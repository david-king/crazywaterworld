import crypto from 'node:crypto';
import { RESOURCE } from './config.mjs';
import { resourceReserve } from './automation-policy.mjs';
import { normalize } from './worlds.mjs';
import { uidText } from './hero-equipment.mjs';
import { adAccess, channelUnavailable, prepareAd } from './ad-shop.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';

const RESOURCE_IDS = new Set(Object.values(RESOURCE));
const RESOURCE_NAMES = Object.fromEntries(Object.entries(RESOURCE).map(([number, id]) => [number, id]));
const TOKEN_TTL_MS = 90_000;
const MAX_QUANTITY = 10_000;
const SHOP_ROWS = [
  { id: 'discount', title: '折扣商店', type: null, kind: 'discount' },
  { id: 'ad', title: '广告商店', type: null, kind: 'ad' },
  { id: 'arena', title: '竞技场商店', type: 1, kind: 'arena' },
  { id: 'guild', title: '联盟商店', type: 2, kind: 'guild' },
  { id: 'shuimu', title: '水姆商店', type: 13, kind: 'shuimu' },
  { id: 'league', title: '积分赛商店', type: 4, kind: 'league' },
  { id: 'vip', title: 'VIP商店', type: 3, kind: 'vip' },
];
export const SHOP_CATALOG = Object.freeze(SHOP_ROWS.map(row => Object.freeze({ ...row })));
const byShopId = new Map(SHOP_ROWS.map(row => [row.id, row]));
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const whole = value => Number.isSafeInteger(value) && value >= 0;
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const checkEnabled = enabled => { if (enabled && !enabled()) throw new Error('操作已暂停或账号已切换'); };
const request = async (client, name, body = {}, response = name.replace(/Request$/, 'Response')) => normalize(await client.request(name, body, response));
const iconUrl = (icon, id) => {
  try {
    const value = icon?.(id);
    return typeof value === 'string' && value ? value : typeof value?.thumb === 'string' && value.thumb ? value.thumb : undefined;
  } catch { return undefined; }
};
const idText = value => {
  if (typeof value === 'string' && value) return value;
  if (Number.isSafeInteger(value)) return String(value);
  return uidText(value);
};
const roleIdentity = player => {
  const role = idText(player?.playerId ?? player?.id), world = idText(player?.worldId);
  if (!role || !world) throw new Error('无法确认购买角色和区服');
  return { role, world, key: role + ':' + world };
};
const materialName = (config, id) => {
  const resourceName = config?.resourceName?.(id);
  const itemName = config?.materialName?.(id);
  return resourceName && resourceName !== '资源 #' + id ? resourceName
    : itemName && itemName !== '未知材料' ? itemName : id;
};
function ensureState(state) {
  if (!state || typeof state !== 'object') throw new Error('商店状态未初始化');
  state.tokens ??= new Map();
  state.inFlight ??= new Set();
  if (!(state.tokens instanceof Map) || !(state.inFlight instanceof Set)) throw new Error('商店状态异常');
  for (const [token, record] of state.tokens) if (!state.inFlight.has(token) && (!record || record.expiresAt < Date.now())) state.tokens.delete(token);
  while (state.tokens.size > 500) {
    const oldest = [...state.tokens.keys()].find(token => !state.inFlight.has(token));
    if (!oldest) break;
    state.tokens.delete(oldest);
  }
  return state;
}
export function createShopState() { return { tokens: new Map(), inFlight: new Set() }; }
function assertProtocol(protocol, names) {
  if (!protocol) return;
  for (const name of names) if (!protocol[name]) throw new Error('当前协议缺少商店消息：' + name);
}
function moduleReason(config, player, moduleId) {
  const row = rows(config, 'ModuleOpenCfg').find(entry => entry.moduleId === moduleId);
  if (!row) return '缺少' + moduleId + '开放等级配置';
  if (!whole(row.playerLevel) || row.playerLevel < 1 || !whole(player?.level)) return '无法确认' + moduleId + '开放等级';
  return player.level < row.playerLevel ? moduleId + '在角色 ' + row.playerLevel + ' 级开放' : '';
}
async function buildingGate(client, config, type, enabled) {
  const unlocks = rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === type && typeof row.buildingId === 'string');
  if (!unlocks.length) return '缺少' + type + '建筑配置，无法确认商店资格';
  checkEnabled(enabled);
  const water = await request(client, 'OnWaterRequest', {}, 'OnWaterResponse');
  checkEnabled(enabled);
  if (!Array.isArray(water?.building)) return '无法确认' + type + '建筑状态';
  if (!water.building.every(row => typeof row?.buildingId === 'string' && whole(row.level))) return '建筑状态不完整，无法确认' + type + '资格';
  const types = new Map(unlocks.map(row => [row.buildingId, row.buildingType]));
  const level = Math.max(0, ...water.building.map(row => types.get(row.buildingId) === type ? row.level : 0));
  return level > 0 ? '' : '尚未建成' + type + '建筑';
}
function openDayReason(config, player, client, gameplay) {
  const required = gameplayOpenDay(config, player, gameplay);
  if (!whole(required) || required < 1) return '缺少' + gameplay + '开放日配置';
  const elapsed = worldOpenDays(player, clock(client));
  if (!whole(elapsed) || elapsed < 1) return '无法确认区服开放时间';
  return elapsed < required ? gameplay + '将在区服开放第 ' + required + ' 天开放' : '';
}
async function shopGate(client, config, shop, { player, clientInfo, enabled }) {
  if (shop.kind === 'ad') return { reason: channelUnavailable(config?.tables, player, clientInfo) || '' };
  if (shop.kind === 'discount' || shop.kind === 'vip') return { reason: await buildingGate(client, config, '商店', enabled) };
  if (shop.kind === 'arena') return { reason: await buildingGate(client, config, '竞技场', enabled) };
  if (shop.kind === 'guild') {
    const levelReason = moduleReason(config, player, '联盟');
    if (levelReason) return { reason: levelReason };
    const guildId = idText(player?.guildId);
    if (!guildId || !/^\d+$/.test(guildId) || BigInt(guildId) <= 0n || BigInt(guildId) % 1000n === 0n) return { reason: '尚未加入联盟' };
    return { reason: '' };
  }
  if (shop.kind === 'shuimu') return { reason: openDayReason(config, player, client, '水姆商店') };
  if (shop.kind === 'league') {
    const days = openDayReason(config, player, client, '跨服积分赛');
    if (days) return { reason: days };
    return { reason: moduleReason(config, player, '跨服积分赛') };
  }
  return { reason: '' };
}
function safeAmount(value, label) {
  const n = value == null ? NaN : Number(value);
  if (!whole(n)) throw new Error('无法确认' + label);
  return n;
}
function inventoryMap(resources, items) {
  if (!Array.isArray(resources?.list) || !Array.isArray(items?.items)) throw new Error('无法完整读取商店货币库存');
  const out = new Map();
  for (const row of resources.list) {
    const id = RESOURCE_NAMES[row?.res];
    if (!id || out.has(id)) throw new Error('资源库存编号异常');
    out.set(id, safeAmount(row.amount, '资源库存'));
  }
  for (const row of items.items) {
    if (typeof row?.itemId !== 'string' || !row.itemId || out.has(row.itemId)) throw new Error('道具库存编号异常');
    out.set(row.itemId, safeAmount(row.num, '道具库存'));
  }
  return out;
}
async function readBalances(client, enabled) {
  checkEnabled(enabled);
  const resources = await request(client, 'AllResourceRequest', {}, 'AllResourceResponse');
  checkEnabled(enabled);
  const items = await request(client, 'AllItemRequest', {}, 'AllItemResponse');
  checkEnabled(enabled);
  return inventoryMap(resources, items);
}
function displayAsset(config, asset, icon) {
  if (!asset || ![0, 1].includes(asset.type) || typeof asset.id !== 'string' || !asset.id) return null;
  if (asset.type === 1 && !RESOURCE_IDS.has(asset.id)) return null;
  const num = Number(asset.num);
  if (!whole(num)) return null;
  const image = iconUrl(icon, asset.id);
  return { id: asset.id, name: materialName(config, asset.id), num, ...(image ? { icon: image } : {}) };
}
function priceInfo(config, raw, factorPercent, icon) {
  if (!raw || ![0, 1].includes(raw.type)) return { price: { id: '', name: '未知货币', num: 0 }, key: null, error: '商品货币类型无法确认' };
  const base = Number(raw.num);
  if (!whole(base)) return { price: { id: '', name: '未知货币', num: 0 }, key: null, error: '商品价格无法确认' };
  if (base === 0 && raw.id === '') return { price: { id: '', name: '免费', num: 0 }, key: JSON.stringify([raw.type, '', 0, factorPercent]), error: '' };
  if (typeof raw.id !== 'string' || !raw.id) return { price: { id: '', name: '未知货币', num: 0 }, key: null, error: '商品货币编号为空' };
  if (raw.type === 1 && !RESOURCE_IDS.has(raw.id)) return { price: { id: '', name: '未知货币', num: 0 }, key: null, error: '商品资源货币无法识别' };
  const unit = Math.floor(base * factorPercent / 100);
  if (!whole(unit)) return { price: { id: '', name: '未知货币', num: 0 }, key: null, error: '商品折后价格异常' };
  const image = iconUrl(icon, raw.id);
  return { price: { id: raw.id, name: materialName(config, raw.id), num: unit, ...(image ? { icon: image } : {}) },
    key: JSON.stringify([raw.type, raw.id, base, factorPercent]), error: '' };
}
function tokenPrefix(identity, shopId, productId) { return 'shop:' + identity.role + ':' + identity.world + ':' + shopId + ':' + productId + ':'; }
function stockChangesMatch(details, balances) {
  if (!details?.baselineStock || !details?.expectedChanges || !(balances instanceof Map)) return false;
  for (const [id, expected] of Object.entries(details.expectedChanges)) {
    if (!Number.isSafeInteger(expected) || expected === 0) return false;
    const before = details.baselineStock[id], after = balances.get(id) ?? 0;
    if (!whole(before) || !whole(after)) return false;
    const delta = after - before;
    if (expected < 0 ? delta !== expected : delta < expected) return false;
  }
  return Object.keys(details.expectedChanges).length > 0;
}
const cycleKey = (client, shop, refresh = 0) => shop.kind === 'ad' || !whole(refresh) || refresh === 0
  ? 'day:' + Math.floor((clock(client) + 28800) / 86400) : 'refresh:' + refresh;
