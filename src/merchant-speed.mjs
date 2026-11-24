import { freePointerAllowance, observeFreePointers, periodPointerUsage, savedFreePointers } from './merchant-free-pointers.mjs';
import { checkedAction, clock, dayOf, natural, positive, read, table, waiting, windowOpen } from './activity-actions.mjs';
import {
  beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation,
  confirmOrderMaterialSpends, refreshOrderMaterialSpends
} from './order-reservations.mjs';
import { MERCHANT_DEFAULTS, merchantActionSeconds, merchantFinalCargoStart, merchantGoalSalePrice, merchantPointerSeconds, merchantSpeedMode, merchantTiming, planMerchant } from './merchant-planner.mjs';
import { buyMerchantPointers, reconcileMerchantAction } from './merchant-strategy.mjs';
import { estimateMerchantRace, merchantCompetitorArrivals } from './merchant-race.mjs';
import { watchMerchant } from './merchant-monitor.mjs';
import { MERCHANT_PROFIT_GOAL, merchantFreeTrips, merchantSprintTrips } from './merchant-goal.mjs';
import { merchantFingerprint as fingerprint, merchantSpeedMatches, merchantSpeedVoyageEnded } from './merchant-action-state.mjs';

export { merchantSpeedMatches };

const pointer = '海商王加速';
const arrivalReasons = new Set(['race', 'full', 'guard', 'finalCargo']);
const fullSettingsOf = ctx => (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) ?? {};
const settingsOf = ctx => fullSettingsOf(ctx).merchant ?? {};
const stampSettings = ctx => {
  const full = fullSettingsOf(ctx), settings = full.merchant ?? {};
  return JSON.stringify([
    settings.autoSpeedUp, settings.keepPointers, settings.estimateDiscountPercent, settings.fullCargoRoutes, settings.liquidationMinutes,
    settings.quoteMaxAgeSeconds, settings.speedUpMode, settings.guardLastPointer, settings.speedUpMaxPerLeg, full.loop?.everySeconds, ctx.everyMs,
    settings.dailyPointerLimit, settings.periodPointerLimit, settings.refreshWindowMinutes, settings.autoBuyPointers, settings.pointerDailyDiamondLimit, settings.profitLimit,
    settings.minExpectedProfit, settings.liquidationMinutes, settings.maxLossPercent, settings.refreshWaitSeconds,
    settings.firstDepartureMode, settings.firstDepartureTime, ctx.merchantCadenceSeconds
  ]);
};

function tradeDeadline(config, event, time) {
  const window = merchantTiming(config, event, time);
  return window.tradingOpen ? window.tradeEndTime : null;
}

function targetMarket(config, event, cityId, time, maxAge, options) {
  const epoch = merchantTiming(config, event, time).marketEpoch;
  return [...(Array.isArray(options.markets) ? options.markets : []), options.targetMarket, options.market].filter(market =>
    market?.cityId === cityId && market.period === event.period && market.startTime === event.startTime
    && natural(market.observedAt) && market.observedAt <= time && time - market.observedAt <= maxAge
    && merchantTiming(config, event, market.observedAt).marketEpoch === epoch && Array.isArray(market.goods)
    && market.goods.every(good => positive(good?.goodsId) && positive(good.price))
    && new Set(market.goods.map(good => good.goodsId)).size === market.goods.length
  ).sort((a, b) => b.observedAt - a.observedAt)[0];
}

// 比较本程让多少航时给后续采购最划算。明天的额度单独计算，库存两天共用。
function closingSpeed({ time, timing, tomorrow, event, settings, goodsCount, actionSeconds, perPointer, legCap,
  available, inventory, dailyBudget, dailyLimit, naturalArrival, remaining, tripProfit, outcome }) {
  const cutoff = event.endTime - (settings.liquidationMinutes ?? MERCHANT_DEFAULTS.liquidationMinutes) * 60;
  const trips = (window, start, budget, wanted) => merchantSprintTrips(window, start, cutoff, timing.travelSeconds,
    actionSeconds, goodsCount, perPointer, legCap, budget, wanted);
  let tomorrowStart = tomorrow.tradeStartTime;
  if (settings.firstDepartureMode === 'time') {
    const midnight = (dayOf(time) + 1) * 86400 - 28800;
    const [h, m] = (settings.firstDepartureTime ?? '10:00').split(':').map(Number);
    tomorrowStart = Math.max(tomorrowStart, midnight + h * 3600 + m * 60);
  }
  let best, unacceleratedProgress = 0;
  for (let useNum = 0; useNum <= available; useNum++) {
    const arrival = Math.max(time, naturalArrival - useNum * perPointer), sale = outcome(arrival);
    if (useNum && !sale.saleCount) continue;
    const wanted = Math.ceil(Math.max(0, remaining - sale.cargoProfit) / tripProfit);
    const ready = arrival + goodsCount * actionSeconds;
    const tomorrowReady = Math.max(tomorrowStart, arrival) + Math.max(0, goodsCount -
      Math.max(0, Math.floor((timing.tradeEndTime - arrival - 1) / actionSeconds))) * actionSeconds;
    const limit = Math.min(inventory, dailyBudget) - useNum;
    const maxToday = trips(timing, ready, limit, wanted).trips;
    for (let today = 0; today <= maxToday; today++) {
      const todayPins = useNum + trips(timing, ready, limit, today).pins;
      const later = trips(tomorrow, tomorrowReady, Math.min(inventory - todayPins, dailyLimit), wanted - today);
      const progress = Math.min(remaining, sale.cargoProfit + (today + later.trips) * tripProfit);
      if (useNum === 0) unacceleratedProgress = Math.max(unacceleratedProgress, progress);
      const totalPins = todayPins + later.pins;
      // 同收益和总用量时保留今天可推迟的针；今天必须用的优先花在已确认的盈利载货上。
      const rank = [progress, -totalPins, -todayPins, Math.min(useNum, Math.floor((naturalArrival - time) / perPointer)), -useNum];
      const delta = best && rank.map((v, i) => v - best.rank[i]).find(v => v !== 0);
      if (!best || delta > 0) best = { rank, useNum, arrival, sale, progress };
    }
  }
  return { ...best, unacceleratedProgress };
}

