// 海面世界的只读探测与计划器：收成品、竣工、建造新建筑、交居民订单、按订单缺口排产、余料升级建筑。
//
// 所有事实都来自客户端自身的调用点与配置表，没有推测：
// - buildingId 形如 "1食品厂" / "1A民居" / "1指标楼A"，即 <序号><可选字母><建筑类型>，
//   类型按最长后缀去比 BuildingCfg.buildingType（58 种）。
// - 人口不是协议字段，是客户端算出来的：初始人口 + Σ BuildingUpgradeCfg[建筑类型][当前等级].effect 里的
//   「人口增加」；人口上限 = GameParamCfg 初始人口上限 + Σ「人口上限」。所以升级前的人口校验
//   可以离线复算（WaterModel._refreshPopulation 同款规则）。
// - 工厂队列上限 = BuildingProduceParamCfg 制造位上限（6），成品存量上限 = GameParamCfg 产品存量初始上限（50）。
// - 加速只花「加速器」：SpeedUpCostParam{type:2, useNum}（SpeedUpCost.SPEED_UP_ITEM=2）。
//   type=1 是钻石、type=3 是广告，本模块永不使用。
//
// 交互原则与 tasks.mjs 一致：先只读探测，再算出计划，显式授权后才逐条执行；
// 没有配套 Response 的写请求走 client.sendWatch()。

import fs from 'node:fs';
import path from 'node:path';
import { SERVER, assetUrl } from '../tools/sync-art.mjs';
import { activeResources } from './resource-store.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { normalize } from './worlds.mjs';
import { upgradeReason } from './building-upgrade-log.mjs';
import { linkOperationResult } from './operation-log.mjs';
import { residentFilter, residentOrderStockWarning, resourceReserve, worldPreferenceEnabled, worldActionAllowed, factoryItemSpeedEnabled, exactAutomationId, AutomationSkip, createActionGuard } from './automation-policy.mjs';
import { cropRelatedMaterialIds, residentMaterialRule } from './resident-materials.mjs';
import { readWeekOrder } from './activities.mjs';
import { RESOURCE, displayMaterial } from './config.mjs';
import { captureFarmMaterialState, farmInventory, settleFarmMaterialState } from './farm-planting.mjs';
import { runFactoryProductionBatch, confirmFactoryProductionBeforeHarvest, prepareFactoryInterruption } from './factory-production.mjs';
import { factoryIncomingStock, resolveFactoryRefills, refillGoal, refillHistoryFor, refillRecipe, planFactoryRefill, readyRefillUnits } from './factory-refill.mjs';
export { factoryIncomingStock };
import { readOrderReservedStock } from './order-reservations.mjs';
import { activityProductionEnabled } from './activity-automation.mjs';
import { createProductionEligibility, factoryRecipeAvailability, factoryRecipeCosts, insertionRecipeReady } from './production-eligibility.mjs';
import { nativeMaterialReceipts, simulateNativeFactoryStarts, simulatedFactoryQueueKey } from './factory-native-simulation.mjs';
import { createFactoryDispatch, shortFactoryFeed } from './factory-dispatch.mjs';
import { waitingQueueChanges, queueStamp, productionDemandChanged } from './factory-replanning.mjs';
import { factoryInsertions } from './factory-insert-store.mjs';
import { insertionYieldsToProduction } from './factory-insertion-queue.mjs';
import { commitFactoryLane, createProductionTiming, nextFactoryLane, observedProductionDurations, observedProductionHeroes } from './production-timing.mjs';

export { factoryRecipeAvailability, factoryRecipeCosts };
const factoryFailures = new WeakMap();

export const SPEED_UP_ITEM = '加速器';
export const SPEED_UP_ITEM_TYPE = 2;
const STOCK_PARAM = '产品存量初始上限';
const SLOTS_PARAM = '制造位上限';
const BASIC_FACTORY_MATERIALS = new Set(['布匹', '长绳', '粗纸']);
const QUICK_RESTOCK_SECONDS = 10;
const POPULATION_PARAM = '初始人口上限';

function rowsOf(config, name) {
  return config?.tables?.[name]?.data ?? [];
}

export function inventoryStockRows(survey, config) {
  const stock = new Map(survey.stock);
  const categories = new Map(rowsOf(config, 'ResourceCfg').map(row => [row.id, '基础资源']));
  const limits = new Map();
  for (const { id, type } of rowsOf(config, 'ItemCfg')) {
    categories.set(id, type);
    if (type === '原料' && Number.isSafeInteger(survey.rawMaterialCap) && survey.rawMaterialCap > 0) {
      limits.set(id, { cap: survey.rawMaterialCap });
    }
  }
  for (const { id, recoverMax } of rowsOf(config, 'ResourceRecoverCfg')) {
    if (Number.isSafeInteger(recoverMax) && recoverMax > 0) limits.set(id, { cap: recoverMax, capKind: 'recovery' });
  }
  if (Number.isSafeInteger(survey.stockCap) && survey.stockCap > 0) {
    const availableProducts = new Set();
    const recordProduct = (id, cap, unlocked) => {
      limits.set(id, { cap });
      if (unlocked) {
        availableProducts.add(id);
        // A complete bag omits depleted items. Never infer zero from a failed read.
        if (survey.stockKnown && !stock.has(id)) stock.set(id, 0);
      }
    };
    for (const recipe of rowsOf(config, 'BuildingProduceCfg')) {
      const unlocked = survey.factories.some(b => b.type === recipe.buildType && b.level > 0 && b.level >= recipe.unlockLevel)
        && factoryRecipeAvailability(recipe, survey.festivals, survey.serverNow).allowed;
      recordProduct(recipe.itemId, survey.stockCap, unlocked);
    }
    const hasFarm = survey.buildings.some(b => b.type === '农田' && b.level > 0);
    for (const crop of rowsOf(config, 'FarmlandPlantCfg')) {
      const seed = crop.material?.[0];
      recordProduct(crop.id, survey.stockCap * 5, hasFarm && (availableProducts.has(seed) || stock.get(seed) > 0));
    }
  }
  return Array.from(stock, ([id, num]) => ({
    id, num, category: categories.get(id) || '其他', ...limits.get(id),
  })).filter(row => row.num > 0 || (row.cap && row.num === 0
    && (row.capKind === 'recovery' ? survey.resourceStockKnown : survey.stockKnown)))
    .sort((a, b) => b.num - a.num);
}

// Bind a click to the displayed recipe and actual factory state. Including
// finished products also invalidates old clicks when a new job finishes instantly.
export function factoryProductionKey(player, building, recipe) {
  const { factoryQ, finishedProducts } = building.factory;
  return createHash('sha256').update(JSON.stringify([
    exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), building.buildingId, building.level,
    factoryQ.map(job => [job.idx ?? 0, job.productId, job.finishTime ?? 0]),
    finishedProducts.map(item => [item.id, item.num]), recipe.itemId, recipe.costItem,
  ])).digest('hex').slice(0, 24);
}

export function manualFactoryProducts(building, survey, config, incoming) {
  if (!building.level || !Array.isArray(building.factory.factoryQ) || !Array.isArray(building.factory.finishedProducts)
    || building.factory.factoryQ.length >= survey.factorySlots) return [];
  const products = [];
  for (const recipe of rowsOf(config, 'BuildingProduceCfg')) {
    if (recipe.buildType !== building.type || !Number.isSafeInteger(recipe.unlockLevel) || recipe.unlockLevel > building.level
      || !factoryRecipeAvailability(recipe, survey.festivals, survey.serverNow).allowed) continue;
    const costs = factoryRecipeCosts(recipe);
    if (!costs) continue;
    const inputs = costs.map(({ id, num }) => ({ id, name: displayMaterial(config, id), num,
      owned: survey.stockKnown ? survey.have(id) : null }));
    let reason = '';
    if (!survey.stockKnown || !survey.stockCap) reason = '库存未同步';
    else if (survey.have(recipe.itemId) + (incoming.get(recipe.itemId) ?? 0) >= survey.stockCap) reason = '成品已达存量上限';
    else if (inputs.some(input => input.owned < input.num)) reason = '原料不足';
    products.push({ productId: recipe.itemId, name: displayMaterial(config, recipe.itemId), inputs, reason,
      seconds: recipe.produceTime, productionKey: factoryProductionKey(survey.player, building, recipe) });
  }
  return products;
}

// 自动生产只按建筑等级和配方开放状态列出产物；队列是否已满、成品是否满仓
// 都不影响游戏内更换自动生产对象，所以这里不能复用 manualFactoryProducts。
export function autoFactoryProducts(building, survey, config) {
  if (!building.level || !building.type) return [];
  const products = [];
  for (const recipe of rowsOf(config, 'BuildingProduceCfg')) {
    if (recipe.buildType !== building.type || !Number.isSafeInteger(recipe.unlockLevel) || recipe.unlockLevel > building.level
      || !factoryRecipeAvailability(recipe, survey.festivals, survey.serverNow).allowed) continue;
    const costs = factoryRecipeCosts(recipe);
    if (!costs) continue;
    const inputs = costs.map(({ id, num }) => ({ id, name: displayMaterial(config, id), num,
      owned: survey.stockKnown ? survey.have(id) : null }));
    let reason = '';
    if (!survey.stockKnown || !survey.stockCap) reason = '库存未同步';
    else if (survey.have(recipe.itemId) >= survey.stockCap) reason = '成品已达存量上限';
    else if (inputs.some(input => input.owned < input.num)) reason = '原料不足';
    products.push({ productId: recipe.itemId, name: displayMaterial(config, recipe.itemId), inputs, reason,
      seconds: recipe.produceTime });
  }
  return products;
}

const lastNativeProducts = new WeakMap();

function nativeFactoryIdentity(player, buildingId) {
  return JSON.stringify([exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), buildingId]);
}

export function nativeFactoryControl(client, building, survey, config, preferred) {
  const identity = nativeFactoryIdentity(survey.player, building.buildingId);
  const current = building.factory.autoProductId || null;
  const entitled = survey.autoProduceForever === true || survey.autoProduceEndTime > survey.serverNow;
  const on = !!current && entitled;
  const recipes = rowsOf(config, 'BuildingProduceCfg').filter(row => row.buildType === building.type && building.level > 0
    && row.unlockLevel <= building.level && factoryRecipeAvailability(row, survey.festivals, survey.serverNow).allowed);
  const unlocked = new Set(recipes.map(row => row.itemId));
  const queue = building.factory.factoryQ ?? [];
  const productId = on ? current : [preferred, lastNativeProducts.get(client)?.get(identity), current,
    ...queue.filter(job => job.finishTime > survey.serverNow).map(job => job.productId),
    ...queue.map(job => job.productId), recipes[0]?.itemId].find(id => unlocked.has(id)) ?? null;
  return { on, productId, name: productId ? displayMaterial(config, productId) : null,
    key: createHash('sha256').update(JSON.stringify([identity, current, on])).digest('hex').slice(0, 24),
    reason: !entitled ? '游戏原生自动生产权益未开启或已到期' : !productId ? '当前没有可用的自动生产配方' : '' };
}

export async function toggleNativeFactory(client, protocol, target, { player, enabled, config }) {
  const { buildingId, productId, on, key } = target;
  if (typeof on !== 'boolean' || typeof buildingId !== 'string' || !buildingId || typeof productId !== 'string'
    || !productId || typeof key !== 'string') throw new Error('请刷新后重新选择工厂');
  const request = on ? 'SetFactoryAutoProduceRequest' : 'CancelFactoryAutoProduceRequest';
  if (!protocol[request] || !protocol.OnWaterRequest || !protocol.OnWaterResponse) throw new Error('当前协议不支持切换工厂自动生产');
  const check = () => { if (!player || !enabled()) throw new Error('账号状态已变化，请刷新建筑一览'); };
  const now = () => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const type = makeTypeResolver(config)(buildingId);
  const read = async () => {
    check();
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    check();
    const building = water.building?.find(b => b.buildingId === buildingId);
    if (!building?.factory || !building.level) throw new Error('工厂状态未同步，请刷新建筑一览');
    return { current: building.factory.autoProductId || null, expires: water.autoProduceForever ? Infinity : water.autoProduceEndTime || 0,
      control: nativeFactoryControl(client, { ...building, type }, { ...water, player, festivals:client.festivals, serverNow:now() }, config, productId) };
  };
  const matches = state => on ? state.control.on && state.current === productId : !state.current;
  const before = await read();
  const label = on ? '已开启原生自动生产' : '已关闭原生自动生产';
  if (matches(before)) return { confirmed:true, label, control:before.control };
  if (before.control.reason) throw new Error(before.control.reason);
  if (key !== before.control.key || before.control.on === on || before.control.productId !== productId) {
    throw new Error('工厂状态或配方已变化，请刷新后重试');
  }
  await client.sendWatch(request, on ? { buildingId, productId } : { buildingId }, { beforeSend() {
    check();
    if (before.expires <= now()) throw new Error('游戏原生自动生产权益已到期');
  } });
  let after;
  try {
    after = await read();
  } catch {
    check();
    return { confirmed:false, label:'切换已提交，游戏状态待同步' };
  }
  if (!matches(after)) return { confirmed:false, label:'切换已提交，游戏状态待同步', control:after.control };
  if (!on) {
    if (!lastNativeProducts.has(client)) lastNativeProducts.set(client, new Map());
    lastNativeProducts.get(client).set(nativeFactoryIdentity(player, buildingId), before.current);
  }
  return { confirmed:true, label, control:after.control };
}

// 这些常量散在几张 param 表里（人口/存量在 GameParamCfg，制造位在 BuildingProduceParamCfg），
// 名字不重复，所以统一按名字查。
function paramOf(config, name) {
  for (const table of ['GameParamCfg', 'BuildingProduceParamCfg']) {
    const row = rowsOf(config, table).find((r) => r.paramName === name);
    if (row) return row.paramValue ?? 0;
  }
  return 0;
}

function indexBy(config, name, key) {
  const out = new Map();
  for (const row of rowsOf(config, name)) out.set(row[key], row);
  return out;
}

// effect 是一组 [名字, 数值]，人口与上限都从这里累加。
function sumEffect(effect, name) {
  let total = 0;
  for (const entry of effect ?? []) {
    if (entry?.[0] === name) total += Number(entry[1] ?? 0);
  }
  return total;
}

// <序号><可选字母><建筑类型> 里抠出类型：取能匹配上的最长后缀。
export function makeTypeResolver(config) {
  const plots = new Map(rowsOf(config, 'BuildingUnlockCfg').map(r => [r.buildingId, r.buildingType]));
  const types = [...new Set(rowsOf(config, 'BuildingCfg').map((r) => r.buildingType))]
    .sort((a, b) => b.length - a.length);
  return (buildingId) => plots.get(buildingId) ?? types.find((type) => buildingId.endsWith(type)) ?? null;
}

export function displayBuilding(config, building) {
  const { buildingId, type } = building;
  const name = rowsOf(config, 'BuildingCfg').find(row => row.buildingType === type)?.name || type;
  const match = /^(\d+)(\D.*)$/.exec(buildingId ?? '');
  if (!match) return name || buildingId;
  const [, number, rawType] = match;
  return (rawType === type ? name : rawType) + '-' + number;
}

function durationText(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return seconds + ' 秒';
  return minutes + ' 分钟' + (rest ? ' ' + rest + ' 秒' : '');
}

// 活动页和挂机共用游戏配方；同类工厂优先使用等级最高的一座。
export function weekFactoryInfo(config, itemId, buildings) {
  const recipe = rowsOf(config, 'BuildingProduceCfg').find(row => row.itemId === itemId);
  if (!recipe) return null;
  const type = recipe.buildType;
  const best = buildings?.filter(b => b.type === type).sort((a, b) => b.level - a.level
    || Number(b.buildFinishTime > 0) - Number(a.buildFinishTime > 0))[0];
  return {
    type, name: rowsOf(config, 'BuildingCfg').find(row => row.buildingType === type)?.name || type,
    required: recipe.unlockLevel, level: buildings ? (best?.level ?? 0) : null,
    buildingId: best?.buildingId, constructing: best?.buildFinishTime > 0,
  };
}

export function upgradeRow(config, buildingType, level) {
  return rowsOf(config, 'BuildingUpgradeCfg').find((r) => r.buildingType === buildingType && r.level === level) ?? null;
}

export function topLevel(config, buildingType) {
  return rowsOf(config, 'BuildingUpgradeCfg')
    .filter((r) => r.buildingType === buildingType)
    .reduce((max, r) => Math.max(max, r.level), 0);
}

// v74 identifies orders by reusable slots. Keep a per-connection token that
// changes if the game replaces the slot, or we have already attempted its delivery.
const residentSessions = new WeakMap();
function trackResidentOrders(client) {
  let session = residentSessions.get(client);
  if (session) return session;
  session = new Map();
  residentSessions.set(client, session);
  client.on?.('message', ({ name, body }) => {
    if (name === 'SCWorkerOrder') rememberResidentOrders(session, normalize(body?.order ?? []));
  });
  return session;
}

export function watchResidentRefreshes(client,ledger,player){
 const session=trackResidentOrders(client),world=exactAutomationId(player?.worldId),id=exactAutomationId(player?.playerId);
 if(ledger&&world&&id)session.manualRefresh={ledger,identity:world+':'+id};
 return session;
}

function rememberResidentOrders(session, orders) {
  const keys = new Map();
  for (const order of orders) {
    const index = order.index ?? 0;
    if (keys.has(index)) { keys.set(index, null); session.delete(index); continue; }
    const quantities = new Map();
    for (const item of order.requirements ?? []) quantities.set(item.id ?? '', (quantities.get(item.id ?? '') ?? 0) + Number(item.num ?? 0));
    const needs = [...quantities].sort(([a], [b]) => a.localeCompare(b));
    const signature = JSON.stringify([order.workerId ?? 0, order.textId ?? 0, !!order.isSpecial, order.refreshTime ?? 0, needs]);
    if (session.get(index)?.signature !== signature) session.set(index, { key: randomUUID(), signature });
    keys.set(index, session.get(index).key);
  }
  session.refreshPending=new Set([...keys.keys()].filter(index => session.get(index)?.materialRefresh));
  if(session.manualRefresh){const {ledger,identity}=session.manualRefresh;
    for(const[key,record]of Object.entries(ledger.keyRecords())){
      const detail=record.details;if(detail?.kind!=='manualOrderRefresh'||detail.identity!==identity)continue;
      const row=session.get(detail.index);if(!row||!keys.has(detail.index))continue;
      if(row.signature!==detail.signature){if(!record.confirmed)ledger.resolveKey(key,true);ledger.releaseCompletedKey(key);}
      else if(!record.confirmed){keys.set(detail.index,null);session.refreshPending.add(detail.index);}
    }
  }
  for (const index of session.keys()) if (!keys.has(index)) session.delete(index);
  return keys;
}

