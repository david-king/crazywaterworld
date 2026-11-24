import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { runLoop } from '../src/loop.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { defaultSettings, hasBaseWork, hasExtraWork, validateSettings, importAutomationSettings, exportAutomationSettings } from '../src/automation-settings.mjs';
import { planBaseAutomation, runBaseAutomation, surveyBaseAutomation } from '../src/base-automation.mjs';
import { museumBoothAdvice, planMuseumDisplay } from '../src/museum-display.mjs';
import { museumPreview } from '../src/museum-preview.mjs';
import { museumFinishKey } from '../src/museum-cases.mjs';

const config = loadConfig(), protocol = loadProtocol();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-museum-unlock-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const codec = (name, data) => protocol[name].decode(protocol[name].encode(data).finish());
const now = Math.floor(Date.now() / 1000);
const caseRow = (caseIndex, level = 0, unlocked = false, upgradeFinishTime = 0) =>
  ({ caseIndex, level, unlocked, antiqueId: '', upgradeFinishTime });
const quote = [{ id: 'GOLD', num: 5400 }, { id: '人气币', num: 1300 }, { id: '建筑蓝图', num: 5 }];
let sequence = 0;

function fixture() {
  const role = String(++sequence + 810000);
  const player = { worldId: 1000001, playerId: role, level: 28 };
  const settings = defaultSettings();
  settings.loop.world = settings.museum.runEnabled = settings.museum.unlockCases = true;
  settings.building.keepBlueprints = 2;
  const museum = { exhibitions: [{ exhibitionId: 1, level: 1, keywordLevels: [], cases: [caseRow(101, 1, true)] }],
    popularity: 123, topPopularity: 123, uncollectedRevenue: 0, revenueLastSettleTime: 0, exploreStages: [], claimedAchievements: [] };
  const stock = new Map([['GOLD', 5400], ['人气币', 1300], ['建筑蓝图', 7]]);
  const file = path.join(temp, role + '.json');
  const snapshot = { now, player, world: { stock: new Map(stock), buildings: [], factories: [], stockCap: 0 }, museum, notes: [], choices: [], pets: [], heroes: [] };
  const f = { player, settings, museum, cases: museum.exhibitions[0].cases, stock, snapshot, writes: [], reads: [],
    beforeRead() {}, beforeWrite() {}, afterWrite() {}, built: true, frozen: false, replyCase: null,
    ledger: createUsageLedger(role, { file }),
    restart() { this.ledger = createUsageLedger(role, { file, now: () => (now + 86400) * 1000 }); this.client.connectionEpoch++; },
    plan() { return planBaseAutomation(snapshot, config, settings); },
    run(plan = this.plan()) { return runBaseAutomation(this.client, protocol, config, plan,
      { player, ledger: this.ledger, getSettings: () => settings }); },
  };
  f.client = { connected: true, connectionEpoch: 1,
    async request(name, body, response) {
      if (name === 'MuseumUpgradeCaseRequest' || name === 'MuseumFinishCaseUpgradeRequest') {
        const decoded = codec(name, body);
        assert.deepEqual([decoded.exhibitionId, decoded.caseIndex], [1, 102]);
        assert.equal(response, 'MuseumCaseUpdateResponse');
        f.writes.push(name);
        f.beforeWrite(name);
        const target = name === 'MuseumUpgradeCaseRequest' ? caseRow(102, 0, false, now + 11400) : caseRow(102, 1, true);
        if (!f.frozen) {
          const prior = f.cases.find(c => c.caseIndex === 102);
          if (prior) Object.assign(prior, target); else f.cases.push(target);
          if (name === 'MuseumUpgradeCaseRequest') for (const { id, num } of quote) stock.set(id, stock.get(id) - num);
        }
        f.afterWrite(name);
        return codec(response, { cases: [f.replyCase ?? target] });
      }
      f.reads.push(name);
      f.beforeRead(name);
      if (name === 'OnWaterRequest') return { building: f.built ? [{ buildingId: '1博物馆', level: 1 }] : [] };
      if (name === 'MuseumInfoRequest') return codec(response, museum);
      if (name === 'AllItemRequest') return { items: [...stock].filter(([id]) => id !== 'GOLD').map(([itemId, num]) => ({ itemId, num })) };
      if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: stock.get('GOLD') }] };
      assert.fail('意外请求 ' + name);
    },
  };
  return f;
}

