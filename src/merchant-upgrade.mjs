import { exactAutomationId } from './automation-policy.mjs';
import { clock, natural, positive, read, table, windowOpen } from './activity-actions.mjs';
import { merchantTiming } from './merchant-planner.mjs';

const fullSettings = ctx => (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) ?? {};
const scopeOf = event => 'merchant-upgrade:' + event.startTime + ':' + event.period;
const fingerprint = state => ({ coins: state.player?.coins, profit: state.player?.profit,
  goods: state.player?.goods, cargo: state.cargo });
async function recordOutcome(ctx, outcome) {
  try { return await ctx.onMerchantOutcome?.(outcome); }
  catch { return null; /* 统计记录失败不能改变已经确认的消费结果。 */ }
}
async function markJournal(ctx, key, result) {
  if (result?.recorded === false || !ctx.ledger?.keyRecords?.()[key]?.confirmed) return;
  const record = ctx.ledger.keyRecords()[key];
  ctx.ledger.resolveKey(key, true, { ...record.details, journalRecorded: true });
}
export function evaluateMerchantUpgrade(config, event, state, time, policy = {}) {
  const skip = reason => ({ kind: 'skip', reason });
  if (!windowOpen(event, time) || state?.period !== event.period) return skip('海商王本期未开放');
  if (!merchantTiming(config, event, time).tradingOpen) return skip('等待游戏规定的贸易时段');
  const cargo = state.cargo, profit = state.player?.profit;
  if (!positive(cargo?.cargoLv) || !positive(cargo.cityId) || !natural(cargo.moveEndTime)
    || cargo.moveEndTime > time || cargo.moveToCityId && cargo.moveToCityId !== cargo.cityId)
    return skip('等待商船到港后升级');
  if (!natural(profit)) return skip('累计利润未同步');
  if (policy.profitLimit > 0 && profit >= policy.profitLimit) return skip('已达本期累计利润上限');
  const ships = table(config, 'TradeShipCfg'), fromLevel = cargo.cargoLv;
  if (!ships.some(ship => ship.lv === fromLevel)) return skip('当前船级配置未确认');
  if (!ships.some(ship => ship.lv > fromLevel)) return skip('商船已达本期满级');
  const next = ships.find(ship => ship.lv === fromLevel + 1);
  if (!natural(next?.upMoney)) return skip('下一船级解锁条件未确认');
  if (profit < next.upMoney) return skip('累计利润尚未达到下一船级解锁门槛');
  if (!Array.isArray(next.upCost) || next.upCost.length !== 2 || next.upCost[0] !== 'RUBY' || !positive(next.upCost[1]))
    return skip('下一船级钻石成本未确认');
  const diamonds = next.upCost[1];
  return { kind: 'upgrade', fromLevel, toLevel: next.lv, diamonds, requiredProfit: next.upMoney,
    label: '海商王 · 商船升级 ' + fromLevel + '→' + next.lv + '，消耗 ' + diamonds + ' 钻石' };
}

async function readResources(client) {
  const resources = await read(client, 'AllResource');
  if (!Array.isArray(resources?.list) || !resources.list.length
    || resources.list.some(row => !natural(row?.res) || !natural(row.amount))
    || new Set(resources.list.map(row => row.res)).size !== resources.list.length)
    throw Error('升级后的完整资源库存未确认');
  const diamonds = resources.list.find(row => row.res === 4)?.amount;
  if (!natural(diamonds)) throw Error('钻石余额未确认');
  return diamonds;
}

export const merchantUpgradeMatched = (expected, state) => expected?.request === 'TradeCargoUpgradeRequest'
  && state?.period === expected.period && positive(state.cargo?.cargoLv) && state.cargo.cargoLv >= expected.toLevel;