// 只读探测：一次拉齐海面状态、库存、资源田、舰队。
export async function surveyWorld(client, protocol, { config = null, player = null, includeWeekOrder = true, includeCargo = false,
  ordersOnly = false, buildingsView = false, includeProductionTiming = true, includeInventoryCaps = false, timeout = 8000 } = {}) {
  const get = async (name) => {
    const responseName = `${name.slice(0, -7)}Response`;
    if (!protocol[name] || !protocol[responseName]) return null;
    try {
      const raw = await client.request(name, {}, responseName, timeout);
      const value = normalize(raw);
      if (name === 'OnWaterRequest') for (const [index, building] of (value.building ?? []).entries()) {
        if (building.petServe) building.petServe.petUid = exactAutomationId(raw.building[index].petServe?.petUid);
      }
      return value;
    } catch {
      return null;
    }
  };

  const orderSession = trackResidentOrders(client);
  let farmState;
  // A later round may only harvest, with no new spending to invoke the guard.
  // Capture old attempts before the ordered world/inventory reads below.
  try { if (player) farmState = captureFarmMaterialState(player); } catch { /* Incomplete preview identity cannot settle writes. */ }
  const water = await get('OnWaterRequest');
  if (!water) throw new Error('拿不到 OnWaterResponse，无法探测海面');
  const orderKeys = rememberResidentOrders(orderSession, water.workerOrder ?? []);
  const readCaps = includeInventoryCaps && !ordersOnly;
  const [itemList, resourceList, resFields, fleets, capacityEffects] = await Promise.all([
    get('AllItemRequest'),
    ordersOnly ? null : get('AllResourceRequest'),
    ordersOnly || buildingsView ? null : get('MyResFieldsRequest'),
    ordersOnly || buildingsView ? null : get('MyFleetsRequest'),
    readCaps ? get('GameEffectRequest') : null,
  ]);
  if (farmState) {
    try { settleFarmMaterialState(player, { ...farmState, water }, farmInventory(itemList)); }
    catch { /* A partial snapshot keeps the original seed and plot reservation. */ }
  }

  // 道具和资源合到一张库存表里，消耗项的 id 有的是道具名（木材）、有的是资源名（GOLD）。
  const stock = new Map();
  const addStock = (id, num) => stock.set(id, (stock.get(id) ?? 0) + Number(num ?? 0));
  if (Array.isArray(itemList?.items)) for (const item of itemList.items) {
    if (item?.itemId || item?.id) addStock(item.itemId ?? item.id, item.num ?? item.count);
  }
  for (const entry of resourceList?.list ?? []) addStock(RESOURCE[entry.res] ?? String(entry.res), entry.amount);

  const resolveType = makeTypeResolver(config);
  const notes = [];

  // 人口 / 人口上限：客户端同款累加，只算已建成的（level > 0）。
  let population = paramOf(config, '初始人口');
  let futurePopulation = population;
  let maxPopulation = paramOf(config, POPULATION_PARAM);
  const buildings = [];
  for (const raw of water.building ?? []) {
    const buildingId = raw.buildingId;
    const type = resolveType(buildingId);
    const level = raw.level ?? 0;
    const current = upgradeRow(config, type, level);
    population += sumEffect(current?.effect, '人口增加');
    const future = raw.buildStartTime > 0 ? upgradeRow(config, type, level + 1) : current;
    futurePopulation += sumEffect(future?.effect, '人口增加');
    maxPopulation += sumEffect(current?.effect, '人口上限');
    if (!type) notes.push(`暂时无法识别建筑「${buildingId}」，本轮跳过`);
    buildings.push({
      buildingId,
      type,
      level,
      skinId: raw.skinId ?? null,
      farm: raw.farm ?? null,
      factory: raw.factory ?? null,
      petBreed: raw.petBreed ?? null,
      petServe: raw.petServe ?? null,
      product: (raw.product?.asset ?? []).map((a) => ({ id: a.id, num: Number(a.num ?? 0) })),
      buildStartTime: raw.buildStartTime ?? 0,
      buildFinishTime: raw.buildFinishTime ?? 0,
      auto: raw.auto === true,
      population: sumEffect(current?.effect, '人口增加'),
    });
  }

  // WaterModel creates level-0 building models locally after the level and
  // prerequisite checks. Unbuilt plots of any category can be absent from the reply.
  const levels = new Map(buildings.map(b => [b.buildingId, b.level]));
  for (const row of rowsOf(config, 'BuildingUnlockCfg')) {
    if (levels.has(row.buildingId) || row.playerLevel > (player?.level ?? 1)) continue;
    if (!(row.condition ?? []).every(([id, lv]) => (levels.get(id) ?? 0) >= lv)) continue;
    buildings.push({ buildingId: row.buildingId, type: row.buildingType, level: 0,
      factory: null, product: [], buildStartTime: 0, buildFinishTime: 0, population: 0 });
  }

  const orderCfg = indexBy(config, 'WorkerOrderCfg', 'itemId');
  const specOrderCfg = indexBy(config, 'WorkerSpecOrderCfg', 'times');
  const workerNames = new Map(rowsOf(config, 'WorkerBaseCfg').map(worker => [String(worker.id), worker.showName]));
  const have = (id) => stock.get(id) ?? 0;

  const orders = (water.workerOrder ?? []).map((raw) => {
    const quantities = new Map();
    for (const row of raw.requirements ?? []) quantities.set(row.id, (quantities.get(row.id) ?? 0) + Number(row.num ?? 0));
    const requirements = Array.from(quantities, ([id, num]) => ({ id, num }));
    const missing = requirements
      .map((r) => ({ id: r.id, num: Math.max(0, r.num - have(r.id)) }))
      .filter((r) => r.num > 0);
    // 订单经验：特殊订单看 WorkerSpecOrderCfg（times 就是 textId），普通订单按需求项累加。
    let rewardExp = null;
    if (raw.isSpecial) {
      const row = specOrderCfg.get(raw.textId) ?? specOrderCfg.get(String(raw.textId));
      const exp = (row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1];
      rewardExp = exp == null ? null : Number(exp);
    } else {
      let total = 0;
      let known = requirements.length > 0;
      for (const r of requirements) {
        const row = orderCfg.get(r.id);
        const exp = (row?.reward ?? []).find((x) => x[0] === 'EXP')?.[1];
        if (exp === undefined) known = false;
        else total += Number(exp) * r.num;
      }
      rewardExp = known ? total : null;
    }
    let rewardGold = null;
    if (raw.isSpecial) {
      const row = specOrderCfg.get(raw.textId) ?? specOrderCfg.get(String(raw.textId));
      const reward = (row?.reward ?? []).find(x => x[0] === 'GOLD');
      if (reward) rewardGold = Number(reward[1]);
    } else if (requirements.length && requirements.every(r => (orderCfg.get(r.id)?.reward ?? []).some(x => x[0] === 'GOLD'))) {
      rewardGold = requirements.reduce((sum, r) => sum + Number(orderCfg.get(r.id).reward.find(x => x[0] === 'GOLD')[1]) * r.num, 0);
    }
    return {
      index: raw.index ?? 0,
      orderKey: orderKeys.get(raw.index ?? 0),
      refreshPending: orderSession.refreshPending?.has(raw.index??0)??false,
      workerId: raw.workerId,
      workerName: workerNames.get(String(raw.workerId)) || '未知居民',
      textId: raw.textId,
      isSpecial: raw.isSpecial === true,
      refreshTime: raw.refreshTime ?? 0,
      requirements,
      missing,
      rewardExp,
      rewardGold,
    };
  });

  let weekOrder = new Map();
  const cargoOrder = new Map();
  const cargoOrders = [];
  const stockKnown = Array.isArray(itemList?.items) && itemList.items.every(item =>
    (item?.itemId || item?.id) && Number.isSafeInteger(item.num ?? item.count ?? 0) && (item.num ?? item.count ?? 0) >= 0);
  let orderCheckError = !stockKnown ? '未能读取仓库库存' : includeWeekOrder &&
    (!protocol.WeekInfoRequest || !protocol.WeekOrderInfoRequest) ? '无法确认商人订单预留' : '';
  if (includeCargo && !player?.level) orderCheckError = '无法确认贸易港的开放状态';
  if (includeWeekOrder && (!buildingsView || orders.length) && itemList && protocol.WeekInfoRequest && protocol.WeekOrderInfoRequest) {
    try {
      const { needed, finished } = await readWeekOrder(client, undefined, config);
      if (!finished) weekOrder = needed;
      if (includeCargo && player?.level >= (config?.tables?.CargoUnlockCfg?.data[0]?.playerLevel ?? 9)) {
        const ships = await get('CargoShipsRequest');
        const ordersKnown = Array.isArray(ships?.ship) && ships.ship.every(ship => ship &&
          ((ship.status ?? 0) !== 0 || (Array.isArray(ship.orderItem) && ship.orderItem.every(slot =>
            slot && (slot.filled || (slot.asset?.id && Number.isSafeInteger(slot.asset.num) && slot.asset.num > 0))))));
        if (!ordersKnown) {
          notes.push('本轮未能读取贸易港货单');
          orderCheckError = '未能确认贸易港货单预留';
        }
        for (const ship of ordersKnown ? ships.ship : []) {
          if ((ship.status ?? 0) !== 0) continue;
          const requirements = [];
          for (const { filled, asset } of ship.orderItem ?? []) {
            if (!filled && asset?.num > 0) {
              cargoOrder.set(asset.id, (cargoOrder.get(asset.id) ?? 0) + Number(asset.num));
              requirements.push({ id: asset.id, num: Number(asset.num) });
            }
          }
          cargoOrders.push({ requirements });
        }
      }
    } catch (error) {
      notes.push('本轮未能读取商人订单：' + error.message);
      orderCheckError = '未能确认商人订单预留';
    }
  }
  const factories = buildings.filter((b) => b.factory);
  const slots = paramOf(config, SLOTS_PARAM);
  const secondLaneConfigured = rowsOf(config, 'MonthCardCfg').some(row =>
    Array.isArray(row.effectList) && row.effectList.some(effect => effect?.[0] === '第二生产位' && effect[1] > 0));
  const readTiming = includeProductionTiming && !ordersOnly && !buildingsView && factories.some(b =>
    b.level > 0 && Array.isArray(b.factory.factoryQ) && (slots > b.factory.factoryQ.length || b.factory.factoryQ.some(job => !job.finishTime))
    && rowsOf(config, 'BuildingProduceCfg').some(recipe => recipe.buildType === b.type));
  const monthCards = readTiming && secondLaneConfigured ? await get('MonthCardRequest') : null;
  const serverClock = () => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  const effects = readTiming && !readCaps ? await get('GameEffectRequest') : capacityEffects;
  const heroes = readTiming && rowsOf(config, 'HeroSkillCfg').length
    ? observedProductionHeroes(client) ?? (await get('AllHeroRequest'))?.heroes : null;
  // RAW_MATERIAL_UPPER_BOUND is the account's current per-material capacity, including bonuses.
  const rawMaterialCap = Array.isArray(effects?.effects) ? effects.effects.find(effect => effect?.id === 16)?.value : null;
  const baseOrderLimit = rowsOf(config, 'OrderParamCfg').find(row => row.paramName === '订单每日上限')?.paramValue;
  // WORKER_ORDER_INC (18) adds to the configured limit. An absent effect in a full list means zero bonus.
  const orderBonus = Array.isArray(effects?.effects) ? effects.effects.find(effect => effect?.id === 18)?.value ?? 0 : null;
  const resFieldInfo = resFields?.info ?? null;
  const vip = rowsOf(config, 'VipLevelCfg').find(row => row.level === player?.vip?.vipLevel);
  const stockBonus = Number(vip?.effects?.find(([effect]) => effect === '加工品存量上限')?.[1] ?? 0);
  const baseStockCap = paramOf(config, STOCK_PARAM);
  const cropIds = new Set(rowsOf(config, 'FarmlandPlantCfg').map(row => row.id));

  return {
    now: Math.floor(Date.now() / 1000),
    serverNow: serverClock(),
    player,
    stock,
    stockKnown,
    factoryInsertions: factoryInsertions(player),
    resourceStockKnown: Array.isArray(resourceList?.list) && resourceList.list.every(entry =>
      Number.isSafeInteger(entry?.res) && Number.isSafeInteger(entry.amount) && entry.amount >= 0),
    have,
    buildings,
    factories,
    orders,
    orderCheckError,
    weekOrder,
    cargoOrder,
    cargoOrders,
    orderOfTheDay: water.orderOfTheDay ?? null,
    residentOrderLimit: Number.isSafeInteger(baseOrderLimit) && baseOrderLimit > 0 && Number.isSafeInteger(orderBonus) && orderBonus >= 0
      ? baseOrderLimit + orderBonus : null,
    autoProduceEndTime: water.autoProduceEndTime ?? 0,
    autoProduceForever: water.autoProduceForever === true,
    festivals: Array.isArray(client.festivals)?normalize(client.festivals):null,
    floaters: water.floater ?? [],
    floaterCount: (water.floater ?? []).length,
    population,
    futurePopulation,
    maxPopulation,
    autoFarming: water.autoFarming === true,
    cropIds,
    cropRelatedIds: cropRelatedMaterialIds(config, cropIds),
    fishingLevel: water.fishingLevel ?? null,
    salvageLevel: water.salvageLevel ?? null,
    divingLevel: water.divingLevel ?? null,
    stockCap: baseStockCap > 0 ? baseStockCap + stockBonus : 0,
    rawMaterialCap,
    factorySlots: slots,
    productionTiming: { monthCards, effects, heroes, observedDurations: observedProductionDurations(client) },
    resFields: resFieldInfo ? normalize(resFieldInfo) : null,
    fleets: fleets ? normalize(fleets.fleets ?? []) : null,
    worldOpenLevel: rowsOf(config, 'ModuleOpenCfg').find(r => r.moduleId === '世界')?.playerLevel,
    notes,
  };
}

// Equal durations are interchangeable only when their downstream work is too.
function* factoryJobOrders(batch) {
  if (batch.length <= 1) { yield batch; return; }
  const seen = new Set();
  for (const job of batch) {
    const key = job.handoff ? job.recipe.itemId : job.seconds;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const rest of factoryJobOrders(batch.filter(other => other !== job))) yield [job, ...rest];
  }
}

// Keep all material reservations and the selected quantities. Within one
// demand priority, a long job may finish sooner if it starts beside a short one.
function orderFactoryJobs(jobs, building, timing, queueState, handoffs) {
  const original = jobs.map(job => job.step);
  if (jobs.length < 2 || !jobs.some(job => job.step.demandDriven) || jobs.some(job => job.step.needsConfirmedBorrow)) return original;
  const { lanes, finishes: initial, missing } = queueState;
  if ((lanes.count < 2 && !handoffs) || missing.length) return original;
  const timed = jobs.map(job => ({ ...job, handoff: handoffs?.get(job.recipe), seconds: timing.factory(job.recipe, { building }).seconds }));
  if (timed.some(job => !job.seconds)) return original;

  let finishes = initial;
  const ordered = [];
  function simulate(batch) {
    const available = [...finishes];
    const downstream = new Map();
    let done = 0, total = 0;
    for (const job of batch) {
      const lane = nextFactoryLane(available, lanes.expiresAt, job.seconds);
      commitFactoryLane(available, lane);
      let end = lane.finish;
      if (job.handoff) {
        const { building, ready, seconds } = job.handoff;
        end = Math.max(end, downstream.get(building) ?? ready) + seconds;
        downstream.set(building, end);
      }
      done = Math.max(done, end);
      total += end;
    }
    return { batch, available, done, total };
  }
  for (let start = 0; start < timed.length;) {
    let end = start + 1;
    while (end < timed.length && timed[end].priority === timed[start].priority) end++;
    const batch = timed.slice(start, end);
    let best = simulate(batch);
    if (batch.length > 1 && batch.every(job => job.step.demandDriven)) {
      // The game's six slots bound this search to 720 orders. Keep a bounded
      // fallback if a future config raises the queue limit.
      const candidates = batch.length <= 6 ? factoryJobOrders(batch) : [[...batch].sort((a, b) => b.seconds - a.seconds)];
      for (const candidate of candidates) {
        const result = simulate(candidate);
        if (result.done < best.done || handoffs && result.done === best.done && result.total < best.total) best = result;
      }
    }
    ordered.push(...best.batch.map(job => job.step));
    finishes = best.available;
    start = end;
  }
  return ordered;
}

export function manualResidentOrderDecision(survey, order, config) {
  if (!order.orderKey) return { status: 'unknown', reason: '无法确认这条居民订单，请刷新后再试' };
  if (order.refreshTime) return { status: 'refreshing', reason: '订单刷新中，等待新需求' };
  if (!order.requirements.length || order.requirements.some(r => !r.id || !Number.isSafeInteger(r.num) || r.num <= 0)) {
    return { status: 'unknown', reason: '尚未收到完整订单需求' };
  }
  const warning = residentOrderStockWarning(survey.stockKnown ? survey.stock : null, order.requirements, config);
  return { status: 'ready', reason: warning || '手动提交这张订单，由游戏确认交付结果' };
}

function residentDeliveryAction(order, orderOfTheDay, weeklyBorrowed = [], borrowedText = '') {
  const label = `交付${order.workerName || '未知居民'}的订单 #${order.index}`;
  return {
    kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse',
    body: { index: order.index }, costs: order.requirements,
    counters: { residentOrders: 1 }, counterMinimums: { residentOrders: Number(orderOfTheDay?.orderNum ?? 0) },
    orderKey: order.orderKey, requirements: order.requirements, workerId: order.workerId, textId: order.textId,
    weeklyBorrowed,
    label: label + (order.rewardExp == null ? '' : `（经验 ${order.rewardExp}）`) + (borrowedText ? '；商人订单待补 ' + borrowedText : ''),
  };
}