test('旧配置默认关闭，单独开启展位解锁即可进入正常基地轮询', async () => {
  const f = fixture(), old = exportAutomationSettings(f.settings);
  delete old.settings.museum.unlockCases;
  old.version = 57;
  assert.equal(validateSettings(old.settings).museum.unlockCases, false);
  assert.equal(importAutomationSettings(old).museum.unlockCases, false);
  assert.equal(hasBaseWork(f.settings), true);
  assert.equal(hasExtraWork(f.settings), true);
  await surveyBaseAutomation(f.client, protocol, config, f.player, f.settings, f.snapshot.world);
  assert.deepEqual(f.reads, ['MuseumInfoRequest']);
  for (const [group, key] of [['loop', 'world'], ['museum', 'runEnabled'], ['museum', 'unlockCases']]) {
    const plan = f.plan();
    f.settings[group][key] = false;
    assert.equal(f.plan().actions.length, 0);
    await f.run(plan);
    assert.deepEqual(f.writes, []);
    f.settings[group][key] = true;
  }
});

test('截图中的 2 号展位既可缺席也可显式锁定，预览和扣料采用游戏首级配置', () => {
  const f = fixture();
  const preview = museumPreview(f.snapshot, null, config, f.settings);
  assert(preview.display.upgrades.some(row => row.name.includes('2 号') && row.reason === '可以解锁'));
  for (const explicit of [false, true]) {
    if (explicit) f.cases.push(caseRow(102));
    const [step] = f.plan().actions;
    assert.deepEqual(step.costs, quote);
    assert.deepEqual(step.body, { exhibitionId: 1, caseIndex: 102 });
    const advice = museumBoothAdvice(f.museum, [], config, f.stock);
    assert(advice.upgrades.some(u => u.name.includes('2 号') && u.level === 1 && u.reason === '可以解锁'));
  }
});

test('展区、前置等级、锁定状态和蓝图保留量会阻止开工', () => {
  const f = fixture();
  f.cases[0].unlocked = false;
  assert.equal(f.plan().actions.length, 0);
  f.cases[0].unlocked = true;
  f.snapshot.world.stock.set('建筑蓝图', 6);
  assert.equal(f.plan().actions.length, 0);
  f.snapshot.world.stock = new Map([['GOLD', 1000000], ['人气币', 1000000], ['建筑蓝图', 1000]]);
  f.cases.push(...[102, 103, 104, 105].map(id => caseRow(id, 1, true)));
  assert.equal(f.plan().actions.length, 0);
  f.museum.exhibitions[0].level = 2;
  assert.deepEqual(f.plan().actions.map(s => s.body.caseIndex), [106]);
  f.cases.push(caseRow(105, 1, true));
  assert.equal(f.plan().actions.length, 0);
});

test('真实配置与协议完成 2 号展位开工、等待、到期完工，随后可上架', async () => {
  const f = fixture();
  assert.equal(f.settings.schedule.adSpeedUpMuseum, false);
  assert.equal((await f.run())[0].status, 'confirmed');
  assert.deepEqual([...f.stock.values()], [0, 0, 2]);
  assert.equal(f.plan().actions.length, 0);
  const booth = f.cases.find(c => c.caseIndex === 102);
  booth.upgradeFinishTime = now - 1;
  const due = f.plan();
  assert.equal((await f.run(due))[0].ok, true);
  await f.run(due);
  assert.deepEqual(f.writes, ['MuseumUpgradeCaseRequest', 'MuseumFinishCaseUpgradeRequest']);
  const art = config.tables.AntiqueBaseCfg.data.find(a => a.isAntique && a.color === 'RED');
  f.cases[0].antiqueId = '占用';
  assert.equal(planMuseumDisplay(f.museum, [{ id: art.antiqueId, star: 0 }], config).actions[0].body.caseIndex, 102);
});

