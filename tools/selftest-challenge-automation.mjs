import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, validateSettings, importAutomationSettings, SETTINGS_FORMAT, createUsageLedger, nativeTaskValues } from '../src/automation-settings.mjs';
import { idleAutomationControls } from '../src/automation-controls.mjs';
import { createChallengeRun, runChallengeRound } from '../src/challenge-automation.mjs';
import { runLoop } from '../src/loop.mjs';
import { loadProtocol } from '../src/proto.mjs';
import { pirateAdvanceFixture } from './fixtures/pirate-advance.mjs';
import { createPirateAdvanceTask, runSinglePirateHunt, runPirateAdvance } from '../src/pirate-advance.mjs';
import { recoverFleetLineups } from '../src/fleet-lineups.mjs';
import { pirateHuntOptions } from '../src/pirates.mjs';
import { waitForChallenge, CHALLENGE_INTERVAL_MS } from '../src/battle-pacing.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-challenge-auto-'));
const oldData = process.env.CW_DATA_DIR;
const oldPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.CW_DATA_DIR);
const protocol = loadProtocol();
let count = 0, ledgerId = 0;
const ledger = () => createUsageLedger('simulated', { file: path.join(root, 'usage-' + ++ledgerId + '.json') });
const test = async (name, fn) => { await fn(); count++; console.log('通过：' + name); };

function fixture() {
  const settings = defaultSettings(), client = new EventEmitter(), state = createChallengeRun();
  client.connected = true;
  settings.loop.world = settings.loop.dailies = settings.loop.tasks = settings.loop.heroes = false;
  settings.dailies.enabled = false;
  settings.progression.enabled = true;
  const player = { playerId: '123', level: 37, mainlineStage: 1, worldId: 1001001, scenarioId: 1 };
  const table = data => ({ data });
  const config = { tables: {
    StageCfg: table(Array.from({ length: 20 }, (_, i) => ({ stage: i + 1, playerLevel: 1 }))),
    TrialRaidCfg: table([1,2,3].map(raidId => ({ raidId, title: '模拟试炼' + raidId }))),
    TrialRaidStageCfg: table([1,2,3].flatMap(raidId => [1,2,3,4,5].map(stageLevel => ({ raidId, stageLevel, stageId: raidId * 100 + stageLevel, openLevel: 1 })))),
  } };
  const writes = [], passed = new Map();
  const f = { client, player, config, settings, state, writes, won: false, hook: null, queued: false, requireQueue: false };
  client.request = async (name, body = {}) => {
    assert(protocol[name], 'real protocol exists: ' + name);
    protocol[name].decode(protocol[name].encode(body).finish());
    if (f.requireQueue) assert(f.queued, 'challenge must execute inside account queue');
    if (name === 'TrialRaidInfoRequest') {
      await f.hook?.(name, body);
      return { raid: { raidId: body.raidId, passedStage: passed.get(body.raidId) ?? 0 } };
    }
    if (name === 'ChallengeStageRequest' || name === 'TrialRaidChallengeRequest') {
      writes.push({ name, body });
      await f.hook?.(name, body);
      const won = typeof f.won === 'function' ? f.won(name, body) : f.won;
      if (name === 'ChallengeStageRequest') return { initialData: { mainlineStage: body.stage }, stats: { isLeftWin: won } };
      if (won) passed.set(body.raidId, body.stageId);
      return { raidId: body.raidId, stageId: body.stageId };
    }
    assert.fail('unexpected request ' + name);
  };
  f.once = extra => runChallengeRound(client, config, { player, getSettings: () => settings, state, wait: async () => {}, ledger: f.ledger ??= ledger(), ...extra });
  f.loop = (rounds, extra = {}) => runLoop(client, protocol, { config, player, rounds, getSettings: () => settings,
    challengeRun: state, isEnabled: () => false, allowMutate: true, everyMs: 1, sleep: async () => {}, usageLedger: f.ledger ??= ledger(),
    schedule: async work => { assert(!f.queued); f.queued = true; try { return await work(); } finally { f.queued = false; } }, ...extra });
  return f;
}