// 计划：收成品 → 竣工 → 建造 → 交单 → 排产 → 余料升级 → 加速。每步都只排「客户端确实会发的请求」。
export function planWorld(survey, {
  config = null,
  allowSpeedUp = false,
  allowReroll = false,
  minOrderExp = 0,
  maxUpgrades = Infinity,
  enabled: taskEnabled = () => true,
  settings = null,
  blockedCollectionTypes = settings?.factory?.blockedCollectionTypes,
  usage = { counters: {} },
  extraDemand = [],
  reserveFactoryInputs = false,
  factoryWaitHistory,
  materialRestock = {},
  refillHistory,
  trackRefills = false,
  checkShortFeeds = true,
  residentDecisionsOnly = false,
} = {}) {
  const { now, have } = survey;
  // 规划是同步的。运行时检查可能读取磁盘，每种动作在本次规划中只查询一次。
  const enabledKinds = new Map();
  const enabled = kind => {
    if (!enabledKinds.has(kind)) enabledKinds.set(kind, worldPreferenceEnabled(settings, kind) && taskEnabled(kind));
    return enabledKinds.get(kind);
  };
  const blockedBuilding = b => !!settings?.building.disabledTypes.some(id => id === b.type || id === b.buildingId);
  const blockedFactory = b => !!settings?.factory.disabledTypes.some(id => id === b.type || id === b.buildingId);
  const canCollect = b => !blockedCollectionTypes?.length || !blockedCollectionTypes.includes(b.type ?? b.buildingId.replace(/^\d+/, ''));
  if (settings) maxUpgrades = settings.building.maxUpgrades;
  const name = id => displayMaterial(config, id);
  const buildingName = b => displayBuilding(config, b);
  const actions = [];
  const notes = [];
  const reserved = new Map();
  const orderDecisions = [];
  const dueHarvest = new Map();
  const markHarvest = (id, num) => dueHarvest.set(id, (dueHarvest.get(id) ?? 0) + num);
  const reserve = (id, num) => reserved.set(id, (reserved.get(id) ?? 0) + Number(num ?? 0));
  const free = (id) => have(id) - (reserved.get(id) ?? 0) - resourceReserve(settings, id);
  const productionEligibility = worldProductionEligibility(survey, config, settings);
  const skipReason = blockers => '已跳过排产，缺少材料 ' + blockers.map(block => name(block.itemId) + ' · ' + block.reason).join('，');

  // 给手动交商人订单留出已有库存，在产和待收的成品也计入缺口。
  const weeklyGap = new Map();
  const weeklyHeld = new Map();
  const borrowedTotals = new Map();
  const weeklyRequirements = activityProductionEnabled(settings, 'merchant') ? [...(survey.weekOrder ?? [])] : [];
  const weeklyOrder = { source: 'merchant', requirements: weeklyRequirements.map(([id, num]) => ({ id, num })) };
  const cargoOrders = (survey.cargoOrders ?? [{ requirements: [...(survey.cargoOrder ?? [])].map(([id, num]) => ({ id, num })) }])
    .map(order => ({ ...order, source: 'cargo' }));
  const orderPriority = settings?.factory?.demandPriority ?? ['merchant', 'cargo'];
  const orderRank = source => orderPriority.includes(source) ? orderPriority.indexOf(source) : orderPriority.length;
  const simulateNative = settings?.factory.strategy === 'nativeSimulation';
  const smart = !simulateNative && settings?.factory.demandFirst === true;
  const smartOrders = smart && (enabled('startProduce') || reserveFactoryInputs && worldPreferenceEnabled(settings, 'startProduce'));
  const directOrders = [weeklyOrder, ...cargoOrders];
  const cargoItems = new Set(cargoOrders.flatMap(order => order.requirements.map(item => item.id)));
  const lastClaim = new Map();
  for (const order of directOrders) for (const { id } of order.requirements) {
    lastClaim.set(id, Math.max(lastClaim.get(id) ?? -1, orderRank(order.source)));
  }
  const lastRank = Math.max(-1, ...lastClaim.values());
  const activityOrders = extraDemand.filter(order => activityProductionEnabled(settings, order.source));
  // An independent guild order's explicit reservations are reconciled by settingDemands.
  const earlyOrders = new Set(smartOrders ? activityOrders.filter(order => order.source !== 'factory' && !order.reserved?.length
    && orderRank(order.source) < lastRank) : []);
  const factoryInputs = new Map();
  const isNative = b => b.factory.autoProductId && (survey.autoProduceForever || survey.autoProduceEndTime > (survey.serverNow ?? now));
  const canSchedule = recipe => factoryRecipeAvailability(recipe, survey.festivals, survey.serverNow ?? now).allowed
    && survey.factories.some(b => b.type === recipe.buildType && b.level > 0 && b.level >= recipe.unlockLevel && !blockedFactory(b)
      && (isNative(b) ? settings.factory.cooperateNative : settings.factory.produce));
  const selectedOrders = new Set(), skippedActivityOrders = new Set();
  function claimFactoryInputs(order, batches) {
    const rank = orderRank(order.source);
    if (earlyOrders.has(order) && [...batches.keys()].some(recipe => !canSchedule(recipe))) return false;
    let competing = false;
    for (const [recipe, count] of batches) {
      if (!canSchedule(recipe)) continue;
      for (const [id, num] of recipe.costItem ?? []) {
        if (rank >= (lastClaim.get(id) ?? -1)) continue;
        if (!factoryInputs.has(order.source)) factoryInputs.set(order.source, new Map());
        const inputs = factoryInputs.get(order.source);
        inputs.set(id, (inputs.get(id) ?? 0) + num * count);
        competing = true;
      }
    }
    if (competing) selectedOrders.add(order);
    return competing || !earlyOrders.has(order);
  }
  const candidates = [...directOrders, ...earlyOrders].sort((a, b) => orderRank(a.source) - orderRank(b.source));
  for (const order of candidates) {
    const acceptBatches = smartOrders && orderRank(order.source) < lastRank ? batches => claimFactoryInputs(order, batches) : undefined;
    const blockers = productionEligibility(order.requirements, { reserve: true, acceptBatches });
    if (blockers.length) {
      const label = order.source === 'merchant' ? '不差钱商人 ' : order.source === 'cargo' ? '贸易港 ' : '';
      notes.push(label + skipReason(blockers));
      if (earlyOrders.has(order)) skippedActivityOrders.add(order);
    } else if (!earlyOrders.has(order)) selectedOrders.add(order);
  }
  const productionOrders = directOrders.filter(order => selectedOrders.has(order));
  const weeklyNeeds = selectedOrders.has(weeklyOrder) ? weeklyRequirements : [];
  const cargoNeeds = new Map();
  for (const order of cargoOrders.filter(order => selectedOrders.has(order))) {
    for (const { id, num } of order.requirements) cargoNeeds.set(id, (cargoNeeds.get(id) ?? 0) + num);
  }
  const weeklyIncomplete = !survey.orderCheckError && weeklyNeeds.every(([id, num]) => id && Number.isSafeInteger(num) && num > 0)
    && weeklyNeeds.some(([id, num]) => have(id) < num);
  const cargoGap = new Map();
  const cargoHeld = new Map();
  const cargoLoadLimits = new Map();
  const holders = [...new Set(['merchant', 'cargo', ...factoryInputs.keys()])];
  if (factoryInputs.size) holders.sort((a, b) => orderRank(a) - orderRank(b));
  for (const source of holders) {
    const stockHeld = source === 'merchant' ? weeklyHeld : cargoHeld;
    const stockGap = source === 'merchant' ? weeklyGap : cargoGap;
    const needs = source === 'merchant' ? weeklyNeeds : source === 'cargo' ? cargoNeeds : [];
    for (const [id, required] of needs) {
      const held = Math.min(required, Math.max(0, free(id)));
      reserve(id, held);
      stockHeld.set(id, held);
      stockGap.set(id, required - held);
    }
    for (const [id, requested] of factoryInputs.get(source) ?? []) {
      const held = Math.min(requested, Math.max(0, free(id)));
      factoryInputs.get(source).set(id, held);
      reserve(id, held);
      if (cargoItems.has(id) && orderRank(source) < orderRank('cargo')) cargoLoadLimits.set(id, 0);
    }
  }
  // Cargo rereads the bag after factory writes. Cap its share instead of
  // subtracting inputs again from a balance that may already reflect the debit.
  for (const id of cargoLoadLimits.keys()) cargoLoadLimits.set(id, cargoHeld.get(id) ?? 0);
  const incomingForResidents = new Map();
  const credit = (id, num) => {
    const weekly = Math.min(weeklyGap.get(id) ?? 0, num);
    if (weekly) weeklyGap.set(id, weeklyGap.get(id) - weekly);
    const cargo = Math.min(cargoGap.get(id) ?? 0, num - weekly);
    if (cargo) cargoGap.set(id, cargoGap.get(id) - cargo);
    return num - weekly - cargo;
  };
  const creditExistingProduction = () => {
    incomingForResidents.clear();
    for (const [id, required] of weeklyNeeds) weeklyGap.set(id, required - weeklyHeld.get(id));
    for (const [id, required] of cargoNeeds) cargoGap.set(id, required - cargoHeld.get(id));
    const addIncoming = (id, num) => incomingForResidents.set(id, (incomingForResidents.get(id) ?? 0) + credit(id, num));
    for (const { factory } of survey.factories) {
      for (const item of factory.finishedProducts ?? []) addIncoming(item.id, item.num);
      for (const job of factory.factoryQ ?? []) addIncoming(job.productId, 1);
    }
  };
  creditExistingProduction();
  const initialWeeklyGap = new Map(weeklyGap);

  const factoryTargets = new Map();
  const merchantProduction = !settings || settings.factory.enabled && settings.factory.demandFirst
    && (settings.factory.produce || settings.factory.cooperateNative) && settings.factory.demandPriority.includes('merchant');
  if (merchantProduction && (enabled('build') || enabled('upgrade'))) {
    // Ordinary construction can unlock a selected merchant recipe for a later round.
    for (const [id, required] of weeklyRequirements) {
      const incoming = survey.factories.reduce((total, { factory }) => total
        + (factory.finishedProducts ?? []).filter(item => item.id === id).reduce((sum, item) => sum + Number(item.num), 0)
        + (factory.factoryQ ?? []).filter(job => job.productId === id).length, 0);
      if (have(id) + incoming >= required) continue;
      const target = weekFactoryInfo(config, id, survey.buildings);
      if (!target || target.level >= target.required) continue;
      if (blockedBuilding({ type: target.type, buildingId: target.buildingId }) || blockedFactory({ type: target.type, buildingId: target.buildingId })) continue;
      if ((factoryTargets.get(target.type)?.required ?? 0) < target.required) factoryTargets.set(target.type, target);
    }
  }
  // 1. 收成品：工厂走 GainFactoryProduce，非工厂建筑的囤积产物一次性批量收。
  for (const b of survey.factories) {
    if (enabled('gainFactory') && !survey.factoryInsertions?.[b.buildingId]?.flight && canCollect(b) && (b.factory.finishedProducts ?? []).length > 0) {
      for (const item of b.factory.finishedProducts) markHarvest(item.id, Number(item.num));
      actions.push({
        kind: 'gainFactory',
        request: 'GainFactoryProduceRequest',
        response: 'GainFactoryProduceResponse',
        body: { buildingId: b.buildingId },
        label: `收取${buildingName(b)}的成品：${b.factory.finishedProducts.map(item => name(item.id) + ' ×' + item.num).join('、')}`,
      });
    }
  }
  const collectible = survey.buildings.filter(b => !b.factory && b.product.length > 0 && canCollect(b));
  if (enabled('collectProduct') && collectible.length > 0) {
    for (const b of collectible) for (const item of b.product) markHarvest(item.id, item.num);
    actions.push({
      kind: 'collectProduct',
      request: 'CollectBuildingProductRequest',
      response: 'CollectBuildingProductResponse',
      body: { buildingId: collectible.map(b => b.buildingId) },
      label: `收取建筑产物：${collectible.map(buildingName).join('、')}`,
    });
  }

  // 2. 竣工：建造时间已过的建筑先收尾，收尾后它才能继续升级。
  for (const b of survey.buildings) {
    if (enabled('finishUpgrade') && b.buildFinishTime > 0 && b.buildFinishTime <= now) {
      actions.push({
        kind: 'finishUpgrade',
        request: 'FinishUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId },
        label: `完成${buildingName(b)}的施工`,
      });
    }
  }

  // 3. 建造：OnWaterResponse 里 level=0 的建筑是空位——要么「已解锁但没盖」，要么正在盖。
  //    客户端的分支很明确（subpackages/main/game.js 的 _toBuildOrUpgradeRequest）：
  //    `0 == t.level ? BuildBuildingRequest : UpgradeBuildingRequest`，所以建造这一条与升级不是同一个请求。
  //    首建门槛、前置建筑和材料取自每个具体地块的 BuildingUnlockCfg。
  const builds = [];
  const buildMaterials = new Map();
  const unavailableRecipes=new Map();
  const produceRows = rowsOf(config, 'BuildingProduceCfg').filter(row=>{const gate=factoryRecipeAvailability(row,survey.festivals,survey.serverNow??now);if(!gate.allowed&&survey.factories.some(b=>b.type===row.buildType)){notes.push(name(row.itemId)+'：'+gate.reason);unavailableRecipes.set(row.buildType,gate.reason);}return gate.allowed;});
  const craftable = new Set(produceRows.filter(row =>
    survey.factories.some(b => b.type === row.buildType && b.level >= row.unlockLevel)).map(row => row.itemId));
  const unlocks = indexBy(config, 'BuildingUnlockCfg', 'buildingId');
  const levels = new Map(survey.buildings.map(b => [b.buildingId, b.level]));
  let plannedPopulation = survey.futurePopulation ?? survey.population;
  for (const b of survey.buildings) {
    if (!enabled('build')) break;
    if (blockedBuilding(b)) continue;
    if (!b.type || b.level !== 0) continue;
    // 有开工或完工时间就已有工程；即便已到竣工时间且竣工开关关闭，也不是空地。
    if (b.buildStartTime > 0 || b.buildFinishTime > 0) continue;
    const row = unlocks.get(b.buildingId);
    if (!row) continue;
    const missingBuildings = (row.condition ?? []).filter(([id, lv]) => (levels.get(id) ?? 0) < lv);
    if (missingBuildings.length) {
      const requirements = missingBuildings.map(([id, level]) => {
        const type = unlocks.get(id)?.buildingType;
        return `${buildingName({ buildingId: id, type })}达到 ${level} 级`;
      });
      notes.push(`${buildingName(b)} 建造有额外条件：需要${requirements.join('、')}`);
      continue;
    }
    if (row.curPeople > survey.population) {
      notes.push(`${buildingName(b)} 需要人口 ${row.curPeople}，当前 ${survey.population}`);
      continue;
    }
    if (row.playerLevel > (survey.player?.level ?? 1)) {
      notes.push(`${buildingName(b)} 建造要等级 ${row.playerLevel}，当前 ${survey.player?.level ?? 1}，先推主线`);
      continue;
    }
    const effect = upgradeRow(config, b.type, 1)?.effect;
    const gain = sumEffect(effect, '人口增加');
    if (gain && plannedPopulation + gain > survey.maxPopulation) {
      notes.push(`${buildingName(b)} 增加 ${gain} 人，需上限 ${plannedPopulation + gain}，当前上限 ${survey.maxPopulation}；先建指标建筑`);
      continue;
    }
    const consume = (row.consume ?? []).map(([id, n]) => ({ id, num: Number(n) }));
    if (!consume.every((c) => free(c.id) >= c.num)) {
      const missing = consume.filter(c => free(c.id) < c.num);
      if (enabled('buildSupply') && enabled('startProduce') && missing.every(c => craftable.has(c.id))) {
        for (const c of missing) {
          if ((buildMaterials.get(c.id)?.num ?? 0) < c.num) buildMaterials.set(c.id, { num: c.num, name: buildingName(b) });
        }
      }
      const short = missing.map((c) => `${name(c.id)} ${free(c.id)}/${c.num}` + (config?.materialSources?.(c.id)?.length ? `（来源：${config.materialSources(c.id).join("、")}）` : "")).join(' ');
      notes.push(`${buildingName(b)} 建造材料不足（${short}），不买材料，等下一轮`);
      continue;
    }
    builds.push({ building: b, row, consume, gain, capacity: sumEffect(effect, '人口上限') });
  }
  const upgradeChecks = [];
  function upgradeBlocked(building, kind, fields) {
    upgradeChecks.push({ id: building.buildingId, name: buildingName(building), kind, ...fields });
  }
  const typeLevels = new Map();
  for (const b of survey.buildings) typeLevels.set(b.type, Math.max(typeLevels.get(b.type) ?? 0, b.level));
  let upgradeCount = 0;
  planUpgrades(true);
  builds.sort((a, b) => Number(b.row.category === '指标') - Number(a.row.category === '指标')
    || Number(b.gain > 0) - Number(a.gain > 0)
    || a.row.playerLevel - b.row.playerLevel || a.building.buildingId.localeCompare(b.building.buildingId));
  const priorityPlots = new Set();
  for (const target of factoryTargets.values()) {
    if (target.level || target.constructing) continue;
    const plot = builds.find(u => u.building.type === target.type);
    if (plot) priorityPlots.add(plot.building.buildingId);
  }
  builds.sort((a, b) => Number(priorityPlots.has(b.building.buildingId)) - Number(priorityPlots.has(a.building.buildingId)));
  let buildCount = 0;
  for (const u of builds) {
    if (settings && buildCount >= settings.building.maxBuilds) { notes.push('已达到每轮建造数量上限'); break; }
    if (u.gain && plannedPopulation + u.gain > survey.maxPopulation) {
      notes.push(`${buildingName(u.building)} 增加 ${u.gain} 人，需上限 ${plannedPopulation + u.gain}，当前上限 ${survey.maxPopulation}；先建指标建筑`);
      continue;
    }
    if (!u.consume.every(c => free(c.id) >= c.num)) {
      notes.push(`${buildingName(u.building)} 建材已预留给本轮其他地块，下一轮重新检查`);
      continue;
    }
    plannedPopulation += u.gain;
    buildCount++;
    for (const c of u.consume) reserve(c.id, c.num);
    actions.push({
      kind: 'build',
      request: 'BuildBuildingRequest',
      response: null,
      body: { buildingId: u.building.buildingId },
      costs: u.consume,
      label: `建造${buildingName(u.building)}（需要角色 ${u.row.playerLevel} 级）`
        + (priorityPlots.has(u.building.buildingId) ? `，商人订单需要 ${factoryTargets.get(u.building.type).required} 级` : '')
        + (u.capacity ? `，竣工后人口上限 +${u.capacity}` : '')
        + (u.gain ? `，竣工后人口 +${u.gain}` : ''),
    });
  }

  // Count ripe crops too: keep the order until the actual harvest reply is known.
  if (enabled('farm') && (!settings || settings.farm.harvest) && (!survey.autoFarming || settings)) {
    const crops = rowsOf(config, 'FarmlandPlantCfg');
    for (const plot of survey.buildings.filter(b => b.type === '农田' && b.level > 0 && !b.buildStartTime && !b.buildFinishTime)) {
      const crop = crops.find(r => r.id === plot.farm?.productId);
      if (crop && !survey.factoryInsertions?.[plot.buildingId]?.flight && canCollect(plot) && plot.farm.ripeTime > 0 && plot.farm.ripeTime < (survey.serverNow ?? now)) {
        markHarvest(crop.id, crop.produceNum);
        actions.push({ kind: 'farm', request: 'FarmHarvestRequest', response: 'FarmHarvestResponse',
          body: { buildingId: [plot.buildingId] }, label: '农田收获 ' + name(crop.id) });
      }
    }
  }
  // 4. 交居民订单：材料齐就交；不齐时按开关决定要不要拒绝重刷。
  const lendable = id => {
    if (!weeklyIncomplete) return 0;
    const cargoOverlap = Math.max(0, (cargoNeeds.get(id) ?? 0) - (cargoHeld.get(id) ?? 0));
    return Math.max(0, (weeklyHeld.get(id) ?? 0) - cargoOverlap);
  };
  const countBefore = Math.max(Number(survey.orderOfTheDay?.orderNum ?? 0), Number(usage.counters?.residentOrders ?? 0));
  const cropRelatedIds = survey.cropRelatedIds ?? (survey.orders.length ? cropRelatedMaterialIds(config, survey.cropIds) : null);
  const residentSteps = [];
  let residentPlanned = 0;
  // 先给本轮可交的订单分配库存和次数，再用剩余额度决定哪些槽位需要换单。
  survey.orders.forEach((order, i) => planResident(order, i, true));
  survey.orders.forEach((order, i) => {
    if (!orderDecisions[i]) planResident(order, i, false);
  });
  // 有材料规则换单时，先交现货、再换单，然后才收货和排产。借用商人预留的单仍在收货后复核。
  const immediate = new Set(residentSteps.some(step => step.materialRule)
    ? residentSteps.filter(step => step.materialRule || step.kind === 'finishOrder' && !step.weeklyBorrowed.length) : []);
  actions.unshift(...immediate);
  actions.push(...residentSteps.filter(step => !immediate.has(step)));
  function planResident(order, i, readyOnly) {
    const label = `${order.workerName || '未知居民'}的订单 #${order.index}`;
    const decision = (status, reason, shortages = []) => {
      const harvestNeeds = shortages.filter(item => item.missing > 0)
        .map(({ id, missing }) => ({ id, missing }));
      orderDecisions[i] = { index: order.index, status, reason, shortages, harvestNeeds };
      if (status !== 'ready' && status !== 'disabled') notes.push(label + ' ' + reason);
    };
    // v74 ignores the previous order's requirements while its slot is refreshing.
    if (order.refreshTime) { decision('refreshing', '订单刷新中，等待新需求'); return; }
    if (order.orderKey === null) { decision('unknown', order.refreshPending?'上次换单结果待确认，等待服务器更新':'服务器返回重复的订单槽位，请刷新后再试'); return; }
    if (!order.requirements.length || order.requirements.some(r => !r.id || !Number.isSafeInteger(r.num) || r.num <= 0)) {
      decision('unknown', '尚未收到完整订单需求');
      return;
    }
    // 禁用材料和农作物能从订单本身确定；判断缺料才需要可靠的库存及预留。
    if (survey.orderCheckError && !residentMaterialRule(settings?.resident, order.requirements, cropRelatedIds, null)) {
      decision('unknown', survey.orderCheckError);
      return;
    }
    const available = id => Math.max(0, free(id) + lendable(id));
    const filter = residentFilter(order, { ...survey, available, cropRelatedIds,
      orderOfTheDay: { ...survey.orderOfTheDay, orderNum: countBefore + residentPlanned } }, settings, usage);
    if (filter) {
      if (readyOnly) return;
      const reroll = filter.reroll && enabled('denyOrder') && (survey.player?.level ?? 0) >= 12;
      decision(reroll ? 'reroll' : 'filtered', filter.reason);
      if (reroll) {
        residentSteps.push({ kind: 'denyOrder', request: 'DenyOrderRequest', response: null, body: { index: order.index }, orderKey: order.orderKey,
          ...(filter.materialRule ? { materialRule: filter.materialRule, requirements: order.requirements } : {}),
          label: `刷新${label}：${filter.reason}` });
      }
      return;
    }
    const shortages = order.requirements.filter(r => free(r.id) < r.num).map(({ id, num }) => {
      const owned = have(id), available = Math.max(0, free(id));
      const weeklyReserved = weeklyHeld.get(id) ?? 0, cargoReserved = cargoHeld.get(id) ?? 0;
      const canBorrow = Math.min(num - available, lendable(id));
      return { id, name: name(id), required: num, owned, available, weeklyReserved, cargoReserved,
        allocated: owned - available - weeklyReserved - cargoReserved, ...(canBorrow ? { canBorrow } : {}),
        missing: num - available - canBorrow };
    });
    // A material may already be fully held for the week, so cargoHeld alone
    // does not cover the ship's outstanding demand when reallocating it.
    const canYield = weeklyIncomplete && shortages.every(item => item.missing === 0);
    if (!shortages.length || canYield) {
      if (!enabled('finishOrder')) { decision('disabled', '材料已齐，自动交居民订单未开启'); return; }
      const weeklyBorrowed = shortages.map(({ id, canBorrow }) => ({ id, num: canBorrow }));
      const borrowedText = weeklyBorrowed.map(item => name(item.id) + ' ×' + item.num).join('、');
      decision('ready', borrowedText ? '商人订单尚缺材料，先交居民订单，商人订单待补 ' + borrowedText : '材料已齐，可交单');
      for (const { id, num } of weeklyBorrowed) {
        weeklyHeld.set(id, weeklyHeld.get(id) - num);
        reserve(id, -num);
        borrowedTotals.set(id, (borrowedTotals.get(id) ?? 0) + num);
      }
      for (const r of order.requirements) reserve(r.id, r.num);
      residentSteps.push(residentDeliveryAction(order, survey.orderOfTheDay, weeklyBorrowed, borrowedText));
      residentPlanned++;
      return;
    }
    if (readyOnly) return;
    const short = shortages.map(item => {
      const holds = [];
      if (item.weeklyReserved) holds.push('商人订单预留 ' + item.weeklyReserved);
      if (item.cargoReserved) holds.push('贸易港预留 ' + item.cargoReserved);
      const cargoOverlap = Math.min(item.weeklyReserved, (cargoNeeds.get(item.id) ?? 0) - item.cargoReserved);
      if (weeklyIncomplete && cargoOverlap > 0) holds.push('其中贸易港也需 ' + cargoOverlap);
      if (item.allocated) holds.push('本轮其他操作占用 ' + item.allocated);
      const limited = item.weeklyReserved > 0 && survey.stockCap > 0
        && item.weeklyReserved + item.required > survey.stockCap
        && rowsOf(config, 'BuildingProduceCfg').some(row => row.itemId === item.id);
      return item.name + '需 ' + item.required + '，库存 ' + item.owned
        + (holds.length ? '（' + holds.join('、') + '）' : '')
        + (item.canBorrow ? '，整单材料齐后可从商人订单临时使用 ' + item.canBorrow : holds.length ? '，可用 ' + item.available : '')
        + (item.missing ? '，缺 ' + item.missing : '')
        + (item.missing && limited ? '；加工品存量上限 ' + survey.stockCap : '');
    }).join('；');
    if (shortages.every(item => item.owned >= item.required)) {
      const holdReason = !weeklyIncomplete && shortages.some(item => item.weeklyReserved) ? '商人订单材料已齐，保留待玩家交单：' : '材料已预留：';
      decision('reserved', holdReason + short, shortages);
    } else if (enabled('finishOrder') && shortages.every(item => (dueHarvest.get(item.id) ?? 0) >= item.missing)) {
      decision('missing', '等待本轮收货后复查：' + short, shortages);
    } else if (allowReroll && (!settings || settings.resident.reroll) && enabled('denyOrder') && (minOrderExp === null || (order.rewardExp ?? 0) < minOrderExp)) {
      decision('reroll', '材料不足，将拒单重刷：' + short, shortages);
      residentSteps.push({
        kind: 'denyOrder',
        request: 'DenyOrderRequest',
        response: null,
        body: { index: order.index },
        orderKey: order.orderKey,
        label: `拒绝${label}（材料不足：${short}）`,
      });
    } else {
      const blockers = productionEligibility(order.requirements);
      decision(blockers.length ? 'productionSkipped' : 'missing', blockers.length ? skipReason(blockers) : '材料不足：' + short, shortages);
    }
  }

  if (residentDecisionsOnly) return { orderDecisions };

  // 5. 排产：按需求补料；原生自动目标仅在协同开关开启时调整，保留正在生产项。
  if (borrowedTotals.size) creditExistingProduction();
  const demand = new Map();
  for (const [i, order] of survey.orders.entries()) {
    if (!['reserved', 'missing', 'disabled'].includes(orderDecisions[i].status)) continue;
    for (const item of order.requirements) demand.set(item.id, (demand.get(item.id) ?? 0) + item.num);
  }
  for (const [id, required] of demand) {
    demand.set(id, Math.max(0, required - free(id) - lendable(id) - (incomingForResidents.get(id) ?? 0)));
  }
  const buildingSupplies = [];
  if (settings?.building.supply && enabled('buildSupply')) for (const b of survey.buildings) {
    if (!b.type || blockedBuilding(b) || b.buildStartTime || b.buildFinishTime || (b.level === 0 ? !settings.building.build : !settings.building.upgrade)) continue;
    const row = b.level === 0 ? unlocks.get(b.buildingId) : upgradeRow(config, b.type, b.level + 1);
    if (!row || row.playerLevel > (survey.player?.level ?? 1) || row.curPeople > survey.population) continue;
    const unmet = b.level === 0 ? (row.condition ?? []).some(([id, lv]) => (levels.get(id) ?? 0) < lv)
      : (row.condition ?? []).some(([type, lv]) => (typeLevels.get(type) ?? 0) < lv);
    if (unmet) continue;
    const effect = b.level === 0 ? upgradeRow(config, b.type, 1)?.effect : row.effect;
    const gain = Math.max(0, sumEffect(effect, '人口增加') - (b.population ?? 0));
    if (gain && plannedPopulation + gain > survey.maxPopulation) continue;
    const costs = (row.consume ?? []).map(([id, num]) => ({ id, num: Number(num) }));
    const missing = costs.filter(item => free(item.id) < item.num);
    if (missing.length && missing.every(item => craftable.has(item.id))) buildingSupplies.push({ source: 'building', requirements: costs });
  }
  const independentSources = settings?.alliance?.enabled ? [
    ...(settings.alliance.recruit && settings.alliance.recruitProduction ? ['guildRecruit'] : []),
    ...(settings.guildShip?.enabled && settings.guildShip.produceMissing ? ['guildShip'] : []),
  ] : [];
  const demandPriority = settings ? [...new Set([...settings.factory.demandPriority, ...independentSources])] : [];
  const speedQuota = new Map();
  const queueClaims = new Map();
  const detailedNeeds = settings ? settingDemands(survey, config, [
    ...productionOrders,
    ...survey.orders.filter((order, i) => ['reserved', 'missing', 'disabled'].includes(orderDecisions[i]?.status))
      .map(order => ({ source: 'resident', requirements: order.requirements })),
    ...buildingSupplies,
    ...activityOrders.filter(order => !skippedActivityOrders.has(order)),
  ], demandPriority, { settings, eligibility: productionEligibility, selectedOrders, speedQuota, queueClaims,
    onSkip: (record, blockers) => notes.push(skipReason(blockers)) }) : null;
  const productionNeeded = id => (detailedNeeds?.get(id)?.num ?? 0) > 0 && (settings?.factory.demandFirst ||
    detailedNeeds.get(id).sources.some(source => independentSources.includes(source)));
  const incoming = factoryIncomingStock(survey.factories);
  const committedInputs = new Map();
  // A forecast can hold completed demand in the warehouse; those units still take up space.
  const warehouseCount = survey.warehouseCount ?? have;
  const occupiedStock = id => warehouseCount(id) + (incoming.get(id) ?? 0) - (borrowedTotals.get(id) ?? 0);
  const projectedStock = id => occupiedStock(id) - (committedInputs.get(id) ?? 0);
  const roomForRecipe = row => Math.max(0, survey.stockCap - projectedStock(row.itemId));
  const stockTarget = Math.min(settings?.factory.keepStock ?? survey.stockCap, survey.stockCap);
  // The factory source is a stock target, including its expanded ingredients.
  // It never grants the order-only exemption from the per-product waterline.
  const itemOrderRank = id => {
    if (!productionNeeded(id)) return Infinity;
    const needs = detailedNeeds.get(id).productionBySource;
    const rank = demandPriority.findIndex(source => source !== 'factory' && needs[source] > 0);
    return rank < 0 ? Infinity : rank;
  };
  const orderNeedsProduction = id => Number.isFinite(itemOrderRank(id));
  const stockIndex = demandPriority.indexOf('factory');
  // With no lower tier, the existing spare-capacity pass already handles stock.
  const stockRank = settings?.factory.demandFirst && stockIndex >= 0 && stockIndex < demandPriority.length - 1 ? stockIndex : Infinity;
  const recipeRank = row => Math.min(itemOrderRank(row.itemId), projectedStock(row.itemId) < stockTarget ? stockRank : Infinity);
  // The factory phase runs before pet feeding. Keep complete feed batches out
  // of lower-priority recipes so stocking the factory cannot starve the pet.
  const petRank = demandPriority.indexOf('petAdvance');
  const feedStock = new Map();
  if (smart && petRank >= 0 && activityProductionEnabled(settings, 'petAdvance')) {
    for (const { requirements } of extraDemand.filter(row => row.source === 'petAdvance' && row.readyToFeed)) {
      if (requirements.every(({ id, num }) => free(id) - (feedStock.get(id) ?? 0) >= num)) {
        for (const { id, num } of requirements) feedStock.set(id, (feedStock.get(id) ?? 0) + num);
      }
    }
  }
  const assignedInputs = row => factoryInputs.get(demandPriority[itemOrderRank(row.itemId)]);
  const recipeFree = (row, id) => Math.max(0, free(id) + (assignedInputs(row)?.get(id) ?? 0)
    - (recipeRank(row) >= petRank ? feedStock.get(id) ?? 0 : 0));
  if(detailedNeeds)for(const crop of rowsOf(config,'FarmlandPlantCfg')) {const need=detailedNeeds.get(crop.id),seed=detailedNeeds.get(crop.material?.[0]);if(need?.num>0 && seed?.num>0)notes.push('生产依赖：缺'+name(crop.id)+' '+need.num+' → 缺'+name(crop.material[0])+' '+seed.num+' → 种子厂按需求补产'+(settings.factory.cooperateNative?'（已允许调整原生自动目标）':'（原生协同尚未开启）'));}
  if (enabled('farm') && settings && survey.autoFarming && (settings.farm.customPlant || !settings.farm.autoPlant)) {
    actions.push({ kind: 'farm', request: 'SetAutoFarmingRequest', response: null, body: { isOn: false }, label: '暂停游戏内自动种植，应用当前种植设置' });
  }
  if (enabled('farm') && !survey.autoFarming && (!settings || settings.farm.autoPlant || settings.farm.customPlant)) {
    const crops = rowsOf(config, 'FarmlandPlantCfg');
    const planted = new Map();
    const plots = survey.buildings.filter(b => b.type === '农田' && b.level > 0 && !b.buildStartTime && !b.buildFinishTime);
    for (const b of plots) {
      const crop = crops.find(r => r.id === b.farm?.productId);
      if (!crop) continue;
      planted.set(crop.id, (planted.get(crop.id) ?? 0) + crop.produceNum);
    }
    const custom = settings?.farm.customPlant ? new Map(settings.farm.crops.map((row, priority) => [row.id, { ...row, priority }])) : null;
    const shortage = id => Math.max(0, (custom ? (custom.get(id)?.target ?? 0) - have(id) : settings ? detailedNeeds.get(id)?.num ?? 0 : (weeklyGap.get(id) ?? 0) + (demand.get(id) ?? 0)) - (planted.get(id) ?? 0));
    const projected = id => have(id) + (planted.get(id) ?? 0);
    for (const crop of crops) {
      if (shortage(crop.id) > 0 && free(crop.material[0]) < crop.material[1])
        notes.push(name(crop.id) + ' 订单缺 ' + shortage(crop.id) + '，种植需要' + name(crop.material[0]));
    }
    for (const b of plots.filter(b => !b.farm?.productId)) {
      if (survey.factoryInsertions?.[b.buildingId]?.jobs?.length) continue;
      const choices = crops.filter(r => free(r.material[0]) >= r.material[1]
        && projected(r.id) < survey.stockCap * 5 && (custom ? custom.has(r.id) && shortage(r.id) > 0 : settings || !weeklyGap.has(r.id) || shortage(r.id) > 0));
      choices.sort((a, b) => (custom ? custom.get(a.id).priority - custom.get(b.id).priority : 0)
        || shortage(b.id) - shortage(a.id) || projected(a.id) - projected(b.id) || a.time - b.time);
      const crop = choices[0];
      if (!crop) continue;
      reserve(crop.material[0], crop.material[1]);
      const need = shortage(crop.id);
      planted.set(crop.id, (planted.get(crop.id) ?? 0) + crop.produceNum);
      actions.push({ kind: 'farm', request: 'FarmPlantRequest', response: 'OkResponse',
        body: { args: [{ buildingId: b.buildingId, productId: crop.id }] },
        costs: [{ id: crop.material[0], num: crop.material[1] }],
        ...(!custom && need ? { demandSources: detailedNeeds?.get(crop.id)?.sources ?? [] } : {}),
        label: '农田播种 ' + name(crop.id) + (need ? '（订单缺 ' + need + '）' : ''),
      });
    }
  }
  const replacementJobs = new Map();
  const factoryReasons = new Map();
  const timing = createProductionTiming({ config, ...survey.productionTiming, serverNow: survey.serverNow ?? now });
  const dispatch = createFactoryDispatch(survey, timing, canCollect, rowsOf(config, 'FarmlandPlantCfg'));
  const revisit = settings?.factory.checkEverySeconds ?? 30;
  const nextWaits = new Map();
  // Each source tier allocates shared inputs across all factories.
  const priorities = demandPriority.map((_, i) => i).filter(i => demandPriority[i] === 'factory' ? i === stockRank && stockTarget > 0
    : [...detailedNeeds.values()].some(need => (need.productionBySource[demandPriority[i]] ?? 0) > 0));
  const fullForInsertion = id => survey.stockCap > 0 && survey.stockKnown !== false
    && warehouseCount(id) + (incoming.get(id) ?? 0) >= survey.stockCap;
  const refillProducts = new Map();
  if (enabled('startProduce') && settings?.factory.produce && settings.factory.refillRules?.length) {
    refillHistory ??= refillHistoryFor(survey.player);
    const assignments = survey.stockKnown === false ? new Map() : resolveFactoryRefills(survey.factories,settings,{
      config, cap:survey.stockCap, owned:warehouseCount, available:free, incoming, history:refillHistory, record:trackRefills,
      festivals:survey.festivals, now:survey.serverNow ?? now, autoProduceForever:survey.autoProduceForever, autoProduceEndTime:survey.autoProduceEndTime,
    });
    const ordered = survey.factories.toSorted((a,b) => Number(!!assignments.get(a.buildingId)?.supply) - Number(!!assignments.get(b.buildingId)?.supply));
    for (const b of ordered) {
      if (!(b.level > 0) || blockedFactory(b) || isNative(b)) continue;
      const id = b.buildingId;
      if (survey.stockKnown === false || !(survey.stockCap > 0)) {
        if (!settings.factory.refillRules.some(r => r.buildingId === id && refillRecipe(config, b, r, survey.festivals, survey.serverNow ?? now))) continue;
        refillProducts.set(id, null);
        factoryReasons.set(b.buildingId, '等待确认补库物品库存'); continue;
      }
      const selected = assignments.get(id);
      if (!selected) continue;
      const {rule, recipe} = selected;
      refillProducts.set(id, rule.productId);
      factoryReasons.set(b.buildingId, (selected.supply ? '补上游原料' : '优先补') + name(rule.productId) + '至 ' + refillGoal(rule, survey.stockCap) + ' 件');
      actions.push(...planFactoryRefill(b, rule, recipe, { survey, owned:warehouseCount, incoming, free, reserve, credit,
        supply:selected.supply, useAccelerators:!selected.supply && settings.factory.refillSpeedUp, factoryName:buildingName(b), productName:name(rule.productId) }));
    }
  }
  const refilling = new Set(refillProducts.keys());
  let facilities = survey.factories.filter(b => {
    if (!(b.level > 0) || blockedFactory(b) || refilling.has(b.buildingId)) return false;
    const entry = survey.factoryInsertions?.[b.buildingId];
    if (!entry) return true;
    const time = survey.serverNow ?? now;
    const canMake = id => insertionRecipeReady(produceRows.find(row => row.itemId === id), b.level, survey.festivals, time, free);
    return !isNative(b) && insertionYieldsToProduction(entry, time, fullForInsertion, canMake);
  });
  const queueChanges = smart && enabled('startProduce') && settings.factory.produce && survey.stockKnown !== false && !survey.orderCheckError
    ? waitingQueueChanges({
      facilities: facilities.filter(b => !isNative(b) && !survey.factoryInsertions?.[b.buildingId]),
      queues: dispatch.queues, claims: queueClaims, priority: demandPriority, recipes: produceRows, timing, now: survey.serverNow ?? now,
      stockUnits: id => stockTarget - warehouseCount(id) - readyRefillUnits(survey.factories, id), stockRank,
      newRank: row => roomForRecipe(row) > 0 && (row.costItem ?? []).every(([id,n]) => recipeFree(row,id) >= n)
        ? recipeRank(row) : Infinity,
    }) : new Map();
  if (queueChanges.size) {
    for (const b of facilities.filter(b => queueChanges.has(b.buildingId))) {
      const {job, target} = queueChanges.get(b.buildingId)[0];
      const reason = buildingName(b) + '优先排' + name(target) + '，撤下等待中的' + name(job.productId);
      const stockIds = new Set([job.productId, target, ...detailedNeeds.keys(),
        ...(produceRows.find(row => row.itemId === target)?.costItem ?? []).map(([id]) => id)]);
      factoryReasons.set(b.buildingId, reason);
      actions.push({kind:'startProduce', request:'CancelFactoryProduceRequest', response:null, body:{buildingId:b.buildingId, index:job.idx ?? 0},
        queueReplan:true, label:reason, displayFactory:buildingName(b), costs:[],
        verify:{productId:job.productId, queue:queueStamp(b.factory.factoryQ), priority:JSON.stringify(settings.factory.demandPriority),
          stock:[...stockIds].filter(id => !Object.values(RESOURCE).includes(id)).map(id => [id, have(id)])}});
    }
    facilities = facilities.filter(b => !queueChanges.has(b.buildingId));
  }
  const usableRows = new Set(facilities.flatMap(b => produceRows.filter(r => r.buildType === b.type && r.unlockLevel <= b.level)));
  let restockBatchSizes;
  let quickRestockDuringOrders = false;
  const coversRestockBatch = row => projectedStock(row.itemId) >= (restockBatchSizes.get(row.itemId) ?? 1);
  const downstream = new Map();
  for (const row of usableRows) {
    if (!orderNeedsProduction(row.itemId)) continue;
    for (const [item] of row.costItem ?? []) {
      if (!downstream.has(item)) downstream.set(item, []);
      downstream.get(item).push(row);
    }
  }
  const tailTime = new Map();
  function remainingPath(row, seen = new Set()) {
    if (tailTime.has(row)) return tailTime.get(row);
    if (seen.has(row)) return 0;
    const costs = (downstream.get(row.itemId) ?? []).filter(next => recipeRank(next) === recipeRank(row)).map(next => {
      const times = facilities.filter(b => b.type === next.buildType && b.level >= next.unlockLevel).map(b => dispatch.seconds(b, next));
      return Math.min(...times) + remainingPath(next, new Set([...seen, row]));
    });
    const tail = Math.max(0, ...costs);
    tailTime.set(row, tail);
    return tail;
  }
  for (const row of usableRows) remainingPath(row);
  // When many ordinary factories are simultaneously waiting on unknown inputs,
  // let the lower-ranked lines with the shortest runnable fillers resume first.
  const earlyFallback = new Set();
  if (smart && priorities.length) {
    const ordinary = facilities.filter(b => !isNative(b) && produceRows.some(r => r.buildType === b.type && r.unlockLevel <= b.level));
    const blocked = [];
    for (const b of ordinary) {
      if (dispatch.queues.get(b).count) continue;
      const local = [...usableRows].filter(r => r.buildType === b.type && r.unlockLevel <= b.level);
      const rank = Math.min(...local.map(recipeRank));
      if (!Number.isFinite(rank) || !local.filter(r => recipeRank(r) === rank).every(r => !Number.isFinite(dispatch.readyAt(r, recipeFree)))) continue;
      const backups = local.filter(r => recipeRank(r) > rank && occupiedStock(r.itemId) < survey.stockCap
        && (orderNeedsProduction(r.itemId) || projectedStock(r.itemId) < stockTarget)
        && (r.costItem ?? []).every(([id,n]) => recipeFree(r,id) >= n));
      if (backups.length) blocked.push({ b, rank, seconds: Math.min(...backups.map(r => dispatch.seconds(b,r))) });
    }
    if (blocked.length >= 2 && blocked.length * 2 >= ordinary.length) {
      blocked.sort((a,b) => b.rank - a.rank || a.seconds - b.seconds || a.b.buildingId.localeCompare(b.b.buildingId));
      const working = ordinary.filter(b => dispatch.queues.get(b).count > 0).length;
      const release = Math.min(Math.ceil(blocked.length / 2), Math.max(0, Math.ceil(ordinary.length / 2) - working));
      for (const row of blocked.slice(0, release)) earlyFallback.add(row.b);
    }
  }
  // A verified one-to-one feeder batch can be compared across two stages.
  // For joins, missing co-inputs or ambiguous machines retain the normal order.
  function batchHandoffs(b, jobs, tier) {
    if (!smart || !settings.factory.gain || !canCollect(b) || !Number.isFinite(tier) || jobs.length < 2 || jobs.length > 6
      || dispatch.queues.get(b).lanes.count !== 1) return;
    const handoffs = new Map(), counts = new Map(), materials = new Map();
    for (const { recipe } of jobs) {
      const children = (downstream.get(recipe.itemId) ?? []).filter(row => recipeRank(row) === tier);
      if (children.length !== 1) return;
      const child = children[0];
      const targets = facilities.filter(f => f.type === child.buildType && f.level >= child.unlockLevel);
      if (targets.length !== 1 || targets[0] === b || isNative(targets[0])) return;
      const target = targets[0], queue = dispatch.queues.get(target);
      if (queue.lanes.count !== 1 || queue.missing.length || recipeFree(child, recipe.itemId) > 0
        || incoming.get(recipe.itemId) > jobs.filter(job => job.recipe === recipe).length) return;
      const count = (counts.get(child) ?? 0) + 1;
      if (count > (detailedNeeds.get(child.itemId)?.productionBySource[demandPriority[tier]] ?? 0)) return;
      counts.set(child, count);
      for (const [id, amount] of child.costItem) {
        if (id === recipe.itemId) { if (amount !== 1) return; continue; }
        const required = (materials.get(id) ?? 0) + amount;
        if (recipeFree(child, id) < required) return;
        materials.set(id, required);
      }
      handoffs.set(recipe, { building: target, ready: queue.finishes[0], seconds: dispatch.seconds(target, child) });
    }
    return handoffs.size > 1 ? handoffs : undefined;
  }
  const constructionGap = id => buildMaterials.has(id)
    ? Math.max(0, buildMaterials.get(id).num - free(id) - (incoming.get(id) ?? 0)) : 0;
  function planFactory(b, tier, quantities, { shortFeed = false, balanceMaterials = false, quickRestock = false } = {}) {
    if (isNative(b)) {
      const desired = !simulateNative && settings?.factory.cooperateNative ? produceRows.filter(row =>
        row.buildType === b.type && row.unlockLevel <= b.level && (productionNeeded(row.itemId) || Number.isFinite(recipeRank(row)))
        && projectedStock(row.itemId) < (orderNeedsProduction(row.itemId) ? survey.stockCap : stockTarget)) : [];
      const choices = desired.filter(row => (row.costItem ?? []).every(([id,n]) => recipeFree(row, id) >= n));
      const shortages=desired.filter(row=>!choices.includes(row)).map(row=>name(row.itemId)+'：'+(row.costItem??[]).filter(([id,n])=>recipeFree(row,id)<n).map(([id,n])=>name(id)+'需'+n+'，可用'+recipeFree(row,id)+'，缺'+(n-recipeFree(row,id))).join('；'));
      if(shortages.length)notes.push(buildingName(b)+'原生协同等待原料：'+shortages.join('；'));
      const bFactoryTarget = b.factory.autoProductId;
      choices.sort((a,b) => recipeRank(a) - recipeRank(b) ||
        Number(b.itemId === bFactoryTarget) - Number(a.itemId === bFactoryTarget) || (detailedNeeds.get(b.itemId)?.num ?? 0) - (detailedNeeds.get(a.itemId)?.num ?? 0));
      const best = choices[0];
      // The native target may stay unchanged until the game starts its next batch.
      if (best) for (const [id, n] of best.costItem ?? []) {
        const inputs = assignedInputs(best);
        if (inputs?.has(id)) inputs.set(id, Math.max(0, inputs.get(id) - n));
      }
      if (best && best.itemId !== b.factory.autoProductId) {
        actions.push({kind:'startProduce',request:'SetFactoryAutoProduceRequest',response:null,
          body:{buildingId:b.buildingId,productId:best.itemId},previousProduct:b.factory.autoProductId,eligibilityKey:factoryRecipeAvailability(best,survey.festivals,survey.serverNow??now).signature+':'+b.level,
          demandSources:recipeRank(best) === stockIndex ? ['factory'] : detailedNeeds.get(best.itemId).sources,
          label:buildingName(b)+'：原生自动目标改为'+name(best.itemId)+'，保留当前生产队列',costs:[]});
        factoryReasons.set(b.buildingId,'按需求调整原生自动目标，当前队列继续完成');
      } else factoryReasons.set(b.buildingId, '游戏自动生产 '+name(b.factory.autoProductId)+(!simulateNative && settings?.factory.cooperateNative?(shortages.length?'；等待所需原料':'；当前目标无需调整或需求已在产'):'；需求协同未开启'));
      return;
    }
    if (settings && !settings.factory.produce) {factoryReasons.set(b.buildingId,'普通排产关闭；原生协同只调整已开启的自动目标');return;}
    const state = dispatch.queues.get(b);
    const slotLimit = survey.factoryInsertions?.[b.buildingId]
      ? Math.min(survey.factorySlots, b.factory.factoryQ.length + 1) : survey.factorySlots;
    if (state.count >= slotLimit) return;
    const initialFinishes = [...state.finishes];
    const localRows = produceRows.filter(row => row.buildType === b.type && row.unlockLevel <= b.level);
    if (!localRows.length) {
      factoryReasons.set(b.buildingId, unavailableRecipes.get(b.type) || '当前等级没有已解锁的生产配方');
      return;
    }
    const inTier = row => recipeRank(row) === tier && (!quantities || quantities.get(row.itemId) > 0);
    if (!localRows.some(inTier)) return;
    const higher = [...usableRows].filter(row => recipeRank(row) < tier);
    const protectedInputs = new Map();
    for (const row of higher) {
      // Reserve one runnable batch for a blocked higher-priority recipe.
      if (quantities && !roomForRecipe(row)) continue;
      for (const [item, n] of row.costItem ?? []) protectedInputs.set(item, (protectedInputs.get(item) ?? 0) + n);
    }
    // The source's share is already excluded from the lower tier's free stock.
    for (const [source, inputs] of factoryInputs) {
      if (orderRank(source) >= tier) continue;
      for (const [id, held] of inputs) {
        if (protectedInputs.has(id)) protectedInputs.set(id, Math.max(0, protectedInputs.get(id) - held));
      }
    }
    const jobs = [];
    for (let slot = state.count; slot < slotLimit; slot++) {
      const waiting = higher.filter(row => row.buildType === b.type && row.unlockLevel <= b.level)
        .flatMap(row => {
          // A full output cannot start until someone spends it. Ingredients
          // being on hand do not establish a release time for that job.
          const room = quantities ? roomForRecipe(row) : Infinity;
          const at = room ? dispatch.readyAt(row, recipeFree) : Infinity;
          const rank = recipeRank(row);
          const wanted = rank === stockRank && Number.isFinite(rank) ? Math.max(0, stockTarget - projectedStock(row.itemId))
            : detailedNeeds.get(row.itemId)?.productionBySource[demandPriority[rank]] ?? 0;
          const quantity = Math.min(wanted, room || 1);
          let waited = 0;
          if (!Number.isFinite(at)) {
            const time = survey.serverNow ?? now;
            const missing = room ? row.costItem.filter(([id, n]) => recipeFree(row, id) < n).map(([id]) => id) : 'capacity';
            const key = JSON.stringify([b.buildingId, row.itemId, missing]);
            const since = Math.min(time, factoryWaitHistory?.get(key) ?? time);
            nextWaits.set(key, since);
            waited = time - since;
          }
          const wave = { row, at, quantity, waited, earlyFallback: earlyFallback.has(b),
            capacityBlocked: balanceMaterials && room === 0 };
          if (Number.isFinite(at) && state.lanes.count > 1 && quantity > 1) {
            const secondAt = dispatch.readyAt(row, recipeFree, 2);
            return Number.isFinite(secondAt) ? [{ ...wave, quantity: 1 }, { row, at: secondAt, quantity: 1 }]
              : [{ ...wave, quantity: 1 }];
          }
          return [wave];
        }).sort((a, other) => (Number.isFinite(a.at) ? a.at : (survey.serverNow ?? now) + revisit)
          - (Number.isFinite(other.at) ? other.at : (survey.serverNow ?? now) + revisit) || recipeRank(a.row) - recipeRank(other.row));
      const reasons = [];
      const cand = localRows.filter(row => {
        if (!inTier(row)) return false;
        const id = row.itemId;
        const batch = quickRestock ? quantities.get(id) : 1;
        let reason;
        if (occupiedStock(id) >= survey.stockCap)
          reason = '库存、待收和在产合计已达 ' + survey.stockCap;
        else if (settings && projectedStock(id) >= stockTarget && !orderNeedsProduction(id))
          reason = '已达到有效备货水位 ' + stockTarget;
        else if (!shortFeed && !quickRestock && (smart || balanceMaterials) && (waiting.length || tier === Infinity) && !dispatch.fits(b, row, waiting, revisit))
          reason = '为下一次需求派单保留生产时间';
        else if ((row.costItem ?? []).some(([item,n]) => protectedInputs.has(item) && recipeFree(row,item) - n * batch < protectedInputs.get(item)))
          reason = '共享原料已为更高优先级的生产预留';
        else {
          const missing = (row.costItem ?? []).filter(([item, n]) => recipeFree(row, item) < n);
          if (missing.length) reason = missing.map(([item, n]) => name(item) + '需要 ' + n + '，可用 ' + recipeFree(row, item)).join('；');
        }
        if (reason) reasons.push(name(id) + '：' + reason);
        return !reason;
      });
      if (!cand.length) {
        factoryReasons.set(b.buildingId, reasons.join('；') || unavailableRecipes.get(b.type) || '当前等级没有已解锁的生产配方');
        break;
      }
      // At the same demand tier, give a waiting downstream line its first
      // usable batch before filling all six slots for an already supplied line.
      const feedsIdle = new Set();
      if (smart && settings.factory.gain && canCollect(b) && Number.isFinite(tier) && cand.length > 1) for (const row of cand) {
        for (const child of downstream.get(row.itemId) ?? []) {
          if (recipeRank(child) !== tier) continue;
          const missing = child.costItem.filter(([id, n]) => recipeFree(child, id) + (incoming.get(id) ?? 0) < n);
          if (missing.length !== 1 || missing[0][0] !== row.itemId) continue;
          if (facilities.some(f => f.type === child.buildType && f !== b && !isNative(f) && f.level >= child.unlockLevel
            && dispatch.queues.get(f).count < dispatch.queues.get(f).lanes.count)) {
            feedsIdle.add(row);
            break;
          }
        }
      }
      const compareCustom = (a, other) => (restockBatchSizes && !quickRestockDuringOrders && tier === stockRank && !balanceMaterials
        ? Number(coversRestockBatch(a)) - Number(coversRestockBatch(other)) : 0)
        || (balanceMaterials ? projectedStock(a.itemId) - projectedStock(other.itemId)
        || dispatch.seconds(b, a) - dispatch.seconds(b, other) : 0)
        || Number(feedsIdle.has(other)) - Number(feedsIdle.has(a))
        || (tailTime.get(other) ?? 0) - (tailTime.get(a) ?? 0)
        || dispatch.seconds(b, a) - dispatch.seconds(b, other)
        || (settings.factory.demandFirst ? (detailedNeeds.get(other.itemId)?.num ?? 0) - (detailedNeeds.get(a.itemId)?.num ?? 0) : 0)
        || projectedStock(a.itemId) - projectedStock(other.itemId);
      const best = cand.sort(settings ? compareCustom : (a, b2) => (weeklyGap.get(b2.itemId) ?? 0) - (weeklyGap.get(a.itemId) ?? 0)
        || (cargoGap.get(b2.itemId) ?? 0) - (cargoGap.get(a.itemId) ?? 0)
        || (demand.get(b2.itemId) ?? 0) - (demand.get(a.itemId) ?? 0)
        || constructionGap(b2.itemId) - constructionGap(a.itemId)
        || a.produceTime - b2.produceTime
        || projectedStock(a.itemId) - projectedStock(b2.itemId))[0];
      for (const [id, n] of best.costItem ?? []) {
        const inputs = assignedInputs(best);
        const assigned = Math.min(inputs?.get(id) ?? 0, n);
        if (assigned) inputs.set(id, inputs.get(id) - assigned);
        reserve(id, n - assigned);
        committedInputs.set(id, (committedInputs.get(id) ?? 0) + n);
      }
      const need = demand.get(best.itemId) ?? 0;
      const weeklyNeed = weeklyGap.get(best.itemId) ?? 0;
      const cargoNeed = cargoGap.get(best.itemId) ?? 0;
      const buildNeed = constructionGap(best.itemId);
      const forDemand = !settings || orderNeedsProduction(best.itemId) && tier !== stockIndex;
      const priority = settings ? recipeRank(best) : [weeklyNeed, cargoNeed, need, buildNeed].findIndex(gap => gap > 0);
      const demandSources = forDemand ? Object.entries(detailedNeeds?.get(best.itemId)?.productionBySource ?? {})
        .filter(([source, quantity]) => source !== 'factory' && quantity > 0).map(([source]) => source) : [];
      const projected = projectedStock(best.itemId);
      // The account may already be at its storage limit. Only run a dependent
      // job after enough resident deliveries have actually freed that stock.
      let needsConfirmedBorrow = Math.max(0, have(best.itemId) + (incoming.get(best.itemId) ?? 0) + 1 - survey.stockCap);
      const initialNeed = initialWeeklyGap.get(best.itemId) ?? 0;
      if (weeklyNeed && initialNeed) initialWeeklyGap.set(best.itemId, initialNeed - 1);
      else if (weeklyNeed && borrowedTotals.has(best.itemId)) {
        const replacement = (replacementJobs.get(best.itemId) ?? 0) + 1;
        replacementJobs.set(best.itemId, replacement);
        needsConfirmedBorrow = Math.max(needsConfirmedBorrow, replacement);
      }
      incoming.set(best.itemId, (incoming.get(best.itemId) ?? 0) + 1);
      if (detailedNeeds?.has(best.itemId)) {
        const need = detailedNeeds.get(best.itemId);
        // A unit made for the waterline can also fill an outstanding order.
        const source = demandPriority[itemOrderRank(best.itemId)] ?? demandPriority.find(source => (need.productionBySource[source] ?? 0) > 0);
        need.num = Math.max(0, need.num - 1);
        if (source) need.productionBySource[source]--;
        need.priority = demandPriority.findIndex(source => (need.productionBySource[source] ?? 0) > 0);
        if (need.priority < 0) need.priority = Infinity;
      }
      if (need > 0 && !weeklyNeed && !cargoNeed) demand.set(best.itemId, need - 1);
      credit(best.itemId, 1);
      const displayFactory = buildingName(b);
      const displayProduct = name(best.itemId);
      const reason = forDemand && weeklyNeed ? `商人订单缺 ${weeklyNeed} 件` + (needsConfirmedBorrow ? '，居民交单后补回' : '') : forDemand && cargoNeed ? `贸易港缺 ${cargoNeed} 件`
        : forDemand && need ? `居民订单缺 ${need} 件` : forDemand && buildNeed ? `${buildMaterials.get(best.itemId).name}建造缺 ${buildNeed} 件`
        : quickRestock ? `快速补货至一批用量，排入后预计共 ${projected + 1} 件（含待收和在产）`
        : balanceMaterials ? `基础材料补货，排入后预计 ${projected + 1}/${stockTarget} 件（含待收和在产）` : `补库存，排入后预计共 ${projected + 1} 件（含待收和在产）`;
      const step = {
        kind: 'startProduce',
        request: 'StartFactoryProduceRequest',
        response: null,
        body: { buildingId: b.buildingId, productId: best.itemId },
        eligibilityKey:factoryRecipeAvailability(best,survey.festivals,survey.serverNow??now).signature+':'+b.level,
        costs: (best.costItem ?? []).map(([id, num]) => ({ id, num: Number(num) })),
        ...(needsConfirmedBorrow ? { needsConfirmedBorrow } : {}),
        factoryStrategy: 'smart',
        demandDriven: settings ? forDemand : !!(need || weeklyNeed || cargoNeed || buildNeed),
        ...(demandSources.length ? { demandSources } : {}),
        displayFactory, displayProduct,
        label: `${displayFactory}安排生产${displayProduct} 1 件，预计耗时 ${durationText(dispatch.seconds(b, best))}。${reason}`,
      };
      jobs.push({ step, recipe: best, priority, arrival: dispatch.commit(b, best) });
      if (quantities) {
        quantities.set(best.itemId, quantities.get(best.itemId) - 1);
        factoryReasons.delete(b.buildingId);
        if (!balanceMaterials) break;
      }
    }
    const ordered = balanceMaterials || higher.some(row => row.buildType === b.type) ? jobs.map(job => job.step)
      : orderFactoryJobs(jobs, b, timing, { ...state, finishes: initialFinishes }, batchHandoffs(b, jobs, tier));
    if (ordered.some((step, index) => step !== jobs[index].step)) {
      state.finishes = initialFinishes;
      for (const step of ordered) {
        const job = jobs.find(entry => entry.step === step);
        const lane = nextFactoryLane(state.finishes, state.lanes.expiresAt, dispatch.seconds(b, job.recipe));
        commitFactoryLane(state.finishes, lane);
        if (job.arrival) job.arrival.at = lane.finish;
      }
    }
    actions.push(...ordered);
  }
  if (enabled('startProduce')) {
    for (const b of survey.factories.filter(blockedFactory)) factoryReasons.set(b.buildingId, '已在设置中禁用此工厂');
    for (const b of facilities.filter(isNative)) planFactory(b);
    const ordinary = facilities.filter(b => !isNative(b));
    if (simulateNative) {
      const collecting = new Set(actions.filter(step => step.kind === 'gainFactory').map(step => step.body.buildingId));
      const receipts = nativeMaterialReceipts(survey.factories, b => collecting.has(b.buildingId));
      // Earlier actions will spend these units before the factories start. An
      // unsubmitted order has no such cost and cannot hold a factory's inputs.
      const spending = new Map();
      for (const step of actions) for (const { id, num } of step.costs ?? []) {
        spending.set(id, (spending.get(id) ?? 0) + num);
      }
      const confirmedStock = survey.nativeFactoryStock ?? have;
      const picks = settings.factory.produce && survey.stockKnown !== false ? simulateNativeFactoryStarts({
        buildings: ordinary, recipes: rowsOf(config, 'BuildingProduceCfg'), availableProducts: craftable,
        targets: settings.factory.simulatedTargets, timing,
        now: survey.serverNow ?? now, cap: survey.stockCap, slots: survey.factorySlots, insertions:survey.factoryInsertions,
        available: id => confirmedStock(id) + (receipts.get(id) ?? 0) - (spending.get(id) ?? 0) - resourceReserve(settings, id),
        owned: id => warehouseCount(id) + (incoming.get(id) ?? 0) - (spending.get(id) ?? 0),
      }) : [];
      for (const { building, row, seconds, primary, laneUntil } of picks) {
        for (const [id, n] of row.costItem) reserve(id, n);
        incoming.set(row.itemId, (incoming.get(row.itemId) ?? 0) + 1);
        credit(row.itemId, 1);
        const displayFactory = buildingName(building), displayProduct = name(row.itemId);
        actions.push({ kind: 'startProduce', request: 'StartFactoryProduceRequest', response: null,
          body: { buildingId: building.buildingId, productId: row.itemId }, factoryStrategy: 'nativeSimulation',
          simulatedTargetsKey: JSON.stringify(settings.factory.simulatedTargets ?? []), demandDriven: false,
          simulatedQueueKey: simulatedFactoryQueueKey(building.factory),
          ...(laneUntil != null ? { latestStart:laneUntil-seconds } : {}),
          eligibilityKey: factoryRecipeAvailability(row,survey.festivals,survey.serverNow??now).signature+':'+building.level,
          costs: row.costItem.map(([id,num]) => ({id,num})), displayFactory, displayProduct,
          label: displayFactory + '模拟原生生产' + displayProduct + '（' + (primary ? '主产物' : '候补') + '），预计耗时 ' + durationText(seconds) });
      }
    } else {
      planSmartFactories(ordinary);
    }
    if (factoryWaitHistory) {
      factoryWaitHistory.clear();
      for (const [key, since] of nextWaits) factoryWaitHistory.set(key, since);
    }
  }

  function planSmartFactories(ordinary) {
    if (smart && settings.factory.produce && stockTarget > 0) {
      // On-hand or queued goods may still belong to an undelivered order.
      const hasClaim = order => order.requirements?.some(item => item.num > 0) || order.reserved?.some(item => item.num > 0);
      const activeClaim = [...directOrders, ...extraDemand, ...buildingSupplies].some(order =>
        order.source !== 'factory' && demandPriority.includes(order.source) && hasClaim(order))
        || demandPriority.includes('resident') && survey.orders.some((order, i) =>
          ['ready', 'reserved', 'missing', 'disabled'].includes(orderDecisions[i].status) && hasClaim(order));
      quickRestockDuringOrders = activeClaim && demandPriority.includes('factory') && survey.stockKnown !== false && enabled('gainFactory');
      if (!activeClaim || quickRestockDuringOrders) {
        restockBatchSizes = new Map();
        for (const row of usableRows) {
          if (projectedStock(row.itemId) >= stockTarget || !ordinary.some(b => b.type === row.buildType && b.level >= row.unlockLevel)) continue;
          const costs = row.costItem ?? [];
          for (const [id, quantity] of costs) {
            if (quantity > (restockBatchSizes.get(id) ?? 1)
              && costs.every(([other, n]) => other === id || recipeFree(row, other) >= n)) {
              restockBatchSizes.set(id, quantity);
            }
          }
        }
      }
    }
    // Remember completion only from a confirmed snapshot. A planned batch
    // may be rejected or only partially sent before the next inventory read.
    const basics = [...usableRows].filter(row => row.buildType === '材料厂' && BASIC_FACTORY_MATERIALS.has(row.itemId)
      && ordinary.some(b => b.type === row.buildType && b.level >= row.unlockLevel));
    const canRestock = settings?.factory.produce && basics.length > 0 && survey.stockKnown !== false;
    if (canRestock) {
      const key = JSON.stringify([stockTarget, ...basics.map(row => row.itemId)]);
      if (materialRestock.key !== key) {
        materialRestock.key = key;
        materialRestock.complete = false;
      }
      if (basics.every(({ itemId }) => warehouseCount(itemId) + (incoming.get(itemId) ?? 0) >= stockTarget))
        materialRestock.complete = true;
    }
    function planTier(b, tier) {
      if (canRestock && !materialRestock.complete && tier === stockRank && b.type === '材料厂') {
        const gaps = new Map(basics.map(row => [row.itemId, stockTarget - projectedStock(row.itemId)]));
        planFactory(b, tier, gaps, { balanceMaterials: true });
      }
      planFactory(b, tier);
    }
    if (checkShortFeeds && smart && settings.factory.produce && enabled('gainFactory')) {
      const feed = shortFactoryFeed({
        idle: ordinary.filter(b => dispatch.queues.get(b).count === 0 && canCollect(b)),
        recipes: [...usableRows], rank: recipeRank, incoming, free: recipeFree, seconds: dispatch.seconds, revisit, slots: survey.factorySlots,
        room: row => Math.min(roomForRecipe(row), orderNeedsProduction(row.itemId) ? Infinity : Math.max(0,stockTarget-projectedStock(row.itemId))),
        defaultHeads() {
          const baseline = planWorld(survey, { config, allowSpeedUp, allowReroll, minOrderExp, maxUpgrades,
            enabled, settings, blockedCollectionTypes, usage, extraDemand, factoryWaitHistory:new Map(factoryWaitHistory),
            materialRestock: { ...materialRestock }, refillHistory, checkShortFeeds:false });
          const heads = new Map();
          for (const step of baseline.actions) if (step.request === 'StartFactoryProduceRequest' && !heads.has(step.body.buildingId))
            heads.set(step.body.buildingId,step.body.productId);
          return heads;
        },
      });
      if (feed) {
        const shortage = new Map([[feed.row.itemId,feed.units]]);
        for (let i=0; i<feed.units; i++) {
          const before = actions.length;
          planFactory(feed.building,recipeRank(feed.row),shortage,{ shortFeed: true });
          if (actions.length === before) break;
        }
      }
    }
    if (quickRestockDuringOrders) for (const b of ordinary) planQuickRestock(b);
    for (const tier of priorities) {
      const candidates = ordinary.map(building => {
        const local = produceRows.filter(row => row.buildType === building.type && row.unlockLevel <= building.level && recipeRank(row) === tier);
        const state = dispatch.queues.get(building);
        return { building, path:Math.max(-1, ...local.map(row => tailTime.get(row) ?? 0)),
          finish:Math.min(Infinity, ...local.map(row => nextFactoryLane(state.finishes, state.lanes.expiresAt, dispatch.seconds(building,row)).finish)) };
      });
      for (const {building} of candidates.sort((a,b) => b.path - a.path || (smart ? a.finish - b.finish : 0))) planTier(building, tier);
    }
    // A downstream booking can expose a replenishment gap at a factory we
    // already visited. Each successful pass consumes at least one free slot.
    let before;
    do {
      before = actions.length;
      for (const b of ordinary) planTier(b, Infinity);
    } while (smart && actions.length > before);
    // Recheck genuinely idle machines after the main allocations. Include
    // the missing ingredients of one batch, even when their stock is nonzero.
    if (smart && settings.factory.produce && (stockTarget > 0 || priorities.length)) {
      const idle = ordinary.filter(b => dispatch.queues.get(b).count === 0);
      const ordinaryRecipes = new Map([...usableRows].filter(row =>
        ordinary.some(b => b.type === row.buildType && b.level >= row.unlockLevel)).map(row => [row.itemId, row]));
      const stockouts = new Map();
      function traceShortage(row, quantity) {
        const previous = stockouts.get(row.itemId) ?? 0;
        stockouts.set(row.itemId, Math.max(previous, quantity));
        if (previous) return;
        for (const [id, n] of row.costItem ?? []) {
          const supplier = ordinaryRecipes.get(id);
          const shortage = n - recipeFree(row, id) - (incoming.get(id) ?? 0);
          if (supplier && shortage > 0) traceShortage(supplier, shortage);
        }
      }
      for (const row of ordinaryRecipes.values()) {
        if ((stockTarget > 0 || orderNeedsProduction(row.itemId)) && projectedStock(row.itemId) <= 0
          && idle.some(b => b.type === row.buildType && b.level >= row.unlockLevel)) {
          traceShortage(row, 1);
        }
      }
      if (stockouts.size) for (const tier of [...priorities, Infinity]) {
        for (const b of idle) if (!dispatch.queues.get(b).count) planFactory(b, tier, stockouts);
      }
    }
  }

  function planQuickRestock(b) {
    const queue = dispatch.queues.get(b);
    const freeSlots = survey.factorySlots - queue.count;
    if (freeSlots < 2 || !canCollect(b) || survey.factoryInsertions?.[b.buildingId] || queue.missing.length && queue.count) return;
    const deadline = (survey.serverNow ?? now) + Math.min(QUICK_RESTOCK_SECONDS, revisit);
    const offers = [];
    for (const row of usableRows) {
      if (row.buildType !== b.type || row.unlockLevel > b.level) continue;
      const stock = projectedStock(row.itemId);
      const units = Math.min(stockTarget, restockBatchSizes.get(row.itemId) ?? 1) - stock;
      // Leave a queue slot for normal dispatch. The entire shortage must fit
      // behind existing work, even if the second production lane expires.
      if (units <= 0 || units >= freeSlots || occupiedStock(row.itemId) + units > survey.stockCap) continue;
      if (!dispatch.batchFitsBy(b, row, units, deadline) || !(row.costItem ?? []).every(([id,n]) => recipeFree(row, id) >= n * units)) continue;
      offers.push({ row, units, stock, duration: dispatch.seconds(b, row) * units });
    }
    offers.sort((a, other) => a.duration - other.duration || a.stock - other.stock || recipeRank(a.row) - recipeRank(other.row));
    for (const { row, units } of offers) {
      const shortage = new Map([[row.itemId, units]]);
      while (shortage.get(row.itemId) > 0) {
        const before = actions.length;
        planFactory(b, recipeRank(row), shortage, { quickRestock: true });
        if (actions.length === before) break;
      }
      if (shortage.get(row.itemId) < units) break;
    }
  }

  // 6. 余料升级建筑：把订单与排产占用的材料扣掉之后再比升级消耗，按人口需求升序（便宜的先生效）。
  planUpgrades(false);

  function planUpgrades(priority) {
    if (!enabled('upgrade')) return;
    const upgrades = [];
    for (const b of survey.buildings) {
      if (blockedBuilding(b)) continue;
      const target = factoryTargets.get(b.type);
      const forOrder = target?.buildingId === b.buildingId && b.level < target.required;
      if (forOrder !== priority) continue;
      if (b.level <= 0) continue;
      if (!b.type) { upgradeBlocked(b, 'config', { reason: '未找到建筑类型' }); continue; }
      if (b.buildStartTime > 0 || b.buildFinishTime > 0) {
        upgradeBlocked(b, 'construction'); continue;
      }
      const next = b.level + 1;
      const row = upgradeRow(config, b.type, next);
      if (!row) {
        const max = topLevel(config, b.type);
        if (max && b.level >= max) upgradeBlocked(b, 'maximum', { required: max });
        else upgradeBlocked(b, 'config', { reason: '缺少下一级配置' });
        continue;
      }
      const unmet = (row.condition ?? []).find(([type, lv]) => (typeLevels.get(type) ?? 0) < lv);
      if (unmet) {
        const prerequisite = rowsOf(config, 'BuildingCfg').find(cfg => cfg.buildingType === unmet[0])?.name || unmet[0];
        upgradeBlocked(b, 'prerequisite', { prerequisite, required: unmet[1] });
        continue;
      }
      if (row.playerLevel > (survey.player?.level ?? 1)) { upgradeBlocked(b, 'level', { required: row.playerLevel }); continue; }
      if (row.curPeople > survey.population) { upgradeBlocked(b, 'population', { required: row.curPeople, current: survey.population }); continue; }
      const consume = (row.consume ?? []).map(([id, num]) => ({ id, num: Number(num) }));
      const gain = Math.max(0, sumEffect(row.effect, '人口增加') - (b.population ?? 0));
      upgrades.push({ building: b, row, consume, gain, costTime: row.costTime ?? 0 });
    }
    upgrades.sort((a, b) => a.row.curPeople - b.row.curPeople || a.costTime - b.costTime);
    for (const u of upgrades) {
      if (upgradeCount >= maxUpgrades) {
        notes.push(`${buildingName(u.building)} 本轮升级额度用完，下一轮再升`);
        continue;
      }
      if (u.gain && plannedPopulation + u.gain > survey.maxPopulation) {
        upgradeBlocked(u.building, 'capacity', { required: survey.maxPopulation });
        continue;
      }
      const short = u.consume.filter(c => free(c.id) < c.num);
      if (short.length) {
        upgradeBlocked(u.building, 'materials', { items: short.map(c => ({ id: c.id, name: name(c.id), missing: c.num - free(c.id) }))
          .sort((a,b) => a.id.localeCompare(b.id)) });
        continue;
      }
      upgradeCount++;
      plannedPopulation += u.gain;
      for (const c of u.consume) reserve(c.id, c.num);
      actions.push({
        kind: 'upgrade',
        request: 'UpgradeBuildingRequest',
        response: null,
        body: { buildingId: u.building.buildingId },
        costs: u.consume,
        label: `${buildingName(u.building)}从 ${u.building.level} 级升至 ${u.building.level + 1} 级（耗时 ${durationText(u.costTime)}，需要 ${u.row.curPeople} 人）`
          + (priority ? `，商人订单需要 ${factoryTargets.get(u.building.type).required} 级` : ''),
      });
    }
  }

  // 7. 加速：只花「加速器」，而且只对真的在等的建造/生产用。
  if (allowSpeedUp || (settings?.farm.enabled && settings.farm.speedUp)) {
    const serverNow = survey.serverNow ?? now;
    const speeders = Number(have(SPEED_UP_ITEM));
    let left = Math.max(0, free(SPEED_UP_ITEM));
    for (const b of survey.buildings) {
      if (settings && !enabled('speedUpUpgrade')) continue;
      if (!Number.isSafeInteger(b.buildFinishTime) || b.buildFinishTime <= serverNow) continue;
      const minutes = Math.ceil((b.buildFinishTime - serverNow) / 60);
      if (minutes <= 0 || left <= 0) continue;
      const useNum = Math.max(1, Math.min(minutes, left));
      left -= useNum;
      actions.push({
        kind: 'speedUpUpgrade',
        request: 'SpeedUpUpgradeBuildingRequest',
        response: null,
        body: { buildingId: b.buildingId, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
        costs: [{ id: SPEED_UP_ITEM, num: useNum }],
        label: `使用 ${useNum} 个${name(SPEED_UP_ITEM)}加速${buildingName(b)}施工`,
      });
    }
    const speedJobs = [];
    for (const b of survey.factories) {
      if (settings && (!enabled('speedUpProduce') || blockedFactory(b))) continue;
      for (const job of b.factory.factoryQ ?? []) {
        if (refilling.has(b.buildingId) && refillProducts.get(b.buildingId) !== job.productId) continue;
        if (!job.productId || !Number.isSafeInteger(job.idx ?? 0) || (job.idx ?? 0) < 0
          || !Number.isSafeInteger(job.finishTime) || job.finishTime <= serverNow) continue;
        const queued = speedQuota.get(job.productId);
        const source = queued && demandPriority.find(id => queued.get(id) > 0);
        const specific = !settings || factoryItemSpeedEnabled(settings.factory, job.productId);
        if (!source && !specific) continue;
        if (source) queued.set(source, queued.get(source) - 1);
        speedJobs.push({ b, job, source, priority: source ? demandPriority.indexOf(source) : Infinity });
      }
    }
    speedJobs.sort((a, b) => a.priority - b.priority);
    for (const { b, job, source } of speedJobs) {
      if (left <= 0) break;
      const useNum = Math.min(Math.ceil((job.finishTime - serverNow) / 60), left);
      left -= useNum;
      actions.push({
        kind: 'speedUpProduce', request: 'SpeedUpFactoryProduceRequest', response: null,
        body: { buildingId: b.buildingId, index: job.idx ?? 0, speedUp: { type: SPEED_UP_ITEM_TYPE, useNum } },
        verify: { productId: job.productId, finishTime: job.finishTime }, displayFactory: buildingName(b),
        costs: [{ id: SPEED_UP_ITEM, num: useNum }],
        ...(source ? { demandSources: [source] } : {}),
        label: `使用 ${useNum} 个${name(SPEED_UP_ITEM)}加速${buildingName(b)}生产`,
      });
    }
    if (settings?.farm.enabled && settings.farm.speedUp && enabled('farm')) {
      for (const b of survey.buildings) {
        if (!(b.farm?.ripeTime > (survey.serverNow ?? now)) || left <= 0) continue;
        const goal = settings.farm.customPlant ? settings.farm.crops.find(c => c.id === b.farm.productId)?.target ?? 0 : (detailedNeeds.get(b.farm.productId)?.unfilled ?? 0) + have(b.farm.productId);
        if (goal <= have(b.farm.productId)) continue;
        const useNum = Math.min(left, Math.ceil((b.farm.ripeTime - (survey.serverNow ?? now)) / 60));
        left -= useNum;
        actions.push({ kind: 'farm', request: 'FarmSpeedUpRequest', response: null, body: { buildingId: b.buildingId, param: { type: SPEED_UP_ITEM_TYPE, useNum } },
          ...(!settings.farm.customPlant ? { demandSources: detailedNeeds.get(b.farm.productId)?.sources ?? [] } : {}),
          costs: [{ id: SPEED_UP_ITEM, num: useNum }], label: `使用 ${useNum} 个加速器催熟${name(b.farm.productId)}` });
      }
    }
    if (left === speeders) notes.push(`${SPEED_UP_ITEM} 有 ${speeders} 个，但没有等待中的建造或生产`);
  }

  return { actions, notes, factoryReasons, refilling, queueChanges, cargoLoadLimits, upgradeChecks, upgradeReasons: upgradeChecks.map(upgradeReason), orderDecisions, allowReroll, minOrderExp,
    demands: detailedNeeds ? [...detailedNeeds].map(([id, need]) => ({ id, ...need })) : [], reserved: [...reserved].filter(([, n]) => n > 0) };
}

function worldProductionEligibility(survey, config, settings) {
  const recipes = rowsOf(config, 'BuildingProduceCfg');
  const crops = new Map(rowsOf(config, 'FarmlandPlantCfg').map(row => [row.id, row]));
  const itemIds = new Set([
    ...recipes.flatMap(row => [row.itemId, ...(row.costItem ?? []).map(([id]) => id)]),
    ...[...crops.values()].flatMap(row => [row.id, row.material?.[0]]),
  ].filter(Boolean));
  const stock = new Map([...itemIds].map(id => [id, Math.max(0, survey.have(id) - (resourceReserve(settings, id) || 0))]));
  const incoming = factoryIncomingStock(survey.factories ?? []);
  for (const building of survey.buildings ?? []) {
    const crop = crops.get(building.farm?.productId);
    if (crop) incoming.set(crop.id, (incoming.get(crop.id) ?? 0) + crop.produceNum);
  }
  return createProductionEligibility(config, { buildings: survey.buildings, settings, stock, incoming });
}

export function settingDemands(survey, config, records, priority, {
  settings = null, eligibility = null, selectedOrders = new Set(), onSkip = () => {}, speedQuota, queueClaims,
} = {}) {
  const result = new Map();
  const recipes = new Map(rowsOf(config, 'BuildingProduceCfg').map(row => [row.itemId, row]));
  const crops = new Map(rowsOf(config, 'FarmlandPlantCfg').map(row => [row.id, row]));
  const incoming = new Map();
  const finished = new Map();
  for (const b of survey.factories) {
    for (const job of b.factory.factoryQ ?? []) {
      const balance = job.finishTime > 0 && job.finishTime <= (survey.serverNow ?? survey.now) ? finished : incoming;
      balance.set(job.productId, (balance.get(job.productId) ?? 0) + 1);
    }
    for (const item of b.factory.finishedProducts ?? []) finished.set(item.id, (finished.get(item.id) ?? 0) + Number(item.num));
  }
  for (const b of survey.buildings ?? []) {
    const crop = crops.get(b.farm?.productId);
    if (crop) incoming.set(crop.id, (incoming.get(crop.id) ?? 0) + crop.produceNum);
  }
  const speedDemand = speedQuota && settings?.factory.speedUpSources.length ? new Map() : null;
  const add = (source, id, count, seen = new Set()) => {
    if (!id || !Number.isFinite(count) || count <= 0 || seen.has(id)) return;
    const previous = result.get(id);
    const required = (previous?.required ?? 0) + count;
    const unfilled = Math.max(0, required - survey.have(id) - (finished.get(id) ?? 0));
    const num = Math.max(0, unfilled - (incoming.get(id) ?? 0));
    const extra = Math.max(0, num - (previous?.num ?? 0));
    const immediate = Math.max(0, unfilled - (previous?.unfilled ?? 0));
    if (queueClaims && immediate && source !== 'factory') {
      if (!queueClaims.has(id)) queueClaims.set(id, new Map());
      const claims = queueClaims.get(id);
      claims.set(source, (claims.get(source) ?? 0) + immediate);
    }
    const productionBySource = { ...previous?.productionBySource };
    if (extra > 0) productionBySource[source] = (productionBySource[source] ?? 0) + extra;
    if (speedDemand && incoming.has(id)) {
      if (!speedDemand.has(id)) speedDemand.set(id, new Map());
      const requested = speedDemand.get(id);
      requested.set(source, (requested.get(source) ?? 0) + count);
    }
    result.set(id, { required, unfilled, num, priority: Math.min(previous?.priority ?? Infinity, extra > 0 ? priority.indexOf(source) : Infinity),
      sources: [...new Set([...(previous?.sources ?? []), ...(immediate > 0 ? [source] : [])])], productionBySource });
    for (const [material, amount] of recipes.get(id)?.costItem ?? []) add(source, material, extra * Number(amount), new Set([...seen, id]));
    const crop = crops.get(id);
    if (crop?.produceNum > 0 && extra > 0) add(source, crop.material[0], Math.ceil(extra / crop.produceNum) * crop.material[1], new Set([...seen,id]));
  };
  const checkProduction = eligibility ?? (settings ? worldProductionEligibility(survey, config, settings) : null);
  // Attribute real shortages first. Stock is a target for the same goods, not
  // another delivery. The dispatcher applies its configured rank at selection.
  const stockLast = [...priority.filter(source => source !== 'factory'), ...priority.filter(source => source === 'factory')];
  const orderedRecords = stockLast.flatMap(source => records.filter(row => row.source === source)).filter(record => {
    if (selectedOrders.has(record)) return true;
    const blockers = checkProduction?.(record.requirements ?? [], { reserve: true }) ?? [];
    if (blockers.length) onSkip(record, blockers);
    return blockers.length === 0;
  });
  const reservationSources = new Set(['merchant', 'cargo', 'resident']);
  const reservedIds = new Set(orderedRecords.flatMap(record => (record.reserved ?? [])
    .filter(item => item.id && Number.isFinite(Number(item.num)) && Number(item.num) > 0).map(item => item.id)));
  const coveredReserve = new Map();
  // 招募/商船持有的是同一批订单预留，不是额外消费。先计入已选择的订单用量，
  // 让库存优先抵扣被保护的订单，独立补料仍归属于招募/商船自身。
  for (const record of orderedRecords) if (reservationSources.has(record.source)) for (const item of record.requirements ?? []) {
    const count = Number(item.num);
    if (!reservedIds.has(item.id) || !Number.isFinite(count) || count <= 0) continue;
    add(record.source, item.id, count);
    coveredReserve.set(item.id, (coveredReserve.get(item.id) ?? 0) + count);
  }
  for (const record of orderedRecords) {
    const missingReserve = new Map();
    for (const item of record.reserved ?? []) {
      const count = Number(item.num), covered = coveredReserve.get(item.id) ?? 0;
      if (!item.id || !Number.isFinite(count) || count <= covered) continue;
      // 未选择的订单来源仍保护库存；多个消费者只补齐一次共同预留水位。
      missingReserve.set(item.id, (missingReserve.get(item.id) ?? 0) + count - covered);
      coveredReserve.set(item.id, count);
    }
    for (const item of record.requirements ?? []) {
      if (reservationSources.has(record.source) && reservedIds.has(item.id)) continue;
      const count = Number(item.num);
      if (!Number.isFinite(count) || count <= 0) continue;
      // 同一记录合并补齐的水位后再展开配方，避免作物种子分别向上取整。
      add(record.source, item.id, count + (missingReserve.get(item.id) ?? 0));
      missingReserve.delete(item.id);
    }
    for (const [id, count] of missingReserve) add(record.source, id, count);
  }
  // Allocate already queued units once, in the user's order. Stock top-ups
  // and orders can both request the same item with different speed-up flags.
  for (const [id, requested] of speedDemand ?? []) {
    let stock = survey.have(id) + (finished.get(id) ?? 0), queued = incoming.get(id);
    for (const source of priority) {
      const count = requested.get(source) ?? 0;
      const fromStock = Math.min(stock, count), fromQueue = Math.min(queued, count - fromStock);
      stock -= fromStock; queued -= fromQueue;
      if (fromQueue > 0 && settings.factory.speedUpSources.includes(source)) {
        if (!speedQuota.has(id)) speedQuota.set(id, new Map());
        speedQuota.get(id).set(source, fromQueue);
      }
    }
  }
  return result;
}

export function stepKey(step) {
  const target = step.body?.buildingId ?? step.body?.index ?? '';
  return `${step.kind}:${Array.isArray(target) ? target.join('+') : target}`;
}

const lastOrderSent = new WeakMap();
const nativeTargetChecks = new WeakMap();

// A collection request alone is not proof that the stock increased. Check the
// actual reward before spending another set of reads on affected resident slots.
export function orderSlotsAfterHarvest(plan, results, attempted) {
  const gained = new Map();
  for (const { step, ok, body } of results) {
    if (!ok || !body || !(step.kind === 'gainFactory' || step.kind === 'collectProduct' || step.request === 'FarmHarvestRequest')) continue;
    const reply = normalize(body);
    let assets;
    if (step.kind === 'gainFactory') assets = reply.products?.asset;
    else if (step.kind === 'collectProduct') assets = reply.reward?.flatMap(row => row.product?.asset ?? []);
    else if (step.request === 'FarmHarvestRequest') assets = reply.reward?.map(item => item.reward).filter(Boolean);
    for (const asset of assets ?? []) if (asset.num > 0) gained.set(asset.id, (gained.get(asset.id) ?? 0) + asset.num);
  }
  return new Set(plan.orderDecisions.filter(d => {
    const needs = d.harvestNeeds ?? d.shortages;
    return !attempted.has(d.index) && needs.length && needs.every(row => (gained.get(row.id) ?? 0) >= row.missing);
  }).map(d => d.index));
}

export async function runWorldRound(client, protocol, plan, {
  config, player, cargoEnabled = () => false, attemptedOrders = new Set(),
  finishEnabled, ...options
}) {
  const execution = { ...options, config, player, cargoEnabled };
  const canFinish = finishEnabled ?? (() => !options.enabled || options.enabled('finishOrder'));
  const rerolls = new Map();
  if (canFinish()) {
    for (const step of plan.actions) {
      if (step.kind === 'denyOrder' && !step.materialRule) rerolls.set(step.body.index, step.orderKey);
    }
  }
  // 收货和交付都可能改变库存。原定换单的槽位在最后一起复核，先交此时能交的单。
  const initial = rerolls.size ? { actions: plan.actions.filter(step => step.kind !== 'denyOrder' || step.materialRule) } : plan;
  const result = await runWorld(client, protocol, initial, execution);
  for (const { step } of result.results) {
    if (step.kind === 'finishOrder' || step.kind === 'denyOrder') attemptedOrders.add(step.body.index);
  }
  result.followupCount = 0;
  if (!canFinish()) return result;
  const slots = orderSlotsAfterHarvest(plan, result.results, attemptedOrders);
  if (!slots.size && !rerolls.size) return result;
  try {
    const includeCargo = cargoEnabled();
    const survey = await surveyWorld(client, protocol, { config, player, ordersOnly: true, includeCargo });
    const allow = kind => canFinish() && (includeCargo || !cargoEnabled()) &&
      (kind === 'finishOrder' || kind === 'denyOrder' && rerolls.size > 0 && (!options.enabled || options.enabled(kind)));
    if (!allow('finishOrder')) return result;
    if (survey.orderCheckError) throw new Error(survey.orderCheckError);
    survey.orders = survey.orders.filter(order => rerolls.has(order.index)
      ? !attemptedOrders.has(order.index) && order.orderKey === rerolls.get(order.index)
      : slots.has(order.index));
    const settings = options.getSettings?.() ?? options.settings;
    const followup = planWorld(survey, { config, enabled: allow, settings,
      allowReroll: plan.allowReroll, minOrderExp: plan.minOrderExp,
      usage: options.getUsage?.() ?? options.usage });
    followup.actions = followup.actions.filter(step => step.kind !== 'denyOrder' || rerolls.has(step.body.index));
    const { results } = await runWorld(client, protocol, followup, { ...execution, enabled: allow });
    for (const { step } of results) attemptedOrders.add(step.body.index);
    result.followupCount = results.filter(({ step }) => !rerolls.has(step.body.index)).length;
    result.results.push(...results);
  } catch (error) {
    if (canFinish()) {
      const entry = { step: { kind: 'checkResidentOrders', label: rerolls.size ? '换单前核对居民订单' : '收货后核对居民订单' }, ok: false, error: error.message };
      result.followupCount = 1;
      result.results.push(entry);
      options.onStep?.(entry);
    }
  }
  return result;
}

// A harvest earlier in this round can complete the weekly order. Do not spend
// its stock based solely on a plan that was made before the harvest.
async function confirmResidentOrder(client, protocol, step, config, player, cargoEnabled, settings, usage) {
  if (!player) return { reason: '无法确认交单账号' };
  if (!step.manualCheck && !config) return { reason: '无法复核商人订单和贸易港预留' };
  const includeCargo = !step.manualCheck && cargoEnabled();
  const survey = await surveyWorld(client, protocol, { config, player, ordersOnly: true, includeWeekOrder: !step.manualCheck, includeCargo });
  const order = survey.orders.find(row => row.index === step.body.index);
  if (!order || (step.orderKey && order.orderKey !== step.orderKey)) return { reason: '这条居民订单已刷新或已处理，请查看当前订单' };
  if (step.manualCheck) {
    const decision = manualResidentOrderDecision(survey, order, config);
    if (decision.status !== 'ready') return { reason: decision.reason };
    return { action: { ...residentDeliveryAction(order, survey.orderOfTheDay), manualCheck: true, acceptStockWarning: step.acceptStockWarning } };
  }
  if (survey.orderCheckError) return { reason: survey.orderCheckError };
  if (order.workerId !== step.workerId || order.textId !== step.textId ||
    order.requirements.length !== step.requirements.length ||
    !order.requirements.every(item => step.requirements.some(old => item.id === old.id && item.num === old.num))) {
    return { reason: '订单需求已刷新，留待下一轮重新安排' };
  }
  const fresh = planWorld({ ...survey, orders: [order] }, { config, enabled: kind => kind === 'finishOrder', settings, usage });
  const current = fresh.actions.find(action => action.kind === 'finishOrder');
  if (!current) return { reason: fresh.orderDecisions[0].reason };
  if ((!includeCargo && cargoEnabled()) || current.weeklyBorrowed.some(item =>
    item.num > (step.weeklyBorrowed.find(old => old.id === item.id)?.num ?? 0))) {
    return { reason: '订单预留已变化，请重新核对库存' };
  }
  return { action: current };
}

// 手动换单只处理当前显示的一单，使用原拒单协议，不付费加速刷新。
export async function rerollResidentOrder(client,protocol,{index,orderKey,config,player,ledger,enabled=()=>true}){
 if(!Number.isSafeInteger(index)||index<0||typeof orderKey!=='string'||!orderKey)throw Error('请从当前订单列表选择换单');
 if(!enabled())throw Error('账号状态已变化，已取消换单');
 if(!Number.isSafeInteger(player?.level)||player.level<12)throw Error('手动换单需要角色12级');
 const session=watchResidentRefreshes(client,ledger,player),identity=session.manualRefresh?.identity;
 if(!identity||!ledger)throw Error('换单记录或角色身份不可用');
 if(session.get(index)?.key!==orderKey)throw Error('这条订单已变化，请刷新后再选择');
 const before=await surveyWorld(client,protocol,{config,player,ordersOnly:true,includeWeekOrder:false}),order=before.orders.find(r=>r.index===index);
 if(!order||order.orderKey!==orderKey)throw Error(order?.refreshPending?'上次换单结果待确认，暂不重复提交':'这条订单已刷新或已处理');
 if(order.refreshTime>0)throw Error('订单正在刷新，等待新订单');
 if(!order.requirements?.length)throw Error('当前订单需求未同步');
 if(session.get(index)?.key!==orderKey)throw Error('这条订单已变化，请刷新后再选择');
 const signature=session.get(index)?.signature;
 const key='manual-order:'+identity+':'+index+':'+createHash('sha256').update(signature).digest('hex').slice(0,24);
 if(ledger.hasKey(key))throw Error('上次换单结果待确认，暂不重复提交');
 if(!enabled())throw Error('账号状态已变化，已取消换单');
 const ticket=ledger.reserve({},{},{},{uniqueKey:key,details:{kind:'manualOrderRefresh',identity,index,signature}});
 // 使其他持有旧页面标识的提交/换单失效，下一次读取由记录与服务器签名核对。
 session.delete(index);
 try{
  await client.sendWatch('DenyOrderRequest',{index},{window:600});
  await surveyWorld(client,protocol,{config,player,ordersOnly:true,includeWeekOrder:false});
  if(session.get(index)?.signature&&session.get(index).signature!==signature){if(ledger.hasKey(key)){ledger.confirm(ticket);ledger.releaseCompletedKey(key);}return{index,label:'居民订单 #'+index+'已换单，等待新需求',status:'confirmed'};}
  throw Error('换单请求已发送，结果待确认；请稍后刷新，暂不重复提交');
 }catch(error){if(error.prompt&&error.request==='DenyOrderRequest')ledger.cancel(ticket);throw error;}
}

export async function submitResidentOrder(client, protocol, { index, orderKey, config, player, acceptStockWarning = false, enabled = () => true }) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 2147483647 || typeof orderKey !== 'string' || !orderKey) {
    throw new Error('请从当前居民订单列表中选择要交付的一单');
  }
  if (!enabled()) throw new Error('账号托管状态已变化，已取消手动交单');
  if (trackResidentOrders(client).get(index)?.key !== orderKey) throw new Error('这条居民订单已刷新或已处理，请查看当前订单');
  const step = { kind: 'finishOrder', request: 'FinishWorkerOrderRequest', response: 'FinishWorkerOrderResponse',
    body: { index }, orderKey, manualCheck: true, acceptStockWarning, label: '交付居民订单 #' + index };
  const { results } = await runWorld(client, protocol, { actions: [step] }, {
    config, player, allowMutate: true, enabled,
  });
  const [entry] = results;
  if (entry?.stockWarning) return { index, stockWarning: entry.stockWarning };
  if (!entry?.ok) throw new Error(entry?.error || '账号托管状态已变化，已取消手动交单');
  const reward = normalize(entry.body.reward);
  const prize = reward.asset.map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
  return { index, label: '已' + entry.step.label + '，获得' + prize, reward };
}

