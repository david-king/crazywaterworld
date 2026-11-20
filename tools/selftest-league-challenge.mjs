import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, defaultSettings, importAutomationSettings, SETTINGS_FORMAT } from '../src/automation-settings.mjs';
import { readLeagueChallenge, runLeagueChallenge } from '../src/league-challenge.mjs';
import { runLoop } from '../src/loop.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-league-challenge-'));
const noon = Date.parse('2026-11-20T12:00:00+08:00');
const reset = noon / 1000 + 43200;
const protocol = { LeagueFightRequest: true, LeagueFightResponse: true };
const player = { playerId: 4321, worldId: 9876, level: 25 };
const config = { tables: { ModuleOpenCfg: { data: [{ moduleId: '跨服积分赛', playerLevel: 25 }] },
  LeagueDanCfg: { data: [{ dan: 1, teamCount: 2 }] } } };
const largeId = { low: 1, high: 2097152, unsigned: false };
let sequence = 0;
function fixture() {
  const settings = defaultSettings();
  settings.schedule.leagueChallenge = true;
  const file = path.join(root, ++sequence + '.json');
  const state = { progress: 0, tickets: 3, rivals: [
    { playerId: player.playerId, nickname: '自己', power: 1, score: 9999 },
    { playerId: 15, nickname: '甲', power: 300, score: 900 },
    { playerId: largeId, nickname: '乙', power: 180, score: 700 },
  ], teams: [1, 2].map(index => ({ index, heroPositions: [{ heroId: '英雄' + index }] })), reads: 0, writes: [], enabled: true };
  const client = { connected: true, serverClockOffsetMs: noon - Date.now(), async request(name, body) {
    switch (name) {
      case 'DailyTaskInfoRequest': return { dailyResetTime: reset, dailyTask: [{ id: 1017, progress: state.progress, targetProgress: 1 }] };
      case 'LeagueInfoRequest': return { roomDan: 1, mine: { playerId: player.playerId, power: state.ownPower }, top10: [{}, {}], settleTime: reset + 86400, ownFormations: state.teams };
      case 'AllResourceRequest': return { list: [{ res: 6, amount: state.tickets }] };
      case 'LeagueRefreshRivalRequest':
        assert.deepEqual(body, { isRefresh: false });
        state.onList?.(++state.reads);
        return { rivals: state.rivals };
      case 'LeagueFightRequest':
        state.writes.push(body);
        if (state.error) throw state.error;
        return { lPlayer: { playerId: player.playerId, finalScore: 32 }, rPlayer: { playerId: body.playerId } };
      default: throw Error('意外请求 ' + name);
    }
  } };
  const options = { getSettings: () => settings, enabled: () => state.enabled, ledger: createUsageLedger('test', { file }) };
  return { settings, state, client, options, file,
    read: () => readLeagueChallenge(client, config, player, options.getSettings, { preview: true }),
    run: () => runLeagueChallenge(client, protocol, config, player, options) };
}

try {
  const old = defaultSettings();
  delete old.arena; delete old.league; delete old.schedule.leagueChallenge;
  old.schedule.arena = old.schedule.leaguePassRewards = true;
  const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 21, settings: old });
  assert.deepEqual(migrated.schedule, { ...old.schedule, leagueChallenge: false });
  assert.deepEqual(migrated.arena, { target: 'weakest', keepTickets: 0, maxPowerRatio: 0 });
  assert.deepEqual(migrated.league, migrated.arena);

  const previous = defaultSettings();
  delete previous.arena.maxPowerRatio;
  delete previous.league.maxPowerRatio;
  previous.league.target = 'score';
  previous.arena.keepTickets = 2;
  const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 22, settings: previous });
  assert.deepEqual(upgraded.league, { ...previous.league, maxPowerRatio: 0 });
  assert.deepEqual(upgraded.arena, { ...previous.arena, maxPowerRatio: 0 });

  const capped = fixture();
  Object.assign(capped.settings.league, { target: 'score', maxPowerRatio: 90 });
  capped.state.ownPower = { low: 200, high: 0 };
  assert.equal((await capped.read()).target.id, '9007199254740993', '高分对手超限，次选对手恰好等于上限');
  capped.settings.league.maxPowerRatio = 150;
  assert.equal((await capped.read()).target.id, '15', '可自定高于己方战力的阈值');
  capped.state.onList = n => { if (n === 2) capped.settings.league.maxPowerRatio = 89; };
  assert.match((await capped.run()).reason, /上限 178/);
  assert.deepEqual(capped.state.writes, []);
  assert.deepEqual(capped.options.ledger.keyRecords(), {});
  capped.state.ownPower = 0;
  assert.match((await capped.read()).reason, /己方战力/);

  const f = fixture();
  assert.equal((await f.read()).target.id, '9007199254740993');
  f.settings.league.target = 'score';
  assert.equal((await f.read()).target.id, '15');
  assert.deepEqual(f.state.writes, []);
  f.settings.league.target = 'weakest';
  assert((await f.run()).ok);
  assert.deepEqual(f.state.writes, [{ playerId: largeId }]);
  assert.match((await f.run()).reason, /已提交/);
  f.state.progress = 1;
  assert.match((await f.run()).reason, /已完成/);
  assert.deepEqual(f.options.ledger.keyRecords(), {});

  for (const change of [
    f => { f.state.teams.pop(); },
    f => { f.client.serverClockOffsetMs -= 7 * 3600000; },
    f => { f.settings.league.keepTickets = f.state.tickets; },
    f => { f.state.onList = n => { if (n === 2) f.settings.league.keepTickets = 3; }; },
    f => { f.state.onList = n => { if (n === 2) f.state.enabled = false; }; },
    f => { f.state.onList = n => { if (n === 2) f.state.rivals.pop(); }; },
  ]) {
    const blocked = fixture(); change(blocked);
    assert((await blocked.run()).skipped);
    assert.deepEqual(blocked.state.writes, []);
    assert.deepEqual(blocked.options.ledger.keyRecords(), {});
  }
  const lost = fixture();
  lost.state.error = Error('模拟超时');
  await assert.rejects(lost.run, /超时/);
  lost.options.ledger = createUsageLedger('test', { file: lost.file });
  lost.state.rivals.pop();
  assert.match((await lost.run()).reason, /已提交/);
  assert.equal(lost.state.writes.length, 1);

  const idle = fixture();
  await runLoop(idle.client, protocol, { config, player, getSettings: idle.options.getSettings, usageLedger: idle.options.ledger,
    isEnabled: key => key === 'leagueChallenge', rounds: 1, allowMutate: true });
  assert.deepEqual(idle.state.writes, [{ playerId: largeId }], '只开积分赛即可完成每日挑战');
  console.log('积分赛挑战通过：旧配置迁移、选人、预览、留券、开放时段、编队、暂停、回包丢失与整轮调度');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
