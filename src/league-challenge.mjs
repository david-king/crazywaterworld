import { toNumber } from './client.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { filterOpponentsByPower } from './opponent-power.mjs';
import { bestLeagueOrder, leagueFormationOrder, leagueTeamPowers, recoverLeagueOrder, rivalTeamPowers, withLeagueOrder } from './league-order.mjs';

const label = '积分赛每日挑战';
const serverNow = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const read = (client, name, body = {}) => client.request(name + 'Request', body, name + 'Response');
const quotaPrefix = player => 'league-fight:' + uidText(player?.worldId) + ':' + uidText(player?.playerId) + ':';
export const leagueChallengeKey = (player, state) => quotaPrefix(player) + state.reset + ':' + (state.battles ?? state.task.progress);
const limitReached = limit => '已达到积分赛每日战斗次数（' + limit + ' 次）';

function challengeReason(state, options, now) {
  const { task, reset, info, teams, tickets } = state;
  if (!task || !integer(task.progress) || !Number.isSafeInteger(task.targetProgress) || task.targetProgress < 1) return '尚未取得今日积分赛任务';
  if (state.battles >= options.dailyBattleLimit) return limitReached(options.dailyBattleLimit);
  if (!(reset > now && info.settleTime > now)) return '等待每日任务或积分赛结算更新';
  const second = (now + 8 * 3600) % 86400;
  if (second < 6 * 3600 || second > 86370) return '挑战开放时间为北京时间 06:00 至 23:59:30';
  if (!Number.isSafeInteger(teams) || teams < 1) return '尚未取得当前段位的编队要求';
  for (let index = 1; index <= teams; index++) {
    if (!info.ownFormations?.some(team => team.index === index && team.heroPositions?.length)) return '请先配置积分赛第 ' + index + ' 队';
  }
  if (!(info.top10?.length > 1)) return '当前分组参赛人数不足';
  if (!integer(tickets) || tickets < 1) return '积分赛挑战券不足或未能确认余额';
  return '';
}

async function selectLeagueRival(client, player, state, list, options) {
  if (!Array.isArray(list?.rivals)) return { reason: '尚未取得积分赛对手名单' };
  const candidates = list.rivals.map(row => ({ id: uidText(row.playerId), name: row.nickname,
    power: toNumber(row.power), score: toNumber(row.score) })).filter(row =>
    row.id && row.id !== state.selfId && integer(row.power) && row.power > 0 && integer(row.score));
  const filtered = filterOpponentsByPower(candidates, state.info.mine.power, options.maxPowerRatio);
  if (!filtered.candidates) return { reason: filtered.reason };
  const formation = leagueFormationOrder(state.info, state.teams, player);
  const powers = await leagueTeamPowers(client, formation.teams);
  let best;
  const seen = new Set();
  for (const target of filtered.candidates) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const rival = await rivalTeamPowers(client, target.id, state.teams);
    if (!rival) continue;
    const plan = bestLeagueOrder(powers, rival);
    const swaps = plan.order.filter((index, slot) => index !== slot + 1).length;
    if (!best || plan.wins > best.wins || (plan.wins === best.wins && swaps < best.swaps)) best = { ...plan, swaps, target };
    if (best.wins === state.teams && !best.swaps) break;
  }
  const times = list.refreshTimes;
  if ((!best || best.wins < 2) && state.lastRefreshTimes < 0 &&
      Object.hasOwn(list, 'refreshTimes') && integer(times) && times <= 1) {
    return { refreshTimes: times, note: '免费刷新后重新比较分队战力' };
  }
  if (!best || best.wins < Math.ceil(state.teams / 2)) return { reason: '当前名单没有可争胜或争平的对手，保留挑战券' };
  return { ...best, signature: formation.signature,
    note: '挑战' + (best.target.name || best.target.id) + '，出战顺序 ' + best.order.join(' → ') + '，预计 ' + best.wins + ' 路战力占优' };
}

