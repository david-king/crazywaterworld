import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createHomelandHarness } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness({ http: true });
const output = path.resolve('output/playwright/homeland');
fs.mkdirSync(output, { recursive: true });
let browser;
try {
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(executablePath, '未找到本机验收浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(h.root).origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], posts = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/homeland/action') posts.push(request); });
  await page.addInitScript(() => history.replaceState({ consoleView: { tab: 'resources', resource: 'homeland' } }, '', location.href));
  await page.goto(h.root);
  const panel = page.locator('#tab-homeland');
  const ready = async () => { await panel.getByRole('button', { name: '刷新家园', exact: true }).waitFor(); await panel.getByRole('heading', { name: /家园科技/ }).waitFor(); };
  await ready();
  assert.equal(posts.length, 0);
  assert.match(await panel.textContent(), /累计消费/);
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  const lockedFloor = panel.locator('details').filter({ has: page.locator('summary', { hasText: '家园 3 级开放' }) });
  assert.equal(await lockedFloor.getAttribute('open'), null);
  await lockedFloor.locator('summary').click();
  assert.notEqual(await lockedFloor.getAttribute('open'), null);
  await lockedFloor.locator('summary').click();
  assert.equal(posts.length, 0, '展开楼层只展示详情');
  await page.locator('#theme-trigger').click();
  await page.locator('[data-theme-option="dark"]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'desktop-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(output, 'mobile-dark-320.png'), fullPage: true });
  await page.locator('#theme-trigger').click();
  await page.locator('[data-theme-option="light"]').click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  const claim = panel.getByRole('button', { name: '领取每日免费体力', exact: true });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/homeland/action');
  await claim.evaluate(button => { button.click(); button.click(); });
  assert.equal((await response).status(), 200); await ready();
  assert.equal(posts.length, 1); assert.equal(h.fixtures.get('a').state.stamina, 110);
  assert.match(await panel.textContent(), /每日免费体力：已领取/);
  console.log('通过：真实页面加载、只读进入、免费领取、双击防重与结果刷新');

  page.on('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: /升级家园科技/ }).click(); await ready();
  assert.equal(h.fixtures.get('a').state.home.techLevel, 1);
  assert.equal(h.fixtures.get('a').state.coins, 150);
  await page.evaluate(() => window.cwConsoleStore.getState().actions.selectAccount('b'));
  await ready();
  assert.match(await panel.getByRole('heading', { name: /家园科技/ }).textContent(), /0 级/);
  assert.match(await panel.textContent(), /每日免费体力：可领取/);
  assert.equal(h.fixtures.get('b').state.writes.length, 0);
  await page.evaluate(() => window.cwConsoleStore.getState().actions.selectAccount('offline'));
  await panel.getByText('请先连接当前账号', { exact: true }).waitFor();
  await page.evaluate(() => window.cwConsoleStore.getState().actions.selectAccount('a'));
  await ready();
  console.log('通过：消费确认、科技更新、切换账号隔离与离线提示');

  const state = h.fixtures.get('a').state;
  state.cells = [0, 1].map(cellId => ({ cellId, state: 2, piece: { uid: 500 + cellId, pieceCfgId: '鱼1' } }));
  state.warehouse = [];
  state.orders = [{ slot: 0, orderId: 12, kind: 2, orderType: 0, expireTs: 0, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }];
  await panel.getByRole('button', { name: '刷新家园', exact: true }).click();
  const merge = panel.getByRole('button', { name: '鱼 ×2 → 生鱼片，用于订单 1', exact: true });
  await merge.waitFor();
  assert.match(await panel.textContent(), /备料最少 1 步：合成 1 次/);
  await page.screenshot({ path: path.join(output, 'merge-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '合成计划不能横向溢出');
  await page.screenshot({ path: path.join(output, 'merge-mobile-320.png'), fullPage: true });
  const merged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/homeland/action');
  await merge.evaluate(button => { button.click(); button.click(); });
  assert.equal((await merged).status(), 200);
  await panel.getByText('物品齐备', { exact: true }).waitFor();
  assert.equal(posts.length, 3);
  assert.equal(state.writes.filter(row => row.name === 'DualCombineMoveRequest').length, 1);
  assert(await panel.getByRole('button', { name: '提交订单', exact: true }).isEnabled());
  console.log('通过：显示订单合成计划、手机布局、手动单步合成与双击防重，回读后可交单');

  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '页面不能横向溢出');
    await page.screenshot({ path: path.join(output, `mobile-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('#tabs [data-tab="settings"]').click();
  await page.locator('#config-group-homeland').waitFor({ state: 'attached' });
  await page.locator('[data-config-tab="base"]').click();
  await page.locator('[data-config-family="homeland"]').click();
  const settings = page.locator('#config-group-homeland');
  assert(await settings.isVisible());
  assert.equal(await settings.locator('#config-field-homeland-enabled').getAttribute('aria-checked'), 'false');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
  await settings.locator('#config-field-homeland-enabled').click();
  assert.equal((await saved).status(), 200);
  assert.equal((await h.api('settings')).data.settings.homeland.enabled, true);
  assert.equal((await h.api('settings')).data.settings.homeland.freeStamina, false);
  assert.equal(posts.length, 3, '保存总开关不执行游戏操作');
  assert.doesNotMatch(await settings.textContent(), /尚未选择执行动作/);
  for (const key of ['submitOrders', 'mergeOrders']) {
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    const toggle = settings.locator('#config-field-homeland-' + key);
    if (key === 'mergeOrders' && !await toggle.isVisible()) await settings.getByRole('button', { name: '自动提交工坊订单，展开下级设置' }).click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    const [savedToggle] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST'),
      toggle.click(),
    ]);
    assert.equal(savedToggle.status(), 200);
    assert.equal((await h.api('settings')).data.settings.homeland[key], true);
  }
  assert.equal((await h.api('settings')).data.settings.homeland.takeWarehouse, false);
  for (const key of ['takeWarehouse', 'warehouseBuffer']) {
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    const toggle = settings.locator('#config-field-homeland-' + key);
    if (!await toggle.isVisible()) await settings.getByRole('button', { name: '按订单需求自动合成，展开下级设置' }).click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    const [savedToggle] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST'),
      toggle.click(),
    ]);
    assert.equal(savedToggle.status(), 200);
    assert.equal((await h.api('settings')).data.settings.homeland[key], true);
  }
  assert.equal(posts.length, 3, '保存自动合成开关不立即执行游戏操作');
  await page.setViewportSize({ width: 320, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '配置页不能横向溢出');
  await page.screenshot({ path: path.join(output, 'settings-320.png'), fullPage: true });
  state.cells = ['鱼4', '鱼1'].map((pieceCfgId, cellId) => ({ cellId, state: 2, piece: { uid: 600 + cellId, pieceCfgId } }));
  state.warehouse = [{ uid: 602, pieceCfgId: '鱼1' }];
  state.orders = [{ slot: 0, orderId: 14, kind: 2, orderType: 0, expireTs: 0, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }];
  await page.locator('#tabs [data-tab="resources"]').click();
  await page.locator('[data-resource-tab="homeland"]').click(); await ready();
  await panel.getByRole('button', { name: '刷新家园', exact: true }).click();
  const transit = panel.getByRole('button', { name: '暂存鱼丸到仓库，为订单 1 腾位', exact: true });
  await transit.waitFor();
  assert.match(await panel.textContent(), /备料最少 3 步：合成 1 次、取出 1 次、暂存 1 次/);
  assert.match(await panel.textContent(), /工坊仓库 1 \/ 5/);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(output, 'warehouse-buffer-320.png'), fullPage: true });
  const feasibleRoute = async route => {
    const response = await route.fetch(), data = await response.json();
    for (const order of data.orders) if (order.synthesis?.steps > 0) Object.assign(order.synthesis, { status: 'feasible', lowerBound: 1 });
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/homeland?*', feasibleRoute);
  await panel.getByRole('button', { name: '刷新家园', exact: true }).click();
  await panel.getByText(/可行方案 3 步.*尚未证明步数最少/).waitFor();
  assert.doesNotMatch(await panel.textContent(), /备料最少 3 步/);
  await page.screenshot({ path: path.join(output, 'search-feasible-320.png'), fullPage: true });
  await page.unroute('**/api/homeland?*', feasibleRoute);
  await panel.getByRole('button', { name: '刷新家园', exact: true }).click();
  await panel.getByText(/备料最少 3 步/).waitFor();
  console.log('通过：最优与预算内可行方案分别展示，未证明的方案不标为最少步数');
  const stored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/homeland/action');
  await transit.evaluate(button => { button.click(); button.click(); });
  assert.equal((await stored).status(), 200);
  await panel.getByText(/工坊仓库 2 \/ 5/).waitFor();
  assert.equal(posts.length, 4);
  assert.equal(state.writes.filter(row => row.name === 'DualCombinePutToWarehouseRequest').length, 1);
  console.log('通过：仓库中转开关保存、手机计划与容量展示、单步暂存和回读刷新');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('通过：360/320 像素布局、家园配置保存且不连带开启细项、无页面脚本错误');
} finally { if (browser) await browser.close(); await h.close(); }
