import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { readAfkUpgrade } from '../src/afk-upgrade.mjs';
import { runLoop } from '../src/loop.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-afk-upgrade-'));
const protocol = createDeclaredProtocol(['AfkInfoRequest', 'AfkInfoResponse', 'AllItemRequest', 'AllItemResponse',
  'UpgradeAfkLevelRequest', 'UpgradeAfkLevelResponse', 'DrawAfkRewardRequest', 'DrawAfkRewardResponse']);
const rows = Array.from({ length: 150 }, (_, i) => ({
  level: i + 1, stage: 5 * i, consume: ['挂机徽章', 1],
}));
const config = { tables: { OfflineCfg: { data: rows } },
  afkMaxLevel: stage => rows.findLast(row => row.stage < stage)?.level ?? 0, nextAfkRewardLevel: () => null };
let serial = 0;
function fixture() {
  const player = { playerId: ++serial, worldId: 1, mainlineStage: 526, level: 20 };
  const settings = defaultSettings();
  const ledger = () => createUsageLedger('acct-' + player.playerId, { file: path.join(directory, 'ledger.json') });
  const state = { level: 105, badges: 1, start: Math.floor(Date.now() / 1000) - 3600 };
  const reads = [], writes = [];
  function connection() {
    return { connected: true, async request(name, body, response, timeout, beforeSend) {
      assert(protocol[name] && protocol[response], name);
      if (name === 'AfkInfoRequest') {
        reads.push(name);
        return { afkInfo: { level: state.level, afkStartTime: state.start, afkFinishTime: state.start + 36000 } };
      }
      if (name === 'AllItemRequest') {
        reads.push(name);
        return { items: [{ itemId: '挂机徽章', num: state.badges }] };
      }
      if (name === 'DrawAfkRewardRequest') {
        state.start = Math.floor(Date.now() / 1000);
        writes.push([name, body]);
        return { afkStartTime: state.start, afkFinishTime: state.start + 36000 };
      }
      assert.equal(name, 'UpgradeAfkLevelRequest');
      if (state.pauseBeforeSend) settings.schedule.afkUpgrade = false;
      beforeSend();
      writes.push([name, body.level]);
      if (state.fail === 'timeout') throw Error('timeout');
      if (state.fail === 'refused') throw Object.assign(Error('服务端拒绝'), { prompt: {}, request: name });
      assert([1, 5, 10].includes(body.level));
      const target = state.level + body.level;
      assert(target <= config.afkMaxLevel(player.mainlineStage));
      const cost = rows.filter(row => row.level > state.level && row.level <= target)
        .reduce((sum, row) => sum + row.consume[1], 0);
      assert(state.badges >= cost);
      state.badges -= cost;
      state.level += body.level;
      state.afterUpgrade?.(this);
      return { level: state.level, afkStartTime: state.start, afkFinishTime: state.start + 36000 };
    } };
  }
  // 每轮新建连接和账本对象，模拟重连/重启后继续运行。
  const round = async () => (await runLoop(connection(), protocol, { config, player, rounds: 1, allowMutate: true,
    getSettings: () => settings, isEnabled: key => settings.schedule[key], usageLedger: ledger() })).history[0].tasks.results;
  return { player, settings, state, reads, writes, round, preview: () => readAfkUpgrade(connection(), config, player, ledger()), ledger };
}

