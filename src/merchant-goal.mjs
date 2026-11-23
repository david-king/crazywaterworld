import { dayOf, natural, positive, table } from './activity-actions.mjs';
import { merchantActionSeconds, merchantSettings, merchantTiming } from './merchant-planner.mjs';

export const MERCHANT_PROFIT_GOAL = 50_000_000;

// 后续每程至少需要采购、出航、出售各一轮。跨夜分别计数，零头不能拼成航程。
export function merchantFreeTrips(config, event, readyAt, actionSeconds, policy, batches = 1, lastDeparture = readyAt) {
  const first = merchantTiming(config, event, readyAt);
  if (!positive(first.travelSeconds) || first.tradeStartTime === null) return 0;
  const cycle = first.travelSeconds + (2 * batches + 1) * actionSeconds;
  const purchaseCutoff = event.endTime - (policy.liquidationMinutes ?? 120) * 60;
  const startDay = dayOf(readyAt), lastDay = dayOf(Math.min(event.endTime, purchaseCutoff) - 1);
  if (startDay > lastDay) return 0;
  const tripsOn = day => {
    const midnight = day * 86400 - 28800;
    const window = merchantTiming(config, event, midnight);
    let start = Math.max(window.tradeStartTime, readyAt, event.startTime);
    if (day > dayOf(lastDeparture) && policy.firstDepartureMode === 'time') {
      const [hour, minute] = (policy.firstDepartureTime ?? '10:00').split(':').map(Number);
      start = Math.max(start, midnight + hour * 3600 + minute * 60);
    }
    const byClose = Math.floor((window.tradeEndTime - start - 1) / cycle);
    const byPurchase = Math.ceil((purchaseCutoff - start) / cycle);
    return Math.max(0, Math.min(byClose, byPurchase));
  };
  if (startDay === lastDay) return tripsOn(startDay);
  const fullDays = lastDay - startDay - 1;
  return tripsOn(startDay) + tripsOn(lastDay) + (fullDays ? fullDays * tripsOn(startDay + 1) : 0);
}

// 将北京时间投影到累计开放交易秒数，跨夜和末日截断与走商使用同一时段。
function tradingSecondsAt(config, time) {
  const day = dayOf(time);
  const { tradeStartTime, tradeEndTime } = merchantTiming(config, null, time);
  if (tradeStartTime === null || tradeEndTime === null) return null;
  const daily = tradeEndTime - tradeStartTime;
  return day * daily + Math.max(0, Math.min(daily, time - tradeStartTime));
}

export function merchantGoal(config, event, state, time, settings = {}) {
  const target = MERCHANT_PROFIT_GOAL;
  const tiers = table(config, 'TradeAchieveRewardCfg').filter(row => row.id === event.period &&
    positive(row.target) && positive(row.rewardId)).sort((a, b) => a.rewardId - b.rewardId);
  const profit = natural(state.player?.profit) ? state.player.profit : null;
  const claimed = natural(state.gotAchieveRwdId) ? state.gotAchieveRwdId : null;
  const remaining = profit === null ? null : Math.max(0, target - profit);
  const goalTier = tiers.find(tier => tier.target === target);
  const nextTier = claimed === null ? null : tiers.find(tier => tier.rewardId > claimed);
  const checkedAt = Math.max(event.startTime, Math.min(time, event.endTime));
  const tradingNow = tradingSecondsAt(config, checkedAt);
  const left = tradingNow === null ? null : tradingSecondsAt(config, event.endTime) - tradingNow;
  const elapsed = tradingNow === null ? null : tradingNow - tradingSecondsAt(config, event.startTime);
  const policy = merchantSettings(settings?.merchant), cargo = state.cargo;
  const step = merchantActionSeconds(settings);
  let freeTrips = null, benchmark = null;
  if (cargo && left !== null && positive(merchantTiming(config, event, time).travelSeconds)) {
    const arrival = Math.max(time, cargo.moveEndTime || 0);
    let window = merchantTiming(config, event, arrival);
    if (arrival + step >= window.tradeEndTime)
      window = merchantTiming(config, event, (dayOf(arrival) + 1) * 86400 - 28800);
    const dockedAt = Math.max(arrival, window.tradeStartTime);
    const cargoSale = state.player.goods?.length > 0 && dockedAt + step < window.tradeEndTime ? 1 : 0;
    freeTrips = cargoSale + merchantFreeTrips(config, event, dockedAt + cargoSale * step, step, policy, 1, cargo.moveStartTime || 0);

    const ships = table(config, 'TradeShipCfg');
    let ship = ships.find(row => row.lv === cargo.cargoLv);
    while (policy.autoUpgrade && ship) {
      const next = ships.find(row => row.lv === ship.lv + 1);
      if (next?.upCost?.[0] !== 'RUBY' || !positive(next.upCost[1])) break;
      ship = next;
    }
    const densities = table(config, 'TradeGoodsCfg').filter(row => positive(row.unitPrice) && positive(row.capacity))
      .map(row => Math.floor(row.unitPrice * (100 - policy.estimateDiscountPercent) / 100) / row.capacity);
    if (positive(ship?.capacity) && natural(ship.profitMargin) && densities.length)
      benchmark = { level: ship.lv, profit: Math.ceil(ship.capacity * Math.max(...densities) * (10000 + ship.profitMargin) / 10000) };
  }
  return {
    checkedAt, target, profit, remaining, claimed, totalTiers: tiers.length, reward: goalTier?.rewards ?? [],
    tiers: tiers.map(tier => ({ id: tier.rewardId, target: tier.target, rewards: tier.rewards ?? [] })),
    nextTier: nextTier && { id: nextTier.rewardId, target: nextTier.target },
    ready: nextTier != null && profit !== null && profit >= nextTier.target,
    remainingTradingSeconds: left,
    freeTrips, requiredPerFreeTrip: remaining !== null && freeTrips > 0 ? Math.ceil(remaining / freeTrips) : null, benchmark,
    requiredPerHour: remaining !== null && left > 0 ? Math.ceil(remaining * 3600 / left) : null,
    observedPerHour: profit !== null && elapsed > 0 ? Math.floor(profit * 3600 / elapsed) : null,
  };
}