export async function startManualFactoryProduction(client, protocol, target, { config, player, settings, enabled, beforeInsertSend }) {
  const { buildingId, productId, productionKey } = target;
  if (typeof buildingId !== 'string' || !buildingId || typeof productionKey !== 'string' || !/^[0-9a-f]{24}$/.test(productionKey)) {
    throw new Error('请刷新工厂后选择要生产的物品');
  }
  const type = makeTypeResolver(config)(buildingId);
  const recipe = rowsOf(config, 'BuildingProduceCfg').find(row => row.itemId === productId && row.buildType === type);
  const costs = factoryRecipeCosts(recipe);
  if (!costs || !Number.isSafeInteger(recipe.unlockLevel)) throw new Error('这座工厂没有对应的生产配方');
  const name = displayMaterial(config, productId);
  const step = { kind: 'startProduce', request: 'StartFactoryProduceRequest', body: { buildingId, productId },
    costs, beforeInsertSend, displayProduct: name, displayFactory: displayBuilding(config, { buildingId, type }), label: '手动生产' + name + ' ×1' };
  const { results: [entry] } = await runFactoryProductionBatch(client, protocol, [step], {
    config, player, enabled,
    async checkSnapshot(building) {
      if (factoryProductionKey(player, building, recipe) !== productionKey) throw new Error('工厂队列或配方已变化，请重新选择产物');
      if (!costs.length) return;
      const { available } = await readOrderReservedStock(client, protocol, config, { player, settings, enabled, itemIds: costs.map(cost => cost.id) });
      for (const { id, num } of costs) {
        const free = Math.max(0, (available.get(id) ?? 0) - (beforeInsertSend ? resourceReserve(settings, id) || 0 : 0));
        if (free < num) throw new Error(displayMaterial(config, id) + '不足，扣除预留后可用 ' + free + '，本次需要 ' + num);
      }
    },
  });
  if (entry.status === 'unknown') return { confirmed: false, label: step.displayFactory + ' · ' + step.label + '，结果待核对' };
  if (!entry.ok) throw Object.assign(new Error(entry.error || '工厂排产未完成，请刷新后重试'), {
    notSent: !!(entry.failureError?.notSent || entry.failureError?.prompt && entry.failureError.request === step.request),
  });
  return { confirmed: true, label: step.displayFactory + '已安排生产' + name + ' ×1' };
}

