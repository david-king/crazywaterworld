import assert from 'node:assert/strict';
import { merchantActionSeconds, merchantOpeningCargo, merchantSettings, merchantSpeedSalePrices, merchantTiming, optimizePurchasePlan, planMerchant } from '../src/merchant-planner.mjs';
import { merchantStrategyPlan } from '../src/merchant-strategy.mjs';
import { merchantClosingRoute } from '../src/merchant-speed.mjs';
import { fullMerchantLoad } from '../src/merchant-loading.mjs';
import { merchantOpeningRadar } from '../src/merchant-race.mjs';

const table = data => ({ data });
const now = Date.UTC(2026, 10, 12, 4, 10) / 1000;
function fixture() {
  const config = { tables: {
    ActivityTradeCfg: table([
      { key: '海商王贸易时间', value: '10-22' },
      { key: '海商王行驶时间', value: '120' },
      { key: '海商王刷新时间', value: '10,12,14,16,18,20' }
    ]),
    TradeShipCfg: table([{ lv: 1, capacity: 10, profitMargin: 300 }]),
    TradeGoodsCfg: table([
      { goodsId: 1, capacity: 1, unitPrice: 100, maxCount: 20, itemName: '鱼' },
      { goodsId: 2, capacity: 1, unitPrice: 200, maxCount: 20, itemName: '水' },
      { goodsId: 3, capacity: 1, unitPrice: 300, maxCount: 20, itemName: '盐' }
    ])
  } };
  const event = { startTime: now - 86400, endTime: now + 86400, period: 1001 };
  const state = { period: 1001, player: { coins: 1000, profit: 0, goods: [] },
    cargo: { cityId: 10, cargoLv: 1, moveEndTime: 0, moveToCityId: 0 } };
  const market = { goods: [{ goodsId: 1, price: 50, stock: 0 }], specGoodsId: 1 };
  const radar = { radar: [{ cityId: 10, specGoodsId: 1, rareGoodsId: 0 }, { cityId: 20, specGoodsId: 2, rareGoodsId: 0 },
    { cityId: 30, specGoodsId: 3, rareGoodsId: 0 }] };
  const f = { config, event, state, market, radar, now, visited: [], settings: { estimateDiscountPercent: 10 }, markets: [] };
  f.plan = () => planMerchant(config, event, state, f.market, f.radar, f.now, f.visited,
    { settings: f.settings, markets: f.markets, actionSeconds: f.actionSeconds, preferredPort: f.preferredPort });
  f.batch = (extra = {}) => ({ pid: 1, goodsId: 1, cityId: 10, buyPrice: 50, num: 10, ...extra });
  f.history = (cityId, price, extra = {}) => ({ cityId, observedAt: f.now, period: event.period, startTime: event.startTime,
    goods: [{ goodsId: 1, price, stock: 0 }], ...extra });
  return f;
}
let tests = 0;
const test = (name, fn) => { fn(); tests++; console.log('通过：' + name); };

test('采购门槛按本金回报比较，未确认紧缺的薄利不绕过门槛', () => {
  const f = fixture();
  f.settings.minPurchaseReturnPercent = 5;
  f.market.goods[0].price = 88; // 风险折后预计卖 90，仅赚 2.27%。
  assert.notEqual(f.plan().kind, 'buy');
  f.market.goods[0].price = 85;
  assert.equal(f.plan().kind, 'buy');
  f.radar.radar[1].rareGoodsId = 1;
  f.market.goods[0].price = 88;
  assert.equal(f.plan().mode, 'THIN_MARGIN');
  f.market.goods[0].price = 91;
  assert.notEqual(f.plan().kind, 'buy');
});

test('接力选港只动用可回款的本金，当日无下一程时按本船利润选港', () => {
  const f = fixture();
  f.settings = { knownPortChains:true, estimateDiscountPercent:0 };
  f.radar.radar = [{cityId:10,specGoodsId:1,rareGoodsId:3}, {cityId:20,specGoodsId:2,rareGoodsId:0},
    {cityId:30,specGoodsId:3,rareGoodsId:0}]; // 30 的特产可运回已知紧缺的 10。
  f.market.rareGoodsId = 3;
  f.market.goods.push({goodsId:3,price:380,stock:20});
  f.state.player = {profit:0,coins:0,goods:[f.batch({buyPrice:90})]};
  assert.equal(f.plan().destination,30);
  assert.equal(f.plan().expectedProfit,103, '本船估值不包含接力机会');
  f.settings.knownPortChains = false;
  assert.equal(f.plan().destination,20);
  f.settings.knownPortChains = true;
  f.state.player.goods[0].buyPrice = 100;
  assert.equal(f.plan().destination,30);
  assert.equal(f.plan().exploration,undefined,'可平价回款时才按接力航线出发');
  f.state.player.goods[0].buyPrice = 110;
  assert.equal(f.plan().exploration,true,'亏损且没有现金时不能预支回款');
  f.state.player.goods[0].buyPrice = 90;
  f.now = merchantTiming(f.config,f.event,f.now).tradeEndTime - 3 * 3600;
  assert.equal(f.plan().destination,20);
});

test('默认零折扣按原价差买货，无利可图时仍可空船寻价', () => {
  const f = fixture();
  f.settings = {};
  f.market.goods[0].price = 99;
  const buy = f.plan();
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.purchases[0].expectedPrice, 100);
  assert.equal(buy.expectedProfit, 11);
  f.market.goods[0].price = 100;
  const explore = f.plan();
  assert.equal(explore.kind, 'move');
  assert.equal(explore.exploration, true);
});

test('配置归一化与北京时间交易、刷新边界使用真实配置', () => {
  const f = fixture(), timing = merchantTiming(f.config, f.event, f.now);
  assert.equal(timing.travelSeconds, 7200);
  assert.equal(timing.nextRefreshAt - f.now, 110 * 60);
  assert(timing.tradingOpen);
  assert.equal(merchantTiming(f.config, f.event, Date.UTC(2026, 10, 12, 14) / 1000).tradingOpen, false);
  assert.equal(merchantSettings({ maxLossPercent: 200 }).maxLossPercent, 100);
  assert.equal(merchantSettings({ minExpectedProfit: -1 }).minExpectedProfit, 1);
  assert.equal(merchantSettings({ autoSpeedUp: 'true' }).autoSpeedUp, false);
});

test('每动作余量取配置和真实间隔较大值，非法输入安全回落', () => {
  assert.equal(merchantActionSeconds(), 60);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: 1 } }, 10), 60);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: 180 } }, 300), 300);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: 300 } }, 180), 300);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: -1 } }, NaN), 60);
  assert.equal(merchantActionSeconds({ loop: { everySeconds: '300' } }, Infinity), 60);
  const f = fixture(), before = f.plan();
  for (const value of [undefined, 0, -1, 1, 59, 60, 60.5, NaN, Infinity, '180']) {
    f.actionSeconds = value;
    assert.deepEqual(f.plan(), before);
  }
});

test('收盘前按本港剩余采购次数备货，夜间或次日开市前可自然出航', () => {
  const f = fixture(), close = merchantTiming(f.config, f.event, f.now).tradeEndTime;
  const opening = close + 12 * 3600;
  f.now = close - 30;
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  const buy = f.plan();
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.purchases.length, 1);
  assert.equal(buy.latestActionAt, close);
  f.now = close;
  assert.equal(f.plan().kind, 'wait', '休市期间空船在本港等待重新核价');
  f.state.player.goods = [f.batch()];
  for (const at of [close - 1, close, opening - 3 * 3600, opening - 2 * 3600, opening - 60]) {
    f.now = at;
    const move = f.plan();
    assert.equal(move.kind, 'move');
    assert.equal(move.plannedOpening, opening);
    assert.equal(move.arrival, at + 7200);
    assert.match(move.label, /提前出航/);
  }
});

test('末日按实际开市后的可售批次数选货，活动在开市时结束则留港', () => {
  const f = fixture(), close = merchantTiming(f.config, f.event, f.now).tradeEndTime;
  const opening = close + 12 * 3600;
  f.now = close + 1;
  f.state.player.goods = [f.batch({ num: 9 }), f.batch({ pid: 2, num: 1 })];
  f.event.endTime = opening + 61;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.deepEqual(move.salePids, [1]);
  for (const end of [opening + 60, opening, opening - 1]) {
    f.event.endTime = end;
    assert.equal(f.plan().kind, 'wait');
  }
  f.now = close - 1;
  f.state.player.goods[0].cityId = 20;
  f.market.goods[0].price = 65;
  assert.equal(f.plan().kind, 'sell', '最后一天收盘前仍能按本港实价卖货');
});

test('开市前可空船换港寻价，手动指定的首航时间仍然生效', () => {
  const f = fixture();
  const opening = merchantTiming(f.config, f.event, f.now).tradeStartTime + 86400;
  f.now = opening - 7200;
  f.market.goods[0].price = 120;
  const plan = f.plan();
  assert.equal(plan.exploration, true);
  assert.equal(plan.arrival, opening);
  const apply = settings => merchantStrategyPlan(plan, f.config, f.event, f.state, merchantSettings(settings), f.now);
  assert.equal(apply({}).kind, 'move');
  assert.equal(apply({ firstDepartureMode: 'time', firstDepartureTime: '10:00' }).nextCheckAt, opening);
});