// 每期每个目标船级使用独立记录，重连后以船级回读确认消费。
export async function runMerchantUpgrade(client, config, ctx, event, state) {
  if (!positive(event?.startTime) || !positive(event.period)) return false;
  const scope = scopeOf(event), ledger = ctx.ledger;
  const report = entry => ctx.report({ label: '海商王商船升级', ...entry });
  const skip = reason => { report({ skipped: true, reason }); return false; };
  if (!ledger) return fullSettings(ctx).merchant?.autoUpgrade === true ? skip('账号执行记录不可用，跳过升级') : false;
  const pending = Object.entries(ledger.keyRecords()).find(([, record]) => !record.confirmed && record.details?.scope === scope);
  if (pending) {
    const [key, record] = pending;
    if (!merchantUpgradeMatched(record.details.expected, state)) {
      report({ skipped: true, reason: '前次升级结果待确认，等待船级同步' }); return true;
    }
    try {
      const afterDiamonds = await readResources(client);
      ledger.resolveKey(key, true);
      const result = await recordOutcome(ctx, { actionKey: key, expected: record.details.expected,
        before: record.details.before, beforeDiamonds: record.details.beforeDiamonds,
        after: fingerprint(state), afterDiamonds, attemptedAt: record.details.attemptedAt,
        status: 'confirmed', time: clock(client), actualDiamondSpent: record.details.expected.diamonds });
      await markJournal(ctx, key, result);
      report({ ok: true, status: 'confirmed', reason: '已按本期船级与完整资源库存确认前次升级' });
      return true;
    } catch (error) { report({ skipped: true, reason: error.message + '，保留升级记录' }); return true; }
  }
  const policy = fullSettings(ctx).merchant ?? {};
  if (policy.autoUpgrade !== true) return false;
  const actor = exactAutomationId(ctx.player?.playerId), world = exactAutomationId(ctx.player?.worldId);
  const active = () => ctx.enabled() && client.connected !== false && fullSettings(ctx).merchant?.autoUpgrade === true
    && exactAutomationId(ctx.player?.playerId) === actor && exactAutomationId(ctx.player?.worldId) === world
    && client.tradeWindow?.period === event.period && client.tradeWindow?.startTime === event.startTime
    && client.tradeWindow?.endTime === event.endTime && windowOpen(event, clock(client));
  if (!actor || !world || !active()) return skip('升级开关、账号或活动状态已变化');
  const initial = evaluateMerchantUpgrade(config, event, state, clock(client), policy);
  if (initial.kind !== 'upgrade') return skip(initial.reason);
  let fresh, diamonds;
  try {
    fresh = await read(client, 'TradeInfo');
    diamonds = await readResources(client);
  } catch (error) { return skip('升级复查失败：' + error.message); }
  const check = () => evaluateMerchantUpgrade(config, event, fresh, clock(client), fullSettings(ctx).merchant);
  const verified = check();
  if (!active() || verified.kind !== 'upgrade' || fresh.cargo.cityId !== state.cargo.cityId
    || verified.toLevel !== initial.toLevel || verified.diamonds !== initial.diamonds)
    return skip('船级、费用或升级条件已变化，下一轮重算');
  if (diamonds < verified.diamonds) return skip('钻石余额不足以升级商船，继续普通贸易');
  const expected = { request: 'TradeCargoUpgradeRequest', period: event.period, startTime: event.startTime,
    fromLevel: verified.fromLevel, toLevel: verified.toLevel, diamonds: verified.diamonds };
  const key = scope + ':' + verified.toLevel;
  if (ledger.hasKey(key)) return skip('本期目标船级已有升级记录，继续普通贸易');
  let ticket;
  const before = fingerprint(fresh), attemptedAt = clock(client);
  const notify = outcome => recordOutcome(ctx, { actionKey: key, expected, before, beforeDiamonds: diamonds,
    attemptedAt, time: clock(client), ...outcome });
  try {
    ticket = ledger.reserve({ merchantUpgradeDiamonds: verified.diamonds }, {}, {},
      { uniqueKey: key, details: { scope, expected, evaluation: verified, before, beforeDiamonds: diamonds, attemptedAt } });
  } catch (error) { return skip(error.message + '，继续普通贸易'); }
  const finalPlan = check();
  if (!active() || finalPlan.toLevel !== verified.toLevel || finalPlan.diamonds !== verified.diamonds) {
    ledger.cancel(ticket); return skip('升级条件已变化');
  }
  let reply;
  try {
    reply = await client.request('TradeCargoUpgradeRequest', {}, 'TradeCargoUpgradeResponse');
  } catch (error) {
    if (error.notSent === true || error.prompt && error.request === 'TradeCargoUpgradeRequest') ledger.cancel(ticket);
    const status = error.notSent === true ? 'cancelled' : error.prompt && error.request === 'TradeCargoUpgradeRequest' ? 'rejected' : 'unknown';
    await notify({ status });
    report({ label: verified.label, ok: false,
      status,
      error: error.message });
    return true;
  }
  let after;
  try {
    if (!positive(reply?.cargo?.cargoLv) || reply.cargo.cargoLv < verified.toLevel) throw Error('升级回执船级未确认');
    after = await read(client, 'TradeInfo');
    if (!merchantUpgradeMatched(expected, after)) throw Error('升级后的本期商船状态未确认');
    const afterDiamonds = await readResources(client);
    ledger.confirm(ticket);
    ledger.resolveKey(key, true, { scope, expected, evaluation: verified, before, beforeDiamonds: diamonds,
      after: fingerprint(after), afterDiamonds, attemptedAt, confirmedAt: clock(client),
      actualDiamondSpent: verified.diamonds });
    const result = await notify({ after: fingerprint(after), afterDiamonds, status: 'confirmed', actualDiamondSpent: verified.diamonds });
    await markJournal(ctx, key, result);
    report({ label: verified.label, ok: true, status: 'confirmed' });
  } catch (error) {
    await notify({ after: after ? fingerprint(after) : undefined, status: 'unknown' });
    report({ label: verified.label, ok: false, status: 'unknown', error: error.message });
  }
  return true;
}