export async function speedUpProduction(client, protocol, target, { player, enabled, config, getSettings }) {
  const { kind, buildingId, index, productId, finishTime, maxUse } = target;
  const farm = kind === 'farm';
  if ((!farm && kind !== 'factory') || typeof buildingId !== 'string' || !buildingId
    || typeof productId !== 'string' || !productId || !Number.isSafeInteger(finishTime) || finishTime <= 0
    || !Number.isSafeInteger(maxUse) || maxUse <= 0
    || (!farm && (!Number.isSafeInteger(index) || index < 0 || index > 2147483647))) {
    throw new Error('请刷新后选择正在生产的格子或生长中的农田');
  }
  const request = farm ? 'FarmSpeedUpRequest' : 'SpeedUpFactoryProduceRequest';
  if (!protocol[request]) throw new Error('当前游戏协议不支持这项加速');
  if (!enabled() || !player) throw new Error('账号连接已变化，请刷新建筑一览');
  const bag = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
  const useNum = Math.min(maxUse, bag.get(SPEED_UP_ITEM) ?? 0);
  if (!useNum) throw new Error('加速器库存为 0');
  const speedUp = { type: SPEED_UP_ITEM_TYPE, useNum };
  const step = {
    kind: farm ? 'farm' : 'speedUpProduce', request, manualCheck: true,
    body: farm ? { buildingId, param: speedUp } : { buildingId, index, speedUp },
    verify: { productId, finishTime }, costs: [{ id: SPEED_UP_ITEM, num: useNum }],
    label: buildingId + ' · 加速' + productId,
  };
  const { results: [entry] } = await runWorld(client, protocol, { actions: [step] }, { player, enabled, allowMutate: true });
  if (!entry?.ok) throw new Error(entry?.error || '账号状态已变化，已取消加速');
  if (entry.status !== 'confirmed') return { confirmed: false, label: step.label + '，结果待同步' };
  const spent = entry.step.costs[0].num;
  const result = { confirmed: true, useNum: spent, label: step.label + '，已使用 ' + spent + ' 个加速器' };
  if (farm || !enabled()) return result;
  // The game's factory button collects this factory's finished products after acceleration.
  const type = makeTypeResolver(config)(buildingId) ?? buildingId.replace(/^\d+/, '');
  const canCollect = () => !getSettings?.()?.factory?.blockedCollectionTypes?.includes(type);
  if (!canCollect()) return result;
  try {
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    const factory = water.building?.find(b => b.buildingId === buildingId)?.factory;
    if (factory?.finishedProducts?.length && enabled()) {
      await confirmFactoryProductionBeforeHarvest(client, protocol, buildingId, { player, enabled });
      if (!enabled() || !canCollect()) return result;
      const reply = await client.request('GainFactoryProduceRequest', { buildingId }, 'GainFactoryProduceResponse');
      result.label += reply?.products?.asset?.length ? '，已收取成品' : '，成品领取结果待同步';
    }
  } catch (error) {
    result.label += '，成品领取待核对：' + error.message;
  }
  return result;
}