test('夜间抵港也按开市后的行情估算，不能把昨晚的紧缺高价当作次日卖价', () => {
  const f = fixture();
  f.now = merchantTiming(f.config, f.event, f.now).tradeEndTime - 3600;
  f.state.player.goods = [f.batch()];
  f.settings = { quoteMaxAgeSeconds: 86400 };
  f.radar.radar[1].rareGoodsId = 1;
  f.markets = [f.history(20, 400)];
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.destination, 20);
  assert.equal(move.expectedProfit, null, '开市价格随机，出航不预报整船利润');
});

test('首日按可购特产和同盟在途船选港，条件相同或赶不上开市时留港', () => {
  const f = fixture(), opening = merchantTiming(f.config, f.event, f.now).tradeStartTime;
  f.event.startTime = opening - 10 * 3600;
  f.now = f.event.startTime;
  assert.equal(f.plan().kind, 'wait', '本港与外港都能承接同样的本金');
  const actor = { playerId: '999', guildId: '1001' };
  const voyage = (id, target, end, guildIdx = 1) => ({ playerId: id, guildIdx, cargo: {
    cityId: 90, moveToCityId: target, moveStartTime: f.now, moveEndTime: end } });
  const ship = voyage('123', 10, opening);
  f.state.worldCargo = [ship, ship, voyage('124', 20, opening + 1), voyage('125', 20, opening, 2), voyage('999', 20, opening)];
  f.radar = merchantOpeningRadar(f.radar, f.state, actor, f.now, opening);
  assert.deepEqual(f.radar.radar.map(p => p.openingShips ?? 0), [1, 0, 0]);
  const plan = f.plan();
  assert.deepEqual([plan.kind, plan.mode, plan.destination, plan.plannedOpening, plan.expectedProfit],
    ['move', 'FIRST_OPENING', 20, opening, null]);
  f.now = opening - 7200;
  assert.equal(f.plan().arrival, opening);
  f.now++;
  assert.deepEqual([f.plan().kind, f.plan().nextCheckAt], ['wait', opening]);
  f.now = f.event.startTime;
  f.state.player.coins = 100;
  assert.equal(f.plan().kind, 'wait', '不会放弃本港可负担的特产，去追本金不够的货');
  f.event.startTime++;
  assert.equal(f.plan().kind, 'wait', '活动尚未开始');
});

test('隔夜销港先避开投入本金最多的特产，条件相同选可见同盟船少的港', () => {
  const f = fixture();
  f.now = merchantTiming(f.config, f.event, f.now).tradeEndTime - 1800;
  f.state.player.coins = 0;
  f.state.player.goods = [f.batch({ num: 2, buyPrice: 500 }), f.batch({ pid: 2, goodsId: 2, num: 8, buyPrice: 10 })];
  f.radar.radar = [{ cityId: 20, specGoodsId: 1 }, { cityId: 30, specGoodsId: 2, openingShips: 2 }];
  const p = f.plan();
  assert.equal(p.destination, 30);
  assert.match(p.priceNote, /进货成本 1080 商会币，相当于基准货值的 60%/);
  f.radar.radar.push({ cityId: 40, specGoodsId: 2 });
  assert.equal(f.plan().destination, 40);
  f.radar.radar.push({ cityId: 15 }, { cityId: 50, specGoodsId: 3 });
  assert.equal(f.plan().destination, 50, '已知无同种特产优先于情报空白');
});

test('同价同舱位的隔夜货可分装两种，逐笔重算后装满且守住收盘期限', () => {
  const f = fixture(), close = merchantTiming(f.config, f.event, f.now).tradeEndTime;
  f.now = close - 600;
  f.config.tables.TradeGoodsCfg.data[1].unitPrice = 100;
  f.market.goods = [{ goodsId: 1, price: 75, stock: 0 }, { goodsId: 2, price: 75, stock: 0 }];
  const initial = f.plan();
  assert.deepEqual(initial.purchases.map(p => [p.goodsId, p.count]), [[1, 5], [2, 5]]);
  assert.equal(initial.destination, 30);
  f.state.player.coins -= 375;
  f.state.player.goods = [f.batch({ num: 5, buyPrice: 75 })];
  const next = f.plan();
  assert.deepEqual(next.purchases.map(p => [p.goodsId, p.count]), [[2, 5]]);
  f.state.player.goods = [];
  f.state.player.coins = 1000;
  f.now = close - 1;
  assert.deepEqual(f.plan().purchases.map(p => p.count), [10], '收盘前仅余一笔时优先满舱');
  f.radar.radar = [{ cityId: 20, specGoodsId: 1 }];
  assert.deepEqual(f.plan().purchases.map(p => [p.goodsId, p.count]), [[2, 10]], '同等折扣时买能避开目的港特产的货');
});

test('隔夜优先买满，允许原价和溢价补舱，按资金与库存决定实际装载量', () => {
  const f = fixture();
  f.now = merchantTiming(f.config, f.event, f.now).tradeEndTime - 1800;
  f.settings = { fullCargoRoutes: true, minExpectedProfit: 999999, estimateDiscountPercent: 100 };
  f.radar.radar[1].rareGoodsId = 0;
  f.market.rareGoodsId = 3;
  f.market.goods = [{ goodsId: 1, price: 105, stock: 14 }, { goodsId: 2, price: 200, stock: 16 },
    { goodsId: 3, price: 1, stock: 0 }];
  f.state.player.coins = 2000;
  const buy = f.plan();
  assert.equal(buy.mode, 'OVERNIGHT');
  assert.deepEqual(buy.purchases.map(p => [p.goodsId, p.count]).sort(), [[1, 6], [2, 4]]);
  assert.equal(buy.expectedProfit, null);
  f.state.player.coins = 315;
  const partial = f.plan();
  assert.deepEqual([partial.goodsId, partial.count], [1, 3], '本金不足时尽量装满可负担的格数');
  f.state.player.goods = [f.batch({ num: 3, buyPrice: 105 })];
  f.state.player.coins = 0;
  assert.equal(f.plan().kind, 'move');
  f.radar.radar = [{ cityId: 20 }];
  f.state.player.goods[0].cityId = 20;
  assert.equal(f.plan().kind, 'wait', '目的港必须能卖整船，不能把货运回来源港');
});

test('新预设隔夜按本金和舱位挑选折价货，达不到门槛留港', () => {
  const f = fixture();
  f.now = merchantTiming(f.config, f.event, f.now).tradeEndTime - 1800;
  f.settings.minPurchaseReturnPercent = 5;
  f.state.player.coins = 190;
  f.market.goods = [{ goodsId: 1, price: 90, stock: 0 }, { goodsId: 2, price: 158, stock: 0 }];
  const buy = f.plan();
  assert.deepEqual([buy.mode, buy.goodsId, buy.count, buy.expectedProfit], ['OVERNIGHT', 2, 1, null]);
  f.market.goods = [{ goodsId: 1, price: 96, stock: 0 }];
  const wait = f.plan();
  assert.equal(wait.kind, 'wait');
  assert(wait.nextCheckAt > f.now);
});

test('收盘前到达紧缺港先按实价卖出异地货，回款后再备隔夜货', () => {
  const f = fixture(), close = merchantTiming(f.config, f.event, f.now).tradeEndTime;
  f.now = close - 1800;
  f.settings.minPurchaseReturnPercent = 5;
  f.state.cargo.cityId = 20;
  f.radar.radar[1].rareGoodsId = 1;
  f.market = { specGoodsId: 2, rareGoodsId: 1, goods: [{ goodsId: 1, price: 115, stock: 0 }, { goodsId: 2, price: 170, stock: 0 }] };
  f.state.player = { profit: 0, coins: 0, goods: [f.batch({ buyPrice: 87 })] };
  const sale = f.plan();
  assert.deepEqual([sale.kind, sale.mode, sale.pid, sale.price, sale.gain], ['sell', 'TRADE', 1, 115, 289],
    '紧缺溢价当天有效，不能原样带去隔夜');
  f.state.player = { profit: 289, coins: 1159, goods: [] };
  const buy = f.plan();
  assert.deepEqual([buy.kind, buy.mode, buy.goodsId, buy.count], ['buy', 'OVERNIGHT', 2, 6]);
  f.state.player = { profit: 0, coins: 0, goods: [f.batch({ buyPrice: 120 })] };
  const loss = f.plan();
  assert.deepEqual([loss.kind, loss.mode, loss.destination], ['move', 'OVERNIGHT', 30], '本港卖不出利润的货仍随船隔夜');
  f.state.player.goods = [f.batch({ buyPrice: 87 })];
  f.now = close + 60;
  const closed = f.plan();
  assert.deepEqual([closed.kind, closed.mode], ['move', 'OVERNIGHT'], '休市后无法成交，按原隔夜流程出航');
});