function cycleEndsAt(cycle) {
  const [kind, period] = cycle.split(':');
  return kind === 'day' ? (Number(period) + 1) * 86400 - 28800 : Number(period);
}
// Only a demonstrably newer server cycle can retire the block. Keep the old
// ticket for audit, and keep blocking when a response lacks comparable data.
function pastShopCycle(previous, current) {
  const format = /^(day|refresh):(\d+)(?::count:(\d+))?$/;
  const old = format.exec(previous), next = format.exec(current);
  if (!old || !next || old[1] !== next[1]) return false;
  if (old[2] !== next[2]) return Number(old[2]) < Number(next[2]);
  return Number(old[3]) < Number(next[3]);
}
function checkSpendAtSend(options, stock, step) {
  const settings = options.getSettings?.() ?? options.settings;
  for (const { id, num } of step.costs) {
    if ((stock.get(id) ?? 0) - num < resourceReserve(settings, id, step)) {
      throw Object.assign(new Error('当前余额不足或会低于保留数量，请重新进入商店'), { notSent: true });
    }
  }
}
function sameAmounts(left, right) {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([id, num]) => right[id] === num);
}
// The discount shop can refill a slot immediately. Older pending purchases
// already contain the quoted cost and net stock changes for the original offer.
function discountOfferChanged(details, offer) {
  if (details?.shop !== 'discount' || !offer || !details.expectedChanges) return false;
  return offer.price !== details.priceNum || !sameAmounts(details.expectedChanges,
    expectedStockChanges(offer.rewards, [{ id: 'RUBY', num: details.priceNum }], 1));
}
function settleUnknowns(ledger, prefix, observed, balances, cycle, offer) {
  if (!ledger?.keyRecords) return false;
  let pending = false;
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!key.startsWith(prefix) || record.confirmed || pastShopCycle(record.details?.cycle, cycle)) continue;
    const expected = record.details?.expectedBuyTimes;
    if (record.details?.cycle === cycle && whole(expected) && (observed >= expected || discountOfferChanged(record.details, offer))
      && stockChangesMatch(record.details, balances)) {
      if (record.details.guardTicket) ledger.confirm(record.details.guardTicket);
      ledger.resolveKey(key, true, { ...record.details, reconciled: true });
      try { ledger.releaseCompletedKey(key); } catch { /* preserve durable confirmation if release is refused */ }
    } else pending = true;
  }
  return pending;
}
function issueToken(state, { identity, shop, id, ...quote }) {
  const token = crypto.randomUUID();
  state.tokens.set(token, { token, identity: identity.key, shop: shop.id, productId: id, expiresAt: Date.now() + TOKEN_TTL_MS, ...quote });
  while (state.tokens.size > 500) {
    const oldest = [...state.tokens.keys()].find(key => !state.inFlight.has(key));
    if (!oldest) break;
    state.tokens.delete(oldest);
  }
  return token;
}
function productResult({ state, identity, shop, id, name, asset, price, discount, buyTimes, limitBuyTimes, maxQuantity,
  blockedReason = '', vipLevel = 0, dan = 0, cycle, signature, unknown = false, rewardAssets = [] }) {
  const validTimes = whole(buyTimes), validLimit = whole(limitBuyTimes);
  const remaining = validLimit && limitBuyTimes > 0 && validTimes ? Math.max(0, limitBuyTimes - buyTimes) : null;
  let reason = blockedReason;
  if (!validTimes || !validLimit) reason ||= '商品限购状态无法确认';
  if (validLimit && limitBuyTimes > 0 && remaining === 0) reason ||= '已达到商品限购次数';
  if (unknown) reason ||= '上一笔购买结果尚未确认，已阻止重复购买';
  let cap = whole(maxQuantity) ? Math.min(MAX_QUANTITY, maxQuantity) : 0;
  cap = remaining !== null ? Math.min(cap, remaining) : Math.min(cap, 1);
  if (reason) cap = 0;
  const token = cap > 0 ? issueToken(state, { identity, shop, id, signature, cycle, name, price: { ...price }, baseline: buyTimes, quantityCap: cap, rewards: rewardAssets }) : '';
  return { id, name, asset, price, discount, buyTimes: validTimes ? buyTimes : 0, limitBuyTimes: validLimit ? limitBuyTimes : 0,
    remaining, maxQuantity: cap, canBuy: cap > 0, blockedReason: reason, vipLevel, dan, token };
}
function fingerprint(shop, raw, factor, priceKey, asset, buyTimes, limit, vipLevel, dan) {
  if (shop.kind === 'discount') return JSON.stringify([raw.price, raw.discount, raw.isBuy ?? false, raw.reward?.asset]);
  if (shop.kind === 'ad') return JSON.stringify([raw.max ?? 0, raw.gotTimes ?? 0, raw.asset?.type, raw.asset?.id, raw.asset?.num]);
  return JSON.stringify([priceKey, factor, buyTimes, limit, vipLevel, dan, asset?.type, asset?.id, asset?.num]);
}
const refreshPrefix = identity => 'shop-refresh:' + identity.role + ':' + identity.world + ':';
const discountCycle = (client, refreshTime, count) => cycleKey(client, byShopId.get('discount'), refreshTime) + ':count:' + count;
function refreshEvidence(details, observed, balances) {
  return details?.kind === 'shopRefresh' && details.cycle === observed.cycle && whole(details.expectedRefreshCount)
    && whole(observed.count) && observed.count >= details.expectedRefreshCount
    && (details.priceNum === 0 || balances?.has('RUBY') && stockChangesMatch(details, balances));
}
function settleRefreshUnknowns(ledger, identity, observed, balances) {
  let pending = false;
  for (const [key, record] of Object.entries(ledger?.keyRecords?.() ?? {})) {
    if (!key.startsWith(refreshPrefix(identity)) || record.confirmed || pastShopCycle(record.details?.cycle, observed.cycle)) continue;
    if (refreshEvidence(record.details, observed, balances)) {
      if (record.details.guardTicket?.id) ledger.confirm(record.details.guardTicket);
      ledger.resolveKey(key, true, { ...record.details, reconciled: true });
      try { ledger.releaseCompletedKey(key); } catch { /* keep confirmed durable state */ }
    } else pending = true;
  }
  return pending;
}
function refreshBonus(effects) {
  if (!Array.isArray(effects)) throw new Error('商店刷新权益配置缺失');
  const matches = effects.filter(pair => Array.isArray(pair) && pair[0] === '折扣商店刷新次数');
  if (matches.length > 1 || (matches.length && !whole(matches[0][1]))) throw new Error('商店刷新权益配置异常');
  return matches[0]?.[1] ?? 0;
}
async function discountRefreshLimit(client, config, player, enabled, protocol) {
  const cfg = rows(config, 'ShopRefreshCfg');
  if (!cfg.length || cfg.some((row, index) => !whole(row.times) || row.times < 1 || (index > 0 && row.times <= cfg[index - 1].times))) {
    throw new Error('缺少有效的游戏商店刷新次数配置');
  }
  const vipLevel = player?.vip?.vipLevel;
  if (!whole(vipLevel)) throw new Error('无法确认当前VIP等级');
  const vip = rows(config, 'VipLevelCfg').find(row => row.level === vipLevel);
  if (!vip && vipLevel !== 0) throw new Error('缺少当前VIP商店刷新权益配置');
  let limit = cfg.at(-1).times + (vip ? refreshBonus(vip.effects) : 0);
  const cards = rows(config, 'MonthCardCfg');
  if (!cards.length) throw new Error('缺少月卡商店刷新权益配置');
  const withBonus = cards.filter(row => refreshBonus(row.effectList) > 0);
  if (withBonus.length) {
    assertProtocol(protocol, ['MonthCardRequest', 'MonthCardResponse']);
    checkEnabled(enabled);
    const view = await request(client, 'MonthCardRequest', {}, 'MonthCardResponse');
    checkEnabled(enabled);
    if (!Array.isArray(view.cardItem) || new Set(view.cardItem.map(row => row.type ?? 1)).size !== view.cardItem.length) throw new Error('无法确认月卡刷新权益');
    for (const card of view.cardItem) {
      const type = card.type ?? 1, endTime = card.endTime ?? 0;
      if (![1, 2].includes(type) || !Number.isSafeInteger(endTime) || endTime < -1) throw new Error('月卡刷新权益状态异常');
      if (endTime !== -1 && endTime <= clock(client)) continue;
      const name = type === 1 ? '普通月卡' : '高级月卡';
      const row = cards.find(entry => entry.id === name);
      if (!row) throw new Error('缺少当前月卡刷新权益配置');
      limit += refreshBonus(row.effectList);
    }
  }
  if (!whole(limit)) throw new Error('游戏商店刷新次数上限异常');
  return { cfg, limit };
}
async function gameRefreshQuote(client, config, { raw, identity, state, player, enabled, protocol, inventory, gateReason, icon }) {
  const count = raw.refreshCount ?? 0;
  const cycle = whole(raw.refreshTime ?? 0) ? cycleKey(client, byShopId.get('discount'), raw.refreshTime ?? 0) : null;
  const pending = settleRefreshUnknowns(state.ledger, identity, { count, cycle }, inventory);
  const image = iconUrl(icon, 'RUBY');
  const quote = { refreshCount: whole(count) ? count : 0, limit: 0, remaining: 0,
    price: { id: 'RUBY', name: materialName(config, 'RUBY'), num: 0, ...(image ? { icon: image } : {}) },
    canRefresh: false, blockedReason: gateReason || '', token: '' };
  Object.defineProperty(quote, 'pending', { value: pending });
  try {
    assertProtocol(protocol, ['DiscountShopRefreshRequest', 'DiscountShopResponse']);
    if (!whole(count) || !whole(raw.refreshTime ?? 0)) throw new Error('无法确认游戏商店刷新次数或周期');
    const { cfg, limit } = await discountRefreshLimit(client, config, player, enabled, protocol);
    const priceAt = times => {
      const cost = (cfg.find(row => row.times >= times) ?? cfg.at(-1)).cost;
      if (!Array.isArray(cost) || (cost.length && (cost.length !== 2 || cost[0] !== 'RUBY' || !whole(cost[1])))) throw new Error('无法确认游戏商店刷新费用');
      return cost.length ? cost[1] : 0;
    };
    quote.price.num = priceAt(count + 1);
    quote.limit = limit;
    quote.remaining = Math.max(0, limit - count);
    if (pending) quote.blockedReason ||= '上一次刷新折扣商店结果待确认，请重新进入商店核对，勿重复刷新';
    if (count >= limit) quote.blockedReason ||= '今日刷新次数已耗尽';
    if ((inventory.get('RUBY') ?? 0) < quote.price.num) quote.blockedReason ||= '钻石余额不足';
    if (raw.refreshTime > 0 && clock(client) >= raw.refreshTime) quote.blockedReason ||= '商店重置时间已到，请重新进入商店';
    if (!pending && !gateReason && (!raw.refreshTime || raw.refreshTime > clock(client)) && count > 0 && count <= limit
      && (count === limit || quote.price.num > 0) && priceAt(count) === 0) {
      Object.defineProperty(quote, 'lastFreeShelf', { value: true, writable: true });
    }
    if (!quote.blockedReason) {
      quote.canRefresh = true;
      quote.token = crypto.randomUUID();
      state.runtime.tokens.set(quote.token, { action: 'game-refresh', identity: identity.key, shop: 'discount', expiresAt: Date.now() + TOKEN_TTL_MS,
        signature: JSON.stringify([cycle, count, limit, quote.price.num, raw.shopItem]), cycle, count, priceNum: quote.price.num, resetAt: cycleEndsAt(cycle) });
      ensureState(state.runtime);
    }
  } catch (error) { quote.blockedReason ||= error.message; }
  return quote;
}
async function readShopSnapshot(client, config, options) {
  const { shop: shopId, player, clientInfo, state, icon, enabled = () => true, ledger, protocol = client?.protocol } = options;
  const shop = byShopId.get(shopId);
  if (!shop) throw new Error('未知商店');
  if (client?.connected === false) throw new Error('游戏连接已断开');
  if (!player) throw new Error('无法确认购买角色');
  const runtime = ensureState(state), identity = roleIdentity(player);
  const requestNames = shop.kind === 'discount' ? ['DiscountShopRequest', 'DiscountShopResponse', 'DiscountShopBuyRequest', 'DiscountShopBuyResponse']
    : shop.kind === 'ad' ? ['AdvShopInfoRequest', 'AdvShopInfoResponse', 'WatchAdvRequest', 'OkResponse', 'GotAdvRewardRequest']
      : ['ShopInfoRequest', 'ShopInfoResponse', 'BuyShopProductRequest'];
  assertProtocol(protocol, [...requestNames, 'AllResourceRequest', 'AllResourceResponse', 'AllItemRequest', 'AllItemResponse']);
  checkEnabled(enabled);
  const gate = await shopGate(client, config, shop, { player, clientInfo, enabled });
  checkEnabled(enabled);
  const inventory = await readBalances(client, enabled);
  let products, nextRefreshTime = 0, halfPriceUntil = 0, discountRaw;
  if (shop.kind === 'discount') {
    const view = await request(client, 'DiscountShopRequest', {}, 'DiscountShopResponse');
    checkEnabled(enabled);
    if (!Array.isArray(view?.shopItem)) throw new Error('折扣商店商品列表格式异常');
    products = view.shopItem;
    discountRaw = view;
    nextRefreshTime = whole(view.refreshTime) ? view.refreshTime : 0;
  } else if (shop.kind === 'ad') {
    const view = await request(client, 'AdvShopInfoRequest', {}, 'AdvShopInfoResponse');
    checkEnabled(enabled);
    if (!Array.isArray(view?.product)) throw new Error('广告商店商品列表格式异常');
    products = view.product;
  } else {
    const view = await request(client, 'ShopInfoRequest', { type: shop.type }, 'ShopInfoResponse');
    checkEnabled(enabled);
    if (!Array.isArray(view?.product)) throw new Error('商店商品列表格式异常');
    products = view.product;
    nextRefreshTime = whole(view.nextRefreshTime) ? view.nextRefreshTime : 0;
    if (shop.kind === 'shuimu' && whole(view.halfEndTime) && view.halfEndTime > clock(client)) halfPriceUntil = view.halfEndTime;
  }
  if (new Set(products.map(row => row?.id)).size !== products.length) throw new Error('商店商品编号重复');
  let leagueDan = null;
  if (shop.kind === 'league' && products.some(row => whole(row?.dan ?? 0) && (row.dan ?? 0) > 0)) {
    assertProtocol(protocol, ['LeagueInfoRequest', 'LeagueInfoResponse']);
    checkEnabled(enabled);
    const league = await request(client, 'LeagueInfoRequest', {}, 'LeagueInfoResponse');
    checkEnabled(enabled);
    if (!whole(league?.dan)) throw new Error('无法确认当前积分赛段位');
    leagueDan = league.dan;
  }
  const cycle = discountRaw ? discountCycle(client, nextRefreshTime, discountRaw.refreshCount ?? 0) : cycleKey(client, shop, nextRefreshTime);
  const gameRefresh = discountRaw ? await gameRefreshQuote(client, config, { raw: discountRaw, identity, state: { runtime, ledger },
    player, enabled, protocol, inventory, gateReason: gate.reason, icon }) : null;
  const result = [];
  for (const raw of products) {
    checkEnabled(enabled);
    if (!Number.isSafeInteger(raw?.id) || raw.id <= 0) throw new Error('商店商品编号异常');
    if (shop.kind === 'discount') {
      const isBuy = raw.isBuy ?? false;
      if (typeof isBuy !== 'boolean' || !whole(raw.price) || !Number.isFinite(raw.discount) || raw.discount < 0) throw new Error('折扣商品价格或领取状态异常');
      raw.isBuy = isBuy;
      const priceNum = Math.floor(raw.price * raw.discount);
      if (!whole(priceNum)) throw new Error('折扣商品实际价格异常');
      const assets = raw.reward?.asset;
      if (!Array.isArray(assets) || !assets.length) throw new Error('折扣商店奖励格式异常');
      const rewardAssets = assets.map(item => displayAsset(config, item, null)).filter(Boolean).map(({ id, num }) => ({ id, num }));
      const asset = displayAsset(config, assets[0], icon);
      const available = inventory.get('RUBY') ?? 0;
      const blocked = gate.reason || (gameRefresh?.pending ? '刷新折扣商店结果待确认，请先重新进入商店核对' : '')
        || (!asset || rewardAssets.length !== assets.length ? '商品奖励无法确认' : isBuy ? '本期商品已购买' : priceNum > available ? '钻石余额不足' : '');
      const offer = rewardAssets.length === assets.length ? { price: priceNum, rewards: rewardAssets } : null;
      const unknown = settleUnknowns(ledger, tokenPrefix(identity, shopId, raw.id), isBuy ? 1 : 0, inventory, cycle, offer);
      const signature = JSON.stringify([cycle, fingerprint(shop, { ...raw, isBuy }, Math.floor(raw.discount * 100), null, asset)]);
      const image = iconUrl(icon, 'RUBY');
      result.push(productResult({ state: runtime, identity, shop, id: raw.id, name: asset?.name || '未知商品', asset: asset || { id: '', name: '未知商品', num: 0 },
        price: { id: 'RUBY', name: materialName(config, 'RUBY'), num: priceNum, ...(image ? { icon: image } : {}) }, discount: Number((raw.discount * 100).toPrecision(15)),
        buyTimes: isBuy ? 1 : 0, limitBuyTimes: 1, maxQuantity: priceNum > 0 ? Math.floor(available / priceNum) : 1,
        blockedReason: blocked, signature, cycle, unknown, rewardAssets }));
      continue;
    }
    if (shop.kind === 'ad') {
      const max = raw.max ?? 0, gotTimes = raw.gotTimes ?? 0;
      if (!whole(max) || !whole(gotTimes) || gotTimes > max) throw new Error('广告商品领取次数异常');
      const asset = displayAsset(config, raw.asset, icon);
      const blocked = gate.reason || (!asset ? '商品奖励无法确认' : max === 0 || gotTimes >= max ? '已达到广告商品领取上限' : '');
      const rewardAssets = asset ? [{ id: asset.id, num: asset.num }] : [];
      const unknown = settleUnknowns(ledger, tokenPrefix(identity, shopId, raw.id), gotTimes, inventory, cycle);
      const signature = JSON.stringify([cycle, fingerprint(shop, raw, 100, null, asset)]);
      result.push(productResult({ state: runtime, identity, shop, id: raw.id, name: asset?.name || '未知商品', asset: asset || { id: '', name: '未知商品', num: 0 },
        price: { id: '', name: '免费', num: 0 }, discount: 100, buyTimes: gotTimes, limitBuyTimes: max,
        maxQuantity: 1, blockedReason: blocked, signature, cycle, unknown, rewardAssets }));
      continue;
    }
    const buyTimesValue = raw.buyTimes ?? 0, limitValue = raw.limitBuyTimes ?? 0;
    const buyTimes = whole(buyTimesValue) ? buyTimesValue : null;
    const limit = whole(limitValue) ? limitValue : null;
    const vipValue = raw.vipLevel ?? 0, danValue = raw.dan ?? 0;
    const vipLevel = whole(vipValue) ? vipValue : 0, dan = whole(danValue) ? danValue : 0;
    const asset = displayAsset(config, raw.asset, icon);
    const factor = halfPriceUntil ? 50 : 100;
    const priced = priceInfo(config, raw.price, factor, icon);
    let blocked = gate.reason || (!asset ? '商品奖励无法确认' : priced.error);
    if (!whole(vipValue) || !whole(danValue)) blocked ||= '商品VIP或段位门槛异常';
    if (!blocked && vipLevel > 0) {
      if (!whole(player?.vip?.vipLevel)) blocked = '无法确认当前VIP等级';
      else if (player.vip.vipLevel < vipLevel) blocked = '需要VIP ' + vipLevel + ' 级';
    }
    if (!blocked && dan > 0) {
      if (leagueDan === null) blocked = '无法确认当前积分赛段位';
      else if (leagueDan < dan) blocked = '需要积分赛段位 ' + dan;
    }
    let maxQuantity = 0;
    if (!blocked && priced.price.num === 0) maxQuantity = limit === 0 ? 1 : limit === null ? 0 : Math.min(MAX_QUANTITY, Math.max(0, limit - (buyTimes ?? 0)));
    else if (!blocked && priced.price.id) maxQuantity = Math.floor((inventory.get(priced.price.id) ?? 0) / priced.price.num);
    else if (!blocked) blocked = '无法确认商品货币';
    const rewardAssets = asset ? [{ id: asset.id, num: asset.num }] : [];
    const unknown = settleUnknowns(ledger, tokenPrefix(identity, shopId, raw.id), buyTimes ?? -1, inventory, cycle);
    const signature = JSON.stringify([cycle, fingerprint(shop, raw, factor, priced.key, asset, buyTimes, limit, vipLevel, dan)]);
    result.push(productResult({ state: runtime, identity, shop, id: raw.id, name: asset?.name || '未知商品', asset: asset || { id: '', name: '未知商品', num: 0 },
      price: priced.price, discount: factor, buyTimes, limitBuyTimes: limit,
      maxQuantity: limit === 0 ? Math.min(1, maxQuantity) : maxQuantity, blockedReason: blocked,
      vipLevel, dan, signature, cycle, unknown: unknown || buyTimes === null || limit === null, rewardAssets }));
  }
  if (gameRefresh) {
    const purchasePrefix = 'shop:' + identity.role + ':' + identity.world + ':discount:';
    // An update must not discard evidence for a purchase still verifiable in
    // this generation. Older reset cycles retain their own locks and ledger.
    const pendingPurchase = Object.entries(ledger?.keyRecords?.() ?? {}).some(([key, record]) => key.startsWith(purchasePrefix) && !record.confirmed
      && !pastShopCycle(record.details?.cycle, cycle));
    if (pendingPurchase) {
      if (gameRefresh.lastFreeShelf) gameRefresh.lastFreeShelf = false;
      runtime.tokens.delete(gameRefresh.token);
      gameRefresh.token = '';
      gameRefresh.canRefresh = false;
      gameRefresh.blockedReason ||= '当前商品有购买结果待确认，请重新进入折扣商店核对后再刷新';
    }
  }
  const currencies = [...new Set(result.map(product => product.price.id).filter(Boolean))];
  const shopBalances = currencies.map(id => {
    const image = iconUrl(icon, id);
    return { id, name: materialName(config, id), num: inventory.get(id) ?? 0, ...(image ? { icon: image } : {}) };
  });
  const view = { catalog: SHOP_CATALOG, shop, products: result, balances: shopBalances, updatedAt: Date.now(), nextRefreshTime, gameRefresh,
    hint: shop.kind === 'ad' ? '无免广告权益时购买前需等待广告时长；一次仅领取一个商品。' : '' };
  Object.defineProperty(view, 'stock', { value: inventory, enumerable: false });
  Object.defineProperty(view, 'cycle', { value: cycle, enumerable: false });
  if (gameRefresh) {
    const roleHash = crypto.createHash('sha256').update(identity.key).digest('hex').slice(0, 24);
    Object.defineProperty(view, 'discountSatisfiedCounter', { value: 'discountSatisfied_' + roleHash });
  }
  Object.defineProperty(view, 'priceValidUntil', { value: Math.min(cycleEndsAt(cycle), halfPriceUntil || Infinity) });
  return view;
}
export async function readShop(client, config, options) { return readShopSnapshot(client, config, options); }

