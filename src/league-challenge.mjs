import { toNumber } from './client.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { filterOpponentsByPower } from './opponent-power.mjs';

const label = '积分赛每日挑战';
const serverNow = client => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const read = (client, name, body = {}) => client.request(name + 'Request', body, name + 'Response');
const quotaPrefix = player => 'league-fight:' + uidText(player?.worldId) + ':' + uidText(player?.playerId) + ':';
export const leagueChallengeKey = (player, state) => quotaPrefix(player) + state.reset + ':' + state.task.progress;

function challengeReason(state, options, now) {
  const { task, reset, info, teams, tickets } = state;
  if (!task || !integer(task.progress) || !Number.isSafeInteger(task.targetProgress) || task.targetProgress < 1) return '尚未取得今日积分赛任务';
  if (task.progress >= task.targetProgress) return '今日积分赛任务已完成';
  if (!(reset > now && info.settleTime > now)) return '等待每日任务或积分赛结算更新';
  const second = (now + 8 * 3600) % 86400;
  if (second < 6 * 3600 || second > 86370) return '挑战开放时间为北京时间 06:00 至 23:59:30';
  if (!Number.isSafeInteger(teams) || teams < 1) return '尚未取得当前段位的编队要求';
  for (let index = 1; index <= teams; index++) {
    if (!info.ownFormations?.some(team => team.index === index && team.heroPositions?.length)) return '请先配置积分赛第 ' + index + ' 队';
  }
  if (!(info.top10?.length > 1)) return '当前分组参赛人数不足';
  if (!integer(tickets) || tickets <= options.keepTickets) return '积分赛挑战券不足或已达保留数量';
  return '';
}

export async function readLeagueChallenge(client, config, player, getSettings, { preview = false } = {}) {
  const level = config?.tables?.ModuleOpenCfg?.data?.find(row => row.moduleId === '跨服积分赛')?.playerLevel;
  if (!Number.isSafeInteger(level) || level < 1) return { reason: '尚未取得积分赛开放等级' };
  if (!(player?.level >= level)) return { reason: '跨服积分赛在角色 ' + level + ' 级开放' };
  const daily = await read(client, 'DailyTaskInfo');
  const task = daily.dailyTask?.find(row => row.id === 1017);
  const state = { task, reset: daily.dailyResetTime };
  if (!preview && (!task || task.progress >= task.targetProgress)) {
    return { ...state, nextCheck: task ? state.reset : undefined, reason: task ? '今日积分赛任务已完成' : '尚未取得今日积分赛任务' };
  }
  const info = await read(client, 'LeagueInfo');
  const resources = await read(client, 'AllResource');
  state.info = info;
  state.teams = config.tables.LeagueDanCfg?.data?.find(row => row.dan === info.roomDan)?.teamCount;
  state.tickets = toNumber(resources.list?.find(row => row.res === 6)?.amount);
  state.selfId = uidText(info.mine?.playerId);
  if (!state.selfId || state.selfId !== uidText(player.playerId)) return { ...state, reason: '未能确认积分赛本人身份' };
  const reason = challengeReason(state, getSettings().league, serverNow(client));
  if (reason) return { ...state, reason };
  // Opening the opponent list uses false. The explicit rematch button uses true and may cost diamonds.
  const list = await read(client, 'LeagueRefreshRival', { isRefresh: false });
  const candidates = (list.rivals ?? []).map(row => ({ id: uidText(row.playerId), name: row.nickname,
    power: toNumber(row.power), score: toNumber(row.score) })).filter(row =>
    row.id && row.id !== state.selfId && integer(row.power) && row.power > 0 && integer(row.score));
  const options = getSettings().league;
  const finalReason = challengeReason(state, options, serverNow(client));
  if (finalReason) return { ...state, reason: finalReason };
  if (!candidates.length) return { ...state, reason: '当前名单没有可挑战的对手' };
  const filtered = filterOpponentsByPower(candidates, info.mine.power, options.maxPowerRatio);
  if (filtered.reason) return { ...state, reason: filtered.reason };
  const target = filtered.candidates.sort((a, b) => options.target === 'score'
    ? b.score - a.score || a.power - b.power : a.power - b.power || b.score - a.score)[0];
  return { ...state, target, note: '挑战' + (target.name || target.id) + '（战力 ' + target.power + '，积分 ' + target.score + '）' + filtered.note };
}

export async function runLeagueChallenge(client, protocol, config, player, { getSettings, enabled, ledger }) {
  const wait = reason => ({ label, skipped: true, reason });
  if (!enabled()) return wait('积分赛挑战已关闭');
  if (!protocol.LeagueFightRequest || !protocol.LeagueFightResponse) return wait('当前协议缺少积分赛挑战定义');
  const readState = () => readLeagueChallenge(client, config, player, getSettings);
  const state = await readState();
  const prefix = quotaPrefix(player);
  if (!ledger) return wait('积分赛挑战记录不可用');
  // The daily quota belongs to the task progress, independently of which rival is selected.
  // Retire old quota locks even when the task has just completed.
  if (integer(state.reset) && state.reset > serverNow(client) && integer(state.task?.progress)) {
    for (const [key, record] of Object.entries(ledger.keyRecords())) {
      if (!key.startsWith(prefix)) continue;
      const { reset, progress } = record.details;
      if (reset < state.reset || (reset === state.reset && progress < state.task.progress)) {
        if (record.confirmed) ledger.releaseCompletedKey(key);
        else ledger.cancel(record); // No counters reserved. This quota can no longer be sent.
      }
    }
  }
  if (state.reason) return { ...wait(state.reason), nextCheck: state.nextCheck };
  const key = leagueChallengeKey(player, state);
  const submitted = () => wait('本次挑战已提交，等待每日任务进度更新');
  if (ledger.hasKey(key)) return submitted();
  const fresh = await readState();
  if (fresh.reason) return wait(fresh.reason);
  if (fresh.reset !== state.reset || fresh.task.progress !== state.task.progress || fresh.info.settleTime !== state.info.settleTime ||
      fresh.target.id !== state.target.id) return wait('任务、赛期或对手已更新，下一轮重新选择');
  if (!enabled()) return wait('积分赛挑战已关闭');
  if (ledger.hasKey(key)) return submitted();
  const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details: { reset: fresh.reset, progress: fresh.task.progress } });
  let reply;
  try {
    reply = await client.request('LeagueFightRequest', { playerId: wireUid(fresh.target.id) }, 'LeagueFightResponse');
  } catch (error) {
    if (error.notSent || (error.prompt && error.request === 'LeagueFightRequest')) ledger.cancel(ticket);
    throw error;
  }
  if (uidText(reply?.lPlayer?.playerId) !== fresh.selfId || uidText(reply?.rPlayer?.playerId) !== fresh.target.id ||
      !integer(toNumber(reply.lPlayer.finalScore))) throw new Error('积分赛战果尚未确认，等待任务进度更新');
  ledger.confirm(ticket);
  return { label, ok: true, note: fresh.note + '，战后积分 ' + toNumber(reply.lPlayer.finalScore) };
}
