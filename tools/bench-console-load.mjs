// 多账号真实控制台、挂机循环及 Chromium；游戏连接和账号存储全部隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { activeResources, resourceUpdatePolicy } from '../src/resource-store.mjs';
import { findConfigPack } from '../src/config.mjs';
import { localLoadProfile, installReplay } from './fixtures/console-load-profile.mjs';

// npm run bench:console -- <账号数> <采样秒数> [--local-max]，CPU 的 100% 表示一个逻辑核。
const count = Number(process.argv[2] ?? 8);
const seconds = Number(process.argv[3] ?? 13);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 64, '账号数应为 1–64');
assert.ok(Number.isSafeInteger(seconds) && seconds >= 10 && seconds <= 3600, '采样时长应为 10–3600 秒');
const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(file => file && fs.existsSync(file));
assert.ok(executablePath, '请用 CW_BROWSER_TEST_EXECUTABLE 指定 Chromium 浏览器');
const useLocal = process.argv.includes('--local-max');
const sourceDirectory = path.resolve(process.env.CW_DATA_DIR || path.join(import.meta.dirname, '../data'));
const profile = useLocal ? localLoadProfile(sourceDirectory) : null;
const sourceResources = useLocal ? activeResources() : null;
const pack = process.env.CW_CONFIG_PACK || (useLocal ? findConfigPack(sourceResources) : null)
  || path.join(import.meta.dirname, '../work/cdn/config_cn_pack.json');