// 名单可能在计划生成后变更。批量收取只发送仍允许的建筑，空批次不能发给服务端。
function checkCollectionTargets(step, blocked, config) {
  if (!blocked?.length) return step;
  if (step.request === 'FarmHarvestRequest') {
    if (blocked.includes('农田')) throw new AutomationSkip('农田已设置禁止自动领取');
    return step;
  }
  const resolveType = makeTypeResolver(config);
  const typeOf = id => resolveType(id) ?? id.replace(/^\d+/, '');
  if (step.kind === 'gainFactory') {
    if (blocked.includes(typeOf(step.body.buildingId))) throw new AutomationSkip('此工厂已设置禁止自动领取');
    return step;
  }
  const ids = step.body.buildingId.filter(id => !blocked.includes(typeOf(id)));
  if (!ids.length) throw new AutomationSkip('这些建筑已设置禁止自动领取');
  if (ids.length === step.body.buildingId.length) return step;
  const names = ids.map(buildingId => displayBuilding(config, { buildingId, type: typeOf(buildingId) }));
  return { ...step, body: { ...step.body, buildingId: ids }, label: '收取建筑产物：' + names.join('、') };
}

// 逐条执行。同类动作失败就跳过该类的剩余动作；被服务端拒过的具体动作记进 rejected，
// 循环模式下后续轮次不再重发（否则每轮都会骚扰一次同一个必败请求）。
export async function runWorld(client, protocol, plan, {
  allowMutate = false,
  window = 400,
  timeout = 15000,
  rejected = new Set(),
  onStep,
  enabled = () => true,
  config, player, cargoEnabled = () => false,
  settings = null, getSettings, getBlockedCollectionTypes, usage, getUsage, beforeStep, afterStep, cancelStep, factoryPlanCurrent = () => true,
} = {}) {
  if (!allowMutate) throw new Error('海面自动化会改变账号状态，需要 --yes');
  const results = [];
  const blocked = new Set();
  const failedRecipes = new Set();
  const confirmedBorrow = new Map();
  const checkDemandPlan = step => {
    if ((step.queueReplan || step.demandSources?.includes('guildRecruit')
      || step.factoryStrategy === 'smart' && (getSettings?.() ?? settings)?.factory.demandFirst)
      && !factoryPlanCurrent(step)) throw new AutomationSkip('库存或需求已变化，按最新状态重新排产');
  };
  const checkFactoryStep = step => {
    const recipe = rowsOf(config, 'BuildingProduceCfg').find(row => row.itemId === step.body.productId);
    const gate = factoryRecipeAvailability(recipe, client.festivals, Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000));
    if (recipe && !gate.allowed) throw new AutomationSkip(gate.reason);
    const failures = factoryFailures.get(client), failure = failures?.get(JSON.stringify([step.request, step.body]));
    if (failure && failure.signature === step.eligibilityKey && Date.now() < failure.until) {
      throw new AutomationSkip('前次生产被明确拒绝，等待条件变化：' + failure.reason);
    }
    if (failure) failures.delete(JSON.stringify([step.request, step.body]));
  };
  const rememberFactoryFailure = (step, error) => {
    if (!error?.prompt || error.request !== step.request) return;
    const failures = factoryFailures.get(client) ?? new Map(); factoryFailures.set(client, failures);
    failures.set(JSON.stringify([step.request, step.body]), { signature: step.eligibilityKey,
      until: /limited item not available/i.test(error.message) ? Infinity : Date.now() + 300000, reason: error.message });
  };
  for (let stepIndex = 0; stepIndex < plan.actions.length; stepIndex++) {
    const step = plan.actions[stepIndex];
    if (!enabled(step.kind)) continue;
    const currentSettings = getSettings?.() ?? settings;
    if (!step.manualCheck && !worldActionAllowed(currentSettings, step, config)) {
      const entry = { step, ok: false, skipped: true, error: '此动作已在设置中关闭或禁用' };
      results.push(entry); onStep?.(entry); continue;
    }
    const key = stepKey(step);
    const resident = step.kind === 'finishOrder' || step.kind === 'denyOrder';
    const recipe = step.kind === 'startProduce' ? JSON.stringify(step.body) : null;
    if (recipe && failedRecipes.has(recipe)) continue;
    // The wire request has no quantity field. Share preflight and settlement
    // within one factory, but keep each write serial for Prompt attribution.
    if (step.request === 'StartFactoryProduceRequest' && !step.response && config && exactAutomationId(player?.playerId)
      && exactAutomationId(player?.worldId) && paramOf(config, SLOTS_PARAM) > 0
      && protocol.OnWaterRequest && protocol.OnWaterResponse && protocol.AllItemRequest && protocol.AllItemResponse
      && (!beforeStep || (afterStep && cancelStep))) {
      const batch = [step];
      for (let next = stepIndex + 1; next < plan.actions.length; next++) {
        const candidate = plan.actions[next];
        // A stale stock target can reject a whole batch at preflight. Settle
        // demand jobs before validating optional refill jobs from the same factory.
        if (candidate.request !== step.request || candidate.response || candidate.body.buildingId !== step.body.buildingId || candidate.refillRule !== step.refillRule
          || candidate.demandDriven !== step.demandDriven) break;
        batch.push(candidate);
      }
      const result = await runFactoryProductionBatch(client, protocol, batch, {
        config, player, settings, getSettings, enabled, beforeStep, afterStep, cancelStep, window,
        beforeDispatch: checkDemandPlan,
        checkStep(action) {
          if (action.demandDriven === false && results.some(entry => !entry.ok && entry.step.demandDriven === true
            && entry.step.request === action.request && entry.step.body.buildingId === action.body.buildingId)) {
            throw new AutomationSkip('本轮同厂需求排产未确认，重新核对后再补库存');
          }
          if (action.needsConfirmedBorrow > (confirmedBorrow.get(action.body.productId) ?? 0)) throw new AutomationSkip('尚未确认居民订单已释放相应库存，稍后复查补产');
          if (failedRecipes.has(JSON.stringify(action.body)) || rejected.has(stepKey(action))) throw new AutomationSkip('前次生产未确认或已被拒绝，暂不重复提交');
          checkFactoryStep(action);
        },
      });
      stepIndex += batch.length - 1;
      for (const entry of result.results) {
        if (entry.failureError) rememberFactoryFailure(entry.step, entry.failureError);
        delete entry.failureError;
        results.push(entry); onStep?.(entry);
      }
      continue;
    }
    let entry;
    if (step.needsConfirmedBorrow > (confirmedBorrow.get(step.body?.productId) ?? 0)) {
      entry = { step, ok: false, skipped: true, error: '尚未确认居民订单已释放相应库存，稍后复查补产' };
    } else if (!resident && rejected.has(key)) entry = { step, ok: false, skipped: true, error: '刚被服务端拒过，跳过' };
    else if (blocked.has(step.kind)) entry = { step, ok: false, skipped: true, error: `同类动作已失败，本轮不再尝试` };
    else if (!protocol[step.request]) entry = { step, ok: false, error: `协议表里没有 ${step.request}` };
    else {
      // Direct CLI calls and manual orders use the same cross-connection
      // resource barrier, while a manual order keeps its own explicit consent.
      const localGuard = step.manualCheck || !beforeStep ? createActionGuard(client,
        () => step.manualCheck ? null : getSettings?.() ?? settings, null,
        { player, config, enabled: () => enabled(step.kind) }) : null;
      const prepareAction = localGuard?.before ?? beforeStep;
      const finishAction = localGuard?.after ?? afterStep;
      const cancelAction = localGuard?.cancel ?? cancelStep;
      let ticket = null, prepared = false, dispatched = false, writePending = false;
      let materialRefresh;
      let actual = step;
      let queueChanged = false;
      const observeQueue = ({name, body}) => {
        if (productionDemandChanged(name,body) || name === 'SCUpdateWaterBuilding'
          && body?.building?.some(b => step.refillSupply || b.buildingId === step.body.buildingId)) queueChanged = true;
      };
      if (step.queueReplan || step.refillRule) client.on?.('message',observeQueue);
      try {
        checkDemandPlan(step);
        if (step.refillRule && step.request === 'StartFactoryProduceRequest') throw new AutomationSkip('当前协议无法核对优先补库排产');
        // The official client waits for a business Response for planting. Keep
        // Prompt attribution until that reply/timeout, not a short silent window.
        const response = step.request === 'FarmPlantRequest' ? 'OkResponse' : step.response;
        if (step.request === 'FarmPlantRequest' && (!protocol.OkResponse || !protocol.OnWaterRequest || !protocol.OnWaterResponse)) {
          throw new AutomationSkip('当前协议不能确认农田播种结果');
        }
        if (step.materialRule === 'skipProduction' && results.some(entry =>
          entry.step.kind === 'finishOrder' && !entry.ok && entry.step.costs?.some(cost => step.requirements.some(item => item.id === cost.id)))) {
          throw new AutomationSkip('前一单的材料扣除尚未确认，重新核对库存后再换单');
        }
        if (step.kind === 'finishOrder') {
          if (!protocol[step.response]) throw new Error('当前协议不能确认居民订单交付结果');
          // WorkerOrderPop spaces consecutive commits by at least two seconds.
          const delay = (lastOrderSent.get(client) ?? 0) + 2000 - Date.now();
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          if (!enabled(step.kind)) continue;
          if (step.manualCheck || step.weeklyBorrowed?.length || currentSettings) {
            const fresh = await confirmResidentOrder(client, protocol, step, config, player, cargoEnabled, currentSettings, getUsage?.() ?? usage);
            if (fresh.reason) {
              entry = { step, ok: false, skipped: true, error: fresh.reason };
              results.push(entry);
              onStep?.(entry);
              continue;
            }
            if (!enabled(step.kind)) continue;
            actual = fresh.action;
          }
        }
        if (['StartFactoryProduceRequest','SetFactoryAutoProduceRequest'].includes(step.request)) {
          checkFactoryStep(step);
        }
        if (step.request === 'GainFactoryProduceRequest' && player) {
          // A harvest would erase the queue/finished baseline needed to prove
          // a previously unknown batch. Settle it before collecting products.
          await confirmFactoryProductionBeforeHarvest(client, protocol, step.body.buildingId, { player, enabled: () => enabled(step.kind) });
        }
        if (step.request === 'SetFactoryAutoProduceRequest') {
          if (!currentSettings?.factory.cooperateNative) throw new Error('原生生产协同已关闭');
          const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
          const factory = water.building?.find(b => b.buildingId === step.body.buildingId)?.factory;
          if (!factory || !(water.autoProduceForever || water.autoProduceEndTime > (Date.now()+(client.serverClockOffsetMs||0))/1000)) throw new Error('原生自动生产状态已变化，等待下轮重算');
          if (factory.autoProductId === step.body.productId) continue;
          if (factory.autoProductId !== step.previousProduct) throw new Error('自动生产目标已变化，等待下轮重算');
          const checks = nativeTargetChecks.get(client) ?? new Map(); nativeTargetChecks.set(client,checks);
          const prior = checks.get(step.body.buildingId);
          if (prior && Date.now() < prior.until) { results.push({step,skipped:true,reason:prior.pending?'前次目标调整待确认':'目标调整冷却中'}); continue; }
          checks.set(step.body.buildingId,{until:Date.now()+300000,pending:true});
        }
        let waterSnapshot, checkSpeedTime, interruption;
        if (step.refillRule || step.queueReplan) {
          interruption = await prepareFactoryInterruption(client, protocol, step, { player, config,
            getSettings: () => getSettings?.() ?? settings,
            enabled: () => !queueChanged && enabled(step.kind) && worldActionAllowed(getSettings?.() ?? settings, step, config) });
          waterSnapshot = interruption.water;
        }
        if (step.verify && (step.request === 'SpeedUpFactoryProduceRequest' || step.request === 'FarmSpeedUpRequest')) {
          waterSnapshot ??= normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
          const building = waterSnapshot.building?.find(b => b.buildingId === step.body.buildingId);
          const farm = step.request === 'FarmSpeedUpRequest';
          const jobs = building?.factory?.factoryQ?.filter(row => (row.idx ?? 0) === step.body.index);
          const job = farm ? building?.farm : jobs?.length === 1 ? jobs[0] : null;
          const finishTime = farm ? job?.ripeTime : job?.finishTime;
          const minutesLeft = () => Math.ceil((finishTime - Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000)) / 60);
          if (job?.productId !== step.verify.productId || finishTime !== step.verify.finishTime || minutesLeft() <= 0)
            throw new AutomationSkip('目标生产格或农田已变化或完成，请刷新后再试');
          const field = farm ? 'param' : 'speedUp';
          const speedUp = step.body[field], useNum = Math.min(speedUp.useNum, minutesLeft());
          if (useNum < speedUp.useNum) actual = { ...step, body: { ...step.body, [field]: { ...speedUp, useNum } },
            costs: [{ id: SPEED_UP_ITEM, num: useNum }], label: step.manualCheck ? step.label : `使用 ${useNum} 个加速器加速${step.displayFactory}生产` };
          checkSpeedTime = () => {
            if (!enabled(step.kind) || minutesLeft() < useNum) throw new AutomationSkip('状态或剩余时间已变化，请重新加速');
          };
        }
        ticket = await prepareAction?.(actual, { waterSnapshot });
        prepared = true;
        checkSpeedTime?.();
        const latestSettings = getSettings?.() ?? settings;
        if (!step.manualCheck && (step.kind === 'collectProduct' || step.kind === 'gainFactory' || step.request === 'FarmHarvestRequest')) {
          actual = checkCollectionTargets(actual, getBlockedCollectionTypes?.() ?? latestSettings?.factory?.blockedCollectionTypes, config);
        }
        if (!enabled(step.kind) || (!step.manualCheck && !worldActionAllowed(latestSettings, actual, config))) {
          if (prepared) await cancelAction?.(actual, ticket, { notSent: true });
          if(step.request==='SetFactoryAutoProduceRequest')nativeTargetChecks.get(client)?.delete(step.body.buildingId);
          continue;
        }
        if (step.kind === 'finishOrder') lastOrderSent.set(client, Date.now());
        if (resident && actual.orderKey) {
          const session = trackResidentOrders(client);
          if (session.get(step.body.index)?.key !== actual.orderKey) throw new Error('这条居民订单已刷新或已处理，请查看当前订单');
          if (actual.materialRule) {
            materialRefresh = session.get(step.body.index);
            materialRefresh.materialRefresh = true;
            materialRefresh.key = null; // 保留旧需求签名，服务器回读仍是旧单时不重复换单。
          } else session.delete(step.body.index); // A lost reply can still have consumed this slot.
        }
        if (response && protocol[response]) {
          checkDemandPlan(step);
          if (step.request === 'FarmPlantRequest') {
            const entries = factoryInsertions(player);
            if (!step.beforePlantSend && actual.body.args.some(arg => entries[arg.buildingId]?.jobs?.length)) {
              throw new AutomationSkip('农田正在为工厂插单补料');
            }
            step.beforePlantSend?.();
          }
          if (step.request === 'FarmHarvestRequest' && player) {
            const entries = factoryInsertions(player);
            if (actual.body.buildingId.some(id => entries[id]?.flight)) throw new AutomationSkip('插单播种待确认，稍后收获');
          }
          dispatched = writePending = true;
          const body = await client.request(step.request, actual.body, response, timeout);
          writePending = false;
          if (step.kind === 'finishOrder' && !body?.reward?.asset?.length) throw new Error('服务端尚未返回居民订单的交付奖励');
          for (const item of actual.weeklyBorrowed ?? []) confirmedBorrow.set(item.id, (confirmedBorrow.get(item.id) ?? 0) + item.num);
          entry = { step: actual, ok: true, body };
        } else {
          // 没有配套 Response：静默即成功，回包是 PromptResponse 就是被拒。
          dispatched = writePending = true;
          const sent = await client.sendWatch(step.request, actual.body, { window, beforeSend: () => {
            checkDemandPlan(step); interruption?.beforeSend(); checkSpeedTime?.();
          } });
          writePending = false;
          entry = { step: actual, ok: true, sent };
          if (interruption && step.request === 'CancelFactoryProduceRequest') {
            const confirmed = await interruption.cancellationConfirmed();
            entry = { step, ok:!!confirmed, status:confirmed ? 'confirmed' : 'unknown', reason:confirmed ? '已确认撤单' : '撤单结果待核对' };
          }
          if (step.request === 'SetFactoryAutoProduceRequest') {
            const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
            const confirmed = water.building?.find(b => b.buildingId === step.body.buildingId)?.factory?.autoProductId === step.body.productId;
            nativeTargetChecks.get(client).set(step.body.buildingId,{until:Date.now()+(confirmed?60000:300000),pending:!confirmed});
            entry = {step,ok:confirmed,status:confirmed?'confirmed':'unknown',reason:confirmed?'已回读确认自动生产目标；本次未逐项核对原队列':'目标切换结果待确认，暂不重复提交'};
          }
        }
        await finishAction?.(actual, ticket, entry);
      } catch (error) {
        // A later read/settlement failure cannot prove the completed write was unsent.
        const notSent = !dispatched || (writePending && error.notSent === true);
        if (materialRefresh && (notSent || error.prompt && error.request === step.request)) {
          const session = trackResidentOrders(client);
          if (session.get(step.body.index) === materialRefresh) session.delete(step.body.index);
        }
        if (prepared) await cancelAction?.(actual, ticket, { notSent, error });
        if (['StartFactoryProduceRequest','SetFactoryAutoProduceRequest'].includes(step.request)) rememberFactoryFailure(step, error);
        if(step.request==='SetFactoryAutoProduceRequest'&&(notSent||error.prompt&&error.request===step.request))nativeTargetChecks.get(client)?.delete(step.body.buildingId);
        if (recipe && error.code !== 'AUTOMATION_SKIP') failedRecipes.add(recipe);
        // Each plot has independent prerequisites. A failed build must not
        // suppress other plots, or prevent a later fresh survey from retrying it.
        if (error.code !== 'AUTOMATION_SKIP' && !resident && !['build', 'farm', 'upgrade', 'weekFactory', 'startProduce', 'speedUpProduce'].includes(step.kind)) {
          rejected.add(key);
          blocked.add(step.kind);
        }
        entry = { step, ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}), error: error.message };
        if (error.stockWarning) entry.stockWarning = error.stockWarning;
        if (step.request === 'FarmPlantRequest' && prepared && !notSent && !(error.prompt && error.request === actual.request)) {
          entry.status = 'unknown';
          entry.reason = '播种响应未确认：' + error.message;
          await finishAction?.(actual, ticket, entry);
        }
      }
      finally {
        if (step.queueReplan || step.refillRule) client.off?.('message',observeQueue);
      }
      linkOperationResult(entry, ticket);
    }
    results.push(entry);
    onStep?.(entry);
    if (entry.ok) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { results, rejected, blocked: [...blocked] };
}