test('收盘前来不及自然跑完一程时，核对针数后改跑当天成交的加速航次，末日仍按基准价保守估价', () => {
  const f = fixture(), close = merchantTiming(f.config, f.event, f.now).tradeEndTime;
  f.config.tables.ActivityTradeCfg.data.push({ key: '海商王加速时长', value: '30' });
  f.settings = merchantSettings({ estimateDiscountPercent: 10, autoSpeedUp: true, speedUpMode: 'goal', liquidationMinutes: 0 });
  f.market.goods[0].price = 95;
  f.radar.radar[1].rareGoodsId = 1;
  const pointer = '海商王加速';
  const at = time => {
    f.now = time;
    // 30 号港本轮的紧缺报价高出基准价 15%，同档紧缺货据此估价 103。
    f.markets = [f.history(30, 115, { specGoodsId: 3, rareGoodsId: 1 })];
  };
  const route = (pins, used = 0) => merchantClosingRoute(f.config, f.event, f.state, f.market, f.radar, f.radar, f.now, [],
    { settings: f.settings, markets: f.markets, actionSeconds: 60 },
    pins === null ? null : { stock: new Map([[pointer, pins]]), dailyUsed: used, periodRemaining: pins });
  at(close - 5400); // 20:30。
  assert.deepEqual([f.plan().kind, f.plan().mode], ['buy', 'OVERNIGHT'], '自然航行赶不上收盘，原计划是隔夜备货');
  const buy = route(4);
  // 一根 22:00 才到，退成次日备货；两根 21:30 到港，当天按紧缺价成交。
  assert.deepEqual([buy.kind, buy.mode, buy.goodsId, buy.count, buy.destination, buy.accelerationRequired], ['buy', 'TRADE', 1, 10, 20, 2]);
  assert.equal(buy.purchases[0].expectedPrice, 103);
  assert.match(buy.label, /收盘前加速航次已核对 2 根库存指南针/);
  assert.equal(route(1), null, '一根赶不上当天成交，不改原计划');
  assert.equal(route(null), null, '额度或库存未确认时不改原计划');
  assert.equal(route(4, 28), null, '每日额度用完');
  f.state.player = { profit: 0, coins: 50, goods: [f.batch({ buyPrice: 95 })] };
  const move = route(4);
  assert.deepEqual([move.kind, move.destination, move.accelerationRequired, move.plannedOpening], ['move', 20, 2, undefined]);
  at(close - 200); // 21:56:40，四根立即到港能卖，但留不出备隔夜货的时间。
  assert.equal(route(4), null, '到港后来不及备隔夜货就不改原计划');
  at(close - 5400);
  f.state.player = { profit: 0, coins: 1000, goods: [] };
  f.event.endTime = close; // 末日收尾，货过期作废。
  assert.equal(route(4), null, '末日卖价封顶到基准价的九折 90，买价 95 不采购');
  f.market.goods[0].price = 85;
  const final = route(4);
  assert.deepEqual([final.kind, final.accelerationRequired, final.purchases[0].expectedPrice], ['buy', 2, 90]);
  assert.match(final.label, /收尾航线已核对 2 根库存指南针/);
});

test('亏损清舱只认最近隔夜航程出发时的原批次，其他船货仍按普通规则', () => {
  const f = fixture(), opening = merchantTiming(f.config, f.event, f.now).tradeStartTime;
  const original = f.batch({ num: 4 });
  const started = opening - 7200;
  const leg = { expected: { plannedOpening: opening, destination: 20 },
    before: { goods: [original, f.batch({ pid: 2 })] }, after: { cargo: { moveStartTime: started } } };
  Object.assign(f.state.cargo, { cityId: 20, moveStartTime: started });
  f.state.player.goods = [f.batch({ pid: 2, buyPrice: 40, num: 1 }), { ...original, num: 2 },
    f.batch({ pid: 3, cityId: 20, num: 1 })];
  f.market.goods[0].price = 15;
  const pids = merchantOpeningCargo(leg, f.state);
  assert.deepEqual(pids, [1]);
  const sale = planMerchant(f.config, f.event, f.state, f.market, f.radar, f.now, [],
    { openingCargoPids: pids, plannedOpening: opening });
  assert.deepEqual([sale.mode, sale.pid, sale.count, sale.gain], ['OPENING_SALE', 1, 2, -70]);
  f.state.player.goods.splice(1, 1);
  assert.deepEqual(merchantOpeningCargo(leg, f.state), []);
  assert.notEqual(f.plan().kind, 'sell');
  f.state.player.goods = [original];
  f.state.cargo.moveStartTime++;
  assert.deepEqual(merchantOpeningCargo(leg, f.state), [], '手动换过航程不能套用之前的清舱规则');
});

test('长轮询间隔按实际操作预算阻止截止前无法完成的采购', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7200 + 500;
  assert.equal(f.plan().kind, 'buy');
  f.actionSeconds = 180;
  assert.notEqual(f.plan().kind, 'buy');
  f.actionSeconds = 300;
  assert.notEqual(f.plan().kind, 'buy');
});

test('长轮询间隔按可售批次数约束出航和最新发送时间', () => {
  const f = fixture();
  f.state.player.goods = [f.batch()];
  f.event.endTime = f.now + 7200 + 200;
  f.settings.liquidationMinutes = 0;
  f.actionSeconds = 180;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.latestActionAt, f.event.endTime - 7200 - 180);
  f.actionSeconds = 300;
  assert.equal(f.plan().kind, 'wait');
});

test('刷新等待与空船寻价也按长轮询间隔计算完整后续动作', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 5, 59) / 1000;
  f.event.endTime = f.now + 7200 + 500;
  f.settings.liquidationMinutes = 0;
  f.market.goods[0].stock = 20;
  assert.equal(f.plan().mode, 'WAIT_REFRESH');
  f.actionSeconds = 180;
  assert.notEqual(f.plan().mode, 'WAIT_REFRESH');
  f.event.endTime = f.now + 14400 + 900;
  f.settings.refreshWaitSeconds = 0;
  f.market.goods[0].price = 100;
  const explore = f.plan();
  assert.equal(explore.exploration, true);
  assert.equal(explore.latestActionAt, f.event.endTime - 14400 - 4 * 180);
  f.actionSeconds = 300;
  assert.equal(f.plan().kind, 'wait');
});

test('组合采购截止对多笔操作逐一计入长轮询间隔', () => {
  const f = fixture();
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  f.actionSeconds = 300;
  const plan = f.plan(), timing = merchantTiming(f.config, f.event, f.now);
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.purchases.length, 2);
  assert.equal(plan.latestActionAt, timing.tradeEndTime - 7200 - 1500);
});

test('没有联盟紧缺共享也能按风险折扣估算先选港再买入', () => {
  const f = fixture(), plan = f.plan();
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.destination, 20);
  assert.equal(plan.count, 10);
  assert.equal(plan.expectedProfit, 412);
  assert.equal(plan.estimated, true);
  assert.match(plan.label, /卖价已扣 10% 风险折扣/);
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 500;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.destination, 20);
});

test('紧缺未共享时用目的港同货历史和基准价估值，忽略同档溢价与过期紧缺身份', () => {
  const f = fixture();
  Object.assign(f.market, { specGoodsId: 4, rareGoodsId: 5 });
  f.market.goods = [70, 140, 150].map((price, i) => ({ goodsId: i + 1, price, stock: i ? 20 : 0 }));
  f.config.tables.TradeGoodsCfg.data.forEach(def => { def.unitPrice = 100; });
  f.radar.radar = [{ cityId: 20, specGoodsId: 4, rareGoodsId: 0 }];
  const offer = () => f.plan().purchases[0];
  assert.equal(offer().referencePrice, 100);
  const ordinary = f.history(20, 90, { observedAt: f.now - 7200, specGoodsId: 4, rareGoodsId: 5 });
  f.markets = [ordinary, { ...ordinary, observedAt: ordinary.observedAt - 1 },
    { ...ordinary, observedAt: f.now - 14400, rareGoodsId: 1, goods: [{ goodsId: 1, price: 160 }] },
    { ...ordinary, observedAt: f.now + 10, goods: [{ goodsId: 1, price: 180 }] }];
  assert.deepEqual([offer().referencePrice, offer().expectedPrice], [95, 85]);
  assert.match(offer().priceSource, /紧缺未确认.*1轮同商品普通报价/);
  f.radar.radar[0].rareGoodsId = 5;
  assert.equal(offer().referencePrice, 117, '确认是普通货后结合本港同货记录与同档参考价');
  f.markets = [];
  assert.equal(offer().referencePrice, 145, '没有本港记录时使用同档普通货参考价');
});

test('可用小单解锁下一级时先卖小单，留大单按新船级的实价结算', () => {
  const f = fixture();
  f.config.tables.TradeShipCfg.data[0].capacity = 1000;
  f.config.tables.TradeShipCfg.data.push({ lv: 2, capacity: 3000, profitMargin: 600, upMoney: 10000, upCost: ['RUBY', 300] });
  Object.assign(f.state.player, { profit: 9000, coins: 0, goods: [f.batch({ num: 100 }), f.batch({ pid: 2, num: 10 })] });
  f.state.cargo.cityId = 20;
  f.radar.radar = [{ cityId: 20 }];
  f.market.goods = [{ goodsId: 1, price: 150, stock: 20 }];
  assert.equal(f.plan().pid, 1);
  f.settings.autoUpgrade = true;
  f.settings.profitLimit = 12000;
  assert.equal(f.plan().pid, 1, '大单可直接到活动停止线');
  f.settings.profitLimit = 0;
  const regularTime = f.now;
  f.now = merchantTiming(f.config, f.event, f.now).nextRefreshAt - 60;
  assert.equal(f.plan().pid, 1, '报价即将刷新，优先兑现最大利润');
  f.now = regularTime;
  f.state.player.profit = 8000;
  assert.equal(f.plan().pid, 1, '小单还不能解锁');
  f.state.player.profit = 9000;
  const small = f.plan();
  assert.deepEqual([small.kind, small.pid, small.gain], ['sell', 2, 1030]);
  assert.match(small.label, /解锁 2 级船/);
  f.state.player.goods.pop();
  f.state.player.profit += small.gain;
  f.state.cargo.cargoLv = 2;
  assert.equal(f.plan().gain, 10600);
});

