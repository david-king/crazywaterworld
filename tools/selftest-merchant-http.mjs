// HTTP实况/单步入口使用隔离账号与真实协议夹具，不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-http-'));
process.env.CW_DATA_DIR = directory;
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { createUsageLedger, saveAutomationSettings } = await import('../src/automation-settings.mjs');
const { seasonalFixture } = await import('./fixtures/seasonal-suite.mjs');
const { merchantGoal } = await import('../src/merchant-goal.mjs');
const f = seasonalFixture();
const request = f.client.request;
f.client.request = (name, ...args) => name === 'WeekInfoRequest' ? { activityTime: [] } : request(name, ...args);
saveStore({ activeId: 'merchant-http', accounts: [{ id: 'merchant-http', label: '海商王HTTP离线',
  url: 'ws://invalid.invalid', login: {}, automation: { enabled: false } }] });
f.settings.schedule.merchantTrade = true;
f.settings.merchant.enabled = true;
saveAutomationSettings('merchant-http', f.settings, { revision: 0 });
const app = createConsole({ port: 0 }), root = await app.listen();
const api = async (route, body) => {
  const response = await fetch(root + '/api/' + route + '?account=merchant-http', {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  });
  return { status: response.status, data: await response.json() };
};
let passed = 0;
const test = async (name, work) => { await work(); console.log('通过：' + name); passed++; };
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
try {
  ok(await api('settings'));
  const session = app.sessions.get('merchant-http');
  Object.assign(session, { client: f.client, player: f.player });
  f.client.stop = () => { f.client.connected = false; };
  await test('实况和历史读取没有买卖或升级副作用，也不导出凭据', async () => {
    const result = ok(await api('merchant'));
    assert.equal(result.available, true);
    assert.equal(result.plan.kind, 'buy');
    assert.equal(f.state.writes.length, 0);
    const history = ok(await api('merchant/history'));
    assert.deepEqual(history.summary, []);
    assert.deepEqual(history.entries, []);
    assert.doesNotMatch(JSON.stringify({ result, history }), /invalid\.invalid|"login"|"token"/);
  });
  await test('总览直接显示本期个人利润、目标档位和有效交易时间', async () => {
    const readStart = f.state.reads.length;
    const panel = ok(await api('overview')).merchant;
    assert.equal(f.state.reads.slice(readStart).filter(name => name === 'TradeGuildRadarRequest').length, 1);
    assert.equal(panel.trade.intel.ports[0].position, '所在港');
    assert.equal(panel.goal.profit, 6000);
    assert.equal(panel.goal.remaining, 49_994_000);
    assert.equal(panel.goal.totalTiers, 20);
    const tiers = f.config.tables.TradeAchieveRewardCfg.data.filter(row => row.id === f.window.period)
      .sort((a, b) => a.rewardId - b.rewardId);
    assert.deepEqual(panel.goal.tiers, tiers.map(row => ({ id: row.rewardId, target: row.target, rewards: row.rewards })));
    assert.equal(panel.rewardItems.GOLD.name, f.config.materialName('GOLD'));
    assert.equal(panel.trade.period, f.window.period);
    assert.equal(panel.trade.coins, 10000);
    assert.deepEqual(panel.trade.voyage.facts[0], ['当前商品', '空载']);
    assert.deepEqual(panel.trade.voyage.facts.find(([label]) => label === '预期收益'), ['预期收益', '约 2,575 商会币']);
    assert.equal(panel.trade.autoSpeedUp, false);
    assert.equal(panel.trade.buys, 0);
    assert.equal(panel.goal.ready, true);
    assert.equal(panel.goal.remainingTradingSeconds, 36 * 3600 - (panel.goal.checkedAt - f.now));
    assert.equal(panel.goal.requiredPerHour, Math.ceil(49_994_000 * 3600 / panel.goal.remainingTradingSeconds));
    assert.match(panel.lines.join(' '), /商会币 10,000.*空载/);
    assert.match(panel.lines.join(' '), /指南针加速已关闭.*钻石补购已关闭.*已核实用针 0 根/);
    assert.equal(panel.goal.freeTrips, 14, '今天中午尚可跑4程，接着两个全天各5程，末日中午前清仓');
    assert.equal(panel.goal.requiredPerFreeTrip, Math.ceil(panel.goal.remaining / panel.goal.freeTrips));
    assert.equal(panel.goal.benchmark.level, 1);
    assert.match(panel.lines.join(' '), /折后基准价/);
    assert.equal(f.state.writes.length, 0);
  });
  await test('海商王单卡刷新返回最新利润，只读取走商数据', async () => {
    const start = f.state.reads.length, profit = f.state.trade.player.profit;
    try {
      f.state.trade.player.profit += 123;
      const panel = ok(await api('merchant/overview'));
      assert.equal(panel.goal.profit, profit + 123);
      assert.equal(panel.trade.period, f.window.period);
      assert(f.state.reads.slice(start).every(name => name.startsWith('Trade')));
      assert.equal(f.state.writes.length, 0);
    } finally { f.state.trade.player.profit = profit; }
  });
  await test('航行中可读联盟港口情报，目的港优先，未共享、无联盟和读取失败各自有提示', async () => {
    const { cargo } = f.state.trade, beforeCargo = { ...cargo }, beforeRadar = f.state.radar, guild = f.player.guildId;
    Object.assign(cargo, { moveStartTime: f.now - 60, moveEndTime: f.now + 600, moveToCityId: 20 });
    f.state.radar = { radar: [
      { cityId: 10, specGoodsId: 1001 },
      { cityId: 20, rareGoodsId: 1001, specGoodsId: 1002, reportName: '海鸥' },
    ] };
    const reads = f.state.reads.length;
    const intel = async () => ok(await api('overview')).merchant.trade.intel;
    const first = await intel();
    assert(first.goods.includes('淡水'));
    assert.deepEqual(first.ports.map(({ revision, ...port }) => port), [
      { cityId: 20, city: '哨塔B0', position: '目的港', specialtyId: 1002, shortageId: 1001, specialty: '淡水', shortage: '生鱼片', reporter: '海鸥' },
      { cityId: 10, city: '铁锈湾', position: '出发港', specialtyId: 1001, shortageId: 0, specialty: '生鱼片', shortage: null, reporter: null },
    ]);
    f.state.radar.radar[1].reportName = '新共享人';
    const next = await intel();
    assert.equal(first.scope, next.scope);
    assert.notEqual(first.ports[0].revision, next.ports[0].revision);
    assert.equal(first.ports[1].revision, next.ports[1].revision);
    f.state.radar = { radar: [] };
    assert.match((await intel()).message, /暂无/);
    f.state.onRead = name => { if (name === 'TradeGuildRadar') throw Error('test'); };
    assert.match((await intel()).message, /读取失败/);
    f.player.guildId = '0';
    assert.match((await intel()).message, /加入联盟/);
    assert.equal(f.state.reads.slice(reads).filter(name => name === 'TradeGuildRadarRequest').length, 4);
    assert(!f.state.reads.slice(reads).includes('TradeCityRequest'));
    assert.equal(f.state.writes.length, 0);
    f.state.trade.cargo = beforeCargo;
    f.state.radar = beforeRadar;
    f.player.guildId = guild;
    f.state.onRead = null;
  });
  await test('总览开启升船后按配置满级估算，关闭时按当前船级估算', () => {
    const settings = structuredClone(f.settings);
    Object.assign(settings.resources, { allowDiamonds: false, diamondThreshold: 9000, diamondDailyLimit: 0 });
    Object.assign(settings.merchant, { autoUpgrade: true, upgradeMaxLevel: 2, upgradeDailyDiamondLimit: 0 });
    assert.equal(merchantGoal(f.config, f.window, f.state.trade, f.now, settings).benchmark.level, 5);
    settings.merchant.autoUpgrade = false;
    assert.equal(merchantGoal(f.config, f.window, f.state.trade, f.now, settings).benchmark.level, 1);
  });
  await test('未开放和已结束时总览不读取商情，活动配置页也不重复读取', async () => {
    const event = f.client.tradeWindow, previous = f.state.reads.filter(name => name.startsWith('Trade')).length;
    f.client.tradeWindow = { ...event, startTime: f.now + 3600 };
    const future = ok(await api('overview')).merchant;
    assert.equal(future.startTime, f.now + 3600);
    assert.equal(future.goal, undefined);
    f.client.tradeWindow = { ...event, endTime: f.now };
    assert.equal(ok(await api('overview')).merchant, null);
    f.client.tradeWindow = null;
    assert.equal(ok(await api('overview')).merchant, null);
    f.client.tradeWindow = event;
    assert.equal(ok(await api('activities')).status.merchant, undefined);
    assert.equal(f.state.reads.filter(name => name.startsWith('Trade')).length, previous);
  });
  await test('跨夜、最后一个交易时段、恰好达标与未同步的利润分别计量', async () => {
    const time = hour => f.now + (hour - 12) * 3600;
    const event = { ...f.window, startTime: time(20), endTime: time(36) };
    const get = (at, profit) => merchantGoal(f.config, event,
      { player: { coins: 99999999, profit }, gotAchieveRwdId: 19 }, time(at));
    assert.equal(get(23, 1000).remainingTradingSeconds, 2 * 3600);
    assert.equal(get(34, 1000).observedPerHour, 500);
    assert.equal(get(35, undefined).remaining, null);
    assert.equal(get(36, 1000).requiredPerHour, null);
    const hit = get(35, 50_000_000);
    assert.equal(hit.remaining, 0);
    assert.equal(hit.nextTier.id, 20);
    assert.equal(hit.ready, true);
    assert(hit.reward.length > 0);
  });
  await test('期次未同步或读取失败时总览不显示旧利润', async () => {
    const period = f.state.trade.period;
    f.state.trade.period++;
    assert.match(ok(await api('overview')).merchant.lines.join(' '), /待同步/);
    f.state.trade.period = period;
    f.state.onRead = name => { if (name === 'TradeInfo') throw Error('test'); };
    const panel = ok(await api('overview')).merchant;
    assert.equal(panel.goal, undefined);
    assert.match(panel.lines.join(' '), /刷新/);
    f.state.onRead = null;
    assert.equal(f.state.writes.length, 0);
  });
  await test('单步要求确认且尊重已保存走商开关', async () => {
    assert.equal((await api('merchant/step', {})).status, 400);
    let s = ok(await api('settings')); s.settings.schedule.merchantTrade = false;
    ok(await api('settings', { settings: s.settings, revision: s.revision, baseRevision: s.baseRevision }));
    assert.equal((await api('merchant/step', { confirm: true })).status, 400);
    assert.equal(f.state.writes.length, 0);
    s = ok(await api('settings')); s.settings.schedule.merchantTrade = true;
    ok(await api('settings', { settings: s.settings, revision: s.revision, baseRevision: s.baseRevision }));
  });
  await test('待买货价格未变，同档普通货的涨跌幅反转后发送前重新选择', async () => {
    const port = f.state.radar.radar[1], originalRare = port.rareGoodsId;
    port.rareGoodsId = 0;
    const market = f.state.markets[10];
    const peers = [1003, 1004].map(goodsId => ({ goodsId, price: 60,
      stock: f.config.tables.TradeGoodsCfg.data.find(g => g.goodsId === goodsId).maxCount }));
    market.goods.push(...peers);
    const before = ok(await api('merchant')).plan;
    assert.deepEqual([before.kind, before.price, before.purchases[0].expectedPrice], ['buy', 40, 60]);
    let reads = 0;
    f.state.onRead = name => {
      if (name === 'TradeCity' && ++reads === 2) peers.forEach(g => { g.price = 35; });
    };
    ok(await api('merchant/step', { confirm: true }));
    f.state.onRead = null;
    assert(reads >= 2);
    assert.equal(f.state.writes.length, 0);
    assert.notEqual(ok(await api('merchant')).plan.kind, 'buy');
    market.goods.splice(-peers.length);
    port.rareGoodsId = originalRare;
  });
  await test('同一批货用手动紧缺情报提前选港；游戏更新立即接管，旧版本不能覆盖', async () => {
    f.state.radar.radar[1].rareGoodsId = 0;
    f.state.radar.radar.push({ cityId: 30, specGoodsId: 1002, rareGoodsId: 0 });
    f.state.markets[10].goods.push({ goodsId: 1002, stock: 0, price: 80 });
    f.state.markets[30] = { goods: [{ goodsId: 1001, stock: 0, price: 68 }], specGoodsId: 1002, rareGoodsId: 1001, isReport: true };
    const plan = async () => ok(await api('merchant')).plan;
    const intel = async () => ok(await api('overview')).merchant.trade.intel;
    const before = await plan();
    assert.deepEqual([before.kind, before.destination, before.expectedProfit], ['buy', 20, 2575]);
    const advice = await intel(), port = advice.ports.find(port => port.cityId === 30);
    const change = { cityId: 30, revision: port.revision, editVersion: null, specialtyId: 1002, shortageId: 1001, reporter: null };
    const save = change => api('merchant/intel', { scope: advice.scope, changes: [change] });
    assert.equal((await save({ ...change, shortageId: 999999 })).status, 400);
    const saved = ok(await save(change));
    assert(saved.edits[30].version);
    assert.equal(createUsageLedger('merchant-http').merchantEdits(advice.scope)[30].shortageId, 1001);
    assert.deepEqual(createUsageLedger('other-merchant').merchantEdits(advice.scope), {});
    assert.equal((await save(change)).status, 400);
    const after = await plan();
    assert.deepEqual([after.kind, after.destination, after.expectedProfit], ['buy', 30, 10300]);
    assert.match(after.label, /30 号港预计卖价 80/);
    assert.equal(Object.fromEntries(after.purchaseDetails)['卖价依据'], '同档紧缺货最低涨跌幅（较基准价高 60%）');
    assert.match(after.label, /手动情报/);
    const overview = ok(await api('overview')).merchant;
    assert.match(overview.lines.join(' '), /10,300 商会币/);
    assert.deepEqual(overview.trade.voyage.purchaseDetails, after.purchaseDetails);
    f.state.radar.radar[2].rareGoodsId = 1003;
    assert.equal((await plan()).destination, 20);
    assert.deepEqual((await intel()).edits, {});
    assert.equal((await save(change)).status, 400);
    f.state.radar.radar[2].rareGoodsId = 0;
    assert.equal((await plan()).destination, 20, '旧手动值不能复活');
    ok(await save(change));
    let radarReads = 0;
    f.state.onRead = name => {
      if (name === 'TradeGuildRadar' && ++radarReads === 2) f.state.radar.radar[2].rareGoodsId = 1003;
    };
    ok(await api('merchant/step', { confirm: true }));
    f.state.onRead = null;
    assert(radarReads >= 2);
    assert.equal(f.state.writes.length, 0);
    f.state.radar.radar[2].rareGoodsId = 0;
    ok(await save(change));
  });
  await test('重复点击串行去重，一次采购有实际回读与独立成交记录', async () => {
    const results = await Promise.all([api('merchant/step', { confirm: true }), api('merchant/step', { confirm: true })]);
    results.forEach(ok);
    assert.equal(f.state.writes.filter(row => row.name === 'TradeBuyRequest').length, 1);
    assert.equal(results[0].data.state.journal.buys, 1);
    assert(results[0].data.state.journal.buyCost > 0);
    const history = ok(await api('merchant/history'));
    assert.equal(history.summary[0].buys, 1);
    const trade = history.entries.find(row => row.type === 'trade');
    assert(trade.before && trade.after);
    assert.equal(trade.status, 'confirmed');
  });
  await test('实际走商入口在复核后驶往手动情报目的港，到港按本港报价结算', async () => {
    const trade = () => api('merchant/step', { confirm: true });
    ok(await trade());
    assert.equal(f.state.writes.find(row => row.name === 'TradeMoveRequest').body.mvToCityId, 30);
    assert.match(ok(await api('overview')).merchant.lines.join(' '), /出发时生鱼片参考涨跌 \+60.00%/);
    Object.assign(f.state.trade.cargo, { cityId: 30, moveToCityId: 0, moveEndTime: 0 });
    const local = ok(await api('merchant')).plan;
    assert.deepEqual([local.kind, local.price, local.gain], ['sell', 68, 7210]);
    ok(await trade());
    assert.equal(ok(await api('merchant/history')).summary[0].realizedProfit, 7210);
  });
  await test('排队期间暂停账号取消单步，历史仍能离线查看', async () => {
    session.paused = true;
    const count = f.state.writes.length;
    assert.equal((await api('merchant/step', { confirm: true })).status, 400);
    assert.equal(f.state.writes.length, count);
    assert.equal(ok(await api('merchant/history')).summary[0].buys, 1);
  });
  console.log('海商王HTTP验证通过：' + passed + ' 项');
} finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