export function planMerchantSpeed(config, event, state, radar, stock, settings, time, options = {}) {
  const none = reason => ({ kind: 'none', reason });
  const wait = reason => ({ kind: 'wait', reason });
  if (settings?.autoSpeedUp !== true) return none('未开启商会指针加速');
  if (!windowOpen(event, time) || state?.period !== event.period) return none('海商王本期未开放');
  const target = Math.min(MERCHANT_PROFIT_GOAL, settings.profitLimit > 0 ? settings.profitLimit : Infinity);
  if (!natural(state.player?.profit)) return wait('本期累计利润未同步，保留指针');
  const remaining = target - state.player.profit;
  if (remaining <= 0) return none('已达本期指针冲刺目标，停止用针和补购');
  const cargo = state.cargo;
  if (!cargo || !positive(cargo.cityId) || !positive(cargo.moveToCityId) || cargo.cityId === cargo.moveToCityId
    || !positive(cargo.moveStartTime) || !positive(cargo.moveEndTime) || cargo.moveStartTime > time
    || cargo.moveEndTime <= time) return none('商船当前不在可确认的航程中');
  if (positive(options.plannedOpening) && cargo.moveEndTime <= options.plannedOpening)
    return none('自然航行即可赶上开市，保留指针');
  const timing = merchantTiming(config, event, time);
  if (!timing.tradingOpen) return none('不在开放交易时段');
  const deadline = timing.tradeEndTime;
  const finalStart = merchantFinalCargoStart(timing, event, settings, state.player.goods, cargo.moveToCityId);
  const finalCargo = finalStart !== null && time >= finalStart;
  const actionSeconds = Math.max(60, Number.isFinite(options.actionSeconds) ? Math.ceil(options.actionSeconds) : 60);
  const savingPointers = !finalCargo && (settings.fullCargoRoutes ?? MERCHANT_DEFAULTS.fullCargoRoutes) &&
    event.endTime - time > (settings.liquidationMinutes ?? MERCHANT_DEFAULTS.liquidationMinutes) * 60;
  if (savingPointers && (!state.player?.goods?.length || cargo.moveEndTime + state.player.goods.length * actionSeconds < deadline))
    return none('满舱航线可自然到港成交，保留指针用于收尾');
  const mode = savingPointers ? 'deadline' : merchantSpeedMode(settings.speedUpMode);
  const goalMode = mode === 'goal';
  const perPointer = merchantPointerSeconds(config);
  const guard = !savingPointers && settings.guardLastPointer === true && perPointer && cargo.moveEndTime - time <= perPointer;
  const arrivalPolicy = finalCargo ? 'finalCargo' : guard ? 'guard' : ['race', 'full'].includes(mode) ? mode : null;
  const refreshMode = ['refresh', 'arrival'].includes(mode);
  const inRefreshWindow = refreshMode && positive(timing.previousRefreshAt) &&
    time < timing.previousRefreshAt + (settings.refreshWindowMinutes ?? 8) * 60;
  const arrivals = mode === 'race' || inRefreshWindow ? merchantCompetitorArrivals(state, options.actor, time,
    mode === 'race' ? 0 : merchantTiming(config, event, cargo.moveEndTime).previousRefreshAt) : [];
  const firstArrival = arrivals[0];
  if (arrivalPolicy === 'race' && (!firstArrival || firstArrival > cargo.moveEndTime)) {
    return { kind: 'none', leading: !!firstArrival, reason: firstArrival
      ? '自然到港比最早的可见同港同盟船早 ' + (firstArrival - cargo.moveEndTime) + ' 秒，保留指针'
      : '未发现同港在途同盟船，保留指针' };
  }
  const rival = arrivals.findLast(eta => eta <= cargo.moveEndTime);
  const discount = settings.estimateDiscountPercent ?? MERCHANT_DEFAULTS.estimateDiscountPercent;
  const keep = settings.keepPointers ?? 0;
  const maxAge = settings.quoteMaxAgeSeconds ?? 300;
  const maxPerLeg = settings.speedUpMaxPerLeg ?? 4;
  const usedPointers = options.usedPointers ?? 0;
  if (!['deadline', 'refresh', 'arrival', 'race', 'full', 'goal'].includes(mode)
    || (!arrivalPolicy && (!natural(discount) || discount >= 100))
    || !natural(keep) || !positive(maxAge) || !positive(maxPerLeg) || !natural(usedPointers))
    return wait('商会指针策略参数无效');
  const fullVoyage = timing.travelSeconds;
  const knownMarket = targetMarket(config, event, cargo.moveToCityId, time, maxAge, options);
  const totalBatches = Array.isArray(state.player?.goods) ? Math.max(1, state.player.goods.length) : null;
  const competing = rival && totalBatches !== null;
  if (!arrivalPolicy && options.exploration && !competing) return none('寻价途中暂无可争取的同盟采购顺位');
  if (!arrivalPolicy && !goalMode && totalBatches !== null && cargo.moveEndTime <= deadline - totalBatches * actionSeconds && !competing) {
    if (arrivals[0] > cargo.moveEndTime) return { kind: 'none', leading: true, reason: '自然到港已领先可见同盟船，保留指针，到港按实价选货' };
    return none('正常到港后仍有逐批成交时间，无需加速');
  }
  if (deadline - time < actionSeconds) return wait('剩余时间不足以预留一轮 ' + actionSeconds + ' 秒成交，不使用指针');
  if (!positive(perPointer) || !positive(fullVoyage)) return wait('指针时长或航程配置未确认');
  const dailyLimit = settings.dailyPointerLimit ?? 28;
  if (!natural(dailyLimit) || !natural(options.dailyUsed ?? 0)) return wait('每日指针用量未确认');
  const limit = Math.max(0, Math.min(dailyLimit - (options.dailyUsed ?? 0), Math.floor(fullVoyage / perPointer) - usedPointers, maxPerLeg - usedPointers,
    Math.ceil((cargo.moveEndTime - time) / perPointer)));
  if (!Array.isArray(radar?.radar)) return wait('目的港列表未同步，不使用指针');
  const ports = radar.radar.filter(row => row?.cityId === cargo.moveToCityId);
  if (ports.length !== 1 || !positive(ports[0].cityId)) return wait('目的港资格未确认，不使用指针');
  const ship = table(config, 'TradeShipCfg').find(row => row.lv === cargo.cargoLv);
  const definitions = new Map(table(config, 'TradeGoodsCfg').map(row => [row.goodsId, row]));
  const goods = state.player?.goods;
  if (!ship || !positive(ship.capacity) || !natural(ship.profitMargin) || !Array.isArray(goods)
    || goods.some(row => !row || typeof row !== 'object')
    || new Set(goods.map(row => row.pid)).size !== goods.length)
    return wait('船舶或持货批次未确认，不使用指针');
  const knownQuotes = new Map(knownMarket?.goods.map(good => [good.goodsId, good.price]) ?? []);
  let usedCapacity = 0;
  const gains = [];
  for (const good of goods) {
    const cfg = definitions.get(good.goodsId);
    if (!natural(good.pid) || !positive(good.num) || !positive(good.buyPrice) || !positive(good.cityId)
      || !positive(cfg?.capacity) || !positive(cfg.unitPrice)) return wait('持货成本或舱位未确认，不使用指针');
    usedCapacity += cfg.capacity * good.num;
    // 本港特产不能按基准价假设盈利，来源港批次也不可出售。
    if (arrivalPolicy || good.cityId === cargo.moveToCityId) continue;
    const knownPrice = knownQuotes.get(good.goodsId);
    // 亲自观察到的低价作为保守上限；即使到港已跨报价有效期，也不恢复为较高基准价。
    // 历史高价不抬高估值，所有目的港价格都仍是带风险折扣的估算。
    const price = merchantGoalSalePrice(cfg, ports[0], knownPrice, discount);
    const gain = Math.floor(Math.max(0, price - good.buyPrice) * good.num * (1 + ship.profitMargin / 10000));
    if (!natural(gain)) return wait('批次利润计算异常，保留指针');
    if (gain > 0) gains.push(gain);
  }
  if (!natural(usedCapacity) || usedCapacity > ship.capacity)
    return wait('持货舱位或利润计算异常，不使用指针');
  const have = stock instanceof Map ? stock.get(pointer) ?? 0 : null;
  const hasPeriodBudget = natural(settings.periodPointerLimit) || settings.speedUpMode === 'eventFree';
  const periodRemaining = hasPeriodBudget ? Math.min(natural(settings.periodPointerLimit) ? settings.periodPointerLimit : Infinity,
    natural(options.periodRemaining) ? options.periodRemaining : 0) : Infinity;
  if (!periodRemaining)
    return wait(settings.speedUpMode === 'eventFree' ? '当前没有已核实可用的本期免费针，继续自然航行' : '本期总针数已用完，继续自然航行');
  const inventory = Math.min(Math.max(0, have - keep), periodRemaining);
  const available = Math.min(limit, inventory);
  if (arrivalPolicy) {
    if (!natural(have)) return wait('商会指针库存未同步');
    if (!available) return wait('可用指南针不足，或已到每程或每日上限');
    let useNum = available;
    if (arrivalPolicy === 'race') {
      // 严格早于最早一艘。恰好与对方同秒到港仍需再用一根。
      useNum = Math.floor((cargo.moveEndTime - firstArrival) / perPointer) + 1;
      if (useNum > available) return wait('当前用量不足以抢在最早的同港同盟船之前，保留指针');
    } else if (arrivalPolicy === 'guard') {
      useNum = 1;
    }
    const afterEndTime = Math.max(time, cargo.moveEndTime - useNum * perPointer);
    const saleCount = finalCargo ? goods.filter(good => good.cityId !== cargo.moveToCityId).length : 1;
    const saleSeconds = saleCount * actionSeconds;
    if (afterEndTime + saleSeconds >= deadline) return wait(finalCargo
      ? '用完可用指南针仍来不及在收盘前卖完 ' + saleCount + ' 批货，保留指针'
      : '加速后仍赶不上本次交易，保留指针');
    // 先自然航行到余针能一次抵港的时刻，抵港时间相同，也能在发针前重新核对额度和货物。
    if (finalCargo && afterEndTime > time) return { kind: 'wait', mode: 'WAIT_FINAL_CARGO', nextCheckAt: afterEndTime,
      reason: '当前可用 ' + available + ' 根指南针，等待剩余航时缩短至可一次到港再核对' };
    const savedSeconds = cargo.moveEndTime - afterEndTime;
    const reason = arrivalPolicy === 'race' ? '预计比最早的可见同港同盟船早 ' + (firstArrival - afterEndTime) + ' 秒到港'
      : arrivalPolicy === 'guard' ? '最后一根防抢，直接到港'
      : arrivalPolicy === 'finalCargo' ? '最后一船加速到港，收盘前按实价卖货' : '全程加速，按剩余航时尽快到港';
    const expected = { request: 'TradeSpeedRequest', period: event.period, city: cargo.cityId,
      destination: cargo.moveToCityId, moveStartTime: cargo.moveStartTime, beforeEndTime: cargo.moveEndTime,
      afterEndTime, useNum, accelerationReason: arrivalPolicy, savedSeconds };
    return { kind: 'speed', useNum, have, expected, deadline, saleSeconds, savedSeconds,
      accelerationReason: arrivalPolicy, rivalEta: arrivalPolicy === 'race' ? firstArrival : null,
      evidenceExpiresAt: Math.min(deadline - saleSeconds - 1, cargo.moveEndTime - 1,
        arrivalPolicy === 'race' ? firstArrival - 1 : Infinity),
      label: '海商王 · 使用商会指针 ×' + useNum + '，' + reason + '，提前 ' + savedSeconds + ' 秒' };
  }
  if (!competing && !gains.length)
    return wait('风险折扣后的目的港估值没有可盈利出售的批次');
  gains.sort((a, b) => b - a);
  // 收盘未售出的货物可以留到下一个开放日。只有本期结束才截断剩余批次。
  const tomorrow = merchantTiming(config, event, (dayOf(time) + 1) * 86400 - 28800);
  const tripProfit = gains.reduce((sum, gain) => sum + gain, 0);
  const outcome = arrival => {
    const slots = Math.max(0, Math.floor((deadline - arrival - 1) / actionSeconds));
    const today = gains.slice(0, slots);
    const saleCount = today.length, saleSeconds = saleCount * actionSeconds;
    const estimatedProfit = today.reduce((sum, gain) => sum + gain, 0);
    const nextOpen = Math.max(arrival, tomorrow.tradeStartTime);
    const carrySlots = Math.max(0, Math.floor((tomorrow.tradeEndTime - nextOpen - 1) / actionSeconds));
    const cargoProfit = gains.slice(saleCount, saleCount + carrySlots).reduce((sum, gain) => sum + gain, estimatedProfit);
    let freeTrips = 0;
    if (goalMode) {
      const readyAt = slots >= totalBatches ? arrival + totalBatches * actionSeconds :
        nextOpen + (totalBatches - slots) * actionSeconds;
      freeTrips = merchantFreeTrips(config, event, readyAt, actionSeconds, settings, totalBatches, cargo.moveStartTime);
    }
    return { saleCount, saleSeconds, estimatedProfit, cargoProfit, freeTrips };
  };
  const normal = outcome(cargo.moveEndTime);
  if (!natural(normal.cargoProfit)) return wait('自然航程利润估算异常，保留指针');
  const gap = remaining - normal.cargoProfit - normal.freeTrips * tripProfit;
  if (gap <= 0) return none(goalMode ? '按本船折后估值和剩余自然航次预计可达目标，保留指针' : '按当前持货自然到港出售估算可达目标，保留指针');
  if (normal.saleCount === gains.length && !competing && !goalMode)
    return none('正常到港后足够完成可盈利批次出售，无需加速');
  if (!natural(have)) return wait('商会指针库存未同步');
  if (!available) return wait('留足保留量或本航程用量上限后的商会指针不足');
  const dayAfter = merchantTiming(config, event, (dayOf(time) + 2) * 86400 - 28800);
  if (goalMode && dayAfter.tradeEndTime <= dayAfter.tradeStartTime) {
    const best = closingSpeed({ time, timing, tomorrow, event, settings, goodsCount: totalBatches, actionSeconds,
      perPointer, legCap: Math.min(maxPerLeg, Math.floor(fullVoyage / perPointer)), available, inventory,
      dailyBudget: dailyLimit - (options.dailyUsed ?? 0), dailyLimit, naturalArrival: cargo.moveEndTime, remaining, tripProfit, outcome });
    if (!best?.useNum) return none('收尾按剩余交易窗口、库存和每日额度测算，本程可继续自然航行');
    const { useNum, arrival: afterEndTime, sale } = best;
    const savedSeconds = cargo.moveEndTime - afterEndTime;
    const rescued = sale.cargoProfit - normal.cargoProfit;
    const accelerationReason = rescued > 0 && best.progress <= sale.cargoProfit ? 'deadline' : 'goalCatchUp';
    const estimatedIncrementalProfit = best.progress - best.unacceleratedProgress;
    const forecast = best.progress >= remaining ? '按本船利润估算可达目标' :
      '若后续每船利润相近，按剩余时间和用针额度预计仍差 ' + (remaining - best.progress).toLocaleString('zh-CN');
    return { kind: 'speed', useNum, have, deadline, savedSeconds, accelerationReason, estimatedIncrementalProfit,
      saleCount: sale.saleCount, saleSeconds: sale.saleSeconds, estimatedProfit: sale.estimatedProfit,
      goalProgress: best.progress, reachesGoal: best.progress >= remaining,
      evidenceExpiresAt: Math.min(deadline - sale.saleSeconds - 1, cargo.moveEndTime - 1),
      expected: { request: 'TradeSpeedRequest', period: event.period, city: cargo.cityId, destination: cargo.moveToCityId,
        moveStartTime: cargo.moveStartTime, beforeEndTime: cargo.moveEndTime, afterEndTime, useNum, accelerationReason,
        estimatedIncrementalProfit, savedSeconds },
      label: '海商王 · 收尾追赶，使用库存指南针 ×' + useNum + '，本船预计利润 ' + sale.estimatedProfit + '，' + forecast + '。到港按实价重算' };
  }
  const candidates = [];
  const estimateRace = competing && estimateMerchantRace(config, event, state, radar, time, settings, options, rival, actionSeconds);
  for (let useNum = 1; useNum <= available; useNum++) {
    const afterEndTime = Math.max(time, cargo.moveEndTime - useNum * perPointer);
    const savedSeconds = cargo.moveEndTime - afterEndTime;
    const accelerated = outcome(afterEndTime);
    const { saleCount, saleSeconds, estimatedProfit } = accelerated;
    const race = estimateRace && estimateRace(afterEndTime);
    if (race) {
      const baseline = normal.cargoProfit + race.baseline;
      const raceGap = remaining - baseline;
      if (raceGap <= 0) return none('自然到港估算可凭现货与后续采购达到目标，保留指针');
      const gain = Math.min(normal.cargoProfit, accelerated.cargoProfit) + race.baseline + race.gain - baseline;
      if (positive(gain)) candidates.push({
        useNum, afterEndTime, savedSeconds, estimatedIncrementalProfit: gain, accelerationReason: 'stockRace',
        goalProgress: Math.min(raceGap, gain), reachesGoal: gain >= raceGap,
        saleCount, saleSeconds, estimatedProfit, evidenceExpiresAt: Math.min(deadline, race.expiresAt,
          inRefreshWindow ? timing.previousRefreshAt + (settings.refreshWindowMinutes ?? 8) * 60 - 1 : Infinity)
      });
    }
    if (options.exploration || !saleCount) continue;
    const extraTrips = accelerated.freeTrips - normal.freeTrips;
    const incrementalProfit = accelerated.cargoProfit - normal.cargoProfit + extraTrips * tripProfit;
    if (!positive(incrementalProfit)) continue;
    candidates.push({ useNum, afterEndTime, savedSeconds, estimatedIncrementalProfit: incrementalProfit,
      accelerationReason: extraTrips > 0 ? 'extraVoyage' : 'deadline', saleCount, saleSeconds, estimatedProfit,
      goalProgress: Math.min(gap, incrementalProfit), reachesGoal: incrementalProfit >= gap,
      evidenceExpiresAt: deadline });
  }
  if (!candidates.length) return wait(competing ? '现有记录未显示抢先采购能增加利润，保留指针' : '按可用指针和成交时间估算，加速未增加利润，保留指针');
  // 达标先取最少根数；差距较大时让每根指针尽量多推进目标。
  candidates.sort((a, b) => Number(b.reachesGoal) - Number(a.reachesGoal) ||
    (a.reachesGoal ? a.useNum - b.useNum : b.goalProgress / b.useNum - a.goalProgress / a.useNum) ||
    a.useNum - b.useNum || b.goalProgress - a.goalProgress);
  const best = candidates[0], { useNum, savedSeconds, estimatedIncrementalProfit, accelerationReason } = best;
  const reasonLabel = accelerationReason === 'stockRace' ? '早于可见同盟船采购，按目的港历史库存估算新货差额' :
    accelerationReason === 'extraVoyage' ? '争取额外自然航次，按本船折后利润估算' : '抢救截止成交';
  return { kind: 'speed', ...best, have, deadline,
    expected: { request: 'TradeSpeedRequest', period: event.period, city: cargo.cityId,
      destination: cargo.moveToCityId, moveStartTime: cargo.moveStartTime,
      beforeEndTime: cargo.moveEndTime, afterEndTime: best.afterEndTime, useNum,
      accelerationReason, estimatedIncrementalProfit, savedSeconds },
    label: accelerationReason === 'stockRace' ? '海商王 · 使用商会指针 ×' + useNum + '，' + reasonLabel + ' ' + estimatedIncrementalProfit + '，到港复查实价和库存' :
      '海商王 · 使用商会指针 ×' + useNum + '，预留 ' + best.saleSeconds + ' 秒完成 ' + best.saleCount + ' 批成交；'
      + reasonLabel + '，提前 ' + savedSeconds + ' 秒，估算增益 ' + estimatedIncrementalProfit + '；'
      + (knownMarket ? '结合到访低价的' : '基准价') + '折扣估算利润 '
      + best.estimatedProfit + '（非目的港实时报价）' };
}