async function readLeagueStatus(client, config, player, getSettings, { preview = false, ledger }) {
  const level = config?.tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '跨服积分赛')?.playerLevel;
  if (!Number.isSafeInteger(level) || level < 1) return { reason: '尚未取得积分赛开放等级' };
  if (!(player?.level >= level)) return { reason: '跨服积分赛在角色 ' + level + ' 级开放' };
  const daily = await read(client, 'DailyTaskInfo');
  const task = daily.dailyTask?.find(row => row.id === 1017);
  const state = { task, reset: daily.dailyResetTime, battles: task?.progress };
  const prefix = quotaPrefix(player);
  const today = Object.entries(ledger?.keyRecords() ?? {})
    .filter(([key, record]) => key.startsWith(prefix) && record.details?.reset === state.reset)
    .map(([, record]) => record);
  const fights = today.filter(record => record.details.refreshTimes === undefined);
  // The daily task can stop counting after its reward target. Confirmed fight slots
  // also survive reconnects and a rolling report list.
  for (const record of fights) if (record.confirmed) state.battles = Math.max(state.battles, record.details.progress + 1);
  const limit = getSettings().league.dailyBattleLimit;
  if (task && state.battles >= task.targetProgress && limit > state.battles && state.reset > serverNow(client)) {
    try {
      const { reports } = await read(client, 'LeagueReportList');
      if (!Array.isArray(reports) || reports.some(row => row.isAttack && !integer(row.fightTime))) throw Error('战报格式不完整');
      const attacks = reports.filter(row => row.isAttack && row.fightTime >= state.reset - 86400 && row.fightTime < state.reset);
      state.battles = Math.max(state.battles, attacks.length);
    } catch (error) {
      state.reason = '尚未取得积分赛今日进攻战报：' + error.message;
    }
  }
  if (fights.some(record => !record.confirmed && record.details.progress >= state.battles)) {
    state.reason = '本次挑战已提交，等待任务进度或战报更新';
  }
  if (!preview && state.battles >= limit) return { ...state, nextCheck: state.reset, reason: limitReached(limit) };
  if (!preview && !task) return { ...state, reason: '尚未取得今日积分赛任务' };
  if (!preview && state.reason) return state;
  const info = await read(client, 'LeagueInfo');
  const resources = await read(client, 'AllResource');
  state.info = info;
  state.teams = config.tables.LeagueDanCfg?.data?.find(row => row.dan === info.roomDan)?.teamCount;
  state.tickets = toNumber(resources.list?.find(row => row.res === 6)?.amount);
  state.selfId = uidText(info.mine?.playerId);
  if (!state.selfId || state.selfId !== uidText(player.playerId)) return { ...state, reason: '未能确认积分赛本人身份' };
  const reason = state.reason || challengeReason(state, getSettings().league, serverNow(client));
  if (reason) return { ...state, reason, nextCheck: state.battles >= getSettings().league.dailyBattleLimit ? state.reset : undefined };
  // A refresh with a lost reply may already have used this free slot.
  state.lastRefreshTimes = Math.max(-1, ...today.filter(record => record.details.progress === state.battles &&
    integer(record.details.refreshTimes)).map(record => record.details.refreshTimes));
  return state;
}

export async function readLeagueChallenge(client, config, player, getSettings, options = {}) {
  const state = await readLeagueStatus(client, config, player, getSettings, options);
  if (state.reason) return state;
  const list = await read(client, 'LeagueRefreshRival', { isRefresh: false });
  const settings = getSettings().league;
  const reason = challengeReason(state, settings, serverNow(client));
  return reason ? { ...state, reason } : { ...state, ...await selectLeagueRival(client, player, state, list, settings) };
}

async function submitLeagueRequest(client, ledger, key, details, name, body, enabled) {
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details });
  try {
    const reply = await client.request(name + 'Request', body, name + 'Response', undefined, () => {
      if (!enabled()) throw Object.assign(Error('积分赛操作已取消'), { notSent: true });
    });
    return { ticket, reply };
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === name + 'Request')) ledger.cancel(ticket);
    throw error;
  }
}

