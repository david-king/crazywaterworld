import { runLoop } from '../src/loop.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUsageLedger,
  importAutomationSettings,
  exportAutomationSettings,
  validateSettings
} from '../src/automation-settings.mjs';
import {
  militaryRewards,
  riverActivity,
  compassActivity,
  beautyActivity,
  leadingCandidate
} from '../src/seasonal-activities.mjs';
import { merchantActivity, merchantProgress, readMerchantStatus, merchantJournalSummary, readMerchantJournal } from '../src/merchant-activity.mjs';
import { seasonalFixture } from './fixtures/seasonal-suite.mjs';
import { read } from '../src/activity-actions.mjs';
import { observeFreePointers } from '../src/merchant-free-pointers.mjs';
import { readMerchantDockBudget } from '../src/merchant-speed.mjs';
import { merchantPresets } from '../src/merchant-presets.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-')),
  file = () => path.join(folder, Math.random() + '.json');
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('通过：' + name);
}
function setup() {
  const f = seasonalFixture(),
    store = file(),
    ledger = createUsageLedger('fixture', { file: store }),
    reports = [];
  let enabled = true;
  const run = (service, key) =>
    service(f.client, f.config, {
      player: f.player,
      clientInfo: { appId: '14021170', channelId: '1400', originVersion: '74.0.0' },
      language: 'zh_CN',
      key,
      label: key,
      ledger,
      settings: () => f.settings,
      enabled: () => enabled,
      report: (r) => reports.push(r)
    });
  return {
    ...f,
    ledger,
    store,
    reports,
    run,
    pause: () => {
      enabled = false;
    },
    sent: (n) => f.state.writes.filter((r) => r.name === n)
  };
}
await test('军备五档积分与专属免费格分别领取，商城普通包与付费格不进入', async () => {
  const f = setup();
  await f.run(militaryRewards, 'armsRaceRewards');
  await f.run(militaryRewards, 'armsRaceRewards');
  assert.equal(f.sent('GetDailyRewardRequest').length, 1);
  assert.deepEqual(
    f.sent('LimitedShopGotFreeRequest').map((r) => r.body.id),
    [90000]
  );
  assert.equal(f.state.writes.length, 2);
});
await test('走江积分、战令及免费/广告助力分别回读，二次检查无重复', async () => {
  const f = setup();
  for (let i = 0; i < 2; i++)
    for (const key of ['riverScore', 'riverPass', 'riverHelp']) await f.run(riverActivity, key);
  assert.deepEqual(
    f.state.writes.map((r) => r.name),
    [
      'SnowballClaimRewardRequest',
      'BattlePassGotRewardRequest',
      'SnowballClaimGiftRequest',
      'WatchAdvRequest',
      'GotAdvRewardRequest'
    ]
  );
  assert.equal(f.sent('BattlePassGotRewardRequest')[0].body.type, 10);
  assert.deepEqual(f.sent('GotAdvRewardRequest')[0].body, { type: 4, id: 1001 });
});
await test('广告权益不足等待后领取，活动未开放不读写活动协议', async () => {
  const f = setup();
  f.player.vip.vipLevel = 0;
  f.settings.ads = { noPrivilege: false, waitSeconds: 0.01 };
  await f.run(riverActivity, 'riverHelp');
  assert.equal(f.sent('GotAdvRewardRequest').length, 1);
  f.client.festivals[0].subActivity[0].openTime = f.now + 100;
  const before = f.state.reads.length;
  await f.run(riverActivity, 'riverScore');
  assert.equal(f.state.reads.length, before);
});
await test('罗盘免费日包、库存阈值和每批数量，真实编码后仅消耗铜钱', async () => {
  const f = setup();
  await f.run(compassActivity, 'compassDaily');
  await f.run(compassActivity, 'compassDaily');
  await f.run(compassActivity, 'compassReward');
  await f.run(compassActivity, 'compassReward');
  assert.equal(f.sent('ClaimCompassWheelRewardRequest').length, 1);
  assert.equal(f.sent('ClaimFreeSelectGiftRequest').length, 1);
  await f.run(compassActivity, 'compassSpin');
  await f.run(compassActivity, 'compassSpin');
  assert.equal(f.sent('SpinCompassWheelRequest').length, 1);
  assert.equal(f.sent('SpinCompassWheelRequest')[0].body.num, 10);
  assert.equal(f.state.stock['活动26捞尸人_抽奖券'], 2);
  f.settings.eventActions.compassThreshold = 20;
  f.settings.eventActions.compassDrawCount = 5;
  f.state.stock['活动26捞尸人_抽奖券'] = 25;
  await f.run(compassActivity, 'compassSpin');
  assert.equal(f.sent('SpinCompassWheelRequest').at(-1).body.num, 5);
  f.state.wheel.cost.id = 'RUBY';
  await f.run(compassActivity, 'compassSpin');
  assert.equal(f.sent('SpinCompassWheelRequest').length, 2);
});
await test('罗盘未知结果跨账本实例防重，暂停或中途提阈值不会发送', async () => {
  const f = setup();
  f.state.mode = 'unknown';
  await f.run(compassActivity, 'compassSpin');
  f.state.mode = '';
  await compassActivity(f.client, f.config, {
    key: 'compassSpin',
    label: '罗盘',
    ledger: createUsageLedger('fixture', { file: f.store }),
    enabled: () => true,
    settings: () => f.settings,
    report: (r) => f.reports.push(r)
  });
  assert.equal(f.sent('SpinCompassWheelRequest').length, 1);
  assert(f.reports.some((r) => r.status === 'pending' || r.reason?.includes('待确认')));
  const g = setup();
  let reads = 0;
  g.state.onRead = (name) => {
    if (name === 'AllItem' && ++reads === 2) g.settings.eventActions.compassThreshold = 30;
  };
  await g.run(compassActivity, 'compassSpin');
  assert.equal(g.state.writes.length, 0);
  const h = setup();
  h.pause();
  await h.run(compassActivity, 'compassSpin');
  assert.equal(h.state.writes.length, 0);
});
await test('风采只按服务端票数，平票按编号，当日已投1票补2票并领包', async () => {
  const f = setup();
  assert.equal(leadingCandidate(f.state.beauty, f.config).no, 620);
  for (let i = 0; i < 2; i++) {
    await f.run(beautyActivity, 'beautyVotes');
    await f.run(beautyActivity, 'beautyGift');
  }
  assert.deepEqual(
    f.sent('BeautyVoteRequest').map((r) => r.body),
    [{ no: 620, count: 2 }]
  );
  assert.equal(f.sent('GotBeautyVoteRequest').length, 1);
  assert.equal(f.state.stock['代颜人投票券'], 7);
  assert.equal(f.state.beauty.todayVote, 3);
});
await test('投票券不足只投已有数量，展示期和未知结果不重复投票', async () => {
  const f = setup();
  f.state.stock['代颜人投票券'] = 1;
  f.state.mode = 'unknown';
  await f.run(beautyActivity, 'beautyVotes');
  f.state.mode = '';
  f.state.beauty.player[0].vote = 100;
  await f.run(beautyActivity, 'beautyVotes');
  assert.equal(f.sent('BeautyVoteRequest').length, 1);
  const g = setup();
  g.client.beautyWindow.endTime = g.now;
  await g.run(beautyActivity, 'beautyVotes');
  assert.equal(g.state.writes.length, 0);
});
await test('海商王真实行情模型低价买入、按商情走商、到港盈利出售', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeBuyRequest')[0].body, { cityId: 10, goodsId: 1001, buyNum: 250 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeMoveRequest')[0].body, { cityId: 10, mvToCityId: 20 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 2);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  f.state.markets[20].goods[0].price = 30;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 0);
  f.state.markets[20].goods[0].price = 65;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert(f.state.trade.player.profit > 6000);
});
await test('无紧缺共享时仍可买入并走普通港，到港出售不依赖商情', async () => {
  const f = setup();
  for (const port of f.state.radar.radar) port.rareGoodsId = 0;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  const radar = f.state.radar.radar;
  f.state.radar.radar = [];
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  f.state.radar.radar = radar;
  f.state.markets[20].goods = [{ goodsId: 1002, price: 10, stock: 0 }, { goodsId: 1004, price: 35, stock: 0 }];
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest')[1].body.goodsId, 1004);
  const empty = setup();
  empty.state.radar.radar = [];
  await empty.run(merchantActivity, 'merchantTrade');
  assert.equal(empty.state.writes.length, 0, '港口列表完全未知时不盲目装货或选取世界城市');
});
await test('休市期间预览与执行均可提前出航，抵港后等到开市重新核价出售', async () => {
  const f = setup();
  const setHour = hour => { f.client.serverClockOffsetMs = (f.now + (hour - 12) * 3600) * 1000 - Date.now(); };
  const run = () => f.run(merchantActivity, 'merchantTrade');
  setHour(21.75);
  await run();
  assert.equal(f.state.writes[0].name, 'TradeBuyRequest');
  setHour(23);
  Object.assign(f.settings.merchant, { autoUpgrade: true, autoShareIntel: true, autoSpeedUp: true, speedUpMode: 'full' });
  f.state.trade.player.profit = 10000;
  f.state.diamonds = 300;
  f.state.stock['海商王加速'] = 4;
  f.state.markets[10].isReport = false;
  const preview = await merchantProgress(f.config, f.client.tradeWindow, f.state.trade, f.player, f.now + 11 * 3600,
    async name => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[10], f.ledger, f.settings);
  assert.match(preview, /提前出航/);
  await run();
  await run();
  assert.deepEqual(f.state.writes.map(row => row.name), ['TradeBuyRequest', 'TradeMoveRequest']);
  setHour(25);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  f.state.markets[20].isReport = false;
  await run();
  assert.match(f.reports.at(-1).reason, /开市后重新核价/);
  assert.equal(f.state.writes.length, 2);
  setHour(34);
  f.settings.merchant.autoUpgrade = false;
  f.settings.merchant.autoShareIntel = false;
  f.state.markets[20].goods[0].price = 72;
  await run();
  assert.deepEqual(f.state.writes.map(row => row.name), ['TradeBuyRequest', 'TradeMoveRequest', 'TradeSellRequest']);
  assert.equal(f.state.trade.player.coins, 18240, '开市报价 72，按 1 级船的 3% 利润加成结算');
});
await test('活动首日零点空船提前避开同盟在途船，等到十点读取新价采购', async () => {
  const f = setup(), start = f.now - 12 * 3600, opening = start + 10 * 3600;
  f.client.tradeWindow.startTime = start;
  f.settings.merchant.autoShareIntel = false;
  const setTime = t => { f.client.serverClockOffsetMs = t * 1000 - Date.now(); };
  const run = () => f.run(merchantActivity, 'merchantTrade');
  f.state.trade.worldCargo = [{ playerId: '1234', guildIdx: 1, cargo: {
    cityId: 30, moveToCityId: 10, moveStartTime: start, moveEndTime: start + 7200 } }];
  setTime(start);
  await run();
  assert.deepEqual(f.state.writes.map(w => w.name), ['TradeMoveRequest']);
  assert.equal(f.state.trade.cargo.moveToCityId, 20);
  const snapshot = readMerchantJournal(f.ledger, f.client.tradeWindow).find(r => r.type === 'snapshot');
  assert.equal(snapshot.radar.radar.find(p => p.cityId === 10).openingShips, 1);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  setTime(opening - 1);
  await run();
  assert.equal(f.state.writes.length, 1);
  f.state.markets[20] = { specGoodsId: 1002, rareGoodsId: 1001, isReport: true, goods: [{ goodsId: 1002, price: 10, stock: 0 }] };
  setTime(opening);
  await run();
  assert.deepEqual(f.state.writes.map(w => w.name), ['TradeMoveRequest', 'TradeBuyRequest'], JSON.stringify(f.reports.at(-1)));
  assert.deepEqual([f.state.trade.player.goods[0].goodsId, f.state.trade.player.goods[0].buyPrice], [1002, 10]);
});
await test('为次日备货的买单在发送前跨过今日收盘时撤销', async () => {
  const f = setup();
  const close = f.now + 10 * 3600;
  f.client.serverClockOffsetMs = (close - 10) * 1000 - Date.now();
  const reserve = f.ledger.reserve;
  let checked = false;
  f.ledger.reserve = (...args) => {
    const ticket = reserve(...args);
    if (args[3]?.details?.expected?.request === 'TradeBuyRequest') {
      checked = true;
      f.client.serverClockOffsetMs = close * 1000 - Date.now();
    }
    return ticket;
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert(checked);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.ledger.snapshot().uncertain, 0);
});
await test('隔夜满舱跨重启按开市实价清完亏损和平价批次，再买首轮新货', async () => {
  for (const stopAtProfitLimit of [false, true]) {
    const f = setup(), trade = f.state.trade;
    const setHour = hour => { f.client.serverClockOffsetMs = (f.now + (hour - 12) * 3600) * 1000 - Date.now(); };
    const run = () => merchantActivity(f.client, f.config, { player: f.player, key: 'merchantTrade', label: '海商王',
      ledger: createUsageLedger('fixture', { file: f.store }), settings: () => f.settings, enabled: () => true,
      report: r => f.reports.push(r) });
    trade.player.coins = 100000;
    f.settings.merchant.maxLossPercent = 0;
    f.state.markets[10].goods = [{ goodsId: 1001, price: 70, stock: 59400 }, { goodsId: 1004, price: 80, stock: 59600 }];
    setHour(21.5);
    await run();
    await run();
    assert.deepEqual(trade.player.goods.map(b => b.num), [600, 400]);
    await run();
    assert.deepEqual(f.state.writes.map(w => w.name), ['TradeBuyRequest', 'TradeBuyRequest', 'TradeMoveRequest']);
    setHour(25);
    Object.assign(trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
    await run();
    assert.equal(f.state.writes.length, 3);
    setHour(34);
    if (stopAtProfitLimit) f.settings.merchant.profitLimit = trade.player.profit;
    f.state.markets[20].goods = [{ goodsId: 1001, price: 20, stock: 0 }, { goodsId: 1003, price: 10, stock: 0 }];
    const profit = trade.player.profit;
    await run();
    assert.equal(f.sent('TradeSellRequest')[0].body.sellNum, 600);
    assert.equal(trade.player.profit, profit, '亏损只影响周转本金');
    await run();
    assert.equal(f.state.writes.length, 4, '剩余隔夜货暂缺实价时先等报价，不能抢先采购或换港');
    f.state.markets[20].goods.push({ goodsId: 1004, price: 80, stock: 0 });
    await run();
    assert.deepEqual(trade.player.goods, []);
    assert.equal(trade.player.coins, 70000);
    await run();
    const afterArrival = f.state.writes.slice(3).map(w => w.name);
    assert.deepEqual(afterArrival, stopAtProfitLimit ? ['TradeSellRequest', 'TradeSellRequest'] :
      ['TradeSellRequest', 'TradeSellRequest', 'TradeBuyRequest']);
    if (!stopAtProfitLimit) assert.equal(trade.player.goods[0].goodsId, 1003);
  }
});
await test('大跌幅但少量库存不再压过整船收益，售罄商品不进入组合', async () => {
  for (const remaining of [1, 0]) {
    const f = setup();
    f.state.radar.radar[1].specGoodsId = 1003;
    f.state.markets[10].goods = [
      { goodsId: 1001, price: 10, stock: 60000 - remaining },
      { goodsId: 1004, price: 35, stock: 0 }
    ];
    await f.run(merchantActivity, 'merchantTrade');
    const buy = f.sent('TradeBuyRequest')[0].body;
    assert.equal(buy.goodsId, 1004);
    assert.equal(buy.buyNum, 285);
    await f.run(merchantActivity, 'merchantTrade');
    if (remaining) assert.deepEqual(f.sent('TradeBuyRequest')[1].body, { cityId: 10, goodsId: 1001, buyNum: 1 });
    else assert.equal(f.sent('TradeBuyRequest').length, 1);
  }
});
await test('多商品组合逐笔复查采购，夹具更新库存并为每批分配唯一编号', async () => {
  const f = setup();
  f.state.radar.radar[1].specGoodsId = 1003;
  f.state.markets[10].goods = [
    { goodsId: 1001, price: 20, stock: 59990 },
    { goodsId: 1004, price: 30, stock: 59980 }
  ];
  await f.run(merchantActivity, 'merchantTrade');
  assert(f.reports.some(row => /组合 2 种/.test(row.label)));
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeBuyRequest').map(row => [row.body.goodsId, row.body.buyNum]), [[1004, 20], [1001, 10]]);
  assert.equal(f.state.trade.player.coins, 9200);
  assert.equal(new Set(f.state.trade.player.goods.map(g => g.pid)).size, 2);
  assert.deepEqual(f.state.markets[10].goods.map(g => g.stock), [60000, 60000]);
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeMoveRequest')[0].body, { cityId: 10, mvToCityId: 20 });
});
await test('雷达读取失败仍核对本港利润出售，空船没有可靠港口列表时不盲目行动', async () => {
  for (const loaded of [true, false]) {
    const f = setup();
    f.state.onRead = name => { if (name === 'TradeGuildRadar') throw Error('联盟商情暂不可用'); };
    if (loaded) f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 20, buyPrice: 20, num: 10 }];
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeSellRequest').length, loaded ? 1 : 0);
    assert.equal(f.sent('TradeBuyRequest').length, 0);
    assert.equal(f.sent('TradeMoveRequest').length, 0);
  }
});
await test('同商品不同成本逐批出售，保留来源为当前港的批次', async () => {
  const f = setup();
  f.state.trade.cargo.cityId = 20;
  f.state.radar.radar = [];
  f.state.trade.player.goods = [
    { pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 },
    { pid: 202, goodsId: 1001, cityId: 30, buyPrice: 60, num: 10 },
    { pid: 203, goodsId: 1001, cityId: 20, buyPrice: 10, num: 5 }
  ];
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeSellRequest')[0].body, { cityId: 20, pid: 201, sellNum: 10 });
  assert.equal(f.state.trade.player.profit, 6258);
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.sent('TradeSellRequest')[1].body, { cityId: 20, pid: 202, sellNum: 10 });
  assert.equal(f.state.trade.player.profit, 6310);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 2);
  assert.deepEqual(f.state.trade.player.goods.map(g => g.pid), [203]);
});
await test('清仓按批次亏损上限出售，不对亏损加成或扣累计利润', async () => {
  for (const maxLossPercent of [0, 10]) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 1800;
    f.settings.merchant.maxLossPercent = maxLossPercent;
    f.state.radar.radar = [];
    f.state.trade.player.goods = [
      { pid: 201, goodsId: 1001, cityId: 20, buyPrice: 44, num: 10 },
      { pid: 202, goodsId: 1001, cityId: 20, buyPrice: 60, num: 10 }
    ];
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeSellRequest').length, maxLossPercent ? 1 : 0);
    assert.equal(f.state.trade.player.profit, 6000);
    if (maxLossPercent) {
      assert.equal(f.sent('TradeSellRequest')[0].body.pid, 201);
      assert.equal(f.state.trade.player.coins, 10400);
      const records = Object.values(f.ledger.keyRecords()).filter(row => row.details?.expected?.request === 'TradeSellRequest');
      assert.equal(records.length, 1);
      assert.equal(records[0].confirmed, true, '亏损成交也须确认防重记录');
      await f.run(merchantActivity, 'merchantTrade');
      assert.equal(f.sent('TradeSellRequest').length, 1, '超过止损比例的批次仍持有');
    }
  }
});
await test('已售完、价格变化、非交易时段及临近结束不买入', async () => {
  for (const mutate of [
    (f) => (f.state.markets[10].goods[0].stock = 60000),
    (f) => (f.client.serverClockOffsetMs += 11 * 3600000),
    (f) => (f.client.tradeWindow.endTime = f.now + 400),
    (f) => {
      let n = 0;
      f.state.onRead = (name) => {
        if (name === 'TradeCity' && ++n === 2) f.state.markets[10].goods[0].price = 80;
      };
    }
  ]) {
    const f = setup();
    mutate(f);
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeBuyRequest').length, 0);
  }
});
await test('发送前库存变化、暂停和策略变化均撤销旧采购计划', async () => {
  for (const update of [
    f => { f.state.markets[10].goods[0].stock = 59999; },
    f => { f.state.markets[10].goods[0].price = 41; },
    f => { Object.assign(f.state.markets[10], { specGoodsId: 1003, rareGoodsId: 1001 }); },
    f => f.pause(),
    f => { f.settings.merchant.minExpectedProfit = 100000; }
  ]) {
    const f = setup();
    let reads = 0;
    f.state.onRead = name => { if (name === 'TradeCity' && ++reads === 2) update(f); };
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.state.writes.length, 0);
    assert(!Object.values(f.ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  }
});
await test('同批货无利润寻价跨刷新与重载后不往返，换新货同周期可重访', async () => {
  const seed = () => {
    const f = setup();
    f.state.trade.player.coins = 0;
    f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 30, buyPrice: 100, num: 10 }];
    f.state.radar.radar[0].specGoodsId = 1003;
    f.state.radar.radar.forEach(port => { port.rareGoodsId = 0; });
    f.state.markets[20].goods[0].price = 40;
    return f;
  };
  const f = seed();
  f.state.trade.player.goods.push({ pid: 202, goodsId: 1002, cityId: 30, buyPrice: 100, num: 5 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  assert.match(f.reports.at(-1).label, /寻价/);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  f.state.trade.player.goods.reverse(); // 服务端只调整批次返回顺序，不应开启重复寻价。
  const restarted = createUsageLedger('fixture', { file: f.store });
  for (let i = 0; i < 2; i++) await merchantActivity(f.client, f.config, {
    player: f.player, key: 'merchantTrade', label: '海商王', ledger: restarted,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row)
  });
  assert.equal(f.sent('TradeMoveRequest').length, 1, '同货舱和资金不因两小时刷新或重启重走已离开的港');

  const g = seed();
  await g.run(merchantActivity, 'merchantTrade');
  const first = Object.values(g.ledger.keyRecords()).find(row => row.details?.expected?.request === 'TradeMoveRequest');
  assert(first.details.expected.cargoSignature);
  // 模拟游戏内手动加速到港，仍在同一次市场刷新周期；卖货后资金和持货均变化。
  g.client.serverClockOffsetMs += 60000;
  Object.assign(g.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  g.state.markets[20].goods[0].price = 120;
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeSellRequest').length, 1);
  g.state.markets[20].goods = [{ goodsId: 1004, price: 20, stock: 0 }];
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeBuyRequest')[0].body.goodsId, 1004);
  await g.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(g.sent('TradeMoveRequest').map(row => row.body.mvToCityId), [20, 10]);
  const legs = Object.values(g.ledger.keyRecords()).filter(row => row.details?.expected?.request === 'TradeMoveRequest');
  assert.equal(legs[0].details.expected.marketEpoch, legs[1].details.expected.marketEpoch);
  assert.notEqual(legs[0].details.expected.cargoSignature, legs[1].details.expected.cargoSignature);
});
await test('动作预留后跨过整船采购或多批出售截止，取消发送且不遗留待确认记录', async () => {
  for (const kind of ['buy', 'move']) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 7200 + (kind === 'buy' ? 190 : 130);
    if (kind === 'move') {
      f.state.trade.player.coins = 0;
      f.state.trade.player.goods = [
        { pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 },
        { pid: 202, goodsId: 1002, cityId: 10, buyPrice: 40, num: 10 }
      ];
      f.state.radar.radar[1].specGoodsId = 1003;
    }
    const reserve = f.ledger.reserve;
    let reservations = 0;
    f.ledger.reserve = (...args) => {
      const ticket = reserve(...args);
      if (args[3]?.uniqueKey?.startsWith('event-action:')) {
        assert.equal(args[3].details.expected.request, kind === 'buy' ? 'TradeBuyRequest' : 'TradeMoveRequest');
        reservations++;
        f.client.serverClockOffsetMs += 11000;
      }
      return ticket;
    };
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(reservations, 1, '必须已计划且预留动作，不能由提前等待掩盖门控');
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert(!Object.keys(f.ledger.keyRecords()).some(key => key.startsWith('event-action:')));
  }
});
await test('每轮间隔五分钟时停止来不及完成的采购，展示预览使用相同间隔', async () => {
  const f = setup();
  f.client.tradeWindow.endTime = f.now + 7200 + 190;
  const preview = () => merchantProgress(f.config, f.client.tradeWindow, f.state.trade, f.player, f.now,
    async name => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[f.state.trade.cargo.cityId], f.ledger, f.settings);
  assert.match(await preview(), /计划买入：/, '一分钟轮询下此窗口足够采购、航行和出售');
  f.settings.loop.everySeconds = 300;
  f.settings.merchant.monitorSeconds = 300;
  assert.doesNotMatch(await preview(), /计划买入：/, '五分钟轮询不能继续使用每步一分钟估计');
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 0);
  assert.equal(f.state.writes.length, 0);
});
await test('真实运行间隔优先于较短配置，直接服务和挂机入口均阻止超时采购', async () => {
  const direct = setup();
  direct.client.tradeWindow.endTime = direct.now + 7200 + 190;
  await merchantActivity(direct.client, direct.config, {
    player: direct.player, key: 'merchantTrade', label: '海商王', ledger: direct.ledger,
    everyMs: 300000, settings: () => direct.settings, enabled: () => true, report: row => direct.reports.push(row)
  });
  assert.equal(direct.settings.loop.everySeconds, 60);
  assert.equal(direct.sent('TradeBuyRequest').length, 0);
  for (const everyMs of [60000, 300000]) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 7200 + 190;
    Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
    f.settings.schedule.merchantTrade = true;
    f.settings.merchant.monitorSeconds = everyMs / 1000;
    await runLoop(f.client, f.protocol, {
      config: f.config, player: f.player, rounds: 1, allowMutate: true,
      isEnabled: key => key === 'merchantTrade', getSettings: () => f.settings,
      everyMs: 60000, getEveryMs: () => everyMs, usageLedger: f.ledger, sleep: async () => {}
    });
    assert(f.state.reads.includes('TradeInfoRequest'), '必须通过真实挂机入口执行海商王状态检查');
    assert.equal(f.sent('TradeBuyRequest').length, everyMs === 60000 ? 1 : 0);
  }
});
await test('复查或动作预留期间调大轮询间隔，配置与挂机动态间隔均取消旧动作', async () => {
  for (const stage of ['second-read', 'reservation', 'loop-reservation']) {
    const f = setup();
    f.client.tradeWindow.endTime = f.now + 7200 + 190;
    let changed = false, actualEveryMs = 60000;
    const change = () => {
      changed = true;
      f.settings.merchant.monitorSeconds = 300;
      if (stage === 'loop-reservation') actualEveryMs = 300000;
      else f.settings.loop.everySeconds = 300;
    };
    if (stage === 'second-read') {
      let reads = 0;
      f.state.onRead = name => { if (name === 'TradeCity' && ++reads === 2) change(); };
    } else {
      const reserve = f.ledger.reserve;
      f.ledger.reserve = (...args) => {
        const ticket = reserve(...args);
        if (args[3]?.uniqueKey?.startsWith('event-action:')) change();
        return ticket;
      };
    }
    if (stage === 'loop-reservation') {
      Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
      f.settings.schedule.merchantTrade = true;
      await runLoop(f.client, f.protocol, {
        config: f.config, player: f.player, rounds: 1, allowMutate: true,
        isEnabled: key => key === 'merchantTrade', getSettings: () => f.settings,
        getEveryMs: () => actualEveryMs, usageLedger: f.ledger, sleep: async () => {}
      });
    } else await f.run(merchantActivity, 'merchantTrade');
    assert.equal(changed, true, '确保间隔在已产生采购计划后变化');
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert(!Object.keys(f.ledger.keyRecords()).some(key => key.startsWith('event-action:')));
  }
});
await test('满舱往返真实入口：刷新前后分两批采购，复查少一格取消发船，抵港按实价逐批出售', async () => {
  const f = setup();
  f.settings.merchant.fullCargoRoutes = true;
  f.state.trade.player.coins = 50000;
  const quote = f.state.markets[10].goods[0];
  quote.stock = 59600;
  const step = () => f.run(merchantActivity, 'merchantTrade');
  f.client.serverClockOffsetMs = (f.now - 60) * 1000 - Date.now();
  await step();
  assert.equal(f.sent('TradeBuyRequest')[0].body.buyNum, 400);
  await step();
  assert.equal(f.state.writes.length, 1);
  f.client.serverClockOffsetMs = (f.now + 60) * 1000 - Date.now();
  Object.assign(quote, { stock: 0, price: 38 });
  await step();
  assert.equal(f.sent('TradeBuyRequest')[1].body.buyNum, 600);
  let reads = 0;
  f.state.onRead = name => {
    if (name === 'TradeInfo' && ++reads === 2) f.state.trade.player.goods[1].num--;
  };
  await step();
  assert.equal(f.sent('TradeMoveRequest').length, 0);
  f.state.onRead = null;
  f.state.trade.player.goods[1].num++;
  await step();
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  Object.assign(f.state.markets[20], { specGoodsId: 1002, rareGoodsId: 1001 });
  await step(); await step();
  assert.equal(f.sent('TradeSellRequest').length, 2);
  assert.equal(f.state.trade.player.goods.length, 0);
});
await test('海商王进度区分持仓、计划商品和城池；无共享仍显示并执行出售', async () => {
  const f = setup();
  const progress = () => merchantProgress(f.config, f.window, f.state.trade, f.player, f.now,
    async (name) => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[f.state.trade.cargo.cityId], f.ledger, f.settings);
  const buy = await progress();
  assert.match(buy, /当前船货：空载/);
  assert.match(buy, /计划买入：.+目标城池：/);
  assert.match(buy, /预期收益：约 2,575 商会币/);
  await f.run(merchantActivity, 'merchantTrade');
  await f.run(merchantActivity, 'merchantTrade');
  const sailing = await progress();
  assert.match(sailing, /当前船货：.+ ×250/);
  assert.match(sailing, /目标城池：.+航行中/);
  assert.match(sailing, /预期收益：约 2,575 商会币/);
  Object.assign(f.state.trade.cargo, { cityId: 20, moveToCityId: 0, moveEndTime: 0 });
  assert.match(await progress(), /计划卖出：.+目标城池：.+预期收益：约 6,438 商会币/);
  for (const port of f.state.radar.radar) port.rareGoodsId = 0;
  assert.match(await progress(), /计划卖出：.+目标城池：/);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.state.writes.length, 3);
});
await test('整船货单合并同种货，靠港卸货后仍可查看本航程的出港货单', async () => {
  const f = setup();
  const cargo = f.state.trade.cargo;
  const water = { pid: 1, goodsId: 1002, num: 1, cityId: 34, buyPrice: 50 };
  const goods = [water, { pid: 2, goodsId: 4006, num: 57, cityId: 37, buyPrice: 687 },
    { pid: 3, goodsId: 3008, num: 1, cityId: 37, buyPrice: 253 },
    { pid: 4, goodsId: 2001, num: 2, cityId: 37, buyPrice: 119 }, { ...water, pid: 5, cityId: 37, buyPrice: 48 }];
  const scope = 'merchant:' + f.window.startTime + ':' + f.window.period;
  const start = f.now - 7200;
  const move = { scope, expected: { request: 'TradeMoveRequest', city: 37, destination: 67, start, estimatedProfit: 12000 },
    before: { goods } };
  const records = { move: { confirmed: true, details: move } };
  const preview = () => merchantProgress(f.config, f.window, f.state.trade, f.player, f.now,
    () => assert.fail('只读货单不需要询价'), { keyRecords: () => records });
  const manifest = '防风门窗 ×57、淡水 ×2、鱼油 ×2、鱼胶汤 ×1（共 62 件）';
  f.state.trade.player.goods = goods;
  Object.assign(cargo, { cityId: 37, moveToCityId: 67, moveStartTime: start, moveEndTime: f.now + 1 });
  assert((await preview()).includes('当前船货：' + manifest));
  Object.assign(cargo, { cityId: 67, moveToCityId: 0, moveStartTime: 0, moveEndTime: 0 });
  f.player.guildId = '0';
  f.state.trade.player.goods = [goods[0], goods[4]];
  assert((await preview()).includes('当前船货：淡水 ×2 · 上次出港船货：' + manifest));
  f.state.trade.player.goods = [];
  assert((await preview()).includes('当前船货：空载 · 上次出港船货：' + manifest));
  records.move.confirmed = false;
  assert.doesNotMatch(await preview(), /上次出港船货/);
  records.move.confirmed = true;
  cargo.cityId = 37;
  assert.doesNotMatch(await preview(), /上次出港船货/);
});
await test('航行中沿用出发估值，旧记录按同期快照还原，寻价或缺少依据时保留待定', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantTrade');
  await f.run(merchantActivity, 'merchantTrade');
  const records = f.ledger.keyRecords();
  const move = Object.values(records).find(row => row.details?.expected?.request === 'TradeMoveRequest');
  const expected = move.details.expected;
  const progress = () => merchantProgress(f.config, f.window, f.state.trade, f.player, f.now,
    () => assert.fail('航行中不应查询港口报价'), { keyRecords: () => records });
  assert.equal(expected.estimatedProfit, 2575);
  delete expected.estimatedProfit;
  assert.match(await progress(), /预期收益：约 2,575 商会币/);
  delete records['merchant-journal:' + f.window.startTime + ':' + f.window.period];
  assert.match(await progress(), /预期收益：待估算/);
  for (const amount of [0, -100]) {
    expected.estimatedProfit = amount;
    assert.match(await progress(), new RegExp('预期收益：约 ' + amount + ' 商会币'));
  }
  expected.exploration = true;
  assert.match(await progress(), /预期收益：待到港询价/);
  f.state.trade.cargo.moveStartTime -= 3600;
  assert.match(await progress(), /预期收益：待估算/);
});
await test('展示计划使用传入策略且不写账本或刷新本港历史时间戳', async () => {
  const f = setup();
  const preview = settings => merchantProgress(f.config, f.window, f.state.trade, f.player, f.now,
    async name => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[f.state.trade.cargo.cityId], f.ledger, settings);
  assert.equal(fs.existsSync(f.store), false);
  assert.match(await preview(f.settings), /计划买入：/);
  assert.equal(fs.existsSync(f.store), false);
  f.settings.merchant.minExpectedProfit = 1000000000;
  assert.doesNotMatch(await preview(f.settings), /计划买入：/);
  f.ledger.confirm(f.ledger.reserve({}, {}, {}, { uniqueKey: 'preview-marker', details: { observedAt: f.now - 60 } }));
  const before = fs.readFileSync(f.store, 'utf8');
  await preview(f.settings);
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
  assert.equal(f.state.writes.length, 0);
});
await test('海商王买入回包丢失，回读核对持仓后才进入下一步', async () => {
  const f = setup();
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = '';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(f.sent('TradeMoveRequest').length, 0);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
});
await test('真实活动入口保留采购原before，未知重连后日志只补确认一次', async () => {
  const f = setup(), before = structuredClone(f.state.trade.player);
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  const [actionKey, record] = Object.entries(f.ledger.keyRecords()).find(([, row]) => row.details?.expected?.request === 'TradeBuyRequest');
  assert.equal(record.confirmed, false);
  assert.equal(record.details.before.coins, before.coins);
  assert.deepEqual(record.details.before.goods, before.goods);
  assert(Number.isSafeInteger(record.details.attemptedAt));
  let summary = merchantJournalSummary(f.ledger, f.client.tradeWindow, { time: f.now });
  assert.equal(summary.unknownActions, 1);
  assert.equal(summary.buyCost, 0);
  f.state.mode = '';
  f.client.serverClockOffsetMs += 60000;
  const reopened = createUsageLedger('fixture', { file: f.store });
  await merchantActivity(f.client, f.config, { player: f.player, key: 'merchantTrade', label: '海商王', ledger: reopened,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row) });
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(reopened.keyRecords()[actionKey].confirmed, true);
  assert.equal(reopened.keyRecords()[actionKey].details.before.coins, before.coins);
  summary = merchantJournalSummary(reopened, f.client.tradeWindow, { time: f.now + 60 });
  assert.equal(summary.unknownActions, 0);
  assert.equal(summary.buys, 1);
  assert.equal(summary.buyCost, 10000);
  assert.equal(summary.batches[0].purchasedAt, record.details.attemptedAt);
  assert.equal(readMerchantJournal(reopened).filter(row => row.type === 'trade' && row.expected.request === 'TradeBuyRequest').length, 1);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(merchantJournalSummary(reopened, f.client.tradeWindow).buyCost, 10000);
});
await test('售出未知恢复用原批次成本记录实际收益，不把期初累计利润当本轮收益', async () => {
  const f = setup();
  f.state.trade.cargo.cityId = 20;
  f.state.radar.radar = [];
  f.state.trade.player.goods = [{ pid: 501, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).realizedProfit, 0);
  f.state.mode = '';
  const reopened = createUsageLedger('fixture', { file: f.store });
  await merchantActivity(f.client, f.config, { player: f.player, key: 'merchantTrade', label: '海商王', ledger: reopened,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row) });
  const summary = merchantJournalSummary(reopened, f.client.tradeWindow);
  assert.equal(summary.sellProceeds, 658);
  assert.equal(summary.realizedProfit, 258);
  assert.equal(summary.sells, 1);
  assert.equal(summary.unknownActions, 0);
  assert.equal(f.sent('TradeSellRequest').length, 1);
});
await test('旧版未知执行记录缺before仍可恢复，成交统计不虚构历史成本', async () => {
  const f = setup();
  f.state.trade.player.coins = 0;
  f.state.trade.player.goods = [{ pid: 600, goodsId: 1001, cityId: 10, buyPrice: 40, num: 250 }];
  const scope = 'merchant:' + f.client.tradeWindow.startTime + ':' + f.client.tradeWindow.period;
  f.ledger.reserve({}, {}, {}, { uniqueKey: 'event-action:legacy-merchant-buy', details: { scope,
    expected: { request: 'TradeBuyRequest', city: 10, goodsId: 1001, price: 40, owned: 250, coins: 0 } } });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.keyRecords()['event-action:legacy-merchant-buy'].confirmed, true);
  assert.equal(f.state.writes.length, 0);
  const summary = merchantJournalSummary(f.ledger, f.client.tradeWindow);
  assert.equal(summary.buyCost, 0);
  assert.equal(summary.buys, 0);
  assert.equal(summary.unverifiedConfirmations, 1);
});
await test('只读实时诊断不交易、不补确认、不写日志且航行不读异地报价', async () => {
  const f = setup();
  assert.equal(fs.existsSync(f.store), false);
  const first = await readMerchantStatus(f.client, f.config, { player: f.player, ledger: f.ledger, settings: f.settings });
  assert.equal(first.available, true);
  assert.equal(first.plan.kind, 'buy');
  assert.equal(f.state.writes.length, 0);
  assert.equal(fs.existsSync(f.store), false, '查询不能创建行情或交易账本');
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = '';
  const before = fs.readFileSync(f.store, 'utf8'), writeCount = f.state.writes.length;
  await readMerchantStatus(f.client, f.config, { player: f.player, ledger: f.ledger, settings: f.settings });
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
  assert.equal(f.state.writes.length, writeCount);
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).unknownActions, 1);
  Object.assign(f.state.trade.cargo, { moveStartTime: f.now, moveEndTime: f.now + 7200, moveToCityId: 20 });
  const start = f.state.reads.length;
  const sailing = await readMerchantStatus(f.client, f.config, { player: f.player, ledger: f.ledger, settings: f.settings });
  assert.match(sailing.plan.reason, /航行中/);
  assert.deepEqual(f.state.reads.slice(start), ['TradeInfoRequest']);
  assert.equal(fs.readFileSync(f.store, 'utf8'), before);
});
await test('累计利润未解锁下一级时继续普通采购', async () => {
  for (const diamondsAllowed of [false, true]) {
    const f = setup();
    f.settings.merchant.autoUpgrade = true;
    f.settings.resources.allowDiamonds = diamondsAllowed;
    f.settings.resources.diamondDailyLimit = 0;
    f.state.trade.player.profit = 9999;
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.sent('TradeCargoUpgradeRequest').length, 0);
    assert.equal(f.sent('TradeBuyRequest').length, 1);
    assert.equal(f.reports.at(-1).status, 'confirmed');
  }
});
await test('贸易入口在采购或出售前先用实际余额升满，下一轮恢复交易', async () => {
  const f = setup();
  Object.assign(f.settings.merchant, { autoUpgrade: true, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 300 });
  f.state.trade.player.profit = 1000000;
  f.state.diamonds = 4100;
  for (const level of [2, 3, 4, 5]) {
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.state.trade.cargo.cargoLv, level);
  }
  assert.equal(f.state.diamonds, 0);
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.state.writes.map(row => row.name), [...Array(4).fill('TradeCargoUpgradeRequest'), 'TradeBuyRequest']);
});
await test('自然航程仅够处理一批时按可实现高收益子集选港并到港售出', async () => {
  const f = setup();
  f.settings.merchant.liquidationMinutes = 0;
  f.client.tradeWindow.endTime = f.now + 7200 + 90;
  f.state.trade.player.coins = 0;
  f.state.trade.player.goods = [
    { pid: 701, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 },
    { pid: 702, goodsId: 1002, cityId: 10, buyPrice: 20, num: 10 }
  ];
  f.state.radar.radar[1].specGoodsId = 1003;
  f.state.markets[20].goods.push({ goodsId: 1002, price: 65, stock: 0 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  assert.match(f.reports.at(-1).label, /预计释放舱位 10/);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveEndTime: 0, moveToCityId: 0 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest')[0].body.pid, 702);
  assert.deepEqual(f.state.trade.player.goods.map(g => g.pid), [701]);
  assert.equal(f.sent('TradeSpeedRequest').length, 0);
  f.client.serverClockOffsetMs += 91000;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1, '活动截止后不继续处置剩余批次');
});
await test('收盘前仅够买卖一种货时，按自然航行完成最高收益批次', async () => {
  const f = setup();
  f.client.serverClockOffsetMs += (7 * 3600 + 56 * 60 + 45) * 1000;
  f.state.radar.radar[1].specGoodsId = 1008;
  f.state.markets[10].goods = [{ goodsId: 1001, price: 40, stock: 59900 }, { goodsId: 1004, price: 30, stock: 59700 }];
  f.state.markets[20].goods = [{ goodsId: 1004, price: 45, stock: 0 }];
  const before = f.state.trade.player.profit;
  await f.run(merchantActivity, 'merchantTrade');
  const [buy] = f.sent('TradeBuyRequest');
  assert.equal(buy.body.goodsId, 1004); assert.equal(buy.body.buyNum, 300);
  f.client.serverClockOffsetMs += 60000;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  f.client.serverClockOffsetMs += 7200000;
  Object.assign(f.state.trade.cargo, { cityId: 20, moveEndTime: 0, moveToCityId: 0 });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.trade.player.profit - before, 4635);
  assert.deepEqual(f.state.writes.map(row => row.name), ['TradeBuyRequest', 'TradeMoveRequest', 'TradeSellRequest']);
});
await test('买入花完商会币且累计利润为零，协议默认零字段当轮正确确认', async () => {
  const f = setup();
  f.state.trade.player.profit = 0;
  const request = f.client.request;
  let omitted = false;
  f.client.request = async (name, body, response) => {
    const reply = await request(name, body, response);
    if (name !== 'TradeBuyRequest') return reply;
    const player = { ...reply.player };
    assert.equal(player.coins, 0);
    assert.equal(player.profit, 0);
    delete player.coins;
    delete player.profit;
    const decoded = f.protocol.TradeBuyResponse.decode(f.protocol.TradeBuyResponse.encode({ player }).finish());
    assert.equal(Object.hasOwn(decoded.player, 'coins'), false);
    assert.equal(Object.hasOwn(decoded.player, 'profit'), false);
    omitted = true;
    return decoded;
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(omitted, true);
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1, '不应多花一轮补确认零字段');
});
await test('平价换货遵守首趟时间，原价回款后按新行情采购，累计利润只计实际盈利', async () => {
  const f = setup(), trade = f.state.trade;
  trade.player.coins = 0;
  trade.player.goods = [{ pid: 701, goodsId: 1001, cityId: 20, buyPrice: 45, num: 100 }];
  f.state.markets[10].goods = [{ goodsId: 1001, price: 45, stock: 60000 }, { goodsId: 1004, price: 10, stock: 0 }];
  f.state.radar.radar[1].specGoodsId = 1003;
  const initialProfit = trade.player.profit;
  Object.assign(f.settings.merchant, { firstDepartureMode: 'time', firstDepartureTime: '16:00' });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 0);
  f.settings.merchant.firstDepartureMode = 'smart';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.match(f.reports.at(-1).label, /平价换货/);
  assert.equal(trade.player.profit, initialProfit); assert.equal(trade.player.coins, 4500);
  f.state.markets[10].goods[1].price = 11;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(trade.player.goods[0].goodsId, 1004); assert.equal(trade.player.goods[0].buyPrice, 11);
});
await test('期末保本清仓允许零收益成交，累计利润零字段可确认', async () => {
  const f = setup();
  f.client.tradeWindow.endTime = f.now + 1800;
  f.state.trade.player.profit = 0;
  f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 20, buyPrice: 40, num: 10 }];
  const request = f.client.request;
  f.client.request = async (name, body, response) => {
    const reply = await request(name, body, response);
    if (name !== 'TradeSellRequest') return reply;
    const player = { ...reply.player };
    delete player.profit;
    delete player.goods;
    return f.protocol.TradeSellResponse.decode(f.protocol.TradeSellResponse.encode({ player }).finish());
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.equal(f.state.trade.player.coins, 10400);
  assert.equal(f.state.trade.player.profit, 0);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
});
await test('原采购明确未发送释放记录，后续回读未发送错误不释放已写操作', async () => {
  const f = setup();
  const request = f.client.request;
  let blockWrite = true;
  f.client.request = async (name, body, response) => {
    if (name === 'TradeBuyRequest' && blockWrite) throw Object.assign(Error('排队期间连接关闭，未发送'), { notSent: true });
    return request(name, body, response);
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 0);
  assert(!Object.values(f.ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  blockWrite = false;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(f.reports.at(-1).status, 'confirmed');

  const g = setup();
  const gRequest = g.client.request;
  let blockRead = true;
  g.client.request = async (name, body, response) => {
    if (name === 'TradeInfoRequest' && g.sent('TradeBuyRequest').length && blockRead)
      throw Object.assign(Error('回读未发送'), { notSent: true });
    return gRequest(name, body, response);
  };
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeBuyRequest').length, 1);
  assert.equal(g.reports.at(-1).status, 'unknown');
  assert(Object.values(g.ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  blockRead = false;
  await g.run(merchantActivity, 'merchantTrade');
  assert.equal(g.sent('TradeBuyRequest').length, 1);
  assert.equal(g.reports.at(-1).status, 'confirmed');
});
await test('售出回包丢失后跨账本实例先确认消失批次，不重复售出', async () => {
  const f = setup();
  f.state.trade.cargo.cityId = 20;
  f.state.radar.radar = [];
  f.state.trade.player.goods = [{ pid: 201, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.state.trade.player.goods.length, 0);
  f.state.mode = '';
  const ledger = createUsageLedger('fixture', { file: f.store });
  await merchantActivity(f.client, f.config, {
    player: f.player, key: 'merchantTrade', label: '海商王', ledger,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row)
  });
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.match(f.reports.at(-1).reason, /前次操作/);
  assert(!Object.values(ledger.keyRecords()).some(row => row.details?.scope?.startsWith('merchant:') && !row.confirmed));
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 1);
});
await test('航行回包丢失后在途中回读确认，不重发出航或被航行等待吞掉', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  f.state.mode = '';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.reports.at(-1).status, 'confirmed');
  assert.match(f.reports.at(-1).reason, /前次操作/);
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.writes.length, 2);
  assert.equal(f.sent('TradeMoveRequest').length, 1);
});
await test('未执行的未知采购不会靠新目标或重载账本绕过，其他账号独立', async () => {
  const f = setup();
  f.state.mode = 'unknown';
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = '';
  f.state.markets[10].goods[0].price = 30;
  for (const account of ['fixture', 'other-fixture']) {
    const ledger = createUsageLedger(account, { file: f.store });
    await merchantActivity(f.client, f.config, {
      player: f.player, key: 'merchantTrade', label: '海商王', ledger,
      settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row)
    });
    assert.equal(f.sent('TradeBuyRequest').length, account === 'fixture' ? 1 : 2);
  }
});
await test('买入回包丢失后玩家已换港出清，重启后从空船恢复，不补计旧交易', async () => {
  const f = setup();
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  const [key] = Object.entries(f.ledger.keyRecords()).find(([, row]) => row.details?.expected?.request === 'TradeBuyRequest');
  f.state.mode = '';
  const { cargo, player } = f.state.trade;
  cargo.cityId = 20;
  player.goods = [];
  player.coins = 16438;
  player.profit += 6438;
  const ledger = createUsageLedger('fixture', { file: f.store });
  const run = () => merchantActivity(f.client, f.config, { key: 'merchantTrade', label: '海商王', player: f.player, ledger,
    settings: () => f.settings, enabled: () => true, report: row => f.reports.push(row) });
  const progress = () => merchantProgress(f.config, f.client.tradeWindow, f.state.trade, f.player, f.now,
    async name => name === 'TradeGuildRadar' ? f.state.radar : f.state.markets[cargo.cityId], ledger, f.settings);
  assert.match(await progress(), /等待自动走商复核/);
  assert.equal(ledger.keyRecords()[key].expired, undefined);
  await run();
  assert.equal(ledger.keyRecords()[key].expired, true);
  assert.equal(ledger.keyRecords()[key].confirmed, false);
  assert.equal(ledger.snapshot().uncertain, 0);
  assert.equal(f.state.writes.length, 1);
  const journal = merchantJournalSummary(ledger, f.client.tradeWindow);
  assert.equal(journal.unknownActions, 1);
  assert.equal(journal.buys + journal.sells + journal.realizedProfit, 0);
  f.state.markets[20].goods[0].price = 30;
  f.state.radar.radar[0].rareGoodsId = 1001;
  assert.doesNotMatch(await progress(), /前次操作|等待自动走商复核/);
  await run();
  assert.equal(f.state.writes.length, 2);
  assert.equal(f.state.writes[1].body.cityId, 20);
});
await test('手动多卖一批的回款不归入旧卖单，下一轮按当前余额继续', async () => {
  const f = setup(), { player, cargo } = f.state.trade;
  cargo.cityId = 20;
  player.goods = [501, 502].map(pid => ({ pid, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }));
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(player.goods.length, 1);
  player.goods = []; player.coins += 658; player.profit += 258;
  f.state.mode = '';
  await f.run(merchantActivity, 'merchantTrade');
  const journal = merchantJournalSummary(f.ledger, f.client.tradeWindow);
  assert.equal(journal.realizedProfit, 0);
  assert.equal(journal.sells, 0);
  assert.equal(journal.unknownActions, 1);
  assert.equal(f.ledger.snapshot().uncertain, 0);
  assert.equal(f.sent('TradeSellRequest').length, 1);
});
await test('本港询价跨刷新时不交易、不把旧报价归入新一轮，下一次按新价采购', async () => {
  const f = setup();
  f.client.serverClockOffsetMs += 7190000;
  f.state.onRead = name => {
    if (name === 'TradeCity') f.client.serverClockOffsetMs += 20000;
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.state.writes, []);
  assert.match(f.reports.at(-1).reason, /行情已刷新/);
  assert.equal(readMerchantJournal(f.ledger, f.client.tradeWindow).length, 0);
  assert(!Object.keys(f.ledger.keyRecords()).some(key => key.startsWith('merchant-market:')));
  f.state.onRead = null;
  f.state.markets[10].goods[0].price = 30;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.trade.player.goods[0].buyPrice, 30);
});
await test('发单复核时本港价格或库存有推送，本轮停止，下次读取新价', async () => {
  const f = setup();
  let radarReads = 0;
  f.state.onRead = name => {
    if (name !== 'TradeGuildRadar' || ++radarReads !== 2) return;
    f.state.markets[10].goods[0].price = 30;
    f.client.emit('message', { name: 'SCTradeCityGoods', body: { cityId: 10 } });
  };
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.state.writes, []);
  assert.equal(f.client.listenerCount('message'), 0);
  f.state.onRead = null;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.state.trade.player.goods[0].buyPrice, 30);
  assert.equal(f.client.listenerCount('message'), 0);
});
await test('买入瞬间变价，按回包、批次数量与实际扣款核账', async () => {
  for (const price of [30, 43]) {
    const f = setup();
    f.state.trade.player.coins = 100000;
    f.state.onWrite = name => { if (name === 'TradeBuy') f.state.markets[10].goods[0].price = price; };
    await f.run(merchantActivity, 'merchantTrade');
    const [order] = f.sent('TradeBuyRequest');
    assert.equal(f.reports.at(-1).status, 'confirmed');
    const summary = merchantJournalSummary(f.ledger, f.client.tradeWindow);
    assert.equal(summary.buys, 1);
    assert.equal(summary.buyCost, price * order.body.buyNum);
    assert.equal(summary.batches[0].buyPrice, price);
  }
});
await test('预设走商在途遵守零针或库存加速，冲刺达标后仍可自然走商', async () => {
  for (const preset of merchantPresets) {
    const f = setup();
    Object.assign(f.settings.merchant, preset.settings.merchant);
    f.state.stock['海商王加速'] = 8;
    const run = () => f.run(merchantActivity, 'merchantTrade');
    await run();
    await run();
    assert.equal(f.sent('TradeMoveRequest').length, 1);
    await run();
    if (preset.id === 'free' || preset.id === 'eventFree') {
      assert.equal(f.sent('TradeSpeedRequest').length, 0);
      assert.equal(f.state.stock['海商王加速'], 8);
      continue;
    }
    assert.deepEqual(f.sent('TradeSpeedRequest').map(r => r.body.useNum), [4], '优先回款，用库存针直接到港');
    assert.equal(f.state.trade.cargo.cityId, 20);
    assert.equal(f.state.trade.cargo.moveToCityId, 0);
    f.state.trade.player.profit = 50_000_000;
    f.state.trade.cargo.cargoLv = 5;
    await run();
    assert.equal(f.sent('TradeSellRequest').length, 1);
    f.state.markets[20].goods[0].price = 30;
    await run();
    await run();
    assert.equal(f.sent('TradeMoveRequest').length, 2);
    await run();
    assert.equal(f.sent('TradeSpeedRequest').length, 1);
    assert.equal(f.state.stock['海商王加速'], 4);
  }
});
await test('仅用本期免费针按实领记账，扣除付费、手动消耗和未确认用针，重启及换期保持隔离', async () => {
  const f = setup(), pointer = '海商王加速', guild = f.player.guildId, day = 86400;
  let ledger = f.ledger;
  const observe = async () => observeFreePointers(f.client, f.config, f.client.tradeWindow,
    await read(f.client, 'TradeInfo'), ledger, guild, () => true);
  const state = f.state, pass = state.passes[3];
  state.stock[pointer] = 100;
  assert.equal((await observe()).available, 0);
  pass.got = [{ id: 1, freeGot: true, payGot: true }];
  state.tasks.gotTaskId = [1];
  state.trade.gotReportRwdId = 1;
  state.trade.player.buySpeedTimes = 3;
  // 1 根免费战令、2 根任务、2 根商情；同档付费战令 4 根，另用钻石买 3 根。
  state.stock[pointer] += 12;
  assert.equal((await observe()).available, 5);
  ledger = createUsageLedger('fixture', { file: f.store });
  assert.equal((await observe()).available, 5);
  state.stock[pointer] -= 3;
  assert.equal((await observe()).available, 2, '手动用针先扣免费余额');
  state.stock[pointer] += 7;
  assert.equal((await observe()).available, 2, '其他入账不能恢复免费额度');
  const pending = ledger.reserve({}, {}, {}, { uniqueKey: 'pending-free', details: {
    scope: 'merchant:' + f.window.startTime + ':' + f.window.period, expected: { request: 'TradeSpeedRequest', useNum: 2 } } });
  const budget = () => readMerchantDockBudget((key) => read(f.client, key), ledger,
    merchantPresets.find(p => p.id === 'eventFree').settings.merchant, f.now, f.client.tradeWindow);
  assert.equal(await budget(), null);
  assert.equal(await observe(), null, '待确认扣针期间保留上次库存快照');
  ledger.cancel(pending);
  assert.equal((await budget()).periodRemaining, 2);
  f.client.serverClockOffsetMs += day * 1000;
  state.trade.gotReportRwdId = 0;
  state.trade.player.buySpeedTimes = 0;
  assert.equal((await observe()).available, 2);
  state.trade.gotReportRwdId = 1;
  state.stock[pointer] += 2;
  assert.equal((await observe()).available, 4, '新一天的同档商情礼包可正常计入');
  f.client.tradeWindow = { ...f.window, startTime: f.window.startTime + day };
  assert.equal((await observe()).available, 0, '活动编号复用也不继承上期余额');
});