// This mutation is intentionally separate from readShop: GET never renews game goods.
export async function refreshDiscountShop(client, config, options) {
  const { shop: shopId, token, paid, player, state, ledger, guard, enabled = () => true, protocol = client?.protocol } = options;
  if (shopId !== 'discount') throw new Error('仅折扣商店支持刷新');
  if (typeof token !== 'string' || !token || !guardShape(guard)) throw new Error('刷新凭据或消费保护无效，请重新进入商店');
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.confirm !== 'function' || typeof ledger.keyRecords !== 'function') throw new Error('商店刷新防重账本尚未就绪');
  assertProtocol(protocol, ['DiscountShopRefreshRequest', 'DiscountShopResponse']);
  checkEnabled(enabled);
  const runtime = ensureState(state), identity = roleIdentity(player), issued = runtime.tokens.get(token);
  if (issued?.action !== 'game-refresh' || issued.identity !== identity.key || issued.shop !== shopId
    || issued.expiresAt <= Date.now() || runtime.inFlight.has(token)) {
    return { action: 'game-refresh', status: 'rejected', message: '刷新报价已失效，请重新进入商店后确认', shopId, costs: [] };
  }
  runtime.inFlight.add(token);
  let reservation, ticket, step, prepared = false, settled = false, sent = false, ledgerKey;
  let costs = [];
  const result = (status, message) => ({ action: 'game-refresh', status, message, shopId: 'discount',
    costs: ['rejected', 'cancelled'].includes(status) ? [] : costs.map(row => ({ ...row, name: materialName(config, row.id) })) });
  const releaseUnsent = async error => {
    if (prepared && !settled) {
      try { await guard.cancel(step, ticket, { notSent: true, error }); } catch { /* preserve original unsent outcome */ }
      settled = true;
    }
    if (reservation) { try { ledger.cancel(reservation); } catch { /* keep durable state if cancellation fails */ } }
    return result(enabled() ? 'rejected' : 'cancelled', error.message || '游戏商店刷新未发送');
  };
  const keepUnknown = async error => {
    if (prepared && !settled) {
      try { await guard.cancel(step, ticket, { error: { message: error?.message || '游戏商店刷新结果待确认' } }); } catch { /* retain uncertain spend */ }
      settled = true;
    }
    return result('unknown', '刷新请求已发送，次数或扣款尚待核对。');
  };
  const quoteMatches = view => {
    const quote = view.gameRefresh, record = quote && runtime.tokens.get(quote.token);
    return quote?.canRefresh && record?.action === 'game-refresh' && record.signature === issued.signature;
  };
  try {
    const { cycle, count, priceNum } = issued;
    if (options.scope === 'discountShop' && priceNum !== 0) return await releaseUnsent(new Error('折扣商店挂机只使用免费刷新'));
    if (priceNum > 0 && paid !== true) return await releaseUnsent(new Error('刷新折扣商店需要单独确认本次钻石费用'));
    costs = priceNum > 0 ? [{ id: 'RUBY', num: priceNum }] : [];
    const expectedRefreshCount = count + 1;
    const refreshObserved = (view, connection) => Array.isArray(view?.shopItem) && whole(view.refreshTime ?? 0)
      && cycleKey(connection, byShopId.get('discount'), view.refreshTime ?? 0) === cycle
      && whole(view.refreshCount) && view.refreshCount >= expectedRefreshCount;
    step = { kind: 'shopRefresh', scope: options.scope ?? 'manual', request: 'DiscountShopRefreshRequest', body: {}, costs, label: '刷新折扣商店',
      verifyGrowth: async nextClient => {
        if (nextClient?.connected === false || !enabled() || roleIdentity(player).key !== identity.key) return false;
        const after = await request(nextClient, 'DiscountShopRequest', {}, 'DiscountShopResponse');
        return refreshObserved(after, nextClient);
      } };
    ticket = await guard.before(step);
    prepared = true;
    checkEnabled(enabled);
    const final = await readShopSnapshot(client, config, { ...options, state: runtime });
    if (!quoteMatches(final)) return await releaseUnsent(new Error(final.gameRefresh?.blockedReason || '发送前游戏商店刷新报价已变化，请重新进入商店后确认'));
    const details = { kind: 'shopRefresh', identity: identity.key, cycle, expectedRefreshCount,
      baselineRefreshCount: count, priceNum, baselineStock: { RUBY: final.stock.get('RUBY') ?? 0 },
      expectedChanges: priceNum > 0 ? { RUBY: -priceNum } : {}, ...(ticket?.id ? { guardTicket: ticket } : {}) };
    ledgerKey = refreshPrefix(identity) + cycle + ':' + count;
    reservation = ledger.reserve({}, {}, {}, { uniqueKey: ledgerKey, details });
    const beforeSend = () => {
      if (!enabled() || client?.connected === false || roleIdentity(player).key !== identity.key
        || issued.expiresAt <= Date.now() || clock(client) >= issued.resetAt) {
        throw Object.assign(new Error('账号或报价已变化，请重新进入商店后确认'), { notSent: true });
      }
      checkSpendAtSend(options, final.stock, step);
    };
    let after;
    try {
      sent = true;
      after = normalize(await client.request('DiscountShopRefreshRequest', {}, 'DiscountShopResponse', 15000, beforeSend));
    } catch (error) {
      if (definiteReject(error, 'DiscountShopRefreshRequest')) return await releaseUnsent(error);
    }
    // Every old discount quote is invalid after an attempted update, even if the
    // random pool returns identical goods. The authoritative count is in new quotes.
    for (const [key, record] of runtime.tokens) if (record.shop === 'discount') runtime.tokens.delete(key);
    if (!refreshObserved(after, client)) {
      after = await request(client, 'DiscountShopRequest', {}, 'DiscountShopResponse');
      if (!refreshObserved(after, client)) return await keepUnknown(new Error('商店刷新次数尚未同步'));
    }
    if (priceNum > 0) {
      checkEnabled(enabled);
      const resources = await request(client, 'AllResourceRequest');
      const balance = inventoryMap(resources, { items: [] });
      if (!balance.has('RUBY') || !stockChangesMatch(details, balance)) return await keepUnknown(new Error('商店刷新扣款尚未同步'));
    }
    ledger.confirm(reservation);
    if (ticket?.id && ticket?.day) ledger.confirm(ticket);
    try { ledger.releaseCompletedKey(ledgerKey); } catch { /* keep confirmed durable state */ }
    try { await guard.after(step, ticket, { ok: true, status: 'completed' }); } catch { /* confirmed writes cannot be rolled back by observers */ }
    settled = true;
    return result('completed', '折扣商店已刷新' + (priceNum > 0 ? '，已确认钻石扣款。' : '，本次免费。'));
  } catch (error) {
    return sent ? await keepUnknown(error) : await releaseUnsent(error);
  } finally {
    runtime.tokens.delete(token);
    runtime.inFlight.delete(token);
  }
}


