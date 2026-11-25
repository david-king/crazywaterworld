import { exactAutomationId } from './automation-policy.mjs';
import { readReportSnapshot } from './campaign-reports.mjs';
import { claimMail, readMailbox } from './mail.mjs';
import { claimReportRewards } from './missing-rewards.mjs';
import { readSeasonMail, readSeasonRanking } from './season-preview.mjs';

const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const wait = (reason, nextAt, status = 'waiting') => ({ skipped: true, reason, nextAt, status });

function canOvertake(board, playerId, targetRank, pending) {
  const target = board.rows[targetRank - 1];
  if (!target || target.score === null) return '目标名次或积分尚未返回';
  if (board.rows.some(row => row.playerId === playerId)) return '已达到目标名次';
  const mine = board.mine;
  if (mine?.playerId && mine.playerId !== playerId) return '本人榜单身份尚未确认';
  if (mine && mine.rank <= targetRank) return '已达到目标名次';
  if (!mine && board.rows.some(row => !row.playerId)) return '本人名次尚未确认';
  // Without a personal score the unclaimed amount alone can prove an overtake.
  const threshold = BigInt(target.score);
  const available = BigInt(pending);
  if (mine?.score == null && available <= threshold) return '本人的功勋积分尚未确认';
  const projected = BigInt(mine?.score ?? 0) + available;
  if (projected <= threshold) return `未领 ${pending} 功勋，超过第 ${targetRank} 名还差 ${threshold - projected + 1n} 功勋`;
  return null;
}

export async function checkSeasonMerit(client, player, options) {
  let revision = 0;
  const sent = ({ name }) => {
    if (name === 'QuickGotReadEmailRequest' || name === 'QuickGotCampaignReportRequest') revision++;
  };
  client.on?.('sent', sent);
  try { return await checkTarget(client, player, options, () => revision); }
  finally { client.off?.('sent', sent); }
}

