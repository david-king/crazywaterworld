import { clock, dayOf, itemBalance, natural, positive, read, table } from './activity-actions.mjs';

const pointer = '海商王加速';
const keyOf = event => 'merchant-free-pointers:' + event.startTime + ':' + event.period;

export function periodPointerUsage(records, event, confirmedOnly = false) {
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  return records.reduce((sum, { confirmed, details }) => {
    const action = details?.expected;
    return (!confirmedOnly || confirmed) && details?.scope === scope && action?.request === 'TradeSpeedRequest' && positive(action.useNum)
      ? sum + action.useNum : sum;
  }, 0);
}

function claimedPointers(rows, claimed, rewards) {
  let count = 0;
  for (const row of rows.filter(claimed)) {
    for (const [id, amount] of rewards(row)) {
      if (id !== pointer) continue;
      if (!natural(amount)) throw Error('免费针奖励数量未同步');
      count += amount;
    }
  }
  return count;
}

export function freePointerAllowance(snapshot, stock, used) {
  if (!snapshot || !natural(stock) || !natural(used) || used < snapshot.used) return 0;
  return Math.max(0, Math.min(snapshot.available - (used - snapshot.used), stock - (snapshot.stock - snapshot.available)));
}

// 背包不区分针的来源。首次观察封存原库存，随后只认可领奖标记和库存同时支持的新增量。
export async function observeFreePointers(client, config, event, info, ledger, guild, allowed) {
  if (!ledger || !guild || info.period !== event.period || !allowed()) return null;
  const key = keyOf(event), day = dayOf(clock(client));
  const initial = ledger.keyRecords()[key]?.details;
  const pass = await read(client, 'BattlePass', { type: 3 });
  const task = info.guildTask ?? (await read(client, 'TradeTask')).guildTask;
  const passRows = table(config, 'TradePassCfg').filter(row => row.period === event.period);
  const taskRows = table(config, 'TradeGuildTaskCfg'), reportRows = table(config, 'TradeDayRewardCfg');
  if (!passRows.length || !taskRows.length || !reportRows.length || !Array.isArray(pass.got) || !Array.isArray(task?.gotTaskId)
    || !positive(pass.endTime) || !natural(info.gotReportRwdId) || !natural(info.player?.buySpeedTimes)) return null;
  const tiers = new Map(pass.got.map(t => [t.id, t])), tasks = new Set(task.gotTaskId);
  const freePass = claimedPointers(passRows, r => tiers.get(r.rwdId)?.freeGot === true, r => r.freeReward);
  const paid = claimedPointers(passRows, r => tiers.get(r.rwdId)?.payGot === true, r => r.payReward);
  const guildTasks = claimedPointers(taskRows, r => tasks.has(r.id), r => r.rewards);
  const reports = claimedPointers(reportRows, r => r.id <= info.gotReportRwdId, r => r.rewards);
  const stock = await itemBalance(client, pointer);
  if (!allowed() || day !== dayOf(clock(client))) return null;
  const records = ledger.keyRecords(), previous = records[key]?.details;
  if (JSON.stringify(previous) !== JSON.stringify(initial)) return null;
  const entries = Object.values(records);
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  // 扣针待回读期间，库存可能已减少。保留上次快照，确认后只扣一次。
  if (entries.some(r => !r.confirmed && !r.expired && r.details?.scope === scope && r.details.expected?.request === 'TradeSpeedRequest')) return null;
  const used = periodPointerUsage(entries, event, true), bought = info.player.buySpeedTimes;
  let available = 0;
  if (previous && previous.guild === guild && previous.passEnd === pass.endTime) {
    const sameDay = previous.day === day;
    if (day < previous.day || used < previous.used || freePass < previous.freePass || paid < previous.paid
      || guildTasks < previous.guildTasks || (sameDay && (reports < previous.reports || bought < previous.bought))) return null;
    // 跨日无法重建昨天最后一次观察以后的购买量。本次仅结转可核实的余额，今天从新快照继续。
    const earned = sameDay ? freePass - previous.freePass + guildTasks - previous.guildTasks + reports - previous.reports : 0;
    const nonFree = paid - previous.paid + bought - (sameDay ? previous.bought : 0);
    const reserved = previous.stock - previous.available + nonFree;
    available = Math.max(0, Math.min(previous.available + earned - (used - previous.used), stock - reserved));
  }
  const snapshot = { guild, passEnd: pass.endTime, day, freePass, guildTasks, reports, bought, paid, stock, used, available };
  if (previous) {
    if (Object.keys(snapshot).some(k => snapshot[k] !== previous[k])) ledger.resolveKey(key, true, snapshot);
  } else {
    ledger.confirm(ledger.reserve({}, {}, {}, { uniqueKey: key, details: snapshot }));
  }
  return snapshot;
}

export const savedFreePointers = (ledger, event) => ledger?.keyRecords()[keyOf(event)]?.details;