// --- 资源田 ------------------------------------------------------------------
//
// 「哪些 gridIdx 是田、是什么类型」不在协议里也不在 591 张配置表里，只在 CDN bundle world_map 的
// JsonAsset 里。地图首次读取时自动缓存到 work/cdn/，编码是 resType * 10000 + cityId。
// 占田（ChallengeResFieldRequest）要求「该田所属城是我方城 + 有闲置且 durability > 0 的舰队」，
// 本模块保留 CLI 的只读报告与显式占田/放弃；总览快捷占领和可配置自动补位见 resource-field-automation.mjs。

export const MAP_DIR = path.resolve(import.meta.dirname, '../work/cdn');

export function mapPath(scenarioId) {
  return path.join(MAP_DIR, `world_map.world_map${scenarioId > 0 ? scenarioId : 1}.json`);
}

const mapLoads = new Map();

// 版本来自游戏包 src/settings.0afbd.json 的 assets.bundleVers.world_map。
async function fetchMap(file, scenarioId) {
  const getJson = async url => {
    const reply = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!reply.ok) throw new Error('地图下载失败（HTTP ' + reply.status + '）');
    return reply.json();
  };
  const cfg = await getJson(SERVER + 'remote/world_map/config.2ca75.json');
  const entry = Object.entries(cfg.paths).find(([, row]) => row[0] === 'world_map' + scenarioId && cfg.types[row[1]] === 'cc.JsonAsset');
  if (!entry) throw new Error('游戏资源中没有场景 ' + scenarioId + ' 的地图');
  const raw = await getJson(assetUrl('world_map', cfg, Number(entry[0]), 'cc.JsonAsset'));
  const map = parseMap(raw, file, scenarioId);
  fs.mkdirSync(MAP_DIR, { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(raw));
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return map;
}

