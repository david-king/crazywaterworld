// 真实页面与 HTTP 启停链路，使用临时账号和假客户端，绝不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-account-controls-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [1, 'ResourceCfg', { data: [{ id: 'GOLD', show_name: '金币' }, { id: 'RUBY', show_name: '钻石' }] }],
  [2, 'ItemCfg', { data: ['种子','公会科技点','汽油'].map(id => ({ id, show_name: id })) }],
]));
const { accountFromCredential, saveStore, loadStore } = await import('../src/accounts.mjs');
const { saveAutomationSettings, settingsFromNative } = await import('../src/automation-settings.mjs');
const { automationTasks } = await import('../src/automation.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
const rows = ['first', 'second'].map((id, index) => ({
  ...accountFromCredential({ url: 'wss://fixture.invalid', source: 'mitm',
    login: { eworldParams: { openId: id } } }, { label: index ? '第二个验收账号' : '当前验收账号' }),
  lastSeen: { nickname: index ? '星海船长' : '海风船长', level: 5, worldId: 9001, worldName: '验收1服' },
}));
saveStore({ version: 1, activeId: rows[0].id, accounts: rows });
const tasks = Object.fromEntries(automationTasks.map(task => [task.key, task.key === 'mail']));
for (const row of rows) saveAutomationSettings(row.id, settingsFromNative(tasks, { everySeconds: 3600 }), { revision: 0 });
const live = new Set();
const logins = [];
let mailReads = 0;
Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  const index = rows.findIndex(row => row.id === login.eworldParams.openId);
  assert.ok(index >= 0, '只能连接隔离测试账号');
  logins.push(rows[index].id);
  this.fixtureGold = index ? 7654321 : 3112412;
  live.add(this);
  const otherRole = login.worldId === 9002;
  return { result: 0, playerInfo: { playerId: otherRole ? 3 : index + 1, worldId: otherRole ? 9002 : 9001,
    level: 5, nickname: otherRole ? '二区船长' : rows[index].lastSeen.nickname } };
};
GameClient.prototype.request = async function (name) {
  if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: this.fixtureGold }, { res: 4, amount: 45422 }] };
  if (name === 'AfkInfoRequest') return { afkInfo: { level: 67, afkFinishTime: 1 } };
  if (name === 'OtherPlayerInfoRequest') return { power: 1871646 };
  if (name === 'GameWorldListRequest') return { recentWorlds: [
    { worldId: 9001, roleInfo: { id: 1, worldId: 9001, nickname: '海风船长' } },
    { worldId: 9002, roleInfo: { id: 3, worldId: 9002, nickname: '二区船长' } },
    { worldId: 9003, roleInfo: { id: 4, worldId: 9003, nickname: '三区船长' } },
  ] };
  if (name === 'EmailBoxRequest') { mailReads++; return { email: [] }; }
  return name === 'OnWaterRequest' ? { building: [] } : name === 'AllItemRequest' ? { items: [] } : {};
};
GameClient.prototype.send = () => {};
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.stop = function () { live.delete(this); };
const protocol = Object.fromEntries(['OnWater', 'AllItem', 'AllResource', 'AfkInfo']
  .flatMap(name => [[name + 'Request', true], [name + 'Response', true]]));
