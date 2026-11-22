import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';
import { SHOP_CATALOG, createShopState, readShop, buyShopProduct, refreshDiscountShop } from '../src/shops.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { actionCounters, budgetPreview, createActionGuard } from '../src/automation-policy.mjs';
import { defaultSettings, exportAutomationSettings, importAutomationSettings, validateSettings } from '../src/automation-settings.mjs';
import { runDiscountShop } from '../src/discount-shop-automation.mjs';
import { normalize } from '../src/worlds.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shops-'));
process.env.CW_DATA_DIR = temp;
const messages = ['ShopInfoRequest', 'ShopInfoResponse', 'BuyShopProductRequest', 'DiscountShopRequest', 'DiscountShopResponse',
  'DiscountShopBuyRequest', 'DiscountShopBuyResponse', 'DiscountShopRefreshRequest', 'MonthCardRequest', 'MonthCardResponse', 'AdvShopInfoRequest', 'AdvShopInfoResponse', 'WatchAdvRequest', 'OkResponse',
  'GotAdvRewardRequest', 'FirstChargeRequest', 'FirstChargeResponse', 'AllResourceRequest', 'AllResourceResponse', 'AllItemRequest',
  'AllItemResponse', 'OnWaterRequest', 'OnWaterResponse', 'LeagueInfoRequest', 'LeagueInfoResponse'];
