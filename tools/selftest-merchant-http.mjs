// HTTP实况/单步入口使用隔离账号与真实协议夹具，不连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-merchant-http-'));
process.env.CW_DATA_DIR = directory;
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const { saveAutomationSettings } = await import('../src/automation-settings.mjs');
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
    const panel = ok(await api('overview')).merchant;
    assert.equal(panel.goal.profit, 6000);
    assert.equal(panel.goal.remaining, 49_994_000);
    assert.equal(panel.goal.totalTiers, 20);
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
  await test('排队期间暂停账号取消单步，历史仍能离线查看', async () => {
    session.paused = true;
    const count = f.state.writes.length;
    assert.equal((await api('merchant/step', { confirm: true })).status, 400);
    assert.equal(f.state.writes.length, count);
    assert.equal(ok(await api('merchant/history')).summary[0].buys, 1);
  });
  console.log('海商王HTTP验证通过：' + passed + ' 项');
} finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