const app = createConsole({ port: 0, protocol });
const output = path.resolve('output/account-controls');
fs.mkdirSync(output, { recursive: true });
let browser;
const errors = [];
try {
  const root = await app.listen();
  assert.deepEqual(logins, [], '新账号启动控制台不连接挂机');
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert.ok(executablePath, '未找到验收浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const width of [1280, 360, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    if (width === 1280) {
      await page.addInitScript(() => history.replaceState({consoleView:{tab:'account'}}, ''));
    }
    await page.goto(root);
    await page.locator('#account-picker-title').filter({ hasText: '当前验收账号' }).waitFor();
    await page.locator('#tabs [data-tab="account"]').click();
    const cards = page.locator('#accounts .account-card');
    await cards.nth(0).getByRole('button', {name:'区服管理'}).waitFor();
    const heading = page.locator('.account-page-heading');
    const title = await heading.locator('h2').boundingBox();
    const count = await heading.locator('#account-count').boundingBox();
    for (const name of ['导入账号', '导出账号', '添加账号']) {
      const button = await heading.getByRole('button', { name, exact: true }).boundingBox();
      const centerY = button.y + button.height / 2;
      assert.ok([title, count].every(box => centerY >= box.y && centerY <= box.y + box.height),
        width + 'px账号标题、数量及操作保持同一行');
      if (width < 768) assert.equal(button.height, 32, width + 'px手机工具栏使用紧凑按钮');
    }
    if (width < 768) {
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const selector of ['#loop-every', '#logs-open', '#import-accounts']) {
        const hit = await page.locator(selector).evaluate(control => {
          const box = control.getBoundingClientRect();
          const target = control.closest('label') ?? control;
          return [-21, 21].every(offset => target.contains(document.elementFromPoint(
            box.x + box.width / 2, box.y + box.height / 2 + offset)));
        });
        assert.ok(hit, width + 'px触屏点击控件上下边缘可命中 ' + selector);
      }
    }
    if (width === 1280) {
      await cards.nth(0).getByText('连接后读取资源').waitFor();
      assert.deepEqual(logins, [], '恢复账号页只显示保存的角色资料');
      await cards.nth(0).getByRole('button', {name:'连接并读取'}).click();
    }
    const firstGold = cards.nth(0).locator('[data-account-field="resources"]').getByText('3,112,412');
    const secondGold = cards.nth(1).locator('[data-account-field="resources"]').getByText('7,654,321');
    await firstGold.waitFor();
    await cards.nth(0).getByText('等级 67 · 收益已满').waitFor();
    await cards.nth(0).getByText('1,871,646').waitFor();
    assert.equal(await cards.nth(0).locator('[data-account-field="world"]').innerText(), '海岛9001服');
    assert.equal(await page.locator('#account-worlds-dialog').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '查看详情', exact: true }).count(), 0);
    if (width === 1280) {
      const [a, b] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
      assert.ok(Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && b.x > a.x, '账号卡片等宽并排');
      await cards.nth(1).getByRole('button', {name:'连接并读取'}).click();
      await secondGold.waitFor();
      assert.equal(loadStore().activeId, 'first', '读取非当前账号不切号');
      const manageSecond = cards.nth(1).getByRole('button', {name:'区服管理'});
      await manageSecond.click();
      const manager = page.getByRole('dialog', {name:'第二个验收账号 · 区服管理'});
      await Promise.all([
        page.waitForRequest(request => new URL(request.url()).pathname === '/api/worlds' && new URL(request.url()).searchParams.get('account') === 'second'),
        manager.getByRole('button', {name:'加载区服'}).click(),
      ]);
      await manager.getByText('二区船长', {exact:false}).waitFor();
      await page.keyboard.press('Escape');
      assert.ok(await manageSecond.evaluate(button => button === document.activeElement));
      assert.equal(loadStore().activeId, 'first', '管理其他账号的区服保留当前账号');
      await cards.nth(1).getByRole('button', {name:'切换账号'}).click();
      await cards.nth(1).locator('[data-account-field="current"]').waitFor();
      assert.ok(await firstGold.isVisible() && await secondGold.isVisible(), '切换后两张卡片都保留自己的余额');
      await cards.nth(0).getByRole('button', {name:'切换账号'}).click();
      await cards.nth(0).locator('[data-account-field="current"]').waitFor();
    }
    const first = cards.nth(0).locator('[data-account-action="loop"]');
    const second = cards.nth(1).locator('[data-account-action="loop"]');
    async function checkStatus(index, expected) {
      await page.locator('#account-picker-trigger').click();
      await page.waitForFunction(({ index, expected }) => {
        const card = document.querySelectorAll('#accounts .account-card')[index];
        const option = document.querySelectorAll('#account-picker-list [role="option"]')[index];
        return card?.querySelector('[data-account-field="status"]').textContent === expected
          && option?.querySelector('[data-picker-field="status"]').textContent === expected
          && (index !== 0 || document.querySelector('#account-picker-status').textContent === expected);
      }, { index, expected });
      await page.locator('#account-picker-trigger').click();
    }
    await second.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(loadStore().activeId, 'first');
    assert.equal(app.sessions.get('first')?.loop.running ?? false, false);
    assert.equal(app.sessions.get('second')?.loop.running ?? false, false);
    if (width === 1280) assert.equal(mailReads, 0, '打开页面读取资料不会执行挂机任务');

    const headerHeights = await page.evaluate(async () => {
      const { actions, accountsById } = window.cwConsoleStore.getState();
      const original = accountsById.first.status;
      const heights = [];
      try {
        for (const status of [
          { paused: true },
          { syncingProduction: true, state: 'CONNECTING' },
          { connected: true, looping: true },
        ]) {
          actions.setStatus('first', status);
          await Promise.resolve();
          heights.push(document.querySelector('.headline').getBoundingClientRect().height);
        }
      } finally {
        actions.setStatus('first', original);
      }
      return heights;
    });
    assert.ok(headerHeights.every(height => height === headerHeights[0]), width + 'px暂停、恢复同步和挂机期间页头高度稳定');
    if (width === 1280) {
      const brand = await page.locator('.mast').boundingBox();
      const picker = await page.locator('#account-picker').boundingBox();
      assert.ok(picker.y < brand.y + brand.height, '桌面账号工具栏与标题保持同一行');
    }

    // No render function is called: a store update must reach all DOM consumers.
    await page.locator('#account-picker-trigger').click();
    const storeViews = await page.evaluate(async () => {
      const { actions, accountsById } = window.cwConsoleStore.getState();
      const original = accountsById.first.status;
      const views = [];
      try {
        for (const looping of [true, false]) {
          actions.patchStatus('first', { connected: true, looping, loopStopping: false });
          // The DOM subscription paints in a microtask. Inspect before the next
          // server poll can correctly replace this synthetic test status.
          await Promise.resolve();
          views.push([
            document.querySelector('#account-picker-status').textContent,
            document.querySelector('#account-picker-list [data-picker-field="status"]').textContent,
            document.querySelector('#accounts [data-account-field="status"]').textContent,
            document.querySelector('#loop-toggle').textContent,
          ]);
        }
      } finally {
        actions.setStatus('first', original);
      }
      return views;
    });
    assert.deepEqual(storeViews, [
      ['挂机中', '挂机中', '挂机中', '暂停挂机'],
      ['已连接 · 未挂机', '已连接 · 未挂机', '已连接 · 未挂机', '开始挂机'],
    ]);
    await page.locator('#account-picker-trigger').click();

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requests = 0;
    await page.route('**/api/accounts/pause?account=second', async route => {
      requests++;
      await gate;
      await route.continue();
    });
    await second.click();
    await second.filter({ hasText: '处理中…' }).waitFor();
    assert.equal(await second.isDisabled(), true);
    await second.evaluate(button => button.click());
    release();
    await second.filter({ hasText: '暂停挂机' }).waitFor();
    assert.equal(requests, 1, '重复点击不会提交多次开始');
    assert.equal(loadStore().activeId, 'first', '开始非当前账号不改变选中账号');
    assert.equal(app.sessions.get('second').loop.running, true);
    assert.equal(app.sessions.get('first')?.loop.running ?? false, false);
    assert.equal(loadStore().accounts[1].automation.autoStart, true);
    assert.match(await page.locator('#account-picker-title').textContent(), /当前验收账号/);
    assert.equal(await page.locator('#loop-toggle').textContent(), '开始挂机');
    await checkStatus(0, '已连接 · 未挂机');
    await checkStatus(1, '挂机中');
    await page.unroute('**/api/accounts/pause?account=second');

    await secondGold.waitFor();
    await cards.nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'accounts-' + width + '.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '页面无横向溢出');
    for (const card of await cards.all()) {
      const layout = await card.locator('.account-card-actions').evaluate(actions => {
        const box = actions.getBoundingClientRect();
        return [...actions.children].filter(button => !button.hidden).map(button => {
          const rect = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const text = range.getBoundingClientRect();
          return { top: rect.top, fits: rect.left >= box.left - 1 && rect.right <= box.right + 1,
            textFits: text.left >= rect.left && text.right <= rect.right && text.top >= rect.top && text.bottom <= rect.bottom };
        });
      });
      assert.ok(layout.every(button => button.fits && button.textFits), width + 'px按钮及文字完整可见');
      assert.ok(layout.every(button => Math.abs(button.top - layout[0].top) < 1), width + 'px卡片按钮保持单行');
    }

    await second.click();
    await second.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(app.sessions.get('second').loop.running, false);
    assert.equal(app.sessions.get('second').client.connected, true, '暂停挂机保留连接');
    assert.equal(loadStore().accounts[1].automation.autoStart, false);
    await checkStatus(1, '已连接 · 未挂机');
    await first.click();
    await first.filter({ hasText: '暂停挂机' }).waitFor();
    assert.equal(await page.locator('#loop-toggle').textContent(), '暂停挂机');
    await checkStatus(0, '挂机中');
    if (width === 1280) {
      await page.locator('#account-picker-trigger').click();
      await page.screenshot({ path: path.join(output, 'account-status-consistency.png'), fullPage: true, animations: 'disabled' });
      await page.locator('#account-picker-trigger').click();
    }
    await first.click();
    await first.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(loadStore().accounts[0].automation.autoStart, false);
    await checkStatus(0, '已连接 · 未挂机');
    await page.reload();
    await page.locator('#tabs [data-tab="account"]').click();
    await first.filter({ hasText: '开始挂机' }).waitFor();
    assert.equal(app.sessions.get('first').loop.running, false, '刷新不重启已暂停的挂机');
    if (width === 320) {
      const oldClient = app.sessions.get('first').client;
      await cards.nth(0).getByRole('button', {name:'区服管理'}).click();
      await page.locator('#load-worlds').click();
      await page.locator('#worlds').getByRole('checkbox', { name: '选择 二区船长' }).check();
      await page.locator('#worlds').getByRole('checkbox', { name: '选择 三区船长' }).check();
      await page.locator('#worlds').getByRole('button', { name: '添加所选角色' }).click();
      await page.locator('#worlds .acct').filter({ hasText: '二区船长' }).getByText('已添加', { exact: true }).waitFor();
      await page.getByRole('button', {name:'关闭区服管理'}).click();
      const nextRole = cards.filter({ hasText: '二区船长' });
      const switchRole = nextRole.getByRole('button', { name: '同时托管此角色' });
      await switchRole.waitFor();
      assert.equal(oldClient.connected, true);
      const store = loadStore();
      assert.equal(store.accounts.find(row => row.id === 'first').login.worldId, 9001, '旧记录固定为原角色');
      assert.equal(store.accounts.find(row => row.login.worldId === 9003)?.roleId, '4');
      const added = store.accounts.find(row => row.login.worldId === 9002);
      const endpoint = root + '/api/settings?account=' + encodeURIComponent(added.id);
      const current = await (await fetch(endpoint)).json();
      current.settings.schedule.mail = true;
      assert.equal((await fetch(endpoint, { method: 'POST', body: JSON.stringify({
        confirm: true, settings: current.settings, revision: current.revision, baseRevision: current.baseRevision,
      }) })).status, 200);
      await switchRole.click();
      await nextRole.getByRole('button', { name: '暂停挂机' }).waitFor();
      assert.equal(oldClient.connected, true);
      await nextRole.locator('summary').click();
      await nextRole.getByRole('button', { name: '切换并托管' }).click();
      await page.waitForFunction(() => !document.querySelector('.account-card details[open]'));
      await first.filter({ hasText: '同时托管此角色' }).waitFor();
      assert.equal(oldClient.connected, false);
      assert.equal(app.sessions.get('first').paused, true);
      assert.equal(app.sessions.get('second').client.connected, true, '其他登录账号继续在线');
      await page.reload();
      await firstGold.waitFor();
      await secondGold.waitFor();
      assert.equal(app.sessions.get('first').paused, true, '重开账号页可查看已暂停角色的上次余额');
      console.log('通过：从当前账号卡片添加二区，保留原区并切换托管');
    }
    console.log('通过：' + width + 'px账号启停、单行按钮、请求锁及当前账号隔离');
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('账号启停浏览器验收通过，截图目录 ' + output);
} finally {
  if (browser) await browser.close();
  const jobs = [...app.sessions.values()].map(session => session.loop.job);
  app.server.closeAllConnections();
  await app.close();
  await Promise.allSettled(jobs);
  assert.equal(path.dirname(directory), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