test('薄利补一件淡水时，提示分清每格价差、本批收益和整船收益', () => {
  const f = fixture();
  Object.assign(f.config.tables.TradeShipCfg.data[0], { capacity: 2, profitMargin: 0 });
  const defs = f.config.tables.TradeGoodsCfg.data;
  Object.assign(defs[0], { itemName: '淡水', unitPrice: 50 });
  defs[1].unitPrice = 5200;
  defs.push(...[5, 6].map(goodsId => ({ ...defs[0], goodsId })));
  f.market.rareGoodsId = 4;
  f.market.goods.push(...[5, 6].map(goodsId => ({ goodsId, price: 52, stock: 20 })));
  f.state.player.coins = 50;
  f.state.player.goods = [f.batch({ goodsId: 2, num: 1, buyPrice: 9 })];
  f.radar.radar = [{ cityId: 70, specGoodsId: 3, rareGoodsId: 4 }];
  const plan = f.plan();
  assert.equal(plan.discountedProfit, 4671, '薄利补货不能把旧货的参考收益计入折后可售收益');
  assert.equal(plan.label, '买入淡水 ×1，单价 50，70 号港预计卖价 52。每格价差 2 商会币，整船预计净收益 5,193 商会币（未扣风险折扣）');
  assert.deepEqual(Object.fromEntries(plan.purchaseDetails), {
    '本批预计净收益': '2 商会币', '本批占舱': '1 格', '本港买价': '与基准价持平', '卖价依据': '同档普通货涨跌幅中位数（较基准价高 4%）'
  });
});

test('单位容量收益与组合采购取代单商品跌幅优先', () => {
  const f = fixture();
  f.config.tables.TradeGoodsCfg.data[0].capacity = 6;
  f.config.tables.TradeGoodsCfg.data[1].capacity = 5;
  f.config.tables.TradeGoodsCfg.data[1].unitPrice = 100;
  f.market.goods = [{ goodsId: 1, price: 40, stock: 19 }, { goodsId: 2, price: 45, stock: 18 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.goodsId, 2);
  assert.equal(plan.count, 2);
  assert.equal(plan.expectedProfit, 93);
});

test('本港紧缺货从采购组合剔除，普通货仍可采购，外港带来的紧缺货仍可出售', () => {
  const f = fixture();
  f.market.specGoodsId = 3;
  f.radar.radar[0].specGoodsId = 3;
  for (const source of [f.market, f.radar.radar[0]]) {
    source.rareGoodsId = 1;
    for (const price of [50, 95]) {
      f.market.goods[0].price = price;
      assert.notEqual(f.plan().kind, 'buy', '折后和参考价方案均跳过本港紧缺货');
    }
    f.market.goods.push({ goodsId: 2, price: 170, stock: 0 });
    assert.deepEqual(f.plan().purchases.map(item => item.goodsId), [2]);
    f.market.goods.pop();
    source.rareGoodsId = 0;
  }
  f.market.rareGoodsId = 1;
  f.market.goods[0].price = 130;
  f.state.player.goods = [f.batch({ cityId: 20 })];
  const sale = f.plan();
  assert.deepEqual([sale.kind, sale.goodsId, sale.price], ['sell', 1, 130]);
});

test('采购估值相同优先运往共享紧缺港，实价估算更差时不追紧缺', () => {
  const f = fixture();
  f.radar.radar.find(row => row.cityId === 30).rareGoodsId = 1;
  assert.equal(f.plan().destination, 30);
  f.markets = [f.history(30, 55)];
  assert.equal(f.plan().destination, 20);
});

test('仅有薄利时首趟按设置等待，随后买货出航，到港按实价卖出', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 2) / 1000;
  f.settings.firstDepartureWaitMinutes = 10;
  const next = () => merchantStrategyPlan(f.plan(), f.config, f.event, f.state, merchantSettings(f.settings), f.now);
  f.market.goods[0].price = 95;
  f.radar.radar = [{ cityId: 20, specGoodsId: 2 }];
  assert.equal(next().kind, 'wait');
  f.now += 600;
  const buy = next();
  assert.equal(buy.mode, 'THIN_MARGIN');
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.count, 10);
  assert.equal(buy.expectedProfit, 52);
  assert.equal(buy.discountedProfit, 0);
  f.state.player.coins -= buy.price * buy.count;
  f.state.player.goods = [f.batch({ buyPrice: buy.price, num: buy.count })];
  const move = next();
  assert.equal(move.kind, 'move');
  assert.equal(move.destination, buy.destination);
  assert.equal(move.expectedProfit, buy.expectedProfit);
  assert.equal(move.discountedProfit, 0);
  f.state.cargo.cityId = move.destination;
  f.now = move.arrival;
  f.market.goods[0].price = 94;
  assert.notEqual(next().kind, 'sell');
  f.market.goods[0].price = 96;
  assert.equal(next().gain, 11);
});

test('有稳妥航线只补同港正收益货物，原批次的出售时间优先', () => {
  const f = fixture();
  f.radar.radar = [{ cityId: 20, specGoodsId: 3 }, { cityId: 30, specGoodsId: 1 }];
  f.state.player.goods = [f.batch({ num: 3 })];
  f.market.goods = [{ goodsId: 2, price: 190, stock: 16 }];
  const buy = f.plan();
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.mode, 'THIN_MARGIN');
  assert.equal(buy.destination, 20);
  assert.equal(buy.count, 4);
  const late = f.event.endTime;
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7200 + 181;
  assert.equal(f.plan().kind, 'move', '剩余三轮不足以采购、出航并卖出两个批次');
  f.event.endTime = late;
  f.state.player.goods.push(f.batch({ pid: 2, goodsId: 2, buyPrice: 190, num: 4 }));
  f.state.player.coins -= buy.price * buy.count;
  f.market.goods[0].stock += buy.count;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.destination, 20);
  assert.deepEqual(move.salePids, [1, 2]);
});

test('共享紧缺港参考同基准价紧缺货实价，空船先采购，装货后按同一估价选港', () => {
  const f = fixture();
  f.config.tables.TradeGoodsCfg.data[0].unitPrice = 50;
  f.config.tables.TradeGoodsCfg.data[1].unitPrice = 50;
  f.market.rareGoodsId = 2;
  f.market.goods = [{ goodsId: 1, price: 48, stock: 0 }, { goodsId: 2, price: 56, stock: 0 }];
  const target = f.radar.radar.find(port => port.cityId === 30);
  target.rareGoodsId = 1;
  const buy = f.plan();
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.goodsId, 1);
  assert.equal(buy.destination, 30);
  assert.equal(buy.purchases[0].expectedPrice, 50);
  assert.equal(buy.expectedProfit, 21);
  assert.match(Object.fromEntries(buy.purchaseDetails)['卖价依据'], /紧缺/);

  f.state.player.goods = [f.batch({ buyPrice: 48 })];
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(move.destination, 30);
  assert.equal(move.expectedProfit, buy.expectedProfit);
  f.state.player.goods = [];
  f.radar.radar = [target];
  f.markets = [f.history(30, 46)];
  assert.notEqual(f.plan().kind, 'buy', '目的港已见的低价优先于其他港紧缺样本');
  f.markets = [];
  f.settings.minExpectedProfit = 84;
  assert.notEqual(f.plan().kind, 'buy');
  f.settings.minExpectedProfit = 1;
  target.rareGoodsId = 0;
  assert.equal(f.plan().purchases[0].expectedPrice, 50);
  assert.equal(f.plan().mode, 'THIN_MARGIN');
  target.rareGoodsId = 1;
  f.config.tables.TradeGoodsCfg.data[1].unitPrice = 200;
  f.market.goods[1].stock = 20;
  assert.equal(f.plan().purchases[0].expectedPrice, 50, '不同基准价的货物不可用作紧缺参考价');
});

test('可比紧缺报价取有效港口样本的最低价，过期后恢复普通估价', () => {
  const f = fixture();
  f.market.goods[0].price = 100;
  f.radar.radar.find(port => port.cityId === 30).rareGoodsId = 1;
  f.radar.radar.push({ cityId: 40, specGoodsId: 3, rareGoodsId: 1 });
  f.markets = [f.history(20, 130, { rareGoodsId: 1 }), f.history(40, 120, { rareGoodsId: 1 })];
  const buy = f.plan();
  assert.equal(buy.kind, 'buy');
  assert.equal(buy.purchases[0].expectedPrice, 108);
  for (const snapshot of f.markets) snapshot.observedAt -= 301;
  assert.equal(f.plan().exploration, true);
});

