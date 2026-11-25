import { normalize } from './worlds.mjs';
import { linkOperationResult } from './operation-log.mjs';
import { AutomationSkip, createActionGuard, resourceReserve, worldActionAllowed } from './automation-policy.mjs';
import { goldAccountKey } from './gold-reservations.mjs';
import { farmInventory } from './farm-planting.mjs';
import { pendingOrderMaterialSpends, readOrderReservedStock, settleOrderMaterialState } from './order-reservations.mjs';
import { factoryRecipeCosts, insertionRecipeReady } from './production-eligibility.mjs';
import { factoryProductionSnapshot, factoryProductionOperation } from './spend-evidence.mjs';
import { factoryInsertions } from './factory-insert-store.mjs';
import { insertionYieldsToProduction } from './factory-insertion-queue.mjs';
import { emitDiagnostic } from './trace-log.mjs';
import { simulatedFactoryQueueKey } from './factory-native-simulation.mjs';
import { editingFactoryQueue, readyRefillUnits, resolveFactoryRefills, refillCanTakeOver, refillSpeedUpJobs, refillGoal, refillHistoryFor } from './factory-refill.mjs';
import { productionDemandChanged, queueStamp } from './factory-replanning.mjs';

const pending = new Map(), busy = new Set();
const resourceIds = new Set(['GOLD', 'RUBY', 'EXP', 'ARENA_POINT', 'LEAGUE_POINT']);
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
export function factoryStockCapacity(config, player) {
  const base = Number(rows(config, 'GameParamCfg').find(row => row.paramName === '产品存量初始上限')?.paramValue);
  const bonus = Number(rows(config, 'VipLevelCfg').find(row => row.level === player?.vip?.vipLevel)?.effects?.find(([id]) => id === '加工品存量上限')?.[1] ?? 0);
  const cap = base + bonus;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new AutomationSkip('无法确认加工品库存上限');
  return cap;
}
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
export function confirmedFactoryIncoming(water) {
  const incoming = new Map();
  for (const row of water.building) if (row.factory) {
    if (row.level === 0 && Array.isArray(row.factory.factoryQ) && !row.factory.factoryQ.length
      && Array.isArray(row.factory.finishedProducts) && !row.factory.finishedProducts.length) continue;
    const other = factoryProductionSnapshot(water, row.buildingId);
    if (!other) throw new AutomationSkip('其他工厂的在产和待收库存不完整');
    for (const [id, count] of other.totals) incoming.set(id, (incoming.get(id) ?? 0) + count);
  }
  return incoming;
}

// Only alternatives behind the head need an ingredient comparison. Read it
// before the new operation reserves its own materials.
export async function readInsertionAlternativeStock(client, protocol, config, entry, context, isFull) {
  if (!entry || entry.flight || entry.remove?.length || entry.jobs.length < 2) return null;
  const ids = new Set(), now = clock(client), recipes = rows(config, 'BuildingProduceCfg');
  for (const job of entry.jobs.slice(1)) {
    if (job.at > now) break;
    if (job.id === entry.jobs[0].id || isFull?.(job.id)) continue;
    for (const [id, num] of recipes.find(r => r.itemId === job.id)?.costItem ?? []) if (num > 0) ids.add(id);
  }
  if (!ids.size) return null;
  return (await readOrderReservedStock(client, protocol, config, { ...context, itemIds:ids })).available;
}
const costsOf = steps => {
  const costs = new Map();
  for (const step of steps) for (const row of step.costs ?? []) {
    if (typeof row?.id !== 'string' || !row.id || resourceIds.has(row.id) || !Number.isSafeInteger(row.num) || row.num < 0) throw new AutomationSkip('批次生产只支持已确认的道具原料');
    const total = (costs.get(row.id) ?? 0) + row.num;
    if (!Number.isSafeInteger(total)) throw new AutomationSkip('批次生产消耗超出安全范围');
    if (total) costs.set(row.id, total);
  }
  return [...costs].map(([id, num]) => ({ id, num }));
};
const skipped = (step, error) => ({ step, ok: false, skipped: true, error });

export function captureManualFactoryProductionState(player) {
  const account = goldAccountKey(player), prefix = account + ':';
  if ([...busy].some(key => key.startsWith(prefix))) throw new Error('工厂仍在处理排产，请等待旧任务退出');
  return { account, batches: [...pending].filter(([key]) => key.startsWith(prefix))
    .map(([key, batch]) => ({ key, batch, buildingId: key.slice(prefix.length) })) };
}