function pointerStock(response) {
  const stock = new Map();
  if (!Array.isArray(response?.items)) throw Error('商会指针完整库存未同步');
  for (const row of response.items) {
    if (typeof row?.itemId !== 'string' || !row.itemId || stock.has(row.itemId) || !natural(row.num))
      throw Error('商会指针完整库存记录无效');
    stock.set(row.itemId, row.num);
  }
  return stock;
}

const readStock = async client => pointerStock(await read(client, 'AllItem'));

function merchantPeriodPointers(records, event, settings, snapshot, stock) {
  const limit = settings.periodPointerLimit;
  const used = periodPointerUsage(records, event);
  const allowance = settings.speedUpMode === 'eventFree' ? freePointerAllowance(snapshot, stock, used) : Infinity;
  if (limit === undefined || limit === -1) return allowance;
  if (!natural(limit)) return 0;
  return Math.min(allowance, Math.max(0, limit - used));
}

function dailyPointersUsed(records, counter, time) {
  return Math.max(counter, records.reduce((sum, record) => {
    const e = record.details?.expected, at = record.details?.attemptedAt;
    return e?.request === 'TradeSpeedRequest' && positive(at) && dayOf(at) === dayOf(time) && positive(e.useNum) ? sum + e.useNum : sum;
  }, 0));
}

