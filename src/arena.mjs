import { toNumber } from './client.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { filterOpponentsByPower } from './opponent-power.mjs';

const busy = new WeakSet();
const attempted = new WeakMap();
const skipped = reason => ({ skipped: true, reason });

// The server exposes one battle count. A slot identifies one ticket across both modes.
function arenaUsage(records, prefix, total) {
  let challenges = 0, sweeps = 0, waiting = false;
  for (const [key, record] of Object.entries(records)) {
    if (!key.startsWith(prefix)) continue;
    if (Number(key.slice(prefix.length)) >= total) waiting = true;
    else if (record.confirmed) {
      if (record.details.sweep) sweeps++;
      else challenges++;
    }
  }
  return { challenges, sweeps, unknown: Math.max(0, total - challenges - sweeps), waiting };
}

function evaluateArena({ task, probe, dailyResetTime, client, now, settings, ledger }) {
  if (!task) return { status: 'waiting', reason: '尚未取得今日竞技场任务' };
  const options = settings?.arena;
  const challengeLimit = options ? (options.challengeHigher ? options.challengeLimit : 0) : task.targetProgress;
  const sweepLimit = options?.sweepLower ? options.sweepLimit : 0;
  if (!challengeLimit && !sweepLimit) return { status: 'done', reason: '竞技场挑战和扫荡均已关闭或次数为 0' };
  if (!options && task.progress >= challengeLimit) return { status: 'done', reason: '已完成竞技场每日战斗次数' };
  const info = probe('ArenaInfoRequest');
  if (!Number.isSafeInteger(info?.dailyChallengeTimes) || info.dailyChallengeTimes < 0) return { status: 'waiting', reason: '尚未取得竞技场今日挑战次数' };
  const reset = dailyResetTime || (Math.floor((now + 28800) / 86400) + 1) * 86400 - 28800;
  const previous = client && attempted.get(client);
  const selfId = uidText(info.myself?.id);
  const prefix = 'arena:' + selfId + ':' + reset + ':';
  const records = ledger?.keyRecords() ?? previous?.records ?? {};
  const usage = arenaUsage(records, prefix, info.dailyChallengeTimes);
  if (!options && info.dailyChallengeTimes >= challengeLimit) return { usage, status: 'done', reason: '已完成竞技场每日战斗次数' };
  const challengesLeft = Math.max(0, challengeLimit - usage.challenges);
  const sweepsLeft = Math.max(0, sweepLimit - usage.sweeps);
  // An unclassified battle consumes one of the remaining slots across both modes.
  if (usage.unknown >= challengesLeft + sweepsLeft) return { usage, status: 'done', reason: '已达到竞技场每日战斗次数上限' };
  if ((usage.waiting && (options || ledger)) || (previous?.reset === reset && info.dailyChallengeTimes < previous.confirmedTimes)
    || task.progress > info.dailyChallengeTimes) return { usage, status: 'waiting', reason: '等待竞技场挑战次数更新' };
  const tickets = toNumber(probe('AllResourceRequest')?.list?.find(row => row.res === 5)?.amount ?? NaN);
  if (!Number.isSafeInteger(tickets) || tickets < 0) return { usage, status: 'waiting', reason: '未能确认挑战券余额' };
  if (tickets === 0) return { usage, status: 'waiting', reason: '等待挑战券恢复，回券后继续剩余场次' };
  const self = info?.myself;
  if (!selfId || !Number.isSafeInteger(self.rankNo) || self.rankNo < 1 || !Array.isArray(info.challenges)) {
    return { usage, status: 'waiting', reason: '尚未取得竞技场排名或对手名单' };
  }
  // ArenaModel builds the visible list from top3, challenges and (when missing)
  // myself. ArenaChallengeItem enables entries 4+ outside the top ten; rows
  // ranked below the player are sweep targets with a different protocol.
  const ranks = new Map();
  const contested = new Set();
  for (const row of [...(info.top3 ?? []), ...info.challenges, self]) {
    if (ranks.has(row.rankNo) && uidText(ranks.get(row.rankNo).id) !== uidText(row.id)) contested.add(row.rankNo);
    ranks.set(row.rankNo, row);
  }
  const roster = [...ranks.values()];
  roster.sort((a, b) => a.rankNo - b.rankNo);
  const selectable = roster.filter((row, i) => !contested.has(row.rankNo)
    && (self.rankNo <= 10 || (i >= 3 && row.rankNo > 3 && info.challenges.includes(row)))
    && Number.isSafeInteger(row.rankNo) && row.rankNo > 0 && row.rankNo !== self.rankNo
    && uidText(row.id) && uidText(row.id) !== selfId && Number.isFinite(toNumber(row.power)));
  const targets = selectable.filter(row => row.rankNo < self.rankNo);
  const byPower = (a, b) => toNumber(a.power) - toNumber(b.power) || b.rankNo - a.rankNo;
  const filtered = challengesLeft > 0 ? filterOpponentsByPower(targets, self.power, options?.maxPowerRatio) : {};
  const fallback = options?.fallbackWeakest === true && filtered.overLimit?.length > 0;
  let target = fallback ? filtered.overLimit.sort(byPower)[0]
    : filtered.candidates?.sort(options?.target === 'rank' ? (a, b) => a.rankNo - b.rankNo : byPower)[0];
  const sweep = !target && sweepsLeft > 0;
  if (sweep) target = selectable.filter(row => row.rankNo > self.rankNo).sort(byPower)[0];
  if (!target) {
    const reasons = [];
    if (challengesLeft > 0) reasons.push(filtered.reason || '没有排名在自己之前的可挑战对手');
    if (sweepsLeft > 0) reasons.push('没有可扫荡的低排名对手');
    return { usage, status: 'waiting', reason: reasons.join('，') };
  }
  const snapshot = JSON.stringify([reset, task.progress, info.dailyChallengeTimes, selfId, self.rankNo, sweep, fallback, target.rankNo,
    roster.map(row => [row.rankNo, uidText(row.id)])]);
  if (previous?.reset === reset && previous.snapshots.has(snapshot)) {
    return { usage, status: 'waiting', reason: '已尝试过本轮名单，等待对手名单或挑战次数更新' };
  }
  const verb = sweep ? '扫荡' : fallback ? '兜底挑战' : '挑战';
  return { usage, status: 'ready', actions: [{ request: sweep ? 'ArenaSweepRequest' : 'ArenaChallengeRequest', response: sweep ? null : 'ArenaChallengeResponse',
    body: { rank: target.rankNo, challengeId: uidText(target.id) }, arenaSnapshot: snapshot, arenaReset: reset, arenaSlot: prefix + info.dailyChallengeTimes,
    cost: '挑战券 ×1', note: verb + '第 ' + target.rankNo + ' 名对手（战力 ' + toNumber(target.power) + '）' + (sweep ? '' : filtered.note ?? '') }] };
}