const guardShape = guard => guard && typeof guard.before === 'function' && typeof guard.after === 'function' && typeof guard.cancel === 'function';
const definiteReject = (error, name) => !!error && (error.notSent === true || (error.prompt && error.request === name));
const result = (status, message, shopId, productId, quantity, rewards = [], costs = []) => ({ status, message, shopId, productId, quantity, rewards, costs });
const assetsOut = (config, assets, quantity) => (Array.isArray(assets) ? assets : []).map(asset => {
  if (asset?.type !== undefined) return displayAsset(config, asset, null);
  if (typeof asset?.id === 'string' && asset.id && whole(asset.num)) return { id: asset.id, name: materialName(config, asset.id), num: asset.num };
  return null;
}).filter(Boolean).map(asset => ({ ...asset, num: asset.num * quantity }));
function validDiscountRewards(assets) {
  return Array.isArray(assets) && assets.length > 0 && assets.every(asset =>
    asset && [0, 1].includes(asset.type) && typeof asset.id === 'string' && asset.id &&
    (asset.type === 0 || RESOURCE_IDS.has(asset.id)) && whole(asset.num) && asset.num > 0);
}
async function readBusiness(client, shop, productId) {
  if (shop.kind === 'discount') {
    const after = await request(client, 'DiscountShopRequest', {}, 'DiscountShopResponse');
    const row = after?.shopItem?.find(item => item.id === productId);
    const rewards = row?.reward?.asset;
    const price = Math.floor(row?.price * row?.discount);
    const offer = validDiscountRewards(rewards) && whole(row.price) && Number.isFinite(row.discount) && row.discount >= 0 && whole(price)
      ? { price, rewards } : null;
    return { count: row?.isBuy === true ? 1 : 0, cycle: discountCycle(client, after.refreshTime ?? 0, after.refreshCount ?? 0), offer };
  }
  if (shop.kind === 'ad') {
    const after = await request(client, 'AdvShopInfoRequest', {}, 'AdvShopInfoResponse');
    const row = after?.product?.find(item => item.id === productId);
    return { count: row?.gotTimes ?? 0, cycle: cycleKey(client, shop), rewards: row?.asset ? [row.asset] : [] };
  }
  const after = await request(client, 'ShopInfoRequest', { type: shop.type }, 'ShopInfoResponse');
  const row = after?.product?.find(item => item.id === productId);
  return { count: row?.buyTimes ?? 0, cycle: cycleKey(client, shop, after.nextRefreshTime ?? 0), rewards: row?.asset ? [row.asset] : [] };
}
function expectedStockChanges(rewards, costs, quantity) {
  const changes = Object.create(null);
  for (const item of rewards) changes[item.id] = (changes[item.id] ?? 0) + item.num * quantity;
  for (const item of costs) changes[item.id] = (changes[item.id] ?? 0) - item.num;
  return Object.fromEntries(Object.entries(changes).filter(([, delta]) => delta !== 0));
}

