import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger } from '../src/automation-settings.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { merchantSpeedMatches, planMerchantSpeed, runMerchantSpeed } from '../src/merchant-speed.mjs';
import {
  beginOrderMaterialSpend, cancelOrderMaterialSpend, pendingOrderMaterialSpends, refreshOrderMaterialSpends
} from '../src/order-reservations.mjs';

const protocol = loadProtocol();
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-speed-'));
const pointer = '海商王加速';
const now = Date.UTC(2026, 10, 12, 13, 15) / 1000; // 北京时间 21:15。
const config = { tables: {
  ActivityTradeCfg: { data: [
    { key: '海商王贸易时间', value: '10-22' }, { key: '海商王行驶时间', value: '120' },
    { key: '海商王加速时长', value: '30' }, { key: '海商王刷新时间', value: '10,12,14,16,18,20' }
  ] },
  TradeShipCfg: { data: [{ lv: 1, capacity: 1000, profitMargin: 300 }] },
  TradeGoodsCfg: { data: [{ goodsId: 1001, unitPrice: 50, capacity: 1 }] }
} };
let count = 0, passed = 0;
function fixture(at = now) {
  const id = ++count;
  const event = { period: 1001, startTime: at - 86400, endTime: now + 3 * 3600 };
  const state = { period: event.period,
    cargo: { cargoLv: 1, cityId: 10, moveToCityId: 20, moveStartTime: at - 2700, moveEndTime: at + 4500 },
    player: { coins: 1000, profit: 2000, goods: [{ pid: 1, goodsId: 1001, num: 100, buyPrice: 10, cityId: 10 }] } };
  const settings = { merchant: { fullCargoRoutes: false, autoSpeedUp: true, speedUpMode: 'refresh', keepPointers: 1, estimateDiscountPercent: 10 } };
  const radar = { radar: [{ cityId: 10, specGoodsId: 1001 }, { cityId: 20, specGoodsId: 1002 }] };
  const stock = new Map([[pointer, 4]]), calls = [], reports = [];
  const player = { playerId: String(80000 + id), worldId: '2002001001', guildId: '1001', level: 37 };
  let active = true, mode = '', hook = () => {};
  const client = { connected: true, tradeWindow: event, serverClockOffsetMs: at * 1000 - Date.now(),
    async request(name, body = {}, response) {
      assert.ok(protocol[name], name + ' 必须存在于真实协议');
      assert.ok(protocol[response], response + ' 必须存在于真实协议');
      protocol[name].encode(body).finish();
      calls.push({ name, body });
      await hook(name, body);
      if (name === 'TradeInfoRequest') return structuredClone(state);
      if (name === 'TradeGuildRadarRequest') return structuredClone(radar);
      if (name === 'AllItemRequest') {
        if (mode === 'inventory-fails' && calls.some(row => row.name === 'TradeSpeedRequest')) throw Error('库存回读超时');
        return { items: [...stock].map(([itemId, num]) => ({ itemId, num })) };
      }
      assert.equal(name, 'TradeSpeedRequest', '不得购买指针或升级商船');
      if (mode === 'not-sent') throw Object.assign(Error('明确未发送'), { notSent: true });
      if (mode === 'rejected') throw Object.assign(Error('拒绝'), { request: name, prompt: { prompt: 1 } });
      if (mode === 'unknown') throw Error('响应未知');
      stock.set(pointer, stock.get(pointer) - body.useNum);
      state.cargo.moveEndTime -= body.useNum * 1800;
      if (mode === 'applied-timeout') throw Error('回包丢失');
      return { moveEndTime: state.cargo.moveEndTime };
    }
  };
  const ledger = createUsageLedger('merchant-speed-' + id, { file: path.join(folder, id + '.json') });
  const ctx = { player, ledger, label: '海商王', enabled: () => active,
    settings: () => settings, report: report => reports.push(report) };
  return { event, state, settings, radar, stock, client, ctx, ledger, calls, reports, player, now: at,
    run: () => runMerchantSpeed(client, config, ctx, event, structuredClone(state)),
    plan: options => planMerchantSpeed(config, event, state, radar, stock, settings.merchant, at, options),
    mode: value => { mode = value; }, hook: value => { hook = value; }, pause: () => { active = false; },
    sent: () => calls.filter(row => row.name === 'TradeSpeedRequest') };
}
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