export async function runLeagueChallenge(client, protocol, config, player, { getSettings, enabled, ledger }) {
  const wait = reason => ({ label, skipped: true, reason });
  if (!enabled()) return wait('积分赛挑战已关闭');
  if (!protocol.LeagueFightRequest || !protocol.LeagueFightResponse) return wait('当前协议缺少积分赛挑战定义');
  if (!ledger) return wait('积分赛挑战记录不可用');
  await recoverLeagueOrder(client, player, ledger);
  const readState = () => readLeagueChallenge(client, config, player, getSettings, { ledger });
  const state = await readState();
  const prefix = quotaPrefix(player);
  if (integer(state.reset) && state.reset > serverNow(client) && integer(state.task?.progress)) {
    for (const [key, record] of Object.entries(ledger.keyRecords())) {
      if (!key.startsWith(prefix)) continue;
      const { reset, progress, refreshTimes } = record.details;
      const completed = refreshTimes === undefined ? state.task.progress : state.battles;
      if (reset < state.reset || (reset === state.reset && progress < completed)) {
        if (record.confirmed) ledger.releaseCompletedKey(key);
        else ledger.cancel(record); // No counters reserved. This quota can no longer be sent.
      } else if (reset === state.reset && !record.confirmed && progress < state.battles) {
        ledger.resolveKey(key, true);
      }
    }
  }
  if (state.reason) return { ...wait(state.reason), nextCheck: state.nextCheck };
  const key = leagueChallengeKey(player, state);
  const submitted = () => wait('本次挑战已提交，等待任务进度或战报更新');
  if (ledger.hasKey(key)) return submitted();
  let fresh = await readState();
  if (!fresh.reason && (fresh.target?.id !== state.target?.id || fresh.refreshTimes !== state.refreshTimes)) {
    return wait('对手已更新，下一轮重新选择');
  }
  const details = { reset: state.reset, progress: state.battles };
  for (;;) {
    if (fresh.reason) return wait(fresh.reason);
    if (fresh.reset !== state.reset || fresh.battles !== state.battles || fresh.info.settleTime !== state.info.settleTime) {
      return wait('任务或赛期已更新，下一轮重新选择');
    }
    if (!enabled()) return wait('积分赛挑战已关闭');
    if (ledger.hasKey(key)) return submitted();
    if (fresh.battles >= getSettings().league.dailyBattleLimit) return wait(limitReached(getSettings().league.dailyBattleLimit));
    if (fresh.target) break;
    const refreshKey = key + ':refresh:' + fresh.refreshTimes;
    if (ledger.hasKey(refreshKey)) return wait('本次免费刷新已提交，等待名单更新');
    const { ticket, reply } = await submitLeagueRequest(client, ledger, refreshKey,
      { ...details, refreshTimes: fresh.refreshTimes }, 'LeagueRefreshRival', { isRefresh: true },
      () => enabled() && !challengeReason(fresh, getSettings().league, serverNow(client)));
    ledger.confirm(ticket);
    const status = await readLeagueStatus(client, config, player, getSettings, { ledger });
    fresh = status.reason ? status : { ...status, ...await selectLeagueRival(client, player, status, reply, getSettings().league) };
  }
  const fight = async (canFight = enabled) => {
    const { ticket, reply } = await submitLeagueRequest(client, ledger, key, details, 'LeagueFight', { playerId: wireUid(fresh.target.id) },
      () => canFight() && !challengeReason(fresh, getSettings().league, serverNow(client)));
    const left = uidText(reply?.lPlayer?.playerId), right = uidText(reply?.rPlayer?.playerId);
    const ours = left === fresh.selfId && right === fresh.target.id ? reply.lPlayer :
      right === fresh.selfId && left === fresh.target.id ? reply.rPlayer : null;
    if (!ours || !integer(toNumber(ours.finalScore))) throw new Error('积分赛战果尚未确认，等待任务进度更新');
    ledger.confirm(ticket);
    let result = '战后积分 ' + toNumber(ours.finalScore);
    if (reply.records?.length === fresh.teams && reply.records.every(row => typeof row.isLWin === 'boolean')) {
      const wins = reply.records.filter(row => row.isLWin === (ours === reply.lPlayer)).length;
      result = '实际 ' + wins + ' 胜 ' + (fresh.teams - wins) + ' 负，' + result;
      if (integer(toNumber(ours.score))) {
        const delta = toNumber(ours.finalScore) - toNumber(ours.score);
        result += '（' + (delta > 0 ? '+' : '') + delta + '）';
      }
    }
    return { label, ok: true, note: (state.refreshTimes !== undefined ? '免费刷新后' : '') + fresh.note + '，' + result };
  };
  const selection = JSON.stringify(getSettings().league);
  const active = () => enabled() && JSON.stringify(getSettings().league) === selection;
  if (!active()) return wait('挑战条件已变化');
  return withLeagueOrder(client, player, ledger, fresh.signature, fresh.order, active, async () => {
    const status = await readLeagueStatus(client, config, player, getSettings, { ledger });
    if (status.reason) return wait(status.reason);
    if (status.battles !== state.battles || status.reset !== state.reset || status.info.settleTime !== state.info.settleTime ||
        status.teams !== fresh.teams) return wait('场次或赛期已变化');
    const current = leagueFormationOrder(status.info, status.teams, player);
    const expected = fresh.order.map(i => fresh.signature[i - 1]);
    if (JSON.stringify(current.signature) !== JSON.stringify(expected)) return wait('当前积分赛队序已变化');
    const list = await read(client, 'LeagueRefreshRival', { isRefresh: false });
    const target = list.rivals?.find(row => uidText(row.playerId) === fresh.target.id);
    const eligible = target && filterOpponentsByPower([target], status.info.mine.power, getSettings().league.maxPowerRatio);
    if (!eligible?.candidates?.length) return wait('对手已变化，重新选择');
    const own = await leagueTeamPowers(client, current.teams);
    const rival = await rivalTeamPowers(client, fresh.target.id, status.teams);
    if (!rival || own.filter((power, i) => power > rival[i]).length !== fresh.wins) return wait('分队战力已变化，重新排阵');
    if (!active() || ledger.hasKey(key) || challengeReason(status, getSettings().league, serverNow(client))) return wait('挑战条件已变化');
    return fight(active);
  });
}