test('缺少同档紧缺报价时，采购和出航用不同港口或轮次的跨档实价选销港', () => {
  const f = fixture();
  f.now += 6 * 3600;
  f.config.tables.TradeGoodsCfg.data = [120, 50, 800, 120, 120].map((unitPrice, i) => ({
    goodsId: i + 1, itemName: ['长绳', '粗铁', '鱼子酱', '鱼油', '墙纸'][i],
    unitPrice, qualityIndex: [2, 1, 4, 2, 2][i], capacity: 1, maxCount: 20
  }));
  f.market = { specGoodsId: 1, rareGoodsId: 2, goods: [
    { goodsId: 1, price: 106, stock: 0 }, { goodsId: 4, price: 128, stock: 20 }, { goodsId: 5, price: 128, stock: 20 }
  ] };
  f.radar.radar[1].rareGoodsId = 3; // 长绳在 20 号港是普通货，在 30 号港紧缺。
  f.radar.radar[2].rareGoodsId = 1;
  const sample = (goodsId, price, hoursAgo) => f.history(20, price, { observedAt: f.now - hoursAgo * 3600,
    specGoodsId: 5, rareGoodsId: goodsId, goods: [{ goodsId, price, stock: 0 }] });
  const first = sample(2, 55, 2), second = sample(3, 960, 4);
  f.markets = [first, { ...first, observedAt: first.observedAt + 5 }, { ...second, period: f.event.period + 1 },
    { ...second, observedAt: f.now + 7200 }, { ...second, rareGoodsId: 0, cityId: 30 }];
  assert.equal(f.plan().destination, 20, '同轮重复、未来、异期和未确认紧缺的报价都不能凑足两个样本');

  f.markets.push(second);
  const buy = f.plan();
  assert.deepEqual([buy.kind, buy.destination, buy.purchases[0].referencePrice, buy.purchases[0].expectedPrice], ['buy', 30, 132, 118]);
  const speedQuote = () => merchantSpeedSalePrices(f.config, f.event, f.radar, f.markets, f.now, 10, 30,
    { quoteMaxAgeSeconds: 300, estimateDiscountPercent: 10 });
  assert.deepEqual(speedQuote(), { goodsId: 1, price: 118 });
  assert.match(buy.purchases[0].priceSource, /跨档紧缺货最低涨跌幅/);
  f.state.player.goods = [f.batch({ buyPrice: 106, num: buy.count })];
  f.state.player.coins -= buy.count * buy.price;
  const move = f.plan();
  assert.deepEqual([move.kind, move.destination], ['move', 30]);

  f.state.player.goods = [];
  f.state.player.coins = 1000;
  f.markets.push(sample(4, 144, 6));
  assert.equal(f.plan().purchases[0].referencePrice, 144, '历史同档紧缺实价优先于跨档样本');
  f.market.rareGoodsId = 4;
  f.market.goods[1].price = 138;
  assert.equal(f.plan().purchases[0].referencePrice, 138, '本轮同档紧缺实价优先于历史');
  f.markets.push(f.history(30, 110));
  assert.deepEqual(speedQuote(), { goodsId: 1, price: 99 });
  assert.equal(f.plan().destination, 20, '目的港已见低价仍限制紧缺估值');
});

test('同一笔本金和十格舱位，目的港可比涨跌幅改变时在高低品质之间换货', () => {
  const f = fixture();
  f.settings = {};
  f.config.tables.TradeGoodsCfg.data = [
    { goodsId: 1, itemName: '维生素补剂', qualityIndex: 4, unitPrice: 800, capacity: 10, maxCount: 20 },
    { goodsId: 2, itemName: '生鱼片', qualityIndex: 1, unitPrice: 50, capacity: 1, maxCount: 20 },
    ...[3, 4, 5].map(goodsId => ({ goodsId, itemName: '参考商品', qualityIndex: 4, unitPrice: 800, capacity: 10, maxCount: 20 }))
  ];
  f.market.specGoodsId = 1;
  f.market.rareGoodsId = 5;
  f.market.goods = [640, 45, 640, 704, 1600].map((price, i) => ({ goodsId: i + 1, price, stock: i < 2 ? 0 : 20 }));
  f.radar.radar = [{ cityId: 20, specGoodsId: 4, rareGoodsId: 5 }];
  const low = f.plan();
  assert.deepEqual([low.goodsId, low.count, low.expectedProfit], [2, 10, 52]);
  f.market.goods[2].price = 880;
  f.market.goods[3].price = 960;
  const high = f.plan();
  assert.deepEqual([high.goodsId, high.count, high.purchases[0].expectedPrice, high.expectedProfit], [1, 1, 920, 289]);
  const details = Object.fromEntries(high.purchaseDetails);
  assert.equal(details['本港买价'], '较基准价低 20%');
  assert.equal(details['卖价依据'], '同档普通货涨跌幅中位数（较基准价高 15%）');
  f.state.player.goods = [f.batch({ num: 1, buyPrice: 640 })];
  const move = f.plan();
  assert.deepEqual([move.kind, move.expectedProfit], ['move', high.expectedProfit]);
  assert.match(move.priceNote, /预计卖价 920/);
});

test('同品质按各自基准价换算，排除自己的买价，风险折扣只计一次', () => {
  const f = fixture();
  for (const def of f.config.tables.TradeGoodsCfg.data) def.qualityIndex = 1;
  Object.assign(f.market, { specGoodsId: 10, rareGoodsId: 11, goods: [
    { goodsId: 1, price: 70, stock: 0 }, { goodsId: 2, price: 188, stock: 20 }, { goodsId: 3, price: 294, stock: 20 }
  ] });
  f.radar.radar = [{ cityId: 20, specGoodsId: 10, rareGoodsId: 11 }];
  const buy = () => f.plan().purchases[0];
  assert.deepEqual([buy().referencePrice, buy().expectedPrice], [96, 86]);
  f.market.goods.pop();
  assert.equal(buy().referencePrice, 100, '本港所买商品不能给自身凑足两个样本');
  f.market.goods.push({ goodsId: 3, price: 294, stock: 20 });
  delete f.market.rareGoodsId;
  assert.equal(buy().referencePrice, 100, '未分清紧缺的报价不能作为普通货样本');
  f.market.rareGoodsId = 11;
  f.config.tables.ActivityTradeCfg.data[1].value = '1';
  f.markets = [f.history(20, 120)];
  assert.equal(buy().expectedPrice, 108, '到港时仍有效的同港同货报价优先');
  f.now = Date.UTC(2026, 10, 12, 5, 59, 30) / 1000;
  f.markets = [f.history(20, 120)];
  assert.equal(buy().expectedPrice, 86, '到港跨刷新，用可比波动估算，不延用高报价');
});

test('按目的港不同刷新轮次估算，同轮重复、异期、未来和不同紧缺状态均不混入', () => {
  const f = fixture();
  f.now += 4 * 3600;
  f.settings = {};
  f.radar.radar = [{ cityId: 20, specGoodsId: 2, rareGoodsId: 3 }, { cityId: 30, specGoodsId: 3, rareGoodsId: 2 }];
  f.market.goods[0].price = 95;
  const sample = (price, hours, extra) => f.history(30, price, { observedAt: f.now - hours * 3600, specGoodsId: 3, rareGoodsId: 2, ...extra });
  f.markets = [sample(20, 4.1), sample(90, 4), sample(130, 2), sample(200, 6, { rareGoodsId: 1 }),
    sample(300, 8, { period: 1000 }), sample(400, -2)];
  const plan = f.plan();
  assert.deepEqual([plan.destination, plan.purchases[0].expectedPrice, plan.expectedProfit], [30, 110, 155]);
  assert.match(Object.fromEntries(plan.purchaseDetails)['卖价依据'], /目的港2轮同商品普通报价中位数/);
  f.markets.splice(2, 1);
  assert.equal(f.plan().purchases[0].expectedPrice, 100);
});

function lateMarket() {
  const f = fixture();
  f.config.tables.TradeShipCfg.data.push({ lv: 5, capacity: 100, profitMargin: 1500 });
  f.state.cargo.cargoLv = 5;
  f.state.player.coins = 5_000_000;
  f.settings.estimateDiscountPercent = 0;
  f.radar.radar = [{ cityId: 20, specGoodsId: 99 }];
  f.config.tables.TradeGoodsCfg.data = [
    { goodsId: 1, itemName: '橙特产', qualityIndex: 4, unitPrice: 800, capacity: 10, maxCount: 1 },
    { goodsId: 2, itemName: '橙货', qualityIndex: 4, unitPrice: 800, capacity: 10, maxCount: 1 },
    { goodsId: 3, itemName: '紫货', qualityIndex: 3, unitPrice: 280, capacity: 4, maxCount: 20 }
  ];
  f.market.goods = [{ goodsId: 1, price: 691, stock: 0 }, { goodsId: 2, price: 740, stock: 0 }, { goodsId: 3, price: 257, stock: 0 }];
  return f;
}

test('本金受限时紫货更赚，舱位受限时同一组报价改买橙货', () => {
  const f = lateMarket();
  f.market.goods.shift();
  f.config.tables.TradeGoodsCfg.data[1].maxCount = 2;
  f.config.tables.TradeShipCfg.data.at(-1).capacity = 20;
  f.state.player.coins = 1030;
  const cashLimited = f.plan();
  assert.deepEqual(cashLimited.purchases.map(p => [p.goodsId, p.count]), [[3, 4]]);
  assert.equal(cashLimited.expectedProfit, 106);
  assert.equal(Object.fromEntries(cashLimited.purchaseDetails)['本批占舱'], '16 格（每件 4 格）');
  for (const coins of [4_999_999, 5_000_000, 5_000_001]) {
    f.state.player.coins = coins;
    const spaceLimited = f.plan();
    assert.deepEqual(spaceLimited.purchases.map(p => [p.goodsId, p.count]), [[2, 2]]);
    assert.equal(spaceLimited.expectedProfit, 138);
  }
});

