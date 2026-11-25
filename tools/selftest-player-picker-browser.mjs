// 隔离账号验证跟随名单的真实点击行为，不连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-player-picker-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
const { loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { rememberPlayerNames, listedPlayerNames } = await import('../src/player-name-history.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('名单测试禁止连接游戏'); };
saveStore({ activeId: 'player-picker', accounts: [{
  id: 'player-picker', label: '盟友名单测试', url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: true },
}] });
const app = createConsole({ port: 0, protocol: {} });
const output = path.resolve('output/playwright/player-picker');
fs.mkdirSync(output, { recursive: true });
const errors = [];
const extraMembers = Array.from({ length: 28 }, (_, i) => ({ id: String(11000 + i), name: '盟友' + (i + 3) }));
let browser;
try {
  const base = await app.listen();
  await fetch(base + '/api/settings?account=player-picker');
  app.sessions.get('player-picker').ownedFleets = { worldId: '1', playerId: '2', ids: ['1远征船'], checkedAt: Date.now() };
  const executablePath = [process.env.CW_BROWSER_TEST_EXECUTABLE, chromium.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file => file && fs.existsSync(file));
  assert(executablePath, '未找到测试浏览器');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const activate = locator => mobile ? locator.tap() : locator.click();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/settings/players?*', route => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get('scope') === 'world') {
        const rankPage = Number(params.get('rankPage') ?? 1), members = [
          { id: '9007199254740994', name: '同名船长', source: '私聊联系人', guildIdx: 9 }];
        if (rankPage === 2) members.push({ id: '9007199254740995', name: '同名船长', source: '战力榜', guildIdx: 7 });
        return route.fulfill({ json: { members, rankPage, rankPages: 2 } });
      }
      return route.fulfill({ json: { guildName: '测试联盟', members: [
        { id: '9007199254740993', name: '测试盟友甲', online: true, power: '1234567' },
        { id: '9007199254740994', name: '测试盟友乙', online: false, power: '234567890' },
        ...extraMembers,
      ] } });
    });
    await page.goto(base + '/#config-group-treasure');
    assert.deepEqual(await page.evaluate(() => [null, '0', '99999', '100000', '99999999', '100000000', '10000000000000', '9223372036854775807'].map(configCompactPower)),
      ['', '0', '99999', '10万', '9999.9万', '1亿', '1兆', '922337兆']);
    await page.locator('#config-field-treasure-follow').waitFor();
    if (await page.locator('#config-field-treasure-follow').getAttribute('aria-checked') !== 'true') await activate(page.locator('#config-field-treasure-follow'));
    const disclosure = page.getByRole('button', { name: '跟随指定玩家，展开下级设置', exact: true });
    if (await disclosure.isVisible()) await activate(disclosure);
    const root = page.locator('#config-field-treasure-followPlayerIds');
    const summary = root.locator('summary');
    await activate(summary);
    const search = root.locator('input[type=search]');
    const first = root.locator('input[type=checkbox]').first();
    await first.waitFor();
    assert.deepEqual(await root.locator('.config-option .config-player-power').allTextContents(), ['战力 123.45万', '战力 2.34亿']);
    assert.equal(await search.evaluate(node => node === document.activeElement), !mobile, '仅桌面展开时自动聚焦盟友搜索框');
    await activate(root.locator('.config-player-name').first());
    assert.equal(await first.isChecked(), true, '点击盟友名字应勾选');
    assert.equal(await root.locator('details').getAttribute('open'), '', '点击名字后应保持展开');
    await activate(root.locator('.config-player-name').first());
    assert.equal(await first.isChecked(), false, '再次点击名字应取消勾选');
    await activate(search);
    assert.equal(await search.evaluate(node => node === document.activeElement), true);
    await search.fill('9007199254740994');
    await activate(root.locator('.config-option small'));
    assert.equal(await first.isChecked(), true, '点击角色 ID 应勾选');
    assert.equal(await search.isVisible(), true, '点击角色 ID 后列表应保持展开');
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.followPlayerIds, ['9007199254740994']);
    // 首次保存可能规范化配置并重绘；重新展开后继续检查交互。
    if (!await search.isVisible()) await activate(summary);
    await search.fill('9007199254740994');
    await page.screenshot({ path: path.join(output, mobile ? 'selected-mobile.png' : 'selected-desktop.png'), animations: 'disabled' });
    await activate(first);
    assert.equal(await first.isChecked(), false, '直接点击勾选框仍能切换');
    await first.press('Space');
    assert.equal(await first.isChecked(), true, '键盘空格仍能切换');
    await first.press('Escape');
    assert.equal(await root.locator('details').getAttribute('open'), null, 'Escape 关闭列表');
    assert.equal(await summary.evaluate(node => node === document.activeElement), true, 'Escape 返回入口焦点');
    await activate(summary);
    await first.waitFor({ state: 'visible' });
    await activate(page.locator('#config-field-treasure-followNames'));
    assert.equal(await root.locator('details').getAttribute('open'), null, '点击外部仍关闭列表');
    await activate(summary);
    await search.press('Shift+Tab');
    await summary.press('Shift+Tab');
    assert.equal(await root.locator('details').getAttribute('open'), null, '键盘移出下拉框仍关闭列表');
    await activate(summary);
    await search.fill('');
    await activate(root.getByText('测试盟友甲', { exact: true }));
    await activate(summary);
    const selected = root.getByRole('list');
    const firstId = '9007199254740993', secondId = '9007199254740994';
    assert.deepEqual(await selected.locator('.config-player-identity small').allTextContents(), ['ID ' + secondId, 'ID ' + firstId]);
    assert.deepEqual(await selected.locator('.config-player-power').allTextContents(), ['战力 2.34亿', '战力 123.45万']);
    for (const label of ['测试盟友甲', '测试盟友乙']) {
      assert.equal(await root.getByText(label, { exact: true }).filter({ visible: true }).count(), 1, '每位已选盟友只显示一次');
    }
    assert.equal(await root.getByRole('button', { name: /^移除/ }).count(), 0);
    assert.equal(await summary.getByText('已选 2 位', { exact: true }).isVisible(), true);
    await root.screenshot({ path: path.join(output, mobile ? 'roster-mobile.png' : 'roster-desktop.png'), animations: 'disabled' });
    const morePlayers = root.getByRole('button', { name: '查看全部', exact: true });
    assert.equal(await morePlayers.count(), 0);
    const setRoster = ids => page.evaluate(ids => configSet('treasure.followPlayerIds', ids), ids);
    const ordered = [secondId, firstId, ...extraMembers.map(member => member.id)];
    await setRoster(ordered.slice(0, 3));
    await morePlayers.waitFor();
    const compactHeight = await selected.evaluate(node => node.clientHeight);
    await setRoster(ordered);
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.equal(await selected.getByRole('listitem').count(), 2);
    assert.equal(await selected.evaluate(node => node.clientHeight), compactHeight);
    assert.equal(await summary.getByText('已选 30 位', { exact: true }).isVisible(), true);
    await root.screenshot({ path: path.join(output, mobile ? 'roster-compact-mobile.png' : 'roster-compact-desktop.png'), animations: 'disabled' });
    if (mobile) {
      const viewport = page.viewportSize();
      await page.setViewportSize({ ...viewport, width: 320 });
      const footer = root.locator('.config-player-footer');
      const buttonTops = await footer.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
      assert.equal(new Set(buttonTops).size, 1, '窄屏操作按钮保持同一行');
      await page.setViewportSize(viewport);
    }
    if (mobile) await activate(morePlayers);
    else {
      await morePlayers.press('Enter');
      assert.equal(await selected.evaluate(node => node === document.activeElement), true);
    }
    assert.equal(await selected.getByRole('listitem').count(), 30);
    assert.equal(await selected.evaluate(node => node.scrollHeight > node.clientHeight && node.clientHeight <= innerHeight * 0.42 + 1), true);
    await selected.getByRole('listitem').last().scrollIntoViewIfNeeded();
    assert(await selected.evaluate(node => node.scrollTop > 0));
    await activate(root.getByRole('button', { name: '收起名单', exact: true }));
    assert.equal(await selected.getByRole('listitem').count(), 2);
    assert.equal(await selected.evaluate(node => node.scrollTop), 0);
    await activate(root.getByRole('button', { name: '编辑跟随名单', exact: true }));
    await activate(selected.getByRole('listitem').last().getByRole('button', { name: /^移除/ }));
    await activate(root.getByRole('button', { name: '完成编辑跟随名单', exact: true }));
    assert.equal(await selected.getByRole('listitem').count(), 2);
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.followPlayerIds, ordered.slice(0, -1));
    await setRoster([secondId, firstId]);
    await activate(root.getByRole('button', { name: '编辑跟随名单', exact: true }));
    await activate(root.getByRole('button', { name: '移除（测试盟友甲，ID ' + firstId + '）', exact: true }));
    await activate(root.getByRole('button', { name: '完成编辑跟随名单', exact: true }));
    assert.equal(await selected.getByRole('listitem').count(), 1);
    assert.equal(await root.getByRole('button', { name: /^移除/ }).count(), 0);
    await activate(root.getByRole('button', { name: '编辑跟随名单', exact: true }));
    await activate(root.getByRole('button', { name: /^移除并关闭.*测试盟友乙/ }));
    assert.equal(await page.locator('#config-field-treasure-follow').getAttribute('aria-checked'), 'false');
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.followPlayerIds, []);
    const chase = page.locator('#config-field-treasure-chase');
    await activate(chase);
    const chaseDisclosure = page.getByRole('button', { name: '是否开启追杀，展开下级设置', exact: true });
    if (await chaseDisclosure.isVisible()) await activate(chaseDisclosure);
    const chaseIds = page.locator('#config-field-treasure-chasePlayerIds'), avoidIds = page.locator('#config-field-treasure-avoidPlayerIds');
    async function selectByName(picker, guild) {
      await activate(picker.locator('summary'));
      await picker.getByRole('searchbox').fill('同名船长');
      const options = picker.locator('.config-option');
      await options.first().waitFor();
      const more = picker.getByRole('button', { name: '加载下一页战力榜' });
      if (await more.isVisible()) {
        const search = picker.getByRole('searchbox');
        await search.fill('9007199254740995');
        await picker.getByText('已载入的名单中没有匹配玩家，可继续加载战力榜。').waitFor();
        await activate(more);
        await options.filter({ hasText: '战力榜' }).waitFor();
        assert.equal(await search.inputValue(), '9007199254740995');
        assert.equal(await more.isVisible(), false);
        await search.fill('同名船长');
      }
      assert.equal(await options.count(), 2);
      await activate(options.filter({ hasText: '联盟 ' + guild }).locator('.config-player-name'));
      await activate(picker.locator('summary'));
    }
    await selectByName(chaseIds, 7);
    await selectByName(avoidIds, 9);
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    const saved = loadAutomationSettings('player-picker').settings.treasure;
    assert.deepEqual(saved.chasePlayerIds, ['9007199254740995']);
    assert.deepEqual(saved.avoidPlayerIds, ['9007199254740994']);
    const id = saved.chasePlayerIds[0], old = mobile ? '旧船长乙' : '旧船长甲', name = mobile ? '新船长乙' : '新船长甲';
    const aliases = page.locator('#config-field-treasure-chaseNames');
    await aliases.fill(old);
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    const settings = loadAutomationSettings('player-picker').settings;
    rememberPlayerNames('player-picker', settings, [{ id, name: old }]);
    rememberPlayerNames('player-picker', settings, [{ id, name, power: '876543210' }]);
    // 迟到的行军快照不能把已核实的新昵称改回去。
    rememberPlayerNames('player-picker', settings, [{ id, name: old }], { initialOnly: true });
    assert.deepEqual(listedPlayerNames('另一个账号', settings), {});
    const history = chaseIds.locator('.config-list-history');
    await activate(history.getByRole('button', { name: /刷新.*资料/ }));
    await history.getByText('已改名 · 曾用名 ' + old, { exact: true }).waitFor();
    await history.getByText('战力 8.76亿', { exact: true }).waitFor();
    await activate(history.getByRole('button', { name: '编辑追杀玩家', exact: true }));
    await activate(history.getByRole('button', { name: '删除旧昵称“' + old + '”', exact: true }));
    assert.equal(await aliases.inputValue(), '');
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.chasePlayerIds, [id]);
    // 绑定后 ID 和手填昵称均应保存。仅删除 ID 时追杀仍能按昵称运行。
    await aliases.fill(old);
    await activate(history.getByRole('button', { name: '移除（' + name + '，ID ' + id + '）', exact: true }));
    await activate(history.getByRole('button', { name: '绑定此 ID 并保留“' + old + '”', exact: true }));
    assert.equal(await history.getByRole('listitem').count(), 1);
    assert.equal(await aliases.inputValue(), old);
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    const bound = loadAutomationSettings('player-picker').settings.treasure;
    assert.deepEqual(bound.chasePlayerIds, [id]);
    assert.deepEqual(bound.chaseNames, [old]);
    await activate(history.getByRole('button', { name: '移除（' + name + '，ID ' + id + '）', exact: true }));
    assert.equal(await chase.getAttribute('aria-checked'), 'true');
    await activate(history.getByRole('button', { name: /删除旧昵称.*并关闭/ }));
    assert.equal(await chase.getAttribute('aria-checked'), 'false');
    await activate(avoidIds.getByRole('button', { name: '编辑避战玩家', exact: true }));
    await activate(avoidIds.getByRole('button', { name: /^移除（/ }));
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    assert.deepEqual(loadAutomationSettings('player-picker').settings.treasure.chasePlayerIds, []);
    assert.deepEqual(listedPlayerNames('player-picker', settings), {});
    await activate(page.getByRole('tab', { name: '硅矿', exact: true }));
    const silicon = page.locator('#config-field-silicon-enabled');
    if (await silicon.getAttribute('aria-checked') !== 'true') await activate(silicon);
    const fleet = page.locator('#config-field-silicon-fleets-0-enabled');
    if (await fleet.getAttribute('aria-checked') !== 'true') await activate(fleet);
    const expandFleet = page.getByRole('button', { name: '舰队1 · 启用，展开下级设置', exact: true });
    if (await expandFleet.isVisible()) await activate(expandFleet);
    const hunt = page.locator('#config-field-silicon-fleets-0-huntEnabled');
    if (await hunt.getAttribute('aria-checked') !== 'true') await activate(hunt);
    const expandHunt = page.getByRole('button', { name: '舰队1 · 追杀指定玩家，展开下级设置', exact: true });
    if (await expandHunt.isVisible()) await activate(expandHunt);
    const hunted = page.locator('#config-field-silicon-fleets-0-huntPlayerIds');
    const safe = page.locator('#config-field-silicon-fleets-0-safePlayerIds');
    await selectByName(hunted, 7);
    await selectByName(safe, 9);
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    const [policy] = loadAutomationSettings('player-picker').settings.silicon.fleets;
    assert.deepEqual(policy.huntPlayerIds, ['9007199254740995']);
    assert.deepEqual(policy.safePlayerIds, ['9007199254740994']);
    // 下一种屏幕尺寸从空名单开始。
    await activate(hunted.getByRole('button', { name: '编辑舰队1 · 追杀玩家', exact: true }));
    await activate(hunted.getByRole('button', { name: /^移除并关闭追杀/ }));
    await activate(safe.getByRole('button', { name: '编辑舰队1 · 安全玩家', exact: true }));
    await activate(safe.getByRole('button', { name: /^移除（/ }));
    await page.locator('#config-state').filter({ hasText: '配置已同步' }).waitFor();
    await page.close();
    console.log('通过：' + (mobile ? '手机触屏' : '桌面鼠标') + '盟友选择、改名标记、绑定 ID 保留昵称兜底及移除均可保存');
  }
  assert.deepEqual(errors, []);
  assert.equal(connections, 0);
  // 纯昵称规则只能在见过 ID 后提示换绑。同名角色互不覆盖，也不自动修改名单。
  const legacy = { silicon: { fleets: [{ huntPlayers: ['Captain'] }] } };
  const first = '9007199254740995', second = '9007199254740994';
  rememberPlayerNames('legacy', legacy, [{ id: first, name: 'CAPTAIN' }, { id: second, name: 'Captain' }], { initialOnly: true });
  rememberPlayerNames('legacy', legacy, [{ id: first, name: '船长甲' }, { id: second, name: '船长乙' }]);
  assert.deepEqual(listedPlayerNames('legacy', legacy), {
    [first]: { name: '船长甲', previous: ['CAPTAIN'] }, [second]: { name: '船长乙', previous: ['Captain'] },
  });
  assert.deepEqual(legacy.silicon.fleets[0], { huntPlayers: ['Captain'] });
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' });
  throw error;
} finally {
  await browser?.close(); app.server.closeAllConnections(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
