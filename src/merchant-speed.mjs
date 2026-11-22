import { checkedAction, clock, dayOf, natural, positive, read, table, waiting, windowOpen } from './activity-actions.mjs';
import {
  beginOrderMaterialSpend, cancelOrderMaterialSpend, confirmOrderMaterialOperation,
  confirmOrderMaterialSpends, refreshOrderMaterialSpends
} from './order-reservations.mjs';
import { merchantActionSeconds, merchantPointerSeconds, merchantTiming } from './merchant-planner.mjs';
import { buyMerchantPointers, reconcileMerchantAction } from './merchant-strategy.mjs';
import { estimateMerchantRace, merchantCompetitorArrivals } from './merchant-race.mjs';
import { watchMerchant } from './merchant-monitor.mjs';
import { merchantFreeTrips, MERCHANT_PROFIT_GOAL } from './merchant-goal.mjs';

const pointer = '海商王加速';
const param = (config, key) => table(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
const fullSettingsOf = ctx => (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) ?? {};
const settingsOf = ctx => fullSettingsOf(ctx).merchant ?? {};
const stampSettings = ctx => {
  const full = fullSettingsOf(ctx), settings = full.merchant ?? {};
  return JSON.stringify([
    settings.autoSpeedUp, settings.speedUpMinProfit, settings.keepPointers, settings.estimateDiscountPercent,
    settings.quoteMaxAgeSeconds, settings.speedUpMode, settings.guardLastPointer, settings.speedUpMaxPerLeg, full.loop?.everySeconds, ctx.everyMs
    , settings.dailyPointerLimit, settings.refreshWindowMinutes, settings.autoBuyPointers, settings.pointerDailyDiamondLimit, settings.profitLimit,
    settings.minExpectedProfit, settings.liquidationMinutes, settings.maxLossPercent, settings.refreshWaitSeconds,
    settings.firstDepartureMode, settings.firstDepartureTime, ctx.merchantCadenceSeconds
  ]);
};
const fingerprint = state => ({ coins: state.player?.coins, profit: state.player?.profit,
  goods: state.player?.goods, cargo: state.cargo });

function tradeDeadline(config, event, time) {
  const window = merchantTiming(config, event, time);
  return window.tradingOpen ? window.tradeEndTime : null;
}

function turnoverMetrics(options, event, time, maxAge) {
  const value = options.metrics ?? options.turnoverSample ?? options;
  const observedAt = Object.hasOwn(value ?? {}, 'turnoverObservedAt') ? value.turnoverObservedAt : value?.observedAt;
  if (!value || value.period !== event.period || value.startTime !== event.startTime
    || !natural(observedAt) || observedAt > time || time - observedAt > maxAge
    || value.turnoverSampleCount != null && (!natural(value.turnoverSampleCount) || value.turnoverSampleCount < 2)
    || value.turnoverSampleSeconds != null && (!natural(value.turnoverSampleSeconds) || value.turnoverSampleSeconds < 60)
    || !Number.isFinite(value.turnoverProfitPerSecond) || value.turnoverProfitPerSecond <= 0
    || value.turnoverProfitPerSecond > Number.MAX_SAFE_INTEGER) return null;
  return { ...value, turnoverObservedAt: observedAt };
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

// 周转收益只来自同一期近期确认成交；未知未来库存、刷新后报价不能产生额外收益。
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
  const deadline = tradeDeadline(config, event, time);
  if (deadline === null) return none('不在开放交易时段');
  const actionSeconds = Math.max(60, Number.isFinite(options.actionSeconds) ? Math.ceil(options.actionSeconds) : 60);
  const mode = settings.speedUpMode ?? 'profit';
  const perPointer = merchantPointerSeconds(config);
  const guard = settings.guardLastPointer === true && perPointer && cargo.moveEndTime - time <= perPointer;
  const arrivalPolicy = guard ? 'guard' : ['race', 'full'].includes(mode) ? mode : null;
  const refreshMode = ['refresh', 'arrival'].includes(mode);
  const timing = merchantTiming(config, event, time);
  const inRefreshWindow = refreshMode && positive(timing.previousRefreshAt) &&
    time < timing.previousRefreshAt + (settings.refreshWindowMinutes ?? 8) * 60;
  const arrivals = mode === 'race' || mode === 'profit' || inRefreshWindow ? merchantCompetitorArrivals(state, options.actor, time,
    mode === 'race' ? 0 : merchantTiming(config, event, cargo.moveEndTime).previousRefreshAt) : [];
  const firstArrival = arrivals[0];
  if (arrivalPolicy === 'race' && (!firstArrival || firstArrival > cargo.moveEndTime)) {
    return { kind: 'none', leading: !!firstArrival, reason: firstArrival
      ? '自然到港比最早的可见同港同盟船早 ' + (firstArrival - cargo.moveEndTime) + ' 秒，保留指针'
      : '未发现同港在途同盟船，保留指针' };
  }
  const rival = arrivals.findLast(eta => eta <= cargo.moveEndTime);
  const discount = settings.estimateDiscountPercent ?? 10;
  const threshold = settings.speedUpMinProfit ?? 1000;
  const keep = settings.keepPointers ?? 0;
  const maxAge = settings.quoteMaxAgeSeconds ?? 300;
  const maxPerLeg = settings.speedUpMaxPerLeg ?? 4;
  const usedPointers = options.usedPointers ?? 0;
  if (!['deadline', 'profit', 'refresh', 'arrival', 'race', 'full'].includes(mode)
    || (!arrivalPolicy && (!natural(discount) || discount >= 100 || !positive(threshold)))
    || !natural(keep) || !positive(maxAge) || !positive(maxPerLeg) || !natural(usedPointers))
    return wait('商会指针策略参数无效');
  const fullVoyage = Number(param(config, '海商王行驶时间')) * 60;
  // 成交速率与港口报价的时效不同：样本最多使用两段完整航程（或更长的报价配置），新快照不续期。
  const turnoverMaxAge = positive(fullVoyage) ? Math.max(maxAge, fullVoyage * 2) : maxAge;
  const metrics = mode === 'profit' ? turnoverMetrics(options, event, time, turnoverMaxAge) : null;
  const knownMarket = targetMarket(config, event, cargo.moveToCityId, time, maxAge, options);
  const nextRefreshAt = merchantTiming(config, event, time).nextRefreshAt;
  const totalBatches = Array.isArray(state.player?.goods) ? Math.max(1, state.player.goods.length) : null;
  const refreshPossible = mode === 'profit' && knownMarket && positive(nextRefreshAt)
    && cargo.moveEndTime + (totalBatches ?? 1) * actionSeconds >= nextRefreshAt;
  const competing = rival && totalBatches !== null;
  if (!arrivalPolicy && options.exploration && !competing) return none('寻价途中暂无可争取的同盟采购顺位');
  if (!arrivalPolicy && totalBatches !== null && cargo.moveEndTime <= deadline - totalBatches * actionSeconds && !metrics && !refreshPossible && !competing) {
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
  const batches = [];
  for (const good of goods) {
    const cfg = definitions.get(good.goodsId);
    if (!natural(good.pid) || !positive(good.num) || !positive(good.buyPrice) || !positive(good.cityId)
      || !positive(cfg?.capacity) || !positive(cfg.unitPrice)) return wait('持货成本或舱位未确认，不使用指针');
    usedCapacity += cfg.capacity * good.num;
    // 本港特产不能按基准价假设盈利，来源港批次也不可出售。
    if (arrivalPolicy || good.cityId === cargo.moveToCityId) continue;
    const knownPrice = knownQuotes.get(good.goodsId);
    if (good.goodsId === ports[0].specGoodsId && !positive(knownPrice)) continue;
    // 亲自观察到的低价作为保守上限；即使到港已跨报价有效期，也不恢复为较高基准价。
    // 历史高价不抬高估值，所有目的港价格都仍是带风险折扣的估算。
    const basis = Math.min(cfg.unitPrice, knownQuotes.get(good.goodsId) ?? cfg.unitPrice);
    const price = Math.floor(basis * (100 - discount) / 100);
    const gain = Math.floor(Math.max(0, price - good.buyPrice) * good.num * (1 + ship.profitMargin / 10000));
    const quotedGain = positive(knownPrice)
      ? Math.floor(Math.max(0, Math.floor(knownPrice * (100 - discount) / 100) - good.buyPrice) * good.num * (1 + ship.profitMargin / 10000))
      : gain;
    if (!natural(gain) || !natural(quotedGain)) return wait('批次利润计算异常，保留指针');
    if (gain || quotedGain) batches.push({ gain, quotedGain });
  }
  if (!natural(usedCapacity) || usedCapacity > ship.capacity)
    return wait('持货舱位或利润计算异常，不使用指针');
  const have = stock instanceof Map ? stock.get(pointer) ?? 0 : null;
  const available = Math.min(limit, Math.max(0, have - keep));
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
    if (afterEndTime + actionSeconds >= deadline) return wait('加速后仍赶不上本次交易，保留指针');
    const savedSeconds = cargo.moveEndTime - afterEndTime;
    const reason = arrivalPolicy === 'race' ? '预计比最早的可见同港同盟船早 ' + (firstArrival - afterEndTime) + ' 秒到港'
      : arrivalPolicy === 'guard' ? '最后一根防抢，直接到港' : '全程加速，按剩余航时尽快到港';
    const expected = { request: 'TradeSpeedRequest', period: event.period, city: cargo.cityId,
      destination: cargo.moveToCityId, moveStartTime: cargo.moveStartTime, beforeEndTime: cargo.moveEndTime,
      afterEndTime, useNum, accelerationReason: arrivalPolicy, savedSeconds };
    return { kind: 'speed', useNum, have, expected, deadline, saleSeconds: actionSeconds, savedSeconds,
      accelerationReason: arrivalPolicy, rivalEta: arrivalPolicy === 'race' ? firstArrival : null,
      evidenceExpiresAt: Math.min(deadline - actionSeconds - 1, cargo.moveEndTime - 1,
        arrivalPolicy === 'race' ? firstArrival - 1 : Infinity),
      label: '海商王 · 使用商会指针 ×' + useNum + '，' + reason + '，提前 ' + savedSeconds + ' 秒' };
  }
  if (!competing && !batches.length)
    return wait('风险折扣后的目的港估值没有可盈利出售的批次');
  const byGain = [...batches].sort((a, b) => b.gain - a.gain);
  const byQuote = [...batches].sort((a, b) => b.quotedGain - a.quotedGain);
  const quoteUntil = refreshPossible ? Math.min(nextRefreshAt - 1, knownMarket.observedAt + maxAge) : 0;
  const tripProfit = metrics ? Math.min(byGain.reduce((sum, row) => sum + row.gain, 0),
    Math.floor(metrics.turnoverProfitPerSecond * fullVoyage)) : 0;
  // 收盘未售出的货物可以留到下一个开放日。只有本期结束才截断剩余批次。
  const tomorrow = merchantTiming(config, event, (dayOf(time) + 1) * 86400 - 28800);
  const outcome = arrival => {
    const slots = Math.max(0, Math.floor((deadline - arrival - 1) / actionSeconds));
    const quoteSlots = Math.max(0, Math.min(slots, Math.floor((quoteUntil - arrival) / actionSeconds)));
    const quoted = new Set(byQuote.filter(row => row.quotedGain > 0).slice(0, quoteSlots));
    const rest = byGain.filter(row => row.gain > 0 && !quoted.has(row));
    const today = rest.slice(0, slots - quoted.size);
    const saleCount = quoted.size + today.length, saleSeconds = saleCount * actionSeconds;
    const estimatedProfit = today.reduce((sum, row) => sum + row.gain, 0) +
      [...quoted].reduce((sum, row) => sum + row.quotedGain, 0);
    const nextOpen = Math.max(arrival, tomorrow.tradeStartTime);
    const carrySlots = Math.max(0, Math.floor((tomorrow.tradeEndTime - nextOpen - 1) / actionSeconds));
    const carried = rest.slice(today.length, today.length + carrySlots);
    const readyAt = carried.length ? nextOpen + carried.length * actionSeconds : arrival + saleSeconds;
    const trips = tripProfit > 0 ? merchantFreeTrips(config, event, readyAt, actionSeconds, settings, batches.length, cargo.moveStartTime) : 0;
    const cargoProfit = carried.reduce((sum, row) => sum + row.gain, estimatedProfit);
    return { saleCount, saleSeconds, estimatedProfit, cargoProfit, trips,
      quoted: [...quoted].some(row => row.quotedGain > row.gain), projected: cargoProfit + trips * tripProfit };
  };
  const normal = outcome(cargo.moveEndTime);
  if (!natural(normal.projected)) return wait('自然航程利润估算异常，保留指针');
  const gap = remaining - normal.projected;
  if (gap <= 0) return none('按当前持货和可完成的免费航次估算可达目标，保留指针');
  if (normal.saleCount === batches.length && !metrics && !refreshPossible && !competing)
    return none('正常到港后足够完成可盈利批次出售，无需加速');
  if (!natural(have)) return wait('商会指针库存未同步');
  if (!available) return wait('留足保留量或本航程用量上限后的商会指针不足');
  const candidates = [];
  const estimateRace = competing && estimateMerchantRace(config, event, state, radar, time, settings, options, rival, actionSeconds);
  for (let useNum = 1; useNum <= available; useNum++) {
    const afterEndTime = Math.max(time, cargo.moveEndTime - useNum * perPointer);
    const savedSeconds = cargo.moveEndTime - afterEndTime;
    const accelerated = outcome(afterEndTime);
    const { saleCount, saleSeconds, estimatedProfit } = accelerated;
    const race = estimateRace && estimateRace(afterEndTime);
    if (race) {
      // 历史采购机会与速率估算可能描述同一趟。比较两条自然路线，避免重复计利。
      const baseline = Math.max(normal.projected, normal.cargoProfit + race.baseline);
      const raceGap = remaining - baseline;
      if (raceGap <= 0) return none('自然到港估算可凭现货与后续采购达到目标，保留指针');
      const gain = Math.min(normal.cargoProfit, accelerated.cargoProfit) + race.baseline + race.gain - baseline;
      if (natural(gain) && gain >= threshold * useNum) candidates.push({
        useNum, afterEndTime, savedSeconds, estimatedIncrementalProfit: gain, accelerationReason: 'stockRace',
        goalProgress: Math.min(raceGap, gain), reachesGoal: gain >= raceGap,
        saleCount, saleSeconds, estimatedProfit, evidenceExpiresAt: Math.min(deadline, race.expiresAt,
          inRefreshWindow ? timing.previousRefreshAt + (settings.refreshWindowMinutes ?? 8) * 60 - 1 : Infinity)
      });
    }
    if (options.exploration || !saleCount) continue;
    const incrementalProfit = accelerated.projected - normal.projected;
    if (!natural(incrementalProfit) || !positive(incrementalProfit) || incrementalProfit / useNum < threshold) continue;
    const extraTrips = accelerated.trips - normal.trips;
    const accelerationReason = accelerated.quoted ? 'refresh' : extraTrips > 0 ? 'turnover' : 'deadline';
    candidates.push({ useNum, afterEndTime, savedSeconds, estimatedIncrementalProfit: incrementalProfit,
      accelerationReason, saleCount, saleSeconds, estimatedProfit, extraTrips,
      goalProgress: Math.min(gap, incrementalProfit), reachesGoal: incrementalProfit >= gap,
      evidenceExpiresAt: Math.min(deadline,
        extraTrips > 0 ? metrics.turnoverObservedAt + turnoverMaxAge : deadline,
        accelerated.quoted ? quoteUntil : deadline) });
  }
  if (!candidates.length) return wait(competing ? '当前用量和时间内，缺少抢先采购能达到收益门槛的记录' : '指针不足、成交窗口或收益阈值不满足，不盲目部分加速');
  // 达标先取最少根数；差距较大时让每根指针尽量多推进目标。
  candidates.sort((a, b) => Number(b.reachesGoal) - Number(a.reachesGoal) ||
    (a.reachesGoal ? a.useNum - b.useNum : b.goalProgress / b.useNum - a.goalProgress / a.useNum) ||
    a.useNum - b.useNum || b.goalProgress - a.goalProgress);
  const best = candidates[0], { useNum, savedSeconds, estimatedIncrementalProfit, accelerationReason } = best;
  const reasonLabel = { deadline: '抢救截止成交', turnover: '按近期确认成交速率估算可多跑 ' + best.extraTrips + ' 程', refresh: '抢在刷新前兑现已观察报价',
    stockRace: '早于可见同盟船采购，按目的港历史库存估算新货差额' }[accelerationReason];
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

// 自然到港不能作为未知加速请求的成功证据，必须确认同一航程被提前。
export function merchantSpeedMatches(expected, snapshot, time) {
  const cargo = snapshot?.cargo;
  if (expected?.request !== 'TradeSpeedRequest' || !cargo || !positive(expected.beforeEndTime)
    || !natural(expected.afterEndTime) || expected.afterEndTime >= expected.beforeEndTime
    || !positive(expected.moveStartTime) || cargo.moveStartTime !== expected.moveStartTime) return false;
  if (cargo.cityId === expected.destination && time < expected.beforeEndTime
    && (!cargo.moveToCityId || cargo.moveToCityId === expected.destination)) return true;
  return cargo.cityId === expected.city && cargo.moveToCityId === expected.destination
    && positive(cargo.moveEndTime) && cargo.moveEndTime < expected.beforeEndTime
    && cargo.moveEndTime <= expected.afterEndTime;
}

async function readStock(client) {
  const response = await read(client, 'AllItem'), stock = new Map();
  if (!Array.isArray(response?.items)) throw Error('商会指针完整库存未同步');
  for (const row of response.items) {
    if (typeof row?.itemId !== 'string' || !row.itemId || stock.has(row.itemId) || !natural(row.num))
      throw Error('商会指针完整库存记录无效');
    stock.set(row.itemId, row.num);
  }
  return stock;
}

export async function runMerchantSpeed(client, config, ctx, event, state) {
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
  const pending = records.find(([, record]) => !record.confirmed && record.details?.scope === 'merchant:' + event.startTime + ':' + event.period &&
    record.details.expected?.request === 'TradeSpeedRequest');
  if (pending) {
    await reconcileMerchantAction(client, ctx, pending, fingerprint(state), merchantSpeedMatches);
    return true;
  }
  const exploratoryLeg = records.some(([, record]) => {
    const expected = record.details?.expected, cargo = state.cargo;
    return record.confirmed && record.details?.scope === 'merchant:' + event.startTime + ':' + event.period
      && expected?.request === 'TradeMoveRequest' && expected.exploration === true
      && expected.city === cargo.cityId && expected.destination === cargo.moveToCityId
      && Math.abs(expected.start - cargo.moveStartTime) <= 2;
  });
  // 不需要加速时不查询库存；其余缺失输入会在获取新快照后校验。
  const actionSeconds = () => positive(ctx.merchantCadenceSeconds) ? Math.max(60, ctx.merchantCadenceSeconds)
    : merchantActionSeconds(fullSettingsOf(ctx), Math.ceil((ctx.everyMs ?? 0) / 1000));
  const metricsOf = () => typeof ctx.getMerchantMetrics === 'function' ? ctx.getMerchantMetrics()
    : typeof ctx.merchantMetrics === 'function' ? ctx.merchantMetrics() : ctx.merchantMetrics;
  const options = () => {
    const all = Object.values(ctx.ledger?.keyRecords() ?? {});
    const records = all.filter(record => record.confirmed);
    const usedPointers = records.reduce((sum, record) => {
      const e = record.details?.expected, cargo = state.cargo;
      return record.details?.scope === 'merchant:' + event.startTime + ':' + event.period && e?.request === 'TradeSpeedRequest'
        && e.period === event.period && e.city === cargo.cityId && e.destination === cargo.moveToCityId
        && e.moveStartTime === cargo.moveStartTime && positive(e.useNum) ? sum + e.useNum : sum;
    }, 0);
    return { actionSeconds: actionSeconds(), metrics: metricsOf(), usedPointers, actor: ctx.player, exploration: exploratoryLeg,
      marketHistory: records.find(record => record.details?.merchantJournal?.event?.startTime === event.startTime &&
        record.details.merchantJournal.event.period === event.period)?.details.merchantJournal.snapshots?.map(entry => ({
          ...entry.market, held: entry.state?.player?.goods, visitStart: entry.state?.cargo?.moveStartTime
        })),
      dailyUsed: Math.max(ctx.ledger?.snapshot().counters?.merchantPointers ?? 0,
        all.reduce((sum, record) => {
          const e = record.details?.expected, at = record.details?.attemptedAt;
          return e?.request === 'TradeSpeedRequest' && positive(at) && dayOf(at) === dayOf(clock(client)) && positive(e.useNum) ? sum + e.useNum : sum;
        }, 0)),
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
    const plan = planMerchantSpeed(config, event, state, radar, stock, settings, clock(client), options());
    const keep = settings.keepPointers ?? 0, maxStock = keep + (settings.speedUpMaxPerLeg ?? 4);
    if (settings.autoBuyPointers && (stock.get(pointer) ?? 0) < maxStock) {
      const purchasePlan = (info, have, possible, ports = radar) => {
        const now = clock(client), input = options();
        const evaluate = (count, at) => planMerchantSpeed(config, event, info, ports, new Map([[pointer, count]]), settings, at, input);
        // 购买占用本轮动作。下一轮仍能兑现的机会才值得补购。
        const next = now + input.actionSeconds;
        if (dayOf(next) !== dayOf(now)) return null;
        const desired = evaluate(possible, next);
        if (desired.kind !== 'speed' || desired.useNum + keep <= have) return null;
        const baseline = evaluate(have, now);
        const count = desired.useNum + keep - have;
        if (['race', 'full', 'guard'].includes(desired.accelerationReason)) {
          const obtainableNow = evaluate(possible, now);
          if (obtainableNow.kind !== 'speed' || obtainableNow.accelerationReason !== desired.accelerationReason ||
            obtainableNow.rivalEta !== desired.rivalEta) return null;
          const currentEta = baseline.expected?.afterEndTime ?? info.cargo.moveEndTime;
          return desired.expected.afterEndTime < currentEta ? { count, expiresAt: desired.evidenceExpiresAt, expedite: true } : null;
        }
        if (baseline.reachesGoal || desired.goalProgress <= (baseline.goalProgress ?? 0)) return null;
        // 门槛同时覆盖额外动用的指针和实际需要买的根数。
        const extra = Math.max(count, desired.useNum - (baseline.useNum ?? 0));
        return desired.estimatedIncrementalProfit - (baseline.estimatedIncrementalProfit ?? 0) >= extra * (settings.speedUpMinProfit ?? 1000)
          ? { count, expiresAt: desired.evidenceExpiresAt } : null;
      };
      if (purchasePlan(state, stock.get(pointer) ?? 0, maxStock) &&
        await buyMerchantPointers(client, config, ctx, event, state, purchasePlan, allowed)) return true;
    }
    if (plan.kind !== 'speed') return plan.kind === 'none' ? false : skip(plan.reason);
    const fresh = await read(client, 'TradeInfo');
    const freshRadar = await read(client, 'TradeGuildRadar');
    const freshStock = await readStock(client);
    if (!allowed()) return skip('加速开关或活动状态已变化');
    const verifiedAt = clock(client), verifiedOptions = options();
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
    const metricStamp = JSON.stringify(metricsOf());
    const evidenceValid = () => {
      const now = clock(client);
      if (now > verified.evidenceExpiresAt || JSON.stringify(metricsOf()) !== metricStamp) return false;
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
      counters: { merchantPointers: verified.useNum }, limits: { merchantPointers: settings.dailyPointerLimit ?? 28 },
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
                return next.tradeWindow?.startTime === event.startTime && current.period === event.period
                  && merchantSpeedMatches(expected, current, clock(next));
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
          if (['race', 'full', 'guard'].includes(verified.accelerationReason) || settings.guardLastPointer) {
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