await test('仅用本期免费针可在途中使用新领的针，背包旧针和钻石都保留', async () => {
  const f = setup(), mode = merchantPresets.find(p => p.id === 'eventFree').settings.merchant;
  Object.assign(f.settings.merchant, mode, { autoBuyPointers: true, pointerDailyDiamondLimit: 8000 });
  f.state.stock['海商王加速'] = 8;
  const run = () => f.run(merchantActivity, 'merchantTrade');
  await run();
  await run();
  await run();
  assert.equal(f.sent('TradeSpeedRequest').length, 0);
  f.state.passes[3].got = [{ id: 1, freeGot: true }];
  await run();
  assert.equal(f.sent('TradeSpeedRequest').length, 0, '只见领奖标记、没有到账不动用旧针');
  f.state.tasks.gotTaskId = [1];
  f.state.stock['海商王加速'] += 2;
  await run();
  assert.deepEqual(f.sent('TradeSpeedRequest').map(r => r.body.useNum), [1]);
  assert.equal(f.state.stock['海商王加速'], 9);
  assert.equal(f.sent('TradeBuySpeedItemRequest').length, 0);
});
await test('手动选择省针追赶时，末日 21:15 从空船购货，用成交所需的三根后停针', async () => {
  const f = setup(), close = f.now + 10 * 3600, at = close - 45 * 60;
  const run = () => f.run(merchantActivity, 'merchantTrade');
  Object.assign(f.settings.merchant, merchantPresets.find(p => p.id === 'sprint').settings.merchant, { speedUpMode: 'goal' });
  f.client.tradeWindow.endTime = close + 2 * 3600;
  f.client.serverClockOffsetMs = at * 1000 - Date.now();
  f.state.trade.player.profit = 50_000_000 - 500;
  f.state.trade.cargo.cargoLv = 5;
  f.state.stock['海商王加速'] = 2;
  await run();
  assert.equal(f.sent('TradeBuyRequest').length, 0, '两根只能减一小时，剩余 45 分钟不能采购出航');
  f.state.stock['海商王加速'] = 10;
  await run();
  await run();
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  await run();
  assert.deepEqual(f.sent('TradeSpeedRequest').map(r => r.body.useNum), [3]);
  const cargo = f.state.trade.cargo;
  f.client.serverClockOffsetMs = cargo.moveEndTime * 1000 - Date.now();
  Object.assign(cargo, { cityId: cargo.moveToCityId, moveToCityId: 0, moveEndTime: 0 });
  f.state.markets[20].goods[0].price = 55;
  await run();
  assert.equal(f.sent('TradeSellRequest').length, 1);
  assert.ok(f.state.trade.player.profit >= 50_000_000);
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).realizedProfit,
    f.state.trade.player.profit - (50_000_000 - 500));
  await run();
  assert.equal(f.sent('TradeBuyRequest').length, 1);
  assert.equal(f.state.stock['海商王加速'], 7);
});
await test('次日仍开市的 20:30 改跑收盘前加速航次，当天成交，没有针时照常隔夜', async () => {
  for (const pins of [10, 0]) {
    const f = setup(), at = f.now + 8.5 * 3600; // 北京时间 20:30，自然航行 22:30 才到。
    const run = () => f.run(merchantActivity, 'merchantTrade');
    Object.assign(f.settings.merchant, merchantPresets.find(p => p.id === 'sprint').settings.merchant, { speedUpMode: 'goal' });
    f.client.serverClockOffsetMs = at * 1000 - Date.now();
    f.state.stock['海商王加速'] = pins;
    await run();
    await run();
    assert.equal(f.sent('TradeBuyRequest').length, 1);
    assert.equal(f.sent('TradeMoveRequest').length, 1);
    const move = Object.values(f.ledger.keyRecords()).find(r => r.details?.expected?.request === 'TradeMoveRequest').details.expected;
    await run();
    if (!pins) {
      assert.equal(move.accelerationRequired, undefined);
      assert.ok(move.plannedOpening > at, '没有针时仍是隔夜航次');
      assert.equal(f.sent('TradeSpeedRequest').length, 0);
      continue;
    }
    assert.deepEqual([move.accelerationRequired, move.plannedOpening], [2, undefined]);
    assert.deepEqual(f.sent('TradeSpeedRequest').map(r => r.body.useNum), [2]);
    const cargo = f.state.trade.cargo;
    assert.equal(cargo.moveEndTime, cargo.moveStartTime + 3600);
    f.client.serverClockOffsetMs = cargo.moveEndTime * 1000 - Date.now();
    Object.assign(cargo, { cityId: cargo.moveToCityId, moveToCityId: 0, moveEndTime: 0 });
    await run();
    assert.equal(f.sent('TradeSellRequest').length, 1, '21:30 前后到港，当天按实价成交');
    assert.equal(f.state.stock['海商王加速'], 8);
  }
});
await test('收尾采购复核时库存不足或报价涨过成本线，取消依赖用针的采购', async () => {
  for (const change of ['stock', 'price']) {
    const f = setup(), at = f.now + 9 * 3600;
    Object.assign(f.settings.merchant, merchantPresets.find(p => p.id === 'sprint').settings.merchant);
    f.client.tradeWindow.endTime = f.now + 12 * 3600;
    f.client.serverClockOffsetMs = at * 1000 - Date.now();
    f.state.stock['海商王加速'] = 10;
    let reads = 0;
    f.state.onRead = name => {
      if (name === (change === 'stock' ? 'AllItem' : 'TradeCity') && ++reads === 2) {
        if (change === 'stock') f.state.stock['海商王加速'] = 1;
        else f.state.markets[10].goods[0].price = 60;
      }
    };
    await f.run(merchantActivity, 'merchantTrade');
    assert.ok(reads >= 2);
    assert.equal(f.sent('TradeBuyRequest').length, 0);
    assert.equal(f.sent('TradeSpeedRequest').length, 0);
  }
});
await test('卖出瞬间涨跌时，用卖出回包与回读核实实际回款和盈亏', async () => {
  for (const [price, profit] of [[70, 309], [60, 206], [40, 0], [35, -50]]) {
    const f = setup();
    f.state.trade.cargo.cityId = 20;
    f.state.trade.player.goods = [{ pid: 501, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
    f.state.onWrite = name => { if (name === 'TradeSell') f.state.markets[20].goods[0].price = price; };
    await f.run(merchantActivity, 'merchantTrade');
    assert.equal(f.reports.at(-1).status, 'confirmed');
    const summary = merchantJournalSummary(f.ledger, f.client.tradeWindow);
    assert.equal(summary.sells, 1);
    assert.equal(summary.realizedProfit, profit);
  }
});
await test('旧采购无快照时区分原始余额和已变化的持仓，二次回读不一致保留防重记录', async () => {
  const f = setup(), { player } = f.state.trade;
  const key = 'event-action:legacy-pending-buy', scope = 'merchant:' + f.client.tradeWindow.startTime + ':' + f.state.trade.period;
  f.ledger.reserve({}, {}, {}, { uniqueKey: key, details: { scope,
    expected: { request: 'TradeBuyRequest', city: 10, goodsId: 1001, price: 40, owned: 250, coins: 0 } } });
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.snapshot().uncertain, 1);
  player.coins++;
  let reads = 0;
  f.state.onRead = name => { if (name === 'TradeInfo' && ++reads === 2) player.coins--; };
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(reads, 2);
  assert.equal(f.ledger.snapshot().uncertain, 1);
  f.state.onRead = null;
  player.coins++;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.keyRecords()[key].expired, true);
  assert.equal(f.state.writes.length, 0);
});
await test('回款或持仓只同步一部分时不解除防重，补齐后确认同一笔', async () => {
  const f = setup(), player = f.state.trade.player;
  f.state.mode = 'lostAfterApply';
  await f.run(merchantActivity, 'merchantTrade');
  const goods = player.goods;
  player.goods = [];
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.snapshot().uncertain, 1);
  player.goods = goods;
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.snapshot().uncertain, 0);
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).buys, 1);
  assert.equal(f.state.writes.length, 1);
});
await test('未知出航后手动改航线，不重发旧目的港或将手动航程计为已确认', async () => {
  const f = setup(), cargo = f.state.trade.cargo;
  await f.run(merchantActivity, 'merchantTrade');
  f.state.mode = 'unknown';
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.sent('TradeMoveRequest')[0].body.mvToCityId, 20);
  Object.assign(cargo, { moveStartTime: f.now, moveEndTime: f.now + 7200, moveToCityId: 30 });
  await f.run(merchantActivity, 'merchantTrade');
  await f.run(merchantActivity, 'merchantTrade');
  assert.match(f.reports.at(-1).reason, /航行中/);
  assert.equal(f.sent('TradeMoveRequest').length, 1);
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).moves, 0);
});
await test('未知加速在自然到港后解除走商等待，仍按到港实价卖货', async () => {
  const f = setup(), { cargo, player } = f.state.trade;
  const key = 'event-action:previous-speed', started = f.now - 7200;
  const scope = 'merchant:' + f.client.tradeWindow.startTime + ':' + f.state.trade.period;
  f.ledger.reserve({ merchantPointers: 1 }, {}, {}, { uniqueKey: key, details: { scope, expected: {
    request: 'TradeSpeedRequest', city: 10, destination: 20, moveStartTime: started,
    beforeEndTime: f.now, afterEndTime: f.now - 1800, useNum: 1
  } } });
  Object.assign(cargo, { cityId: 20, moveStartTime: started });
  player.goods = [{ pid: 501, goodsId: 1001, cityId: 10, buyPrice: 40, num: 10 }];
  await f.run(merchantActivity, 'merchantTrade');
  assert.equal(f.ledger.keyRecords()[key].expired, true);
  assert.equal(f.ledger.snapshot().counters.merchantPointers, 1);
  assert.equal(merchantJournalSummary(f.ledger, f.client.tradeWindow).pointerUsed, 0);
  await f.run(merchantActivity, 'merchantTrade');
  assert.deepEqual(f.state.writes.map(row => row.name), ['TradeSellRequest']);
});
await test('贸易战令、已达利润、联盟任务与商情礼包逐项核验', async () => {
  const f = setup();
  await f.run(merchantActivity, 'merchantRewards');
  await f.run(merchantActivity, 'merchantRewards');
  assert.equal(f.sent('BattlePassGotRewardRequest')[0].body.type, 3);
  assert.equal(f.sent('GotTradeAchievementRequest').length, 1);
  assert(f.sent('TradeGotTaskRequest').length > 0);
  assert.equal(f.sent('GotTradeReportRequest').length, 1);
});
await test('旧导出保留显式关闭值，新默认与罗盘阈值入参校验', () => {
  const f = setup(),
    doc = { ...exportAutomationSettings(f.settings), version: 1 };
  delete doc.settings.eventActions;
  for (const k of [
    'armsRaceRewards',
    'riverScore',
    'riverPass',
    'riverHelp',
    'compassDaily',
    'compassSpin',
    'merchantTrade',
    'merchantRewards',
    'beautyVotes',
    'beautyGift'
  ])
    delete doc.settings.schedule[k];
  doc.settings.schedule.compassReward = false;
  const restored = importAutomationSettings(doc);
  assert.equal(restored.schedule.compassReward, false);
  assert.equal(restored.schedule.armsRaceRewards, false);
  for (const key of ['compassSpin', 'merchantTrade', 'beautyVotes']) assert.equal(restored.schedule[key], false, key + ' 消耗型任务需主动开启');
  assert.deepEqual(restored.eventActions, { compassThreshold: 10, compassDrawCount: 10 });
  restored.eventActions.compassDrawCount = 3;
  assert.throws(() => validateSettings(restored));
});
await test('跨日礼包核对、活动中途关闭和候选人名单按游戏客户端筛选', async () => {
  const f = setup();
  f.client.seriesSnapshotDay = Math.floor((f.now + 28800) / 86400) - 1;
  f.client.festivals[0].subActivity[2].dailySelectGift.boughtTimes[1000] = 1;
  await f.run(compassActivity, 'compassDaily');
  assert.equal(f.sent('ClaimFreeSelectGiftRequest').length, 1);
  const g = setup();
  g.state.beauty.player.push({ no: 999999, rank: 1, playerId: 1000, vote: 99999 });
  await g.run(beautyActivity, 'beautyVotes');
  assert.equal(g.sent('BeautyVoteRequest')[0].body.no, 620);
  const h = setup();
  let reads = 0;
  h.state.onRead = (name) => {
    if (name === 'BeautyInfo' && ++reads === 2) h.client.beautyWindow = { ...h.window, endTime: h.now };
  };
  await h.run(beautyActivity, 'beautyVotes');
  assert.equal(h.state.writes.length, 0);
});
await test('正常挂机循环从保存的开关执行投票与奖励，未启用的走商不会发送', async () => {
  const f = setup();
  Object.assign(f.settings.loop, { world: false, tasks: false, dailies: false, heroes: false });
  const enabled = new Set(['beautyVotes', 'beautyGift']);
  await runLoop(f.client, f.protocol, {
    config: f.config,
    player: f.player,
    rounds: 1,
    allowMutate: true,
    isEnabled: (k) => enabled.has(k),
    getSettings: () => f.settings,
    usageLedger: f.ledger,
    sleep: async () => {}
  });
  assert.deepEqual(
    f.state.writes.map((w) => w.name),
    ['BeautyVoteRequest', 'GotBeautyVoteRequest']
  );
});
console.log('活动专项 ' + passed + '/' + passed + ' 通过');