export async function readMerchantDockBudget(ask, ledger, settings, time, event, freePointers) {
  if (!ledger) return null;
  const counter = ledger.snapshot().counters?.merchantPointers ?? 0, records = Object.values(ledger.keyRecords());
  const dailyUsed = dailyPointersUsed(records, counter, time);
  if (dailyUsed >= settings.dailyPointerLimit) return null;
  const freeMode = settings.speedUpMode === 'eventFree';
  if (freeMode && freePointers === undefined) freePointers = savedFreePointers(ledger, event);
  let periodRemaining = merchantPeriodPointers(records, event, settings, freePointers, freePointers?.stock);
  if (!periodRemaining) return null;
  const stock = pointerStock(await ask('AllItem'));
  if (freeMode) periodRemaining = merchantPeriodPointers(records, event, settings, freePointers, stock.get(pointer) ?? 0);
  return periodRemaining ? { stock, dailyUsed, periodRemaining } : null;
}

export function merchantClosingRoute(config, event, state, market, ports, radar, time, visited, inputs, budget) {
  if (!budget) return null;
  const { settings, actionSeconds: step } = inputs;
  const timing = merchantTiming(config, event, time), per = merchantPointerSeconds(config);
  const max = Math.min(settings.dailyPointerLimit - budget.dailyUsed, settings.speedUpMaxPerLeg, budget.periodRemaining ?? Infinity,
    (budget.stock.get(pointer) ?? 0) - settings.keepPointers, Math.floor(timing.travelSeconds / per));
  for (let pins = 1; pins <= max; pins++) {
    const route = planMerchant(config, event, state, market, ports, time, visited, { ...inputs, closingPointers: pins });
    if (!['buy', 'move'].includes(route.kind) || route.exploration || !(route.expectedProfit > 0) || !(route.latestActionAt > time)) continue;
    // 用同一个在途策略试算这船是否真能在收盘前成交。采购和发船之后仍逐次读实际库存与报价。
    const purchases = route.purchases ?? [], goods = state.player.goods.slice();
    let pid = goods.reduce((id, good) => Math.max(id, good.pid + 1), 0);
    for (const item of purchases) goods.push({ pid: pid++, goodsId: item.goodsId, cityId: route.city, buyPrice: item.price, num: item.count });
    const start = time + purchases.length * step;
    const loaded = { ...state, player: { ...state.player, goods }, cargo: { ...state.cargo, moveToCityId: route.destination,
      moveStartTime: start, moveEndTime: start + timing.travelSeconds } };
    const speed = planMerchantSpeed(config, event, loaded, radar, budget.stock, settings, start + step,
      { actionSeconds: step, dailyUsed: budget.dailyUsed, periodRemaining: budget.periodRemaining, markets: inputs.markets });
    if (speed.kind === 'speed' && speed.useNum >= pins)
      return { ...route, accelerationRequired: pins, travelSeconds: route.arrival - time,
        label: route.label + '，收尾航线已核对 ' + pins + ' 根库存指南针' };
  }
  return null;
}