export async function buyShopProduct(client, config, options) {
  const { shop: shopId, id: productId, quantity, token, paid, player, clientInfo, getSettings, settings, ledger, state,
    guard, enabled = () => true, report, icon, protocol = client?.protocol } = options;
  const shop = byShopId.get(shopId);
  if (!shop) throw new Error('未知商店');
  if (!Number.isSafeInteger(productId) || productId <= 0) throw new Error('商品编号无效');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new Error('购买数量无效');
  if (typeof token !== 'string' || !token) throw new Error('购买凭证无效或已过期');
  if (!guardShape(guard)) throw new Error('消费保护尚未就绪，无法购买');
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.confirm !== 'function' || typeof ledger.cancel !== 'function') throw new Error('持久防重账本尚未就绪');
  if (client?.connected === false) throw new Error('游戏连接已断开');
  checkEnabled(enabled);
  const runtime = ensureState(state), identity = roleIdentity(player), issued = runtime.tokens.get(token);
  if (!issued || issued.shop !== shopId || issued.productId !== productId || issued.identity !== identity.key
    || issued.expiresAt <= Date.now() || runtime.inFlight.has(token)) {
    return result('rejected', '购买报价已失效，请核对最新商品后确认', shopId, productId, quantity);
  }
  runtime.inFlight.add(token);
  const requestName = shop.kind === 'discount' ? 'DiscountShopBuyRequest' : shop.kind === 'ad' ? 'GotAdvRewardRequest' : 'BuyShopProductRequest';
  const ledgerKey = tokenPrefix(identity, shopId, productId) + token;
  let reservation, ticket, step, prepared = false, settled = false, sent = false;
  let costs = [], outcomeRewards = issued.rewards;
  const consumeToken = () => runtime.tokens.delete(token);
  const releaseUnsent = async (error, cancelled = false) => {
    if (prepared && !settled) {
      try { await guard.cancel(step, ticket, { notSent: true, error }); } catch { /* don't turn an unsent failure into a sent operation */ }
      settled = true;
    }
    if (reservation) { try { ledger.cancel(reservation); } catch { /* retain conservative durable state */ } }
    consumeToken();
    return result(cancelled ? 'cancelled' : 'rejected', error?.message || '购买未发送', shopId, productId, quantity);
  };
  const keepUnknown = async error => {
    if (prepared && !settled) {
      try { await guard.cancel(step, ticket, { error: { message: error?.message || '购买结果未确认' } }); } catch { /* an unknown sent write must retain its guard reservation */ }
      settled = true;
    }
    consumeToken();
    return result('unknown', '购买已发送，但商品次数或库存尚未同步；已阻止重复购买，请重新进入商店核对。', shopId, productId, quantity, [],
      costs.map(item => ({ ...item, name: materialName(config, item.id) })));
  };
  const stillSameRole = currentClient => currentClient?.connected !== false && roleIdentity(player).key === identity.key;
  try {
    const { price, baseline, cycle: businessCycle } = issued;
    if (price.id === 'RUBY' && price.num > 0 && paid !== true) return await releaseUnsent(new Error('钻石购买需要再次确认'));
    if ((shop.kind === 'ad' || shop.kind === 'discount') && quantity !== 1) return await releaseUnsent(new Error('该商店商品一次只能购买一个'));
    if (quantity > issued.quantityCap) return await releaseUnsent(new Error('当前余额或限购次数不足，请重新进入商店'));
    const expectedCount = shop.kind === 'discount' ? 1 : baseline + quantity;
    if (shop.kind !== 'ad' && price.num > 0) costs = [{ id: price.id, num: price.num * quantity }];
    if (costs.some(row => !row.id || !Number.isSafeInteger(row.num) || row.num < 1)) return await releaseUnsent(new Error('无法确认本次购买货币'));
    const body = shop.kind === 'discount' || shop.kind === 'ad' ? { id: productId } : { type: shop.type, id: productId, num: quantity };
    step = { kind: 'shopPurchase', scope: options.scope ?? 'manual', request: requestName, body, costs, label: shop.title + ' · ' + issued.name,
      verifyGrowth: async nextClient => {
        try {
          if (!stillSameRole(nextClient)) return false;
          const after = await readBusiness(nextClient, shop, productId);
          return after.cycle === businessCycle && whole(after.count) && after.count >= expectedCount;
        } catch { return false; }
      } };
    checkEnabled(enabled);
    ticket = await guard.before(step);
    prepared = true;
    if (!enabled()) return await releaseUnsent(new Error('操作已暂停或账号已切换'), true);
    const finalView = await readShopSnapshot(client, config, { shop: shopId, player, clientInfo, settings: getSettings?.() ?? settings,
      ledger, state: runtime, enabled, protocol });
    const final = finalView.products.find(item => item.id === productId), finalToken = final && runtime.tokens.get(final.token);
    if (options.checkFallback && !options.checkFallback(finalView)) {
      return await releaseUnsent(new Error('兜底购买条件已变化，将在下轮重新检查货架'));
    }
    if (!enabled() || !runtime.tokens.has(token) || !final || !final.canBuy || !finalToken || finalToken.signature !== issued.signature
      || final.buyTimes !== baseline || quantity > final.maxQuantity) {
      return await releaseUnsent(new Error(final?.blockedReason || '发送前商店价格、库存、资格或购买次数已变化，请重新进入商店后重试'), !enabled());
    }
    outcomeRewards = finalToken.rewards ?? outcomeRewards;
    const expectedChanges = expectedStockChanges(outcomeRewards, costs, quantity);
    if (!Object.keys(expectedChanges).length || !Object.values(expectedChanges).every(Number.isSafeInteger) || !finalView.stock) return await releaseUnsent(new Error('无法完整确认购买前的奖励与货币库存'));
    const details = { kind: 'shopPurchase', shop: shopId, productId, baselineBuyTimes: baseline, expectedBuyTimes: expectedCount,
      priceId: price.id, priceNum: price.num, quantity, identity: identity.key, request: requestName, cycle: businessCycle,
      baselineStock: Object.fromEntries(Object.keys(expectedChanges).map(id => [id, finalView.stock.get(id) ?? 0])), expectedChanges, guardTicket: ticket };
    // Reserve the daily fallback together with the purchase. An unknown write keeps
    // its place across restarts, while a definite rejection releases both.
    const fallbackCount = options.checkFallback ? { [finalView.discountSatisfiedCounter]: 1 } : {};
    try { reservation = ledger.reserve(fallbackCount, fallbackCount, {}, { uniqueKey: ledgerKey, details }); }
    catch (error) { return await releaseUnsent(error); }
    if (shop.kind === 'ad') {
      const access = await adAccess(client, config?.tables, { player, clientInfo, settings: getSettings?.() ?? settings });
      if (access.reason) return await releaseUnsent(new Error(access.reason));
      if (!await prepareAd(client, access, { type: 2, id: productId }, () => enabled() && stillSameRole(client))) {
        return await releaseUnsent(new Error('广告等待期间操作已暂停或账号已变化'), true);
      }
      if (!enabled() || !stillSameRole(client)) return await releaseUnsent(new Error('操作已暂停或账号已切换'), true);
      const afterWait = await readShopSnapshot(client, config, { shop: shopId, player, clientInfo, state: runtime, icon, enabled, protocol });
      const waitedProduct = afterWait.products.find(item => item.id === productId);
      const waitedToken = waitedProduct && runtime.tokens.get(waitedProduct.token);
      if (!waitedProduct?.canBuy || !waitedToken || waitedToken.signature !== issued.signature) {
        return await releaseUnsent(new Error('广告等待后商品资格或领取次数已变化，请重新进入商店后再试'));
      }
      details.baselineStock = Object.fromEntries(Object.keys(expectedChanges).map(id => [id, afterWait.stock.get(id) ?? 0]));
      ledger.updateKeyDetails(ledgerKey, details);
    }
    const beforeSend = () => {
      if (!enabled() || !stillSameRole(client)) throw Object.assign(new Error('操作已暂停或账号已切换'), { notSent: true });
      if (!runtime.tokens.has(token) || Date.now() >= issued.expiresAt || clock(client) >= finalView.priceValidUntil) {
        throw Object.assign(new Error('购买报价已过期，请重新进入商店后确认'), { notSent: true });
      }
      checkSpendAtSend(options, finalView.stock, step);
      if (shop.kind === 'discount') {
        // A purchase may immediately refill this slot with an identical offer.
        for (const [key, record] of runtime.tokens) {
          if (record.identity === identity.key && record.shop === shopId && record.productId === productId) runtime.tokens.delete(key);
        }
      }
    };
    let discountReply;
    try {
      sent = true;
      if (shop.kind === 'discount') discountReply = normalize(await client.request(requestName, body, 'DiscountShopBuyResponse', 15000, beforeSend));
      else await client.sendWatch(requestName, body, { beforeSend });
    } catch (error) {
      if (definiteReject(error, requestName)) return await releaseUnsent(error);
    }
    const granted = discountReply?.reward?.asset;
    const receiptConfirmed = discountReply?.shopItem?.id === productId && validDiscountRewards(granted)
      && sameAmounts(expectedChanges, expectedStockChanges(granted, costs, 1));
    if (receiptConfirmed) {
      outcomeRewards = granted;
    } else {
      const after = await readBusiness(client, shop, productId);
      if (after.cycle !== businessCycle || !(whole(after.count) && after.count >= expectedCount || discountOfferChanged(details, after.offer))) {
        return await keepUnknown(new Error('服务端尚未确认商品状态变化'));
      }
      if (!stockChangesMatch(details, await readBalances(client, enabled))) return await keepUnknown(new Error('商品已更新，但奖励或扣款库存仍未同步'));
      if (after.rewards?.length) outcomeRewards = after.rewards;
    }
    ledger.confirm(reservation);
    if (ticket?.id && ticket?.day) ledger.confirm(ticket);
    try { ledger.releaseCompletedKey(ledgerKey); } catch { /* retain durable confirmation if release is refused */ }
    try { await guard.after(step, ticket, { ok: true, status: 'completed' }); } catch { /* no rollback after the server and inventory confirm */ }
    settled = true;
    consumeToken();
    const rewards = assetsOut(config, outcomeRewards, shop.kind === 'ad' || shop.kind === 'discount' ? 1 : quantity);
    const costsOut = costs.map(row => ({ ...row, name: materialName(config, row.id) }));
    try { report?.({ label: step.label, ok: true, rewards, costs: costsOut }); } catch { /* reporting cannot change a confirmed outcome */ }
    return result('completed', receiptConfirmed ? '游戏已确认购买并发放奖励。' : '已通过商品状态及货币、奖励库存回读确认到账。',
      shopId, productId, quantity, rewards, costsOut);
  } catch (error) {
    return sent ? await keepUnknown(error) : await releaseUnsent(error);
  } finally {
    runtime.inFlight.delete(token);
  }
}