test('发送前重新核对本轮金币、人气币、蓝图、展位、建筑和账号连接', async () => {
  for (const id of ['GOLD', '人气币', '建筑蓝图']) {
    const f = fixture(), plan = f.plan();
    f.stock.set(id, f.stock.get(id) - 1);
    assert.equal((await f.run(plan))[0].ok, false);
    assert.deepEqual(f.writes, []);
  }
  for (const change of [f => { f.cases.push(caseRow(102, 1, true)); }, f => { f.settings.museum.unlockCases = false; },
    f => { f.client.connectionEpoch++; }, f => { f.player.playerId = '999999'; }]) {
    const f = fixture(), plan = f.plan();
    f.beforeRead = name => { if (name === 'MuseumInfoRequest') change(f); };
    await f.run(plan);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.ledger.keyRecords(), {});
  }
  for (const change of [f => { f.built = false; }, f => { f.player.level = 27; }]) {
    const f = fixture(); change(f); await f.run();
    assert.deepEqual(f.writes, []);
  }
});

test('切换角色后不能执行旧角色的展位计划', async () => {
  const a = fixture(), b = fixture();
  await b.run(a.plan());
  assert.deepEqual(b.reads, []);
  assert.deepEqual(b.writes, []);
});

test('单开解锁的挂机轮次通过基地调度执行并报告目标展位', async () => {
  const f = fixture(), client = Object.assign(new EventEmitter(), f.client);
  client.setMaxListeners(100);
  const names = ['OnWater', 'AllItem', 'AllResource', 'MuseumInfo'];
  const subset = Object.fromEntries(names.flatMap(name => ['Request', 'Response'].map(end => [name + end, protocol[name + end]])));
  subset.MuseumUpgradeCaseRequest = protocol.MuseumUpgradeCaseRequest;
  subset.MuseumCaseUpdateResponse = protocol.MuseumCaseUpdateResponse;
  const reports = [];
  await runLoop(client, subset, { config, player: f.player, rounds: 1, allowMutate: true,
    usageLedger: f.ledger, getSettings: () => f.settings, isEnabled: () => false, onStep: row => reports.push(row) });
  assert.deepEqual(f.writes, ['MuseumUpgradeCaseRequest']);
  assert(reports.some(row => row.taskKey === 'museum.unlockCases' && row.ok && row.step.body.caseIndex === 102));
});

test('未知开工结果跨重启或换日不会重发，看到目标施工后核销', async () => {
  const f = fixture(), plan = f.plan();
  f.frozen = true;
  f.afterWrite = () => { throw Error('响应丢失'); };
  assert.equal((await f.run(plan))[0].status, 'pending');
  f.restart();
  assert.equal((await f.run())[0].status, 'pending');
  f.cases.push(caseRow(102, 0, false, now + 11400));
  await f.run();
  assert.equal(f.ledger.snapshot().uncertain, 0);
  assert.deepEqual(f.writes, ['MuseumUpgradeCaseRequest']);
});

test('完工与广告入口共用记录，错柜回执或完工状态未同步均不能报成功', async () => {
  for (const mode of ['advert', 'wrongReply', 'stale']) {
    const f = fixture(), time = now - 1;
    f.cases.push(caseRow(102, 0, false, time));
    if (mode === 'advert') {
      f.ledger.reserve({}, {}, {}, { uniqueKey: museumFinishKey(1, 102, time) });
      await f.run(); assert.deepEqual(f.writes, []); continue;
    }
    f.replyCase = mode === 'wrongReply' ? caseRow(101, 1, true) : null;
    f.frozen = true;
    assert.equal((await f.run())[0].status, 'pending');
    f.restart(); await f.run();
    assert.deepEqual(f.writes, ['MuseumFinishCaseUpgradeRequest']);
    Object.assign(f.cases[1], caseRow(102, 1, true)); await f.run();
    assert.equal(f.ledger.snapshot().uncertain, 0);
  }
});

test('服务器明确拒绝后可重试，同一展位的重叠检查只会开工一次', async () => {
  const f = fixture(), plan = f.plan();
  f.beforeWrite = name => { throw Object.assign(Error('服务器拒绝'), { prompt: true, request: name }); };
  assert.equal((await f.run(plan))[0].status, 'rejected');
  assert.deepEqual(f.ledger.keyRecords(), {});
  f.beforeWrite = () => {};
  await Promise.all([f.run(plan), f.run(plan)]);
  assert.equal(f.writes.length, 2);
  assert.equal(f.cases[1].upgradeFinishTime, now + 11400);
});
