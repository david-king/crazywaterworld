// Real browser + local console restart, with isolated files and zero game traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-console-version-browser-'));
const environment = ['CW_DATA_DIR', 'CW_CONFIG_PACK', 'CW_RESOURCE_DIR'];
const previousEnvironment = Object.fromEntries(environment.map(key => [key, process.env[key]]));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw Error('版本浏览器测试禁止连接真实游戏'); };
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, settingsFile } = await import('../src/automation-settings.mjs');
const { createConsole } = await import('../src/server.mjs');
const id = 'console-version-browser';
saveStore({ activeId: id, accounts: [{ id, label: '页面版本浏览器测试', url: 'ws://invalid.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true } }] });
const settings = defaultSettings(); settings.resources.allowDiamonds = true;
saveAutomationSettings(id, settings, { revision: 0 });

let app, base, port = 0, browser;
const errors = [], writes = [];
const open = async () => {
  app = createConsole({ port, protocol: {} }); base = await app.listen(); port = app.server.address().port;
};
const close = async () => {
  if (!app) return;
  const closing = app; app = null;
  closing.server.closeAllConnections(); await closing.close();
};
const executablePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);

try {
  assert(executablePath, '需要已安装Chrome或Edge以运行真实浏览器专项');
  await open();
  const originalBase = base;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/settings') {
      writes.push({ version: request.headers()['x-cw-console-version'], payload: request.postDataJSON() });
    }
  });
  await page.goto(base);
  const openSettings = async () => {
    await page.locator('#tabs [data-tab=settings]').click();
    await page.locator('[data-config-tab=base]').click();
    await page.locator('[data-config-family=foundation]').click();
    await page.locator('[data-config-group=resources]').click();
    const disclosure = page.locator('[data-config-branch="resources.allowDiamonds"] > .config-row .config-disclosure');
    if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  };
  await openSettings();
  const budget = page.locator('#config-field-resources-diamondDailyLimit');
  const oldVersion = await page.evaluate(() => window.cwConsoleVersion.version);
  assert(oldVersion); assert.equal(await page.evaluate(() => window.cwConsoleVersion.isStale()), false);
  const before = fs.readFileSync(settingsFile()), initialRevision = loadAutomationSettings(id).revision;
  assert.equal(writes.length, 0, '打开配置不会自动写入');

  // Let offline saves exhaust their existing finite network retries first. The
  // new backend must subsequently be detected by polling alone, without a write.
  await close();
  await budget.fill('1234'); await budget.blur();
  await page.waitForFunction(() => configEditor.saveRetries >= 3 && configEditor.saveTimer === null
    && !configEditor.savePromise && !configEditor.saving, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => configIsDirty()), true);
  assert.equal(await page.evaluate(() => configEditor.draft.resources.diamondDailyLimit), 1234);
  assert.equal(await page.evaluate(() => window.cwConsoleVersion.isStale()), false);
  assert.deepEqual(fs.readFileSync(settingsFile()), before);
  const offlineWrites = writes.length;
  assert(offlineWrites > 0, '实际经过离线保存失败');

  await open();
  assert.equal(base, originalBase, '重启复用原端口且保留旧tab');
  await page.waitForFunction(() => window.cwConsoleVersion.isStale(), null, { timeout: 8000 });
  const banner = page.locator('#console-version-warning'); await banner.waitFor({ state: 'visible' });
  assert.match(await banner.textContent(), /保留.*草稿|草稿已保留/);
  assert.match(await page.locator('#config-state').textContent(), /页面已过期.*草稿已保留/);
  assert.equal(await page.evaluate(() => window.cwConsoleVersion.version), oldVersion, '旧页身份不能随响应静默升级');
  assert.equal(await budget.inputValue(), '1234');
  assert.equal(await page.evaluate(() => configIsDirty()), true);
  assert.equal(await page.evaluate(() => configEditor.draft.resources.diamondDailyLimit), 1234);
  await page.waitForTimeout(1600);
  assert.equal(writes.length, offlineWrites, '轮询发现版本变化后不能自动重发旧草稿');
  assert.deepEqual(fs.readFileSync(settingsFile()), before);
  console.log('通过：同端口后台重启由轮询识别，旧草稿保留，自动保存停止');

  const downloadPromise = page.waitForEvent('download');
  await banner.getByRole('button', { name: '下载游戏配置草稿', exact: true }).click();
  const download = await downloadPromise, downloadedFile = path.join(directory, 'draft.json');
  await download.saveAs(downloadedFile);
  assert.equal(JSON.parse(fs.readFileSync(downloadedFile)).settings.resources.diamondDailyLimit, 1234);
  assert.equal(writes.length, offlineWrites, '下载草稿不发送保存请求');

  // Bypass the frontend helper deliberately to verify the HTTP fence as well.
  const blocked = await page.evaluate(async ({ id, oldVersion }) => {
    const payload = { settings: configEditor.draft, revision: configEditor.data.revision, baseRevision: configEditor.data.baseRevision };
    const results = [];
    for (const version of [oldVersion, null]) {
      const response = await fetch('/api/settings?account=' + id, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(version === null ? {} : { 'X-CW-Console-Version': version }) }, body: JSON.stringify(payload) });
      results.push({ status: response.status, data: await response.json(), version: response.headers.get('X-CW-Console-Version') });
    }
    return results;
  }, { id, oldVersion });
  for (const result of blocked) {
    assert.equal(result.status, 409); assert.equal(result.data.code, 'CLIENT_VERSION_MISMATCH');
    assert.notEqual(result.version, oldVersion);
  }
  assert.deepEqual(fs.readFileSync(settingsFile()), before);
  const stopResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/loop/stop');
  await banner.getByRole('button', { name: '停止当前账号挂机', exact: true }).click();
  assert.equal((await stopResponse).status(), 200);
  assert.equal(app.sessions.get(id).loop.running, false);
  assert.equal(loadAutomationSettings(id).revision, initialRevision);
  console.log('通过：草稿可下载，旧版本/缺版本真实浏览器请求均409，停止接口仍200');

  fs.mkdirSync(path.resolve('output/playwright'), { recursive: true });
  await banner.screenshot({ path: path.resolve('output/playwright/console-version-stale.png') });
  let refreshConfirmed = false;
  page.once('dialog', async dialog => { assert.match(dialog.message(), /保留.*刷新/); refreshConfirmed = true; await dialog.accept(); });
  await Promise.all([page.waitForNavigation(), banner.getByRole('button', { name: '刷新页面', exact: true }).click()]);
  assert.equal(refreshConfirmed, true, '刷新前应提醒保留未保存内容');
  await openSettings();
  const newVersion = await page.evaluate(() => window.cwConsoleVersion.version);
  assert.notEqual(newVersion, oldVersion); assert.equal(newVersion, blocked[0].version);
  assert.equal(await page.evaluate(() => window.cwConsoleVersion.isStale()), false);
  assert.equal(await page.locator('#console-version-warning').count(), 0);
  assert.equal(await budget.inputValue(), String(settings.resources.diamondDailyLimit), '刷新加载已保存配置，旧草稿留在下载文件');
  const savedResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/settings' && response.status() === 200);
  await budget.fill('2345'); await budget.blur(); await savedResponse;
  await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  assert.equal(writes.at(-1).version, newVersion);
  const saved = loadAutomationSettings(id); assert.equal(saved.settings.resources.diamondDailyLimit, 2345);
  assert.equal(saved.revision, initialRevision + 1);
  assert.equal(connections, 0); assert.deepEqual(errors, []);
  console.log('通过：确认刷新后携带新版本正常保存，全程零游戏连接');
  await context.close();
} finally {
  await browser?.close(); await close();
  for (const key of environment) if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  assert(path.basename(directory).startsWith('cw-console-version-browser-'));
  fs.rmSync(directory, { recursive: true, force: true });
}
