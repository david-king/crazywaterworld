import { toNumber } from './client.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { filterOpponentsByPower } from './opponent-power.mjs';

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

function selectLeagueRival(state, list, options) {
  if (!Array.isArray(list?.rivals)) return { reason: '尚未取得积分赛对手名单' };
  const candidates = list.rivals.map(row => ({ id: uidText(row.playerId), name: row.nickname,
    power: toNumber(row.power), score: toNumber(row.score) })).filter(row =>
    row.id && row.id !== state.selfId && integer(row.power) && row.power > 0 && integer(row.score));
  const filtered = filterOpponentsByPower(candidates, state.info.mine.power, options.maxPowerRatio);
  if (!filtered.candidates || (filtered.reason && !options.fallbackWeakest)) return { reason: filtered.reason };
  const fallback = !filtered.candidates.length;
  // LeagueChallengePop switches to its diamond refresh button above 1.
  const times = list.refreshTimes;
  if (fallback && options.fallbackWeakest && Object.hasOwn(list, 'refreshTimes') && integer(times) && times <= 1 && times > state.lastRefreshTimes) {
    return { refreshTimes: times, note: '免费刷新对手，仍无人符合战力上限时挑战当前名单中战力最低者' };
  }
  if (!candidates.length) return { reason: '当前名单没有可挑战的对手' };
  const byPower = (a, b) => a.power - b.power || b.score - a.score;
  const byScore = (a, b) => b.score - a.score || a.power - b.power;
  const target = fallback ? candidates.sort(byPower)[0]
    : filtered.candidates.sort(options.target === 'score' ? byScore : byPower)[0];
  return { target, note: (fallback ? '兜底挑战' : '挑战') + (target.name || target.id) + '（战力 ' + target.power + '，积分 ' + target.score + '）' + (filtered.note ?? '') };
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
  return reason ? { ...state, reason } : { ...state, ...selectLeagueRival(state, list, settings) };
}

async function submitLeagueRequest(client, ledger, key, details, name, body) {
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details });
  try {
    return { ticket, reply: await read(client, name, body) };
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
      { ...details, refreshTimes: fresh.refreshTimes }, 'LeagueRefreshRival', { isRefresh: true });
    ledger.confirm(ticket);
    const status = await readLeagueStatus(client, config, player, getSettings, { ledger });
    fresh = status.reason ? status : { ...status, ...selectLeagueRival(status, reply, getSettings().league) };
  }
  const { ticket, reply } = await submitLeagueRequest(client, ledger, key, details, 'LeagueFight', { playerId: wireUid(fresh.target.id) });
  if (uidText(reply?.lPlayer?.playerId) !== fresh.selfId || uidText(reply?.rPlayer?.playerId) !== fresh.target.id ||
      !integer(toNumber(reply.lPlayer.finalScore))) throw new Error('积分赛战果尚未确认，等待任务进度更新');
  ledger.confirm(ticket);
  return { label, ok: true, note: (state.refreshTimes !== undefined ? '免费刷新后' : '') + fresh.note + '，战后积分 ' + toNumber(reply.lPlayer.finalScore) };
}