test('逐笔扣除已占舱位和联盟已购库存，剩余14格可装一橙一紫', () => {
  const f = lateMarket();
  f.config.tables.TradeShipCfg.data.at(-1).capacity = 24;
  f.state.player.goods = [f.batch({ goodsId: 1, num: 1, buyPrice: 691 })];
  f.market.goods[0].stock = 1;
  f.market.goods[2].stock = 19;
  const mixed = f.plan();
  assert.deepEqual(mixed.purchases.map(p => [p.goodsId, p.count]), [[2, 1], [3, 1]]);
  assert.equal(mixed.expectedProfit, 126 + 69 + 27);
  f.state.player.goods.push(f.batch({ pid: 2, goodsId: 2, num: 1, buyPrice: 740 }));
  f.market.goods[1].stock++;
  const last = f.plan();
  assert.equal(last.goodsId, 3);
  assert.equal(last.count, 1);
  f.market.goods[2].stock++;
  assert.equal(f.plan().kind, 'move');
});

test('500万本金的大额组合至少达到按本金收益装货的可行利润', () => {
  const f = lateMarket();
  f.config.tables.TradeShipCfg.data.at(-1).capacity = 81_000;
  const defs = f.config.tables.TradeGoodsCfg.data;
  [7000, 7000, 15000].forEach((max, i) => { defs[i].maxCount = max; });
  f.market.goods[0].stock = 7000 - 5457;
  defs.push({ goodsId: 4, itemName: '木板', qualityIndex: 1, unitPrice: 50, capacity: 1, maxCount: 60000 });
  f.market.goods.push({ goodsId: 4, price: 46, stock: 0 });
  const plan = f.plan();
  assert(plan.expectedProfit >= 810542);
  assert(plan.purchases.reduce((sum, p) => sum + p.count * p.price, 0) <= 5_000_000);
  assert(plan.purchases.reduce((sum, p) => sum + p.count * p.capacity, 0) <= 81_000);
});

test('有界组合背包在容量和现金双约束下优于逐件贪心', () => {
  const offers = [
    { goodsId: 1, price: 6, capacity: 6, count: 1, unitProfit: 11 },
    { goodsId: 2, price: 5, capacity: 5, count: 2, unitProfit: 9 }
  ];
  const plan = optimizePurchasePlan(offers, 10, 10);
  assert.equal(plan.profit, 18);
  assert.equal(plan.purchases[0].goodsId, 2);
  assert.equal(plan.purchases[0].count, 2);
  const mixed = optimizePurchasePlan([
    { goodsId: 1, price: 2, capacity: 3, count: 2, unitProfit: 9 },
    { goodsId: 2, price: 3, capacity: 2, count: 3, unitProfit: 8 }
  ], 10, 10);
  assert.equal(mixed.profit, 34);
  assert.deepEqual(mixed.purchases.map(row => [row.goodsId, row.count]), [[1, 2], [2, 2]]);
});

test('小规模组合与穷举比较，库存、余舱和现金均不超限', () => {
  let seed = 19;
  const random = max => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let sample = 0; sample < 100; sample++) {
    const maxTypes = sample % 3 + 1;
    const offers = Array.from({ length: 3 }, (_, i) => ({ goodsId: i + 1, price: random(8) + 1,
      capacity: random(6) + 1, count: random(4) + 1, unitProfit: random(40) / 4 + 1 }));
    const capacity = random(15) + 1, cash = random(25) + 1;
    let expected = 0;
    for (let a = 0; a <= offers[0].count; a++) for (let b = 0; b <= offers[1].count; b++) for (let c = 0; c <= offers[2].count; c++) {
      const counts = [a, b, c];
      if (counts.filter(n => n > 0).length > maxTypes) continue;
      const cost = offers.reduce((sum, item, i) => sum + item.price * counts[i], 0);
      const space = offers.reduce((sum, item, i) => sum + item.capacity * counts[i], 0);
      if (cost <= cash && space <= capacity) expected = Math.max(expected, offers.reduce((sum, item, i) => sum + Math.ceil(item.unitProfit * counts[i]), 0));
    }
    const actual = optimizePurchasePlan(offers, capacity, cash, { maxTypes });
    assert.equal(actual.profit, expected, '小空间应取得全局最优');
    assert.equal(actual.approximate, false);
    assert(actual.cost <= cash && actual.capacity <= capacity);
    for (const item of actual.purchases) assert(item.count <= offers.find(o => o.goodsId === item.goodsId).count);
  }
});

test('临近收盘时为高收益新货留出售机会，较低收益的持仓可留到下一程', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7200 + 3 * 60 + 15;
  f.state.player.goods = [f.batch({ num: 1, buyPrice: 89 })];
  f.market.goods = [{ goodsId: 2, price: 80, stock: 15 }, { goodsId: 3, price: 100, stock: 18 }];
  f.radar.radar = [{cityId: 40, specGoodsId: 99}];
  const plan = f.plan();
  assert.equal(plan.kind, 'buy'); assert.equal(plan.goodsId, 2);
  assert.equal(plan.purchases.length, 1); assert.equal(plan.count, 5);
  assert.equal(plan.expectedProfit, 515);
  f.now += 16;
  assert.equal(f.plan().kind, 'move', '窗口只够带现货出航，不再采购');
});

test('大空间有界近似也遵守两项资源与库存限制', () => {
  const offers = Array.from({ length: 15 }, (_, i) => ({ goodsId: i + 1, price: 71 + i * 23,
    capacity: 1 + i % 5, count: 60000, unitProfit: 14 + i * 11 }));
  const plan = optimizePurchasePlan(offers, 81000, 10000000, { maxStates: 128 });
  assert(plan.approximate);
  assert(plan.profit > 0);
  assert(plan.cost <= 10000000 && plan.capacity <= 81000);
  assert(plan.purchases.every(item => item.count <= 60000));
});

test('每批成本和来源港独立计算，本港出售不依赖商情接口', () => {
  const f = fixture();
  f.state.cargo.cityId = 30;
  f.state.player.goods = [f.batch({ pid: 1, cityId: 20, buyPrice: 40, num: 5 }), f.batch({ pid: 2, cityId: 30, buyPrice: 80, num: 5 })];
  f.market.goods[0].price = 100;
  f.radar = null;
  const plan = f.plan();
  assert.equal(plan.kind, 'sell');
  assert.equal(plan.pid, 1);
  assert.equal(plan.count, 5);
  assert.equal(plan.gain, 309);
  assert.equal(plan.estimated, false);
});

test('目的港按所有批次总收益排序而不是首个紧缺匹配', () => {
  const f = fixture();
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, num: 9, buyPrice: 80 })];
  f.radar.radar = [{ cityId: 20, specGoodsId: 2, rareGoodsId: 1 }, { cityId: 30, specGoodsId: 3, rareGoodsId: 2 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert(plan.expectedProfit > 900);
});

test('出售决策按整船实际目标比较，不被另一港单批最高收益绑住', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, num: 9, buyPrice: 80 })];
  f.market.goods = [{ goodsId: 1, price: 60, stock: 20 }, { goodsId: 2, price: 70, stock: 20 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 2 }, { cityId: 40, specGoodsId: 1 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'sell');
  assert.equal(plan.pid, 1, '港40承接整船主要收益，货1当前出售比为了港30的单批收益占舱更好');
  f.state.player.goods.shift();
  f.state.player.coins += plan.count * 50 + plan.gain;
  assert.equal(f.plan().destination, 40);
});

test('没有指针也选自然可达的高收益出售子集，不因整船售不完选低收益港', () => {
  const f = fixture();
  f.settings.autoSpeedUp = true;
  f.settings.keepPointers = 100;
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7200 + 90;
  f.state.player.goods = [f.batch({ num: 5 }), f.batch({ pid: 2, goodsId: 2, num: 5, buyPrice: 80 })];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert.deepEqual(plan.salePids, [2]);
  assert.equal(plan.expectedProfit, 515);
  assert.equal(plan.accelerationRequired, 0);
  assert.equal(plan.latestActionAt, f.event.endTime - 7200 - 60);
});

test('可售子集仍遵守本批来源港和清仓亏损上限', () => {
  const f = fixture();
  f.settings.maxLossPercent = 10;
  f.settings.liquidationMinutes = 180;
  f.event.endTime = f.now + 7200 + 90;
  f.state.player.goods = [f.batch({ pid: 1, cityId: 20, num: 5, buyPrice: 100 }),
    f.batch({ pid: 2, cityId: 30, num: 5, buyPrice: 101 })];
  f.radar.radar = [{ cityId: 20, specGoodsId: 2 }, { cityId: 30, specGoodsId: 2 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert.deepEqual(plan.salePids, [1]);
  assert.equal(plan.expectedProfit, -50);
});

test('当前盈利小但继续持有风险调整后收益明显更高时保留', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods[0].price = 55;
  f.market.goods[0].stock = 20;
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
});

test('不可回访的高估收益港不会阻止本港实际盈利出售', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods[0].price = 55;
  f.market.goods[0].stock = 20;
  f.visited = [30];
  assert.equal(f.plan().kind, 'sell');
});

test('释放舱位可采购高收益组合时，优先本港获利出售', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods = [{ goodsId: 1, price: 75, stock: 20 }, { goodsId: 2, price: 50, stock: 0 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'sell');
  assert.match(plan.label, /再采购预计收益/);
});