if (useLocal) assert.ok(fs.existsSync(pack), '最高配置压测需要本地游戏配置包，可以用 CW_CONFIG_PACK 指定');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-console-load-'));
process.env.CW_DATA_DIR = dir;
process.env.CW_RESOURCE_DIR = path.join(dir, 'resources');
// 使用本机资源版本和隔离快照，执行正常的资源就绪检查，全程不启动更新器。
delete process.env.CW_CONFIG_PACK;
process.env.CW_RESOURCE_AUTO_UPDATE = '1';
const generation = '0123456789abcdef-00000000-0000-4000-8000-000000000000';
const resourceDir = path.join(process.env.CW_RESOURCE_DIR, generation);
const configFile = path.join(resourceDir, 'config.json');
const { GameClient } = await import('../src/client.mjs');
const { saveStore, DATA_DIR } = await import('../src/accounts.mjs');
assert.equal(DATA_DIR, path.resolve(dir), '虚构账号必须写入本次压测目录');
const { automationTasks } = await import('../src/automation.mjs');
const { beijingDay, saveAutomationSettings, settingsFromNative } = await import('../src/automation-settings.mjs');
const { createConsole } = await import('../src/server.mjs');
const accounts = Array.from({ length: count }, (_, i) => ({
  id: 'bench-' + (i + 1), label: '压测角色 ' + (i + 1), url: 'ws://fixture.invalid',
  login: { eworldParams: { openId: 'bench-' + (i + 1) } }, automation: { autoStart: false, settingsConfigured: true },
}));
const tasks = Object.fromEntries(automationTasks.map(t => [t.key, t.key === 'mail']));
const online = new Set();
let mails = 0;
if (!profile) {
  Object.defineProperty(GameClient.prototype, 'connected', { get() { return online.has(this); } });
  GameClient.prototype.connect = async function (login) {
    const account = accounts.find(row => row.id === login.eworldParams.openId);
    assert.ok(account);
    online.add(this);
    return { playerInfo: { playerId: accounts.indexOf(account) + 1, worldId: 9001, level: 5, nickname: account.label } };
  };
  GameClient.prototype.send = () => {};
  GameClient.prototype.sendWatch = async () => ({});
  GameClient.prototype.stop = function () { online.delete(this); };
  GameClient.prototype.request = async function (name) {
    await sleep(5);
    if (name === 'EmailBoxRequest') { mails++; return { email: [] }; }
    if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: 1000 }] };
    if (name === 'AfkInfoRequest') return { afkInfo: { level: 5 } };
    return {};
  };
}
const replay = profile ? installReplay(GameClient, profile, online) : null;
const protocol = replay?.protocol ?? Object.fromEntries(['OnWater', 'AllItem', 'AllResource', 'AfkInfo', 'EmailBox']
  .flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
const showAccounts = () => history.replaceState({ consoleView: { tab: 'account' } }, '');
async function accountPage(page) {
  await page.goto(root, { waitUntil: 'domcontentloaded' });
  return page.evaluate(async ({ n, local }) => {
    const deadline = performance.now() + 30000;
    while (document.querySelectorAll('#accounts [data-account-action="loop"]').length !== n ||
        document.getElementById('tab-account').classList.contains('hidden')) {
      if (performance.now() > deadline) throw Error('账号卡片未就绪');
      await new Promise(requestAnimationFrame);
    }
    await new Promise(requestAnimationFrame);
    const cardsMs = Math.round(performance.now());
    while (document.querySelectorAll('#accounts [data-account-field="resources"]:has(.qty)').length !== n) {
      if (performance.now() > deadline) throw Error('账号资源未就绪');
      await new Promise(requestAnimationFrame);
    }
    if ([...document.querySelectorAll('#accounts [data-account-field="resources"]')].some(field =>
      ![...field.querySelectorAll('.qty')].some(qty => local ? /[0-9]/.test(qty.textContent) : qty.textContent.replace(/,/g, '') === '1000'))) {
      throw Error('账号卡片缺少模拟回包中的金币');
    }
    await new Promise(requestAnimationFrame);
    return { cardsMs, resourcesMs: Math.round(performance.now()) };
  }, { n: count, local: useLocal });
}

let app, root, browser, memoryTimer, pushTimer;
try {
  const resourcePolicy = resourceUpdatePolicy();
  fs.mkdirSync(resourceDir, { recursive: true });
  if (fs.existsSync(pack)) fs.copyFileSync(pack, configFile);
  else {
    console.warn('未找到游戏配置包，本次使用空表。正式对比请将 CW_CONFIG_PACK 指向相同的本地配置包。');
    fs.writeFileSync(configFile, '[]');
  }
  for (const id of [1, 2]) {
    const target = path.join(resourceDir, 'world_map' + id + '.json');
    const local = sourceResources?.mapFiles[id] ?? path.join(path.dirname(pack), 'world_map.world_map' + id + '.json');
    if (profile && fs.existsSync(local)) fs.copyFileSync(local, target);
    else fs.writeFileSync(target, '{}');
  }
  fs.writeFileSync(path.join(process.env.CW_RESOURCE_DIR, 'active.json'), JSON.stringify({
    generation, scenarios: [1, 2], appVersion: resourcePolicy.appVersion, version: 'benchmark',
  }));
  fs.writeFileSync(path.join(process.env.CW_RESOURCE_DIR, 'check.json'), JSON.stringify({
    version: 1, appVersion: resourcePolicy.appVersion, verifiedGeneration: generation, verifiedAt: new Date().toISOString(),
  }));
  saveStore({ activeId: accounts[0].id, accounts });
  for (const row of accounts) saveAutomationSettings(row.id, profile?.settings ?? settingsFromNative(tasks, { everySeconds: 1 }), { revision: 0 });
  const keys = Object.fromEntries(Array.from({ length: profile?.history.count ?? 300 }, (_, i) =>
    ['past-' + i, { id: String(i), confirmed: true, details: { finished: true } }]));
  if (profile?.history.count) {
    const records = Object.values(keys);
    for (const record of records) record.details.padding = '';
    const extra = Math.max(0, profile.history.bytes - Buffer.byteLength(JSON.stringify(keys)));
    for (const [i, record] of records.entries())
      record.details.padding = 'x'.repeat(Math.floor(extra / records.length) + Number(i < extra % records.length));
  }
  const entries = accounts.map(row => [row.id, { day: beijingDay(Date.now()), counters: {}, confirmed: {}, pending: {}, keys }]);
  fs.writeFileSync(path.join(dir, 'automation-usage.json'), JSON.stringify({ version: 1, accounts: Object.fromEntries(entries) }));
  app = createConsole({ port: 0, protocol });
  root = await app.listen();
  browser = await chromium.launch({ executablePath });
  const launchPage = await browser.newPage();
  await launchPage.addInitScript(showAccounts);
  const cold = monitorEventLoopDelay({ resolution: 10 });
  cold.enable();
  const coldCpuStart = process.cpuUsage();
  const start = performance.now();
  const starts = Promise.all(accounts.map(async row => {
    const res = await fetch(root + '/api/loop/start?account=' + row.id, { method: 'POST',
      body: JSON.stringify(profile ? { confirm: true } : { confirm: true, rounds: 0, everySeconds: 1 }), signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    assert.ok(res.ok && data.running, JSON.stringify(data.error));
  })).then(() => Math.round(performance.now() - start));
  const [startupMs, launchPageTiming] = await Promise.all([starts, accountPage(launchPage)]);
  await launchPage.close();
  const sessions = [...app.sessions.values()];
  const deadline = Date.now() + (profile ? 180000 : 30000);
  while (!sessions.every(s => s.loop.completed >= 1) && Date.now() < deadline) await sleep(50);
  assert.ok(sessions.every(s => s.loop.completed >= 1 && s.loop.running), '每个账号必须实际完成首轮');
  cold.disable();
  const firstRoundMs = Math.round(performance.now() - start);
  const coldCpu = process.cpuUsage(coldCpuStart);
  const initialRounds = sessions.map(s => s.loop.completed);
  const initialMails = mails;
  if (!profile) pushTimer = setInterval(() => {
    for (const client of online) client.emit('message', { name: 'SCNewEmail', body: {} });
  }, 1000);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now(), cpu = process.cpuUsage();
  const initialRss = process.memoryUsage.rss();
  let maxRss = initialRss;
  memoryTimer = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage.rss()); }, 100);
  const loadMs = [];
  let page;
  for (let i = 0; i < 3; i++) {
    if (page) await page.context().close();
    const context = await browser.newContext();
    page = await context.newPage();
    await page.addInitScript(showAccounts);
    loadMs.push(await accountPage(page));
  }
  // 浏览器独立计时，即使 Node 事件循环阻塞也能按时发起下一组请求。
  const latency = await page.evaluate(async duration => {
    async function probe(route) {
      const start = performance.now();
      const response = await fetch('/api/' + route);
      const data = await response.json();
      if (!response.ok || (route === 'loop' ? !data.running : !data.accounts.length)) throw Error(route);
      return performance.now() - start;
    }
    const probes = Array.from({ length: Math.floor(duration * 1000 / 400) }, (_, i) => new Promise(resolve => setTimeout(resolve, i * 400))
      .then(() => Promise.all([probe('accounts'), probe('loop')])));
    return Promise.all(probes);
  }, seconds);
  const cost = process.cpuUsage(cpu), elapsed = performance.now() - started;
  delay.disable();
  const rounds = sessions.map((s, i) => s.loop.completed - initialRounds[i]);
  assert.ok(sessions.every(s => s.loop.running) && (profile || Math.min(...rounds) > 0 && mails - initialMails >= count),
    '每个账号应持续完成挂机轮次并检查邮件，轮数 ' + rounds + '，邮件检查 ' + mails);
  const p95 = values => Math.round(values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]);
  const errors = sessions.flatMap(s => s.log.filter(row => row.level === 'error'));
  const errorTasks = {};
  for (const row of errors) {
    const key = row.extra?.taskKey ?? row.category;
    errorTasks[key] = (errorTasks[key] ?? 0) + 1;
  }
  console.log(JSON.stringify({ accounts: count, configBytes: fs.statSync(configFile).size, versionSource: resourcePolicy.versionSource,
    ...(profile ? { profile: { source: profile.source, revision: profile.revision, level: profile.level, enabled: profile.enabled,
      everySeconds: profile.settings.loop.everySeconds, defaultedFields: profile.filled,
      historyKeys: Object.keys(keys).length, historyBytes: Buffer.byteLength(JSON.stringify(keys)) }, firstRoundMs,
      coldEventLoopP99ms: Math.round(cold.percentile(99) / 1e6), coldMaxMs: Math.round(cold.max / 1e6), coldCpuOneCorePct: Math.round((coldCpu.user + coldCpu.system) / (firstRoundMs * 10)),
      requestTypes: replay.calls.size, replayedTypes: replay.replayed.size, missingRequired: Object.fromEntries(replay.unavailable),
      requests: [...replay.calls.values()].reduce((a,b) => a+b, 0), replayed: [...replay.replayed.values()].reduce((a,b) => a+b, 0),
      roundErrors: errors.length, errorTasks } : {}),
    startupMs, launchPageTiming, accountPageTiming: loadMs, samplesPerApi: latency.length, accountsP95ms: p95(latency.map(r => r[0])),
    loopP95ms: p95(latency.map(r => r[1])), eventLoopP99ms: Math.round(delay.percentile(99) / 1e6),
    cpuOneCorePct: Math.round((cost.user + cost.system) / (elapsed * 10)), peakRssMiB: Math.round(maxRss / 2 ** 20),
    initialRssMiB: Math.round(initialRss / 2 ** 20), endRssMiB: Math.round(process.memoryUsage.rss() / 2 ** 20),
    minRounds: Math.min(...rounds), mails, elapsedMs: Math.round(elapsed) }));
} finally {
  clearInterval(memoryTimer);
  clearInterval(pushTimer);
  await browser?.close();
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
