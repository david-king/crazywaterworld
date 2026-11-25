import { exactAutomationId } from './automation-policy.mjs';
import { readReportSnapshot } from './campaign-reports.mjs';
import { readMailbox } from './mail.mjs';

export function seasonNumber(player) {
  const worldId = exactAutomationId(player?.worldId);
  return worldId ? Number(BigInt(worldId) / 1000000n % 1000n) || null : null;
}

// Keep int64 values exact until presentation. Zero is a valid score.
function quantity(value) {
  if (value === 0 || value === '0' || (value?.high === 0 && value.low === 0)) return '0';
  const result = exactAutomationId(value);
  if (result === null) throw Error('服务器返回的分数或数量无法精确读取，请刷新');
  return result;
}

function rankRow(item) {
  if (!Number.isSafeInteger(item?.rank) || item.rank < 1) throw Error('赛季名次未完整返回');
  return {
    rank: item.rank, playerId: exactAutomationId(item.playerId), name: item.nickname || '未知玩家',
    score: Object.hasOwn(item, 'score') ? quantity(item.score) : null,
  };
}

export async function readSeasonRanking(client, player, kind, limit = 50) {
  if (kind !== 'merit' && kind !== 'tech') throw Error('未知赛季榜单');
  const type = kind === 'merit' ? 0 : 1;
  const info = await client.request('SeasonRankInfoRequest', {}, 'SeasonRankInfoResponse');
  const rows = [];
  const players = new Set();
  let mine = null;
  // SeasonRankPop starts at page 1 for both personal boards.
  for (let page = 1; page <= limit; page++) {
    const reply = await client.request('SeasonRankPlayerRequest', { type, page }, 'SeasonRankPlayerResponse');
    if (!Array.isArray(reply?.player)) throw Error('赛季榜单未完整返回');
    if (reply.myRank?.rank > 0) mine = rankRow(reply.myRank);
    for (const item of reply.player) {
      const row = rankRow(item);
      if (row.rank !== rows.length + 1 || (row.playerId && players.has(row.playerId))) {
        throw Error('赛季名次在分页时发生变化，请刷新榜单');
      }
      rows.push(row);
      if (row.playerId) players.add(row.playerId);
      if (rows.length === limit) break;
    }
    if (rows.length === limit || (page === 1 && !reply.player.length && !reply.maxPage)) break;
    if (!Number.isSafeInteger(reply.maxPage) || reply.maxPage < page) throw Error('赛季榜单页数未确认');
    if (!reply.player.length && (page > 1 || reply.maxPage > page)) throw Error('赛季榜单分页缺失，请刷新');
    if (page === reply.maxPage) break;
  }
  const ownId = exactAutomationId(player?.playerId);
  return { kind, season: seasonNumber(player), rows, mine: mine ?? rows.find(row => ownId && row.playerId === ownId) ?? null,
    midEndTime: info?.midEndTime || null, endTime: info?.endTime || null };
}

export async function readSeasonGuildRank(client, player) {
  const guildId = exactAutomationId(player?.guildId);
  const season = seasonNumber(player);
  const result = { kind: 'guild', season, rank: null, score: null };
  if (player?.guildId == null) throw Error('当前角色的联盟信息尚未同步');
  if (!guildId || BigInt(guildId) % 1000n === 0n) return { ...result, state: 'notJoined' };
  const reply = await client.request('SeasonRankGuildRequest', {}, 'SeasonRankGuildResponse');
  if (!Array.isArray(reply?.guild) || guildId !== exactAutomationId(player.guildId)) throw Error('联盟赛季榜未同步，请刷新');
  const row = reply.guild.find(item => exactAutomationId(item.guildId) === guildId);
  if (!row) return { ...result, state: 'unranked' };
  if (!Number.isSafeInteger(row.rank) || row.rank < 1) throw Error('联盟名次未完整返回');
  return { ...result, state: 'ranked', rank: row.rank, score: Object.hasOwn(row, 'score') ? quantity(row.score) : null };
}

export async function readSeasonMail(client, player, config, reader = client) {
  let changed = false;
  const onSend = ({ name }) => {
    if (name === 'QuickGotReadEmailRequest' || name === 'QuickGotCampaignReportRequest') changed = true;
  };
  client.on?.('sent', onSend);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      changed = false;
      const snapshot = await seasonMailSnapshot(reader, player, config);
      if (!changed) return snapshot;
    }
    throw Error('领取状态正在变化，请稍后刷新邮件物品');
  } finally {
    client.off?.('sent', onSend);
  }
}