export function assertManualFactoryProductionState(player, snapshot) {
  const current = captureManualFactoryProductionState(player);
  if (current.account !== snapshot.account || current.batches.length !== snapshot.batches.length
    || current.batches.some(row => !snapshot.batches.some(old => row.key === old.key && row.batch === old.batch))) {
    throw new Error('同步期间工厂记录已变化，请重新同步');
  }
}

export function retireManualFactoryProductionState(player, snapshot) {
  assertManualFactoryProductionState(player, snapshot);
  for (const row of snapshot.batches) pending.delete(row.key);
}

async function settlePrevious(client, player, account, key, enabled) {
  const previous = pending.get(key);
  if (!previous) return false;
  const check = () => {
    if (!enabled() || client.connected === false || goldAccountKey(player) !== account) throw new AutomationSkip('操作已暂停、断开或账号已切换，保留排产记录');
  };
  check();
  if (!previous.operation.confirmed && !await previous.operation.verify(client)) throw new AutomationSkip('上次批次排产结果待确认，暂缓领取和重复排产');
  check(); previous.operation.confirmed = true;
  const handles = pendingOrderMaterialSpends(player).filter(handle => handle.operation === previous.operation);
  const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
  check();
  if (handles.length) settleOrderMaterialState(player, { account: handles[0].account, handles }, stock);
  pending.delete(key);
  return true;
}

// Harvesting removes finished-product evidence. Resolve a previous uncertain
// production first, otherwise retain its products until a later readable round.
export async function confirmFactoryProductionBeforeHarvest(client, protocol, buildingId, { player, enabled = () => true } = {}) {
  if (!player) return false;
  if (factoryInsertions(player)[buildingId]?.flight) throw new AutomationSkip('工厂插单结果待确认，暂缓领取');
  const account = goldAccountKey(player), key = account + ':' + buildingId;
  // Manual/single-request production uses the shared material guard instead
  // of this module's batch map. Harvesting must preserve that evidence too.
  const handles = pendingOrderMaterialSpends(player).filter(handle => handle.operation.factoryBuildingId === buildingId);
  if (!pending.has(key) && !handles.length) return false;
  if (busy.has(key)) throw new AutomationSkip('工厂正在核对排产，暂缓领取成品');
  for (const name of ['OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse']) if (!protocol[name]) throw new AutomationSkip('当前协议无法核对上次排产，暂缓领取成品');
  busy.add(key);
  try {
    const live = () => enabled() && client.connected !== false && goldAccountKey(player) === account;
    const check = () => { if (!live()) throw new AutomationSkip('操作已暂停、断开或账号已切换，保留排产记录'); };
    check();
    const settled = await settlePrevious(client, player, account, key, live);
    const remaining = handles.filter(handle => pendingOrderMaterialSpends(player).includes(handle));
    if (!remaining.length) return settled;
    for (const handle of remaining) {
      if (!handle.operation.confirmed && !await handle.operation.verify(client)) throw new AutomationSkip('上次排产结果待确认，暂缓领取成品');
      check(); handle.operation.confirmed = true;
    }
    const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
    check();
    settleOrderMaterialState(player, { account: remaining[0].account, handles: remaining }, stock);
    return true;
  }
  catch (error) { throw error.code === 'AUTOMATION_SKIP' ? error : new AutomationSkip('上次排产尚未完整核对，暂缓领取成品：' + error.message); }
  finally { busy.delete(key); }
}

export function liveFactoryRefill(buildingId, {water, stock, incoming, cap, settings, config, client, player}) {
  const owned = id => stock.get(id) ?? 0;
  return resolveFactoryRefills(water.building,settings,{config,cap,owned,available:id => owned(id) - resourceReserve(settings,id),
    incoming,now:clock(client),festivals:client.festivals,history:refillHistoryFor(player),record:true,
    autoProduceForever:water.autoProduceForever,autoProduceEndTime:water.autoProduceEndTime}).get(buildingId);
}