try {
  const f = fixture();
  await f.round();
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
  f.settings.schedule.afkUpgrade = true;
  f.player.mainlineStage = 525;
  assert.match((await f.round())[0].reason, /通关第 525 关/);
  f.player.mainlineStage++;
  f.state.badges = 0;
  assert.match((await f.round())[0].reason, /当前有 0 枚/);
  f.state.badges = 1;
  assert.deepEqual((await f.preview()).action.body, { level: 1 });
  assert.deepEqual(f.writes, []); assert.deepEqual(f.ledger().keyRecords(), {});
  assert.equal((await f.round())[0].status, 'confirmed');
  assert.equal(f.state.level, 106);
  assert.deepEqual(f.writes, [['UpgradeAfkLevelRequest', 1]]);
  async function checkBatches(badges, cleared, batches, { firstCost = batches[0], remaining = 0 } = {}) {
    const batch = fixture();
    batch.settings.schedule.afkUpgrade = true;
    batch.state.badges = badges;
    batch.player.mainlineStage = cleared + 1;
    const { action } = await batch.preview();
    assert.deepEqual(batch.writes, []);
    if (batches.length) {
      assert.deepEqual(action.body, { level: batches[0] });
      assert.deepEqual(action.costs, [{ id: '挂机徽章', num: firstCost }]);
      assert.deepEqual(action.verify, { level: 105 + batches[0] });
    } else {
      assert.equal(action, undefined);
    }
    await batch.round();
    assert.deepEqual(batch.writes, batches.map(count => ['UpgradeAfkLevelRequest', count]));
    assert.equal(batch.state.level, 105 + batches.reduce((sum, count) => sum + count, 0));
    assert.equal(batch.state.badges, remaining);
    return batch;
  }
  for (const [chips, batches] of [[0, []], [1, [1]], [4, [1, 1, 1, 1]], [5, [5]], [9, [5, 1, 1, 1, 1]],
    [10, [10]], [17, [10, 5, 1, 1]], [26, [10, 10, 5, 1]]]) {
    await checkBatches(chips, 700, batches);
  }
  for (const [cleared, batches, remaining] of [[524, [], 10], [525, [1], 9], [544, [1, 1, 1, 1], 6],
    [545, [5], 5], [569, [5, 1, 1, 1, 1], 1], [570, [10], 0]]) {
    await checkBatches(10, cleared, batches, { remaining });
  }
  const capped = await checkBatches(17, 570, [10], { remaining: 7 });
  capped.player.mainlineStage = 606;
  await capped.round();
  assert.deepEqual(capped.writes.map(row => row[1]), [10, 5, 1, 1]);
  assert.equal(capped.state.badges, 0);
  // 核对逐级累计费用，包括从 10 级档回退到 5 级档时真正扣除的数量。
  const intermediate = rows.find(row => row.level === 108);
  intermediate.consume[1] = 2;
  try {
    await checkBatches(3, 600, [1, 1], { remaining: 1 });
    await checkBatches(5, 600, [1, 1, 1, 1]);
    await checkBatches(10, 600, [5, 1, 1, 1, 1], { firstCost: 6 });
    await checkBatches(11, 600, [10], { firstCost: 11 });
  } finally { intermediate.consume[1] = 1; }

  const both = fixture();
  Object.assign(both.settings.schedule, { afk: true, afkUpgrade: true });
  both.settings.afk.claimIntervalHours = 2;
  await both.round();
  assert.deepEqual(both.writes.map(row => row[0]), ['UpgradeAfkLevelRequest']);
  both.state.start -= 3600;
  await both.round();
  assert.deepEqual(both.writes.map(row => row[0]), ['UpgradeAfkLevelRequest', 'DrawAfkRewardRequest']);

  const unknown = fixture();
  unknown.settings.schedule.afkUpgrade = true;
  unknown.player.mainlineStage = 546;
  unknown.state.badges = 5;
  unknown.state.fail = 'timeout';
  assert.equal((await unknown.round())[0].status, 'pending');
  assert.equal((await unknown.round())[0].status, 'pending');
  unknown.state.level = 106;
  assert.equal((await unknown.round())[0].status, 'pending');
  assert.deepEqual(unknown.writes, [['UpgradeAfkLevelRequest', 5]]);
  unknown.state.level = 110; unknown.state.badges = 0;
  await unknown.preview();
  assert.equal(unknown.ledger().snapshot().uncertain, 1, '预览不能核销待确认记录');
  await unknown.round();
  assert.equal(unknown.ledger().snapshot().uncertain, 0);
  assert.equal(unknown.writes.length, 1);

  for (const interruption of ['pause', 'reconnect', 'timeout']) {
    const batch = fixture();
    batch.settings.schedule.afkUpgrade = true;
    batch.player.mainlineStage = 606;
    batch.state.badges = 17;
    batch.state.afterUpgrade = client => {
      if (interruption === 'pause') batch.settings.schedule.afkUpgrade = false;
      if (interruption === 'reconnect') client.connectionEpoch = 2;
      if (interruption === 'timeout') batch.state.fail = 'timeout';
    };
    await batch.round();
    assert.equal(batch.state.badges, 7);
    if (interruption === 'timeout') {
      assert.deepEqual(batch.writes.map(row => row[1]), [10, 5]);
      assert.equal((await batch.round())[0].status, 'pending');
      assert.equal(batch.writes.length, 2);
      batch.state.level = 120;
      batch.state.badges = 2;
    } else {
      assert.deepEqual(batch.writes.map(row => row[1]), [10]);
    }
    delete batch.state.afterUpgrade;
    delete batch.state.fail;
    batch.settings.schedule.afkUpgrade = true;
    await batch.round();
    assert.deepEqual(batch.writes.map(row => row[1]), [10, 5, 1, 1]);
    assert.equal(batch.state.badges, 0);
  }

  const paused = fixture();
  paused.settings.schedule.afkUpgrade = true;
  paused.state.pauseBeforeSend = true;
  await paused.round();
  assert.deepEqual(paused.writes, []); assert.deepEqual(paused.ledger().keyRecords(), {});
  paused.state.pauseBeforeSend = false; paused.settings.schedule.afkUpgrade = true;
  paused.state.fail = 'refused';
  await paused.round();
  assert.deepEqual(paused.ledger().keyRecords(), {});
  delete paused.state.fail;
  assert.equal((await paused.round())[0].ok, true);
  console.log('挂机升级通过：同轮按 1/5/10 级用完可用芯片、主线解锁后续升、逐级费用、独立领取、只读预览、暂停、拒绝和重连核对');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