async function seasonMailSnapshot(client, player, config) {
  const mails = await readMailbox(client);
  const { reports, complete, reason } = await readReportSnapshot(client);
  if (!complete) throw Error(reason);
  const items = new Map();
  const tables = config?.tables;
  const names = new Map([
    ...(tables?.HeroCfg?.data ?? []).map(row => ['heroes:' + row.id, row.name]),
    ...(tables?.EquipCfg?.data ?? []).map(row => ['equips:' + row.id, row.name]),
    ...(tables?.HeroBadgeCfg?.data ?? []).map(row => ['badge:' + row.id, row.name]),
    ...(tables?.AntiqueBaseCfg?.data ?? []).map(row => ['antiques:' + row.antiqueId, row.showName]),
  ]);
  function accumulate(source, assets, attachments = {}) {
    const amounts = new Map();
    const add = (kind, id, amount) => {
      if (typeof id !== 'string' || !id) throw Error('邮件附件标识缺失，请刷新邮箱');
      const key = kind + ':' + id;
      if (!items.has(key)) {
        const material = config?.materialName?.(id);
        const name = names.get(key) || (kind.startsWith('asset-') && material !== '未知材料' && material) || id;
        items.set(key, { key, id, name, pending: 0n, claimed: 0n, sources: [] });
      }
      amounts.set(key, (amounts.get(key) ?? 0n) + amount);
    };
    for (const asset of assets) {
      add('asset-' + asset.type, asset.id, BigInt(quantity(asset.num)));
    }
    for (const [kind, field] of Object.entries({ heroes: 'heroId', equips: 'equipId', antiques: 'antiqueId', badge: 'badgeId', supplies: 'supId' })) {
      for (const entry of attachments[kind] ?? []) {
        const id = typeof entry === 'string' ? entry : entry?.[field];
        if (!entry?.frag) {
          add(kind, id, 1n);
          continue;
        }
        if (!id) throw Error('奖励碎片标识缺失，请刷新邮箱');
        const color = kind === 'antiques' && tables?.AntiqueBaseCfg?.data?.find(row => row.antiqueId === id)?.color;
        const amount = kind === 'heroes' ? tables?.HeroCfg?.data?.find(row => row.id === id)?.heroFrag
          : color && tables?.AntiqueFragReturnCfg?.data?.find(row => row.color === color)?.count;
        if (Number.isSafeInteger(amount) && amount > 0) add('asset-0', id + '碎片', BigInt(amount));
        else add(kind + '-fragment-packs', id + '碎片兑换包', 1n);
      }
    }
    for (const [key, count] of amounts) {
      const item = items.get(key);
      item[source.claimed ? 'claimed' : 'pending'] += count;
      item.sources.push({ ...source, count: String(count) });
    }
  }
  for (const [id, mail] of mails) {
    if (!mail.attachment) continue;
    if (typeof mail.got !== 'boolean') throw Error('系统邮件领取状态尚未确认，请刷新邮箱');
    accumulate({
      kind: 'system', id, subject: mail.subject || '未命名邮件',
      sendTime: mail.sendTime || null, claimed: !!mail.got,
    }, mail.attachment.assets?.asset ?? [], mail.attachment);
  }
  for (const [id, report] of reports) {
    if (!report.rewards) continue;
    const cargo = report.treasureLoot;
    const subject = cargo ? `货轮${cargo.uid || ''} ${cargo.buildingId || ''}`.trim()
      : report.cityWar ? '攻城战' : '战斗奖励';
    const time = Number(exactAutomationId(report.createTime));
    accumulate({
      kind: 'report', id, subject, sendTime: Number.isSafeInteger(time) && time > 0 ? time : null,
      claimed: report.received,
    }, report.rewards.assetPackage?.asset ?? [], report.rewards);
  }
  let pendingMerit = 0n, claimedMerit = 0n;
  for (const item of items.values()) {
    if (item.id === '功勋' && item.key.startsWith('asset-')) {
      pendingMerit += item.pending;
      claimedMerit += item.claimed;
    }
  }
  return { kind: 'mail', season: seasonNumber(player), scanned: mails.size, reportsScanned: reports.size,
    merit: { pending: String(pendingMerit), claimed: String(claimedMerit) },
    items: Array.from(items.values(), item => ({ ...item, pending: String(item.pending), claimed: String(item.claimed) }))
      .sort((a, b) => Number(b.id === '功勋') - Number(a.id === '功勋') || a.name.localeCompare(b.name, 'zh-CN')) };
}