export async function runMerchantSpeed(client, config, ctx, event, state, freePointers) {
  const settings = settingsOf(ctx);
  if (settings.autoSpeedUp !== true || !(state?.cargo?.moveEndTime > clock(client))) return false;
  const initialSettings = stampSettings(ctx);
  const monitor = watchMerchant(client), fleetRevision = monitor.fleetRevision;
  const actor = JSON.stringify([ctx.player?.playerId, ctx.player?.worldId, ctx.player?.guildId]);
  const allowed = () => ctx.enabled() && client.connected !== false && settingsOf(ctx).autoSpeedUp === true
    && stampSettings(ctx) === initialSettings
    && JSON.stringify([ctx.player?.playerId, ctx.player?.worldId, ctx.player?.guildId]) === actor
    && client.tradeWindow?.period === event.period && client.tradeWindow?.startTime === event.startTime
    && client.tradeWindow?.endTime === event.endTime
    && monitor.fleetRevision === fleetRevision
    && windowOpen(event, clock(client)) && tradeDeadline(config, event, clock(client)) !== null;
  if (!allowed()) return false;
  const records = Object.entries(ctx.ledger?.keyRecords() ?? {});
  const pending = records.find(([, record]) => !record.confirmed && !record.expired && record.details?.scope === 'merchant:' + event.startTime + ':' + event.period &&
    record.details.expected?.request === 'TradeSpeedRequest');
  if (pending) {
    await reconcileMerchantAction(client, ctx, pending, state, allowed);
    return true;
  }
  const departure = records.find(([, record]) => {
    const expected = record.details?.expected, cargo = state.cargo;
    return record.confirmed && record.details?.scope === 'merchant:' + event.startTime + ':' + event.period
      && expected?.request === 'TradeMoveRequest'
      && expected.city === cargo.cityId && expected.destination === cargo.moveToCityId
      && (record.details.after?.cargo?.moveStartTime === cargo.moveStartTime || Math.abs(expected.start - cargo.moveStartTime) <= 2);
  })?.[1].details.expected;
  // 不需要加速时不查询库存；其余缺失输入会在获取新快照后校验。
  const actionSeconds = () => positive(ctx.merchantCadenceSeconds) ? Math.max(60, ctx.merchantCadenceSeconds)
    : merchantActionSeconds(fullSettingsOf(ctx), Math.ceil((ctx.everyMs ?? 0) / 1000));
  const options = stock => {
    const counter = ctx.ledger?.snapshot().counters?.merchantPointers ?? 0;
    const all = Object.values(ctx.ledger?.keyRecords() ?? {});
    const records = all.filter(record => record.confirmed);
    const usedPointers = records.reduce((sum, record) => {
      const e = record.details?.expected, cargo = state.cargo;
      return record.details?.scope === 'merchant:' + event.startTime + ':' + event.period && e?.request === 'TradeSpeedRequest'
        && e.period === event.period && e.city === cargo.cityId && e.destination === cargo.moveToCityId
        && e.moveStartTime === cargo.moveStartTime && positive(e.useNum) ? sum + e.useNum : sum;
    }, 0);
    return { actionSeconds: actionSeconds(), usedPointers, actor: ctx.player, exploration: departure?.exploration === true,
      plannedOpening: departure?.plannedOpening, counter,
      periodRemaining: merchantPeriodPointers(all, event, settings, freePointers, stock?.get(pointer) ?? 0),
      marketHistory: records.find(record => record.details?.merchantJournal?.event?.startTime === event.startTime &&
        record.details.merchantJournal.event.period === event.period)?.details.merchantJournal.snapshots?.map(entry => ({
          ...entry.market, held: entry.state?.player?.goods, visitStart: entry.state?.cargo?.moveStartTime
        })),
      dailyUsed: dailyPointersUsed(all, counter, clock(client)),
      markets: records.map(record => record.details?.merchantMarket).filter(Boolean) };
  };
  const early = planMerchantSpeed(config, event, state, null, null, settings, clock(client), options());
  const skip = reason => { waiting(ctx, reason); return true; };
  if (early.kind === 'none') return early.leading ? skip(early.reason) : false;
  if (!ctx.ledger) return skip('账号执行记录不可用，不使用指针');
  try {
    await refreshOrderMaterialSpends(client, ctx.player, { enabled: allowed });
    const radar = await read(client, 'TradeGuildRadar');
    const stock = await readStock(client);
    if (!allowed()) return skip('加速开关或活动状态已变化');
    const plan = planMerchantSpeed(config, event, state, radar, stock, settings, clock(client), options(stock));
    const keep = settings.keepPointers ?? 0, maxStock = keep + (settings.speedUpMaxPerLeg ?? 4);
    if (settings.speedUpMode !== 'eventFree' && settings.autoBuyPointers && (stock.get(pointer) ?? 0) < maxStock) {
      const purchasePlan = (info, have, possible, ports = radar) => {
        const now = clock(client), input = options();
        const evaluate = (count, at) => planMerchantSpeed(config, event, info, ports, new Map([[pointer, count]]), settings, at, input);
        // 购买占用本轮动作。下一轮仍能兑现的机会才值得补购。
        const next = now + input.actionSeconds;
        if (dayOf(next) !== dayOf(now)) return null;
        const desired = evaluate(possible, next);
        if (desired.kind !== 'speed' || desired.useNum + keep <= have) return null;
        const baseline = evaluate(have, now);
        if (desired.accelerationReason === 'finalCargo' && baseline.mode === 'WAIT_FINAL_CARGO') return null;
        const count = desired.useNum + keep - have;
        if (arrivalReasons.has(desired.accelerationReason)) {
          const obtainableNow = evaluate(possible, now);
          if (obtainableNow.kind !== 'speed' || obtainableNow.accelerationReason !== desired.accelerationReason ||
            obtainableNow.rivalEta !== desired.rivalEta) return null;
          const currentEta = baseline.expected?.afterEndTime ?? info.cargo.moveEndTime;
          return desired.expected.afterEndTime < currentEta ? { count, expiresAt: desired.evidenceExpiresAt, expedite: true } : null;
        }
        if (baseline.reachesGoal || desired.goalProgress <= (baseline.goalProgress ?? 0)) return null;
        return desired.estimatedIncrementalProfit > (baseline.estimatedIncrementalProfit ?? 0)
          ? { count, expiresAt: desired.evidenceExpiresAt } : null;
      };
      if (purchasePlan(state, stock.get(pointer) ?? 0, maxStock) &&
        await buyMerchantPointers(client, config, ctx, event, state, purchasePlan, allowed)) return true;
    }
    if (plan.kind !== 'speed') {
      if (plan.nextCheckAt) {
        const now = clock(client);
        monitor.observe({ event, state, plan, time: now, config, settings: fullSettingsOf(ctx), expedite: now >= plan.nextCheckAt });
      }
      return plan.kind === 'none' ? false : skip(plan.reason);
    }
    const fresh = await read(client, 'TradeInfo');
    const freshRadar = await read(client, 'TradeGuildRadar');
    if (settings.speedUpMode === 'eventFree') {
      freePointers = await observeFreePointers(client, config, event, fresh, ctx.ledger, freePointers?.guild, allowed);
      if (!freePointers) return skip('本期免费针余额待核实，继续自然航行');
    }
    const freshStock = await readStock(client);
    if (!allowed()) return skip('加速开关或活动状态已变化');
    const verifiedAt = clock(client), verifiedOptions = options(freshStock);
    const verifyAt = time => planMerchantSpeed(config, event, fresh, freshRadar, freshStock, settings, time, verifiedOptions);
    const verified = verifyAt(verifiedAt);
    const sameVoyage = verified.kind === 'speed' &&
      ['period', 'city', 'destination', 'moveStartTime', 'beforeEndTime', 'useNum']
        .every(key => plan.expected[key] === verified.expected[key]);
    // 立即到港时 afterEndTime 会随读取期间流逝的秒数变化，执行新快照即可。
    if (!sameVoyage
      || JSON.stringify(fingerprint(state)) !== JSON.stringify(fingerprint(fresh))
      || verified.estimatedProfit !== plan.estimatedProfit || verified.saleCount !== plan.saleCount
      || verified.saleSeconds !== plan.saleSeconds || verified.accelerationReason !== plan.accelerationReason
      || verified.rivalEta !== plan.rivalEta || verified.goalProgress !== plan.goalProgress || verified.reachesGoal !== plan.reachesGoal
      || verified.estimatedIncrementalProfit !== plan.estimatedIncrementalProfit)
      return skip('航程、库存或加速收益已变化，下一轮重算');
    const expected = verified.expected;
    const evidenceValid = () => {
      const now = clock(client);
      if (now > verified.evidenceExpiresAt) return false;
      if (now === verifiedAt) return true;
      const latest = verifyAt(now);
      return latest.useNum === verified.useNum && latest.accelerationReason === verified.accelerationReason && latest.rivalEta === verified.rivalEta &&
        latest.goalProgress === verified.goalProgress && latest.reachesGoal === verified.reachesGoal;
    };
    let material;
    await checkedAction(ctx, {
      scope: 'merchant:' + event.startTime + ':' + event.period,
      before: fingerprint(fresh), expected, label: verified.label,
      retainEvidence: true, attemptedAt: clock(client), onOutcome: ctx.onMerchantOutcome,
      counters: { merchantPointers: verified.useNum }, limits: { merchantPointers: Math.min(settings.dailyPointerLimit ?? 28,
        verifiedOptions.counter + verifiedOptions.periodRemaining) },
      allowed: () => allowed() && clock(client) <= verified.deadline - verified.saleSeconds
        && evidenceValid(),
      matches: (e, value) => merchantSpeedMatches(e, value, clock(client)),
      send: async () => {
        try {
          if (!allowed() || clock(client) > verified.deadline - verified.saleSeconds
            || !evidenceValid()) throw Error('加速开关、收益证据或成交窗口已变化');
          confirmOrderMaterialSpends(ctx.player, freshStock, [pointer]);
          material = beginOrderMaterialSpend(ctx.player,
            [{ id: pointer, have: verified.have, need: verified.useNum }], '海商王指针加速', {
              operation: { verify: async next => {
                const current = await read(next, 'TradeInfo');
                const window = next.tradeWindow, now = clock(next);
                if (current.period !== window?.period || !windowOpen(window, now)) return false;
                // 旧航程结束后可用随后回读的完整库存重新定基；成交与用针统计独立核对。
                return window.startTime > event.startTime || window.startTime === event.startTime && current.period === event.period
                  && (merchantSpeedMatches(expected, current, now) || merchantSpeedVoyageEnded(expected, fingerprint(current), now));
              } }
            });
          if (!allowed() || clock(client) > verified.deadline - verified.saleSeconds
            || !evidenceValid()) throw Error('加速开关、收益证据或成交窗口已变化');
        } catch (error) {
          cancelOrderMaterialSpend(material);
          throw Object.assign(error, { released: true });
        }
        try {
          return await client.request('TradeSpeedRequest', { useNum: verified.useNum }, 'TradeSpeedResponse');
        } catch (error) {
          if (error.notSent === true || error.prompt && error.request === 'TradeSpeedRequest') {
            cancelOrderMaterialSpend(material);
            if (error.notSent === true) error.released = true;
          }
          throw error;
        }
      },
      accept: reply => natural(reply?.moveEndTime) && reply.moveEndTime <= expected.afterEndTime
        && reply.moveEndTime < expected.beforeEndTime,
      inspect: async () => {
        const current = await read(client, 'TradeInfo');
        if (current.period !== event.period) return null;
        const now = clock(client);
        if (merchantSpeedMatches(expected, current, now)) {
          confirmOrderMaterialOperation(material);
          if (arrivalReasons.has(verified.accelerationReason) || merchantSpeedMode(settings.speedUpMode) === 'goal' || settings.guardLastPointer) {
            const remaining = (current.cargo.moveEndTime ?? 0) - now;
            const checkSoon = remaining <= 0 || settings.guardLastPointer && remaining <= merchantPointerSeconds(config);
            monitor.observe({ event, state: current, time: now, config, settings: fullSettingsOf(ctx), expedite: checkSoon });
          }
        }
        return fingerprint(current);
      }
    });
    // 业务证据在前，完整库存回读在后；库存下降本身不代表加速成功。
    await refreshOrderMaterialSpends(client, ctx.player, { enabled: () => client.connected !== false });
    return true;
  } catch (error) {
    return skip(error.message);
  }
}