async function checkTarget(client, player, { getPreference, enabled, ledger }, claimRevision) {
  const p = getPreference();
  const now = () => nowOf(client);
  const retry = () => now() + 15;
  const world = exactAutomationId(player?.worldId), owner = exactAutomationId(player?.playerId);
  if (!p?.enabled || !enabled() || !owner || !world || !ledger
    || !Number.isSafeInteger(p.targetRank) || p.targetRank < 1
    || !Number.isSafeInteger(p.leadMinutes) || p.leadMinutes < 1) return wait('等待账号或偷榜设置', retry());
  const { targetRank, leadMinutes } = p;
  const current = () => {
    const preference = getPreference();
    return enabled() && preference?.enabled === true && preference.targetRank === targetRank
      && preference.leadMinutes === leadMinutes && exactAutomationId(player.worldId) === world
      && exactAutomationId(player.playerId) === owner;
  };
  const clock = await client.request('SeasonRankInfoRequest', {}, 'SeasonRankInfoResponse');
  const end = clock?.endTime;
  if (!Number.isSafeInteger(end) || end <= now()) return wait('等待有效的赛季末结算时间', now() + 300);
  const start = Math.max(clock.startTime || 0, end - leadMinutes * 60);
  if (now() < start) return wait('尚未进入设定的赛季末检查时段', Math.min(start, now() + 3600));
  const allowed = () => current() && now() >= start && now() < end;
  const assertAllowed = () => {
    if (!allowed()) throw Object.assign(Error('偷榜已停止、设置已变化或已到结算时间'), { notSent: true });
  };
  // Stop long inbox/ranking scans promptly when a player edits the goal or stops idle.
  const reader = { request: (...args) => { assertAllowed(); return client.request(...args); } };
  const key = `season-merit:${world}:${owner}:${end}`;
  let record = ledger.keyRecords()[key];
  let plan = record && !record.confirmed ? record.details : null;
  const quoteRevision = claimRevision();
  if (plan) {
    if (plan.mailSent && plan.mailIds.length) {
      const mails = await readMailbox(reader);
      if (!plan.mailIds.every(id => mails.get(id)?.got === true)) return wait('系统邮件领取结果待确认', retry(), 'pending');
    }
    if (plan.reportSent && plan.reportIds.length) {
      const snapshot = await readReportSnapshot(reader);
      if (!snapshot.complete || !plan.reportIds.every(id => snapshot.reports.get(id)?.received === true))
        return wait('战报领取结果待确认', retry(), 'pending');
    }
    if (plan.targetRank !== targetRank || plan.leadMinutes !== leadMinutes) {
      ledger.resolveKey(key, true);
      plan = null;
    }
  }

  if (!plan) {
    const inbox = await readSeasonMail(client, player, null, reader);
    if (inbox.merit.pending === '0') return wait('未领取功勋为 0', retry());
    // Read the live threshold after potentially slow mailbox pagination.
    const board = await readSeasonRanking(reader, player, 'merit', targetRank);
    if (board.endTime !== end) return wait('赛季结算时间已变化，重新检查', retry());
    const reason = canOvertake(board, owner, targetRank, inbox.merit.pending);
    if (reason) return wait(reason, retry());
    const sources = inbox.items.flatMap(item => item.sources.filter(s => !s.claimed));
    const ids = kind => [...new Set(sources.filter(s => s.kind === kind).map(s => s.id))];
    plan = { targetRank, leadMinutes, pending: inbox.merit.pending, mailIds: ids('system'), reportIds: ids('report'),
      mailSent: false, reportSent: false };
    if (record?.confirmed) {
      const previous = record.details;
      if (plan.mailIds.some(id => previous.mailIds.includes(id)) || plan.reportIds.some(id => previous.reportIds.includes(id)))
        return wait('此前已确认的奖励仍显示未领，等待同步', retry());
    }
    record = null;
  }

  // Persist at the actual send boundary. An interrupted two-source payout resumes
  // the remaining source only after the previously sent source is confirmed.
  function beforeSend(field) {
    assertAllowed();
    if (!record && quoteRevision !== claimRevision())
      throw Object.assign(Error('读取榜单期间邮件领取状态已变化，重新检查'), { notSent: true });
    const next = { ...plan, [field]: true };
    try {
      if (!record) {
        const previous = ledger.keyRecords()[key];
        if (previous?.confirmed) ledger.releaseCompletedKey(key, previous);
        ledger.reserve({}, {}, {}, { uniqueKey: key, details: next });
      } else if (!ledger.updateKeyDetails(key, next, record)) throw Error('另一个领取操作已更新记录');
      plan = next;
      record = ledger.keyRecords()[key];
    } catch (error) { throw Object.assign(error, { notSent: true }); }
  }

  if (plan.mailIds.length && !plan.mailSent) {
    let result;
    try {
      result = await claimMail(client, { enabled: allowed, beforeSend: () => beforeSend('mailSent') });
    } catch (error) {
      if (record && error.prompt && error.request === 'QuickGotReadEmailRequest') ledger.cancel({ id: record.id });
      throw error;
    }
    if (!result.ok) return wait(result.reason || result.error || '等待系统邮件领取确认', retry(), 'pending');
  }
  if (plan.reportIds.length && !plan.reportSent) {
    let result;
    await claimReportRewards(client, null, { enabled: allowed, ledger, requireComplete: true,
      beforeSend: () => beforeSend('reportSent'), report: entry => { result = entry; } });
    if (!result?.ok) {
      if (record && plan.reportSent && result?.status === 'rejected') {
        if (plan.mailSent) ledger.updateKeyDetails(key, { ...plan, reportSent: false }, record);
        else ledger.cancel({ id: record.id });
        return wait(result.error || '战报领取被拒绝', retry());
      }
      // A different claim may already have collected these reports.
      if (!allowed()) return wait('偷榜检查已停止', retry());
      const snapshot = await readReportSnapshot(reader);
      if (!snapshot.complete || !plan.reportIds.every(id => snapshot.reports.get(id)?.received === true))
        return wait(result?.reason || result?.error || '等待战报领取确认', retry(), 'pending');
    }
  }
  if (record) ledger.resolveKey(key, true);
  return { ok: true, status: 'confirmed', reason: `已核对领取，决策时未领 ${plan.pending} 功勋，目标第 ${targetRank} 名`, nextAt: retry() };
}