test('赶不及执行的换货机会不能诱导提前出售原本应持有的货', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7440;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, num: 9, buyPrice: 80 })];
  f.market.goods = [{ goodsId: 1, price: 55, stock: 20 }, { goodsId: 2, price: 70, stock: 20 }, { goodsId: 3, price: 1, stock: 0 }];
  f.radar.radar = [{ cityId: 40, specGoodsId: 99 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 40);
});

test('同价卖出要能买到其他现货，整船预计利润超过继续持货才换', () => {
  const f = fixture();
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.state.player.coins = 0;
  f.market.goods = [{ goodsId: 1, price: 50, stock: 20 }, { goodsId: 2, price: 50, stock: 0 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const swap = f.plan();
  assert.equal(swap.kind, 'sell'); assert.equal(swap.gain, 0);
  assert.match(swap.label, /平价换货/); assert.ok(swap.latestActionAt > f.now);
  f.state.player.goods = []; f.state.player.coins = 500;
  assert.equal(f.plan().goodsId, 2); assert.equal(f.plan().kind, 'buy');
  f.state.player.goods = [f.batch()]; f.state.player.coins = 0;
  f.market.goods[0].price = 49;
  assert.notEqual(f.plan().kind, 'sell', '换货仍遵守默认零亏损');
  f.market.goods[0].price = 50;
  f.market.goods[1].stock = 20;
  assert.notEqual(f.plan().kind, 'sell', '新货卖空时不换');
  f.market.goods[1].stock = 0; f.market.goods[1].price = 150;
  assert.equal(f.plan().kind, 'move', '保留原货的整船收益更高');
  f.market.goods[1].price = 50; f.settings.minExpectedProfit = 2000;
  assert.notEqual(f.plan().kind, 'sell', '遵守账号收益门槛');
  f.settings.minExpectedProfit = 1; f.now = merchantTiming(f.config, f.event, f.now).nextRefreshAt - 30;
  assert.notEqual(f.plan().kind, 'sell', '下一轮采购前要刷新旧报价');
});

test('已持货占用容量，少量库存不会丢弃其他组合机会', () => {
  const f = fixture();
  f.state.player.goods = [f.batch({ num: 6 })];
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 17 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.purchases.reduce((sum, row) => sum + row.count * row.capacity, 0), 4);
  assert.equal(plan.purchases.find(row => row.goodsId === 1).count, 1);
  assert.equal(plan.purchases.find(row => row.goodsId === 2).count, 3);
});

test('组合采购逐笔重算后仍补齐其余商品，再执行整船出航', () => {
  const f = fixture();
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const executed = [];
  for (let step = 0; step < 3; step++) {
    const plan = f.plan();
    executed.push(plan.kind);
    if (plan.kind === 'move') {
      assert.equal(plan.destination, 30);
      break;
    }
    assert.equal(plan.kind, 'buy');
    f.state.player.coins -= plan.price * plan.count;
    f.state.player.goods.push(f.batch({ pid: step + 1, goodsId: plan.goodsId, buyPrice: plan.price, num: plan.count }));
    f.market.goods.find(row => row.goodsId === plan.goodsId).stock += plan.count;
    f.now += 60;
  }
  assert.deepEqual(executed, ['buy', 'buy', 'move']);
  assert.equal(f.state.player.goods.reduce((sum, row) => sum + row.num, 0), 10);
});

test('已知低价压低目的港估值，过期或跨期报价不当现价', () => {
  const f = fixture();
  f.state.player.goods = [f.batch()];
  f.markets = [f.history(20, 30)];
  assert.equal(f.plan().destination, 30);
  f.markets[0].observedAt -= 301;
  assert.equal(f.plan().destination, 20);
  f.markets = [f.history(20, 30, { period: 999 })];
  assert.equal(f.plan().destination, 20);
  f.markets = [f.history(20, 30, { startTime: f.event.startTime - 86400 })];
  assert.equal(f.plan().destination, 20);
  f.settings.quoteMaxAgeSeconds = 86400;
  f.markets = [f.history(20, 30, { observedAt: f.now - 601 })];
  assert.equal(f.plan().destination, 20, '跨12点刷新仍不能沿用低报价');
});

test('历史记录不能自行增加当前列表中没有的航行港', () => {
  const f = fixture();
  f.radar = { radar: [] };
  f.markets = [f.history(20, 1000)];
  assert.equal(f.plan().kind, 'wait');
  assert.match(f.plan().reason, /港口列表/);
});

test('本港缺货且刷新收益值得等待才进入 WAIT_REFRESH', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 5, 59) / 1000;
  f.market.goods[0].stock = 20;
  const plan = f.plan();
  assert.equal(plan.kind, 'wait');
  assert.equal(plan.mode, 'WAIT_REFRESH');
  assert.equal(plan.nextCheckAt - f.now, 60);
  f.settings.refreshWaitSeconds = 0;
  assert.notEqual(f.plan().mode, 'WAIT_REFRESH');
  f.market.goods[0].stock = 0;
  f.settings.refreshWaitSeconds = 120;
  assert.equal(f.plan().kind, 'buy', '充足库存没有等待收益');
});

test('等待会错过交易窗口时不等刷新，现有货及时出航', () => {
  const f = fixture();
  f.now = Date.UTC(2026, 10, 12, 5, 59) / 1000;
  f.event.endTime = f.now + 7200 + 90;
  f.settings.liquidationMinutes = 0;
  f.state.player.goods = [f.batch({ num: 5 })];
  f.market.goods[0].stock = 20;
  assert.equal(f.plan().kind, 'move');
});

test('最后一程按实际可售批次数留余量，不被其他滞销货卡住', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 0;
  f.event.endTime = f.now + 7330;
  f.state.cargo.cityId = 20;
  f.state.player.coins = 0;
  f.state.player.goods = [f.batch({ num: 1 }),
    ...Array.from({ length: 9 }, (_, i) => f.batch({ pid: i + 2, goodsId: 2, num: 1, buyPrice: 200 }))];
  f.market.goods = [{ goodsId: 1, price: 55, stock: 20 }, { goodsId: 2, price: 190, stock: 20 }];
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.destination, 30);
  assert.equal(plan.latestActionAt, f.event.endTime - 7200 - 60);
});

test('采购与空船寻价暴露完整操作截止，不仅预留单次出售时间', () => {
  const f = fixture();
  f.market.goods = [{ goodsId: 1, price: 50, stock: 19 }, { goodsId: 2, price: 100, stock: 11 }];
  f.radar.radar = [{ cityId: 30, specGoodsId: 3 }];
  const plan = f.plan(), timing = merchantTiming(f.config, f.event, f.now);
  assert.equal(plan.kind, 'buy');
  assert.equal(plan.purchases.length, 2);
  assert.equal(plan.latestActionAt, timing.tradeEndTime - 7200 - 300);
  f.market.goods = [{ goodsId: 1, price: 100, stock: 0 }];
  const explore = f.plan();
  assert.equal(explore.exploration, true);
  assert.equal(explore.latestActionAt, timing.tradeEndTime - 14400 - 240);
});

test('活动临近结束禁止新采购，同时仍可本港获利出售', () => {
  const f = fixture();
  f.event.endTime = f.now + 7300;
  assert.notEqual(f.plan().kind, 'buy', '必须为采购和到港出售留出时间');
  f.event.endTime = f.now + 30;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.market.goods[0].price = 70;
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().mode, 'FINAL_LIQUIDATION');
});

test('清仓按盈利批次累计选港，现金净收益与累计利润可不同', () => {
  const f = fixture();
  Object.assign(f.settings, { liquidationMinutes: 180, maxLossPercent: 10 });
  f.event.endTime = f.now + 9000;
  f.state.player.goods = [f.batch({ num: 1 }), f.batch({ pid: 2, goodsId: 2, buyPrice: 200, num: 1 })];
  f.radar.radar = [{ cityId: 20, specGoodsId: 3 }, { cityId: 30, specGoodsId: 2 }];
  f.markets = [f.history(30, 85)];
  for (const threshold of [1, 30]) {
    f.settings.minExpectedProfit = threshold;
    const plan = f.plan();
    assert.equal(plan.destination, 20);
    assert.equal(plan.expectedScore, 42);
    assert.equal(plan.expectedProfit, 22);
  }
  f.settings.maxLossPercent = 0;
  assert.deepEqual(f.plan().salePids, [1]);
});

test('期末仅显式配置限额内清仓，亏损不乘利润加成', () => {
  const f = fixture();
  f.event.endTime = f.now + 120;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch()];
  f.market.goods[0].price = 45;
  assert.equal(f.plan().kind, 'wait');
  f.settings.maxLossPercent = 10;
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().gain, -50);
  f.settings.maxLossPercent = 9;
  assert.equal(f.plan().kind, 'wait');
});

test('清仓期可执行更少亏损的异港路线，已访问港不阻止本港止损', () => {
  const f = fixture();
  f.settings.liquidationMinutes = 180;
  f.settings.maxLossPercent = 20;
  f.event.endTime = f.now + 9000;
  f.state.cargo.cityId = 20;
  f.state.player.goods = [f.batch({ buyPrice: 100 })];
  f.market.goods[0].price = 80;
  assert.equal(f.plan().kind, 'move');
  assert.equal(f.plan().destination, 30);
  assert.equal(f.plan().expectedProfit, -100);
  f.visited = [30];
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().gain, -200);
  f.settings.maxLossPercent = 0;
  f.market.goods[0].price = 100;
  assert.equal(f.plan().kind, 'sell');
  assert.equal(f.plan().gain, 0, '期末保本出售不需要允许亏损');
});