const declared = createDeclaredProtocol(messages);
let protocol = declared;
if (process.argv.includes('--protocol')) {
  const { loadProtocol } = await import('../src/proto.mjs');
  protocol = loadProtocol();
  for (const name of messages) assert(protocol[name], 'real protocol: ' + name);
  assert.equal(protocol.BuyShopProductResponse, undefined, 'must not invent a generic response');
}
const clone = value => structuredClone(value);
let serial = 0;
const wire = (name, body) => normalize(protocol[name].decode(protocol[name].encode(body).finish()));
const namesByRes = { 1: 'EXP', 3: 'GOLD', 4: 'RUBY', 5: 'ARENA_POINT', 6: 'LEAGUE_POINT' };
function fixture() {
  const index = ++serial;
  const calls = [], hooks = {}, products = new Map(), discounts = [{ id: 901, reward: { asset: [{ type: 0, id: '建筑蓝图', num: 3 }] }, price: 101, discount: 0.5, isBuy: false }];
  const adverts = [{ id: 801, asset: { type: 0, id: '木材', num: 5 }, max: 2, gotTimes: 0 }];
  const stock = new Map([['EXP', 100], ['GOLD', 10000], ['RUBY', 1000], ['ARENA_POINT', 9], ['LEAGUE_POINT', 8],
    ['竞技币', 1000], ['联盟币', 1000], ['积分赛货币', 1000], ['水姆币', 1000], ['建筑蓝图', 0], ['木材', 0]]);
  for (const [type, id, priceId, price, assetNum] of [[1, 101, '竞技币', 120, 2], [2, 201, '联盟币', 50, 1],
    [3, 301, 'RUBY', 100, 3], [4, 401, '积分赛货币', 60, 1], [13, 1301, '水姆币', 101, 1]]) {
    products.set(type, [{ id, asset: { type: 0, id: '建筑蓝图', num: assetNum }, price: { type: priceId === 'RUBY' ? 1 : 0, id: priceId, num: price },
      discount: 25, buyTimes: 0, limitBuyTimes: 5, vipLevel: type === 3 ? 3 : 0, dan: type === 4 ? 2 : 0 }]);
  }
  const config = { materialName: id => id, resourceName: id => namesByRes[id] || id, tables: {
    BuildingUnlockCfg: { data: [{ buildingId: '1商店', buildingType: '商店' }, { buildingId: '1竞技场', buildingType: '竞技场' }] },
    ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 16 }, { moduleId: '跨服积分赛', playerLevel: 25 }, { moduleId: '广告', playerLevel: 9 }] },
    GameplayOpenCfg: { data: [{ gameplay: '水姆商店', openDays: [8, 1, 1, 1] }, { gameplay: '跨服积分赛', openDays: [8, 1, 1, 1] }] },
    AdvChannelCfg: { data: [{ key: '1400', isOpen: true }] },
    VipLevelCfg: { data: [{ level: 3, effects: [['免广告', 1]] }, { level: 5, effects: [['折扣商店刷新次数', 2]] }] },
    ShopRefreshCfg: { data: [{ times: 1, cost: [] }, { times: 2, cost: [] }, { times: 3, cost: ['RUBY', 50] }] },
    MonthCardCfg: { data: [{ id: '普通月卡', effectList: [] }, { id: '高级月卡', effectList: [] }] },
  } };
  const player = { playerId: 10000 + index, worldId: 1_000_001, guildId: 1001, level: 30, vip: { vipLevel: 3 }, worldOpenTime: Math.floor(Date.now() / 1000) - 12 * 86400 };
  let active = true;
  const settings = defaultSettings();
  Object.assign(settings.resources, { allowDiamonds: true, diamondDailyLimit: 10000, diamondThreshold: 0 });
  settings.ads.waitSeconds = 0.01;
  const ledger = createUsageLedger('shop-test-' + index, { file: path.join(temp, 'ledger.json') });
  const shared = { products, stock, discounts, adverts, halfEndTime: 0, refreshCount: 0, refreshTime: 2_000_000_000, monthCards: [], mode: 'ok', stockLag: null, omitDefaults: false, dan: 3,
    buildings: [{ buildingId: '1商店', level: 1 }, { buildingId: '1竞技场', level: 1 }] };
  const client = {
    protocol, connected: true,
    async request(name, body = {}, response, timeout, beforeSend) {
      beforeSend?.();
      const encoded = wire(name, body);
      calls.push([name, encoded, response]);
      await hooks[name]?.(encoded);
      if (name === 'AllResourceRequest') return wire(response, { list: Object.entries(namesByRes).map(([res, id]) => ({ res: Number(res), amount: (shared.stockLag || stock).get(id) ?? 0 })) });
      if (name === 'AllItemRequest') return wire(response, { items: [...(shared.stockLag || stock)].filter(([id]) => !Object.values(namesByRes).includes(id)).map(([itemId, num]) => ({ itemId, num })) });
      if (name === 'OnWaterRequest') return wire(response, { building: shared.buildings });
      if (name === 'LeagueInfoRequest') return wire(response, { dan: shared.dan });
      if (name === 'FirstChargeRequest') return { firstCharge: { record: [] } };
      if (name === 'WatchAdvRequest') return wire(response, {});
      if (name === 'DiscountShopRequest') {
        const rows = clone(discounts); if (shared.omitDefaults) for (const row of rows) if (!row.isBuy) delete row.isBuy;
        return wire(response, { shopItem: rows, refreshTime: shared.refreshTime, refreshCount: shared.refreshCount });
      }
      if (name === 'MonthCardRequest') return wire(response, { cardItem: shared.monthCards });
      if (name === 'DiscountShopRefreshRequest') {
        await this.mutate(name, encoded);
        return wire(response, { shopItem: discounts, refreshTime: shared.refreshTime, refreshCount: shared.refreshCount });
      }
      if (name === 'AdvShopInfoRequest') return wire(response, { product: adverts });
      if (name === 'ShopInfoRequest') {
        const rows = clone(products.get(encoded.type) || []);
        if (shared.omitDefaults) for (const row of rows) for (const key of ['buyTimes', 'limitBuyTimes', 'vipLevel', 'dan']) if (row[key] === 0) delete row[key];
        return wire(response, { product: rows, nextRefreshTime: 2_000_000_000, halfEndTime: shared.halfEndTime });
      }
      if (name === 'DiscountShopBuyRequest') {
        await this.mutate(name, encoded);
        return wire(response, { shopItem: discounts.find(row => row.id === encoded.id), reward: discounts.find(row => row.id === encoded.id)?.reward });
      }
      throw new Error('unexpected fixture request: ' + name);
    },
    async sendWatch(name, body, { beforeSend } = {}) {
      beforeSend?.();
      calls.push([name, wire(name, body)]);
      await hooks[name]?.(body);
      return this.mutate(name, body);
    },
    async mutate(name, body) {
      if (shared.mode === 'reject') throw Object.assign(new Error('server refused'), { prompt: { args: ['refused'] }, request: name });
      if (shared.mode === 'notSent') throw Object.assign(new Error('not sent'), { notSent: true });
      if (shared.mode === 'unknown') throw new Error('socket lost after submission');
      if (shared.mode === 'lag') shared.stockLag = new Map(stock);
      if (name === 'BuyShopProductRequest') {
        const row = products.get(body.type).find(row => row.id === body.id), quantity = body.num;
        const unit = body.type === 13 && shared.halfEndTime > Date.now() / 1000 ? Math.floor(row.price.num / 2) : row.price.num;
        stock.set(row.price.id, stock.get(row.price.id) - unit * quantity);
        stock.set(row.asset.id, (stock.get(row.asset.id) ?? 0) + row.asset.num * quantity);
        row.buyTimes = (row.buyTimes ?? 0) + quantity;
      } else if (name === 'DiscountShopBuyRequest') {
        const row = discounts.find(row => row.id === body.id);
        stock.set('RUBY', stock.get('RUBY') - Math.floor(row.price * row.discount));
        for (const asset of row.reward.asset) stock.set(asset.id, stock.get(asset.id) + asset.num);
        row.isBuy = true;
      } else if (name === 'DiscountShopRefreshRequest') {
        const cfg = config.tables.ShopRefreshCfg.data;
        const cost = (cfg.find(row => row.times >= shared.refreshCount + 1) ?? cfg.at(-1)).cost;
        stock.set('RUBY', stock.get('RUBY') - (cost[1] ?? 0));
        shared.refreshCount++;
        for (const row of discounts) { row.isBuy = false; row.price++; }
      } else if (name === 'GotAdvRewardRequest') {
        const row = adverts.find(row => row.id === body.id); row.gotTimes++;
        stock.set(row.asset.id, stock.get(row.asset.id) + row.asset.num);
      } else throw new Error('unexpected mutate: ' + name);
      return { sent: 1 };
    },
  };
  const state = createShopState(), enabled = () => active;
  const options = { state, ledger, player, clientInfo: { channelId: '1400' }, settings, getSettings: () => settings, enabled, protocol,
    guard: createActionGuard(client, () => settings, ledger, { player, enabled }) };
  const read = shop => readShop(client, config, { ...options, shop });
  const buy = async (shop, changes = {}) => { const view = await read(shop), item = view.products[0]; return buyShopProduct(client, config, { ...options, shop,
    id: item.id, quantity: 1, token: item.token, paid: item.price.id === 'RUBY', ...changes }); };
  return { client, config, player, settings, options, shared, stock, products, discounts, adverts, calls, hooks, ledger, state, read, buy, stop() { active = false; } };
}
const sent = f => f.calls.filter(([name]) => ['BuyShopProductRequest', 'GotAdvRewardRequest', 'DiscountShopBuyRequest'].includes(name));
const tests = [];
const test = (name, run) => tests.push([name, run]);
test('seven catalog types are protocol types', async () => assert.deepEqual(SHOP_CATALOG.map(row => [row.id, row.type]), [['discount', null], ['ad', null], ['arena', 1], ['guild', 2], ['shuimu', 13], ['league', 4], ['vip', 3]]));
test('VIP blueprint RUBY purchase uses current server unit price', async () => {
  const f = fixture(), view = await f.read('vip'); assert.equal(view.products[0].price.num, 100); assert.equal(view.products[0].discount, 100);
  const item = view.products[0], outcome = await buyShopProduct(f.client, f.config, { ...f.options, shop: 'vip', id: item.id, quantity: 2, token: item.token, paid: true });
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome)); assert.equal(f.stock.get('RUBY'), 800); assert.equal(f.stock.get('建筑蓝图'), 6);
  assert.deepEqual(outcome.costs.map(({ id, num }) => ({ id, num })), [{ id: 'RUBY', num: 200 }]);
  assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0); assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, 200);
  assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0); assert.equal(f.ledger.confirmedCounters().diamonds ?? 0, 0);
  assert.equal((await buyShopProduct(f.client, f.config, { ...f.options, shop: 'vip', id: item.id, quantity: 2, token: item.token, paid: true })).status, 'rejected');
  assert.equal(sent(f).length, 1);
});
test('manual VIP and discount purchases ignore automatic diamond switch and daily budget', async () => {
  for (const shop of ['vip', 'discount']) for (const policy of [
    { allowDiamonds: false, diamondDailyLimit: 10000, spent: 0 },
    { allowDiamonds: true, diamondDailyLimit: 0, spent: 0 },
    { allowDiamonds: true, diamondDailyLimit: 100, spent: 100 },
  ]) {
    const f = fixture(), { spent, ...resources } = policy, cost = shop === 'vip' ? 100 : 50;
    Object.assign(f.settings.resources, resources);
    if (spent) f.ledger.confirm(f.ledger.reserve({ diamonds: spent }, { diamonds: spent }));
    const outcome = await f.buy(shop);
    assert.equal(outcome.status, 'completed', JSON.stringify({ shop, policy, outcome }));
    assert.equal(f.stock.get('RUBY'), 1000 - cost); assert.equal(f.stock.get('建筑蓝图'), 3);
    assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, cost);
    assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, spent);
    assert.equal(f.ledger.confirmedCounters().diamonds ?? 0, spent);
    assert.equal(sent(f).length, 1);
  }
});
test('manual shop exemption still requires strict paid confirmation', async () => {
  for (const shop of ['vip', 'discount']) for (const paid of [undefined, false, 'true', 1]) {
    const f = fixture(); Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 0 });
    const outcome = await f.buy(shop, { paid });
    assert.equal(outcome.status, 'rejected'); assert.match(outcome.message, /确认/);
    assert.equal(sent(f).length, 0); assert.equal(f.stock.get('RUBY'), 1000);
    assert.equal(f.ledger.snapshot().counters.manualShopDiamonds ?? 0, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
  }
});
test('manual purchases may spend the whole balance even when all diamonds are reserved for automation', async () => {
  for (const shop of ['vip', 'discount']) {
    const f = fixture(), cost = shop === 'vip' ? 100 : 50;
    Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 0, diamondThreshold: 1000 });
    f.stock.set('RUBY', cost);
    const item = (await f.read(shop)).products[0];
    const options = { ...f.options, shop, id: item.id, quantity: 1, token: item.token, paid: true };
    f.stock.set('RUBY', cost - 1);
    assert.equal((await buyShopProduct(f.client, f.config, options)).status, 'rejected');
    assert.equal(sent(f).length, 0);
    f.stock.set('RUBY', cost);
    assert.equal((await f.buy(shop)).status, 'completed');
    assert.equal(f.stock.get('RUBY'), 0);
    assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, cost);
  }
});
test('automatic dailies and forged manual shop markers retain the automatic diamond policy', async () => {
  const invalid = [
    ...['BuyShopProductRequest', 'DiscountShopBuyRequest'].flatMap(request => [
      { request, kind: 'daily', scope: 'daily' },
      { request, scope: 'daily' },
      { request, kind: 'daily' },
      { request, kind: undefined },
      { request, scope: undefined },
      { request, kind: 'shopPurchaseOther' },
      { request, scope: 'MANUAL' },
    ]),
    { request: 'ClickGoldRequest' },
    { request: 'BuyShopProductRequestOther' },
  ];
  for (const changes of invalid) for (const policy of [
    { allowDiamonds: false, diamondDailyLimit: 10000, spent: 0 },
    { allowDiamonds: true, diamondDailyLimit: 0, spent: 0 },
    { allowDiamonds: true, diamondDailyLimit: 100, spent: 100 },
  ]) {
    const f = fixture(), { spent, ...resources } = policy;
    Object.assign(f.settings.resources, resources);
    if (spent) f.ledger.confirm(f.ledger.reserve({ diamonds: spent }, { diamonds: spent }));
    const step = { kind: 'shopPurchase', scope: 'manual', request: 'BuyShopProductRequest', body: { type: 3, id: 301, num: 1 },
      costs: [{ id: 'RUBY', num: 100 }], label: 'non-exempt purchase', ...changes };
    assert.deepEqual(actionCounters(step), { diamonds: 100 }, JSON.stringify(changes));
    const preview = budgetPreview([step], f.stock, f.settings, f.ledger.snapshot());
    assert.equal(preview.actions.length, 0, JSON.stringify({ changes, policy, preview }));
    assert.match(preview.notes.join(' '), /总开关|今日使用上限/);
    await assert.rejects(f.options.guard.before(step), /总开关|今日上限/, JSON.stringify({ changes, policy }));
    assert.equal(sent(f).length, 0); assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, spent);
    assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0);
  }
});
test('manual shop budget preview ignores the automation reserve and leaves automatic budget available', async () => {
  for (const request of ['BuyShopProductRequest', 'DiscountShopBuyRequest']) {
    const f = fixture(), manual = { kind: 'shopPurchase', scope: 'manual', request, label: 'manual shop', costs: [{ id: 'RUBY', num: 100 }], counters: { diamonds: 100 } };
    for (const policy of [
      { allowDiamonds: false, diamondDailyLimit: 10000 },
      { allowDiamonds: true, diamondDailyLimit: 0 },
      { allowDiamonds: true, diamondDailyLimit: 100 },
    ]) {
      Object.assign(f.settings.resources, policy);
      const preview = budgetPreview([manual], f.stock, f.settings, { counters: { diamonds: 100 } });
      assert.deepEqual(preview.actions, [manual]); assert.deepEqual(preview.notes, []);
    }
    assert.deepEqual(actionCounters(manual), { manualShopDiamonds: 100 });
    const daily = { ...manual, kind: 'daily', scope: 'daily', label: 'automatic daily' };
    const preview = budgetPreview([manual, daily], f.stock, f.settings);
    assert.deepEqual(preview.actions, [manual, daily]); assert.deepEqual(preview.notes, []);
    f.settings.resources.diamondThreshold = 1000;
    const belowReserve = budgetPreview([manual, daily], f.stock, f.settings);
    assert.deepEqual(belowReserve.actions, [manual]);
    await assert.rejects(f.options.guard.before(daily), /保留/);
    const short = budgetPreview([manual], new Map([['RUBY', 99]]), f.settings);
    assert.equal(short.actions.length, 0);
  }
});
test('arena blueprint spends ITEM coins, never challenge tickets', async () => {
  const f = fixture(), outcome = await f.buy('arena'); assert.equal(outcome.status, 'completed');
  assert.equal(f.stock.get('竞技币'), 880); assert.equal(f.stock.get('ARENA_POINT'), 9); assert.equal(f.stock.get('建筑蓝图'), 2);
});
test('league and guild gates use real server role status', async () => {
  const f = fixture(); f.shared.dan = 1; assert.match((await f.read('league')).products[0].blockedReason, /段位/);
  f.shared.dan = 3; assert.equal((await f.buy('league')).status, 'completed');
  f.player.guildId = 1000; assert.match((await f.read('guild')).products[0].blockedReason, /联盟/);
  f.player.guildId = 1001; assert.equal((await f.buy('guild')).status, 'completed');
});
test('VIP lock, absent buildings, insufficient currency and exact quantity bounds', async () => {
  const f = fixture(); f.player.vip.vipLevel = 2; assert.match((await f.read('vip')).products[0].blockedReason, /VIP/);
  f.player.vip.vipLevel = 3; f.shared.buildings[0].level = 0; assert.match((await f.read('vip')).products[0].blockedReason, /建成/);
  f.shared.buildings[0].level = 1; f.stock.set('RUBY', 10); assert.equal((await f.read('vip')).products[0].canBuy, false);
  f.stock.set('RUBY', 1000); assert.equal((await f.buy('vip', { quantity: 6 })).status, 'rejected'); assert.equal(sent(f).length, 0);
});
test('zero optional defaults permit only one per purchase', async () => {
  const f = fixture(); const p = f.products.get(1)[0]; p.limitBuyTimes = 0; f.shared.omitDefaults = true;
  const view = await f.read('arena'); assert.equal(view.products[0].remaining, null); assert.equal(view.products[0].maxQuantity, 1);
  assert.equal((await f.buy('arena', { quantity: 2 })).status, 'rejected');
  assert.equal((await f.buy('arena')).status, 'completed'); assert.equal((await f.buy('arena')).status, 'completed');
  assert.equal((await f.buy('discount')).status, 'completed');
});
test('shuimu half price follows current server halfEndTime only', async () => {
  const f = fixture(); f.shared.halfEndTime = Math.floor(Date.now() / 1000) + 500;
  const item = (await f.read('shuimu')).products[0]; assert.equal(item.price.num, 50); assert.equal(item.discount, 50);
  assert.equal((await f.buy('shuimu')).status, 'completed'); assert.equal(f.stock.get('水姆币'), 950);
});
test('discount dedicated response and ad per-product claim', async () => {
  const f = fixture(); const discount = await f.buy('discount'); assert.equal(discount.status, 'completed'); assert.equal(f.stock.get('RUBY'), 950);
  const ad = await f.buy('ad'); assert.equal(ad.status, 'completed'); assert.equal(f.adverts[0].gotTimes, 1); assert.equal(f.stock.get('木材'), 5);
  assert.equal(f.calls.filter(([name]) => name === 'WatchAdvRequest').length, 1);
});
test('discount receipt grants the purchased reward while the slot already offers a replacement', async () => {
  const f = fixture(), slot = f.discounts[0];
  Object.assign(slot, { price: 400, discount: 0.6, reward: { asset: [{ type: 0, id: '抽卡券', num: 1 }] } });
  f.stock.set('抽卡券', 27);
  const oldQuote = (await f.read('discount')).products[0];
  const request = f.client.request.bind(f.client);
  f.client.request = async (...args) => {
    const reply = await request(...args);
    if (args[0] !== 'DiscountShopBuyRequest') return reply;
    Object.assign(slot, { price: 50, discount: 0.4, isBuy: false, reward: { asset: [{ type: 0, id: '原料自选包', num: 1000 }] } });
    return { shopItem: clone(slot), reward: { asset: [{ type: 0, id: '抽卡券', num: { low: 1, high: 0, unsigned: false } }] } };
  };
  const buy = quote => buyShopProduct(f.client, f.config, { ...f.options, shop: 'discount', id: quote.id, quantity: 1, token: quote.token, paid: true });
  const quote = (await f.read('discount')).products[0];
  f.calls.length = 0;
  const out = await buy(quote);
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.rewards, [{ id: '抽卡券', name: '抽卡券', num: 1 }]);
  assert.equal(out.costs[0].num, 240);
  assert.equal(f.stock.get('抽卡券'), 28);
  assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, 240);
  assert.equal(f.calls.filter(([name]) => name === 'DiscountShopRequest').length, 1);
  assert.equal(f.calls.at(-1)[0], 'DiscountShopBuyRequest', '完整回执可直接结算');
  assert.equal((await buy(oldQuote)).status, 'rejected');
  const next = await f.read('discount');
  assert.equal(next.products[0].asset.id, '原料自选包');
  assert(next.products[0].canBuy && next.gameRefresh.canRefresh);
  assert.equal(sent(f).length, 1);
});
test('old pending discount buys reconcile a replacement slot only with original stock changes in the same cycle', async () => {
  const f = fixture(), slot = f.discounts[0];
  f.shared.mode = 'unknown';
  assert.equal((await f.buy('discount')).status, 'unknown');
  f.shared.mode = 'ok';
  const original = clone(slot);
  slot.reward = { asset: [{ type: 0, id: '木材', num: 1 }] };
  assert.equal((await f.read('discount')).gameRefresh.canRefresh, false, '换货本身不能确认');
  f.stock.set('RUBY', 950);
  f.stock.set('建筑蓝图', 3);
  slot.reward = original.reward;
  assert.equal((await f.read('discount')).gameRefresh.canRefresh, false, '库存本身不能确认');
  slot.reward = { asset: [{ type: 0, id: '木材', num: 1 }] };
  f.shared.refreshCount++;
  await f.read('discount');
  assert.equal(f.ledger.pendingCounters().manualShopDiamonds, 50, '其他刷新周期不能核销旧购买');
  f.shared.refreshCount--;
  const reopened = await readShop(f.client, f.config, { ...f.options, shop: 'discount', state: createShopState() });
  assert(reopened.products[0].canBuy && reopened.gameRefresh.canRefresh);
  assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, 50);
  assert.equal(f.ledger.snapshot().uncertain, 0);
  assert.equal(sent(f).length, 1);
});
test('an unrelated or incomplete discount receipt alone never confirms a purchase', async () => {
  for (const malformed of ['slot', 'reward', 'missing']) {
    const f = fixture(), slot = f.discounts[0];
    const request = f.client.request.bind(f.client);
    f.client.request = async (...args) => {
      if (args[0] !== 'DiscountShopBuyRequest') return request(...args);
      args[4]?.();
      return { shopItem: { id: slot.id + (malformed === 'slot' ? 1 : 0) },
        reward: malformed === 'missing' ? {} : { asset: [{ ...slot.reward.asset[0], num: malformed === 'reward' ? 9 : 3 }] } };
    };
    const outcome = await f.buy('discount');
    assert.equal(outcome.status, 'unknown');
    assert.equal(f.ledger.pendingCounters().manualShopDiamonds, 50);
    assert.equal((await f.read('discount')).gameRefresh.canRefresh, false);
  }
});
test('price changes, expiry and same-token concurrent calls never send twice', async () => {
  const f = fixture(), view = await f.read('vip'), item = view.products[0]; f.products.get(3)[0].price.num = 110;
  const opts = { ...f.options, shop: 'vip', id: item.id, token: item.token, quantity: 1, paid: true };
  assert.equal((await buyShopProduct(f.client, f.config, opts)).status, 'rejected'); assert.equal(sent(f).length, 0);
  const v = await f.read('vip'), token = v.products[0].token; f.state.tokens.get(token).expiresAt = Date.now() - 1;
  assert.equal((await buyShopProduct(f.client, f.config, { ...opts, token })).status, 'rejected');
  const current = (await f.read('vip')).products[0], results = await Promise.allSettled([buyShopProduct(f.client, f.config, { ...opts, token: current.token }), buyShopProduct(f.client, f.config, { ...opts, token: current.token })]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'completed').length, 1); assert.equal(sent(f).length, 1);
});
test('pause, role switch and price changes cancel only unsent tickets', async () => {
  for (const change of ['pause', 'role', 'price']) {
    const f = fixture(), original = f.options.guard.before;
    f.options.guard.before = async step => { const ticket = await original(step); if (change === 'pause') f.stop(); if (change === 'role') f.player.playerId++; if (change === 'price') f.products.get(3)[0].price.num++; return ticket; };
    assert.notEqual((await f.buy('vip')).status, 'completed'); assert.equal(sent(f).length, 0);
    assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0); assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
  }
});
test('explicit rejection and notSent release durable and manual diamond reservations', async () => {
  for (const mode of ['reject', 'notSent']) {
    const f = fixture(); f.shared.mode = mode; const out = await f.buy('vip');
    assert.equal(out.status, 'rejected'); assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.snapshot().counters.manualShopDiamonds ?? 0, 0); assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
  }
});
test('unknown manual diamond tickets persist across reconnect and settle with late business+stock evidence', async () => {
  const f = fixture(); Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 0 });
  f.shared.mode = 'unknown'; const out = await f.buy('vip'); assert.equal(out.status, 'unknown');
  assert.equal(f.ledger.pendingCounters().manualShopDiamonds, 100); assert.equal((await f.read('vip')).products[0].canBuy, false);
  assert.equal(f.ledger.confirmedCounters().manualShopDiamonds ?? 0, 0); assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
  const oldClient = f.client; const replacement = { ...f.client, connected: true }; oldClient.connected = false;
  const nextLedger = createUsageLedger('shop-test-' + serial, { file: path.join(temp, 'ledger.json') }), state = createShopState();
  assert.equal(nextLedger.pendingCounters().manualShopDiamonds, 100);
  const unknownRecord = Object.values(nextLedger.keyRecords()).find(record => record.details?.kind === 'shopPurchase');
  assert(unknownRecord?.details.guardTicket?.id, 'business record must retain the exact durable guard ticket');
  const pending = await readShop(replacement, f.config, { ...f.options, ledger: nextLedger, state, shop: 'vip' });
  assert.equal(pending.products[0].canBuy, false); assert.equal(sent(f).length, 1);
  f.shared.mode = 'ok'; await replacement.mutate('BuyShopProductRequest', { type: 3, id: 301, num: 1 });
  const view = await readShop(replacement, f.config, { ...f.options, ledger: nextLedger, state, shop: 'vip' });
  assert.equal(view.products[0].canBuy, true); assert.equal(nextLedger.pendingCounters().manualShopDiamonds ?? 0, 0);
  assert.equal(nextLedger.confirmedCounters().manualShopDiamonds, 100); assert.equal(nextLedger.snapshot().uncertain, 0);
  assert.equal(nextLedger.snapshot().counters.diamonds ?? 0, 0); assert.equal(nextLedger.confirmedCounters().diamonds ?? 0, 0);
  await readShop(replacement, f.config, { ...f.options, ledger: nextLedger, state, shop: 'vip' });
  assert.equal(nextLedger.confirmedCounters().manualShopDiamonds, 100, 'refresh must not confirm the same manual cost twice');
  assert.equal(sent(f).length, 1);
});
test('lagging stock never claims success even after buyTimes increases', async () => {
  const f = fixture(); f.shared.mode = 'lag'; const out = await f.buy('vip'); assert.equal(out.status, 'unknown'); assert.deepEqual(out.rewards, []);
  assert.equal(f.ledger.pendingCounters().manualShopDiamonds, 100); assert.equal((await f.read('vip')).products[0].canBuy, false);
  f.shared.stockLag = null; assert.equal((await f.read('vip')).products[0].canBuy, true); assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0); assert.equal(sent(f).length, 1);
});
test('unknown evidence from a different refresh cycle never confirms an old write', async () => {
  const f = fixture(); f.shared.mode = 'unknown'; assert.equal((await f.buy('vip')).status, 'unknown');
  f.shared.mode = 'ok'; await f.client.mutate('BuyShopProductRequest', { type: 3, id: 301, num: 1 });
  const original = f.client.request.bind(f.client);
  f.client.request = async (...args) => { const value = await original(...args); if (args[0] === 'ShopInfoRequest') value.nextRefreshTime++; return value; };
  assert.equal((await f.buy('vip')).status, 'completed'); assert.equal(f.ledger.pendingCounters().manualShopDiamonds, 100);
});
test('quote crossing ad Beijing midnight is rejected and old unknown stays pending', async () => {
  const f = fixture(), item = (await f.read('ad')).products[0]; f.client.serverClockOffsetMs = 86400_000;
  assert.equal((await buyShopProduct(f.client, f.config, { ...f.options, shop: 'ad', id: item.id, quantity: 1, token: item.token, paid: false })).status, 'rejected');
  f.client.serverClockOffsetMs = 0; f.shared.mode = 'unknown'; assert.equal((await f.buy('ad')).status, 'unknown');
  f.shared.mode = 'ok'; await f.client.mutate('GotAdvRewardRequest', { id: item.id }); f.client.serverClockOffsetMs = 86400_000;
  assert.equal((await f.buy('ad')).status, 'completed'); assert.equal(f.ledger.snapshot().uncertain, 1);
});
test('unknown response costs have names and confirmed absent reward uses verified quote', async () => {
  const f = fixture(); f.shared.mode = 'unknown'; const unknown = await f.buy('vip'); assert.equal(unknown.costs[0].name, 'RUBY');
  const g = fixture(), original = g.client.request.bind(g.client);
  g.client.request = async (...args) => { const value = await original(...args); if (args[0] === 'ShopInfoRequest' && sent(g).length > 0) for (const item of value.product) delete item.asset; return value; };
  const completed = await g.buy('vip'); assert.equal(completed.status, 'completed'); assert.deepEqual(completed.rewards, [{ id: '建筑蓝图', name: '建筑蓝图', num: 3 }]);
});
test('advert waiting rechecks eligibility and refuses changed reward counters', async () => {
  const f = fixture(); f.player.vip.vipLevel = 0;
  f.hooks.WatchAdvRequest = async () => { f.adverts[0].gotTimes++; };
  assert.equal((await f.buy('ad')).status, 'rejected'); assert.equal(sent(f).length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
});
test('post-write bookkeeping errors cannot reverse a confirmed purchase', async () => {
  const f = fixture(); f.options.guard.after = async () => { throw new Error('observer failed'); };
  assert.equal((await f.buy('vip')).status, 'completed'); assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0);
});
test('read-only ad path never applies WatchAdv and token storage is bounded', async () => {
  const f = fixture(); await f.read('ad'); assert.equal(f.calls.some(([name]) => name === 'WatchAdvRequest'), false);
  for (let i = 0; i < 510; i++) await f.read('vip'); assert(f.state.tokens.size <= 500);
});
const refreshWrites = f => f.calls.filter(([name]) => name === 'DiscountShopRefreshRequest');
const updateGameShop = async (f, extra = {}) => {
  const quote = (await f.read('discount')).gameRefresh;
  return refreshDiscountShop(f.client, f.config, { ...f.options, shop: 'discount', token: quote.token, paid: quote.price.num > 0, ...extra });
};
test('purchase and paid refresh use the final diamond balance when automation settings change', async () => {
  for (const shop of ['vip', 'refresh']) for (const affordable of [true, false]) {
    const f = fixture(), cost = shop === 'vip' ? 100 : 50;
    f.shared.refreshCount = 2;
    const before = f.options.guard.before.bind(f.options.guard);
    f.options.guard.before = async step => {
      const ticket = await before(step);
      f.settings.resources.diamondThreshold = 1000;
      f.stock.set('RUBY', affordable ? cost : cost - 1);
      return ticket;
    };
    const outcome = shop === 'vip' ? await f.buy(shop) : await updateGameShop(f);
    assert.equal(outcome.status, affordable ? 'completed' : 'rejected');
    assert.equal(sent(f).length + refreshWrites(f).length, affordable ? 1 : 0);
    assert.equal(f.stock.get('RUBY'), affordable ? 0 : cost - 1);
    assert.equal(f.ledger.snapshot().uncertain, 0);
  }
});
test('half price ending at the send boundary cancels the purchase', async () => {
  const f = fixture();
  f.shared.halfEndTime = Math.floor(Date.now() / 1000) + 10;
  const send = f.client.sendWatch.bind(f.client);
  f.client.sendWatch = (...args) => {
    f.client.serverClockOffsetMs = 10_000;
    return send(...args);
  };
  const outcome = await f.buy('shuimu');
  assert.equal(outcome.status, 'rejected');
  assert.equal(sent(f).length, 0);
  assert.equal(f.stock.get('水姆币'), 1000);
  assert.equal(f.ledger.snapshot().uncertain, 0);
});
test('a debit larger than the confirmed price stays unknown after a reread', async () => {
  for (const shop of ['vip', 'refresh']) {
    const f = fixture();
    f.shared.refreshCount = 2;
    const mutate = f.client.mutate.bind(f.client);
    f.client.mutate = async (...args) => {
      const value = await mutate(...args);
      f.stock.set('RUBY', f.stock.get('RUBY') - 1);
      return value;
    };
    const outcome = shop === 'vip' ? await f.buy(shop) : await updateGameShop(f);
    assert.equal(outcome.status, 'unknown');
    const view = await f.read(shop === 'vip' ? 'vip' : 'discount');
    assert.equal(view.products[0].canBuy, false);
    assert.equal(f.ledger.confirmedCounters().manualShopDiamonds ?? 0, 0);
  }
});
test('rereading shop goods is read-only and never consumes a game refresh', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    const view = await f.read('discount');
    assert.equal(view.gameRefresh.refreshCount, 0); assert.equal(view.gameRefresh.limit, 3);
    assert.equal(view.gameRefresh.price.num, 0); assert.equal(view.gameRefresh.canRefresh, true);
  }
  assert.equal(refreshWrites(f).length, 0); assert.equal(f.stock.get('RUBY'), 1000);
  assert.equal((await f.read('vip')).gameRefresh, null);
});
test('game refresh performs two free updates then one explicitly confirmed paid update', async () => {
  const f = fixture(); Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 0 });
  assert.equal((await updateGameShop(f)).status, 'completed');
  assert.equal((await updateGameShop(f)).status, 'completed');
  assert.equal(f.stock.get('RUBY'), 1000); assert.equal(f.shared.refreshCount, 2);
  assert.equal((await updateGameShop(f, { paid: false })).status, 'rejected');
  assert.equal(refreshWrites(f).length, 2);
  const result = await updateGameShop(f); assert.equal(result.action, 'game-refresh'); assert.equal(result.status, 'completed');
  assert.equal(f.stock.get('RUBY'), 950); assert.equal(f.shared.refreshCount, 3);
  assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, 50); assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
  const view = await f.read('discount'); assert.equal(view.gameRefresh.canRefresh, false); assert.match(view.gameRefresh.blockedReason, /今日刷新次数已耗尽/);
  assert(refreshWrites(f).every(([, body, response]) => Object.keys(body).length === 0 && response === 'DiscountShopResponse'));
});
test('a complete refresh response only needs a subsequent currency read when paid', async () => {
  for (const count of [0, 2]) {
    const f = fixture();
    f.shared.refreshCount = count;
    const quote = (await f.read('discount')).gameRefresh;
    f.calls.length = 0;
    const result = await refreshDiscountShop(f.client, f.config, { ...f.options, shop: 'discount', token: quote.token, paid: count === 2 });
    assert.equal(result.status, 'completed');
    const names = f.calls.map(([name]) => name);
    assert.equal(names.filter(name => name === 'DiscountShopRequest').length, 1);
    assert.deepEqual(names.slice(names.indexOf('DiscountShopRefreshRequest') + 1), count === 2 ? ['AllResourceRequest'] : []);
  }
});
test('game refresh fees use the first upper interval and VIP extends the real cap', async () => {
  const f = fixture(); f.config.tables.ShopRefreshCfg.data = [{ times: 1, cost: [] }, { times: 4, cost: ['RUBY', 75] }];
  f.shared.refreshCount = 1; assert.equal((await f.read('discount')).gameRefresh.price.num, 75);
  f.player.vip.vipLevel = 5; const quote = (await f.read('discount')).gameRefresh; assert.equal(quote.limit, 6);
  f.shared.refreshCount = 5; assert.equal((await updateGameShop(f)).status, 'completed'); assert.equal(f.stock.get('RUBY'), 925);
  assert.equal((await f.read('discount')).gameRefresh.remaining, 0);
  const zero = fixture(); zero.player.vip.vipLevel = 0; assert.equal((await zero.read('discount')).gameRefresh.limit, 3);
});
test('only active month card effects extend the shop refresh cap', async () => {
  const f = fixture(); f.config.tables.MonthCardCfg.data[0].effectList = [['折扣商店刷新次数', 2]];
  f.shared.monthCards = [{ type: 1, endTime: -1 }, { type: 2, endTime: 1 }];
  assert.equal((await f.read('discount')).gameRefresh.limit, 5);
  f.shared.monthCards = [{ type: 1, endTime: 1 }]; assert.equal((await f.read('discount')).gameRefresh.limit, 3);
});
test('new game refresh invalidates old purchase and refresh quotes even for identical goods', async () => {
  const f = fixture(), before = await f.read('discount');
  const original = f.client.request.bind(f.client);
  f.client.request = async (...args) => { const out = await original(...args); if (args[0] === 'DiscountShopRefreshRequest') f.discounts[0].price--; return out; };
  assert.equal((await refreshDiscountShop(f.client, f.config, { ...f.options, shop: 'discount', token: before.gameRefresh.token, paid: false })).status, 'completed');
  assert.equal((await buyShopProduct(f.client, f.config, { ...f.options, shop: 'discount', id: before.products[0].id, quantity: 1, token: before.products[0].token, paid: true })).status, 'rejected');
  assert.equal((await refreshDiscountShop(f.client, f.config, { ...f.options, shop: 'discount', token: before.gameRefresh.token, paid: false })).status, 'rejected');
  assert.equal(refreshWrites(f).length, 1); assert.equal(sent(f).length, 0);
});
test('game refresh quote changes, pause and insufficient balance prevent writes', async () => {
  for (const change of ['price', 'count', 'pause', 'balance']) {
    const f = fixture(); f.shared.refreshCount = 2;
    const quote = (await f.read('discount')).gameRefresh;
    if (change === 'price') f.config.tables.ShopRefreshCfg.data[2].cost[1]++;
    if (change === 'count') f.shared.refreshCount++;
    if (change === 'balance') f.stock.set('RUBY', 0);
    if (change === 'pause') { const before = f.options.guard.before; f.options.guard.before = async step => { const ticket = await before(step); f.stop(); return ticket; }; }
    assert.notEqual((await refreshDiscountShop(f.client, f.config, { ...f.options, shop: 'discount', token: quote.token, paid: true })).status, 'completed');
    assert.equal(refreshWrites(f).length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
  }
});
test('unknown game refresh blocks repeats and discount purchases until late count plus stock settlement', async () => {
  const f = fixture(); f.shared.refreshCount = 2; f.shared.mode = 'unknown';
  assert.equal((await updateGameShop(f)).status, 'unknown'); assert.equal(f.ledger.pendingCounters().manualShopDiamonds, 50);
  const ledger = createUsageLedger('shop-test-' + serial, { file: path.join(temp, 'ledger.json') });
  const next = async () => readShop(f.client, f.config, { ...f.options, ledger, state: createShopState(), shop: 'discount' });
  const pending = await next(); assert.equal(pending.gameRefresh.canRefresh, false); assert.equal(pending.products[0].canBuy, false);
  f.shared.mode = 'ok'; await f.client.mutate('DiscountShopRefreshRequest', {});
  const settled = await next(); assert.equal(settled.gameRefresh.remaining, 0); assert.equal(ledger.snapshot().uncertain, 0);
  assert.equal(ledger.confirmedCounters().manualShopDiamonds, 50); assert.equal(refreshWrites(f).length, 1);
});
test('game refresh with lagging currency remains unknown until a read confirms the debit', async () => {
  const f = fixture(); f.shared.refreshCount = 2; f.shared.mode = 'lag';
  assert.equal((await updateGameShop(f)).status, 'unknown'); assert.equal(f.shared.refreshCount, 3);
  assert.equal((await f.read('discount')).gameRefresh.canRefresh, false); assert.equal(f.ledger.snapshot().uncertain, 2);
  f.shared.stockLag = null; await f.read('discount'); assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.ledger.confirmedCounters().manualShopDiamonds, 50);
});
test('a new reset cycle never confirms an old uncertain game refresh', async () => {
  const f = fixture(); f.shared.mode = 'unknown'; assert.equal((await updateGameShop(f)).status, 'unknown');
  f.shared.mode = 'ok'; await f.client.mutate('DiscountShopRefreshRequest', {}); f.shared.refreshTime++;
  const view = await f.read('discount'); assert.equal(view.gameRefresh.canRefresh, true); assert.equal(view.products[0].canBuy, true);
  assert.equal((await updateGameShop(f)).status, 'completed');
  assert.equal(f.ledger.snapshot().uncertain, 1);
});
test('explicit refresh rejection and unsent writes release only their reservations', async () => {
  for (const mode of ['reject', 'notSent']) {
    const f = fixture(); f.shared.refreshCount = 2; f.shared.mode = mode;
    assert.equal((await updateGameShop(f)).status, 'rejected'); assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.pendingCounters().manualShopDiamonds ?? 0, 0); assert.equal(f.stock.get('RUBY'), 1000);
  }
});
test('bad refresh configuration disables only game refresh and does not prevent reading products', async () => {
  const f = fixture(); f.config.tables.ShopRefreshCfg.data[0].cost = ['GOLD', 1];
  const view = await f.read('discount'); assert.equal(view.gameRefresh.canRefresh, false); assert(view.products[0].canBuy);
  assert.equal(refreshWrites(f).length, 0); assert.match(view.gameRefresh.blockedReason, /刷新费用/);
});
test('concurrent game refresh quotes reserve the same generation only once', async () => {
  const f = fixture();
  const a = (await f.read('discount')).gameRefresh, b = (await f.read('discount')).gameRefresh;
  const out = await Promise.allSettled([a, b].map(quote => refreshDiscountShop(f.client, f.config, { ...f.options, shop: 'discount', token: quote.token, paid: false })));
  assert.equal(out.filter(row => row.status === 'fulfilled' && row.value.status === 'completed').length, 1);
  assert.equal(refreshWrites(f).length, 1); assert.equal(f.shared.refreshCount, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
});
test('manual game refresh exemption requires matching kind and cannot waive automatic budgets', async () => {
  const costs = [{ id: 'RUBY', num: 50 }];
  assert.deepEqual(actionCounters({ kind: 'shopRefresh', scope: 'manual', request: 'DiscountShopRefreshRequest', costs }), { manualShopDiamonds: 50 });
  for (const markers of [{ kind: 'shopPurchase', scope: 'manual' }, { kind: 'shopRefresh', scope: 'daily' }, { scope: 'manual' }]) {
    assert.deepEqual(actionCounters({ ...markers, request: 'DiscountShopRefreshRequest', costs }), { diamonds: 50 });
  }
});
test('protocol-default month card fields preserve permanent and expired card semantics', async () => {
  const f = fixture(); f.config.tables.MonthCardCfg.data[0].effectList = [['折扣商店刷新次数', 2]];
  f.shared.monthCards = [{ endTime: -1 }]; assert.equal((await f.read('discount')).gameRefresh.limit, 5);
  f.shared.monthCards = [{}]; assert.equal((await f.read('discount')).gameRefresh.limit, 3);
});
test('a game update waits for current purchases to settle before discarding their generation', async () => {
  const f = fixture(); f.shared.mode = 'unknown'; assert.equal((await f.buy('discount')).status, 'unknown');
  const pending = await f.read('discount'); assert.equal(pending.gameRefresh.canRefresh, false); assert.match(pending.gameRefresh.blockedReason, /购买结果待确认/);
  f.shared.mode = 'ok'; await f.client.mutate('DiscountShopBuyRequest', { id: 901 });
  const settled = await f.read('discount'); assert.equal(settled.gameRefresh.canRefresh, true); assert.equal(f.ledger.snapshot().uncertain, 0);
  assert.equal((await updateGameShop(f)).status, 'completed');
});
const autoShop = f => runDiscountShop(f.client, f.config, { ...f.options, report() {} });
const blueprintRule = { id: '建筑蓝图', maxPercent: 50, maxDiamonds: null };
test('old shop switches migrate without granting rules or refreshes', async () => {
  const f = fixture(), old = defaultSettings();
  old.schedule.shop = true; delete old.discountShop;
  const upgraded = importAutomationSettings({ ...exportAutomationSettings(defaultSettings()), settings: old, version: 40 });
  Object.assign(f.settings, upgraded);
  await autoShop(f);
  assert.equal(f.calls.length, 0);
  for (const rule of [{ ...blueprintRule, maxPercent: null }, { ...blueprintRule, maxPercent: 101 }, { ...blueprintRule, maxDiamonds: -1 }]) {
    f.settings.discountShop.rules = [rule]; assert.throws(() => validateSettings(f.settings), /购买|上限/);
  }
});
test('automatic buying follows reward ids and exact OR thresholds independently of daily progress', async () => {
  const f = fixture(), first = f.discounts[0];
  f.shared.refreshCount = 2;
  f.settings.schedule.shop = true;
  Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 0, diamondThreshold: 1000 });
  f.settings.discountShop.rules = [{ ...blueprintRule, maxDiamonds: 25 }];
  // Same reward across slots, plus an unrelated cheaper item.
  for (const [id, assetId, price, discount] of [[902, '木材', 1, 1], [903, '建筑蓝图', 50, .51], [904, '建筑蓝图', 100, .501]]) {
    f.discounts.push({ ...clone(first), id, price, discount, reward: { asset: [{ type: 0, id: assetId, num: 1 }] } });
  }
  await autoShop(f); await autoShop(f);
  assert.deepEqual(sent(f).map(([, body]) => body.id), [903, 901]);
  assert.equal(f.ledger.confirmedCounters().discountShopDiamonds, 75);
  assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
  assert.equal(f.ledger.snapshot().counters.manualShopDiamonds, undefined);
  assert.equal(refreshWrites(f).length, 0);
});
test('rotation buys from the new shelf after the last free refresh and stops at a paid quote', async () => {
  const f = fixture(); f.settings.schedule.shop = true;
  f.settings.resources.allowDiamonds = false;
  f.settings.discountShop.rules = [blueprintRule];
  const item = f.discounts[0]; item.reward.asset[0].id = '木材';
  f.shared.refreshCount = 1;
  f.hooks.DiscountShopRefreshRequest = () => { item.id = 905; item.reward.asset[0].id = '建筑蓝图'; };
  await autoShop(f); await autoShop(f);
  assert.equal(f.shared.refreshCount, 2); assert.equal(refreshWrites(f).length, 1);
  assert.deepEqual(sent(f).map(([, body]) => body.id), [905]);
  assert.equal(f.ledger.confirmedCounters().discountShopDiamonds, 51);
  assert.equal(f.stock.get('RUBY'), 949);
});
function fallbackFixture() {
  const f = fixture();
  f.settings.schedule.shop = true;
  Object.assign(f.settings.discountShop, { rules: [blueprintRule], fallbackCheapest: true });
  Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 0, diamondThreshold: 1000 });
  const first = f.discounts[0]; first.reward.asset[0].id = '木材';
  for (const [id, price] of [[903, 10], [902, 10]]) f.discounts.push({ ...clone(first), id, price });
  return f;
}
test('fallback buys one lowest whole-pack price from the last free shelf, breaking ties in shelf order', async () => {
  const f = fallbackFixture();
  await autoShop(f);
  assert.equal(sent(f).length, 0); assert.equal(f.shared.refreshCount, 1);
  f.hooks.DiscountShopRefreshRequest = () => { f.discounts[0].price = 60; };
  await autoShop(f); await autoShop(f);
  assert.equal(refreshWrites(f).length, 2);
  assert.deepEqual(sent(f).map(([, body]) => body.id), [903]);
  assert.equal(f.ledger.confirmedCounters().discountShopDiamonds, 6);
  assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
});
test('a match on any observed shelf suppresses fallback, including after a restart or when the balance is insufficient', async () => {
  for (const affordable of [true, false]) {
    const f = fallbackFixture();
    f.discounts[0].reward.asset[0].id = '建筑蓝图';
    if (!affordable) f.stock.set('RUBY', 20);
    await autoShop(f);
    f.discounts[0].reward.asset[0].id = '木材'; f.shared.refreshCount = 2;
    f.options.ledger = createUsageLedger('shop-test-' + serial, { file: path.join(temp, 'ledger.json') });
    await autoShop(f);
    assert.deepEqual(sent(f).map(([, body]) => body.id), affordable ? [901] : []);
  }
});
test('fallback skips paid and initial shelves, checks the balance and requotes the cheapest item before send', async () => {
  const f = fallbackFixture(); f.shared.refreshCount = 3;
  await autoShop(f);
  f.shared.refreshCount = 0;
  const tiers = f.config.tables.ShopRefreshCfg.data;
  tiers[0].cost = ['RUBY', 50]; await autoShop(f);
  f.shared.refreshCount = 2;
  f.stock.set('RUBY', 4); await autoShop(f);
  assert.equal(sent(f).length + refreshWrites(f).length, 0);
  f.stock.set('RUBY', 50);
  const before = f.options.guard.before;
  f.options.guard.before = async step => { const ticket = await before(step); f.discounts[0].price = 2; return ticket; };
  await autoShop(f); assert.equal(sent(f).length, 0);
  await autoShop(f); assert.deepEqual(sent(f).map(([, body]) => body.id), [901]);
});
test('fallback on an all-free schedule handles rejection and an uncertain purchase without buying another item', async () => {
  const f = fallbackFixture(); f.shared.refreshCount = 3;
  f.config.tables.ShopRefreshCfg.data.at(-1).cost = [];
  f.shared.mode = 'reject'; await autoShop(f);
  f.shared.mode = 'unknown'; await autoShop(f); await autoShop(f);
  assert.deepEqual(sent(f).map(([, body]) => body.id), [903, 903]);
  f.shared.mode = 'ok'; await f.client.mutate('DiscountShopBuyRequest', { id: 903 });
  await autoShop(f); assert.equal(sent(f).length, 2);
  assert.equal(f.ledger.snapshot().uncertain, 0);
});
test('automatic refresh rejects a paid quote even with legacy authorization or a price change before send', async () => {
  const f = fixture();
  f.settings.schedule.shop = true;
  f.settings.discountShop.rules = [blueprintRule];
  f.discounts[0].isBuy = true;
  f.shared.refreshCount = 2;
  assert.equal((await updateGameShop(f, { scope: 'discountShop', paid: true })).status, 'rejected');
  f.shared.refreshCount = 1;
  const before = f.options.guard.before;
  let requoted = false;
  f.options.guard.before = async step => {
    const ticket = await before(step);
    f.config.tables.ShopRefreshCfg.data[1].cost = ['RUBY', 50];
    requoted = true;
    return ticket;
  };
  await autoShop(f);
  assert(requoted);
  assert.equal(refreshWrites(f).length, 0);
  assert.equal(f.stock.get('RUBY'), 1000);
});
test('discount purchases use the actual balance and reconcile uncertain costs outside the global budget', async () => {
  const f = fixture(); f.settings.schedule.shop = true;
  f.settings.discountShop.rules = [blueprintRule];
  Object.assign(f.settings.resources, { allowDiamonds: false, diamondDailyLimit: 20, diamondThreshold: 1000 });
  f.ledger.confirm(f.ledger.reserve({ diamonds: 20 }, { diamonds: 20 }));
  f.stock.set('RUBY', 49);
  await autoShop(f);
  assert.equal(sent(f).length + refreshWrites(f).length, 0);
  f.stock.set('RUBY', 50); f.shared.mode = 'unknown';
  await autoShop(f); await autoShop(f);
  assert.equal(sent(f).length, 1); assert.equal(refreshWrites(f).length, 0);
  assert.equal(f.ledger.pendingCounters().discountShopDiamonds, 50);
  assert.equal(f.ledger.pendingCounters().diamonds ?? 0, 0);
  f.shared.mode = 'ok'; await f.client.mutate('DiscountShopBuyRequest', { id: 901 });
  await f.read('discount');
  assert.equal(f.stock.get('RUBY'), 0);
  assert.equal(f.ledger.snapshot().uncertain, 0);
  assert.equal(f.ledger.confirmedCounters().discountShopDiamonds, 50);
  assert.equal(f.ledger.confirmedCounters().diamonds, 20);
});
test('only discount purchases have independent diamond authorization', async () => {
  const f = fixture();
  f.settings.resources.allowDiamonds = false;
  f.settings.schedule.shop = true;
  const buy = { scope: 'discountShop', kind: 'shopPurchase', request: 'DiscountShopBuyRequest', costs: [{ id: 'RUBY', num: 50 }] };
  const refresh = { ...buy, kind: 'shopRefresh', request: 'DiscountShopRefreshRequest' };
  const other = [{ ...buy, request: 'BuyShopProductRequest' }, { ...buy, scope: 'daily' }, { ...buy, request: 'ClickGoldRequest' }, refresh];
  assert.deepEqual(budgetPreview([...other, buy], f.stock, f.settings).actions, [buy]);
  for (const step of other) await assert.rejects(f.options.guard.before(step), /总开关/);
  f.settings.resources.allowDiamonds = true;
  await assert.rejects(f.options.guard.before(refresh), /总开关/);
  f.settings.schedule.shop = false;
  assert.deepEqual(budgetPreview([buy], f.stock, f.settings).actions, []);
  await assert.rejects(f.options.guard.before(buy), /总开关/);
});
test('normal loop buys from the dedicated shop while daily actions are disabled', async () => {
  const { runLoop } = await import('../src/loop.mjs');
  const f = fixture(), client = Object.assign(new EventEmitter(), f.client);
  client.setMaxListeners(50);
  f.settings.schedule.shop = true;
  f.settings.resources.allowDiamonds = false;
  f.settings.discountShop.rules = [blueprintRule];
  await runLoop(client, protocol, { config: f.config, player: f.player, allowMutate: true, rounds: 1,
    getSettings: f.options.getSettings, usageLedger: f.ledger, isEnabled: key => key === 'shop' });
  assert.deepEqual(sent(f).map(([, body]) => body.id), [901]);
  assert(!f.calls.some(([name]) => name === 'DailyTaskInfoRequest'));
});
try {
  for (const [name, run] of tests) { await run(); console.log('ok - ' + name); }
  console.log('shops selftest ok: ' + tests.length + ' tests' + (protocol !== declared ? ' (real protocol encoding)' : ' (declared offline protocol)'));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
