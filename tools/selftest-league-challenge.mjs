import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, defaultSettings, importAutomationSettings, SETTINGS_FORMAT, validateSettings } from '../src/automation-settings.mjs';
import { readLeagueChallenge, runLeagueChallenge } from '../src/league-challenge.mjs';
import { bestLeagueOrder, recoverLeagueOrder } from '../src/league-order.mjs';
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
  const state = { progress: 0, tickets: 3, refreshTimes: 1, refreshes: 0, rivals: [
    { playerId: player.playerId, nickname: '自己', power: 1, score: 9999 },
    { playerId: 15, nickname: '甲', power: 300, score: 900 },
    { playerId: largeId, nickname: '乙', power: 180, score: 700 },
  ], teams: [1, 2].map(index => ({ index, presetId: 1, heroPositions: [{ heroId: '英雄' + index, pos: { x: 1, y: 1 } }] })), reads: 0, writes: [], enabled: true };
  const client = { connected: true, serverClockOffsetMs: noon - Date.now(), async request(name, body) {
    switch (name) {
      case 'DailyTaskInfoRequest': return { dailyResetTime: state.reset ?? reset, dailyTask: [{ id: 1017, progress: state.progress, targetProgress: 1 }] };
      case 'LeagueReportListRequest': return { reports: state.reports ?? [] };
      case 'LeagueInfoRequest': return { roomDan: 1, mine: { playerId: player.playerId, power: state.ownPower }, top10: [{}, {}], settleTime: reset + 2 * 86400, ownFormations: state.teams };
      case 'AllHeroRequest': return { heroes: [1, 2].map(index => ({ heroId: '英雄' + index, power: 100 })) };
      case 'LeagueOtherFormationRequest': {
        const row = state.rivals.find(rival => (rival.playerId.low ?? rival.playerId) === body.playerId.low);
        return { formation: [Math.ceil(row.power / 2), Math.floor(row.power / 2)].map(power => ({ power })) };
      }
      case 'AllResourceRequest': return { list: [{ res: 6, amount: state.tickets }] };
      case 'LeagueRefreshRivalRequest':
        if (body.isRefresh) {
          assert.ok(Number.isSafeInteger(state.refreshTimes) && state.refreshTimes >= 0 && state.refreshTimes <= 1, '禁止使用付费刷新');
          state.refreshTimes++;
          state.refreshes++;
          state.onRefresh?.(state.refreshes);
        } else {
          assert.deepEqual(body, { isRefresh: false });
          state.onList?.(++state.reads);
        }
        return { rivals: state.rivals, refreshTimes: state.refreshTimes };
      case 'LeagueFightRequest':
        state.writes.push(body);
        if (state.error) throw state.error;
        return { lPlayer: { playerId: player.playerId, finalScore: 32 }, rPlayer: { playerId: body.playerId } };
      default: throw Error('意外请求 ' + name);
    }
  } };
  const options = { getSettings: () => settings, enabled: () => state.enabled, ledger: createUsageLedger('test', { file }) };
  return { settings, state, client, options, file,
    read: () => readLeagueChallenge(client, config, player, options.getSettings, { preview: true, ledger: options.ledger }),
    run: () => runLeagueChallenge(client, protocol, config, player, options) };
}