try {
  await test('同港抢先比较最早的同盟船，并列多用一根，无法领先时留针', () => {
    const f = fixture(now - 6 * 3600);
    f.settings.merchant.speedUpMode = 'race';
    const rival = (playerId, eta, dest = 20, guildIdx = 1) => ({ playerId, guildIdx,
      cargo: { cityId: 30, moveToCityId: dest, moveStartTime: f.now - 10, moveEndTime: f.now + eta } });
    const plan = () => f.plan({ actor: f.player });
    f.state.worldCargo = [rival(f.player.playerId, 10), rival('91', 20, 30), rival('92', 30, 20, 2)];
    assert.equal(plan().kind, 'none');
    f.state.worldCargo.push(rival('93', 4501));
    assert.equal(plan().leading, true);
    f.state.worldCargo.push(rival('94', 4500));
    assert.equal(plan().useNum, 1);
    f.state.worldCargo.push(rival('95', 2700));
    assert.equal(plan().useNum, 2);
    assert.equal(plan().rivalEta, f.now + 2700);
    f.stock.set(pointer, 2); // 其中一根必须保留。
    assert.equal(plan().kind, 'wait');
  });
  await test('最后一根按剩余航时独立触发，全程用针受背包和额度约束', async () => {
    const f = fixture(now - 6 * 3600);
    f.state.player.goods = [];
    Object.assign(f.settings.merchant, { speedUpMode: 'race', guardLastPointer: true });
    f.state.cargo.moveEndTime = f.now + 1801;
    assert.equal(f.plan().kind, 'none');
    f.state.cargo.moveEndTime--;
    assert.equal(f.plan().accelerationReason, 'guard');
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    assert.equal(f.reports.at(-1).status, 'confirmed');
    const g = fixture(now - 6 * 3600);
    g.state.player.goods = [];
    Object.assign(g.settings.merchant, { speedUpMode: 'full', keepPointers: 0 });
    for (const [seconds, useNum] of [[7200, 4], [3600, 2], [8, 1]]) {
      g.state.cargo.moveEndTime = g.now + seconds;
      assert.equal(g.plan().useNum, useNum);
    }
    g.state.cargo.moveEndTime = g.now + 7200;
    assert.equal(g.plan({ usedPointers: 3 }).useNum, 1);
    assert.equal(g.plan({ dailyUsed: 28 }).kind, 'wait');
    g.stock.set(pointer, 2);
    assert.equal(g.plan().useNum, 2);
    g.state.player.profit = 50_000_000;
    assert.equal(g.plan().kind, 'none');
    g.state.player.profit = 0;
    g.event.endTime = g.now + 59;
    assert.equal(g.plan().kind, 'wait');
  });
  await test('旧账本的本期选择不能覆盖账号开关，发送前关闭立即生效', async () => {
    for (const enabled of [false, true]) {
      const f = fixture();
      f.settings.merchant.autoSpeedUp = enabled;
      f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'merchant-pointer-mode:' + f.event.startTime + ':' + f.event.period,
        details: { mode: enabled ? 'save' : 'sprint' } }));
      await f.run(); assert.equal(f.sent().length, enabled ? 1 : 0);
    }
    const g = fixture();
    g.hook(name => { if (name === 'TradeInfoRequest') g.settings.merchant.autoSpeedUp = false; });
    await g.run(); assert.equal(g.sent().length, 0);
  });
  await test('5000万、较低自设目标、自然可达及次日可售时保留指针', async () => {
    for (const [profit, profitLimit] of [[50_000_000, 0], [50_000_000, 60_000_000], [12_345, 12_345]]) {
      const f = fixture();
      Object.assign(f.state.player, { profit }); Object.assign(f.settings.merchant, { profitLimit });
      assert.equal(await f.run(), false); assert.deepEqual(f.calls, []);
    }
    const f = fixture(now - 6 * 3600);
    f.state.player.profit = 50_000_000 - 10_000;
    assert.equal(f.plan().kind, 'none', '自然到港仍有时间卖货');
    const overnight = fixture();
    overnight.event.endTime = now + 86400;
    await overnight.run(); assert.deepEqual(overnight.sent(), [], '今日收盘后留货，明日可自然出售');
    const g = fixture();
    g.state.cargo.moveEndTime = now + 2610;
    g.state.player.goods.push({ ...g.state.player.goods[0], num: 1, buyPrice: 44, pid: 2 });
    assert.equal(g.plan().estimatedIncrementalProfit, 1, '抢救一批仅多赚一币也是有效增益');
    assert.equal(g.plan().useNum, 1);
    g.state.player.profit = 50_000_000 - 3500;
    assert.equal(g.plan().kind, 'none', '自然到港可卖出的高利润批次已够达标');
  });
  await test('同样成交次数留针，一根能达标时放弃更高的两根收益', () => {
    const g = fixture();
    g.state.cargo.moveEndTime = now + 4410;
    g.state.player.goods.push({ ...g.state.player.goods[0], pid: 2 });
    g.state.player.profit = 50_000_000 - 3500;
    assert.equal(g.plan().useNum, 1);
    assert.equal(g.plan().reachesGoal, true);
    g.state.player.profit = 50_000_000 - 7000;
    assert.equal(g.plan().useNum, 2);
  });
  await test('最少两枚指针保留一分钟成交，收益使用折扣基准价', async () => {
    const f = fixture(), plan = f.plan();
    assert.equal(plan.kind, 'speed');
    assert.equal(plan.useNum, 2);
    assert.equal(plan.estimatedProfit, 3605);
    assert.equal(plan.expected.afterEndTime, now + 900);
    assert.match(plan.label, /非目的港实时报价/);
    assert.equal(await f.run(), true);
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 2 }]);
    assert.equal(f.stock.get(pointer), 2);
    assert.equal(f.reports.at(-1).status, 'confirmed');
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    const sendIndex = f.calls.findIndex(row => row.name === 'TradeSpeedRequest');
    assert.deepEqual(f.calls.slice(sendIndex + 1).map(row => row.name), ['TradeInfoRequest', 'AllItemRequest']);
    assert.equal(await f.run(), false, '已经赶得上窗口，不继续加速');
    assert.equal(f.sent().length, 1);
  });
  await test('关闭加速和正常到港都不读取库存或发送请求', async () => {
    const f = fixture();
    f.settings.merchant.autoSpeedUp = false;
    assert.equal(await f.run(), false);
    f.settings.merchant.autoSpeedUp = true;
    f.state.cargo.moveEndTime = now + 100;
    assert.equal(await f.run(), false);
    assert.equal(f.calls.length, 0);
  });
  await test('旧周转策略和缺省策略均按稳定模式执行，刷新前高价和成交速率不会触发用针', async () => {
    for (const mode of [undefined, 'profit', 'deadline']) {
      const f = fixture(now - 7 * 3600 - 20 * 60); // 13:55，距刷新五分钟。
      if (mode === undefined) delete f.settings.merchant.speedUpMode;
      else f.settings.merchant.speedUpMode = mode;
      const metrics = { ...f.event, observedAt: f.now, turnoverProfitPerSecond: 50 };
      const targetMarket = { ...f.event, cityId: 20, observedAt: f.now, goods: [{ goodsId: 1001, price: 90 }] };
      assert.equal(f.plan({ metrics, targetMarket }).kind, 'none');
      await f.run();
      assert.deepEqual(f.calls, []);
      const closing = fixture();
      if (mode === undefined) delete closing.settings.merchant.speedUpMode;
      else closing.settings.merchant.speedUpMode = mode;
      assert.equal(closing.plan().accelerationReason, 'finalCargo');
    }
  });
  await test('最后一船只看剩余航时与出售时间，遵守指针额度和活动开关', async () => {
    const f = fixture();
    Object.assign(f.settings.merchant, { speedUpMode: 'deadline', fullCargoRoutes: true });
    f.state.player.goods[0].buyPrice = 49;
    const plan = f.plan();
    assert.equal(plan.accelerationReason, 'finalCargo');
    assert.equal(plan.useNum, 3);
    assert.equal(plan.expected.afterEndTime, now);
    const waiting = f.plan({ dailyUsed: 26 });
    assert.equal(waiting.kind, 'wait');
    assert.equal(waiting.nextCheckAt, now + 900, '还剩两根时先自然航行15分钟');
    const atBoundary = planMerchantSpeed(config, f.event, f.state, f.radar, f.stock, f.settings.merchant, waiting.nextCheckAt, { dailyUsed: 26 });
    assert.equal(atBoundary.useNum, 2);
    assert.equal(atBoundary.expected.afterEndTime, waiting.nextCheckAt);
    const tooLate = f.plan({ dailyUsed: 27 });
    assert.equal(tooLate.kind, 'wait', '只剩一根，到港时已收盘');
    assert.equal(tooLate.nextCheckAt, undefined);
    assert.equal(f.plan({ usedPointers: 3 }).kind, 'wait');
    f.stock.set(pointer, 1);
    assert.equal(f.plan().kind, 'wait', '保留数量不能动用');
    f.stock.set(pointer, 4);
    f.settings.merchant.autoSpeedUp = false;
    assert.equal(f.plan().kind, 'none');
    f.settings.merchant.autoSpeedUp = true;
    f.event.endTime = now + 60;
    assert.notEqual(f.plan().kind, 'speed', '即使立即到港也来不及完成出售');
  });
  await test('最后一船须给目的港可售的每批货留出成交时间，额度救不回整船就零消耗', async () => {
    const f = fixture();
    Object.assign(f.settings.merchant, { speedUpMode: 'deadline', speedUpMaxPerLeg: 2, autoBuyPointers: true });
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 }, { ...f.state.player.goods[0], pid: 3, cityId: 20 });
    // 最早15分钟后到港。剩余时间可卖一批；两批恰好碰到截止，不得提前扣掉两根。
    f.event.endTime = now + 900 + 120;
    assert.equal(f.plan().kind, 'wait');
    assert.match(f.plan().reason, /卖完 2 批/);
    await f.run();
    assert.deepEqual(f.sent(), []);
    assert.equal(f.stock.get(pointer), 4);
    assert.equal(f.ledger.snapshot().counters.merchantPointers ?? 0, 0);
    f.event.endTime++;
    assert.equal(f.plan().nextCheckAt, now + 900, '多一秒就能安排两批，目的港原购批次不占用成交时间');
    f.state.cargo.moveEndTime = now + 1800;
    const ready = f.plan();
    assert.equal(ready.useNum, 1);
    assert.equal(ready.saleSeconds, 120);
    assert.equal(ready.evidenceExpiresAt, f.event.endTime - 121);
  });
  await test('稳定模式只在最后交易窗口对异港货直接加速', () => {
    const f = fixture();
    f.settings.merchant.speedUpMode = 'deadline';
    f.state.cargo.moveEndTime = now + 80;
    assert.equal(f.plan().useNum, 1, '自然航行也来得及卖，仍可直接到港');
    const originalEnd = f.event.endTime;
    f.event.endTime = now + 86400;
    assert.equal(f.plan().kind, 'none', '明天还开市');
    f.event.endTime = originalEnd;
    f.state.player.goods[0].cityId = f.state.cargo.moveToCityId;
    assert.equal(f.plan().kind, 'none', '目的港买的货不能原港卖');
    f.state.player.goods = [];
    assert.equal(f.plan().kind, 'none', '空船不触发最后一船加速');
  });
  await test('指针不足时选有证据且可成交的部分加速，不用不足数量抢救截止', async () => {
    const f = fixture();
    f.state.cargo.moveEndTime = now + 3300;
    f.settings.merchant.keepPointers = 3;
    const plan = f.plan();
    assert.equal(plan.useNum, 1);
    assert.equal(plan.estimatedIncrementalProfit, 3605);
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    assert.equal(f.stock.get(pointer), 3);
    const g = fixture();
    g.settings.merchant.keepPointers = 3;
    assert.equal(g.plan().kind, 'wait');
    await g.run();
    assert.equal(g.sent().length, 0, '一根赶不及收盘就留针');
  });
  await test('航程上限扣除本程已确认指针，达到上限后不重复消费', async () => {
    const f = fixture(now - 6.5 * 3600);
    Object.assign(f.settings.merchant, { speedUpMode: 'full', speedUpMaxPerLeg: 3 });
    const cargo = f.state.cargo;
    f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'prior-speed', details: {
      scope: 'merchant:' + f.event.startTime + ':' + f.event.period,
      expected: { request: 'TradeSpeedRequest', period: f.event.period, city: cargo.cityId,
        destination: cargo.moveToCityId, moveStartTime: cargo.moveStartTime, useNum: 2 }
    } }));
    assert.equal(f.plan({ usedPointers: 2 }).useNum, 1);
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    await f.run();
    assert.equal(f.sent().length, 1);
    assert.equal(f.plan({ usedPointers: 3 }).kind, 'wait');
  });
  await test('加速策略或本程上限在复查期间变化时取消加速', async () => {
    for (const mutation of [
      f => { f.settings.merchant.speedUpMaxPerLeg = 1; },
      f => { f.settings.merchant.speedUpMode = 'deadline'; }
    ]) {
      const f = fixture();
      f.hook(name => { if (name === 'TradeInfoRequest') mutation(f); });
      await f.run();
      assert.equal(f.sent().length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    }
  });
  await test('预留后关闭加速或超过证据有效期，取消未发送指针并释放票据', async () => {
    for (const change of [
      f => { f.settings.merchant.autoSpeedUp = false; },
      f => { f.client.serverClockOffsetMs += 14401000; }
    ]) {
      const f = fixture();
      const reserve = f.ledger.reserve;
      let observed = false;
      f.ledger.reserve = (...args) => {
        const ticket = reserve(...args);
        if (args[3]?.uniqueKey?.startsWith('event-action:')) { observed = true; change(f); }
        return ticket;
      };
      await f.run();
      assert.equal(observed, true);
      assert.equal(f.sent().length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('指针保留量、正增益与目的港资格同时限制发送', async () => {
    for (const edit of [
      f => f.stock.set(pointer, 2),
      f => { f.radar.radar = [{ cityId: 10 }]; },
      f => { f.state.player.goods[0].cityId = 20; },
      f => { f.radar.radar[1].specGoodsId = 1001; },
      f => { f.state.player.goods[0].buyPrice = 46; },
      f => { f.state.player.goods[0].num = 1001; }
    ]) {
      const f = fixture(); edit(f); assert.equal(await f.run(), true); assert.equal(f.sent().length, 0);
    }
  });
  await test('按活动截止计算且不足一分钟不盲目使用指针', async () => {
    const f = fixture(); f.event.endTime = now + 180;
    assert.equal(f.plan().useNum, 3);
    f.event.endTime = now + 59;
    assert.equal(f.plan().kind, 'wait');
    await f.run(); assert.equal(f.sent().length, 0);
  });
  await test('立即到港计划跨秒复查仍可执行，以新时刻核对结果', async () => {
    const f = fixture(); f.event.endTime = now + 180;
    f.hook(name => { if (name === 'TradeInfoRequest') f.client.serverClockOffsetMs += 2000; });
    await f.run();
    assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 3 }]);
    assert.equal(f.reports.at(-1).status, 'confirmed');
  });
  await test('两批估算利润必须预留两轮出售时间并增加最低指针数', async () => {
    const f = fixture(); f.state.cargo.moveEndTime = now + 4410;
    assert.equal(f.plan().useNum, 1, '一批到港后可留90秒');
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 });
    f.state.player.profit = 50_000_000 - 7000;
    const plan = f.plan();
    assert.equal(plan.saleCount, 2); assert.equal(plan.saleSeconds, 120);
    assert.equal(plan.useNum, 2, '一枚仅剩90秒，不足以完成两笔出售');
    assert.equal(plan.estimatedProfit, 7210);
    await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 2 }]);
  });
  await test('自然到港仅剩90秒时两批需要一枚指针，只有一批可卖则无需', async () => {
    const f = fixture(); f.state.cargo.moveEndTime = now + 2610;
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 });
    assert.equal(f.plan().saleCount, 2); assert.equal(f.plan().useNum, 1);
    assert.equal(f.plan().estimatedIncrementalProfit, 3605, '自然能卖出的第一批不能计入指针收益');
    await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 1 }]);
    const g = fixture(); g.state.cargo.moveEndTime = now + 2610;
    g.state.player.goods.push({ ...g.state.player.goods[0], pid: 2, cityId: 20 });
    assert.equal(g.plan().kind, 'none');
    assert.equal(await g.run(), false); assert.equal(g.sent().length, 0);
  });
  await test('180秒挂机间隔不会用只能留出60到120秒的方案消耗指针', async () => {
    for (const remaining of [60, 120]) {
      const f = fixture(); f.event.endTime = now + remaining;
      f.settings.loop = { everySeconds: 180 };
      assert.equal(f.plan({ actionSeconds: 180 }).kind, 'wait');
      await f.run(); assert.equal(f.sent().length, 0);
    }
  });
  await test('长挂机间隔按实际逐批时间增加指针，CLI间隔也参与', async () => {
    for (const cli of [false, true]) {
      const f = fixture(); f.state.cargo.moveEndTime = now + 4410;
      assert.equal(f.plan().useNum, 1);
      const plan = f.plan({ actionSeconds: 180 });
      assert.equal(plan.useNum, 2); assert.equal(plan.saleSeconds, 180);
      assert.match(plan.label, /预留 180 秒/);
      if (cli) { f.settings.loop = { everySeconds: 60 }; f.ctx.everyMs = 180000; }
      else f.settings.loop = { everySeconds: 180 };
      await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 2 }]);
    }
    const g = fixture(); g.state.cargo.moveEndTime = now + 2580;
    g.settings.loop = { everySeconds: 180 };
    assert.equal(g.plan().kind, 'none');
    await g.run(); assert.deepEqual(g.sent().map(row => row.body), [{ useNum: 1 }],
      '正常到港只剩120秒，首次快速判断也必须考虑180秒间隔');
  });
  await test('加速复查期间调大网页或CLI挂机间隔必须取消发送', async () => {
    for (const edit of [f => { f.settings.loop = { everySeconds: 180 }; },
      f => { f.ctx.everyMs = 180000; }]) {
      const f = fixture(); f.state.cargo.moveEndTime = now + 4410;
      f.hook(name => { if (name === 'TradeInfoRequest') edit(f); });
      await f.run(); assert.equal(f.sent().length, 0);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    }
  });
  await test('窗口只能出售一批时不累加两批收益消耗指针', async () => {
    const f = fixture(); f.event.endTime = now + 90;
    f.state.player.goods.push({ ...f.state.player.goods[0], pid: 2 });
    assert.equal(f.plan().estimatedIncrementalProfit, 3605);
    assert.equal(f.plan().saleCount, 1);
    assert.equal(f.plan().useNum, 3);
    await f.run(); assert.deepEqual(f.sent().map(row => row.body), [{ useNum: 3 }]);
  });
  await test('当前有效到访低价压低加速估值，过期高价不提高基准估值', async () => {
    const f = fixture();
    const market = { cityId: 20, period: f.event.period, startTime: f.event.startTime,
      observedAt: now - 10, goods: [{ goodsId: 1001, price: 15 }] };
    const low = f.plan({ markets: [market] });
    assert.equal(low.kind, 'speed');
    assert.equal(low.estimatedProfit, 309);
    assert.ok(low.expected.afterEndTime - market.observedAt > 300,
      '到港可能超过旧价TTL，仍保守采用低价上限而非恢复较高基准');
    assert.equal(f.plan({ markets: [{ ...market, goods: [{ goodsId: 1001, price: 100 }] }] }).estimatedProfit, 3605);
    for (const invalid of [
      { ...market, period: 2000 },
      { ...market, startTime: f.event.startTime - 86400 },
      { ...market, observedAt: now + 1 },
      { ...market, observedAt: now - 301 },
      { ...market, goods: [{ goodsId: 1001, price: 0 }] },
      { ...market, goods: [market.goods[0], market.goods[0]] }
    ]) assert.equal(f.plan({ markets: [invalid] }).estimatedProfit, 3605);
    f.settings.merchant.quoteMaxAgeSeconds = 10000;
    assert.equal(f.plan({ markets: [{ ...market, observedAt: now - 4501 }] }).estimatedProfit, 3605,
      '前一刷新周期的报价不能被当前TTL延长复活');
  });
  await test('持久行情或发送前复查显示折后无利可赚时保留指针', async () => {
    for (const late of [false, true]) {
      const f = fixture();
      const remember = () => f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'market-low', details: {
        merchantMarket: { cityId: 20, period: f.event.period, startTime: f.event.startTime,
          observedAt: now, goods: [{ goodsId: 1001, price: 12 }] }
      } }));
      if (late) f.hook(name => { if (name === 'TradeInfoRequest') remember(); });
      else remember();
      await f.run(); assert.equal(f.sent().length, 0);
    }
  });
  await test('空批次条目安全等待，探索航程不会使用指针', async () => {
    const f = fixture(); f.state.player.goods = [null];
    assert.equal(f.plan().kind, 'wait'); await f.run(); assert.equal(f.sent().length, 0);
    const g = fixture();
    g.ledger.confirm(g.ledger.reserve({}, {}, {}, { uniqueKey: 'explore-leg', details: {
      scope: 'merchant:' + g.event.startTime + ':' + g.event.period,
      expected: { request: 'TradeMoveRequest', city: 10, destination: 20,
        start: g.state.cargo.moveStartTime, exploration: true }
    } }));
    assert.equal(await g.run(), false); assert.equal(g.calls.length, 0);
  });
  await test('发送前关闭开关、修改保留量或改变航程取消发送', async () => {
    for (const edit of [f => f.pause(), f => { f.settings.merchant.keepPointers = 3; },
      f => { f.state.cargo.moveToCityId = 30; }]) {
      const f = fixture(); let n = 0;
      f.hook(name => { if (name === 'TradeInfoRequest' && ++n === 1) edit(f); });
      await f.run(); assert.equal(f.sent().length, 0); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    }
  });
  await test('未确认指针预留阻止重复使用，且不阻塞其他材料', async () => {
    const f = fixture();
    const handle = beginOrderMaterialSpend(f.player, [{ id: pointer, have: 4, need: 1 }], '前次指针',
      { operation: { verify: async () => false } });
    await f.run(); assert.equal(f.sent().length, 0);
    assert.equal(Object.keys(f.ledger.keyRecords()).length, 0, '明确未发送释放持久票据');
    cancelOrderMaterialSpend(handle);
    const other = beginOrderMaterialSpend(f.player, [{ id: '木头', have: 4, need: 1 }], '其他材料',
      { operation: { verify: async () => false } });
    await f.run(); assert.equal(f.sent().length, 1); cancelOrderMaterialSpend(other);
  });
  await test('请求结果未知保留票据与指针，不因库存下降或重试而重发', async () => {
    const f = fixture(); f.mode('unknown'); await f.run();
    assert.equal(f.reports.at(-1).status, 'unknown');
    f.stock.set(pointer, 2); // 无关操作改变库存，不能据此确认航程。
    await refreshOrderMaterialSpends(f.client, f.player);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
    f.stock.set(pointer, 4); await f.run();
    assert.equal(f.sent().length, 1);
    assert.equal(Object.values(f.ledger.keyRecords()).filter(row => !row.confirmed).length, 1);
  });
  await test('加速未知记录保留原快照和尝试时间，恢复回调复用同一证据', async () => {
    const f = fixture(), outcomes = [];
    f.state.cargo.moveEndTime = now + 3300;
    f.settings.merchant.speedUpMaxPerLeg = 1;
    f.ctx.onMerchantOutcome = entry => outcomes.push(structuredClone(entry));
    const original = structuredClone({ coins: f.state.player.coins, profit: f.state.player.profit,
      goods: f.state.player.goods, cargo: f.state.cargo });
    f.mode('unknown'); await f.run();
    const pending = Object.values(f.ledger.keyRecords()).find(row => !row.confirmed);
    assert.deepEqual(pending.details.before, original);
    assert.equal(pending.details.attemptedAt, f.now);
    assert.equal(outcomes[0].status, 'unknown');
    assert.deepEqual(outcomes[0].before, original);
    f.state.cargo.moveEndTime -= 1800;
    f.stock.set(pointer, 3);
    f.client.serverClockOffsetMs += 1000;
    f.mode(''); await f.run();
    assert.equal(f.sent().length, 1, '恢复结果不重复发送指针');
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[1].status, 'confirmed');
    assert.equal(outcomes[1].actionKey, outcomes[0].actionKey);
    assert.equal(outcomes[1].attemptedAt, outcomes[0].attemptedAt);
    assert.deepEqual(outcomes[1].before, original);
    assert.equal(outcomes[1].after.cargo.moveEndTime, original.cargo.moveEndTime - 1800);
    assert.equal(Object.values(f.ledger.keyRecords()).filter(row => !row.confirmed).length, 0);
  });
  await test('明确未发送和服务端拒绝释放材料及持久票据', async () => {
    for (const mode of ['not-sent', 'rejected']) {
      const f = fixture(); f.mode(mode); await f.run();
      assert.equal(f.sent().length, 1);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
      assert.equal(Object.keys(f.ledger.keyRecords()).length, 0);
    }
  });
  await test('回包丢失仅以同程提前证据恢复，完整库存失败继续预留', async () => {
    const f = fixture(); const expected = f.plan().expected;
    f.mode('applied-timeout'); await f.run();
    assert.equal(f.sent().length, 1);
    assert.equal(merchantSpeedMatches(expected, f.state, now), true);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    const g = fixture(); g.mode('inventory-fails'); await g.run();
    assert.equal(g.reports.at(-1).status, 'confirmed');
    assert.equal(pendingOrderMaterialSpends(g.player).length, 1);
    g.mode(''); await refreshOrderMaterialSpends(g.client, g.player);
    assert.equal(pendingOrderMaterialSpends(g.player).length, 0);
  });
  await test('自然到港、其他航程和未达预期的缩短不确认加速', async () => {
    const f = fixture(), expected = f.plan().expected;
    const arrived = { cargo: { ...f.state.cargo, cityId: 20, moveToCityId: 0, moveEndTime: 0 } };
    assert.equal(merchantSpeedMatches(expected, arrived, expected.beforeEndTime + 1), false);
    assert.equal(merchantSpeedMatches(expected, arrived, expected.beforeEndTime - 1), true);
    arrived.cargo.moveStartTime += 1;
    assert.equal(merchantSpeedMatches(expected, arrived, now), false);
    f.state.cargo.moveEndTime -= 10;
    assert.equal(merchantSpeedMatches(expected, f.state, now), false);
  });
  await test('未知加速后已开始新航程，保留当日用针额度，完整库存回读后新航程可继续用针', async () => {
    const f = fixture(now - 6 * 3600);
    Object.assign(f.settings.merchant, { speedUpMode: 'full', keepPointers: 0, dailyPointerLimit: 8 });
    f.mode('unknown');
    await f.run();
    assert.equal(f.sent().length, 1);
    const used = f.sent()[0].body.useNum;
    const [key] = Object.entries(f.ledger.keyRecords()).find(([, r]) => r.details?.expected?.request === 'TradeSpeedRequest');
    f.mode('');
    f.client.serverClockOffsetMs += 7200000;
    Object.assign(f.state.cargo, { cityId: 20, moveToCityId: 10, moveStartTime: f.now + 7200, moveEndTime: f.now + 10800 });
    await f.run();
    assert.equal(f.ledger.keyRecords()[key].expired, true);
    assert.equal(f.ledger.keyRecords()[key].confirmed, false);
    assert.equal(f.ledger.confirmedCounters().merchantPointers ?? 0, 0);
    assert.equal(f.ledger.snapshot().counters.merchantPointers, used);
    assert.equal(f.sent().length, 1);
    await f.run();
    assert.equal(f.sent().length, 2);
    assert.equal(f.ledger.confirmedCounters().merchantPointers, f.sent()[1].body.useNum);
  });
  await test('满舱航线前期自然到港时保留指针，进入配置的收尾窗口才按已开启模式加速', () => {
    const f = fixture(now - 8 * 3600);
    Object.assign(f.settings.merchant, { fullCargoRoutes: true, speedUpMode: 'full', liquidationMinutes: 120 });
    assert.equal(f.plan().kind, 'none');
    f.event.endTime = f.now + 7100;
    assert.equal(f.plan().kind, 'speed');
    f.settings.merchant.autoSpeedUp = false;
    assert.equal(f.plan().kind, 'none');
    const closing = fixture();
    Object.assign(closing.settings.merchant, { fullCargoRoutes: true, speedUpMode: 'full' });
    assert.equal(closing.plan().useNum, 2, '收盘救航只用赶得及成交的根数');
  });
  console.log('海商王指针测试通过：' + passed + ' 项');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