test('持货寻价和空船调港有边界，不凭过期商情循环往返', () => {
  const f = fixture();
  f.state.player.goods = [f.batch({ buyPrice: 100 })];
  f.market.goods[0].price = 100;
  const plan = f.plan();
  assert.equal(plan.kind, 'move');
  assert.equal(plan.exploration, true);
  assert.equal(plan.expectedProfit, 0);
  f.visited = [20, 30];
  assert.equal(f.plan().kind, 'wait');
  f.state.player.goods = [];
  f.visited = [];
  assert.equal(f.plan().exploration, true);
  f.state.player.coins = 0;
  assert.equal(f.plan().kind, 'wait', '没有本金的空船到港后无法采购');
  f.state.player.coins = 1000;
  f.event.endTime = f.now + 10800;
  assert.equal(f.plan().kind, 'wait', '空船调港后还需一次载货航程');
  f.event.endTime = f.now + 6 * 3600;
  f.settings.liquidationMinutes = 240;
  assert.equal(f.plan().kind, 'wait', '能在收盘前跑两程，但到港时已停止采购');
  f.event.endTime += 120;
  assert.equal(f.plan().exploration, true);
});

test('重复批次、重复报价、过期本港快照和超舱均停止执行', () => {
  const mutations = [
    f => f.state.player.goods = [f.batch({ num: 5 }), f.batch({ num: 5 })],
    f => f.market.goods.push({ ...f.market.goods[0] }),
    f => f.market.observedAt = f.now - 301,
    f => f.market.observedAt = f.now + 1,
    f => f.state.player.goods = [f.batch({ num: 11 })],
    f => f.state.player.goods = [f.batch({ buyPrice: Number.MAX_SAFE_INTEGER })],
    f => f.state.player.goods = [null],
    f => f.market.goods = [null]
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.equal(f.plan().kind, 'wait');
  }
});

test('畸形历史快照被忽略，不因空记录中断当前合法计划', () => {
  const f = fixture();
  for (const goods of [[null], [{ goodsId: 1, price: -1 }], [{ goodsId: 1, price: 20 }, { goodsId: 1, price: 200 }]]) {
    f.markets = [null, f.history(20, 30, { goods })];
    assert.equal(f.plan().kind, 'buy');
    assert.equal(f.plan().destination, 20);
  }
});

test('矛盾港口信息不参与目的港选择，坏库存不能购买', () => {
  const f = fixture();
  f.radar.radar.push({ cityId: 20, specGoodsId: 3, rareGoodsId: 1 });
  assert.equal(f.plan().destination, 30);
  f.market.goods[0].stock = 21;
  assert.notEqual(f.plan().kind, 'buy');
  f.market.goods[0].stock = -1;
  assert.notEqual(f.plan().kind, 'buy');
});

function fullCargoFixture() {
  const f = fixture();
  f.settings = { fullCargoRoutes: true };
  f.market.rareGoodsId = 2;
  f.radar.radar[1].rareGoodsId = 1;
  f.now = Date.UTC(2026, 10, 12, 4, 1) / 1000;
  return f;
}

test('开启满舱往返后，单向、空船、差一格或缺本金都不出航，仍可按实价卖出', () => {
  const f = fullCargoFixture();
  assert.equal(merchantSettings().fullCargoRoutes, false);
  const buy = f.plan();
  assert.deepEqual([buy.kind, buy.destination, buy.count], ['buy', 20, 10]);
  assert.match(buy.label, /每格价差 50 商会币/);
  f.state.player.coins = 0;
  assert.match(f.plan().reason, /余款 0 商会币不足/);
  f.state.player.goods = [f.batch({ num: 9 })];
  assert.equal(f.plan().kind, 'wait');
  f.state.player.goods[0].num++;
  assert.deepEqual([f.plan().kind, f.plan().destination], ['move', 20]);
  f.radar.radar[1].specGoodsId = 3;
  assert.match(f.plan().reason, /双向/);
  f.state.cargo.cityId = 20;
  f.market.goods[0].price = 90;
  assert.equal(f.plan().kind, 'sell');
});

test('先买刷新前余货，12:01重新读价补足，涨价后留港', () => {
  const f = fullCargoFixture();
  f.now = Date.UTC(2026, 10, 12, 3, 59) / 1000;
  f.market.goods[0].stock = 16;
  const first = f.plan();
  assert.deepEqual([first.kind, first.count, first.expectedProfit], ['buy', 4, 206]);
  f.market.goods[0].stock = 20;
  f.state.player.goods = [f.batch({ num: 4 })];
  f.state.player.coins -= first.price * first.count;
  const wait = f.plan();
  assert.deepEqual([wait.mode, wait.nextCheckAt], ['WAIT_REFRESH', first.nextCheckAt]);
  f.now += 120;
  Object.assign(f.market.goods[0], { stock: 0, price: 110 });
  assert.equal(f.plan().kind, 'wait');
  f.market.goods[0].price = 40;
  const next = f.plan();
  assert.deepEqual([next.kind, next.price, next.count], ['buy', 40, 6]);
  f.state.player.goods.push(f.batch({ pid: 2, buyPrice: 40, num: 6 }));
  assert.deepEqual([f.plan().kind, f.plan().expectedProfit], ['move', 577]);
});

test('同一双向航线获利时优先返航，航线失效后重选，并在不损失航次时卡刷新到达', () => {
  const f = fullCargoFixture();
  f.state.player.goods = [f.batch()];
  f.radar.radar.push({ cityId: 40, specGoodsId: 2, rareGoodsId: 1 });
  assert.equal(f.plan().destination, 20);
  f.preferredPort = 40;
  assert.equal(f.plan().destination, 40);
  f.radar.radar.at(-1).rareGoodsId = 3;
  assert.equal(f.plan().destination, 20);
  f.now += 20 * 60;
  assert.equal(f.plan().kind, 'move', '为卡点会损失一趟时直接出发');
  f.now += 94 * 60;
  const wait = f.plan();
  assert.equal(wait.mode, 'WAIT_DEPARTURE');
  f.now = wait.nextCheckAt;
  const move = f.plan();
  assert.equal(move.kind, 'move');
  assert.equal(merchantTiming(f.config, f.event, move.arrival).nextRefreshAt - move.arrival, 120);
  f.now = Date.UTC(2026, 10, 12, 11, 58) / 1000;
  assert.equal(f.plan().kind, 'move', '最后一趟直接出发');
  f.now += 120;
  assert.equal(f.plan().kind, 'move', '当日已来不及成交，满舱可为次日开市提前出发');
});

test('满舱配货保留特产，以折扣、每格净价差、品质排序并给余格留足本金', () => {
  const item = (goodsId, capacity, price, basePrice, gain, count, quality = 1) =>
    ({ goodsId, capacity, price, basePrice, count, quality, unitProfit: gain, profitBasis: gain * 10000 });
  const load = (items, capacity, cash, types = items.length) =>
    fullMerchantLoad(items, capacity, cash, types, 1, true).purchases.map(p => [p.goodsId, p.count]);
  const main = item(1, 4, 60, 100, 20, 3);
  assert.deepEqual(load([main, item(2, 3, 12, 50, 10, 5)], 10, 150), [[1, 1], [2, 2]]);
  assert.deepEqual(load([main, item(2, 1, 10, 20, 10, 10)], 10, 125), [[1, 1], [2, 6]]);
  assert.deepEqual(load([main, item(2, 1, 10, 20, 10, 10)], 10, 125, 1), []);
  main.count = 1;
  const fillers = [item(2, 3, 30, 60, 21, 2), item(3, 1, 5, 10, 8, 6, 3), item(4, 1, 5, 10, 8, 6, 4)];
  assert.deepEqual(load([main, ...fillers], 10, 500), [[1, 1], [4, 6]]);
  fillers[0].price = 29;
  assert.deepEqual(load([main, ...fillers], 10, 500), [[1, 1], [2, 2]]);
});

test('满舱组合按排序与小规模穷举一致，兼容余数、本金和可成交货种数约束', () => {
  let seed = 37;
  const random = max => (seed = seed * 48271 % 2147483647) % max;
  for (let t = 0; t < 180; t++) {
    const offers = Array.from({ length: 4 }, (_, i) => ({ goodsId: i + 1, price: i + 2, basePrice: 20,
      capacity: 1 + random(5), count: 1 + random(4), unitProfit: 3, profitBasis: 30000, quality: 1 }));
    const space = 1 + random(17), cash = 1 + random(40), types = 1 + random(4), main = Boolean(t % 2);
    const enumerate = (i, left, balance, slots) => {
      if (!left) return [];
      if (i === offers.length || !slots) return null;
      const o = offers[i], max = Math.min(o.count, Math.floor(left / o.capacity), Math.floor(balance / o.price));
      for (let n = max; n >= Number(main && i === 0); n--) {
        const rest = enumerate(i + 1, left - n * o.capacity, balance - n * o.price, slots - Number(n > 0));
        if (rest) return n ? [[o.goodsId, n], ...rest] : rest;
      }
      return null;
    };
    const actual = fullMerchantLoad(offers, space, cash, types, 1, main);
    assert.deepEqual(actual.purchases.map(p => [p.goodsId, p.count]), enumerate(0, space, cash, types) ?? []);
  }
});

console.log('海商王纯策略验证完成：' + tests + ' 项');
