// 隔离账号验证刷新后的导航恢复；仅操作界面，不连接游戏或保存配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-navigation-browser-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
const originalConnect = GameClient.prototype.connect;
GameClient.prototype.connect = async () => { connections++; throw new Error('导航验收禁止连接游戏'); };
const account = 'navigation-browser', label = '导航验收账号';
saveStore({ activeId: account, accounts: [{ id: account, label, url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true } }] });
saveAutomationSettings(account, defaultSettings(), { revision: 0 });
const baseline = loadAutomationSettings(account);
const app = createConsole({ port: 0, protocol: {} });
let browser;
const errors = [];
let settingsWrites = 0;
try {
  const base = await app.listen();
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, hasTouch: name === 'mobile' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/settings') settingsWrites++;
    });
    const tab = async (id, resource) => {
      await page.locator('#account-picker-title').filter({ hasText: label }).waitFor();
      await page.locator('#tabs [data-tab="' + id + '"][aria-current="page"]').waitFor();
      await page.locator('#tab-' + (resource || id)).waitFor({ state: 'visible' });
      if (resource) await page.locator('[data-resource-tab="' + resource + '"][aria-current="page"]').waitFor();
    };
    const config = async (category, group) => {
      await tab('settings');
      await page.locator('[data-config-tab="' + category + '"][aria-selected="true"]').waitFor();
      await page.locator('#config-group-' + group).waitFor({ state: 'visible' });
      await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    };
    const main = async id => { await page.locator('#tabs [data-tab="' + id + '"]').click(); };
    const cityWar = async () => {
      await main('settings');
      await page.locator('[data-config-tab="world"]').click();
      await page.locator('[data-config-group="cityWar"]').click();
      await config('world', 'cityWar');
    };
    const reloadFrom = async (state, hash = '') => {
      await page.evaluate(({ state, hash }) => history.replaceState(state, '', location.pathname + location.search + hash), { state, hash });
      await page.reload();
    };

    await page.goto(base);
    await tab('overview');
    {
      const edits = {};
      await page.route('**/api/merchant/intel?*', async route => {
        const { changes, scope } = route.request().postDataJSON();
        for (const change of changes) {
          if (change.reset) delete edits[change.cityId];
          else edits[change.cityId] = { ...change, version: 'saved' };
        }
        await route.fulfill({ json: { edits, scope } });
      });
      const paint = (period, intel, purchaseDetails) => page.evaluate(({ period, intel, purchaseDetails }) => renderMerchantOverview({
        startTime: 1, endTime: 3601, serverNow: 1, goal: { target: 50000000, profit: 60, claimed: 0,
          tiers: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, target: (i + 1) * 100, rewards: [] })) }, trade: {
          period, intel: { ...intel, scope: '测试联盟-' + period }, voyage: { facts: [['预期收益', '约 2,575 商会币']],
            status: purchaseDetails ? '买入淡水 ×1' : '航行中', purchaseDetails }, notes: [],
        },
      }), { period, intel: { ...intel, edits }, purchaseDetails });
      const intel = { catalog: [{ id: 1, name: '维生素补剂' }, { id: 2, name: '鱼皮' }, { id: 3, name: '布匹' }], ports: [
        { cityId: 1, revision: '旧', city: '太阳岛', position: '目的港', shortageId: 1, specialtyId: 2, shortage: '维生素补剂', specialty: '鱼皮', reporter: '海鸥' },
        { cityId: 2, revision: '缺', city: '要塞D6', position: '出发港', specialtyId: 3, shortageId: 0, specialty: '布匹', shortage: null, reporter: null },
      ] };
      await page.evaluate(account => localStorage.setItem('cw.merchant-intel.' + account, JSON.stringify({
        scope: '测试联盟-1', ports: { 1: { revision: '旧', specialty: '布匹', shortage: '维生素补剂', reporter: '海鸥' } },
      })), account);
      const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/merchant/intel');
      await paint(1, intel);
      await imported;
      assert.equal(edits[1].specialtyId, 3);
      const purchaseDetails = [['本批预计净收益', '2 商会币'], ['本批占舱', '1 格']];
      await paint(1, intel, purchaseDetails);
      const summary = page.getByText('采购明细', { exact: true });
      const batch = page.getByText('本批预计净收益', { exact: true });
      assert.equal(await batch.isVisible(), false);
      await summary.focus();
      await summary.press('Enter');
      assert.equal(await batch.isVisible(), true);
      await paint(1, intel, purchaseDetails);
      assert.equal(await batch.isVisible(), true);
      await paint(1, intel);
      assert.equal(await summary.count(), 0);
      assert.equal(await page.evaluate(account => localStorage.getItem('cw.merchant-intel.' + account), account), null);
      const panel = page.getByRole('dialog', { name: '港口情报', includeHidden: true });
      const toggle = page.locator('.merchant-score-actions').getByRole('button', { name: '港口情报' });
      assert.equal(await toggle.isVisible(), true);
      assert.equal(await page.locator('#merchant-intel-toggle + .merchant-tier-controls').count(), 1);
      await toggle.focus();
      await toggle.press('Enter');
      await panel.getByText('待共享', { exact: true }).waitFor();
      const first = panel.locator('tbody tr').first();
      assert.match(await first.innerText(), /太阳岛.*目的港/);
      assert.match(await first.innerText(), /维生素补剂/);
      assert.match(await first.innerText(), /海鸥/);
      assert(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      const edit = panel.getByRole('button', { name: '编辑要塞D6情报' });
      await edit.click();
      await panel.getByLabel('紧缺商品').selectOption('2');
      await paint(1, { message: '港口情报读取失败，请刷新总览重试。' });
      assert.equal(await panel.getByLabel('紧缺商品').inputValue(), '2');
      await paint(1, intel);
      assert.equal(await panel.getByLabel('紧缺商品').inputValue(), '2');
      await panel.getByRole('button', { name: '保存情报' }).click();
      await panel.locator('tbody tr').nth(1).getByText('手动', { exact: true }).waitFor();
      await panel.getByRole('button', { name: '关闭港口情报' }).click();
      await paint(1, intel);
      await toggle.click();
      const second = panel.locator('tbody tr').nth(1);
      assert.match(await second.innerText(), /鱼皮/);
      await edit.click();
      await panel.getByRole('button', { name: '恢复游戏情报' }).click();
      await second.getByText('待共享', { exact: true }).waitFor();
      assert.match(await second.innerText(), /待共享/);
      await edit.click();
      await panel.getByLabel('紧缺商品').selectOption('2');
      await panel.getByRole('button', { name: '保存情报' }).click();
      await edit.click();
      await panel.getByLabel('共享人').fill('尚未保存');
      const updated = structuredClone(intel);
      delete edits[2];
      Object.assign(updated.ports[1], { revision: '新', shortage: '维生素补剂', reporter: '新共享人' });
      await paint(1, updated);
      assert.equal(await panel.locator('form').isVisible(), false);
      assert.match(await second.innerText(), /新共享人/);
      assert.doesNotMatch(await second.innerText(), /手动|鱼皮/);
      await paint(1, intel);
      assert.match(await second.innerText(), /待共享/);
      await paint(1, { ports: [], message: '联盟暂无港口情报。' });
      await panel.getByText('联盟暂无港口情报。').waitFor();
      assert.equal(await panel.locator('table').count(), 0);
      await paint(2, intel);
      assert.equal(await panel.locator('table').isVisible(), false);
      const refreshToggle = page.locator('#merchant-auto-refresh'), interval = page.getByLabel('海商王刷新间隔（秒）');
      assert.equal(await refreshToggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await interval.inputValue(), '30');
      assert(await interval.evaluate(node => node.getBoundingClientRect().right <= document.documentElement.clientWidth));
      await refreshToggle.click();
      await interval.fill('4');
      await interval.press('Tab');
      assert.equal(await interval.evaluate(node => node.validity.valid), false);
      await interval.fill('5');
      await interval.press('Tab');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('cw.merchant.refresh'))), { enabled: false, seconds: 5 });
      const reads = await page.evaluate(async () => {
        const originalCall = call, originalStatus = snapshot, wasDisconnected = disconnected.has(current);
        const reads = [];
        try {
          snapshot = { ...snapshot, connected: true, paused: false, loginBlocked: false };
          disconnected.delete(current);
          call = async path => {
            reads.push(path);
            return { startTime: 1, endTime: 3601, serverNow: 1, lines: ['已刷新本船'] };
          };
          merchantLastRefresh = 0;
          await maybeRefreshMerchant();
          if (reads.length) throw Error('关闭后仍自动读取');
          $('merchant-auto-refresh').click();
          await maybeRefreshMerchant();
          if (reads.length !== 1 || !$('merchant-overview-progress').textContent.includes('已刷新本船')) throw Error('开启后未立即更新本船');
          await maybeRefreshMerchant();
          if (reads.length !== 1) throw Error('间隔未到就再次刷新');
          merchantLastRefresh = Date.now() - 5000;
          await Promise.all([maybeRefreshMerchant(), maybeRefreshMerchant()]);
          $('merchant-auto-refresh').click();
          return reads;
        } finally {
          call = originalCall;
          snapshot = originalStatus;
          if (wasDisconnected) disconnected.add(current);
        }
      });
      assert.deepEqual(reads, Array(2).fill('/api/merchant/overview?account=' + account));
      await page.reload();
      await tab('overview');
      assert.equal(await refreshToggle.getAttribute('aria-pressed'), 'false');
      assert.equal(await interval.inputValue(), '5');
      await page.evaluate(() => renderMerchantOverview(null));
    }
    {
      const runtime = await (await page.request.get(base + '/api/loop?account='+account)).json();
      Object.assign(runtime, {running:true, connected:true, completed:8, fleetMaintenance:null, controls:[
        {key:'factory.gain', group:'基地', label:'领取工厂产品', enabled:true, observation:{state:'ok',text:'已领取 3 份工厂产品',checkedAt:1700000000}},
        {key:'farm.enabled', group:'基地', label:'农田', enabled:true, observation:{state:'waiting',text:'作物尚未成熟，等待收获'}},
        {key:'forge.enabled', group:'装备', label:'装备自动锻造', enabled:true, observation:{state:'error',text:'锻造队列读取失败'}},
        {key:'gather.fishing', group:'采集', label:'自动钓鱼', enabled:true, blockedBy:['采集总开关']},
        {key:'gather.diving', group:'采集', label:'潜水打捞原料', enabled:true, blockedBy:['采集总开关']},
        {key:'cityWar.enabled', group:'世界与挑战', label:'联盟城战', enabled:true, observation:{state:'pending',text:'舰队派遣结果待确认'}},
        {key:'events.enabled', group:'基地', label:'随机事件', enabled:true, observation:{state:'unsynced',text:'等待随机事件推送'}},
        {key:'cargo.enabled', group:'基地', label:'贸易港口', enabled:false},
        ...Array.from({length:68}, (_, index) => ({
          key:'fixture.'+index, group:'验收功能', label:'巡查 '+(index+1), enabled:true,
          observation:{state:'waiting',text:'已核对第 '+(index+1)+' 份记录'},
        })),
      ]});
      const route = '**/api/loop?*';
      await page.route(route, intercepted => intercepted.fulfill({json:runtime}));
      const refresh = () => page.evaluate(() => refreshLoop());
      await refresh();
      const rows = page.locator('#overview-task-groups'), search = page.locator('#overview-task-search');
      const filter = page.locator('#overview-task-filter');
      const gather = rows.locator('[data-feature="gather"]');
      await page.locator('#overview-matches').getByText('共 75 个功能').waitFor();
      await rows.getByText('已领取 3 份工厂产品', {exact:true}).first().waitFor();
      assert(await rows.locator('.overview-feature').count() < 25);
      assert.match(await page.locator('#overview-task-summary').innerText(), /本次完成 8 轮/);
      assert.match(await gather.locator('summary').innerText(), /采集总开关/);
      assert(await rows.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      const output = path.resolve('output/playwright/runtime-overview');
      fs.mkdirSync(output, {recursive:true});
      await page.locator('#tab-overview [data-slot=card]').first().screenshot({path:path.join(output, name+'.png')});
      await gather.locator('summary').click();
      await gather.getByText('自动钓鱼',{exact:true}).waitFor();
      await rows.focus();
      await rows.press('End');
      const last = rows.locator('summary').filter({hasText:'已关闭'});
      await last.waitFor();
      await page.waitForFunction(() => {
        const list = document.getElementById('overview-task-groups');
        return !list.querySelector('[data-feature="gather"]') && list.scrollHeight - list.clientHeight - list.scrollTop < 2;
      }).catch(async error => {
        console.error(await rows.evaluate(list => ({top:list.scrollTop, total:list.scrollHeight, height:list.clientHeight,
          focus:document.activeElement.id, mounted:[...list.querySelectorAll('.overview-feature')].map(node => node.dataset.feature)})));
        throw error;
      });
      const position = await last.boundingBox();
      runtime.controls[0].observation.checkedAt++;
      await refresh();
      assert(Math.abs((await last.boundingBox()).y-position.y) <= 1);
      await rows.press('Home');
      await gather.getByText('自动钓鱼',{exact:true}).waitFor();
      assert(await gather.evaluate(node => node.open));
      await search.fill('第 68 份记录');
      await page.locator('#overview-matches').getByText('共 1 个功能').waitFor();
      await rows.locator('summary').getByText('巡查 68').waitFor();
      assert.equal(await rows.evaluate(node => node.scrollTop), 0);
      await search.fill('');
      await filter.selectOption('issues');
      await page.locator('#overview-matches').getByText('共 3 个功能').waitFor();
      await gather.locator('summary').click();
      await gather.getByText('自动钓鱼',{exact:true}).waitFor();
      await gather.getByText('潜水打捞原料',{exact:true}).waitFor();
      const link = gather.getByRole('link',{name:'查看采集配置'});
      await link.focus();
      runtime.controls[0].observation.checkedAt++;
      await refresh();
      assert(await link.evaluate(node => node === document.activeElement));
      await link.click();
      await config('base','gather');
      await main('overview');
      await filter.selectOption('all');
      await search.fill('推送');
      assert.match(await rows.innerText(), /随机事件.*待同步/s);
      await search.fill('找不到这项');
      await rows.getByText('没有找到匹配的功能或原因').waitFor();
      await search.fill('工厂');
      runtime.running = false;
      await refresh();
      await rows.locator('summary').filter({ hasText: '未运行' }).waitFor();
      assert.match(await rows.innerText(), /未运行.*上次记录.*已领取/s);
      runtime.running = true;
      delete runtime.controls[0].observation;
      await refresh();
      await rows.locator('summary').getByText('待检查').waitFor();
      runtime.controls.push({key:'factory.produce',group:'基地',label:'工厂自动生产',enabled:true,
        observation:{state:'error',text:'生产队列读取失败'}});
      await refresh();
      assert.match(await rows.locator('summary').innerText(), /1 项失败.*工厂自动生产.*生产队列读取失败/s);
      await filter.selectOption('issues');
      assert.match(await rows.locator('summary').innerText(), /1 项失败/);
      await filter.selectOption('all');
      runtime.controls = [
        {key:'factory.enabled',group:'基地',label:'工厂总开关',enabled:true,observation:{state:'scope'}},
        {key:'factory.gain',group:'基地',label:'领取产品',enabled:false},
      ];
      await refresh();
      await rows.locator('summary').getByText('未开启动作').waitFor();
      await search.fill('居民订单');
      const reward = {key:'resident.rewards', group:'基地', label:'领取居民订单进度奖励', enabled:true};
      runtime.controls = [reward];
      for (const [state, badge, text] of [
        ['inProgress', '进行中', '今日已交 3 单，下一档 6 单'],
        ['completed', '已完成', '今日 6 档奖励已全部领取'],
      ]) {
        reward.observation = {state, text};
        await refresh();
        const summary = rows.locator('summary');
        await summary.getByText(badge, {exact:true}).waitFor();
        assert((await summary.innerText()).includes(text));
        assert.doesNotMatch(await summary.innerText(), /待检查|上次记录/);
      }
      await page.unroute(route);
      await page.reload(); await tab('overview');
    }
    const search = page.getByRole('button', { name: '站内搜索', exact: true });
    const dialog = page.getByRole('dialog', { name: '站内搜索' });
    const query = dialog.getByRole('combobox');
    const searchBox = await search.boundingBox();
    const themeBox = await page.locator('#theme-trigger').boundingBox();
    assert(searchBox.x + searchBox.width <= themeBox.x && Math.abs(searchBox.y - themeBox.y) <= 1);
    if (name === 'desktop') {
      const logBox = await page.locator('#logs-open').boundingBox();
      assert(logBox.x + logBox.width <= searchBox.x && Math.abs(logBox.y - searchBox.y) <= 1);
    }
    await search.click();
    assert(await query.evaluate(input => input === document.activeElement));
    await query.fill('自动激活藏品');
    await dialog.getByRole('option', { selected: true }).filter({ hasText: '自动激活藏品' }).waitFor();
    await query.press('Enter');
    await config('antique', 'antique');
    await page.waitForFunction(() => {
      const bounds = document.getElementById('config-field-antique-activate').getBoundingClientRect();
      return bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight;
    });
    assert(await page.locator('#config-field-antique-activate').evaluate(field => {
      const row = field.closest('.config-row');
      return !row.matches(':focus-within') && getComputedStyle(row).outlineStyle === 'none';
    }), '配置项应滚入视口，不获得焦点或显示外框');
    await page.keyboard.press('Control+k');
    await query.fill('无此功能xyz');
    await dialog.getByRole('status').filter({ hasText: '没有找到匹配的结果' }).waitFor();
    await query.fill('杂项 仓库');
    const first = await query.getAttribute('aria-activedescendant');
    await query.press('ArrowDown');
    assert.notEqual(await query.getAttribute('aria-activedescendant'), first);
    await dialog.getByRole('option').filter({ hasText: '养成材料' }).click();
    await tab('resources', 'inventory');
    await page.locator('#inventory-tab-growth[aria-selected="true"]').waitFor();
    await search.click();
    await query.fill('总览');
    await dialog.getByRole('option', { selected: true }).click();
    await tab('overview');
    assert(await page.locator('#tab-overview').evaluate(async section => {
      await new Promise(requestAnimationFrame);
      return !section.matches(':focus-within') && getComputedStyle(section).outlineStyle === 'none';
    }), '跳回总览后整页不获得焦点或显示外框');
    await search.click();
    await query.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(await search.evaluate(button => button === document.activeElement));
    await reloadFrom(null);
    await tab('overview');
    assert.equal(await page.locator('#tabs [data-tab="activities"]').getAttribute('aria-label'), '活动');
    assert.equal(await page.locator('#tabs [data-tab="resources"]').getAttribute('aria-label'), '杂项');
    assert.deepEqual(await page.locator('[data-resource-tab]').allTextContents(), ['联盟', '仓库', '装备与徽章', '礼包兑换', '日常任务', '商店', '赛季预览', '聊天']);
    assert.equal(await page.locator('#tabs [data-tab="items"]').count(), 0);
    await main('settings');
    await config('base', 'building');
    await page.reload();
    await config('base', 'building');

    await cityWar();
    assert.equal(new URL(page.url()).hash, '#config-group-cityWar');
    await page.reload();
    await config('world', 'cityWar');
    {
      await page.locator('[data-config-group="treasure"]').click();
      await config('world', 'treasure');
      const preview = page.getByRole('region', {name:'运行预览', exact:true});
      assert.equal(await preview.getByRole('combobox').count(), 0, '当前页直接决定预览功能');
      const reason = '已达到游戏今日货轮领奖上限，按“打满就停”停止常规派遣和备战维修';
      const loopRoute = '**/api/loop?*';
      const runtime = await (await page.request.get(base + '/api/loop?account='+account)).json();
      Object.assign(runtime,{running:true, connected:true, controls:[{key:'treasure.enabled', label:'万吨巨轮自动参与', enabled:true,
        observation:{state:'waiting', text:reason}}]});
      await page.route(loopRoute, intercepted => intercepted.fulfill({json:runtime}));
      await page.evaluate(() => refreshLoop());
      await preview.getByText(reason, {exact:true}).waitFor();
      const route = '**/api/settings/preview?*';
      await page.route(route, intercepted => {
        assert.equal(intercepted.request().postDataJSON().category, 'world');
        return intercepted.fulfill({json:{checkedAt:'2026-11-20T15:28:14Z', usage:{counters:{}}, actions:[],
          notes:[reason, reason, '中小货轮兜底领奖目标已达到', '货轮甲：个人进度已达上限'],
          counts:{treasures:4, fleets:2}, treasure:{todayRewardTimes:3, rewardLimit:3, participationMode:'untilFull',
            targets:[{label:'货轮甲', reason:'个人进度已达上限', personalProgress:20, personalProgressLimit:20}],
            fleets:[], fuel:6633870, fuelPerFleet:500}}});
      });
      assert.equal(await page.locator('#config-root section[aria-labelledby=config-runtime-title]').count(), 0);
      await preview.getByRole('button', {name:'只读预览计划'}).click();
      await preview.getByText('本次没有可排动作').waitFor();
      await page.evaluate(() => refreshLoop());
      await preview.getByText('今日领奖 3/3 次 · 候选货轮 4 艘 · 读到舰队 2 支').waitFor();
      assert.equal((await preview.innerText()).split(reason).length-1, 1);
      assert.equal(await preview.locator('details[open]').count(), 0);
      assert(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await preview.evaluate(node => node.scrollIntoView({block:'center', behavior:'instant'}));
      await preview.screenshot({path:path.resolve('output/playwright/runtime-overview', 'preview-'+name+'.png')});
      await preview.getByText('其他检查说明（1）').click();
      await preview.getByText('中小货轮兜底领奖目标已达到').waitFor();
      await preview.getByText('查看货轮与舰队条件').click();
      await preview.getByRole('cell', {name:'个人进度已达上限'}).waitFor();
      await page.unroute(route);
      await page.route(route, intercepted => intercepted.fulfill({status:503, json:{error:'货轮状态读取超时'}}));
      await preview.getByRole('button', {name:'只读预览计划'}).click();
      await preview.getByText('预览未完成：货轮状态读取超时').waitFor();
      assert.doesNotMatch(await preview.innerText(), /本次没有可排动作|候选货轮 4 艘/);
      await page.unroute(route);
      await page.route(route, intercepted => intercepted.fulfill({json:{usage:{counters:{}}, notes:[],
        actions:Array.from({length:5}, (_, i) => ({label:'派遣舰队 '+(i+1),costs:[{name:'汽油',num:500}]}))}}));
      await preview.getByRole('button', {name:'只读预览计划'}).click();
      await preview.getByText('本次可排 5 项').waitFor();
      assert.equal(await preview.locator('li:visible').count(), 3);
      await preview.getByText('其余 2 项动作').click();
      assert.equal(await preview.locator('li:visible').count(), 5);
      await page.unroute(route);
      await page.unroute(loopRoute);
      await page.locator('[data-config-group="cityWar"]').click();
      assert.doesNotMatch(await preview.innerText(), /货轮领奖上限|本次没有可排动作/);
    }
    await page.locator('[data-config-tab="base"]').click();
    await page.locator('[data-config-family="production"]').click();
    await page.locator('[data-config-group="farm"]').click();
    await config('base', 'farm');
    {
      const route = '**/api/settings/preview?*';
      const preview = page.getByRole('region', {name:'运行预览', exact:true});
      await page.route(route, intercepted => intercepted.fulfill({json:{checkedAt:'2026-11-20T15:30:00Z', usage:{counters:{}},
        actions:[{kind:'cargoReward',label:'领取到港货物',costs:[]}], notes:['收到基地计划'],
        moduleNotes:{farm:['种子不足'],cargo:['等待装货']}}}));
      await preview.getByRole('button', {name:'只读预览计划'}).click();
      await preview.getByText('种子不足').waitFor();
      assert.match(await preview.innerText(), /本次没有可排动作/);
      assert.doesNotMatch(await preview.innerText(), /领取到港货物|等待装货|收到基地计划/);
      await page.unroute(route);
      const pending = page.waitForRequest(req => new URL(req.url()).pathname === '/api/settings/preview');
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route(route, async intercepted => {
        await gate;
        await intercepted.fulfill({json:{actions:[], usage:{counters:{}}, moduleNotes:{farm:['旧农田预览']}}});
      });
      const run = preview.getByRole('button', {name:'只读预览计划'});
      await run.click();
      await pending;
      try {
        await page.locator('[data-config-group="factory"]').click();
        await page.locator('[data-config-group="farm"]').click();
      } finally { release(); }
      await page.waitForFunction(() => !document.querySelector('#config-preview').disabled);
      assert.doesNotMatch(await preview.innerText(), /旧农田预览|种子不足/);
      await page.unroute(route);
    }
    await page.reload();
    await config('base', 'farm');

    // 已载入的草稿返回配置时可能不重绘，仍须恢复当前分组的 URL。
    await cityWar();
    await main('overview');
    await tab('overview');
    assert.equal(new URL(page.url()).hash, '');
    await main('settings');
    await config('world', 'cityWar');
    assert.equal(new URL(page.url()).hash, '#config-group-cityWar');
    await page.reload();
    await config('world', 'cityWar');
    await main('overview');
    await page.reload();
    await tab('overview');
    assert.equal(new URL(page.url()).hash, '');

    await cityWar();
    await main('resources');
    await page.getByRole('button', { name: '装备与徽章', exact: true }).click();
    await tab('resources', 'heroes');
    assert.equal(new URL(page.url()).hash, '');
    await main('settings');
    await config('world', 'cityWar');
    assert.equal(new URL(page.url()).hash, '#config-group-cityWar');
    await main('resources');
    await tab('resources', 'heroes');
    await page.reload();
    await tab('resources', 'heroes');
    for (const legacy of [{ tab: 'items', resource: 'guild' }, { tab: 'resources', resource: 'items' }]) {
      await reloadFrom({ consoleView: legacy });
      await tab('resources', 'heroes');
      const equipment = page.getByRole('region', { name: '装备与徽章', exact: true });
      await equipment.locator('#items-root').getByText('账号已暂停，恢复托管后可查看装备。').waitFor();
      await equipment.getByRole('button', { name: '刷新装备厂' }).waitFor();
    }
    await page.locator('[data-resource-tab="dailies"]').click();
    await page.reload();
    await tab('resources', 'dailies');
    await page.locator('#tab-dailies').getByText('账号已暂停，请先恢复托管').waitFor();
    await page.locator('[data-resource-tab="heroes"]').click();

    // 活动独立为顶级页面，返回杂项继续显示原子页。
    await main('activities');
    await tab('activities');
    assert.equal(await page.locator('#tab-activities [data-activity="pirates"], #tab-activities #pirate-board-view').count(), 0);
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);
    await main('resources');
    await tab('resources', 'heroes');
    await main('activities');
    await page.reload();
    await tab('activities');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);

    // 旧版保存在资源与玩法中的活动位置迁移到顶级活动；杂项仍默认打开联盟。
    await reloadFrom({ consoleView: { tab: 'resources', resource: 'activities' } });
    await tab('activities');
    assert.equal(await page.locator('#resource-tabs').isVisible(), false);
    await page.waitForFunction(() => history.state?.consoleView?.tab === 'activities');
    await main('resources');
    await tab('resources', 'guild');

    // 独立登录设置入口已并入账号，旧页面记录恢复到账号列表。
    await reloadFrom({ consoleView: { tab: 'login-settings', resource: 'guild' } });
    await tab('account');
    assert.equal(await page.locator('#tabs [data-tab="login-settings"]').count(), 0);
    await page.locator('#accounts [data-account-action="login-settings"]').waitFor();
    assert.equal(await page.locator('#account-login-dialog').isVisible(), false);
    await page.waitForFunction(() => history.state?.consoleView?.tab === 'account');

    // 显式配置深链优先于原来的主页面；旧版分组链接沿用现有迁移。
    await reloadFrom({ consoleView: { tab: 'overview', resource: 'guild' } }, '#config-group-cityWar');
    await config('world', 'cityWar');
    await reloadFrom({ consoleView: { tab: 'resources', resource: 'heroes' } }, '#config-group-equipment-legacy');
    await config('equipment', 'forge');
    await reloadFrom({ consoleView: { tab: 'missing-page', resource: 'heroes' } });
    await tab('overview');
    await page.waitForFunction(() => history.state?.consoleView?.tab === 'overview');
    await reloadFrom({ consoleView: { tab: 'resources', resource: 'missing-resource' } });
    await tab('resources', 'guild');
    await reloadFrom(null, '#journal');
    await tab('overview');
    await page.locator('#journal-dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await main('resources');
    await page.reload();
    await tab('resources', 'guild');
    assert.equal(new URL(page.url()).hash, '');
    await reloadFrom(null, '#pirate-first-kill');
    await tab('stages');
    const pirateDetails = page.locator('#tab-stages #pirate-details');
    assert.equal(await pirateDetails.evaluate(panel => panel.open), false);
    await pirateDetails.locator('summary').click();
    await pirateDetails.locator('#pirate-board-view').getByText('账号已暂停').waitFor();
    await main('overview');
    await page.reload();
    await tab('overview');
    assert.equal(new URL(page.url()).hash, '');
    // Only the browser sees a connected account. The real console fixture stays paused.
    let ready = false, planReads = 0, releasePlan;
    const readGate = new Promise(resolve => { releasePlan = resolve; });
    await page.route(/\/api\/accounts(?:\?|$)/, async route => {
      const response = await route.fetch(), data = await response.json();
      if (ready) Object.assign(data.accounts[0].status, { connected:true, paused:false, syncingProduction:false });
      await route.fulfill({ response, json:data });
    });
    await page.route('**/api/world?*', route => route.fulfill({ json:{ factories:[], farms:[], orders:[], stock:[] } }));
    await page.route('**/api/world/production-plan?*', async route => {
      assert.equal(new URL(route.request().url()).searchParams.get('account'), account);
      assert.equal(route.request().method(), 'GET');
      const read = ++planReads, now = 1767225600;
      if (read === 2) await readGate;
      await route.fulfill({ json:{ snapshotTime:now, orders:[], forecast:{ startAt:now, endAt:now+86400,
        completions:[], factories:[{ id:'1金属厂', name:'金属厂', runs:[{ name:'铜锭', quantity:read,
          from:now, to:now+read, lane:1, status:'queued' }] }] } } });
    });
    await main('manual');
    const card = page.locator('#production-day-card');
    await card.getByText('连接账号后自动显示排产清单。').waitFor();
    assert.equal(planReads,0);
    ready = true;
    await page.evaluate(() => refreshAccountStatuses());
    const quantity = card.locator('.production-batch-quantity');
    await quantity.filter({ hasText:'×1' }).waitFor();
    assert.equal(await page.locator('#production-day-preview').count(), 0);
    await page.getByRole('button', { name:'查看排产清单' }).click();
    assert.equal(await page.locator('#production-day-title').evaluate(node => node === document.activeElement),true);
    await main('settings');
    await main('manual');
    await page.locator('#production-day-result[aria-busy="true"]').waitFor();
    await main('manual');
    await quantity.filter({ hasText:'×1' }).waitFor();
    releasePlan();
    await quantity.filter({ hasText:'×2' }).waitFor();
    assert.equal(planReads,2);
    await page.reload();
    await tab('manual');
    await quantity.filter({ hasText:'×3' }).waitFor();
    assert.equal(planReads,3);
    await context.close();
    console.log('通过：' + name + ' 页头搜索位置、快捷键、配置项滚动定位、总览与仓库分类跳转，导航刷新恢复、深链与无效状态回退');
  }
  assert.deepEqual(errors, []);
  assert.equal(settingsWrites, 0, '导航不保存配置');
  assert.equal(connections, 0, '导航不连接游戏');
  const after = loadAutomationSettings(account);
  assert.equal(after.revision, baseline.revision);
  assert.deepEqual(after.settings, baseline.settings);
  for (const session of app.sessions.values()) {
    assert.equal(session.client, null);
    assert.equal(session.loop.running, false);
  }
  console.log('通过：零配置写入、零游戏连接，导航恢复不改变账号设置');
} catch (error) {
  if (errors.length) console.error(errors);
  throw error;
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await app.close();
  GameClient.prototype.connect = originalConnect;
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cw-navigation-browser-')) throw new Error('拒绝清理意外目录');
  fs.rmSync(directory, { recursive: true, force: true });
}