try {
  await test('旧设置与导入保留主线选择，新增试炼/海盗需主动开启，失败次数校验', () => {
    const old = defaultSettings(); delete old.progression; delete old.pirateHunt.enabled; delete old.pirateHunt.maxFailures;
    old.schedule.stageAuto = true;
    for (const s of [validateSettings(old, { partial: true }), importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old })]) {
      assert.equal(s.progression.mainline, true); assert.equal(s.progression.trials, false); assert.equal(s.pirateHunt.enabled, false);
      assert.equal(s.progression.maxFailures, 3); assert.equal(nativeTaskValues(s).stageAuto, true);
    }
    const s = defaultSettings();
    for (const bad of [0, -1, 1.5, 101]) { s.progression.maxFailures = bad; assert.throws(() => validateSettings(s)); }
    s.progression.maxFailures = 3; s.pirateHunt.enabled = true; assert.throws(() => validateSettings(s), /舰队/);
    assert(idleAutomationControls.some(c => c.key === 'progression.enabled' && c.configTarget === 'progression'));
    assert(idleAutomationControls.some(c => c.key === 'pirateHunt.enabled'));
  });
  await test('关闭挑战不开网络请求，保存配置本身不启动任务', async () => {
    const f = fixture(); await f.loop(2); assert.equal(f.writes.length, 0);
  });
  await test('主线与不同试炼共用五秒间隔，等待期间暂停不会发送', async () => {
    const f = fixture(), waits = [];
    Object.assign(f.settings.progression, { mainline: true, trials: true, raidIds: ['1','2'] });
    await f.once({ wait: async ms => { waits.push(ms); } });
    assert.equal(f.writes.length, 3); assert.equal(waits.length, 2);
    assert(waits.every(ms => ms > 0 && ms <= CHALLENGE_INTERVAL_MS));
    const g = fixture(); Object.assign(g.settings.progression, { mainline: true, trials: true, raidIds: ['1'] });
    await g.once({ wait: async () => { g.settings.progression.enabled = false; } });
    assert.equal(g.writes.length, 1);
    const controller = new AbortController(), dummy = {}; let time = 1000;
    await waitForChallenge(dummy, { now: () => time, beforeSend: () => { time += 7000; } });
    time += 1000;
    await assert.rejects(waitForChallenge(dummy, { signal: controller.signal, now: () => time, wait: async ms => { assert.equal(ms, 4000); controller.abort(); } }), /abort/i);
  });
  await test('服务器明确拒绝不记战败或未知结果，只在下一轮重新检查', async () => {
    for (const key of ['mainline', 'trials']) {
      const f = fixture(); f.settings.progression[key] = true; f.settings.progression.raidIds = ['1'];
      f.hook = name => { if (name.includes('Challenge') && f.writes.length === 1) throw Object.assign(new Error('server prompt: too frequent, retry later'), { prompt: { prompt: 1 }, request: name }); };
      await f.once();
      const state = key === 'mainline' ? f.state.mainline : f.state.trials[1];
      assert.equal(state.failures ?? 0, 0); assert(!state.halted); assert.equal(f.writes.length, 1);
      await f.once(); assert.equal(f.writes.length, 2); assert.equal(state.failures, 1);
    }
  });
  await test('主线每轮执行，三次战败后后续轮次不再发送且始终在队列内', async () => {
    const f = fixture(); f.settings.progression.mainline = true; f.requireQueue = true;
    await f.loop(6); assert.equal(f.writes.length, 3); assert.equal(f.state.mainline.failures, 3); assert.equal(f.state.mainline.halted, true);
  });
  await test('通关清零连败计数，下一关继续，无总挑战次数限制', async () => {
    const f = fixture(); f.settings.progression.mainline = true;
    f.won = () => f.writes.length === 2;
    for (let i = 0; i < 5; i++) await f.once();
    assert.deepEqual(f.writes.map(x => x.body.stage), [1,1,2,2,2]);
    assert.equal(f.state.mainline.wins, 1); assert.equal(f.state.mainline.failures, 3); assert(f.state.mainline.halted);
  });
  await test('所选试炼每轮挑战，按副本分别停止，不影响主线或其他副本', async () => {
    const f = fixture(); Object.assign(f.settings.progression, { mainline: true, trials: true, raidIds: ['1','2'], maxFailures: 2 });
    f.won = (name, body) => name === 'ChallengeStageRequest' || body.raidId === 2;
    await f.loop(4);
    assert.equal(f.writes.filter(x => x.name === 'ChallengeStageRequest').length, 4);
    assert.equal(f.writes.filter(x => x.body.raidId === 1).length, 2);
    assert.equal(f.writes.filter(x => x.body.raidId === 2).length, 4);
    assert(!f.writes.some(x => x.body.raidId === 3)); assert(f.state.trials[1].halted); assert(!f.state.trials[2].halted);
  });
  await test('跨重连保留战败计数，用户重新开始才重置', async () => {
    const f = fixture(); f.settings.progression.mainline = true; await f.loop(2);
    const next = fixture(); next.settings.progression.mainline = true;
    await next.loop(4, { challengeRun: f.state });
    assert.equal(next.writes.length, 1); assert(f.state.mainline.halted);
    await next.loop(1, { challengeRun: createChallengeRun() }); assert.equal(next.writes.length, 2);
  });
  await test('战报未知不记战败且阻止跨轮重发', async () => {
    for (const type of ['mainline', 'trials']) {
      const f = fixture(); f.settings.progression[type] = true; f.settings.progression.raidIds = ['1'];
      f.hook = name => { if (name.includes('Challenge')) throw new Error('模拟响应超时'); };
      await f.loop(3); assert.equal(f.writes.length, 1);
      const progress = type === 'mainline' ? f.state.mainline : f.state.trials[1];
      assert.equal(progress.failures ?? 0, 0); assert(progress.halted); assert.match(progress.reason, /未确认/);
    }
  });
  await test('排队期间暂停、读取后关闭及手动任务占用均不再自动发送', async () => {
    const f = fixture(), stop = { aborted: false }; f.settings.progression.mainline = true;
    await f.loop(1, { stop, schedule: async work => { stop.aborted = true; return work(); } }); assert.equal(f.writes.length, 0);
    const g = fixture(); g.settings.progression.trials = true; g.settings.progression.raidIds = ['1'];
    g.hook = () => { g.settings.progression.enabled = false; };
    await g.once(); assert.equal(g.writes.length, 0);
    f.settings.progression.trials = true; await f.once({ isStageBusy: () => true, isTrialBusy: () => true }); assert.equal(f.writes.length, 0);
  });
  await test('海盗挂机关闭后保留挑战选择，发送前关闭也不出征', async () => {
    const f = pirateAdvanceFixture(), state = createChallengeRun(), l = ledger();
    f.settings.pirateHunt.enabled = true;
    const round = (prepareDispatch) => runChallengeRound(f.client, f.config, {
      player: f.player, getSettings: () => f.settings, state, ledger: l, prepareDispatch, mode: 'pirate',
    });
    await round();
    assert.equal(f.client.writes.length, 0);
    f.settings.pirate.enabled = true;
    await round(async () => { f.settings.pirate.enabled = false; });
    assert.equal(f.client.writes.length, 0);
    assert.equal(f.settings.pirateHunt.enabled, true);
    f.settings.pirate.enabled = true;
    await round();
    assert.equal(f.client.writes.length, 1);
  });
  await test('海盗跨轮确认首杀和三次战败上限，旧汽油预算不阻止推进', async () => {
    for (const mode of ['lose', 'win']) {
      const f = pirateAdvanceFixture({ mode }), state = createChallengeRun(), l = ledger();
      f.settings.pirate.enabled = true;
      Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3, fuelBudget: mode === 'win' ? 600 : 3000 });
      for (let i = 0; i < 7; i++) await runChallengeRound(f.client, f.config, { player: f.player, getSettings: () => f.settings, state, ledger: l });
      assert.equal(f.client.writes.length, 3);
      assert.equal(state.pirate.state.spent, 900);
      if (mode === 'lose') { assert.equal(state.pirate.state.failures, 3); assert(state.pirate.state.halted); }
    }
  });
  await test('海盗在途与未知结果跨轮不重派，停止不会强制召回', async () => {
    for (const mode of ['wait', 'unknown']) {
      const f = pirateAdvanceFixture({ mode }), state = createChallengeRun(), l = ledger();
      f.settings.pirate.enabled = true;
      Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3 });
      for (let i = 0; i < 4; i++) await runChallengeRound(f.client, f.config, { player: f.player, getSettings: () => f.settings, state, ledger: l });
      assert.equal(f.client.writes.length, 1); assert.equal(state.pirate.state.failures, 0);
    }
  });
  await test('调低海盗失败上限后立即停止，不因旧汽油字段变化继续派遣', async () => {
    const f = pirateAdvanceFixture({ mode: 'lose' }), state = createChallengeRun(), l = ledger();
    f.settings.pirate.enabled = true;
    Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3, fuelBudget: 300 });
    const round = () => runChallengeRound(f.client, f.config, { player: f.player, getSettings: () => f.settings, state, ledger: l });
    await round();
    assert.equal(f.client.writes.length, 1);
    Object.assign(f.settings.pirateHunt, { maxFailures: 1, fuelBudget: 3000 });
    await round(); assert(state.pirate.state.halted); assert.equal(f.client.writes.length, 1);
  });
  await test('海盗胜利清零连败，达到阈值后重启和改设置仍停，到北京时间零点再开一轮', async () => {
    const f = pirateAdvanceFixture(), state = createChallengeRun();
    const file = path.join(root, 'daily-hunt.json');
    let now = Date.UTC(2026, 10, 21, 15, 59, 59);
    const round = (run = state) => runChallengeRound(f.client, f.config, { player: f.player, state: run,
      getSettings: () => f.settings, ledger: createUsageLedger('role', { file, now: () => now }), mode: 'pirate' });
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.settings.pirateHunt.maxFailures = 2;
    for (const [mode, failures] of [['lose', 1], ['win', 0], ['lose', 1], ['lose', 2]]) {
      f.state.mode = mode;
      await round();
      assert.equal(state.pirate.state.failures, failures);
    }
    assert(state.pirate.state.halted);
    f.settings.pirateHunt.maxFailures = 10;
    await round();
    await round(createChallengeRun());
    assert.deepEqual(f.client.writes.map(write => write.body.uid), [201, 201, 202, 202]);
    now += 1000;
    await round();
    assert.equal(state.pirate.state.failures, 1);
    assert.equal(state.pirate.state.spent, 300);
    assert.equal(f.client.writes.length, 5);
  });
  await test('首杀成功后重建挂机和连接，从下一关继续，通关原因可以跨重启查看', async () => {
    const file = path.join(root, 'resume-hunt.json');
    const round = async level => {
      const f = pirateAdvanceFixture(), state = createChallengeRun();
      f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
      f.state.level = level;
      const ledger = createUsageLedger('role', {file});
      let report;
      await runChallengeRound(f.client, f.config, {player: f.player, state, ledger, mode: 'pirate',
        getSettings: () => f.settings, report: entry => { report = entry; }});
      assert.equal(ledger.snapshot().counters.pirateAutoRuns1001001, 1);
      return {progress: state.pirate.state, writes: f.client.writes.map(w => w.body.uid), report};
    };
    for (let level = 0; level < 3; level++) {
      const {progress, writes} = await round(level);
      assert.deepEqual(writes, [201 + level]);
      assert.equal(progress.wins, level + 1);
      assert.equal(progress.spent, 300 * (level + 1));
    }
    for (let i = 0; i < 2; i++) {
      const {progress, writes, report} = await round(3);
      assert.deepEqual(writes, []);
      assert.equal(progress.halted, true);
      assert.match(report.reason, /等级上限（3 级）/);
    }
  });
  await test('首笔派遣记账后立即退出，恢复时先确认旧战果，再派下一关', async () => {
    const file = path.join(root, 'before-reply.json'), crash = path.join(root, 'interrupted.json');
    const f = pirateAdvanceFixture({mode: 'unknown'});
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    const round = (f, file, state = createChallengeRun()) => runChallengeRound(f.client, f.config, {
      player: f.player, state, ledger: createUsageLedger('role', {file}), mode: 'pirate', getSettings: () => f.settings,
    });
    const send = f.client.sendWatch;
    f.client.sendWatch = async (...args) => {
      fs.copyFileSync(file, crash); // 此时已预留汽油，还没有收到发送结果。
      return send(...args);
    };
    await round(f, file);
    for (const saved of [file, crash]) {
      const fresh = pirateAdvanceFixture();
      fresh.settings.pirate.enabled = fresh.settings.pirateHunt.enabled = true;
      await round(fresh, saved);
      await round(fresh, saved);
      assert.deepEqual(fresh.client.writes, []);
      fresh.state.level = 1;
      const state = createChallengeRun();
      await round(fresh, saved, state);
      assert.deepEqual(fresh.client.writes.map(w => w.body.uid), [202]);
      assert.equal(state.pirate.state.wins, 2);
      assert.equal(state.pirate.state.spent, 600);
    }
  });
  await test('未知首杀满15分钟跳过该类，归队后释放占用，可打其他种类且次日可重试原目标', async () => {
    const f = pirateAdvanceFixture({mode:'unknown', types:[1,2]});
    let serverNow = Date.UTC(2026,10,23,4);
    const l = createUsageLedger('role', {file:path.join(root,'timeout-types.json'), now:()=>serverNow});
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    const round = async () => {
      f.client.serverClockOffsetMs = serverNow - Date.now();
      const state = createChallengeRun();
      await runChallengeRound(f.client, f.config, {player:f.player, state, ledger:l, mode:'pirate', getSettings:()=>f.settings});
      return state.pirate.state;
    };
    await round();
    const key='pirate-first:1001001:1:1:201', first=l.keyRecords()[key];
    serverNow += 14*60000;
    await round();
    assert.equal(l.pendingCounters().piratePetrol,300);
    assert.deepEqual(f.client.writes.map(w=>w.body.uid),[201]);
    serverNow += 61000;
    const skipped = await round();
    assert.match(skipped.reason,/先锋.*15分钟.*跳过/);
    assert.equal(skipped.failures,0);
    assert.equal(skipped.wins,0);
    const expired = l.keyRecords()[key];
    assert.equal(expired.details.outcome,'timedOut');
    assert.equal(expired.expired,true);
    assert.equal(expired.confirmed,false);
    assert.equal(l.pendingCounters().piratePetrol??0,0);
    assert.equal(l.confirmedCounters().piratePetrol??0,0);
    assert.equal(l.snapshot().counters.piratePetrol,300);
    f.state.mode='win';
    await round();
    assert.deepEqual(f.client.writes.map(w=>w.body.uid),[201,301]);
    serverNow += 86400000;
    await round();
    assert.deepEqual(f.client.writes.map(w=>w.body.uid),[201,301,201]);
    assert.notEqual(l.keyRecords()[key].id,first.id);
    assert.equal(l.keyRecords()[key].details.outcome,'won');
  });
  await test('超时仍在途时结束本类等待，舰队归队前保留占用', async () => {
    const f = pirateAdvanceFixture({mode:'wait'}), l = ledger();
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    const round = async () => {
      const state=createChallengeRun();
      await runChallengeRound(f.client, f.config, {player:f.player, state, ledger:l, mode:'pirate', getSettings:()=>f.settings});
      return state.pirate.state;
    };
    await round();
    const key='pirate-first:1001001:1:1:201';
    f.client.serverClockOffsetMs=16*60000;
    assert.match((await round()).reason,/15分钟.*跳过/);
    assert.equal((await round()).halted,true);
    assert.notEqual(l.keyRecords()[key].details.active,false);
    assert.equal(l.keyRecords()[key].expired,undefined);
    Object.assign(f.fleet,{state:1,curGridIdx:0,targetGridIdx:0});
    await round();
    assert.equal(l.keyRecords()[key].details.outcome,'timedOut');
    assert.equal(l.keyRecords()[key].details.active,false);
    assert.equal(f.client.writes.length,1);
  });
  await test('重启保留各类连败，重试被明确拒绝后仍能继续同一轮', async () => {
    const f = pirateAdvanceFixture({mode: 'lose', types: [1,2]}), l = ledger();
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.settings.pirateHunt.maxFailures = 2;
    const round = async () => {
      const state = createChallengeRun();
      await runChallengeRound(f.client, f.config, {player: f.player, state, ledger: l, mode: 'pirate', getSettings: () => f.settings});
      return state.pirate.state;
    };
    assert.equal((await round()).failures, 1);
    const send = f.client.sendWatch;
    f.client.sendWatch = async name => { throw Object.assign(Error('明确拒绝'), {prompt: true, request: name}); };
    assert.match((await round()).reason, /明确拒绝/);
    f.client.sendWatch = send;
    assert.deepEqual((await round()).failedTypes, [1]);
    assert.equal((await round()).failures, 1);
    assert.deepEqual((await round()).failedTypes, [1,2]);
    f.settings.pirateHunt.maxFailures = 5;
    assert.match((await round()).reason, /连续战败 2 次/);
    assert.deepEqual(f.client.writes.map(w => w.body.uid), [201,201,301,301]);
    assert.equal(l.snapshot().counters.piratePetrol, 1200);
  });
  await test('两次挂机检查之间收到的战败也保留当时的停止上限', async () => {
    const f = pirateAdvanceFixture({mode: 'wait'}), l = ledger();
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    const round = async () => {
      const state = createChallengeRun();
      await runChallengeRound(f.client, f.config, {player: f.player, state, ledger: l, mode: 'pirate', getSettings: () => f.settings});
      return state.pirate.state;
    };
    await round();
    Object.assign(f.fleet, {state: 3, curGridIdx: 401});
    f.client.emit('message', {name: 'SCMyFleetUpdate', body: {fleets: [f.fleet]}});
    f.client.emit('message', {name: 'SCPirateCampaignEnd', body: {uid: 201, isWin: false}});
    Object.assign(f.fleet, {state: 1, curGridIdx: 0, targetGridIdx: 0});
    f.settings.pirateHunt.maxFailures = 3;
    const progress = await round();
    assert.equal(progress.halted, true);
    assert.equal(progress.failures, 1);
    assert.equal(f.client.writes.length, 1);
  });
  await test('升级前只有当日计数时说明原因，北京时间换日后正常推关', async () => {
    let now = Date.UTC(2026, 10, 21, 15, 59, 59);
    const f = pirateAdvanceFixture(), l = createUsageLedger('role', {file: path.join(root, 'legacy-hunt.json'), now: () => now});
    l.confirm(l.reserve({pirateAutoRuns1001001: 1, piratePetrol: 300}));
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    let report;
    const round = () => runChallengeRound(f.client, f.config, {player: f.player, state: createChallengeRun(), ledger: l,
      mode: 'pirate', getSettings: () => f.settings, report: entry => { report = entry; }});
    await round();
    assert.match(report.reason, /旧版.*未记录推进进度/);
    assert.deepEqual(f.client.writes, []);
    now += 1000;
    await round();
    assert.equal(f.client.writes.length, 1);
  });
  await test('海盗每日首轮在出征时占用，舰队未就绪或明确拒绝后仍能开始，跨日未知派遣不重发', async () => {
    const f = pirateAdvanceFixture({ mode: 'unknown' }), state = createChallengeRun();
    let now = Date.UTC(2026, 10, 21, 15, 59, 59);
    const l = createUsageLedger('role', { file: path.join(root, 'unknown-hunt.json'), now: () => now });
    const round = (run = state, prepareDispatch) => runChallengeRound(f.client, f.config, { player: f.player, state: run,
      getSettings: () => f.settings, ledger: l, mode: 'pirate', prepareDispatch });
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.fleet.durability = 0;
    await round();
    assert.deepEqual(l.snapshot().counters, {});
    f.fleet.durability = 1000;
    const send = f.client.sendWatch;
    f.client.sendWatch = async name => { throw Object.assign(Error('明确拒绝'), { prompt: true, request: name }); };
    await round();
    assert.equal(l.snapshot().uncertain, 0);
    f.client.sendWatch = send;
    let checks = 0;
    await round(state, async () => { if (++checks === 2) now += 1000; });
    assert.equal(f.client.writes.length, 0);
    await round(createChallengeRun());
    assert.equal(f.client.writes.length, 1);
    await round(createChallengeRun());
    now += 86400000;
    await round();
    assert.equal(f.client.writes.length, 1);
    assert.equal(l.pendingCounters().piratePetrol, 300);
    f.state.level = 1;
    await round();
    assert.deepEqual(f.client.writes.map(write => write.body.uid), [201, 202]);
  });
  await test('自动首杀按种类顺序推进，当前种类暂缺目标时等待刷新', async () => {
    const f = pirateAdvanceFixture({ types: [3, 1, 2] }), state = createChallengeRun(), l = ledger(), reports = [];
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.settings.pirateHunt.types = ['3']; // 旧配置也不能跳过先锋和精锐。
    f.config.tables['1_SeasonTaskCfg'].data[0].maxPirateLevel = 1;
    const all = f.state.pirates;
    f.state.pirates = all.filter(p => p.type !== 2);
    const round = () => runChallengeRound(f.client, f.config, { player: f.player, state,
      getSettings: () => f.settings, ledger: l, mode: 'pirate', report: entry => reports.push(entry) });
    await round();
    await round();
    assert.equal(f.client.writes.length, 1);
    assert(!state.pirate.state.halted);
    assert.match(reports.at(-1).reason, /等待.*海盗精锐/);
    f.state.pirates = all;
    await round();
    await round();
    await round();
    assert(state.pirate.state.halted);
    assert.match(reports.at(-1).reason, /等级上限（1 级）/);
    f.config.tables['1_SeasonTaskCfg'].data[0].maxPirateLevel = 3;
    await round();
    assert.deepEqual(f.client.writes.map(write => write.body.uid), [201,301,401]);
  });
  await test('三类海盗各自连败三次才结束当天首杀，调高阈值不会重开已停止的种类', async () => {
    const f = pirateAdvanceFixture({ types: [3,2,1], mode: 'lose' }), state = createChallengeRun(), l = ledger();
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.settings.pirateHunt.maxFailures = 3;
    const round = () => runChallengeRound(f.client, f.config, { player: f.player, state, getSettings: () => f.settings, ledger: l, mode: 'pirate' });
    for (let index = 0; index < 9; index++) {
      f.settings.pirateHunt.maxFailures = index === 3 ? 4 : 3;
      await round();
      assert.equal(state.pirate.state.failures, index % 3 + 1);
      assert.equal(Boolean(state.pirate.state.halted), index === 8);
    }
    await round();
    assert.deepEqual(f.client.writes.map(write => write.body.uid), [201,201,201,301,301,301,401,401,401]);
  });
  await test('先锋到顶、精锐战胜后连败、头目到顶可以在同一轮完成', async () => {
    const f = pirateAdvanceFixture({ types: [1,2,3] }), state = createChallengeRun(), l = ledger();
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.settings.pirateHunt.maxFailures = 2;
    f.state.level = 1;
    f.config.tables['1_SeasonTaskCfg'].data[0].maxPirateLevel = 2;
    const round = () => runChallengeRound(f.client, f.config, { player: f.player, state, getSettings: () => f.settings, ledger: l, mode: 'pirate' });
    for (const mode of ['win','lose','win','lose','lose','win','win']) {
      f.state.mode = mode;
      await round();
    }
    await round();
    assert.deepEqual(f.client.writes.map(write => write.body.uid), [202,301,301,302,302,401,402]);
    assert(state.pirate.state.halted);
    assert.deepEqual(state.pirate.state.failedTypes, [2]);
  });
  await test('首次检查已到顶时只读取赛季和首杀记录，开放新等级后仍可用当天首轮', async () => {
    const f = pirateAdvanceFixture(), state = createChallengeRun(), l = ledger();
    f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
    f.settings.pirateHunt.maxLevel = 1; // 旧页面遗留的值也不能拦截新开放的等级。
    f.config.tables['1_SeasonTaskCfg'].data[0].maxPirateLevel = f.state.level = 1;
    const round = () => runChallengeRound(f.client, f.config, { player: f.player, state,
      getSettings: () => f.settings, ledger: l, mode: 'pirate' });
    await round();
    assert.deepEqual(f.state.reads, ['SeasonTaskStageRequest', 'PirateKillRecordRequest']);
    assert.deepEqual(l.snapshot().counters, {});
    f.config.tables['1_SeasonTaskCfg'].data[0].maxPirateLevel = 2;
    await round();
    assert.deepEqual(f.client.writes.map(write => write.body.uid), [202]);
  });
  await test('首杀到顶或连败停止后，挂机仍扫荡所选种类的最高已首杀等级', async () => {
    for (const stop of ['到顶', '连败']) {
      const f = pirateAdvanceFixture({ types: [1, 2, 3] }), state = createChallengeRun(), l = ledger();
      f.settings.pirate.enabled = f.settings.pirateHunt.enabled = f.settings.schedule.pirate = true;
      Object.assign(f.settings.pirateSweep,{types:['3'],times3:-1});
      f.state.levels[3] = 1;
      f.config.tables['1_SeasonTaskCfg'].data[0].maxPirateLevel = stop === '到顶' ? 1 : 3;
      f.player.vip = { vipLevel: 0 };
      f.config.tables.PirateParamCfg = { data: [{ paramName: '每日野怪扫荡次数', paramValue: 2 }] };
      f.config.tables.VipLevelCfg = { data: [{ level: 0, effects: [] }] };
      let sweeps = 0;
      const request = f.client.request;
      f.client.request = async (name, body, response) => {
        if (name === 'PirateSweepRequest') {
          assert.equal(body.uid, 401);
          sweeps++;
          return { reward: { asset: [{ id: '木材', num: 1 }] } };
        }
        if (name === 'MonthCardRequest') return { cardItem: [] };
        const data = await request(name, body, response);
        if (name === 'AllPirateRequest') data.sweepTimes = sweeps;
        return data;
      };
      const round = () => runChallengeRound(f.client, f.config, { player: f.player, state,
        getSettings: () => f.settings, ledger: l, mode: 'pirate' });
      f.state.mode = stop === '到顶' ? 'win' : 'lose';
      for (let i = 0; i < 3; i++) await round();
      assert(state.pirate.state.halted);
      assert.deepEqual(f.client.writes.map(write => write.body.uid), stop === '到顶' ? [201, 301] : [201, 301, 402]);
      const battles = f.client.writes.length;
      await runLoop(f.client, protocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
        getSettings: () => f.settings, isEnabled: key => key === 'pirate', usageLedger: l, challengeRun: state });
      assert.equal(sweeps, 2);
      assert.equal(f.client.writes.length, battles);
    }
  });
  await test('海盗自动派遣进入挂机串行队列，每轮最多一次，不需手动启动', async () => {
    const f = pirateAdvanceFixture(), state = createChallengeRun(), l = ledger(), perRound = [];
    f.settings.pirate.enabled = true;
    Object.assign(f.settings.pirateHunt, { enabled: true, maxFailures: 3 });
    f.settings.loop.world = f.settings.loop.dailies = f.settings.loop.tasks = f.settings.loop.heroes = false;
    let queued = false;
    const request = f.client.request, send = f.client.sendWatch;
    f.client.request = (...args) => { assert(queued); return request(...args); };
    f.client.sendWatch = (...args) => { assert(queued); return send(...args); };
    await runLoop(f.client, protocol, { config: f.config, player: f.player, rounds: 4, allowMutate: true,
      getSettings: () => f.settings, isEnabled: () => false, usageLedger: l, challengeRun: state, everyMs: 1, sleep: async () => {},
      schedule: async work => { assert(!queued); queued = true; try { return await work(); } finally { queued = false; } },
      onRound: () => perRound.push(f.client.writes.length) });
    assert.deepEqual(perRound, [1,2,3,3]); assert.equal(state.pirate.state.wins, 3);
  });
  await test('隔离控制台按账号保存统一配置，未启动时无游戏连接', async () => {
    process.env.CW_CONFIG_PACK = path.join(root, 'config.json');
    const tables = { ...pirateAdvanceFixture({ types: [1,2,3] }).config.tables, ...fixture().config.tables, BuildingUnlockCfg: { data: [{ buildingType: '远征船', buildingId: '1远征船' }] } };
    fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(tables).map(([name, table], index) => [index, name, table])));
    fs.writeFileSync(path.join(process.env.CW_DATA_DIR, 'accounts.json'), JSON.stringify({ version: 1, activeId: 'a', accounts: ['a','b'].map(id => ({ id, label: '模拟账号' + id, url: 'ws://127.0.0.1:1', login: {}, automation: { paused: true } })) }));
    const { createConsole } = await import('../src/server.mjs'); const app = createConsole({ port: 0 });
    try {
      const url = await app.listen();
      const a = await (await fetch(url + '/api/settings?account=a')).json();
      a.settings.progression.maxFailures = 7;
      const saved = await fetch(url + '/api/settings?account=a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: a.settings, revision: a.revision, baseRevision: a.baseRevision }) });
      assert.equal(saved.status, 200, await saved.text());
      assert.equal((await (await fetch(url + '/api/settings?account=a')).json()).settings.progression.maxFailures, 7);
      assert.equal((await (await fetch(url + '/api/settings?account=b')).json()).settings.progression.maxFailures, 3);
      assert(!Object.hasOwn(await (await fetch(url + '/api/stages?account=a')).json(), 'configuredMaxFailures'));
      assert(!app.sessions.get('a').client); assert(!app.sessions.get('b').client);
      const session = app.sessions.get('a'), checkedAt = Math.floor(Date.now() / 1000);
      session.loop.controlStatus = new Map(['stageAuto', 'trialAuto:1', 'pirateAuto'].map(key => [key, { text: key + ' 已检查', state: 'waiting', checkedAt }]));
      const loop = await (await fetch(url + '/api/loop?account=a')).json();
      for (const [key, task] of [['progression.mainline','stageAuto'], ['progression.trials','trialAuto:1'], ['pirateHunt.enabled','pirateAuto']]) {
        assert.equal(loop.controls.find(control => control.key === key).observation.text, task + ' 已检查');
      }
      const page = await (await fetch(url)).text();
      const settingsResponse = await (await fetch(url + '/api/settings?account=a')).json();
      for (const [key, target] of [['progression.enabled', 'progression'], ['pirateHunt.enabled', 'pirate-hunt']]) {
        assert(settingsResponse.rules.moduleControls.some(control => control.key === key && control.configTarget === target));
      }
      assert(page.includes('失败停止次数')); assert(!page.includes('>次数</label>'));
      const stageHtml = page.slice(page.indexOf('id="tab-stages"'), page.indexOf('id="tab-stages"') + 18000);
      assert.match(stageHtml, /<input[^>]*id="stage-failures"/);
      assert(stageHtml.includes('id="pirate-advance-start"'));
      assert(!page.includes('id="tab-idle"'));
      for (const [, script] of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
  await test('手动主线和试炼使用本次参数，不继承或修改挂机失败上限', async () => {
    const f = fixture(); f.client.stop = () => { f.client.connected = false; };
    const { createConsole } = await import('../src/server.mjs'), app = createConsole({ port: 0 });
    try {
      const url = await app.listen(); await fetch(url + '/api/settings?account=a');
      const session = app.sessions.get('a');
      Object.assign(session, { client: f.client, player: f.player, paused: false });
      session.loop.tasks.afk = false;
      const post = async (route, payload) => {
        const response = await fetch(url + route + '?account=a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, ...payload }) });
        const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
      };
      for (const [route, payload] of [['/api/stages', {}], ['/api/trials', { raidId: 1 }]]) {
        for (const maxFailures of [undefined, 1]) {
          const started = await post(route + '/start', { ...payload, ...(maxFailures ? { maxFailures } : {}) });
          assert.equal(started.maxFailures, maxFailures ?? 3);
          await post(route + '/stop', payload);
          const task = route.endsWith('stages') ? session.stages : session.trials.get(1);
          for (let i = 0; task.view().running && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(task.view().running, false);
        }
      }
      assert.equal(session.loop.running, false);
      const settings = await (await fetch(url + '/api/settings?account=a')).json();
      assert.equal(settings.settings.progression.maxFailures, 7);
      assert.equal(settings.settings.progression.mainline, false);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
  await test('手动海盗失败上限独立，默认一次战败停止，显式参数可覆盖', async () => {
    for (const limit of [undefined, 2]) {
      const f = pirateAdvanceFixture({ mode: 'lose' }), task = createPirateAdvanceTask();
      Object.assign(f.settings.pirateHunt, { maxFailures: 7, fleetIds: [], minDurabilityPercent: 90 });
      f.fleet.durability = 20;
      const manual = { fleetIds: [f.fleet.buildingId], types: ['1'], checkEverySeconds: 15 };
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const state = task.start(manual, async () => ({ client: f.client, config: f.config, player: f.player,
        ledger: ledger(), getSettings: () => f.settings, enabled: () => true, sleep: async () => { f.settings.pirateHunt.enabled = !f.settings.pirateHunt.enabled; } }), s => { if (!s.running) finish(s); }, limit);
      assert.equal(state.maxFailures, limit ?? 1);
      const result = await done; assert.equal(result.failures, limit ?? 1); assert.equal(f.client.writes.length, limit ?? 1);
      assert.equal(f.settings.pirateHunt.maxFailures, 7);
    }
  });
  await test('海盗手动预设只改所选舰队，连续逐级出征、取消和返航恢复', async () => {
    for (const mode of ['single', 'continuous', 'moved', 'refused', 'unknown', 'empty']) {
      const f = pirateAdvanceFixture({ mode: mode === 'unknown' ? 'unknown' : 'win' }), l = ledger();
      f.fleet.autoFight.isOn = false;
      if (mode === 'empty') f.building.fleet.formation.heroPositions = [];
      const original = structuredClone(f.building.fleet.formation);
      const formation = { presetId: 1, heroPositions: [{ heroId: '瑞文', pos: { x: 2, y: 1 } }] };
      const preset = { id: 'manual', name: '海盗编队', formation: { ...formation, petUid: '123' } };
      const choices = await pirateHuntOptions(f.client, f.config, f.player, true);
      const firstSelection = { targetKey: choices.targets[0].targetKey, fleetKey: choices.fleets[0].key };
      const send = f.client.sendWatch, dispatches = [];
      f.client.sendWatch = async (name, body, opts) => {
        if (name === 'ChallengePirateRequest') {
          assert.deepEqual(body.fleetBuildingIds, [f.fleet.buildingId]);
          assert.deepEqual(f.building.fleet.formation, formation);
          const record = Object.values(l.keyRecords()).find(row => row.details?.kind === 'pirateLineup');
          assert.equal(record.details.phase, 'dispatched');
          assert.equal(record.details.dispatchId, l.keyRecords()[record.details.dispatchKey].id);
          dispatches.push(body.uid);
          if (mode === 'refused') throw Object.assign(Error('派遣被拒绝'), { prompt: true, request: name });
        }
        await send(name, body, opts);
        if (name === 'FleetSaveFormationRequest' && mode === 'moved') f.state.level = 1;
      };
      const context = { ...f, ledger: l, getSettings: () => f.settings, enabled: () => true, preset };
      if (mode === 'continuous') {
        const result = await runPirateAdvance({ ...context, options: { fleetIds: [f.fleet.buildingId], types: ['1'], checkEverySeconds: 5 },
          optionsCurrent: () => true, firstSelection, sleep: async () => {} });
        assert.equal(result.wins, 3);
        assert.deepEqual(dispatches, [201, 202, 203]);
      } else {
        const single = () => runSinglePirateHunt(f.client, f.config, f.player, { ...context, ...firstSelection });
        if (mode === 'moved' || mode === 'refused') {
          await assert.rejects(single(), mode === 'moved' ? /已变化/ : /被拒绝/);
          assert.equal(f.state.fuel, 3000);
          assert.equal(dispatches.length, mode === 'refused' ? 1 : 0);
          assert.deepEqual(l.keyRecords(), {});
        } else {
          assert.equal((await single()).status, mode === 'unknown' ? 'unknown' : 'won');
          assert.deepEqual(dispatches, [201]);
          if (mode === 'unknown') {
            assert.equal((await recoverFleetLineups(f.client, f.player, l)).pending.length, 1);
            assert.deepEqual(f.building.fleet.formation, formation);
            continue;
          }
          f.fleet.state = 4;
          assert.equal((await recoverFleetLineups(f.client, f.player, l)).pending.length, 1);
          f.fleet.state = 1;
          assert.equal((await recoverFleetLineups(f.client, f.player, l)).restored.length, 1);
        }
      }
      assert.deepEqual(f.building.fleet.formation, original, mode);
    }
  });
  await test('海盗预览忽略累计汽油用量，沿用自动挂机停止状态且不发送派遣', async () => {
    const f = pirateAdvanceFixture({ mode: 'lose', types: [1,2,3] });
    f.client.stop = () => { f.client.connected = false; };
    const { createConsole } = await import('../src/server.mjs'), app = createConsole({ port: 0 });
    try {
      const url = await app.listen();
      await fetch(url + '/api/settings?account=b');
      const session = app.sessions.get('b');
      Object.assign(session, { client: f.client, player: f.player, paused: false });
      session.loop.running = true;
      session.loop.challengeRun = createChallengeRun();
      const preview = async () => {
        const response = await fetch(url + '/api/settings/preview?account=b', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: f.settings, category: 'pirateHunt' }) });
        const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
      };
      const off = await preview(); assert.equal(off.actions.length, 0); assert.match(off.notes.join(' '), /海盗挂机已关闭/);
      f.settings.pirate.enabled = true;
      const huntOff = await preview(); assert.equal(huntOff.actions.length, 0); assert.match(huntOff.notes.join(' '), /自动挑战下一级/);
      f.settings.pirateHunt.enabled = true;
      f.settings.pirateHunt.maxFailures = 2;
      assert.equal((await preview()).actions.length, 1);
      const round = () => runChallengeRound(f.client, f.config, { player: f.player, mode: 'pirate',
        state: session.loop.challengeRun, ledger: createUsageLedger('b'), getSettings: () => f.settings });
      await round();
      session.loop.challengeRun.pirate.state.spent = 1000000;
      assert.match((await preview()).actions[0].label, /海盗先锋/);
      f.settings.pirateHunt.maxFailures = 1;
      assert.match((await preview()).actions[0].label, /海盗精锐/);
      f.settings.pirateHunt.maxFailures = 2;
      assert.match((await preview()).actions[0].label, /海盗先锋/);
      await round();
      assert.match((await preview()).actions[0].label, /海盗精锐/);
      await round();
      await round();
      assert.match((await preview()).actions[0].label, /海盗头目/);
      await round();
      await round();
      const halted = await preview(); assert.equal(halted.actions.length, 0); assert.match(halted.notes.join(' '), /失败停止次数/);
      session.loop.running = false;
      const stopped = await preview();
      assert.equal(stopped.actions.length, 0);
      assert.match(stopped.notes.join(' '), /失败停止次数/);
      f.client.serverClockOffsetMs = 86400000;
      session.loop.running = true;
      assert.equal((await preview()).actions.length, 1);
      assert.equal(f.client.writes.length, 6);
    } finally { app.server.closeAllConnections(); await app.close(); }
  });
} finally {
  if (oldData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = oldData;
  if (oldPack === undefined) delete process.env.CW_CONFIG_PACK; else process.env.CW_CONFIG_PACK = oldPack;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('自动推关与讨伐专项 ' + count + '/' + count + ' 通过');