try {
  const old = defaultSettings();
  delete old.arena; delete old.league; delete old.schedule.leagueChallenge;
  old.schedule.arena = old.schedule.leaguePassRewards = true;
  const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 21, settings: old });
  assert.deepEqual(migrated.schedule, { ...old.schedule, leagueChallenge: false });
  assert.deepEqual(migrated.arena, { ...defaultSettings().arena, challengeHigher: true });
  assert.deepEqual(migrated.league, defaultSettings().league);

  const v29 = defaultSettings();
  v29.arena = { dailyBattleLimit: 3, maxPowerRatio: 0, target: 'weakest', claimTask: false };
  v29.league.target = 'weakest';
  assert.deepEqual(importAutomationSettings({ format: SETTINGS_FORMAT, version: 29, settings: v29 }), defaultSettings());
  assert.deepEqual(validateSettings(v29), defaultSettings(), '旧页面仍可保存');

  const previous = defaultSettings();
  previous.arena = { target: 'weakest' };
  delete previous.arena.maxPowerRatio;
  delete previous.league.maxPowerRatio;
  previous.league.target = 'score';
  previous.dailies.claimTasks = true;
  for (const group of ['arena', 'league']) {
    delete previous[group].dailyBattleLimit; delete previous[group].claimTask;
  }
  previous.league.keepTickets = 0; previous.arena.keepTickets = 2;
  const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 22, settings: previous });
  assert.deepEqual(upgraded.league, { ...defaultSettings().league, claimTask: true });
  assert.deepEqual(upgraded.arena, { ...defaultSettings().arena, challengeLimit: 0, claimTask: true });
  for (const [group, key] of [['arena', 'challengeLimit'], ['arena', 'sweepLimit'], ['league', 'dailyBattleLimit']]) for (const value of [-1, 1.5, '2']) {
    const invalid = defaultSettings();
    invalid[group][key] = value;
    assert.throws(() => validateSettings(invalid), error => !!error.fields?.[group + '.' + key]);
  }

  for (const target of ['weakest', 'score', 'matchWin', 'matchDraw']) {
    const legacy = defaultSettings();
    Object.assign(legacy.league, { target, fallbackWeakest: false, dailyBattleLimit: 4, maxPowerRatio: 80 });
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 45, settings: legacy });
    assert.deepEqual(migrated.league, { ...defaultSettings().league, dailyBattleLimit: 4, maxPowerRatio: 80 });
    assert.deepEqual(validateSettings(legacy).league, migrated.league);
  }
  const capped = fixture();
  capped.settings.league.maxPowerRatio = 90;
  capped.state.ownPower = { low: 200, high: 0 };
  assert.equal((await capped.read()).target.id, '9007199254740993', '恰好达到上限仍可挑战');
  capped.state.refreshTimes = 2;
  capped.settings.league.maxPowerRatio = 89;
  assert((await capped.run()).skipped);
  assert.deepEqual(capped.state.writes, []);
  capped.state.ownPower = 0;
  assert.match((await capped.read()).reason, /己方战力/);

  for (const count of [0, 1, 2, undefined, -1, '1']) {
    const f = fixture();
    f.state.refreshTimes = count;
    f.state.rivals = [];
    f.state.onRefresh = () => { f.state.rivals = [{ playerId: 33, power: 90, score: 4 }]; };
    const free = count === 0 || count === 1;
    const preview = await f.read();
    if (free) assert.match(preview.note, /免费刷新/);
    assert.equal(f.state.refreshes, 0, '预览只读');
    assert.equal(!!(await f.run()).ok, free);
    assert.equal(f.state.refreshes, Number(free));
    assert.equal(f.state.writes.length, Number(free));
  }
  const paused = fixture();
  paused.state.rivals = [];
  paused.state.onRefresh = () => { paused.state.enabled = false; };
  assert((await paused.run()).skipped);
  assert.deepEqual(paused.state.writes, []);
  const lostRefresh = fixture();
  lostRefresh.state.rivals = [];
  lostRefresh.state.onRefresh = () => { lostRefresh.state.refreshTimes = 1; throw Error('刷新回包超时'); };
  await assert.rejects(lostRefresh.run, /刷新回包超时/);
  lostRefresh.options.ledger = createUsageLedger('test', { file: lostRefresh.file });
  assert((await lostRefresh.run()).skipped);
  assert.equal(lostRefresh.state.refreshes, 1, '重连后不重复刷新');

  const f = fixture();
  assert.equal((await f.read()).target.id, '9007199254740993');
  assert.deepEqual(f.state.writes, []);
  assert((await f.run()).ok);
  assert.deepEqual(f.state.writes, [{ playerId: largeId }]);
  assert.match((await f.run()).reason, /每日战斗次数/);
  f.state.progress = 1;
  assert.match((await f.run()).reason, /每日战斗次数/);
  assert.deepEqual(f.options.ledger.keyRecords(), {});

  for (const change of [
    f => { f.state.teams.pop(); },
    f => { f.client.serverClockOffsetMs -= 7 * 3600000; },
    f => { f.settings.league.dailyBattleLimit = 0; },
    f => { f.state.tickets = 0; },
    f => { f.state.onList = n => { if (n === 2) f.settings.league.dailyBattleLimit = 0; }; },
    f => { f.state.onList = n => { if (n === 2) f.state.enabled = false; }; },
    f => { f.state.onList = n => { if (n === 2) f.state.rivals.pop(); }; },
  ]) {
    const blocked = fixture(); change(blocked);
    assert((await blocked.run()).skipped);
    assert.deepEqual(blocked.state.writes, []);
    assert.deepEqual(blocked.options.ledger.keyRecords(), {});
  }
  const extra = fixture();
  extra.settings.league.dailyBattleLimit = 4;
  extra.state.progress = 1;
  // Two manual attacks today. Yesterday's fight and a defence do not use today's quota.
  const fightTime = noon / 1000;
  extra.state.reports = [{ fightTime, isAttack: true }, { fightTime, isAttack: true },
    { fightTime, isAttack: false }, { fightTime: fightTime - 86400, isAttack: true }];
  assert.equal((await extra.read()).battles, 2);
  assert((await extra.run()).ok);
  extra.options.ledger = createUsageLedger('test', { file: extra.file });
  assert.equal((await extra.read()).battles, 3);
  assert((await extra.run()).ok);
  assert.match((await extra.run()).reason, /每日战斗次数/);
  assert.equal(extra.state.writes.length, 2);
  extra.state.reset = reset + 86400; extra.state.progress = 0;
  extra.client.serverClockOffsetMs += 86400000;
  assert((await extra.run()).ok, '次日按新的重置周期计数');
  const lost = fixture();
  lost.state.error = Error('模拟超时');
  await assert.rejects(lost.run, /超时/);
  lost.options.ledger = createUsageLedger('test', { file: lost.file });
  lost.state.rivals.pop();
  assert.match((await lost.run()).reason, /已提交/);
  assert.equal(lost.state.writes.length, 1);

  const lostAfterTask = fixture();
  lostAfterTask.settings.league.dailyBattleLimit = 2;
  lostAfterTask.state.progress = 1;
  lostAfterTask.state.error = Error('模拟超时');
  await assert.rejects(lostAfterTask.run, /超时/);
  lostAfterTask.options.ledger = createUsageLedger('test', { file: lostAfterTask.file });
  assert.match((await lostAfterTask.run()).reason, /已提交/);
  lostAfterTask.state.reports = [{ fightTime, isAttack: true }, { fightTime: fightTime + 1, isAttack: true }];
  assert.match((await lostAfterTask.run()).reason, /每日战斗次数/);
  assert.equal(lostAfterTask.state.writes.length, 1, '任务到顶后仍可按战报确认未知场次');

  function matchup(own, rivals) {
    const f = fixture(), { state, client, options } = f;
    const teams = own.map((power, i) => ({ index: i + 1, presetId: 1, petUid: String(i + 1),
      heroPositions: [{ heroId: 'h' + i, pos: { x: 1, y: 2 } }] }));
    state.teams = structuredClone(teams);
    state.rivals = rivals.map((powers, i) => ({ playerId: i + 10, power: powers.reduce((a, b) => a + b), score: 100 }));
    state.ownPower = own.reduce((a, b) => a + b);
    state.orders = [];
    const original = client.request.bind(client);
    client.request = async (name, body, reply) => {
      if (name === 'AllHeroRequest') return { heroes: own.map((power, i) => ({ heroId: 'h' + i, power })) };
      if (name === 'LeagueOtherFormationRequest') return { formation: rivals[body.playerId.low - 10].map(power => ({ power })) };
      if (name === 'LeagueFormationSequenceRequest') {
        state.orders.push(body.index);
        state.teams = body.index.map((index, i) => ({ ...state.teams[index - 1], index: i + 1 }));
        state.onOrder?.();
        return { formations: state.teams };
      }
      if (name === 'LeagueFightRequest') {
        state.writes.push(body);
        state.onFight?.();
        return { rPlayer: { playerId: player.playerId, score: 999, finalScore: 999 }, lPlayer: { playerId: body.playerId },
          records: own.map((_, i) => ({ isLWin: i === 1 })) };
      }
      return original(name, body, reply);
    };
    const cfg = { tables: { ...config.tables, LeagueDanCfg: { data: [{ dan: 1, teamCount: own.length }] } } };
    return { ...f, teams, run: () => runLeagueChallenge(client, protocol, cfg, player, options),
      preview: () => readLeagueChallenge(client, cfg, player, options.getSettings, { preview: true, ledger: options.ledger }) };
  }
  for (const [own, rival, order] of [
    [[100, 60], [50, 90], [2, 1]], [[100, 60, 80], [70, 90, 50], [3, 1, 2]],
  ]) {
    const battle = matchup(own, [rival]);
    assert.deepEqual((await battle.preview()).order, order);
    assert.deepEqual(battle.state.orders, []);
    assert.deepEqual(battle.state.writes, []);
    const report = await battle.run();
    assert(report.ok);
    assert.match(report.note, /实际 .* 胜 1 负，战后积分 999（0）/);
    assert.deepEqual(battle.state.orders, [order, battle.teams.map(team => order.indexOf(team.index) + 1)]);
    assert.deepEqual(battle.state.teams, battle.teams);
  }
  const draw = matchup([100, 60], [[110, 80]]);
  assert.match((await draw.run()).note, /实际 1 胜 1 负/);
  assert.equal(draw.state.refreshes, 1, '免费刷新后仍可争平');
  const winning = matchup([100, 60], [[110, 80], [50, 90]]);
  assert.equal((await winning.preview()).target.id, '11', '后面的两胜优于前面的平局');
  assert((await winning.run()).ok);
  assert.equal(winning.state.refreshes, 0);
  assert.equal(winning.state.writes[0].playerId.low, 11);
  const threeWins = matchup([100, 80, 60], [[110, 70, 50], [90, 70, 50]]);
  assert.equal((await threeWins.preview()).target.id, '11', '三胜优于两胜');
  const twoWins = matchup([100, 80, 60], [[110, 70, 50]]);
  assert((await twoWins.run()).ok);
  assert.equal(twoWins.state.refreshes, 0);
  const hold = matchup([100, 60], [[150, 110]]);
  assert((await hold.run()).skipped);
  assert.equal(hold.state.writes.length, 0);
  const cap = matchup([100, 60], [[110, 80]]);
  cap.settings.league.maxPowerRatio = 100;
  cap.state.refreshTimes = 0;
  assert((await cap.run()).skipped);
  assert.equal(cap.state.refreshTimes, 1, '智能排阵只免费刷新一次，同场次不重复刷新');
  assert.equal(cap.state.writes.length, 0, '争平也遵守总战力上限');
  assert((await cap.run()).skipped);
  assert.equal(cap.state.refreshTimes, 1);
  const unchanged = matchup([100, 60], [[50, 90], [90, 50]]);
  assert((await unchanged.run()).ok);
  assert.deepEqual(unchanged.state.orders, []);
  assert.equal(unchanged.state.writes[0].playerId.low, 11);
  assert.equal(bestLeagueOrder([60, 60], [60, 60]).wins, 0);
  const unreadable = matchup([100, 60], [[0, 0], [90, 50]]);
  assert.equal((await unreadable.preview()).target.id, '11');
  const threeLoss = matchup([100, 60, 80], [[110, 120, 70]]);
  assert((await threeLoss.run()).skipped);
  assert.equal(threeLoss.state.writes.length, 0);
  const pausedSwap = matchup([100, 60], [[50, 90]]);
  pausedSwap.state.onOrder = () => { pausedSwap.state.enabled = false; };
  await assert.rejects(pausedSwap.run, /取消挑战/);
  assert.deepEqual(pausedSwap.state.teams, pausedSwap.teams);
  assert.equal(pausedSwap.state.writes.length, 0);
  const conflict = matchup([100, 60], [[50, 90]]);
  conflict.state.onFight = () => { conflict.state.teams[0].petUid = '999'; };
  assert((await conflict.run()).ok);
  assert.equal(conflict.state.orders.length, 1, '保留玩家新改的防守阵容');
  const lostSwap = matchup([100, 60], [[50, 90]]);
  lostSwap.state.onOrder = () => { delete lostSwap.state.onOrder; throw Error('换位回包超时'); };
  await assert.rejects(lostSwap.run, /换位回包超时/);
  assert.deepEqual(lostSwap.state.teams, lostSwap.teams);
  assert.deepEqual(lostSwap.state.writes, []);
  const disconnected = matchup([100, 60], [[50, 90]]);
  disconnected.state.onFight = () => { disconnected.client.connected = false; throw Error('断线'); };
  await assert.rejects(disconnected.run);
  assert.equal(disconnected.state.orders.length, 1);
  disconnected.client.connected = true;
  disconnected.options.ledger = createUsageLedger('test', { file: disconnected.file });
  await recoverLeagueOrder(disconnected.client, player, disconnected.options.ledger);
  assert.deepEqual(disconnected.state.teams, disconnected.teams);
  assert((await disconnected.run()).skipped);
  assert.equal(disconnected.state.writes.length, 1, '未知战果不能重复扣券');
  const idle = fixture();
  await runLoop(idle.client, protocol, { config, player, getSettings: idle.options.getSettings, usageLedger: idle.options.ledger,
    isEnabled: key => key === 'leagueChallenge', rounds: 1, allowMutate: true });
  assert.deepEqual(idle.state.writes, [{ playerId: largeId }], '只开积分赛即可完成每日挑战');
  console.log('积分赛挑战通过：旧配置迁移、选人、预览、留券、开放时段、编队、暂停、回包丢失与整轮调度');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
