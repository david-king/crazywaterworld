// 隔离账号验证模块启停与配置共页；禁止连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-unified-config-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
const items = [{ id: '望远镜碎片', show_name: '古董望远镜碎片', type: '藏品碎片' }, ...['耐火砖','高温合金','木板'].map(id => ({ id })),
  { id: '礼包A', show_name: '材料礼包' }, { id: '礼包B', show_name: '材料礼包' }];
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([[1, 'HeroCfg', { data: [
  { id: '瑞文', name: '骑士瑞文', quality: 'PURPLE', type: '英雄' },
  { id: '波奇', name: '波奇', quality: 'PURPLE', type: '英雄' },
  { id: '训练目标', name: '训练木人', quality: 'PURPLE', type: 'NPC' },
] }], [2, 'BuildingUnlockCfg', { data: [
  ...[1, 2, 3].map(id => ({ buildingType: '远征船', buildingId: id + '远征船' })),
  ...[1, 2].map(id => ({ buildingType: '精铁厂', buildingId: id + '精铁厂' })),
  { buildingType: '海水厂', buildingId: '1海水厂' },
] }],
  [3, 'ItemCfg', { data: items }],
  [10, 'MuseumExpeditionStageCfg', { data: [{ stageId: 1, name: '旧灯塔瞭望台', exploreTime: 14400 }] }],
  [11, 'MuseumStageStarCfg', { data: [{ star: 1, exploreValue: 250 }] }],
  [12, 'MuseumExpeditionRewardCfg', { data: [{ stageId: 1, star: 1, randomRewards: [['望远镜碎片',1]], randomRewardWeights: [1] }] }],
  [4, 'BuildingCfg', { data: [{ buildingType: '精铁厂', name: '冶炼厂' }, { buildingType: '海水厂', name: '海水提取厂' }] }],
  [5, 'BuildingUpgradeCfg', { data: [{ buildingType: '精铁厂', product: [['精铁', 1]] }] }],
  [6, 'ItemJumpCfg', { data: [{ id: '耐火砖', accessList: ['折扣商店'] }] }],
  [9, 'BuildingProduceCfg', { data: [...['耐火砖','高温合金','精铁'].map(itemId => ({ itemId,buildType:'精铁厂',unlockLevel:1,produceTime:20,costItem:[] })),
    {itemId:'淡水',buildType:'海水厂',unlockLevel:1,produceTime:5,costItem:[]}] }],
  [7, 'TrialRaidCfg', { data: ['英雄经验副本', '强化石副本', '海兽经验副本'].map((title, i) => ({ raidId: i + 1, title })) }],
  [8, 'TrialRaidStageCfg', { data: [1, 2, 3].flatMap(raidId => Array.from({ length: 15 }, (_, i) => ({
    raidId, stageId: raidId * 1000 + i + 1, stageLevel: i + 1, openLevel: raidId === 3 ? 25 : 14,
  }))) }],
]));
const { saveStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, settingsUiRules } = await import('../src/automation-settings.mjs');
const { GameClient } = await import('../src/client.mjs');
const { observeOwnedFleets } = await import('../src/fleet-catalog.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('配置验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'config-a', accounts: ['config-a', 'config-b'].map((id, index) => ({
  id, label: '配置验收账号' + (index + 1), url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
})) });
const settings = defaultSettings();
settings.loop.world = true;
settings.factory.enabled = true; settings.factory.produce = false; settings.factory.keepStock = 321;
settings.heroes.enabled = true; settings.loop.heroes = false; settings.heroes.level = false; settings.heroes.star = true;
settings.heroes.needsSelection = true;
settings.antique.maxActions = 7; settings.antique.checkEverySeconds = 90;
settings.museum.runEnabled = true; settings.museum.enabled = settings.museum.upgrade = false;
settings.lineups.presets = [
  { id: 'boss-first', name: '世界Boss一队', formation: { presetId: 1, heroPositions: [{ heroId: '瑞文', pos: { x: 4, y: 4 } }], petUid: '0' } },
  { id: 'boss-second', name: '世界Boss二队', formation: { presetId: 1, heroPositions: [{ heroId: '波奇', pos: { x: 4, y: 4 } }], petUid: '0' } },
];
saveAutomationSettings('config-a', settings, { revision: 0 });
const otherSettings = defaultSettings();
otherSettings.heroes.heroIds = ['训练目标'];
saveAutomationSettings('config-b', otherSettings, { revision: 0 });
const otherBefore = loadAutomationSettings('config-b');
const output = path.resolve('output/unified-config'); fs.mkdirSync(output, { recursive: true });
const museumOutput = path.resolve('output/playwright/unified-config'); fs.mkdirSync(museumOutput, { recursive: true });
const app = createConsole({ port: 0, protocol: {} });
let browser;
const errors = [];
try {
  const base = await app.listen();
  await fetch(base + '/api/settings?account=config-a');
  const bossSession = app.sessions.get('config-a');
  bossSession.player = { playerId: 123, worldId: 1001001 };
  observeOwnedFleets(bossSession, [1, 2, 3].map(id => ({ buildingId: id + '远征船' })), { complete: true });
  const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(fs.existsSync);
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const saved = () => page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  const openConfig = async () => {
    await page.locator('#account-picker-title').filter({ hasText: '配置验收账号' }).waitFor();
    await page.locator('#tabs [data-tab=settings]').click();
    await page.locator('#config-field-building-enabled').waitFor({ state: 'attached' }); await saved();
  };
  const group = async id => {
    await page.evaluate(id => {
      const item = configEditor.groups.get(id);
      configActivate(item.category); configActivateGroup(id);
    }, id);
    await page.locator('#config-group-' + id).waitFor();
  };
  await page.goto(base); await openConfig();
  const desktopTabs = page.locator('.config-tabs');
  const tabBounds = await desktopTabs.boundingBox();
  const toolbarBounds = await page.locator('.config-toolbar').boundingBox();
  assert(tabBounds.width < toolbarBounds.width / 2, '桌面分类标签按内容占宽');
  assert(Math.abs(tabBounds.x - toolbarBounds.x) < 1, '桌面分类标签与账号信息左对齐');
  await page.screenshot({ path: path.join(output, 'config-navigation-desktop.png'), animations: 'disabled',
    clip: { x: toolbarBounds.x, y: toolbarBounds.y, width: toolbarBounds.width, height: tabBounds.y + tabBounds.height - toolbarBounds.y + 8 } });
  {
    await group('rewards');
    const rewards = page.locator('#config-group-rewards');
    const enable = rewards.getByRole('switch', { name: '闯关挂机收益', exact: true });
    const children = rewards.locator('#config-field-schedule-afk-children');
    const upgrade = children.getByRole('switch', { name: '自动升级挂机等级', exact: true });
    const hours = children.getByRole('spinbutton', { name: '领取间隔', exact: true });
    const expand = rewards.getByRole('button', { name: '闯关挂机收益，展开下级设置' });
    assert(await children.isHidden());
    await expand.click();
    assert.equal(await upgrade.isChecked(), false);
    assert.equal(await hours.inputValue(), '0');
    await upgrade.click(); await saved();
    assert.equal(await enable.isChecked(), false);
    await rewards.getByRole('button', { name: '闯关挂机收益，收起下级设置' }).click();
    assert(await children.isHidden());
    await expand.click();
    assert(await upgrade.isChecked());
    await hours.fill('6'); await saved();
    assert.equal(loadAutomationSettings('config-a').settings.afk.claimIntervalHours, 6);
    assert.equal(loadAutomationSettings('config-b').settings.afk.claimIntervalHours, 0);
    await enable.click(); await saved();
    await page.reload(); await openConfig(); await group('rewards'); await expand.click();
    assert(await enable.isChecked());
    assert.equal(await hours.inputValue(), '6');
    await enable.click(); await saved();
    assert(await upgrade.isChecked());
    assert.equal(loadAutomationSettings('config-b').settings.schedule.afkUpgrade, false);
    await upgrade.click(); await saved();
    console.log('通过：展开闯关挂机收益可独立开关升级，领取间隔与升级开关均按账号保存');
  }
  {
    await group('pet');
    const pet = page.locator('#config-group-pet');
    const enable = pet.getByRole('switch', { name: '自动升级', exact: true });
    await enable.click(); await saved();
    const expand = pet.getByRole('button', { name: '自动升级，展开下级设置' });
    await expand.click();
    const picker = pet.locator('#config-field-pet-levelUids');
    const previous = { client: bossSession.client, paused: bossSession.paused };
    const roster = [1, 2, 3].map(low => ({ uid: { high: 2097152, low }, petId: '海豚', level: 29, star: 2 }));
    const reads = [];
    try {
      bossSession.paused = false;
      bossSession.client = { connected: true, async request(name) {
        reads.push(name);
        if (name === 'AllPetRequest') return { pets: roster };
        assert.equal(name, 'OnWaterRequest');
        return { building: roster.slice(0, 2).map((p, i) => ({ buildingId: (i + 1) + '号值守建筑', level: 1, petServe: { petUid: p.uid } })) };
      } };
      await picker.locator('summary').click();
      await picker.getByRole('checkbox', { name: /海豚.*1号值守建筑/ }).check();
      await picker.getByRole('checkbox', { name: /海豚.*2号值守建筑/ }).check();
      assert.equal(await picker.getByRole('checkbox').count(), 2);
      await picker.locator('summary').click();
    } finally { Object.assign(bossSession, previous); }
    assert.deepEqual(reads, ['AllPetRequest', 'OnWaterRequest']);
    assert.equal(await pet.getByRole('radiogroup', { name: '目标阶段' }).count(), 0);
    await saved();
    const storedPet = loadAutomationSettings('config-a').settings.pet;
    assert.deepEqual(storedPet.levelUids, ['9007199254740993', '9007199254740994']);
    assert(!Object.hasOwn(storedPet, 'targetLevel'));
    await page.reload(); await openConfig(); await group('pet'); await expand.click();
    assert.match(await picker.locator('summary').innerText(), /9007199254740993/);
    await enable.click(); await saved();
    assert.deepEqual(loadAutomationSettings('config-a').settings.pet.levelUids, storedPet.levelUids);
  }
  {
    await group('progression');
    const card = page.getByRole('region', { name: '主线推关进度' });
    await card.waitFor();
    assert(await card.evaluate(node => node.parentElement.firstElementChild === node));
    await card.getByText('关卡待同步').waitFor();
    const stages = card.getByRole('list', { name: '主线关卡' });
    const current = card.locator('[aria-current=step]');
    const trials = page.getByRole('region', { name: '试炼进度' });
    const trialRow = name => trials.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
    const hero = trialRow('英雄经验副本'), stones = trialRow('强化石副本'), beasts = trialRow('海兽经验副本');
    const reads = [];
    const trialClient = new GameClient({ protocol: {} });
    trialClient.freeRecruitTimes = { hero: 0, antique: 0 };
    trialClient.request = async (name, { raidId }) => {
      assert.equal(name, 'TrialRaidInfoRequest');
      reads.push(raidId);
      return { raid: { raidId, passedStage: { 1: 1012, 2: 2015, 3: 0 }[raidId] } };
    };
    await hero.getByText('待同步').waitFor();
    try {
      bossSession.player.mainlineStage = 268;
      bossSession.loop.challengeRun = { mainline: { stage: 267, wins: 5, failures: 0, reason: '第 267 关已通关' } };
      await current.getByText('268', { exact: true }).waitFor();
      assert.deepEqual(await stages.getByRole('listitem').allTextContents(), ['265','266','267','268','269','270','271']);
      assert.equal(await stages.locator('[data-state=passed]').count(), 3);
      await stages.getByRole('listitem', { name: '第 269 关，下一关' }).waitFor();
      await card.getByText('最近同步').waitFor();
      await card.screenshot({ path: path.join(output, 'mainline-progress.png') });
      bossSession.player.level = 24;
      bossSession.paused = false;
      bossSession.client = trialClient;
      trialClient.socket = { readyState: 1 };
      await hero.getByText('第 13 关').waitFor({ timeout: 15000 });
      assert.deepEqual(await hero.locator('td').allTextContents(), ['第 12 关', '第 13 关']);
      await stones.getByText('全部通关').waitFor();
      await beasts.getByText('角色 25 级开放').waitFor();
      assert.deepEqual(reads, [1, 2], '只补读开放副本');
      const progressCard = card.locator('..');
      const [mainWide, trialsWide, desktopCard] = await Promise.all([card, trials, progressCard].map(node => node.boundingBox()));
      assert(trialsWide.x >= mainWide.x + mainWide.width - 1 && Math.abs(trialsWide.y - mainWide.y) < 1, '宽屏试炼进度排在主线右侧');
      await progressCard.screenshot({ path: path.join(output, 'mainline-and-trials.png') });
      await page.setViewportSize({ width: 320, height: 800 });
      const [mainNarrow, trialsNarrow, mobileCard] = await Promise.all([card, trials, progressCard].map(node => node.boundingBox()));
      assert(trialsNarrow.y >= mainNarrow.y + mainNarrow.height && Math.abs(mainNarrow.x - trialsNarrow.x) < 1, '窄屏试炼进度排在主线下方');
      assert(desktopCard.height < mobileCard.height, '并排展示压缩整张卡片的高度');
      assert(await trials.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      assert(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      const boxes = await stages.locator('.mainline-stage-number').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
      assert(boxes.every((box, i) => box.y === boxes[0].y && (!i || box.x >= boxes[i - 1].right)));
      await card.screenshot({ path: path.join(output, 'mainline-progress-mobile.png') });
      await card.locator('..').screenshot({ path: path.join(output, 'mainline-and-trials-mobile.png') });
      assert.deepEqual(reads, [1, 2], '轮询期间复用已确认的副本进度');
      bossSession.player.level = 25;
      await beasts.getByText('未首通').waitFor({ timeout: 15000 });
      assert.deepEqual(await beasts.locator('td').allTextContents(), ['未首通', '第 1 关']);
      assert.deepEqual(reads, [1, 2, 3]);
      const other = await (await fetch(base + '/api/loop?account=config-b&trials=1')).json();
      assert(other.trialProgress.every(raid => raid.passed === null), '切换账号不能读到其他账号的通关记录');
      bossSession.player.mainlineStage++;
      await current.getByText('269', { exact: true }).waitFor();
      assert.deepEqual(await stages.locator('.mainline-stage-number').allTextContents(), ['266','267','268','269','270','271','272']);
      bossSession.player.mainlineStage = 1;
      await current.getByText('1', { exact: true }).waitFor();
      assert.deepEqual(await stages.locator('.mainline-stage-number').allTextContents(), ['1','2','3','4']);
      const firstStage = await current.boundingBox();
      assert(Math.abs(firstStage.x - boxes[3].x) < 1, '第一关也保持居中');
      delete bossSession.player.mainlineStage;
      await card.getByText('关卡待同步').waitFor();
      assert.equal(await stages.count(), 0);
      await group('treasure');
      assert.equal(await card.isVisible(), false);
    } finally {
      trialClient.socket = null;
      bossSession.client = null;
      bossSession.paused = true;
      delete bossSession.player.level;
      delete bossSession.player.mainlineStage;
      delete bossSession.loop.challengeRun;
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
  {
    await group('pirate-hunt');
    const picker = page.locator('#config-field-pirateSweep-types');
    await picker.locator('summary').click();
    await picker.getByRole('checkbox', { name: '海盗精锐' }).check();
    await page.keyboard.press('Escape');
    const eliteTimes = page.locator('#config-field-pirateSweep-times2');
    await eliteTimes.fill('2');
    await saved();
    assert.deepEqual(loadAutomationSettings('config-a').settings.pirateSweep, { types: ['1', '2'], times1: -1, times2: 2, times3: 1 });
    assert(!await page.locator('#config-field-pirateSweep-times3').isVisible());
  }
  {
    await page.getByRole('tab', { name: '日常', exact: true }).click();
    const tabs = await page.locator('#config-panel-daily [data-config-group]').allTextContents();
    assert.deepEqual(tabs.slice(tabs.indexOf('日常行动'), tabs.indexOf('日常行动') + 3), ['日常行动', '折扣商店', '广告奖励']);
    await page.getByRole('tab', { name: '折扣商店', exact: true }).click();
    const panel = page.locator('#config-group-discount-shop');
    const shopSwitch = panel.getByRole('switch', { name: '折扣商店总开关', exact: true });
    await shopSwitch.waitFor();
    assert.equal(await panel.getByText(/实际钻石余额足够就会购买/).isVisible(), false);
    await panel.getByRole('button', { name: '折扣商店总开关说明', exact: true }).click();
    const help = page.locator('#ui-help-body');
    await help.waitFor();
    assert.match(await help.textContent(), /实际钻石余额足够就会购买.*普通购买和兜底购买均不受全局钻石开关、每日预算和钻石保留量限制.*不占用全局预算.*挂机只使用免费刷新/);
    await page.keyboard.press('Escape');
    assert.equal(await help.isVisible(), false);
    assert.equal(await shopSwitch.getAttribute('aria-checked'), 'false');
    await group('resources');
    assert.equal(await page.getByRole('switch', { name: '自动钻石消耗总开关', exact: true }).getAttribute('aria-checked'), 'false');
    await page.getByRole('button', { name: '自动钻石消耗总开关说明', exact: true }).click();
    assert.match(await help.textContent(), /折扣商店.*独立控制.*每日钻石使用量和钻石保留阈值均不适用于折扣商店/);
    await page.keyboard.press('Escape');
    await group('discount-shop');
    const add = panel.getByRole('button', { name: '增加', exact: true });
    const grid = panel.getByRole('table', { name: '购买清单' });
    assert.equal(await grid.isVisible(), false);
    assert.equal(await panel.locator('.config-discount-count').innerText(), '0 项');
    assert(await add.evaluate(button => button.parentElement.contains(document.getElementById('config-field-discountShop-rules-label'))));
    assert.equal(await panel.getByLabel('最高折数', { exact: true }).isVisible(), false);
    assert.equal(await panel.getByRole('button', { name: '读取当前货架' }).count(), 0);
    const picker = panel.getByRole('listbox', { name: '可选折扣商品' }), search = panel.getByRole('combobox', { name: '搜索折扣商品' });
    const assertEditorAlignment = async () => {
      const controls = panel.locator('.config-discount-picker:visible, .config-discount-item-field > strong:visible, .config-discount-limit input, .config-discount-form button');
      const tops = await controls.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      assert.equal(tops.length, 5);
      assert(Math.max(...tops) - Math.min(...tops) <= 1, '物品、上限输入框和操作按钮应在同一行：' + tops.join(', '));
    };
    await add.click(); await search.waitFor();
    assert(await search.evaluate(node => node === document.activeElement));
    await assertEditorAlignment();
    const known = picker.getByRole('group', { name: '已知折扣商品' });
    for (const id of ['原料自选包', '玉米', '耐火砖']) assert.equal(await known.getByRole('option', { name: id }).count(), 1);
    await search.fill('不存在的折扣商品');
    await panel.getByText('没有匹配的可选物品，试试其他名称或 ID。').waitFor();
    await search.fill('材料礼包');
    assert.deepEqual(await picker.getByRole('option').allTextContents(), ['材料礼包（礼包A）', '材料礼包（礼包B）']);
    await search.press('ArrowDown'); await search.press('Enter');
    await panel.locator('summary').filter({ hasText: '材料礼包（礼包B）' }).waitFor();
    assert.equal(await picker.isVisible(), false);
    await assertEditorAlignment();
    await panel.getByLabel('最高折数').fill('4.5');
    await panel.getByLabel('整份最高钻石价').fill('25');
    const save = panel.getByRole('button', { name: '保存', exact: true });
    await save.click(); await saved();
    const row = grid.getByRole('row').filter({ hasText: '礼包B' });
    assert.deepEqual(await grid.getByRole('columnheader').allTextContents(), ['物品', '最高折数', '整份最高钻石价', '操作']);
    assert.deepEqual((await row.getByRole('cell').allInnerTexts()).slice(0, 3), ['材料礼包（礼包B）', '4.5 折', '25 钻石']);
    assert.equal(await panel.getByLabel('每日刷新上限', { exact: true }).count(), 0);
    assert.equal(await panel.getByLabel('单次刷新钻石上限', { exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '确认次数' }).count(), 0);
    await shopSwitch.click(); await saved();
    const fallbackSwitch = panel.getByRole('switch', { name: '兜底购买', exact: true });
    assert.equal(await fallbackSwitch.getAttribute('aria-checked'), 'false');
    await panel.getByRole('button', { name: '兜底购买说明' }).click();
    assert.match(await help.textContent(), /最后一次免费刷新.*折后整份钻石价最低.*买 1 份/);
    await page.keyboard.press('Escape');
    await fallbackSwitch.click(); await saved();
    const stored = () => loadAutomationSettings('config-a').settings.discountShop;
    assert.deepEqual(stored(), { rules: [{ id: '礼包B', maxPercent: 45, maxDiamonds: 25 }], fallbackCheapest: true });
    for (const [item, field, limit] of [['玉米', '整份最高钻石价', '20'], ['原料自选包', '最高折数', '6']]) {
      await add.click(); await search.fill(item); await picker.getByRole('option', { name: item, exact: true }).click();
      await panel.getByLabel(field, { exact: true }).fill(limit); await save.click(); await saved();
    }
    await panel.screenshot({ path: path.join(output, 'discount-shop-desktop.png') });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await phone.goto(base); await phone.locator('#tabs [data-tab=settings]').tap();
      await phone.getByRole('tab', { name: '日常', exact: true }).tap();
      await phone.getByRole('tab', { name: '折扣商店', exact: true }).tap();
      const shop = phone.locator('#config-group-discount-shop');
      assert.deepEqual(await shop.locator('.config-discount-condition:visible').allTextContents(),
        ['4.5 折以内 或 整份 ≤ 25 钻石', '整份 ≤ 20 钻石', '6 折以内']);
      await phone.evaluate(() => window.scrollTo(0, 0));
      await phone.screenshot({ path: path.join(output, 'discount-shop-mobile.png') });
      await phone.setViewportSize({ width: 320, height: 760 });
      const widths = await shop.evaluate(node => ({
        page:document.documentElement.scrollWidth, viewport:innerWidth,
        list:node.querySelector('.config-discount-table').scrollWidth, available:node.querySelector('.config-discount-table').clientWidth,
      }));
      assert(widths.page <= widths.viewport && widths.list <= widths.available + 1, JSON.stringify(widths));
      const sizes = await phone.locator('.hosting-controls > button, .config-actions > button:visible, #config-group-discount-shop .config-small-button:visible').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return [node.offsetHeight, style.fontSize, style.paddingInline, style.borderRadius];
      }));
      assert.equal(sizes[0][0], 32);
      for (const size of sizes) assert.deepEqual(size, sizes[0]);
    } finally { await phone.close(); }
    for (const item of ['玉米', '原料自选包']) {
      await grid.getByRole('row').filter({ hasText: item }).getByRole('button', { name: '移除' }).click(); await saved();
    }
    await add.click(); await search.fill('礼包');
    assert.deepEqual(await picker.getByRole('option').allTextContents(), ['材料礼包（礼包A）']);
    await search.press('Escape'); assert.equal(await picker.isVisible(), false);
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 360, height: 800 });
    await add.click(); await search.waitFor();
    assert.equal(await picker.getByRole('option', { name: '高温合金' }).count(), 1);
    assert(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), '折扣商店在手机宽度可完整显示');
    assert(await picker.evaluate(node => node.scrollHeight > node.clientHeight), '可单独滚动候选列表');
    assert(await picker.evaluate(node => node.getBoundingClientRect().bottom <= document.getElementById('tabs').getBoundingClientRect().top), '选择器展开后位于手机底栏上方');
    await search.fill('高温'); await picker.getByRole('option', { name: '高温合金' }).click();
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(stored().rules.length, 1);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.getByRole('button', { name: '编辑', exact: true }).click();
    await assertEditorAlignment();
    await panel.getByLabel('最高折数').fill('');
    await save.click(); await saved();
    assert.equal(stored().rules[0].maxPercent, null);
    assert.equal(await row.getByRole('cell').nth(1).textContent(), '—');
    await panel.getByRole('button', { name: '移除', exact: true }).click(); await saved();
    assert.deepEqual(stored().rules, []);
    await group('building');
    console.log('通过：折扣商店购买清单、搜索增改删、独立购买和免费刷新说明');
  }
  {
    const history = page.locator('#config-history-dialog');
    const action = name => history.getByRole('button', { name, exact: true });
    const record = name => history.locator('.history-record').filter({ hasText: name });
    const preview = async name => {
      await page.locator('#config-history-open').click();
      await record(name).getByRole('button', { name: '查看与恢复' }).click();
    };
    await page.locator('#config-history-save').click();
    await history.getByLabel('配置名称').fill('日常方案');
    await action('保存').click();
    await history.getByText('快照已保存', { exact: true }).waitFor();
    await action('关闭').click();
    await group('factory');
    const stock = page.locator('#config-field-factory-keepStock');
    await stock.fill('332'); await saved();
    await stock.fill('');
    await preview('日常方案');
    assert.match(await history.locator('.history-differences').innerText(), /备货水位[\s\S]*当前：未设置[\s\S]*恢复后：321/);
    await action('继续恢复').click();
    await history.getByLabel('草稿名称').fill('待补水位');
    await action('保存草稿并恢复').click(); await saved();
    assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 321);

    await preview('待补水位');
    await action('取回并编辑').click(); await action('直接取回').click();
    await page.locator('#config-state').filter({ hasText: '请修正配置' }).waitFor();
    assert.equal(await stock.inputValue(), '');
    assert.equal(await stock.getAttribute('aria-invalid'), 'true');
    assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 321);
    await stock.fill('333'); await saved();
    assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 333);

    const list = async account => (await (await fetch(base + '/api/settings/history?account=' + account)).json()).entries;
    const entries = await list('config-a');
    assert.deepEqual(entries.map(row => [row.name, row.draft]), [['待补水位', true], ['日常方案', false]]);
    assert.deepEqual(await list('config-b'), []);
    assert.equal((await fetch(base + '/api/settings/history?account=config-b&id=' + entries[0].id)).ok, false);
    await preview('日常方案');
    await action('继续恢复').click();
    const newer = loadAutomationSettings('config-a');
    newer.settings.factory.keepStock = 334;
    saveAutomationSettings('config-a', newer.settings, { revision: newer.revision });
    await action('直接恢复').click();
    await page.locator('#config-state').filter({ hasText: '配置有冲突' }).waitFor();
    assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 334);
    await page.reload(); await openConfig();
    console.log('通过：命名快照、差异、跨账号隔离、草稿取回修正和恢复版本冲突');

    const beforeDelete = loadAutomationSettings('config-a');
    const wrongAccount = await fetch(base + '/api/settings/history/delete?account=config-b', {
      method: 'POST', body: JSON.stringify({ confirm: true, id: entries[0].id }),
    });
    assert.equal(wrongAccount.ok, false);
    await page.locator('#config-history-open').click();
    const draftDelete = record('待补水位').getByRole('button', { name: '删除' });
    page.once('dialog', dialog => dialog.dismiss());
    await draftDelete.click();
    assert.deepEqual(await list('config-a'), entries);
    page.once('dialog', dialog => dialog.accept());
    await draftDelete.click();
    await record('待补水位').waitFor({ state: 'detached' });
    assert.deepEqual(await list('config-a'), [entries[1]]);
    assert.equal(await history.getByRole('status').isVisible(), false);
    assert((await history.boundingBox()).height < 200, '一条记录的弹窗应紧凑');
    await page.setViewportSize({ width: 320, height: 800 });
    assert(await history.evaluate(node => node.scrollWidth <= node.clientWidth));
    page.once('dialog', dialog => dialog.accept());
    await record('日常方案').getByRole('button', { name: '删除' }).click();
    await history.getByText('暂无历史配置。').waitFor();
    assert.deepEqual(await list('config-a'), []);
    assert.deepEqual(loadAutomationSettings('config-a'), beforeDelete);
    await action('关闭').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log('通过：取消删除、逐条删除草稿和快照、空列表及窄屏布局');
  }
  assert.equal(await page.locator('#tabs [data-tab=idle], #tab-idle').count(), 0);
  assert.equal(await page.locator('#tabs [data-tab=lineups]').count(), 1);
  assert.equal(await page.getByText('前往挂机启停', { exact: true }).count(), 0);
  for (const control of settingsUiRules().moduleControls) {
    const selector = '[data-config-key="' + control.key + '"]';
    assert.equal(await page.locator(selector).count(), 1, control.key + ' 唯一');
    assert.equal(await page.locator('#config-group-' + control.configTarget + ' ' + selector).count(), 1, control.key + ' 配置归属');
  }
  assert.equal(await page.locator('[data-config-key="loop.heroes"]').count(), 0);
  for (const key of ['guildAidCollect', 'guildAidHelp', 'petCollect', 'petBreed', 'museumCollect', 'museumExplore', 'museumRevenue', 'museumAchievements', 'radarAuto', 'radarRepair', 'worldBossDamage']) {
    assert.equal(await page.locator('[data-config-key="schedule.' + key + '"]').count(), 0, '退役开关不再显示：' + key);
  }
  assert.equal(await page.locator('#config-root').getByText(/沿用原规则|旧规则/).count(), 0, '实际配置页面没有兼容规则文案');
  for (const key of ['alliance.mutual', 'alliance.autoHelp', 'alliance.autoAsk']) {
    assert.equal(await page.locator('#config-group-alliance [data-config-key="' + key + '"]').count(), 1, '互助只保留统一入口');
  }
  assert.equal(await page.locator('#config-root').getByRole('button', { name: /重新载入/ }).count(), 0);
  assert.equal(await page.locator('#config-root').getByText(/上次保存/).count(), 0);
  console.log('通过：模块开关各自归位，旧导航与跨页跳转移除');

  await group('guildFort');
  const fortRoute = '**/api/settings/guild-fort-materials?account=config-a';
  let fortRequests = 0;
  await page.route(fortRoute, route => {
    fortRequests++;
    return route.fulfill({ json: { itemIds: [] } });
  });
  const fortPickers = [
    ['materials', '任意可捐物料', '木板'],
    ['blockedMaterials', '未排除物料', '高温合金'],
  ];
  for (const [key, empty, material] of fortPickers) {
    const picker = page.locator('#config-field-guildFort-' + key);
    assert.equal(await picker.locator('summary').textContent(), empty);
    await picker.locator('summary').click();
    await picker.getByRole('checkbox', { name: '耐火砖' }).waitFor();
    assert.deepEqual(await picker.locator('.config-option').allTextContents(), items.map(item => item.show_name ?? item.id));
    await picker.getByRole('searchbox').fill(material);
    assert.deepEqual(await picker.locator('.config-option').allTextContents(), [material]);
    await picker.getByRole('checkbox', { name: material }).check();
    await picker.locator('summary').click(); await saved();
  }
  await page.reload(); await openConfig(); await group('guildFort');
  for (const [key, , material] of fortPickers) {
    const picker = page.locator('#config-field-guildFort-' + key);
    assert.equal(await picker.locator('summary').textContent(), material);
    await picker.locator('summary').click();
    assert(await picker.getByRole('checkbox', { name: material }).isChecked());
    await picker.locator('summary').click();
  }
  assert.equal(fortRequests, 0);
  await page.unroute(fortRoute);
  console.log('通过：工事两份名单直接展示全部物料，支持搜索、独立保存和刷新回显');

  await group('radar');
  assert.equal(await page.locator('[data-config-key="radar.monthCardSweep"]').count(), 0);
  const radar = page.getByRole('switch', { name: '自动处理情报', exact: true });
  await radar.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.radar.enabled, true);
  await page.reload(); await openConfig(); await group('radar');
  assert(await radar.isChecked());
  console.log('通过：自动处理情报统一控制普通派遣和月卡扫荡');

  await group('resourceFields');
  const fieldConfig = page.locator('#config-group-resourceFields');
  const refillAfterLoss = fieldConfig.getByRole('switch', { name: '失地后自动补齐', exact: true });
  const ratioMode = fieldConfig.getByRole('radio', { name: '按比例' });
  const quotaMode = fieldConfig.getByRole('radio', { name: '按配额' });
  const fieldCount = (resource, mode) => fieldConfig.getByRole('spinbutton', { name: resource + mode, exact: true });
  assert(await ratioMode.isChecked());
  assert.equal(await refillAfterLoss.isChecked(), false);
  await refillAfterLoss.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.resourceFields.refillAfterLoss, true);
  assert.equal(loadAutomationSettings('config-a').settings.resourceFields.enabled, false);
  assert.equal(await fieldCount('汽油', '比例').inputValue(), '3');
  assert.equal(await fieldCount('种子', '比例').inputValue(), '1');
  assert.equal(await fieldCount('科技点', '比例').inputValue(), '6');
  assert.equal(await fieldCount('汽油', '配额').count(), 0);
  await fieldCount('汽油', '比例').fill('0'); await saved();
  await quotaMode.check(); await fieldCount('种子', '配额').fill('2'); await saved();
  assert.equal(await fieldCount('汽油', '比例').count(), 0);
  await page.reload(); await openConfig(); await group('resourceFields');
  assert(await quotaMode.isChecked());
  assert(await refillAfterLoss.isChecked());
  assert.equal(await fieldCount('种子', '配额').inputValue(), '2');
  await ratioMode.check(); await saved();
  assert.equal(await fieldCount('汽油', '比例').inputValue(), '0');
  await fieldConfig.screenshot({ path: path.join(museumOutput, 'resource-fields-ratio.png'), animations: 'disabled' });
  console.log('通过：资源田可保存零比例和独立配额，刷新保留分配模式、两套数值及失地补齐开关');

  await group('worldBoss');
  const bossReward = page.locator('#config-field-schedule-worldBossRewards');
  assert.equal(await page.locator('[data-config-key="schedule.worldBossRewards"]').count(), 1);
  assert.equal(await page.locator('#config-group-worldBoss [data-config-key="schedule.worldBossRewards"]').count(), 1);
  assert.equal(await page.locator('#config-group-worldBoss').getByText('每日首战自动派遣', { exact: true }).count(), 1);
  assert.equal(await page.locator('#config-field-worldBoss-enabled').getAttribute('aria-checked'), 'false');
  await bossReward.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.schedule.worldBossRewards, true);
  assert.equal(loadAutomationSettings('config-a').settings.worldBoss.enabled, false);
  await page.reload(); await openConfig(); await group('worldBoss');
  assert.equal(await bossReward.getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-rewards.png'), animations: 'disabled' });
  await bossReward.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.schedule.worldBossRewards, false);
  assert(!Object.hasOwn(loadAutomationSettings('config-a').settings.schedule, 'worldBossDamage'));
  console.log('通过：世界Boss只有一个领奖入口，自动保存及刷新保留选择，首战派遣保持独立');
  await group('arena');
  const challenge = page.locator('#config-field-arena-challengeHigher');
  const sweep = page.locator('#config-field-arena-sweepLower');
  const challengeDetails = page.locator('button.config-disclosure[aria-controls="config-field-arena-challengeHigher-children"]');
  const sweepDetails = page.locator('button.config-disclosure[aria-controls="config-field-arena-sweepLower-children"]');
  const sweepLimit = page.locator('#config-field-arena-sweepLimit');
  const arenaLimit = page.locator('#config-field-arena-challengeLimit');
  const arenaRatio = page.locator('#config-field-arena-maxPowerRatio');
  assert.equal(await sweepDetails.getAttribute('aria-expanded'), 'false');
  assert.equal(await challengeDetails.getAttribute('aria-expanded'), 'false');
  await sweepDetails.click();
  assert.equal(await arenaLimit.isVisible(), false);
  await sweepLimit.fill('4'); await saved();
  await challengeDetails.click();
  await arenaLimit.fill('2'); await saved();
  await arenaRatio.fill('70'); await saved();
  await sweepDetails.click();
  assert.equal(await sweepLimit.isVisible(), false);
  assert.equal(await arenaRatio.isVisible(), true);
  await challengeDetails.click();
  assert.equal(await arenaRatio.isVisible(), false);
  assert.equal(await challenge.getAttribute('aria-checked'), 'false');
  assert.equal(await sweep.getAttribute('aria-checked'), 'false');
  await group('league');
  const leagueLimit = page.locator('#config-field-league-dailyBattleLimit');
  await leagueLimit.fill('0'); await saved();
  await page.locator('#config-field-league-claimTask').click(); await saved();
  const leagueRatio = page.locator('#config-field-league-maxPowerRatio');
  await leagueRatio.fill('115'); await saved();
  await page.locator('#config-field-schedule-leagueChallenge').click(); await saved();
  await page.reload(); await openConfig(); await group('league');
  assert.equal(await leagueLimit.inputValue(), '0');
  assert.equal(await page.locator('#config-field-league-claimTask').getAttribute('aria-checked'), 'true');
  assert.equal(await leagueRatio.inputValue(), '115');
  assert.equal(await page.locator('#config-field-schedule-leagueChallenge').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#config-field-schedule-leagueCollect').getAttribute('aria-checked'), 'false');
  await group('arena');
  await sweepDetails.click();
  await challengeDetails.click();
  assert.equal(await challenge.getAttribute('aria-checked'), 'false');
  assert.equal(await sweep.getAttribute('aria-checked'), 'false');
  assert.equal(await sweepLimit.inputValue(), '4');
  assert.equal(await arenaLimit.inputValue(), '2');
  assert.equal(await arenaRatio.inputValue(), '70');
  assert.equal(await page.locator('[data-config-key="schedule.arena"]').count(), 1);
  console.log('通过：竞技场挑战与扫荡可独立展开、收起，关闭时可编辑并在刷新后保留配置');

  await group('worldBoss');
  const bossFleets = page.locator('#config-field-worldBoss-fleetIds');
  const bossLineups = page.locator('#config-field-worldBoss-fleetPresets');
  const bossDisclosure = page.getByRole('button', { name: /^首战参与舰队，(?:展开|收起)下级设置$/ });
  const fleetLineup = id => bossLineups.locator('[data-lineup-binding="fleet:' + id + '远征船"]');
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await bossLineups.isVisible(), false, '逐队阵容设置默认收起');
  await bossDisclosure.click();
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(await bossLineups.getByText('请先勾选参与舰队以逐队指定阵容。', { exact: true }).isVisible(), true);
  await bossFleets.locator('summary').click();
  await bossFleets.getByRole('button', { name: '全选首战参与舰队', exact: true }).click();
  await bossFleets.locator('summary').click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetIds, ['1远征船', '2远征船', '3远征船']);
  assert.equal(await bossLineups.locator('select:visible').count(), 3);
  assert.equal(await page.getByText('各舰队出战阵容', { exact: true }).isVisible(), false);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const rowsFit = await bossLineups.locator('.config-fleet-lineup:visible').evaluateAll(rows => rows.every(row => {
      const [label, select, view] = [...row.children].map(node => node.getBoundingClientRect());
      const center = rect => rect.top + rect.height / 2;
      return label.left >= 0 && label.right <= select.left && select.right <= view.left && view.right <= innerWidth
        && Math.abs(center(label) - center(select)) <= 1 && Math.abs(center(select) - center(view)) <= 1;
    }));
    assert(rowsFit, width + 'px 每支舰队的名称、阵容和查看按钮均在同一行');
  }
  await fleetLineup(1).selectOption('boss-first');
  await fleetLineup(2).selectOption('boss-second'); await saved();
  assert.equal(await fleetLineup(3).inputValue(), '', '未指定的舰队沿用当前阵容');
  const expectedFleetPresets = [{ buildingId: '1远征船', presetId: 'boss-first' }, { buildingId: '2远征船', presetId: 'boss-second' }];
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetPresets, expectedFleetPresets);
  const fleetView = id => bossLineups.getByRole('button', { name: '查看远征舰队 ' + id + ' 队阵容' });
  const viewer = page.getByRole('dialog');
  const closeViewer = () => viewer.getByRole('button', { name: '关闭阵容查看' }).click();
  const previousClient = bossSession.client, previousPause = bossSession.paused;
  const water = [{ buildingId: '1远征船', level: 1 }, { buildingId: '3远征船', level: 1, fleet: {
    formation: { presetId: 7, heroPositions: [{ heroId: '瑞文', pos: { x: 2, y: 5 } }] },
  } }];
  let waterReads = 0;
  try {
    bossSession.paused = false;
    bossSession.client = { connected: true, async request(name) {
      assert.equal(name, 'OnWaterRequest'); waterReads++;
      return { building: water };
    } };
    await fleetView(3).click();
    await viewer.getByRole('heading', { name: '远征舰队 3 队 · 当前阵容' }).waitFor();
    await viewer.getByRole('img', { name: '站位 2，5，骑士瑞文' }).waitFor();
    assert.equal(await viewer.getByText('阵型 7', { exact: true }).isVisible(), true);
    await closeViewer();
    water[1].fleet = {};
    await fleetView(3).click();
    await viewer.getByText('这支舰队尚未编入英雄。').waitFor();
    await closeViewer();
    await fleetView(2).click();
    await viewer.getByRole('heading', { name: '世界Boss二队' }).waitFor();
    await viewer.getByRole('img', { name: '站位 4，4，波奇' }).waitFor();
    await closeViewer();
    assert.equal(waterReads, 2);
  } finally {
    bossSession.client = previousClient; bossSession.paused = previousPause;
  }
  const beforeCollapse = loadAutomationSettings('config-a');
  await bossDisclosure.click();
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(await bossLineups.isVisible(), false);
  assert.deepEqual(loadAutomationSettings('config-a'), beforeCollapse, '收起仅改变显示，不保存或清空舰队与阵容');
  await bossDisclosure.click();
  assert.equal(await fleetLineup(1).inputValue(), 'boss-first');
  assert.equal(await fleetLineup(2).inputValue(), 'boss-second');
  await bossFleets.locator('summary').click();
  await bossFleets.getByRole('checkbox', { name: '远征舰队 1 队', exact: true }).uncheck(); await saved();
  assert.equal(await fleetLineup(1).isVisible(), false);
  assert.equal(await fleetLineup(2).inputValue(), 'boss-second');
  await bossFleets.getByRole('checkbox', { name: '远征舰队 1 队', exact: true }).check(); await saved();
  assert.equal(await fleetLineup(1).inputValue(), 'boss-first', '重新勾选恢复此前阵容选择');
  await bossFleets.getByRole('button', { name: '清空选择', exact: true }).click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetIds, []);
  assert.deepEqual(loadAutomationSettings('config-a').settings.worldBoss.fleetPresets, expectedFleetPresets);
  assert.match(await bossFleets.locator('summary').textContent(), /自动选一支空闲舰队/);
  assert.equal(await bossLineups.getByText('请先勾选参与舰队以逐队指定阵容。', { exact: true }).isVisible(), true);
  assert.equal(await bossLineups.locator('select:visible').count(), 0);
  await bossFleets.getByRole('button', { name: '全选首战参与舰队', exact: true }).click();
  await bossFleets.locator('summary').click(); await saved();
  await page.reload(); await openConfig(); await group('worldBoss');
  assert.equal(await bossDisclosure.getAttribute('aria-expanded'), 'false', '重新打开页面默认收起');
  assert.equal(await bossLineups.isVisible(), false);
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-collapsed.png'), animations: 'disabled' });
  await bossDisclosure.click();
  assert.equal(await fleetLineup(1).inputValue(), 'boss-first');
  assert.equal(await fleetLineup(2).inputValue(), 'boss-second');
  assert.equal(await fleetLineup(3).inputValue(), '');
  assert.equal(await page.locator('#config-field-worldBoss-enabled').getAttribute('aria-checked'), 'false');
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-fleets.png'), animations: 'disabled' });
  await page.screenshot({ path: path.join(museumOutput, 'world-boss-expanded.png'), animations: 'disabled' });
  console.log('通过：世界Boss阵容默认收起且可展开，收起保留选择，舰队全选、逐队选阵容及刷新保存正确');
  await group('building');

  await page.locator('[data-config-family=production]').click();
  const factory = page.locator('#config-field-factory-enabled');
  const strategy = page.locator('#config-field-factory-strategy');
  const expandProduction = page.getByRole('button', {name:'自动生产，展开下级设置'});
  assert(await strategy.isHidden()); await expandProduction.click();
  const refill = page.locator('#config-field-factory-refillRules');
  const refillSpeedUp = page.getByRole('switch',{name:'强制补库时使用加速器',exact:true});
  assert.equal(await refillSpeedUp.getAttribute('aria-checked'), 'false');
  await refillSpeedUp.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.factory.refillSpeedUp, true);
  assert.equal(loadAutomationSettings('config-b').settings.factory.refillSpeedUp, false);
  const addRefill = refill.getByRole('button', {name:'添加补库规则'});
  const factoryPicker = refill.getByLabel('选择补库工厂');
  await factoryPicker.selectOption('1海水厂');
  assert.equal(await refill.getByLabel('选择要添加的物品').inputValue(), '淡水');
  await addRefill.click(); await saved();
  const waterFactory = refill.getByRole('group', {name:'海水提取厂',exact:true});
  const waterRule = waterFactory.getByRole('group', {name:'淡水',exact:true});
  assert.equal(await refill.getAttribute('data-slot'), 'card');
  assert.equal(await waterRule.getByLabel('补库物品').getAttribute('data-slot'), 'native-select');
  assert.equal(await waterRule.getByLabel('库存 ≤').getAttribute('data-slot'), 'input');
  assert.equal(await addRefill.getAttribute('data-slot'), 'button');
  assert.equal(await waterRule.getByLabel('库存 ≤').inputValue(), '0');
  assert.equal(await waterRule.getByPlaceholder('仓容上限').inputValue(), '');
  await factoryPicker.selectOption('2精铁厂'); await addRefill.click();
  const smelter = refill.getByRole('group', {name:'冶炼厂（2 号）',exact:true});
  await smelter.getByLabel('补库物品').selectOption('高温合金');
  const alloyRule = smelter.getByRole('group',{name:'高温合金',exact:true});
  await alloyRule.getByLabel('库存 ≤').fill('2'); await alloyRule.getByLabel('补至库存').fill('8'); await saved();
  assert.equal(await factoryPicker.inputValue(), '2精铁厂');
  const itemPicker = refill.getByLabel('选择要添加的物品');
  assert.deepEqual(await itemPicker.locator('option').evaluateAll(options => options.map(o => o.value)), ['耐火砖','精铁']);
  await factoryPicker.selectOption('1精铁厂'); await addRefill.click();
  await factoryPicker.selectOption('2精铁厂');
  await addRefill.click(); await saved();
  const brickRule = smelter.getByRole('group', {name:'耐火砖',exact:true});
  await brickRule.getByLabel('库存 ≤').fill('1'); await brickRule.getByLabel('补至库存').fill('4'); await saved();
  const sameFactory = () => loadAutomationSettings('config-a').settings.factory.refillRules.filter(r => r.buildingId === '2精铁厂');
  assert.deepEqual(sameFactory().map(r => [r.productId,r.trigger,r.target]), [['高温合金',2,8],['耐火砖',1,4]]);
  await addRefill.click(); await saved();
  assert.equal(await factoryPicker.locator('option[value="2精铁厂"]').count(), 0);
  const ironRule = smelter.getByRole('group',{name:'精铁',exact:true});
  const ironHandle = ironRule.getByRole('button',{name:'拖动排序：精铁'});
  assert.equal(await smelter.getByRole('heading',{name:'冶炼厂（2 号）',exact:true}).count(), 1);
  assert.equal(await smelter.locator('fieldset').count(), 3);
  assert(await smelter.getByText('同时缺货时，从上到下生产').isVisible());
  const productsByPosition = smelter.getByLabel('补库物品');
  assert.equal(await smelter.getByText(/^优先级 \d+$/).filter({visible:true}).count(), 0);
  assert.equal(await ironHandle.evaluate(handle => document.getElementById(handle.getAttribute('aria-describedby'))?.textContent), '优先级 3');
  const desktopControls = brickRule.locator('button, select, label span, input');
  for (const width of [880,1440]) {
    await page.setViewportSize({width,height:1000});
    assert(await desktopControls.evaluateAll(controls => {
      const boxes = controls.map(el => el.getBoundingClientRect());
      const center = boxes[0].top + boxes[0].height / 2;
      return boxes.every((box,i) => box.width > 0 && Math.abs(box.top + box.height / 2 - center) <= 1
        && (i === 0 || boxes[i - 1].right <= box.left));
    }), width + 'px 补库规则的物品、库存和操作从左到右排在同一行');
    assert((await brickRule.getByLabel('补至库存').boundingBox()).width >= 96, width + 'px 为仓容上限占位文字保留空间');
  }
  await ironHandle.dragTo(alloyRule,{targetPosition:{x:25,y:12}});
  await saved();
  assert.deepEqual(sameFactory().map(r => r.productId), ['精铁','高温合金','耐火砖']);
  assert.deepEqual(await productsByPosition.evaluateAll(inputs => inputs.map(input => input.value)), ['精铁','高温合金','耐火砖']);
  assert(await ironHandle.evaluate(handle => document.activeElement === handle));
  const beforeOutside = loadAutomationSettings('config-a').revision;
  await brickRule.getByRole('button',{name:'拖动排序：耐火砖'}).dragTo(waterRule,{targetPosition:{x:25,y:12}});
  assert.equal(await productsByPosition.first().inputValue(), '精铁');
  assert.equal(loadAutomationSettings('config-a').revision, beforeOutside);
  await page.reload(); await openConfig(); await page.locator('[data-config-family=production]').click(); await expandProduction.click();
  assert.equal(await refillSpeedUp.getAttribute('aria-checked'), 'true');
  await refillSpeedUp.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.factory.refillSpeedUp, false);
  assert.equal(await productsByPosition.first().inputValue(), '精铁');
  await page.setViewportSize({width:390,height:844});
  const touchSession = await page.context().newCDPSession(page);
  try {
    await touchSession.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await ironHandle.evaluate(node => window.scrollBy(0, node.getBoundingClientRect().top - innerHeight / 3));
    const start = await ironHandle.boundingBox(), end = await alloyRule.boundingBox();
    const x = start.x + start.width / 2, y = start.y + start.height / 2, dropY = end.y + end.height * .8;
    for (const finish of ['touchCancel','touchEnd']) {
      await touchSession.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      await touchSession.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:dropY}]});
      assert(await ironRule.evaluate(row => row.dataset.dragging === 'true'));
      await touchSession.send('Input.dispatchTouchEvent',{type:finish,touchPoints:[]});
      if (finish === 'touchCancel') assert.equal(await productsByPosition.first().inputValue(), '精铁');
    }
    await saved(); assert.deepEqual(sameFactory().map(r => r.productId), ['高温合金','精铁','耐火砖']);
  } finally {
    await touchSession.send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await touchSession.detach();
  }
  await page.setViewportSize({width:1440,height:1000});
  await ironRule.getByRole('button',{name:'移除'}).click(); await saved();
  console.log('通过：补库规则支持鼠标跨多项拖放、触屏排序与取消，跨厂放手不改顺序');
  const up = brickRule.getByRole('button',{name:'上移'}), down = brickRule.getByRole('button',{name:'下移'});
  assert(await down.isDisabled()); assert(await waterRule.getByRole('button',{name:'上移'}).isHidden());
  await up.click(); await saved();
  assert(await up.isDisabled()); assert(await down.evaluate(button => document.activeElement === button));
  assert.deepEqual(loadAutomationSettings('config-a').settings.factory.refillRules.map(r => [r.buildingId,r.productId]),
    [['1海水厂','淡水'],['2精铁厂','耐火砖'],['1精铁厂','耐火砖'],['2精铁厂','高温合金']]);
  await page.reload(); await openConfig(); await page.locator('[data-config-family=production]').click(); await expandProduction.click();
  assert.equal(await productsByPosition.first().inputValue(), '耐火砖');
  assert.equal(await brickRule.getByLabel('补至库存').inputValue(), '4');
  await page.setViewportSize({width:320,height:844});
  assert(await brickRule.evaluate(row => [...row.querySelectorAll('button')].every(b => {
    const box = b.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth;
  })));
  await down.focus(); await page.keyboard.press('Enter'); await saved();
  assert.equal(await productsByPosition.nth(1).inputValue(), '耐火砖');
  assert.deepEqual(sameFactory().map(r => [r.productId,r.trigger,r.target]), [['高温合金',2,8],['耐火砖',1,4]]);
  await page.setViewportSize({width:1440,height:1000});
  await refill.getByRole('group',{name:'冶炼厂（1 号）',exact:true}).getByRole('button',{name:'移除'}).click();
  await brickRule.getByRole('button',{name:'移除'}).click(); await saved();
  assert.deepEqual(sameFactory().map(r => [r.productId,r.trigger,r.target]), [['高温合金',2,8]]);
  const refillRow = page.locator('.config-row[data-kind=refillRules]');
  await refillRow.screenshot({path:path.join(museumOutput,'refill-desktop.png'), animations:'disabled'});
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    await factoryPicker.selectOption('1精铁厂');
    assert(await refill.evaluate(node => [...node.querySelectorAll('input,select,button')].filter(el => !el.hidden).every(el => {
      const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.width > 0;
    })), width + 'px 行内编辑和添加控件均在视口内');
    assert(await waterRule.getByRole('spinbutton').evaluateAll(controls => {
      const [trigger,target] = controls.map(el => el.getBoundingClientRect());
      return Math.abs(trigger.top - target.top) <= 1 && trigger.right < target.left
        && trigger.width >= 76 && target.width >= 76;
    }), width + 'px 两个库存输入框并排显示且留有编辑空间');
    await factoryPicker.selectOption('');
    if (width === 390) {
      await refillRow.evaluate(node => node.scrollIntoView({block:'center',behavior:'instant'}));
      await refillRow.screenshot({path:path.join(museumOutput,'refill-mobile.png'), animations:'disabled'});
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await waterRule.getByRole('button',{name:'移除'}).click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.factory.refillRules, [{buildingId:'2精铁厂',productId:'高温合金',trigger:2,target:8}]);
  assert.deepEqual(loadAutomationSettings('config-b').settings.factory.refillRules, []);
  await page.getByRole('button', {name:'自动生产，收起下级设置'}).click();
  assert(await refill.isHidden()); assert(!(await page.locator('#config-field-factory-produce').isChecked()));
  await expandProduction.click();
  assert.equal(await strategy.inputValue(),'smart');
  await strategy.selectOption('nativeSimulation');
  const targets = page.locator('#config-field-factory-simulatedTargets');
  await targets.locator('summary').click();
  await targets.getByRole('checkbox',{name:'冶炼厂 · 耐火砖',exact:true}).check();
  await targets.getByRole('checkbox',{name:'冶炼厂 · 高温合金',exact:true}).check();
  assert.equal(await targets.getByRole('checkbox',{checked:true}).count(),1);
  await targets.locator('summary').click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.factory.simulatedTargets,['高温合金']);
  assert.equal(loadAutomationSettings('config-b').settings.factory.strategy,'smart');
  await strategy.selectOption('smart'); await saved();
  const exclusions = page.locator('#config-field-factory-blockedCollectionTypes');
  await exclusions.locator('summary').click();
  await exclusions.getByRole('checkbox', { name: '冶炼厂', exact: true }).check();
  assert.equal(await exclusions.getByRole('checkbox').count(), 2);
  await exclusions.locator('summary').click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.factory.blockedCollectionTypes, ['精铁厂']);
  await factory.click(); await page.locator('#config-field-factory-keepStock').fill('432'); await saved();
  assert.equal(await factory.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#config-field-factory-produce').getAttribute('aria-checked'), 'false');
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, false);
  assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 432);
  assert.equal(loadAutomationSettings('config-a').settings.factory.produce, false);
  await page.screenshot({ path: path.join(output, 'factory-desktop.png'), animations: 'disabled' });
  await page.reload(); await openConfig(); await page.locator('[data-config-family=production]').click();
  assert(await strategy.isHidden()); await expandProduction.click();
  assert.equal(await alloyRule.getByLabel('补至库存').inputValue(), '8');
  assert.equal(await factory.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), '432');
  assert.equal(await exclusions.locator('summary').textContent(), '冶炼厂');
  await factory.focus(); await page.keyboard.press('Space'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, true);
  assert.equal(loadAutomationSettings('config-a').settings.factory.produce, false);
  console.log('通过：模块暂停与参数一同保存，刷新、键盘启用不改细项');
  console.log('通过：补库规则按工厂行内编辑、自动保存和移除，320px 与 390px 宽度均可操作');

  await page.locator('#tabs [data-tab=resources]').click();
  await page.locator('[data-resource-tab=heroes]').click();
  assert.equal(await page.locator('#hero-plan, #hero-run, #hero-view, #hero-table, #formation-view').count(), 0);
  assert.equal(await page.locator('#tab-heroes').getByRole('link', { name: '养成设置' }).count(), 0);
  assert.equal(await page.locator('#tab-heroes').getByText('英雄装备', { exact: true }).count(), 0);
  assert.equal(await page.locator('#tab-heroes').getByText('英雄任命', { exact: true }).count(), 0);
  assert.equal(await page.locator('#tab-heroes [data-slot=card-title]').filter({ hasText: '装备制造' }).isVisible(), true);
  await page.locator('#tabs [data-tab=settings]').click();
  await page.locator('[data-config-tab=heroes]').click();
  await page.getByRole('tab', { name: '英雄任命', exact: true }).click();
  const appointmentPanel = page.getByRole('tabpanel', { name: '英雄任命', exact: true });
  const appointmentSwitch = appointmentPanel.getByRole('switch', { name: '自动委任' });
  const priorities = settings.appointments.priorities;
  const reordered = [priorities[1], priorities[0], ...priorities.slice(2)];
  assert.equal(await appointmentPanel.getByRole('listitem').count(), priorities.length);
  await appointmentSwitch.click();
  await appointmentPanel.getByRole('button', { name: '训练营产量提高上移' }).click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.appointments, { enabled: true, priorities: reordered });
  await page.reload(); await appointmentSwitch.waitFor(); await saved();
  assert.equal(await appointmentSwitch.getAttribute('aria-checked'), 'true');
  assert.match(await appointmentPanel.getByRole('listitem').first().textContent(), /训练营产量提高/);
  console.log('通过：英雄任命从杂项移入英雄标签，开关和优先级自动保存，刷新后保留');
  await page.getByRole('tab', { name: '英雄养成', exact: true }).click();
  await page.locator('#config-group-heroes').waitFor();
  const picker = page.locator('#config-field-heroes-heroIds');
  assert.match(await picker.locator('summary').textContent(), /重新选择/);
  await picker.locator('summary').click();
  assert.equal(await picker.getByRole('checkbox', { name: '训练木人' }).count(), 0);
  await picker.getByRole('searchbox').fill('骑士');
  await picker.getByRole('checkbox', { name: '骑士瑞文' }).check();
  await picker.locator('summary').click(); await saved();
  assert.deepEqual(loadAutomationSettings('config-a').settings.heroes.heroIds, ['瑞文']);
  assert.equal(loadAutomationSettings('config-a').settings.heroes.needsSelection, false);
  const advanced = page.locator('#config-group-heroes details').filter({ has: page.getByText('高级设置', { exact: true }) });
  assert.equal(await advanced.getAttribute('open'), null);
  await advanced.locator('summary').click();
  await advanced.getByLabel('目标等级', { exact: true }).fill('35');
  await advanced.locator('summary').click();
  const newActions = ['skillAdvance', 'exclusiveLevel', 'exclusiveStar', 'badge', 'showSkillReward'];
  for (const action of newActions) {
    const toggle = page.locator('#config-field-heroes-' + action);
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
  }
  await saved();
  await page.locator('[data-config-tab=equipment]').click();
  assert.equal(await page.locator('#config-subtab-equipment-growth, #config-group-equipment-growth').count(), 0);
  assert.equal(await page.locator('#config-subtab-equipment-legacy, #config-group-equipment-legacy').count(), 0);
  assert.equal(await page.locator('[data-config-key="schedule.equipmentCollect"], [data-config-key="schedule.equipmentCraft"]').count(), 0);
  assert.equal(await page.locator('#config-group-forge').isVisible(), true);
  assert.equal(await page.locator('#config-group-forge [data-config-key="forge.enabled"]').count(), 1);
  await page.reload(); await openConfig();
  await page.locator('[data-config-tab=equipment]').click();
  assert.equal(await page.locator('#config-subtab-equipment-growth, #config-group-equipment-growth').count(), 0);
  assert.equal(await page.locator('#config-group-forge').isVisible(), true);
  await page.locator('[data-config-tab=heroes]').click();
  await picker.waitFor();
  const growth = loadAutomationSettings('config-a').settings.heroes;
  assert(newActions.every(action => growth[action])); assert.equal(growth.targetLevel, 35);
  const badgeSwitch = page.locator('#config-group-heroes').getByRole('switch', { name: '徽章强化', exact: true });
  assert.equal(await badgeSwitch.getAttribute('aria-checked'), 'true');
  await badgeSwitch.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.heroes.badge, false);
  await picker.locator('summary').click(); await picker.getByRole('button', { name: '清空选择' }).click();
  await picker.locator('summary').click(); await saved();
  assert.equal(await picker.locator('summary').textContent(), '留空则暂停培养，不影响技能展示领奖');
  assert.deepEqual(loadAutomationSettings('config-a').settings.heroes.heroIds, []);
  console.log('通过：资源页移除手动养成和远征舰队编队并保留其余功能，挂机配置仍可按名称选英雄、保存独立动作及目标、清空名单');
  const hero = page.locator('#config-field-heroes-enabled');
  assert.equal(await hero.getAttribute('aria-checked'), 'false', '组合字段有一项关闭时显示暂停');
  await hero.click(); await saved();
  let stored = loadAutomationSettings('config-a').settings;
  assert.equal(stored.heroes.enabled, true); assert.equal(stored.loop.heroes, true);
  await hero.click(); await saved(); stored = loadAutomationSettings('config-a').settings;
  assert.equal(stored.heroes.enabled, false); assert.equal(stored.loop.heroes, false);
  assert.equal(stored.heroes.level, false); assert.equal(stored.heroes.star, true);
  await group('museum');
  assert.equal(await page.locator('#config-field-museum-runEnabled-note').isVisible(), false);
  const museum = page.locator('#config-group-museum');
  const autoExplore = museum.locator('#config-field-museum-enabled');
  for (const key of ['upgrade', 'revenue', 'achievements', 'display']) {
    const action = museum.locator('#config-field-museum-' + key);
    assert(await action.isVisible(), key + ' 在同组直接展示');
    assert.equal(await action.getAttribute('aria-checked'), 'false');
    await action.click(); await saved();
    assert.equal(loadAutomationSettings('config-a').settings.museum[key], true);
    assert.equal(loadAutomationSettings('config-a').settings.museum.enabled, false, key + ' 不依赖自动探宝');
    assert.equal(await page.locator('#config-field-museum-runEnabled-note').isVisible(), false);
    await action.click(); await saved();
  }
  assert.equal(await museum.locator('#config-field-museum-claim, #config-field-museum-explore').count(), 0, '领奖和派遣使用同一个开关');
  assert.equal(await museum.getByRole('switch', { name: '自动探宝', exact: true }).count(), 1);
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false, '探宝关闭时参数隐藏');
  await autoExplore.click(); await saved();
  assert.equal(await page.locator('#config-field-museum-runEnabled-note').isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.enabled, true);
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false, '开启探宝后参数默认折叠');
  await museum.getByRole('button', { name: '自动探宝，展开下级设置', exact: true }).click();
  for (const key of ['factorMode', 'factor', 'maxDispatches', 'maps', 'useGuide']) {
    assert.equal(await museum.locator('#config-field-museum-' + key).isVisible(), true, key + ' 参数直接随自动探宝展开');
  }
  await museum.locator('#config-field-museum-factor').selectOption('2');
  await museum.locator('#config-field-museum-maxDispatches').fill('1'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.museum.factor, 2, '常规倍率保存数字');
  await museum.locator('#config-field-museum-materialFactor').click();
  await museum.getByRole('button', { name: '根据材料调整倍数，展开下级设置', exact: true }).click();
  await museum.locator('#config-field-museum-matchedFactor').selectOption('3'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.museum.matchedFactor, 3, '命中倍率保存数字');
  await museum.locator('#config-field-museum-materialFactor').click(); await saved();
  await museum.locator('#config-field-museum-factorMode').selectOption('recommended'); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.museum.factorMode, 'recommended');
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false);
  assert.equal(await museum.locator('#config-field-museum-materialFactor').isVisible(), false);
  assert.equal(await museum.locator('#config-field-museum-fullRecommendedFactor').inputValue(), '3');
  assert.equal(await museum.locator('#config-field-museum-partialRecommendedFactor').inputValue(), '2');
  const fallback = museum.locator('#config-field-museum-noRecommendedFallback');
  const fallbackFactor = museum.locator('#config-field-museum-noRecommendedFactor');
  assert.equal(await fallback.getAttribute('aria-checked'), 'false');
  assert.equal(await fallbackFactor.isVisible(), false);
  await fallback.click(); await saved();
  await museum.getByRole('button', { name: '无推荐英雄时兜底，展开下级设置', exact: true }).click();
  assert.equal(await fallbackFactor.inputValue(), '1');
  await museum.screenshot({ path: path.join(museumOutput, 'museum-recommended-desktop.png'), animations: 'disabled' });
  await museum.locator('#config-field-museum-fullRecommendedFactor').selectOption('2');
  await museum.locator('#config-field-museum-partialRecommendedFactor').selectOption('1');
  await fallbackFactor.selectOption('3'); await saved();
  let factors = loadAutomationSettings('config-a').settings.museum;
  assert.equal(factors.fullRecommendedFactor, 2); assert.equal(factors.partialRecommendedFactor, 1); assert.equal(factors.noRecommendedFactor, 3);
  await fallback.click(); await saved();
  assert.equal(await fallbackFactor.isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.noRecommendedFactor, 3, '关闭兜底保留倍率');
  assert.equal(await museum.locator('#config-field-museum-maps').isVisible(), true);
  await museum.locator('#config-field-museum-factorMode').selectOption('materials'); await saved();
  assert.equal(await museum.locator('#config-field-museum-factor').inputValue(), '2');
  assert.equal(await museum.locator('#config-field-museum-fullRecommendedFactor').isVisible(), false);
  assert.equal(await fallback.isVisible(), false); assert.equal(await fallbackFactor.isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.fullRecommendedFactor, 2);
  assert.equal(loadAutomationSettings('config-a').settings.museum.partialRecommendedFactor, 1);
  await museum.screenshot({ path: path.join(museumOutput, 'museum-actions-desktop.png'), animations: 'disabled' });
  await autoExplore.click(); await saved();
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false);
  assert.equal(loadAutomationSettings('config-a').settings.museum.factor, 2, '暂停自动探宝保留倍数');
  assert.equal(loadAutomationSettings('config-a').settings.museum.enabled, false);
  await page.reload(); await openConfig(); await group('museum');
  assert.equal(await autoExplore.getAttribute('aria-checked'), 'false');
  assert.equal(await museum.locator('#config-field-museum-factor').isVisible(), false);
  await autoExplore.click(); await saved();
  await museum.getByRole('button', { name: '自动探宝，展开下级设置', exact: true }).click();
  assert.equal(await museum.locator('#config-field-museum-factor').inputValue(), '2');
  {
    const picker = museum.locator('#config-field-museum-targetFragments');
    await picker.locator('summary').click();
    await picker.getByRole('searchbox').fill('望远镜');
    await picker.getByRole('checkbox', { name: '古董望远镜碎片' }).check();
    await picker.locator('summary').click(); await saved();
    const previous = { player: bossSession.player, client: bossSession.client, paused: bossSession.paused };
    const reads = [];
    const mock = { MuseumInfo: { exploreStages: [{ stageId: 1, progress: 180 }], exhibitions: [] }, AllHero: { heroes: [] },
      AllAntique: { antiques: [] }, AllItem: { items: [] }, AllResource: { list: [] } };
    Object.assign(bossSession, { paused: false, player: { worldId: 1001001, playerId: 123, level: 40 },
      client: { connected: true, stop() {}, async request(name) {
        reads.push(name); const value = mock[name.replace(/Request$/, '')]; assert(value, name); return value;
      } } });
    try {
      await page.locator('#config-preview').click();
      const result = page.locator('#config-preview-result');
      await result.getByText('距 1 星还差 70 进度', { exact: true }).waitFor();
      await result.getByText('展柜升级与摆放建议', { exact: true }).click();
      await result.getByText(/当前摆放暂无/).waitFor();
      assert.deepEqual(reads, ['MuseumInfoRequest','AllHeroRequest','AllItemRequest','AllResourceRequest','AllAntiqueRequest']);
    } finally { Object.assign(bossSession, previous); }
  }
  const savedMuseum = loadAutomationSettings('config-a').settings.museum;
  assert.deepEqual(savedMuseum.targetFragments, ['望远镜碎片']);
  assert.equal(savedMuseum.enabled, true);
  assert(!Object.hasOwn(savedMuseum, 'claim') && !Object.hasOwn(savedMuseum, 'explore'), '保存后没有拆分动作字段');
  await museum.locator('#config-field-museum-factorMode').selectOption('recommended'); await saved();
  assert.equal(await museum.locator('#config-field-museum-fullRecommendedFactor').inputValue(), '2');
  assert.equal(await museum.locator('#config-field-museum-partialRecommendedFactor').inputValue(), '1');
  assert.equal(await fallback.getAttribute('aria-checked'), 'false');
  await fallback.click(); await saved();
  await museum.getByRole('button', { name: '无推荐英雄时兜底，展开下级设置', exact: true }).click();
  assert.equal(await fallbackFactor.inputValue(), '3');
  console.log('通过：兼容开关和拆分动作开关移除，自动探宝一个开关控制领奖及派遣，参数直接展开且暂停刷新保留');
  console.log('博物馆截图：' + path.join(museumOutput, 'museum-actions-desktop.png'));

  await page.locator('[data-config-tab=antique]').click();
  const antiques = page.locator('#config-group-antique');
  assert.equal(await antiques.locator('#config-field-antique-maxActions, #config-field-antique-checkEverySeconds').count(), 0);
  const antiqueMaster = antiques.getByRole('switch', { name: '藏品养成总开关', exact: true });
  assert.equal(await antiques.locator('fieldset, legend').count(), 0);
  assert.equal(await antiques.locator('.config-disclosure').count(), 4);
  for (const key of ['activate', 'star', 'master', 'suit']) {
    const toggle = antiques.locator('#config-field-antique-' + key);
    assert(await toggle.isVisible() && await toggle.isEnabled());
  }
  await antiqueMaster.click(); await saved();
  assert.equal(await antiques.locator('#config-field-antique-enabled-note').isVisible(), false);
  const masterLevel = antiques.locator('#config-field-antique-master');
  await masterLevel.click(); await saved();
  await antiqueMaster.click(); await saved();
  assert.equal(loadAutomationSettings('config-a').settings.antique.enabled, false);
  assert.equal(await masterLevel.getAttribute('aria-checked'), 'true');
  await masterLevel.click(); await saved();
  const savedAntique = loadAutomationSettings('config-a').settings.antique;
  assert.equal(savedAntique.master, false);
  assert.equal(savedAntique.maxActions, 7);
  assert.equal(savedAntique.checkEverySeconds, 90);
  console.log('通过：藏品总开关可单独保存，暂停时四个养成动作可见可编辑');

  assert.equal(await page.locator('[data-config-tab=runtime], #config-field-loop-rounds, #config-group-runtime').count(), 0);
  assert.deepEqual(await page.locator('[data-config-tab]').allTextContents(), ['基地', '世界', '英雄', '藏品', '装备', '日常']);
  await page.locator('#account-picker-trigger').click();
  await page.locator('#account-picker-list [role=option]').filter({ hasText: '配置验收账号2' }).click();
  await page.locator('#config-account-name').filter({ hasText: '配置验收账号2' }).waitFor(); await saved();
  assert.deepEqual(loadAutomationSettings('config-b'), otherBefore, '另一个账号不受编辑影响');
  await group('heroes'); await picker.locator('summary').click();
  const retiredTarget = picker.getByRole('checkbox', { name: '训练木人' });
  assert.equal(await retiredTarget.isChecked(), true);
  await retiredTarget.click(); await saved();
  assert.equal(await retiredTarget.count(), 0);
  assert.deepEqual(loadAutomationSettings('config-b').settings.heroes.heroIds, []);
  await group('factory');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), String(otherBefore.settings.factory.keepStock));
  await page.locator('#account-picker-trigger').click();
  await page.locator('#account-picker-list [role=option]').filter({ hasText: '配置验收账号1' }).click();
  await page.locator('#config-account-name').filter({ hasText: '配置验收账号1' }).waitFor(); await saved();
  await group('factory');
  assert.equal(await page.locator('#config-field-factory-keepStock').inputValue(), '432');
  console.log('通过：运行安排入口移除，切换账号隔离且保留已保存配置');

  // 外部页面改变版本后，组合开关的本地修改不能静默覆盖它。
  const external = loadAutomationSettings('config-a'); external.settings.factory.keepStock = 876;
  saveAutomationSettings('config-a', external.settings, { revision: external.revision });
  await factory.click();
  await page.locator('#config-state').filter({ hasText: '配置有冲突' }).waitFor();
  assert.match(await page.locator('#config-message').textContent(), /刷新页面.*未保存/);
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, true);
  assert.equal(loadAutomationSettings('config-a').settings.factory.keepStock, 876);
  assert.equal(await factory.getAttribute('aria-checked'), 'false', '本地草稿仍保留供处理');
  console.log('通过：合并后的模块开关仍受配置版本冲突保护');

  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });
  const mobile = await context.newPage(); mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(base); await mobile.locator('#account-picker-title').filter({ hasText: '配置验收账号1' }).waitFor();
  await mobile.locator('#tabs [data-tab=settings]').tap();
  await mobile.locator('#config-field-building-enabled').waitFor();
  await mobile.locator('[data-config-tab=world]').tap();
  await mobile.locator('#config-field-cityWar-enabled').waitFor();
  await mobile.screenshot({ path: path.join(output, 'world-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('[data-config-tab=base]').tap();
  await mobile.locator('[data-config-family=production]').tap();
  await mobile.locator('#config-field-factory-enabled').tap();
  await mobile.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  assert.equal(loadAutomationSettings('config-a').settings.factory.enabled, false);
  await mobile.screenshot({ path: path.join(output, 'factory-mobile.png'), animations: 'disabled' });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
  for (const width of [320, 360, 390, 430, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    await mobile.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('#log-top-count').textContent = '99999';
      document.querySelector('#loop-every').value = '86400';
    });
    const layout = await mobile.evaluate(() => {
      const controls = ['loop-every', 'loop-toggle', 'account-pause', 'logs-open'].map(id => {
        const node = document.getElementById(id), box = node.getBoundingClientRect();
        return { id, top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      const bar = document.querySelector('.config-tabs').getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[data-config-tab]')].map(node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, left: box.left, right: box.right, visible: box.left >= bar.left && box.right <= bar.right + 1 && box.top >= bar.top && box.bottom <= bar.bottom + 1, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      return { controls, tabs, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(layout.overflow, false, width + 'px 页面无横向溢出');
    assert(layout.controls.every(item => Math.abs(item.top - layout.controls[0].top) <= 1 && item.height === 32 && item.left >= 0 && item.right <= width && !item.overflow), JSON.stringify({ width, layout }));
    assert.equal(layout.tabs.length, 6);
    assert(layout.tabs.every(item => item.visible && !item.overflow && Math.abs(item.top - layout.tabs[0].top) <= 1), JSON.stringify({ width, layout }));
    assert.equal(await mobile.evaluate(() => [...document.querySelectorAll('.config-subtabs,.config-families')].filter(node => node.getClientRects().length).every(bar => {
      const bounds = bar.getBoundingClientRect();
      return [...bar.children].filter(node => node.getClientRects().length).every(node => {
        const box = node.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
      });
    })), true, width + 'px 触屏子页签的按钮完整位于底座内');
    for (const category of ['daily', 'equipment', 'antique', 'heroes', 'world', 'base']) {
      await mobile.locator('[data-config-tab=' + category + ']').tap();
      assert.equal(await mobile.locator('[data-config-tab=' + category + ']').getAttribute('aria-selected'), 'true');
    }
    await mobile.screenshot({ path: path.join(output, 'header-tabs-' + width + '.png'), animations: 'disabled' });
  }
  console.log('通过：320–768px 手机顶部四项操作同排，六个配置分类完整显示并可点击，大日志数和最大间隔不撑破布局');
  assert.deepEqual(errors, []); assert.equal(connections, 0);
  console.log('通过：360px手机导航、启停和参数无横向溢出，无脚本错误或游戏连接');
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