export async function readArena(client, getSettings, timeout, ledger) {
  const request = name => client.request(name + 'Request', {}, name + 'Response', timeout);
  const daily = await request('DailyTaskInfo');
  const task = daily.dailyTask?.find(row => row.id === 1005);
  const info = await request('ArenaInfo');
  const resources = await request('AllResource');
  const plan = evaluateArena({ task, client, ledger, settings: getSettings(), dailyResetTime: daily.dailyResetTime,
    now: (Date.now() + (client.serverClockOffsetMs || 0)) / 1000,
    probe: name => name === 'ArenaInfoRequest' ? info : resources });
  const tickets = toNumber(resources.list?.find(row => row.res === 5)?.amount);
  return { plan, info, task, tickets: Number.isSafeInteger(tickets) ? tickets : null };
}

async function runArena({ client, protocol, action, timeout, allowAction, ledger, getSettings = () => null, performWrite = write => write() }) {
  if (busy.has(client)) return skipped('正在核对上一场竞技场挑战');
  busy.add(client);
  try {
    const request = name => client.request(name + 'Request', {}, name + 'Response', timeout);
    const { info, plan: fresh } = await readArena(client, getSettings, timeout, ledger);
    const current = fresh.actions?.[0];
    if (!current) return skipped(fresh.reason);
    if (current.request !== action.request || current.arenaSnapshot !== action.arenaSnapshot || current.body.challengeId !== action.body.challengeId
      || current.body.rank !== action.body.rank) return skipped('竞技场排名或对手名单已更新，请按最新名单再挑战');
    if (!allowAction(1005, action)) return skipped('竞技场挑战已关闭');
    if (!protocol[current.request] || (current.response && !protocol[current.response])) throw new Error('缺少竞技场挑战或扫荡协议定义');
    let previous = attempted.get(client);
    if (!previous || previous.reset !== current.arenaReset) {
      previous = { reset: current.arenaReset, snapshots: new Set(), confirmedTimes: 0, records: {} };
      attempted.set(client, previous);
    }
    const challengeId = wireUid(current.body.challengeId);
    const payload = { rank: current.body.rank, challengeId };
    const key = current.arenaSlot;
    const details = { reset: current.arenaReset, sweep: !current.response };
    if (ledger) {
      // Slots only disambiguate the current game day. Discard older role records.
      const rolePrefix = 'arena:' + uidText(info.myself.id) + ':';
      for (const [oldKey, record] of Object.entries(ledger.keyRecords())) {
        if (!oldKey.startsWith(rolePrefix) || record.details.reset >= details.reset) continue;
        if (record.confirmed) ledger.releaseCompletedKey(oldKey);
        else ledger.cancel(record);
      }
    }
    const ticket = ledger?.reserve({}, {}, {}, { uniqueKey: key, details });
    const record = { details, confirmed: false };
    previous.records[key] = record;
    previous.snapshots.add(current.arenaSnapshot);
    const release = () => { ledger?.cancel(ticket); delete previous.records[key]; };
    let body;
    try {
      body = current.response
        ? await performWrite(() => client.request(current.request, payload, current.response, timeout))
        : await performWrite(() => client.sendWatch(current.request, payload));
    } catch (error) {
      if (error.notSent || (error.prompt && error.request === current.request)) {
        release();
        previous.snapshots.delete(current.arenaSnapshot);
      }
      throw error;
    }
    if (body?.isChange) {
      release();
      return skipped('对手排名已变更，本轮未挑战，等待新名单');
    }
    let confirmedTimes = info.dailyChallengeTimes + 1;
    // Sweeps have no dedicated response. Verify the server-side battle count.
    if (!uidText(body?.reportId)) {
      const after = await request('ArenaInfo');
      if (!(after.dailyChallengeTimes >= confirmedTimes)) throw new Error('未确认竞技场战报或挑战次数变化');
      confirmedTimes = after.dailyChallengeTimes;
    }
    ledger?.confirm(ticket);
    record.confirmed = true;
    previous.confirmedTimes = confirmedTimes;
    return { body };
  } finally {
    busy.delete(client);
  }
}

export const arenaDailyDriver = {
  id: 1005, title: '竞技场战斗',
  probes: [['ArenaInfoRequest', {}], ['AllResourceRequest', {}]],
  evaluate: evaluateArena, run: runArena,
};
