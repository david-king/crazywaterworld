import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-season-preview-'));
process.env.CW_DATA_DIR = tmp;
process.env.CW_RESOURCE_DIR = path.join(tmp, 'resources');
process.env.CW_CONFIG_PACK = path.join(tmp, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { readSeasonRanking, seasonNumber } = await import('../src/season-preview.mjs');
const { createConsole } = await import('../src/server.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const accounts = ['a', 'b'].map(id => ({ id, label: id, login: {}, url: 'ws://fixture.invalid',
  automation: { enabled: false, autoStart: false } }));
saveStore({ accounts, activeId: 'a' });
const app = createConsole({ port: 0, protocol: {} });
const calls = [];
const large = { high: 2097152, low: 1, unsigned: false };
const rankRow = rank => ({ rank, playerId: rank, nickname: '玩家' + rank, score: large });
const asset = (id, num) => ({ type: 0, id, num });
const letters = [
  { emailId: large, subject: '第一封', got: false, attachment: { assets: { asset: [asset('功勋', large), asset('功勋', 2)] }, heroes: ['英雄甲', '英雄甲'] } },
  { emailId: 42, subject: '第二封', got: true, attachment: { assets: { asset: [asset('功勋', 7)] }, equips: ['装备甲'], antiques: ['藏品甲'] } },
];
const reports = [
  { uid: large, read: true, received: true, treasureLoot: { uid: 46, feats: 330 },
    rewards: { assetPackage: { asset: [asset('功勋', 330), asset('RUBY', 110)] } } },
  { uid: 43, read: true, received: false, treasureLoot: { uid: 49, feats: 77 },
    rewards: { assetPackage: { asset: [asset('功勋', 77)] }, heroes: [{heroId:'英雄甲'}], badge:[{badgeId:'徽章甲'}] } },
  { uid: 44, read: false, received: false, treasureLoot: { uid: 50, feats: 800 } },
  { uid: 45, received: false, rewards: { equips: ['装备甲'], supplies: [{supId:'补给甲'}],
    antiques: [{antiqueId:'藏品甲'}, {antiqueId:'藏品甲',frag:true}] } },
];
function fakeClient(owner) {
  return Object.assign(new EventEmitter().setMaxListeners(32), {
    connected: true, stop() { this.connected = false; }, snapshot() { return { state: 'READY' }; },
    async request(name, body) {
      calls.push({ owner, name, body });
      if (name === 'SeasonRankInfoRequest') return { midEndTime: 1795400000, endTime: 1796400000 };
      if (name === 'SeasonRankGuildRequest') return { guild: [
        { rank: 1, guildId: '9007199254740992', score: 500 },
        { rank: 2, guildId: large, score: 300 },
      ] };
      if (name === 'SeasonRankPlayerRequest') {
        const count = body.type === 0 ? 63 : 3;
        assert(body.type === 0 || body.type === 1);
        const start = (body.page - 1) * 13;
        return { maxPage: Math.ceil(count / 13), myRank: rankRow(body.type === 0 ? 51 : 94),
          player: Array.from({ length: Math.min(13, count - start) }, (_, i) => rankRow(start + i + 1)) };
      }
      if (name === 'EmailBoxRequest') return owner === 'b' ? { total: 0, email: [] }
        : { total: letters.length, email: [letters[body.pageNo]] };
      if (name === 'CampaignReportsRequest') return owner === 'b' ? { total: 0, reports: [] }
        : { total: reports.length, reports: [reports[body.pageNo]] };
      throw Error('意外游戏请求 ' + name);
    },
  });
}
let browser;
try {
  const base = await app.listen();
  for (const { id } of accounts) {
    const session = app.sessions.get(id);
    session.client = fakeClient(id);
    session.player = { playerId: 51, guildId: id === 'a' ? large : 0, worldId: id === 'a' ? '3004002696' : 2000111 };
  }
  const get = async endpoint => {
    const response = await fetch(base + endpoint);
    const value = await response.json();
    assert.equal(response.status, 200, value.error);
    return value;
  };
  const board = await get('/api/season/rank?account=a&kind=merit');
  assert.equal(board.season, 4);
  assert.deepEqual(board.rows.map(row => row.rank), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(board.rows[0].score, '9007199254740993');
  assert.equal(board.mine.rank, 51);
  assert.deepEqual(calls.filter(c => c.name === 'SeasonRankPlayerRequest').map(c => c.body.page), [1, 2, 3, 4]);
  const tech = await get('/api/season/rank?account=b&kind=tech');
  assert.equal(tech.season, 2);
  assert.equal(tech.rows.length, 3);
  assert.deepEqual(calls.at(-1), { owner: 'b', name: 'SeasonRankPlayerRequest', body: { type: 1, page: 1 } });
  const mail = await get('/api/season/mail?account=a');
  assert.equal(mail.scanned, 2);
  assert.equal(mail.reportsScanned, 4);
  assert.deepEqual(mail.items.map(row => row.id).sort(), ['功勋', '英雄甲', '装备甲', '藏品甲', 'RUBY','徽章甲','补给甲','藏品甲碎片兑换包'].sort());
  assert.equal(mail.items[0].pending, '9007199254741072');
  assert.equal(mail.items[0].claimed, '337');
  assert.deepEqual(mail.merit, { pending: '9007199254741072', claimed: '337' });
  assert.deepEqual((await get('/api/season/mail?account=b')).merit, {pending:'0', claimed:'0'});
  const guild = await get('/api/season/guild?account=a');
  assert.equal(guild.rank, 2);
  assert.equal(guild.score, '300');
  assert.equal((await get('/api/season/guild?account=b')).state, 'notJoined');
  assert.deepEqual(mail.items[0].sources.map(s => [s.kind, s.id, s.claimed, s.count]), [
    ['system', '9007199254740993', false, '9007199254740995'],
    ['system', '42', true, '7'],
    ['report', '9007199254740993', true, '330'],
    ['report', '43', false, '77'],
  ]);
  assert.equal(mail.items.find(row => row.id === '英雄甲').pending, '3');
  assert.equal(mail.items.find(row => row.id === '装备甲').pending, '1');
  assert.deepEqual(calls.filter(c => c.owner === 'a' && c.name === 'EmailBoxRequest').map(c => c.body.pageNo), [0, 1]);
  assert.deepEqual(calls.filter(c => c.owner === 'a' && c.name === 'CampaignReportsRequest').map(c => c.body.pageNo), [0, 1, 2, 3]);
  const client = app.sessions.get('a').client;
  const original = client.request;
  let claimedDuringScan = false;
  client.request = async function (name, body) {
    if (name === 'EmailBoxRequest' && body.pageNo === 1 && !claimedDuringScan) {
      this.emit('sent', { name: 'QuickGotReadEmailRequest' });
      claimedDuringScan = true;
    }
    const value = await original.call(this, name, body);
    if (name === 'EmailBoxRequest' && claimedDuringScan) return { ...value, email: value.email.map(mail => ({ ...mail, got:true })) };
    return value;
  };
  const afterClaim = await get('/api/season/mail?account=a');
  assert.deepEqual(afterClaim.merit, { pending:'77', claimed:'9007199254741332' });
  assert.equal(client.listenerCount('sent'), 0);
  const retriedPages = [];
  client.request = function (name, body) {
    if (name !== 'CampaignReportsRequest') return original.call(this, name, body);
    retriedPages.push(body.pageNo);
    return { total: 3, reports: [reports[0]] };
  };
  const partial = await fetch(base + '/api/season/mail?account=a');
  assert.equal(partial.ok, false);
  assert.match((await partial.json()).error, /出现重复编号/);
  assert.deepEqual(retriedPages, [0, 1, 0, 1]);
  client.request = original;
  assert.equal(seasonNumber({}), null);
  const duplicatePage = { request: async name => name === 'SeasonRankInfoRequest' ? {} : { player: [rankRow(1)], maxPage: 2 } };
  await assert.rejects(readSeasonRanking(duplicatePage, {}, 'merit'), /分页/);
  assert.equal((await fetch(base + '/api/season/mail')).ok, false);
  assert.equal((await fetch(base + '/api/season/rank?account=a&kind=other')).ok, false);
  assert.equal((await fetch(base + '/api/season/mail?account=a', { method: 'POST' })).status, 404);
  const settingsPath = '/api/season/merit-settings?account=a';
  const originalPref = await get(settingsPath);
  const postPref = (pref, version) => fetch(base + settingsPath, { method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({ seasonMerit:pref, revision:version.revision, baseRevision:version.baseRevision, confirm:true }) });
  assert.equal(originalPref.enabled, false);
  assert(!(await postPref({enabled:true,targetRank:0,leadMinutes:5}, originalPref)).ok);
  assert(!(await postPref({enabled:true,targetRank:1,leadMinutes:0}, originalPref)).ok);
  const selected = { enabled:true, targetRank:2, leadMinutes:12 };
  assert((await postPref(selected, originalPref)).ok);
  assert(!(await postPref(selected, originalPref)).ok);
  assert.equal((await get(settingsPath)).leadMinutes,12);
  assert.equal((await get('/api/season/merit-settings?account=b')).enabled,false);
  if (process.argv.includes('--browser')) {
    const { chromium } = await import('playwright-core');
    const executablePath = process.env.CW_BROWSER_TEST_EXECUTABLE || [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find(fs.existsSync);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
      if (!history.state?.consoleView) history.replaceState({ consoleView: { tab: 'season-preview' } }, '');
    });
    await page.goto(base);
    const panel = page.locator('#season-preview-root');
    await panel.getByText('S4 赛季').waitFor();
    const miscTab = page.locator('#tabs [data-tab="resources"]');
    const seasonTab = page.locator('#resource-tabs [data-resource-tab="season-preview"]');
    const chatTab = page.locator('#resource-tabs [data-resource-tab="chat"]');
    assert.equal(await page.locator('#tabs [data-tab="season-preview"]').count(), 0);
    assert.equal(await seasonTab.locator('+ [data-resource-tab="chat"]').count(), 1);
    assert.equal(await miscTab.getAttribute('aria-current'), 'page');
    assert.equal(await seasonTab.getAttribute('aria-current'), 'page');
    assert.deepEqual(await page.evaluate(() => history.state.consoleView), { tab: 'resources', resource: 'season-preview' });
    await chatTab.click();
    await page.locator('#tab-chat').waitFor();
    await page.locator('#tabs [data-tab="account"]').click();
    await miscTab.click();
    await seasonTab.click();
    await panel.getByText('S4 赛季').waitFor();
    await page.reload();
    await panel.getByText('S4 赛季').waitFor();
    assert.equal(await seasonTab.getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 1180, height: 844 });
    await page.locator('#tabs [data-tab="account"]').click();
    await page.getByRole('button', {name: '站内搜索'}).click();
    await page.getByRole('combobox', {name: '搜索功能或页面文字'}).fill('自动偷榜');
    await page.getByRole('option', {name: '赛季预览 杂项', exact: true}).click();
    await panel.getByText('S4 赛季').waitFor();
    assert.equal(await seasonTab.getAttribute('aria-current'), 'page');
    const summary = panel.getByRole('region', {name: '我的赛季'});
    await summary.getByText('第 51 名', {exact: true}).waitFor();
    await summary.getByText('第 94 名', {exact: true}).waitFor();
    await summary.getByText('第 2 名', {exact: true}).waitFor();
    await summary.getByText('未领 9,007,199,254,741,072').waitFor();
    const toggle = panel.getByRole('switch',{name:'自动偷榜'});
    await toggle.waitFor();
    assert(await toggle.isChecked());
    await panel.getByLabel('结算前（分钟）').fill('8');
    await panel.getByRole('button',{name:'保存设置'}).click();
    await panel.getByText('已保存，随本账号挂机运行').waitFor();
    assert.equal((await get(settingsPath)).leadMinutes,8);
    await panel.getByText(/请手动关闭挂机配置中的「邮件附件」/).waitFor();
    assert.equal(await summary.getByText(/^已领/).count(), 0);
    for (const width of [320, 390, 1180]) {
      await page.setViewportSize({ width, height: 844 });
      const stats = await summary.boundingBox();
      const picker = await panel.getByRole('group', {name:'赛季预览内容'}).boundingBox();
      assert(stats && picker);
      assert(width >= 1000 ? picker.x >= stats.x + stats.width : picker.y >= stats.y + stats.height);
      assert(await panel.evaluate(node => node.scrollWidth <= node.clientWidth));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const previewCalls = () => calls.filter(c => c.name.startsWith('SeasonRank') || c.name === 'EmailBoxRequest' || c.name === 'CampaignReportsRequest').length;
    const initialCalls = previewCalls();
    assert.equal(await panel.locator('tbody tr').count(), 50);
    await panel.getByRole('button', { name: '科技榜' }).click();
    const techTable = panel.getByRole('table', { name: '科技霸主 · 科技榜' });
    await techTable.getByRole('cell', { name: '玩家3', exact: true }).waitFor();
    assert.equal(await techTable.locator('tbody tr').count(), 3);
    await panel.getByRole('button', { name: '邮件物品' }).click();
    await panel.getByText('未领取功勋 9,007,199,254,741,072').waitFor();
    assert.equal(await panel.getByText(/\d+\s*封系统邮件/).count(), 0);
    const meritMail = panel.locator('details').filter({ has: page.locator('summary strong', { hasText: /^功勋$/ }) });
    await meritMail.locator('summary').click();
    await meritMail.getByText(/第一封/).waitFor();
    await meritMail.locator('li').filter({ hasText: '货轮49' }).getByText('未领 77').waitFor();
    assert.equal(await meritMail.getByText(/货轮46/).count(), 0);
    assert.equal(await meritMail.getByText(/第二封/).count(), 0);
    await panel.getByRole('switch', {name:'包含已领取附件'}).click();
    await meritMail.getByText(/第二封/).waitFor();
    await meritMail.locator('li').filter({ hasText: '货轮46' }).getByText('已领 330').waitFor();
    assert.equal(previewCalls(), initialCalls);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    let signal;
    const started = new Promise(resolve => { signal = resolve; });
    await page.route('**/api/season/mail?account=a', async route => {
      signal();
      await hold;
      await route.fulfill({ json: mail }).catch(() => {});
    });
    await panel.getByRole('button', { name: '刷新' }).click();
    await started;
    await page.evaluate(() => window.cwConsoleStore.getState().actions.selectAccount('b'));
    await panel.getByText('S2 赛季').waitFor();
    release();
    await summary.getByText('未加入联盟').waitFor();
    await summary.getByText('未领 0').waitFor();
    assert(!(await toggle.isChecked()));
    await panel.getByRole('table', { name: '最强个人 · 功勋榜' }).waitFor();
    assert.equal(await panel.getByText('S4 赛季').count(), 0);
  }
  const start = await fetch(base + '/api/loop/start?account=a', { method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({confirm:true, rounds:1}) });
  const startedLoop = await start.json();
  assert(start.ok, startedLoop.error);
  await app.sessions.get('a').loop.job;
  console.log('通过：赛季编号、两榜分页与本人名次、邮件汇总与来源、账号隔离、独立启动偷榜挂机' + (browser ? '、手机浏览器页面' : ''));
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await app.close();
  if (path.dirname(tmp) === path.resolve(os.tmpdir()) && path.basename(tmp).startsWith('cw-season-preview-'))
    fs.rmSync(tmp, { recursive: true, force: true });
}