export async function prepareFactoryInterruption(client, protocol, step, {player, config, enabled, getSettings}) {
  const rule = step.refillRule, {buildingId} = step.body, productId = rule?.productId;
  await confirmFactoryProductionBeforeHarvest(client, protocol, buildingId, {player, enabled});
  const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
  const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
  const live = factoryProductionSnapshot(water, buildingId);
  if (!enabled() || !live
    || live.building.factory.autoProductId && (water.autoProduceForever || water.autoProduceEndTime > clock(client))) {
    throw new AutomationSkip('工厂生产状态已变化，等待重新排产');
  }
  const factorySettings = getSettings()?.factory, rules = factorySettings?.refillRules ?? [];
  const verifiedSettings = JSON.stringify(factorySettings);
  const cap = factoryStockCapacity(config, player);
  const incoming = rules.length ? confirmedFactoryIncoming(water) : new Map();
  const active = rules.length ? liveFactoryRefill(buildingId,{water,stock,incoming,cap,settings:getSettings(),config,client,player}) : undefined;
  if (step.queueReplan && (queueStamp(live.queue) !== step.verify.queue
    || step.verify.stock.some(([id,n]) => (stock.get(id) ?? 0) !== n))) {
    throw new AutomationSkip('库存或等待队列已变化，重新核对需求');
  }
  if (active?.rule?.productId !== productId || !!active?.supply !== !!step.refillSupply
    || rule && (stock.get(productId) ?? 0) + readyRefillUnits(water.building, productId) >= refillGoal(rule, cap)) {
    throw new AutomationSkip('补库库存已变化，等待重新排产');
  }
  const cancel = step.request === 'CancelFactoryProduceRequest';
  const job = live.queue.find(j => (j.idx ?? 0) === step.body.index);
  if (!job || job.productId !== step.verify.productId || job.productId === productId
    || (cancel ? job === live.queue[0] || job.finishTime : !refillSpeedUpJobs(live.queue, productId, clock(client)).includes(job))) {
    throw new AutomationSkip('工厂队列已变化，等待重新排产');
  }
  if (rule) {
    const missing = refillGoal(active.rule, cap) - (stock.get(productId) ?? 0) - (incoming.get(productId) ?? 0);
    const available = id => (stock.get(id) ?? 0) - resourceReserve(getSettings(), id);
    if (!refillCanTakeOver(live.queue, productId, missing, factoryRecipeCosts(active.recipe), available))
      throw new AutomationSkip('补库原料不足或已排足，保留当前队列');
  }
  function beforeSend() {
    const now = clock(client);
    const insertion = factoryInsertions(player)[buildingId];
    if (!enabled() || JSON.stringify(getSettings()?.factory) !== verifiedSettings || (step.queueReplan ? insertion : editingFactoryQueue(insertion)) ||
      cancel && (!live.queue.some(j => j.finishTime > now) || live.queue.some(j => j.finishTime && j.finishTime <= now))) {
      throw new AutomationSkip('工厂设置或生产格已变化，等待重新排产');
    }
  }
  beforeSend();
  return {water, beforeSend, async cancellationConfirmed() {
    const after = factoryProductionSnapshot(normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse')), buildingId);
    return !!after && !after.queue.some(j => (j.idx ?? 0) === step.body.index && j.productId === job.productId)
      && (after.totals.get(job.productId) ?? 0) < live.totals.get(job.productId);
  }};
}

// The wire protocol accepts one product per request. Reserve a bounded batch,
// keep its writes serial, then reconcile it once against queue + finished stock.
export async function runFactoryProductionBatch(client, protocol, steps, {
  config, player, settings = null, getSettings, enabled = () => true,
  beforeStep, afterStep, cancelStep, window = 400, onStep, checkStep, checkSnapshot, beforeDispatch,
} = {}) {
  if (!Array.isArray(steps) || !steps.length) return { results: [] };
  const results = [], attemptedEntries = new Set(), current = () => getSettings?.() ?? settings;
  let account, lock, batch, batchStep, ticket, prepared = false, acquired = false, actionGuard;
  const supply = steps[0].refillSupply;
  let supplyChanged = false;
  const observeSupply = ({name,body}) => {
    if (productionDemandChanged(name,body) || name === 'SCUpdateWaterBuilding' && body?.building?.length) supplyChanged = true;
  };
  const checkDispatch = step => {
    beforeDispatch?.(step);
    if (supplyChanged) throw new AutomationSkip('上游补料的库存或队列已变化，等待重新排产');
  };
  const publish = () => {
    const members = [...attemptedEntries];
    const first = members[0];
    if (!first && ticket) linkOperationResult(results.find(row => row.failureError) || results[0], ticket);
    if (first && linkOperationResult(first, ticket).operationId) {
      const products = new Map();
      for (const member of members) {
        const name = member.step.displayProduct || member.step.body.productId;
        products.set(name, (products.get(name) ?? 0) + 1);
        linkOperationResult(member, ticket);
        if (member !== first) member.operationMember = true;
      }
      first.operationSummary = (first.step.displayFactory || first.step.body.buildingId) + '排产'
        + [...products].map(([name, count]) => name + ' ×' + count).join('、');
      first.operationDetail = members.map(member => member.step.label).join('\n');
    }
    for (const entry of results) onStep?.(entry);
    return { results };
  };
  try {
    account = goldAccountKey(player);
    const buildingId = steps[0].body?.buildingId;
    if (typeof buildingId !== 'string' || !buildingId || steps.some(step => step.kind !== 'startProduce'
      || step.request !== 'StartFactoryProduceRequest' || step.body?.buildingId !== buildingId || typeof step.body.productId !== 'string' || !step.body.productId
      || Object.values(step.counters ?? {}).some(Boolean))) throw new AutomationSkip('批次必须属于同一工厂的普通排产');
    for (const name of ['StartFactoryProduceRequest', 'OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse']) if (!protocol[name]) throw new AutomationSkip('当前协议无法完整核对批次排产');
    lock = account + ':' + buildingId;
    if (busy.has(lock)) { for (const step of steps) results.push(skipped(step, '同一工厂正在处理排产')); return publish(); }
    busy.add(lock); acquired = true;
    if (supply) client.on?.('message',observeSupply);
    const live = () => enabled('startProduce') && client.connected !== false && goldAccountKey(player) === account;
    const ensureLive = () => { if (!live()) throw new AutomationSkip('排产已暂停、断开或账号已切换'); };
    ensureLive();
    await settlePrevious(client, player, account, lock, live);
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    ensureLive();
    const snapshot = factoryProductionSnapshot(water, buildingId);
    if (!snapshot) throw new AutomationSkip('无法完整确认工厂队列和待收成品');
    if (steps.some(step => step.factoryStrategy === 'nativeSimulation' && step.simulatedQueueKey !== simulatedFactoryQueueKey(snapshot.building.factory)))
      throw new AutomationSkip('模拟原生的生产位或主产物已变化，等待重新排产');
    if (snapshot.building.factory.autoProductId && (water.autoProduceForever || water.autoProduceEndTime > clock(client))) throw new AutomationSkip('游戏自动生产已开启，保留原队列和目标');
    const slots = Number(rows(config, 'BuildingProduceParamCfg').find(row => row.paramName === '制造位上限')?.paramValue);
    if (!Number.isSafeInteger(slots) || slots < 1) throw new AutomationSkip('无法确认工厂制造位上限');
    const selected = steps.slice(0, Math.max(0, slots - snapshot.queue.length));
    if (!selected.length) throw new AutomationSkip('工厂生产格已满，等待下轮重新排产');
    const factorySettings = JSON.stringify(current()?.factory);
    const reserves = new Map(costsOf(selected).map(row => [row.id, resourceReserve(current(), row.id)]));
    const check = async step => {
      ensureLive();
      checkDispatch(step);
      if (!worldActionAllowed(current(), step, config)) throw new AutomationSkip('普通排产已关闭或此工厂已禁用');
      if (JSON.stringify(current()?.factory) !== factorySettings) throw new AutomationSkip('工厂设置已变化，等待重新排产');
      if ([...reserves].some(([id, amount]) => resourceReserve(current(), id) > amount)) throw new AutomationSkip('材料保留量已提高，等待重新核对库存');
      const recipe = rows(config, 'BuildingProduceCfg').find(row => row.itemId === step.body.productId);
      if (!recipe || recipe.unlockLevel > snapshot.building.level || !buildingId.endsWith(recipe.buildType)) throw new AutomationSkip('工厂等级或配方条件已变化');
      const expected = costsOf([{ costs: (recipe.costItem ?? []).map(([id, num]) => ({ id, num: Number(num) })) }]);
      const actual = costsOf([step]);
      if (JSON.stringify([...expected].sort((a,b) => a.id.localeCompare(b.id))) !== JSON.stringify([...actual].sort((a,b) => a.id.localeCompare(b.id)))) throw new AutomationSkip('生产配方消耗已变化，等待重新排产');
      if (recipe.limitType || recipe.buildType === '活动工厂') {
        const now = clock(client);
        const open = Array.isArray(client.festivals) && client.festivals.some(event => event.festivalData?.limitTimeItem?.some(row => row.item === recipe.limitType
          && Number.isSafeInteger(row.openTime) && Number.isSafeInteger(row.closeTime) && row.openTime > 0 && row.openTime <= now && now <= row.closeTime));
        if (!open) throw new AutomationSkip('当前活动未开放此生产配方');
      }
      await checkStep?.(step);
      ensureLive();
      if (!worldActionAllowed(current(), step, config) || JSON.stringify(current()?.factory) !== factorySettings
        || [...reserves].some(([id, amount]) => resourceReserve(current(), id) > amount)) throw new AutomationSkip('生产设置已变化，等待重新核对');
    };
    for (const step of selected) await check(step);
    if (checkSnapshot) { await checkSnapshot(snapshot.building); ensureLive(); }
    const refill = selected[0].refillRule;
    const insertion = selected[0].factoryStrategy || refill ? factoryInsertions(player)[buildingId] : null;
    const alternativeStock = refill ? null : await readInsertionAlternativeStock(client, protocol, config, insertion, {player,settings:current(),enabled:live});
    ensureLive();
    batch = { attempted: [], sealed: false };
    batch.operation = factoryProductionOperation(water, buildingId, batch);
    batchStep = { ...selected[0], costs: costsOf(selected), factoryBatch: batch, label: (selected[0].displayFactory || buildingId) + '连续排产' };
    actionGuard = beforeStep && afterStep && cancelStep ? { before: beforeStep, after: afterStep, cancel: cancelStep }
      : createActionGuard(client, current, null, { player, enabled: live });
    ticket = await actionGuard.before(batchStep, { waterSnapshot: water }); prepared = true;
    ensureLive();
    const stock = batch.checkedStock ?? farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
    ensureLive();
    const cap = factoryStockCapacity(config, player);
    const incoming = confirmedFactoryIncoming(water);
    const rules = current()?.factory?.refillRules ?? [];
    let refillTarget;
    if (refill || selected[0].factoryStrategy && rules.length) {
      const active = liveFactoryRefill(buildingId,{water,stock,incoming,cap,settings:current(),config,client,player});
      if (refill?.productId !== active?.rule.productId || !!selected[0].refillSupply !== !!active?.supply)
        throw new AutomationSkip('补库状态已变化，等待重新排产');
      if (refill) refillTarget = Math.min(refillGoal(refill,cap),refillGoal(active.rule,cap));
      if (refill && snapshot.queue.some(j => !j.finishTime && j.productId !== refill.productId)) throw new AutomationSkip('等待撤下排队中的其他产品');
    }
    const projected = new Map(incoming);
    for (const step of selected) {
      const id = step.body.productId;
      projected.set(id, (projected.get(id) ?? 0) + 1);
      if ((stock.get(id) ?? 0) + projected.get(id) > cap) throw new AutomationSkip('库存、在产和待收合计将超过上限，等待重新排产');
      const preferences = current(), independent = preferences?.alliance?.enabled && (preferences.alliance.recruit && preferences.alliance.recruitProduction
        || preferences.guildShip?.enabled && preferences.guildShip.produceMissing);
      const stockOnly = step.demandDriven === false || step.demandDriven == null && preferences?.factory?.demandFirst === false && !independent;
      if (refill && (id !== refill.productId || (stock.get(id) ?? 0) + projected.get(id) > refillTarget)) throw new AutomationSkip('优先补库已排足，等待重新排产');
      if (!refill && stockOnly && preferences && step.factoryStrategy !== 'nativeSimulation' && (stock.get(id) ?? 0) + projected.get(id) > preferences.factory.keepStock) throw new AutomationSkip('最新库存已达到备货水位，等待重新排产');
      // This start must succeed before the next wire request can use the space.
      if (step.factoryStrategy === 'nativeSimulation') for (const { id: input, num } of step.costs) {
        projected.set(input, (projected.get(input) ?? 0) - num);
      }
    }
    let stopped = '';
    for (const step of selected) {
      if (stopped) { results.push(skipped(step, stopped)); continue; }
      let attempted = false;
      try {
        await check(step);
        pending.set(lock, batch);
        batch.attempted.push({ body: { ...step.body }, costs: structuredClone(step.costs ?? []) }); attempted = true;
        const sent = await client.sendWatch(step.request, step.body, { window, beforeSend: () => {
          ensureLive();
          checkDispatch(step);
          if (!worldActionAllowed(current(), step, config) || JSON.stringify(current()?.factory) !== factorySettings) throw new AutomationSkip('排产策略或目标已变化，等待重新排产');
          if (step.latestStart != null && clock(client)>step.latestStart) throw new AutomationSkip('第二生产位剩余时间不足，等待重新排产');
          if (step.beforeInsertSend) step.beforeInsertSend();
          else if (refill) {
            if (editingFactoryQueue(factoryInsertions(player)[buildingId])) throw new AutomationSkip('等待工厂插单操作确认');
          } else {
            const entry = factoryInsertions(player)[buildingId];
            const isFull = id => (stock.get(id) ?? 0) + (incoming.get(id) ?? 0) >= cap;
            const now = clock(client);
            const canMake = id => insertionRecipeReady(rows(config,'BuildingProduceCfg').find(row => row.itemId === id),
              snapshot.building.level, client.festivals, now, item => ((alternativeStock ?? stock).get(item) ?? 0) - resourceReserve(current(),item));
            if (entry && (entry.revision !== insertion?.revision || batch.attempted.length > 1 ||
              !insertionYieldsToProduction(entry, now, isFull, canMake))) throw new AutomationSkip('工厂正在执行排产清单中的插单');
          }
        } });
        const entry = { step, ok: false, status: 'unknown', sent, reason: '批次已发送，等待统一核对' };
        results.push(entry); attemptedEntries.add(entry);
      } catch (error) {
        const notSent = !attempted || error.notSent === true || error.prompt && error.request === step.request;
        emitDiagnostic(client, 'factory-production-write-stopped', { buildingId, productId: step.body.productId,
          notSent: !!notSent, rejected: !!(error.prompt && error.request === step.request), reason: error.message });
        if (attempted && notSent) batch.attempted.pop();
        const entry = { step, ok: false, ...(notSent ? { skipped: error.code === 'AUTOMATION_SKIP' } : { status: 'unknown' }), error: error.message, failureError: error };
        results.push(entry); if (attempted && !notSent) attemptedEntries.add(entry);
        stopped = '本批排产已停止，等待状态和设置重新核对';
      }
    }
    for (const step of steps.slice(selected.length)) results.push(skipped(step, '本次空闲生产格不足，等待下轮重新排产'));
    batch.sealed = true;
    if (!batch.attempted.length) {
      await actionGuard.cancel(batchStep, ticket, { notSent: true, error: results.find(row => row.failureError)?.failureError });
      prepared = false; pending.delete(lock);
    } else {
      try {
        ensureLive();
        const confirmed = await batch.operation.verify(client);
        ensureLive();
        if (confirmed) {
          batch.operation.confirmed = true;
          const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
          ensureLive(); batch.settledStock = stock;
        }
      } catch { /* Sent requests keep their immutable baseline across reconnect. */ }
      const outcome = { ok: false, sent: true, status: 'unknown' };
      await actionGuard.after(batchStep, ticket, outcome); prepared = false;
      if (batch.operation.confirmed && batch.settledStock && live()) {
        pending.delete(lock);
        for (const entry of attemptedEntries) {
          entry.ok = true; entry.status = 'confirmed'; entry.reason = '已统一核对队列、待收成品及库存'; delete entry.sent; delete entry.error; delete entry.failureError;
        }
      } else for (const entry of attemptedEntries) {
        entry.ok = false; entry.status = 'unknown'; entry.reason = '批次排产结果待确认，保留已发送部分，暂不重复提交';
      }
    }
  } catch (error) {
    emitDiagnostic(client, 'factory-production-batch-blocked', { buildingId: steps[0]?.body?.buildingId,
      attempted: batch?.attempted?.length ?? 0, reason: error.message });
    if (batch) batch.sealed = true;
    if (prepared && !batch?.attempted.length) await actionGuard.cancel(batchStep, ticket, { notSent: true });
    if (batch?.attempted.length && prepared) {
      try { await actionGuard.after(batchStep, ticket, { ok: false, sent: true, status: 'unknown' }); }
      catch (settlementError) { await actionGuard.cancel(batchStep, ticket, { error: settlementError }); }
    }
    for (const step of steps) if (!results.some(entry => entry.step === step)) results.push({ ...skipped(step, error.message), failureError: error });
  } finally {
    if (supply) client.off?.('message',observeSupply);
    if (acquired) busy.delete(lock);
  }
  return publish();
}