export function loadMapAsset(id, resources = activeResources()) {
  const scenarioId = id > 0 ? id : 1;
  if (!Number.isSafeInteger(scenarioId)) throw new Error('地图场景编号无效');
  const file = resources ? resources.mapFiles[scenarioId] : mapPath(scenarioId);
  if (!file) throw new Error('当前资源版本中没有场景 ' + scenarioId + ' 的地图');
  if (!mapLoads.has(file)) {
    const job = (async () => {
      try { return parseMap(JSON.parse(fs.readFileSync(file, 'utf8')), file, scenarioId); }
      catch (error) { if (resources) throw error; return fetchMap(file, scenarioId); }
    })().catch(error => { mapLoads.delete(file); throw error; });
    mapLoads.set(file, job);
    if (mapLoads.size > 16) mapLoads.delete(mapLoads.keys().next().value);
  }
  return mapLoads.get(file);
}

function parseMap(raw, file, scenarioId) {
  const data = raw?.[5]?.[0]?.[2];
  if (!Array.isArray(data?.mapData) || !data.mapInfo?.width || data.mapData.length !== data.mapInfo.width * data.mapInfo.height)
    throw new Error('地图格子数据不完整');
  const { mapInfo, cityInfo, mapData } = data;
  return {
    file,
    scenarioId: scenarioId > 0 ? scenarioId : 1,
    width: mapInfo?.width ?? 0,
    height: mapInfo?.height ?? 0,
    tileWidth: mapInfo?.tileWidth ?? 0,
    tileHeight: mapInfo?.tileHeight ?? 0,
    cityInfo,
    pollutionData: data.pollutionData,
    cityAt(gridIdx) { return mapData[gridIdx] === undefined ? 0 : mapData[gridIdx] % 1000; },
    fieldCount: mapData.reduce((n, v) => n + (Math.floor(v / 10000) % 10 ? 1 : 0), 0),
    fieldAt(gridIdx) {
      const v = mapData[gridIdx];
      if (v === undefined) return null;
      const resType = Math.floor(v / 10000) % 10;
      if (!resType) return null;
      return { gridIdx, resType, cityId: v % 1000 };
    },
  };
}

// 舰队状态：1=IDLE 2=MOVING 3=BATTLING 4=REPAIRING 5=QUEUING（客户端 FleetState 枚举）。
export function idleFleets(survey) {
  return (survey.fleets ?? []).filter((f) => Number(f.state) === 1 && Number(f.durability) > 0);
}

export function formatFieldReport(survey, map, mapError) {
  const lines = [];
  const info = survey.resFields;
  const fields = info?.fields ?? [];
  const locked = survey.player?.level > 0 && survey.player.level < survey.worldOpenLevel;
  if (locked) lines.push(`世界玩法 ${survey.worldOpenLevel} 级开放，当前角色 ${survey.player.level} 级`);
  lines.push(info ? `已占资源田 ${fields.length}/${info.maxNum ?? '?'}` : '未取得资源田信息');
  for (const f of fields) {
    const at = map?.fieldAt(f.gridIdx);
    lines.push(`  gridIdx=${f.gridIdx} cityId=${f.cityId} type=${f.type}${at ? ` (地图: 城 ${at.cityId} 类型 ${at.resType})` : ''}`);
  }
  const idle = idleFleets(survey);
  if (!survey.fleets) lines.push('未取得舰队信息，可稍后刷新');
  else if (survey.fleets.length) lines.push(`舰队 ${survey.fleets.length} 支，其中闲置可用 ${idle.length} 支${idle.length ? `（${idle.map(f => f.buildingId).join('、')}）` : ''}`);
  else if (!locked) lines.push('当前账号暂无舰队');
  if (map) lines.push(`场景 ${map.scenarioId} · 地图 ${map.width}×${map.height}，资源田 ${map.fieldCount} 块，城池 ${Object.keys(map.cityInfo ?? {}).length} 座`);
  else lines.push('本次未取得场景地图' + (mapError ? '：' + mapError : ''));
  return lines.join('\n');
}

// 手动占田：显式给 gridIdx，舰队要么点名要么自动挑闲置的；条件不满足就直接拒绝，不发请求。
export function planFieldOccupy(survey, gridIdx, { fleetBuildingIds = [] } = {}) {
  const info = survey.resFields;
  if (survey.player?.level < survey.worldOpenLevel) return { error: `世界玩法 ${survey.worldOpenLevel} 级开放` };
  if (!info || !survey.fleets) return { error: '未取得资源田或舰队状态，请刷新后重试' };
  if (info && (info.fields ?? []).length >= (info.maxNum ?? 0)) {
    return { error: `已占 ${info.fields.length}/${info.maxNum} 块田，达到上限` };
  }
  const idle = idleFleets(survey);
  const picks = fleetBuildingIds.length > 0 ? fleetBuildingIds : idle.slice(0, 1).map((f) => f.buildingId);
  if (picks.length === 0) {
    return { error: '没有闲置且耐久>0 的舰队可派，占田会被服务端拒绝' };
  }
  const known = new Set((survey.fleets ?? []).map((f) => f.buildingId));
  const unknown = picks.filter((id) => !known.has(id));
  if (unknown.length > 0) return { error: `舰队 ${unknown.join(',')} 不在 MyFleetsResponse 里` };
  return {
    action: {
      kind: 'challengeField',
      request: 'ChallengeResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx), fleetBuildingIds: picks },
      label: `占田 gridIdx=${gridIdx} 派 ${picks.join(',')}`,
    },
  };
}

export function planFieldGiveUp(survey, gridIdx) {
  const owned = (survey.resFields?.fields ?? []).some((f) => Number(f.gridIdx) === Number(gridIdx));
  if (!owned) return { error: `gridIdx=${gridIdx} 不在我已占的田里` };
  return {
    action: {
      kind: 'giveUpField',
      request: 'GiveUpResFieldRequest',
      response: null,
      body: { resFieldGridIdx: Number(gridIdx) },
      label: `放弃资源田 gridIdx=${gridIdx}`,
    },
  };
}

export function formatWorldPlan(survey, plan) {
  const lines = [];
  lines.push(`人口 ${survey.population}/${survey.maxPopulation}  库存 ${survey.stock.size} 种  工厂 ${survey.factories.length} 栋  订单 ${survey.orders.length} 条`);
  if (survey.futurePopulation > survey.population) lines.push(`民居施工完成后人口 ${survey.futurePopulation}`);
  if (survey.resFields) {
    const fields = survey.resFields.fields ?? [];
    lines.push(`资源田 ${fields.length}/${survey.resFields.maxNum ?? '?'}${fields.length ? `  已占 ${fields.map((f) => f.gridIdx).join(',')}` : ''}`);
  }
  for (const action of plan.actions) lines.push(`动作 ${action.label}`);
  for (const note of [...survey.notes, ...plan.notes]) lines.push(`跳过 ${note}`);
  return lines.join('\n');
}
