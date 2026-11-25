// 海商王的纯决策层。异地卖价依据已知商情估算，成交使用到港实价。
import { fillRankedMerchantLoad, fullMerchantLoad } from './merchant-loading.mjs';
const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => natural(value) && value > 0;
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const param = (config, key) => rows(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
const dayOf = time => Math.floor((time + 28800) / 86400);
const safe = value => Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const tradeDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
});

export const MERCHANT_DEFAULTS = Object.freeze({
  fullCargoRoutes: false,
  knownPortChains: true,
  minPurchaseReturnPercent: 0,
  autoShareIntel: false,
  quoteMaxAgeSeconds: 300,
  estimateDiscountPercent: 0,
  refreshWaitSeconds: 120,
  liquidationMinutes: 120,
  maxLossPercent: 0,
  minExpectedProfit: 1,
  autoSpeedUp: false,
  keepPointers: 0,
  speedUpMode: 'deadline', guardLastPointer: false, speedUpMaxPerLeg: 4, monitorSeconds: 60,
  refreshWindowMinutes: 8, dailyPointerLimit: 28, periodPointerLimit: -1, speedUpIntelPorts: 0, autoBuyPointers: false, pointerDailyDiamondLimit: 0,
  profitLimit: 0, firstDepartureMode: 'smart', firstDepartureTime: '10:00', firstDepartureWaitMinutes: 29,
  autoUpgrade: false
});

export function merchantSpeedMode(value = MERCHANT_DEFAULTS.speedUpMode) {
  if (value === 'eventFree' || value === 'targetFirst') return 'goal';
  return value === 'profit' ? 'deadline' : value;
}

export function merchantSettings(input = {}) {
  const output = { ...MERCHANT_DEFAULTS };
  for (const [key, fallback] of Object.entries(output)) {
    const value = input?.[key];
    if (typeof fallback === 'boolean') output[key] = typeof value === 'boolean' ? value : fallback;
    else if (key === 'speedUpMode') output[key] = ['deadline', 'refresh', 'arrival', 'race', 'full', 'goal', 'targetFirst', 'eventFree'].includes(value) ? value : fallback;
    else if (key === 'firstDepartureMode') output[key] = ['smart', 'time'].includes(value) ? value : fallback;
    else if (key === 'firstDepartureTime') output[key] = typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    else if (natural(value)) output[key] = value;
  }
  output.estimateDiscountPercent = Math.min(100, output.estimateDiscountPercent);
  output.minPurchaseReturnPercent = Math.min(100, output.minPurchaseReturnPercent);
  output.maxLossPercent = Math.min(100, output.maxLossPercent);
  output.monitorSeconds = Math.max(10, Math.min(300, output.monitorSeconds));
  return output;
}

// 周期动作每轮只执行一笔，使用配置与实际轮询间隔中较慢者，并保留最低一分钟余量。
export function merchantActionSeconds(settings = {}, intervalSeconds = 0) {
  const configured = settings?.loop?.everySeconds;
  return Math.max(60, positive(configured) ? configured : 0, positive(intervalSeconds) ? intervalSeconds : 0);
}

export function merchantPointerSeconds(config) {
  const seconds = Number(param(config, '海商王加速时长')) * 60;
  return positive(seconds) ? seconds : null;
}

export function merchantGoalSalePrice(definition, port, knownPrice, discount) {
  if (port.specGoodsId === definition.goodsId && !positive(knownPrice)) return 0;
  return Math.floor(Math.min(definition.unitPrice, knownPrice ?? definition.unitPrice) * (100 - discount) / 100);
}

// 用针只能采用本船目的港的证据。当天已知紧缺且有实测样本时，采用保守估价；
// 跨开市、情报缺失或样本不足时仍使用原基准价上限。
export function merchantSpeedSalePrices(config, event, radar, markets, time, origin, targetCity, settings) {
  const timing = merchantTiming(config, event, time);
  const { ports, history, pastRounds } = portsAndHistory(config, event, radar, markets, time, settings, timing.marketEpoch);
  const target = ports.find(p => p.cityId === targetCity);
  const defs = new Map(rows(config, 'TradeGoodsCfg').map(g => [g.goodsId, g]));
  const def = defs.get(target?.rareGoodsId);
  if (!def || target.specGoodsId === def.goodsId) return null;
  const peers = comparableQuotes(history, pastRounds, defs);
  const quote = expectedPrice(def, target, history.get(targetCity), pastRounds.get(targetCity), peers, origin, false, settings.estimateDiscountPercent);
  return quote ? { goodsId: def.goodsId, price: quote.price } : null;
}

export function merchantTiming(config, event, time) {
  const hours = String(param(config, '海商王贸易时间')).split('-').map(Number);
  const travelMinutes = Number(param(config, '海商王行驶时间'));
  const refresh = [...new Set(String(param(config, '海商王刷新时间')).split(',').map(Number))]
    .filter(hour => natural(hour) && hour < 24).sort((a, b) => a - b);
  const day = dayOf(time), midnight = day * 86400 - 28800;
  const validHours = hours.length === 2 && hours.every(natural) && hours[0] < hours[1] && hours[1] <= 24;
  const tradeStartTime = validHours ? midnight + hours[0] * 3600 : null;
  const tradeEndTime = validHours ? Math.min(midnight + hours[1] * 3600, event?.endTime ?? Infinity) : null;
  const candidates = [-1, 0, 1].flatMap(offset => refresh.map(hour => midnight + offset * 86400 + hour * 3600));
  const previousRefreshAt = candidates.filter(at => at <= time).at(-1) ?? null;
  const nextRefreshAt = candidates.find(at => at > time) ?? null;
  return {
    travelSeconds: positive(travelMinutes) ? travelMinutes * 60 : null,
    tradeStartTime,
    tradeEndTime,
    tradingOpen: validHours && time >= tradeStartTime && time < tradeEndTime,
    nextRefreshAt,
    previousRefreshAt,
    marketEpoch: previousRefreshAt === null ? day + ':unknown' : dayOf(previousRefreshAt) + ':' + ((previousRefreshAt + 28800) % 86400) / 3600
  };
}

// 活动可能在夜间结束；最后一程从最后一个实际交易窗口的收盘向前推算。
export function merchantFinalCargoStart(timing, event, policy, goods, destination) {
  if (!policy?.autoSpeedUp || merchantSpeedMode(policy.speedUpMode) !== 'deadline' || !timing.tradingOpen || !positive(timing.travelSeconds) ||
    !positive(event?.endTime) || event.endTime > timing.tradeStartTime + 86400 || !positive(destination) ||
    !Array.isArray(goods) || !goods.some(g => positive(g?.num) && positive(g.cityId) && g.cityId !== destination)) return null;
  return Math.max(timing.tradeStartTime, timing.tradeEndTime - timing.travelSeconds);
}

// 二元分组有界背包；两项资源同时做 Pareto 剪枝。小状态空间精确求解，
// 大状态空间以剩余资源的收益上界保留有限候选，并明确返回 approximate。
export function optimizePurchasePlan(offers, capacity, cash, { maxStates = 2048, maxTypes = offers.length } = {}) {
  const empty = { purchases: [], profit: 0, cost: 0, capacity: 0, approximate: false };
  if (!natural(capacity) || !natural(cash) || !positive(maxTypes)) return empty;
  const items = offers.filter(o => o && positive(o.goodsId) && positive(o.price) && positive(o.capacity) &&
    positive(o.count) && Number.isFinite(o.unitProfit) && o.unitProfit > 0)
    .map(o => ({ ...o, count: Math.min(o.count, Math.floor(capacity / o.capacity), Math.floor(cash / o.price)) }))
    .filter(o => o.count > 0).sort((a, b) => a.goodsId - b.goodsId);
  const limit = Math.max(32, Math.min(16384, natural(maxStates) ? maxStates : 2048));
  const profitFor = (item, count) => Math.ceil(item.profitBasis != null
    ? item.profitBasis * count / 10000 : item.unitProfit * count);
  if (maxTypes === 1 || items.length <= 1) {
    let best = empty;
    for (const item of items) {
      const { count } = item, gain = profitFor(item, count), cost = item.price * count, space = item.capacity * count;
      if (gain > best.profit || (gain === best.profit && (cost < best.cost || (cost === best.cost && space < best.capacity))))
        best = { purchases: [{ ...item, gain }], profit: gain, cost, capacity: space, approximate: false };
    }
    return best;
  }
  // 可完全枚举时按每批结算后的整数利润比较，不丢失分批取整的收益。
  if (items.reduce((total, item) => total * (item.count + 1), 1) <= limit) {
    let best = empty;
    const selected = [];
    const visit = (index, cost, space, profit) => {
      if (index === items.length || selected.length === maxTypes) {
        if (profit > best.profit || (profit === best.profit && (cost < best.cost || (cost === best.cost && space < best.capacity))))
          best = { purchases: selected.slice(), profit, cost, capacity: space, approximate: false };
        return;
      }
      const item = items[index];
      visit(index + 1, cost, space, profit);
      const available = Math.min(item.count, Math.floor((cash - cost) / item.price), Math.floor((capacity - space) / item.capacity));
      for (let count = 1; count <= available; count++) {
        const gain = profitFor(item, count);
        selected.push({ ...item, count, gain });
        visit(index + 1, cost + item.price * count, space + item.capacity * count, profit + gain);
        selected.pop();
      }
    };
    visit(0, 0, 0, 0);
    return best;
  }
  const bundles = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    for (let count = 1, left = item.count; left > 0; count *= 2) {
      const num = Math.min(count, left);
      bundles.push({ index, count: num, space: num * item.capacity, cost: num * item.price, gain: num * item.unitProfit });
      left -= num;
    }
  }
  const density = new Array(bundles.length + 1).fill(0), roi = [...density];
  for (let i = bundles.length - 1; i >= 0; i--) {
    density[i] = Math.max(density[i + 1], bundles[i].gain / bundles[i].space);
    roi[i] = Math.max(roi[i + 1], bundles[i].gain / bundles[i].cost);
  }
  const typeLimited = maxTypes < items.length;
  let states = [{ space: 0, cost: 0, gain: 0, types: 0, path: null }];
  let approximate = items.some(item => !Number.isInteger(item.unitProfit));
  for (let step = 0; step < bundles.length; step++) {
    const bundle = bundles[step], candidates = [...states];
    for (const old of states) {
      const space = old.space + bundle.space, cost = old.cost + bundle.cost;
      const types = old.types + Number(old.path?.index !== bundle.index);
      if (space > capacity || cost > cash || types > maxTypes) continue;
      candidates.push({ space, cost, types, gain: old.gain + bundle.gain,
        path: { previous: old.path, index: bundle.index, count: bundle.count } });
    }
    candidates.sort((a, b) => a.space - b.space || a.cost - b.cost || b.gain - a.gain);
    const costs = [...new Set(candidates.map(s => s.cost))].sort((a, b) => a - b);
    const indices = new Map(costs.map((cost, i) => [cost, i + 1]));
    const groups = new Map(), frontier = [];
    for (const candidate of candidates) {
      // 只有剩余种类名额和本种是否已占名额相同的状态才可相互淘汰。
      const group = typeLimited ? 2 * candidate.types + Number(candidate.path?.index === bundle.index) : 0;
      if (!groups.has(group)) groups.set(group, new Float64Array(costs.length + 1).fill(-Infinity));
      const best = groups.get(group);
      const index = indices.get(candidate.cost);
      let previous = -Infinity;
      for (let i = index; i > 0; i -= i & -i) previous = Math.max(previous, best[i]);
      if (previous >= candidate.gain) continue;
      frontier.push(candidate);
      for (let i = index; i < best.length; i += i & -i) best[i] = Math.max(best[i], candidate.gain);
    }
    if (frontier.length > limit) {
      approximate = true;
      const bound = state => state.gain + Math.min((capacity - state.space) * density[step + 1], (cash - state.cost) * roi[step + 1]);
      frontier.sort((a, b) => bound(b) - bound(a) || b.gain - a.gain || a.cost - b.cost || a.space - b.space);
      frontier.length = limit;
    }
    states = frontier;
  }
  states.sort((a, b) => b.gain - a.gain || a.cost - b.cost || a.space - b.space);
  const best = states[0], counts = new Array(items.length).fill(0);
  for (let path = best.path; path; path = path.previous) counts[path.index] += path.count;
  const purchases = items.flatMap((item, i) => counts[i] ? [{ ...item, count: counts[i], gain: profitFor(item, counts[i]) }] : []);
  let plan = { purchases, profit: purchases.reduce((sum, item) => sum + item.gain, 0), cost: best.cost, capacity: best.space, approximate };
  // 状态裁剪可能漏掉低单价或低占舱货物。用两种能实际装船的方案校验结果下限。
  if (approximate) for (const resource of ['price', 'capacity']) {
    const ordered = [...items].sort((a, b) => b.unitProfit / b[resource] - a.unitProfit / a[resource] || a.goodsId - b.goodsId);
    const candidate = { ...empty, purchases: [], approximate };
    for (const item of ordered) {
      if (candidate.purchases.length === maxTypes) break;
      const count = Math.min(item.count, Math.floor((cash - candidate.cost) / item.price),
        Math.floor((capacity - candidate.capacity) / item.capacity));
      if (!count) continue;
      const gain = profitFor(item, count);
      candidate.purchases.push({ ...item, count, gain });
      candidate.cost += count * item.price;
      candidate.capacity += count * item.capacity;
      candidate.profit += gain;
    }
    if (candidate.profit > plan.profit || (candidate.profit === plan.profit &&
      (candidate.cost < plan.cost || (candidate.cost === plan.cost && candidate.capacity < plan.capacity)))) plan = candidate;
  }
  return plan;
}

function portsAndHistory(config, event, radar, snapshots, time, settings, epoch) {
  const ports = new Map(), conflicting = new Set(), history = new Map(), pastRounds = new Map();
  for (const port of Array.isArray(radar?.radar) ? radar.radar : []) {
    if (!positive(port?.cityId)) continue;
    const old = ports.get(port.cityId);
    if (old && (old.specGoodsId !== port.specGoodsId || old.rareGoodsId !== port.rareGoodsId)) conflicting.add(port.cityId);
    else ports.set(port.cityId, port);
  }
  for (const city of conflicting) ports.delete(city);
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (snapshot?.period !== event.period || snapshot.startTime !== event.startTime || !positive(snapshot.cityId) ||
      !natural(snapshot.observedAt) || snapshot.observedAt > time) continue;
    // 当前港口列表是航行权限的依据；历史记录不能自行增加目的港。
    if (!ports.has(snapshot.cityId) || snapshot.observedAt < event.startTime || !Array.isArray(snapshot.goods) ||
      !snapshot.goods.every(g => g && positive(g.goodsId) && positive(g.price)) ||
      new Set(snapshot.goods.map(g => g.goodsId)).size !== snapshot.goods.length) continue;
    const round = merchantTiming(config, event, snapshot.observedAt).marketEpoch;
    if (round === epoch) {
      if (time - snapshot.observedAt <= settings.quoteMaxAgeSeconds &&
        (!history.has(snapshot.cityId) || history.get(snapshot.cityId).observedAt < snapshot.observedAt)) history.set(snapshot.cityId, snapshot);
    } else {
      if (!pastRounds.has(snapshot.cityId)) pastRounds.set(snapshot.cityId, new Map());
      const rounds = pastRounds.get(snapshot.cityId);
      if (!rounds.has(round) || rounds.get(round).observedAt < snapshot.observedAt) rounds.set(round, snapshot);
    }
  }
  return { ports: [...ports.values()].sort((a, b) => a.cityId - b.cityId), history, pastRounds };
}

function marketRole(port, goodsId) {
  if (port.specGoodsId === goodsId) return '特产';
  if (port.rareGoodsId === goodsId) return '紧缺';
  return positive(port.specGoodsId) && positive(port.rareGoodsId) ? '普通' : null;
}

const priceTier = def => positive(def.qualityIndex) ? '品质' + def.qualityIndex : '基准价' + def.unitPrice;
const median = values => {
  values.sort((a, b) => a - b);
  return Math.floor((values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2);
};
const changeLabel = (price, base) => (price >= base ? '+' : '') + ((price / base - 1) * 100).toFixed(2) + '%';
const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const versusBase = (price, base) => price === base ? '与基准价持平' :
  '较基准价' + (price > base ? '高 ' : '低 ') + amount.format(Math.abs(price - base) * 100 / base) + '%';

function comparableQuotes(markets, pastRounds, definitions) {
  const ordinary = new Map(), shortages = [];
  const addShortage = (city, market, current) => {
    const id = market.rareGoodsId, def = definitions.get(id);
    if (!positive(def?.unitPrice) || id === market.specGoodsId) return;
    const quote = market.goods.find(g => g.goodsId === id);
    if (positive(quote?.price)) shortages.push({ city, goodsId: id, tier: priceTier(def), price: quote.price, base: def.unitPrice, current });
  };
  for (const [city, market] of markets) {
    addShortage(city, market, true);
    for (const quote of market.goods) {
      const def = definitions.get(quote.goodsId);
      if (!positive(def?.unitPrice) || !positive(quote.price) || marketRole(market, quote.goodsId) !== '普通') continue;
      const tier = priceTier(def);
      if (!ordinary.has(tier)) ordinary.set(tier, []);
      ordinary.get(tier).push({ city, goodsId: quote.goodsId, price: quote.price, base: def.unitPrice });
    }
  }
  for (const [city, rounds] of pastRounds)
    for (const market of rounds.values()) addShortage(city, market, false);
  return { ordinary, shortages };
}

function shortageReference(def, quotes, origin) {
  const eligible = quotes.filter(q => q.city !== origin || q.goodsId !== def.goodsId);
  const tier = priceTier(def), sameTier = eligible.filter(q => q.tier === tier);
  const current = sameTier.filter(q => q.current);
  const lowest = (samples, source) => ({ basis: Math.floor(Math.min(...samples.map(q => def.unitPrice * q.price / q.base))), source });
  if (current.length) return lowest(current, '同档紧缺货最低涨跌幅');
  if (sameTier.length) return lowest(sameTier, '本期历史同档紧缺货最低涨跌幅');
  // 跨档只迁移相对于各自基准价的涨跌幅；单个港口的一轮报价不足以支持跨档估价。
  return eligible.length >= 2 ? lowest(eligible, '本期跨档紧缺货最低涨跌幅') : null;
}

function expectedPrice(def, port, snapshot, pastRounds, peers, origin, freshAtArrival, discount) {
  if (!positive(def?.unitPrice)) return null;
  const role = marketRole(port, def.goodsId);
  const quote = snapshot?.goods.find(g => g.goodsId === def.goodsId);
  let basis = def.unitPrice, source = '商品基准价';
  if (quote && freshAtArrival) {
    basis = quote.price;
    source = '目的港到访报价';
  } else {
    // 每轮每港只贡献一个样本，且特产、紧缺状态须与本次估价一致。
    const past = [];
    for (const round of pastRounds?.values() ?? []) {
      if (marketRole(round, def.goodsId) !== (role ?? '普通')) continue;
      const price = round.goods.find(g => g.goodsId === def.goodsId)?.price;
      if (positive(price)) past.push(price);
    }
    if (!role) {
      // 当天紧缺尚未共享。只用本港同货已确认的普通报价，以一份基准价缓和稀少样本。
      basis = median([def.unitPrice, ...past]);
      source = past.length ? '紧缺未确认，基准价与目的港' + past.length + '轮同商品普通报价中位数' : '紧缺未确认，采用商品基准价';
    } else if (past.length >= 2) {
      basis = median(past);
      source = '目的港' + past.length + '轮同商品' + role + '报价中位数';
    } else if (role === '特产') {
      if (!quote) return null;
    } else if (role === '紧缺') {
      const reference = shortageReference(def, peers.shortages, origin);
      if (reference) {
        basis = reference.basis;
        source = reference.source;
      }
    } else {
      // 以各商品自己的基准价换算涨跌幅，排除本港该商品的买入报价。
      const samples = (peers.ordinary.get(priceTier(def)) ?? [])
        .filter(s => s.city !== origin || s.goodsId !== def.goodsId)
        .map(s => def.unitPrice * s.price / s.base);
      if (samples.length >= 2) {
        basis = median(samples);
        source = '同档普通货涨跌幅中位数';
      }
      if (past.length === 1) {
        basis = median([past[0], basis]);
        source = '目的港一轮同商品普通报价与' + source + '的均值';
      }
    }
    if (quote && quote.price <= basis) {
      basis = quote.price;
      source = '目的港已见报价保守估算';
    }
  }
  return { price: Math.floor(basis * (100 - discount) / 100), referencePrice: basis, source };
}

const profit = (price, batch, ship) => {
  const difference = (price - batch.buyPrice) * batch.num;
  return difference > 0 ? Math.ceil(difference * (10000 + ship.profitMargin) / 10000) : difference;
};

// 用已确认的出航快照辨认隔夜货。到港后新买的批次不能继承这趟的亏损出售规则。
export function merchantOpeningCargo(leg, state) {
  const e = leg?.expected, cargo = state?.cargo;
  if (!positive(e?.plannedOpening) || e.destination !== cargo?.cityId || !Array.isArray(state?.player?.goods)) return [];
  const started = leg.after?.cargo?.moveStartTime;
  if (positive(cargo.moveStartTime) && (positive(started) ? cargo.moveStartTime !== started :
    positive(e.start) && Math.abs(cargo.moveStartTime - e.start) > 2)) return [];
  const loaded = leg.before?.goods ?? leg.before?.player?.goods;
  if (!Array.isArray(loaded)) return [];
  return state.player.goods.filter(b => b && b.cityId !== cargo.cityId && loaded.some(old => old?.pid === b.pid &&
    old.goodsId === b.goodsId && old.cityId === b.cityId && old.buyPrice === b.buyPrice && b.num <= old.num)).map(b => b.pid);
}

function openingLoad(market, shortage, definitions, space, cash, maxTypes, held, ports, minReturn = 0) {
  if (!space || !cash || maxTypes < 1) return [];
  const salePorts = ports.filter(p => definitions.has(p.specGoodsId) && held.every(b => b.goodsId !== p.specGoodsId));
  const canAvoidSpecialty = id => salePorts.some(p => p.specGoodsId !== id);
  const offers = market.goods.flatMap(({ goodsId, price, stock }) => {
    const def = definitions.get(goodsId);
    if (goodsId === shortage || !positive(price) || price > cash || !natural(stock) ||
      !positive(def?.capacity) || def.capacity > space || !positive(def.unitPrice) ||
      !positive(def.maxCount) || stock >= def.maxCount) return [];
    return [{ goodsId, price, capacity: def.capacity, basePrice: def.unitPrice, count: def.maxCount - stock }];
  }).sort((a, b) => a.price / a.basePrice - b.price / b.basePrice ||
    Number(canAvoidSpecialty(b.goodsId)) - Number(canAvoidSpecialty(a.goodsId)) ||
    a.price / a.capacity - b.price / b.capacity || a.goodsId - b.goodsId);
  // 次日紧缺未定，用基准价衡量折扣所留下的利润空间，并同时约束本金和舱位。
  let load = minReturn > 0 ? optimizePurchasePlan(offers.filter(item => canAvoidSpecialty(item.goodsId) &&
    (item.basePrice - item.price) * 100 >= minReturn * item.price)
    .map(item => ({ ...item, unitProfit: item.basePrice - item.price })), space, cash, { maxTypes }).purchases :
    fillRankedMerchantLoad(offers, space, cash, maxTypes);
  if (!load.length && !minReturn) {
    // 无法满舱时先求可装格数，再在同等格数下优先挑折价货。
    const partial = optimizePurchasePlan(offers.map(item => ({ ...item, unitProfit: item.capacity })), space, cash, { maxTypes });
    load = fillRankedMerchantLoad(offers, partial.capacity, cash, maxTypes);
  }
  if (load.length !== 1) return load;
  const [item] = load, aboard = id => held.reduce((n, b) => n + (b.goodsId === id ? b.num : 0), 0);
  // 同成本、同基准价、同占舱且有合适销港时，用第二个品种分担单一货价下跌的风险。
  const other = offers.find(o => o.goodsId !== item.goodsId && o.price === item.price && o.basePrice === item.basePrice &&
    o.capacity === item.capacity && salePorts.some(p => p.specGoodsId !== o.goodsId && p.specGoodsId !== item.goodsId));
  if (!other) return load;
  const n = Math.min(other.count, item.count, Math.max(0, Math.floor((aboard(item.goodsId) + item.count - aboard(other.goodsId)) / 2)));
  if (!n || (n < item.count && maxTypes < 2)) return load;
  return [...(n < item.count ? [{ ...item, count: item.count - n }] : []), { ...other, count: n }];
}

// 首轮采购前只有固定特产可作比较。基准价只衡量这笔本金与舱位能承接多少货值。
function openingPurchasePort(ports, city, specialty, definitions, coins, space) {
  const candidates = [{ ...ports.find(p => p.cityId === city), cityId: city, specGoodsId: specialty },
    ...ports.filter(p => p.cityId !== city)];
  const ranked = candidates.map(port => {
    const def = definitions.get(port.specGoodsId);
    const units = positive(def?.unitPrice) && positive(def.capacity) && positive(def.maxCount)
      ? Math.min(def.maxCount, Math.floor(coins / def.unitPrice), Math.floor(space / def.capacity)) : 0;
    return { port, value: units ? units * def.unitPrice : 0 };
  });
  return ranked.filter(c => c.value > 0).sort((a, b) =>
    (a.port.openingShips ?? 0) - (b.port.openingShips ?? 0) || b.value - a.value ||
    Number(b.port.cityId === city) - Number(a.port.cityId === city) || a.port.cityId - b.port.cityId)[0]?.port;
}

// 有多批可卖且单卖一批即可升级时，把升级后能多赚最多的批次留在船上。
function saleToUnlockShip(sales, config, event, state, ship, settings, timing, time, actionSeconds) {
  if (!settings.autoUpgrade || sales.length < 2 || !natural(state.player.profit)) return null;
  const deadline = Math.min(timing.nextRefreshAt ?? Infinity, timing.tradeEndTime);
  if (time + (sales.length + 1) * actionSeconds >= deadline) return null;
  const finalStart = merchantFinalCargoStart(timing, event, settings, state.player.goods, state.cargo.cityId);
  if (finalStart !== null && time >= finalStart) return null;
  const ships = rows(config, 'TradeShipCfg'), next = ships.find(row => row.lv === ship.lv + 1);
  if (!positive(next?.upMoney) || !natural(next.profitMargin) || next.profitMargin <= ship.profitMargin ||
    next.upCost?.[0] !== 'RUBY' || next.upCost.length !== 2 || !positive(next.upCost[1])) return null;
  const gap = next.upMoney - state.player.profit, first = sales[0];
  const firstProfit = state.player.profit + first.gain;
  if (gap <= 0 || first.gain < gap || (settings.profitLimit > 0 && firstProfit >= settings.profitLimit) ||
    ships.some(row => row.lv > next.lv && natural(row.upMoney) && firstProfit >= row.upMoney)) return null;
  let selected = first, bonus = profit(first.price, first.batch, next) - first.gain;
  for (const candidate of sales.slice(1)) {
    if (candidate.gain < gap) break;
    const extra = profit(candidate.price, candidate.batch, next) - candidate.gain;
    if (extra < bonus) { selected = candidate; bonus = extra; }
  }
  return selected === first ? null : selected;
}

export function planMerchant(config, event, state, market, radar, time, visited = [], options = {}) {
  const settings = merchantSettings(options.settings), timing = merchantTiming(config, event, time);
  const actionSeconds = merchantActionSeconds({}, options.actionSeconds);
  const liquidation = positive(event?.endTime) && event.endTime - time <= settings.liquidationMinutes * 60;
  const mode = liquidation ? 'FINAL_LIQUIDATION' : 'TRADE';
  const wait = (reason, extra = {}) => ({ kind: 'wait', mode, reason, ...extra });
  if (!positive(event?.startTime) || !positive(event.endTime) || event.startTime > time || event.endTime <= time ||
    state?.period !== event.period || timing.tradeStartTime === null) return wait('等待本期开放交易时段');
  const cargo = state.cargo, player = state.player;
  if (!positive(cargo?.cityId) || !positive(cargo.cargoLv) || !natural(cargo.moveEndTime)) return wait('商船位置未同步');
  if (cargo.moveEndTime > time || (cargo.moveToCityId && cargo.moveToCityId !== cargo.cityId)) return wait('商船航行中，等待到港确认');
  const ship = rows(config, 'TradeShipCfg').find(row => row.lv === cargo.cargoLv);
  if (!positive(ship?.capacity) || !natural(ship.profitMargin) || !natural(player?.coins) || !natural(player.profit) ||
    !Array.isArray(player.goods) || !Array.isArray(market?.goods)) return wait('商船、货舱或本港报价未同步');
  if (market.observedAt !== undefined && (!natural(market.observedAt) || market.observedAt > time ||
    time - market.observedAt > settings.quoteMaxAgeSeconds || merchantTiming(config, event, market.observedAt).marketEpoch !== timing.marketEpoch))
    return wait('本港报价已过期，等待重新读取');
  const definitions = new Map(rows(config, 'TradeGoodsCfg').map(row => [row.goodsId, row]));
  if (market.goods.some(g => !g || !positive(g.goodsId)) || player.goods.some(g => !g) ||
    new Set(market.goods.map(g => g.goodsId)).size !== market.goods.length ||
    new Set(player.goods.map(g => g.pid)).size !== player.goods.length || player.goods.some(g =>
      !natural(g.pid) || !positive(g.num) || !positive(g.buyPrice) || !positive(g.cityId) || !positive(definitions.get(g.goodsId)?.capacity) ||
      !safe(g.num * g.buyPrice) || !safe(g.num * definitions.get(g.goodsId).capacity))) return wait('货物批次、港口报价或舱位未确认');
  const occupied = player.goods.reduce((sum, g) => sum + g.num * definitions.get(g.goodsId).capacity, 0);
  if (!natural(occupied) || occupied > ship.capacity) return wait('船舱容量与持货批次不一致');
  const free = ship.capacity - occupied, quotes = new Map(market.goods.map(row => [row.goodsId, row]));
  const openingCargo = player.goods.filter(b => b.cityId !== cargo.cityId && options.openingCargoPids?.includes(b.pid));
  if (openingCargo.length && positive(options.plannedOpening)) {
    if (time < options.plannedOpening)
      return wait('隔夜船货留在目的港，等待开市后重新核价', { nextCheckAt: options.plannedOpening });
    if (!timing.tradingOpen || market.observedAt < options.plannedOpening)
      return wait('隔夜船货留在目的港，等待开市后的本港报价');
    const batch = openingCargo.find(b => positive(quotes.get(b.goodsId)?.price));
    if (!batch) return wait('等待隔夜船货的本港实价，清舱后开始采购');
    const price = quotes.get(batch.goodsId).price, gain = profit(price, batch, ship);
    if (!safe(gain)) return wait('隔夜船货的实际收益待核对');
    return { kind: 'sell', mode: 'OPENING_SALE', city: cargo.cityId, pid: batch.pid, goodsId: batch.goodsId, count: batch.num,
      price, gain, expectedProfit: gain, estimated: false,
      label: '开市清舱，出售' + definitions.get(batch.goodsId).itemName + ' ×' + batch.num +
        '，本港实价 ' + price + '，本批盈亏 ' + gain + ' 商会币，成交后剩余 ' + (openingCargo.length - 1) + ' 批隔夜货' };
  }
  const { ports, history, pastRounds } = portsAndHistory(config, event, radar, options.markets, time, settings, timing.marketEpoch);
  const closing = positive(options.closingPointers) && settings.autoSpeedUp && merchantSpeedMode(settings.speedUpMode) === 'goal';
  const travel = closing ? Math.max(actionSeconds, timing.travelSeconds - options.closingPointers * merchantPointerSeconds(config)) :
    timing.travelSeconds ?? Infinity;
  const arrival = time + travel;
  // 买货看出发港当前的收盘，航行经过休市时段仍计时，卖货从目的港实际开市起计。
  let saleWindow = timing;
  if (positive(timing.travelSeconds)) {
    saleWindow = merchantTiming(config, event, arrival);
    // 同一时刻，无论船已买了几批，备货与出航都必须面向同一次开市。
    if (arrival + actionSeconds >= saleWindow.tradeEndTime) {
      const next = merchantTiming(config, event, arrival + 86400);
      if (next.tradeStartTime < next.tradeEndTime) saleWindow = next;
    }
  }
  const saleAt = Math.max(arrival, saleWindow.tradeStartTime), saleEnd = saleWindow.tradeEndTime;
  const advance = !timing.tradingOpen || saleWindow.tradeStartTime > timing.tradeStartTime;
  const sameRound = !advance && Number.isFinite(saleAt) && merchantTiming(config, event, saleAt).marketEpoch === timing.marketEpoch;
  const opening = saleWindow.tradeStartTime;
  const openLabel = advance ? tradeDate.format(opening * 1000) : '';
  const nextOpen = time < timing.tradeStartTime ? timing.tradeStartTime : timing.tradeStartTime + 86400;
  const waitForOpen = () => wait('商船留港，等 ' + tradeDate.format(nextOpen * 1000) + ' 开市后重新核价', { nextCheckAt: nextOpen });
  const canArrive = count => positive(timing.travelSeconds) && saleAt + Math.max(1, count) * actionSeconds < saleEnd;
  if (!timing.tradingOpen) {
    if (nextOpen >= event.endTime) return wait('本期贸易已收盘');
    if (!canArrive(1)) return waitForOpen();
  }
  const strict = settings.fullCargoRoutes;
  const localIntel = ports.find(port => port.cityId === cargo.cityId);
  const specialty = market.specGoodsId || localIntel?.specGoodsId;
  const shortage = market.rareGoodsId || localIntel?.rareGoodsId;
  const slotsAt = arrivalTime => Math.max(0, Math.floor((saleEnd - arrivalTime - 1) / actionSeconds));
  const saleSlots = slotsAt(saleAt), routeSlots = slotsAt(arrival);
  const buyEnd = Math.min(timing.tradeEndTime, event.endTime - settings.liquidationMinutes * 60);
  const buySlots = timing.tradingOpen ? Math.max(0, Math.ceil((buyEnd - time) / actionSeconds)) : 0;
  if (!occupied && !timing.tradingOpen) {
    const start = merchantTiming(config, event, event.startTime);
    const firstOpening = start.tradeStartTime + (event.startTime >= start.tradeEndTime ? 86400 : 0);
    if (time < firstOpening && nextOpen === firstOpening) {
      const stay = reason => wait(reason + '，留在本港等首次开市重新核价', { nextCheckAt: firstOpening });
      if (arrival > firstOpening) return stay('现在换港会错过首轮开市');
      if (firstOpening + travel + 3 * actionSeconds >= saleEnd ||
        firstOpening >= event.endTime - settings.liquidationMinutes * 60) return stay('首轮剩余时间不足以采购并运往销港');
      const port = openingPurchasePort(ports, cargo.cityId, specialty, definitions, player.coins, ship.capacity);
      if (!port) return stay('尚未找到按基准价可购的固定特产');
      if (port.cityId === cargo.cityId) return stay('按可见同盟船和可购特产货值比较，本港适合首轮采购');
      return { kind: 'move', mode: 'FIRST_OPENING', city: cargo.cityId, destination: port.cityId, goodsId: port.specGoodsId,
        exploration: true, plannedOpening: firstOpening, arrival, latestActionAt: firstOpening - travel + 1,
        expectedProfit: null, estimated: true, label: '首日空船提前前往 ' + port.cityId + ' 号港，准备采购特产' +
          definitions.get(port.specGoodsId).itemName + '。开市前可见同盟在途船 ' + (port.openingShips ?? 0) + ' 艘，开市后核对实价和库存' };
    }
  }
  // 收盘前到港的异地货先按本港实价卖出，回款后再备隔夜货。次日紧缺重置，带过夜只能按普通价清舱。
  const sellBeforeOvernight = timing.tradingOpen && player.goods.some(b => b.cityId !== cargo.cityId &&
    positive(quotes.get(b.goodsId)?.price) && profit(quotes.get(b.goodsId).price, b, ship) > 0);
  if (advance && time < opening && canArrive(1) && !closing && (occupied || buySlots) && !sellBeforeOvernight) {
    const portsForSale = ports.filter(p => p.cityId !== cargo.cityId && player.goods.every(b => b.cityId !== p.cityId));
    if (portsForSale.length) {
      const held = player.goods.length;
      const maxTypes = Math.min(buySlots, saleSlots - held, Math.floor((routeSlots - held - 1) / 2));
      const purchases = openingLoad(market, shortage, definitions, free, player.coins, maxTypes, player.goods, portsForSale,
        strict ? 0 : settings.minPurchaseReturnPercent);
      // 卖到同种特产港时，有多少买货本金暴露在该品种上。不同货物每格占用的本金可能相差很大。
      const costs = new Map();
      let capital = 0, reference = 0;
      for (const b of [...player.goods, ...purchases]) {
        const count = b.num ?? b.count, cost = count * (b.buyPrice ?? b.price);
        costs.set(b.goodsId, (costs.get(b.goodsId) ?? 0) + cost);
        capital += cost;
        reference += count * definitions.get(b.goodsId).unitPrice;
      }
      const port = portsForSale.sort((a, b) => (costs.get(a.specGoodsId) ?? 0) - (costs.get(b.specGoodsId) ?? 0) ||
        Number(definitions.has(b.specGoodsId)) - Number(definitions.has(a.specGoodsId)) || (a.openingShips ?? 0) - (b.openingShips ?? 0) ||
        Number(b.cityId === options.preferredPort) - Number(a.cityId === options.preferredPort) || a.cityId - b.cityId)[0];
      const costNote = '整船进货成本 ' + capital + ' 商会币' +
        (positive(reference) ? '，相当于基准货值的 ' + Number((capital * 100 / reference).toFixed(1)) + '%' : '');
      const base = { mode: 'OVERNIGHT', city: cargo.cityId, destination: port.cityId, plannedOpening: opening,
        arrival, estimated: true, expectedProfit: null, purchaseDetails: [['隔夜本金', costNote],
          ['目的港', '同种特产涉及的本金 ' + (definitions.has(port.specGoodsId) ? (costs.get(port.specGoodsId) ?? 0) + ' 商会币' : '待确认') +
            '，开市前可见同盟在途船 ' + (port.openingShips ?? 0) + ' 艘']] };
      if (purchases.length) {
        const [item] = purchases;
        const load = occupied + purchases.reduce((n, p) => n + p.capacity * p.count, 0);
        return { ...base, kind: 'buy', goodsId: item.goodsId, count: item.count, price: item.price, purchases,
          latestActionAt: Math.min(buyEnd - (purchases.length - 1) * actionSeconds,
            saleEnd - travel - (held + 2 * purchases.length + 1) * actionSeconds),
          label: '隔夜备货，买入' + definitions.get(item.goodsId).itemName + ' ×' + item.count +
            '，单价 ' + item.price + '，预计装舱 ' + load + '/' + ship.capacity + ' 格。开市后按实价清舱，可能亏损' };
      }
      if (held) {
        const sales = player.goods.slice(0, saleSlots);
        return { ...base, kind: 'move', goodsId: sales[0].goodsId, salePids: sales.map(b => b.pid),
          accelerationRequired: 0, latestActionAt: saleEnd - travel - sales.length * actionSeconds,
          priceNote: costNote + '，开市价格待定，届时按实价逐批清舱',
          label: '隔夜备货 ' + occupied + '/' + ship.capacity + ' 格，提前出航前往港口 ' + port.cityId +
            '，' + openLabel + ' 开市后按实价逐批清舱，再采购' };
      }
      if (!strict && settings.minPurchaseReturnPercent > 0) {
        const refresh = timing.nextRefreshAt;
        if (refresh > time && refresh < buyEnd) return wait('隔夜货未达到采购回报门槛，等本港刷新后重新核价', { nextCheckAt: refresh });
        return waitForOpen();
      }
    }
  }
  const destinations = ports.filter(port => port.cityId !== cargo.cityId &&
    (!advance || player.goods.every(b => b.cityId !== port.cityId)) && (!strict ||
    (positive(specialty) && positive(shortage) && specialty !== shortage &&
      port.rareGoodsId === specialty && port.specGoodsId === shortage)));
  const estimates = new Map();
  const peers = comparableQuotes(new Map(history).set(cargo.cityId, market), pastRounds, definitions);
  const estimate = (definition, port) => {
    const key = port.cityId + ':' + definition.goodsId;
    if (!estimates.has(key)) {
      const snapshot = history.get(port.cityId);
      // 紧缺每天开市重置，昨日的紧缺溢价不能用来估算开市后的售价。
      const salePort = advance ? { ...port, rareGoodsId: 0 } : port;
      let value = expectedPrice(definition, salePort, snapshot, pastRounds.get(port.cityId), peers, cargo.cityId,
        sameRound && snapshot && saleAt - snapshot.observedAt <= settings.quoteMaxAgeSeconds, settings.estimateDiscountPercent);
      // 末日收尾的货过期作废，卖价封顶到基准价。次日仍开市的收盘前航次即使没赶上，货也能留到开市再卖，按已知紧缺正常估价。
      if (closing && !options.eveningLeg && value) {
        const known = snapshot?.goods.find(g => g.goodsId === definition.goodsId)?.price;
        const price = merchantGoalSalePrice(definition, port, known, settings.estimateDiscountPercent);
        if (price < value.price) value = { ...value, price, source: '收尾用针保守估价' };
      }
      estimates.set(key, value);
    }
    return estimates.get(key);
  };
  const batchAt = (batch, port, reference) => {
    if (batch.cityId === port.cityId) return null;
    const estimated = estimate(definitions.get(batch.goodsId), port);
    if (!estimated) return null;
    const price = reference ? estimated.referencePrice : estimated.price;
    if (!positive(price)) return null;
    const gain = profit(price, batch, ship);
    if (!safe(gain)) return null;
    return { batch, ...estimated, price, gain, space: batch.num * definitions.get(batch.goodsId).capacity };
  };
  const offersAt = (port, reset, reference) => market.goods.flatMap(quote => {
    if (quote.goodsId === shortage) return [];
    const definition = definitions.get(quote.goodsId), target = definition && estimate(definition, port);
    if (!definition || !positive(quote.price) || !natural(quote.stock) || !positive(definition.capacity) || !natural(definition.maxCount) ||
      quote.stock > definition.maxCount || !target) return [];
    const expectedPrice = reference ? target.referencePrice : target.price;
    if (expectedPrice <= quote.price) return [];
    if (settings.minPurchaseReturnPercent > 0) {
      // 按真实买价计算资金回报。参考价补货仅给当日明确紧缺且折后仍能保本的货物。
      if (reference && (port.rareGoodsId !== quote.goodsId || target.price < quote.price)) return [];
      if ((expectedPrice - quote.price) * 100 < settings.minPurchaseReturnPercent * quote.price) return [];
    }
    const available = definition.maxCount - quote.stock;
    const count = reset ? definition.maxCount + (strict && quote.goodsId === specialty ? available : 0) : available;
    if (!positive(count)) return [];
    const profitBasis = (expectedPrice - quote.price) * (10000 + ship.profitMargin);
    return [{ goodsId: quote.goodsId, price: quote.price, capacity: definition.capacity, count,
      expectedPrice, referencePrice: target.referencePrice, priceSource: target.source, basePrice: definition.unitPrice,
      quality: definition.qualityIndex ?? 0, marginPerSlot: (expectedPrice - quote.price) / definition.capacity,
      profitBasis, unitProfit: profitBasis / 10000, estimated: true }];
  });
  const cache = new Map();
  const optimize = (port, capacity, cash, maxTypes, reset, reference) => {
    const offers = offersAt(port, reset, reference), types = Math.min(maxTypes, offers.length);
    const needsSpecialty = strict && !player.goods.some(b => b.cityId === cargo.cityId && b.goodsId === specialty &&
      b.buyPrice < definitions.get(specialty)?.unitPrice && batchAt(b, port, reference)?.gain > 0);
    const key = JSON.stringify([offers, capacity, cash, types, needsSpecialty]);
    if (!cache.has(key)) cache.set(key, strict ? fullMerchantLoad(offers, capacity, cash, types, specialty, needsSpecialty) :
      optimizePurchasePlan(offers, capacity, cash, { maxTypes: types }));
    return cache.get(key);
  };
  const lossAllowed = (batch, gain) => liquidation && settings.maxLossPercent > 0 && gain < 0 &&
    -gain <= batch.buyPrice * batch.num * settings.maxLossPercent / 100;
  const saleAllowed = (batch, gain) => gain > 0 || (liquidation && gain === 0) || lossAllowed(batch, gain);
  const eligible = route => {
    if (!visited.includes(route.port.cityId)) return true;
    // 提前空船到港后，本轮新货可运回出发港。下面的空船寻价仍单独排除已访问港口。
    if (!occupied && timing.tradingOpen && timing.tradeStartTime === options.plannedOpening) return true;
    const snapshot = history.get(route.port.cityId);
    if (!snapshot || saleAt - snapshot.observedAt > settings.quoteMaxAgeSeconds || !sameRound) return false;
    return route.batches.some(row => {
      const local = quotes.get(row.batch.goodsId)?.price;
      return row.gain > 0 && positive(local) && row.price > local;
    });
  };
  // 指针不足时仍可自然航行并出售高价值子集，不能因其余批次来不及出售而放弃整条路线。
  // 规划从不依赖尚未确认能够使用的指针；来源与止损不满足的批次继续保留。
  const bestBatches = (batches, slots) => [...batches].sort((a, b) => b.gain - a.gain || b.space - a.space || a.batch.pid - b.batch.pid)
    .slice(0, Math.max(0, slots));
  // 每笔盈利累计活动积分，亏损只减少周转资金。积分相同时优先保住本金。
  const outcome = (batches, gain = 0, purchaseProfit = 0) => ({
    score: batches.reduce((sum, row) => sum + Math.max(0, row.gain), Math.max(0, gain) + purchaseProfit),
    net: batches.reduce((sum, row) => sum + row.gain, gain + purchaseProfit)
  });
  const byOutcome = (a, b) => b.score - a.score || b.net - a.net;
  // 仅预看一次次程交易。预计售价、库存和销路仍在实际抵港时重读。
  const connections = new Map();
  if (settings.knownPortChains && !strict && !advance && !closing && !liquidation &&
    saleAt + travel + 3 * actionSeconds < saleEnd && saleAt + actionSeconds < buyEnd) {
    const samples = [...new Map(history).set(cargo.cityId, market).values(),
      ...Array.from(pastRounds.values(), rounds => [...rounds.values()]).flat()].flatMap(m => {
      const def = definitions.get(m.specGoodsId), q = m.goods.find(g => g.goodsId === m.specGoodsId);
      return positive(def?.unitPrice) && positive(q?.price) ? [{ tier: priceTier(def), ratio: q.price / def.unitPrice }] : [];
    });
    for (const port of destinations) {
      const def = definitions.get(port.specGoodsId);
      if (!positive(def?.unitPrice) || !positive(def.capacity) || !positive(def.maxCount)) continue;
      const sampled = history.get(port.cityId);
      const observations = [...(pastRounds.get(port.cityId)?.values() ?? []), ...(sampled ? [sampled] : [])];
      const prices = observations.filter(m => m.specGoodsId === def.goodsId)
        .map(m => m.goods.find(g => g.goodsId === def.goodsId)?.price).filter(positive);
      const sameTier = samples.filter(s => s.tier === priceTier(def));
      const comparable = sameTier.length >= 2 ? sameTier : samples;
      const ratio = comparable.length >= 2 ? Math.max(...comparable.map(s => s.ratio)) : 1;
      const buy = prices.length ? Math.max(...prices) : Math.ceil(def.unitPrice * ratio);
      const live = sameRound && sampled?.goods.find(g => g.goodsId === def.goodsId);
      const available = live ? Math.max(0, def.maxCount - live.stock) : def.maxCount;
      for (const next of ports) {
        if (next.cityId === port.cityId || next.rareGoodsId !== def.goodsId || next.specGoodsId === def.goodsId) continue;
        const sale = expectedPrice(def, next, history.get(next.cityId), pastRounds.get(next.cityId), peers,
          port.cityId, false, settings.estimateDiscountPercent);
        if (sale?.price > buy && (sale.referencePrice - buy) * 100 >= settings.minPurchaseReturnPercent * buy &&
          sale.price - buy > (connections.get(port.cityId)?.spread ?? 0))
          connections.set(port.cityId, { next: next.cityId, buy, spread: sale.price - buy, available, space: def.capacity });
      }
    }
  }
  const nextTrade = (port, cash, space, actions) => {
    const link = connections.get(port.cityId);
    if (!link || saleAt + (actions + 1) * actionSeconds >= buyEnd ||
      saleAt + travel + (actions + 3) * actionSeconds >= saleEnd) return 0;
    const units = Math.min(link.available, Math.floor(cash / link.buy), Math.floor(space / link.space));
    return Math.max(0, units) * link.spread;
  };
  const cargoRoutesFor = (ports, reference = false) => ports.map(port => {
    const allBatches = player.goods.map(batch => batchAt(batch, port, reference)).filter(row => row && (saleAllowed(row.batch, row.gain) ||
      (!reference && row.gain === 0 && nextTrade(port, player.coins + row.batch.num * row.batch.buyPrice, free + row.space, 1) > 0)));
    const batches = bestBatches(allBatches, saleSlots);
    return { port, allBatches, batches };
  }).filter(route => canArrive(route.batches.length) && eligible(route));
  const cargoRoutes = cargoRoutesFor(destinations);

  // 新货每种需要一轮买入和一轮出售，旧货只占出售轮数。纯出航沿用当前轮即可发船的余量。
  const loadFor = (port, held, space, cash, slots, reset = false, reference = false) => {
    const ranked = bestBatches(held, Math.min(slots, saleSlots));
    let best = { batches: ranked, purchases: [], profit: 0, approximate: false, ...outcome(ranked) };
    // 空船休市时也比较留在本港采购的机会，实际买入必须到开市后重算。
    const maxBuys = !timing.tradingOpen && !occupied ? Infinity : buySlots;
    if (liquidation || !space || !cash || !maxBuys) return best;
    if (strict) {
      const types = Math.min(maxBuys, saleSlots - held.length, Math.floor((slots - 1 - held.length) / 2));
      if (types < 1) return best;
      const purchase = optimize(port, space, cash, types, reset, reference);
      return { ...purchase, batches: ranked, ...outcome(ranked, 0, purchase.profit) };
    }
    let types = Math.min(maxBuys, market.goods.length, saleSlots, Math.floor((slots - 1) / 2));
    while (types > 0) {
      const purchase = optimize(port, space, cash, types, reset, reference), used = purchase.purchases.length;
      if (!used) break;
      const batches = ranked.slice(0, Math.min(saleSlots - used, slots - 1 - used * 2));
      const candidate = { ...purchase, batches, ...outcome(batches, 0, purchase.profit) };
      if (byOutcome(candidate, best) < 0) best = candidate;
      if (batches.length === ranked.length) break;
      types = used - 1;
    }
    return best;
  };
  const buildRoutes = (slots, reset = false, candidates = cargoRoutes, reference = false) => candidates.map(route => {
    const load = loadFor(route.port, route.allBatches, free, player.coins, slots, reset, reference);
    const matched = load.batches.filter(row => route.port.rareGoodsId === row.batch.goodsId).length +
      load.purchases.filter(item => item.goodsId === route.port.rareGoodsId).length;
    const released = load.batches.reduce((sum, row) => sum + row.space, 0);
    let onward = 0;
    if (!reset && !reference && connections.has(route.port.cityId)) {
      const actions = load.batches.length + 2 * load.purchases.length;
      const principal = load.batches.reduce((sum, r) => sum + r.batch.buyPrice * r.batch.num, 0);
      onward = nextTrade(route.port, player.coins + principal + load.net, free + released, actions);
    }
    // 平价货可回笼本金，但次程库存尚未确认，最多按回笼成本的 5% 给它排序加权。
    const flatCapital = load.batches.reduce((sum, r) => sum + (r.gain === 0 ? r.batch.buyPrice * r.batch.num : 0), 0);
    const rank = load.score + Math.min(Math.floor(onward / 2), Math.floor(load.score / 4 + flatCapital / 20));
    return { ...route, ...load, matched, cargoOutcome: outcome(load.batches), rank, onward, released };
  }).filter(route => !strict || (route.net >= settings.minExpectedProfit &&
    (route.purchases.some(p => p.goodsId === specialty) || route.batches.some(r => r.batch.goodsId === specialty &&
      r.batch.cityId === cargo.cityId && r.batch.buyPrice < definitions.get(specialty)?.unitPrice && r.gain > 0)) &&
    (!free || route.purchases.length))).sort((a, b) =>
    (strict && (Number(b.port.cityId === options.preferredPort) - Number(a.port.cityId === options.preferredPort))) ||
    b.rank - a.rank || byOutcome(a, b) || b.released - a.released || b.matched - a.matched || a.port.cityId - b.port.cityId);
  const routes = buildRoutes(routeSlots), best = routes[0];
  const bestHold = routes.find(route => route.batches.length || route.purchases.length);
  const sales = [];
  for (const batch of player.goods) {
    const quote = quotes.get(batch.goodsId);
    if (batch.cityId === cargo.cityId || !positive(quote?.price)) continue;
    const gain = profit(quote.price, batch, ship);
    const swapOnly = gain === 0 && !liquidation;
    if (!safe(gain) || (!swapOnly && !saleAllowed(batch, gain))) continue;
    if (strict) {
      if (!swapOnly) sales.push({ batch, price: quote.price, gain, opportunity: 0 });
      continue;
    }
    let swap;
    let bestAfterSale = outcome([], gain), opportunity = 0;
    const consider = (batches, purchaseProfit = 0) => {
      const candidate = outcome(batches, gain, purchaseProfit);
      if (byOutcome(candidate, bestAfterSale) < 0) bestAfterSale = candidate;
    };
    const releasedCash = player.coins + batch.buyPrice * batch.num + gain;
    for (const route of cargoRoutes) {
      const remaining = route.allBatches.filter(row => row.batch.pid !== batch.pid);
      const noPurchase = bestBatches(remaining, saleSlots - 1);
      if (noPurchase.length && canArrive(noPurchase.length + 1))
        consider(noPurchase);
      if (liquidation || !natural(releasedCash) || !canArrive(3)) continue;
      const replacement = loadFor(route.port, remaining, free + batch.num * definitions.get(batch.goodsId).capacity, releasedCash, saleSlots - 1);
      if (!replacement.purchases.length) continue;
      const baseline = loadFor(route.port, remaining, free, player.coins, saleSlots - 1);
      const remainingBatches = replacement.batches;
      // 机会收益只计出售本批带来的增量，且包含本次卖出、后续采购和其余批次出售的时间。
      const actions = remainingBatches.length + replacement.purchases.length * 2 + 2;
      if (canArrive(actions)) {
        consider(remainingBatches, replacement.profit);
        opportunity = Math.max(opportunity, replacement.profit - baseline.profit);
        if (swapOnly && replacement.profit > baseline.profit && replacement.purchases.some(item =>
          item.goodsId !== batch.goodsId && item.count > (baseline.purchases.find(old => old.goodsId === item.goodsId)?.count ?? 0))) {
          const extra = outcome(remainingBatches, 0, replacement.profit).score - (bestHold?.score ?? 0);
          // 卖出后逐笔采购必须赶在本港刷新及停止采购之前，下一程还须能按时卖出。
          const lastBuy = Math.min(timing.nextRefreshAt ?? Infinity, event.endTime - settings.liquidationMinutes * 60);
          const latestActionAt = Math.min(lastBuy - replacement.purchases.length * actionSeconds,
            timing.tradeEndTime - timing.travelSeconds - actions * actionSeconds);
          if (time < latestActionAt && extra >= settings.minExpectedProfit && (!swap || extra > swap.extra))
            swap = { extra, latestActionAt };
        }
      }
    }
    if (swapOnly && !swap) continue;
    const timeCost = Math.max(0, gain) * (timing.travelSeconds ?? 0) / Math.max(1, timing.tradeEndTime - time);
    if (bestHold && (bestHold.score === bestAfterSale.score ? bestHold.net - bestAfterSale.net :
      bestHold.score - bestAfterSale.score) > timeCost + settings.minExpectedProfit) continue;
    sales.push({ batch, price: quote.price, gain, opportunity, swap });
  }
  sales.sort((a, b) => b.gain - a.gain || (b.swap?.extra ?? 0) - (a.swap?.extra ?? 0) || a.batch.pid - b.batch.pid);
  if (sales.length) {
    if (!timing.tradingOpen) return waitForOpen();
    const unlock = !liquidation && saleToUnlockShip(sales, config, event, state, ship, settings, timing, time, actionSeconds);
    const sale = unlock || sales[0], batch = sale.batch;
    return { kind: 'sell', mode: sale.swap ? 'SWAP' : mode, city: cargo.cityId, pid: batch.pid, goodsId: batch.goodsId, count: batch.num,
      price: sale.price, gain: sale.gain, expectedProfit: sale.gain, estimated: false,
      ...(sale.swap && { latestActionAt: sale.swap.latestActionAt }),
      label: (sale.swap ? '平价换货，出售' : sale.gain < 0 ? '清仓出售' : '出售') + definitions.get(batch.goodsId).itemName + ' ×' + batch.num +
        '，本港报价收益 ' + sale.gain + '；释放舱位 ' + batch.num * definitions.get(batch.goodsId).capacity +
        (unlock ? '，本批成交可解锁 ' + (ship.lv + 1) + ' 级船，留大单到升级后再卖' :
          sale.swap ? '，换货比继续持有预计多赚 ' + sale.swap.extra : sale.opportunity > 0 ? '，再采购预计收益 ' + sale.opportunity : '') };
  }
  // 一程未必出售全部持货；具体路线已按可出售批次数检查，不能用无关滞销批次阻塞它。
  if (!canArrive(1)) return wait('本期剩余交易时段不足以完成航行和出售', { mode: 'FINAL_LIQUIDATION' });

  // 刷新会改变价格，不能把补货当成确定收益：仅以本港已见折价做再折扣估算。
  const refreshIn = timing.nextRefreshAt === null ? Infinity : timing.nextRefreshAt - time;
  let stagedRoute;
  if (timing.tradingOpen && strict && !liquidation && free && refreshIn > 0 && (!best || refreshIn <= settings.refreshWaitSeconds) &&
    timing.nextRefreshAt + actionSeconds < event.endTime - settings.liquidationMinutes * 60 &&
    arrival + refreshIn + 3 * actionSeconds < timing.tradeEndTime) {
    const after = buildRoutes(slotsAt(arrival + refreshIn) - 2, true)[0];
    const main = after?.purchases.find(p => p.goodsId === specialty);
    const available = definitions.get(specialty)?.maxCount - quotes.get(specialty)?.stock;
    if (main && natural(available) && main.count > available && (!best || after.net >= best.net)) {
      if (!available) return wait('本轮折价特产已售罄，等待刷新后重新核价补舱（' + occupied + '/' + ship.capacity + ' 格）',
        { mode: 'WAIT_REFRESH', nextCheckAt: timing.nextRefreshAt });
      const gain = Math.ceil(main.profitBasis * available / 10000);
      stagedRoute = { ...after, purchases: [{ ...main, count: available, gain }], net: after.cargoOutcome.net + gain };
    }
  }
  if (timing.tradingOpen && !strict && !liquidation && free > 0 && refreshIn > 0 && refreshIn <= settings.refreshWaitSeconds &&
    market.goods.some(quote => positive(quote.stock))) {
    const afterRefresh = buildRoutes(slotsAt(arrival + refreshIn), true)[0], currentProfit = Math.max(0, best?.score ?? 0);
    if (afterRefresh && afterRefresh.profit > (best?.profit ?? 0) &&
      timing.nextRefreshAt + timing.travelSeconds + (afterRefresh.batches.length + afterRefresh.purchases.length * 2 + 1) * actionSeconds < timing.tradeEndTime) {
      const discounted = afterRefresh.score * (1 - settings.estimateDiscountPercent / 100);
      const waitingCost = currentProfit * refreshIn / timing.travelSeconds;
      if (discounted > currentProfit + waitingCost + settings.minExpectedProfit) return wait(
        '本港折价库存不足，等待约 ' + Math.ceil(refreshIn / 60) + ' 分钟刷新后重读报价库存；补货估算收益 ' + Math.floor(discounted) +
        '，当前方案 ' + currentProfit, { mode: 'WAIT_REFRESH', nextCheckAt: timing.nextRefreshAt });
    }
  }
  const worthBuying = route => route?.purchases.length && route.score >= settings.minExpectedProfit;
  const worthSailing = route => (!strict || !free) && route.batches.length && (route.cargoOutcome.score >= settings.minExpectedProfit ||
    (!route.purchases.length && route.onward > 0 && route.cargoOutcome.net === 0 && route.rank >= settings.minExpectedProfit) ||
    (liquidation && route.cargoOutcome.score === 0 && (route.cargoOutcome.net === 0 || settings.maxLossPercent > 0)));
  let buyRoute = stagedRoute ?? (worthBuying(best) ? best : null);
  let moveRoute = routes.find(worthSailing);
  const hasDiscountedRoute = !!moveRoute;
  let reference = false;
  const canLoad = free > 0 && player.coins > 0 && routeSlots >= 3;
  const allowReference = !closing && !liquidation && settings.estimateDiscountPercent > 0 && settings.estimateDiscountPercent < 100;
  if (!buyRoute && allowReference && (canLoad || occupied > 0)) {
    // 已有载货航线时只补同港货物，并为原本能卖的所有批次留足操作时间。
    const ports = moveRoute ? [moveRoute.port] : destinations;
    const alternatives = buildRoutes(routeSlots, false, cargoRoutesFor(ports, true), true);
    const extra = alternatives.find(route => worthBuying(route) && (!moveRoute ||
      moveRoute.batches.every(old => route.batches.some(row => row.batch.pid === old.batch.pid))));
    if (extra) {
      buyRoute = extra;
      reference = true;
    } else {
      const sailing = alternatives.find(worthSailing);
      if (sailing && (!moveRoute || (sailing.batches.length > moveRoute.batches.length &&
        moveRoute.batches.every(old => sailing.batches.some(row => row.batch.pid === old.batch.pid))))) {
        moveRoute = sailing;
        reference = true;
      }
    }
  }
  const tradeMode = reference ? 'THIN_MARGIN' : mode;
  // 薄利方案另报同一批货在折后价下可兑现的利润，低于成本的批次按策略留仓。
  const discountedOutcome = (route, purchases = []) => {
    if (!reference) return {};
    const gain = (goodsId, buyPrice, num) => {
      const quote = estimate(definitions.get(goodsId), route.port);
      return Math.max(0, profit(quote.price, { buyPrice, num }, ship));
    };
    const held = route.batches.reduce((sum, { batch }) => sum + gain(batch.goodsId, batch.buyPrice, batch.num), 0);
    return { discountedProfit: purchases.reduce((sum, item) => sum + gain(item.goodsId, item.price, item.count), held) };
  };
  let estimateLabel = '整船预计净收益 ';
  if (reference) estimateLabel = '整船按未打折参考价估算收益 ';
  else if (settings.estimateDiscountPercent) estimateLabel = '整船按 ' + settings.estimateDiscountPercent + '% 风险折扣估算净收益 ';
  const saleEstimate = (def, basis, source, price) => def.itemName + '参考涨跌 ' + changeLabel(basis, def.unitPrice) +
    '（' + source + '），预计卖价 ' + price;
  if (buyRoute) {
    if (!timing.tradingOpen) return waitForOpen();
    const purchase = strict ? buyRoute.purchases[0] : [...buyRoute.purchases].sort((a, b) => b.gain - a.gain || a.goodsId - b.goodsId)[0];
    const definition = definitions.get(purchase.goodsId);
    const space = purchase.count * purchase.capacity;
    const riskNote = reference ? '（未扣风险折扣）' : settings.estimateDiscountPercent ? '（卖价已扣 ' + settings.estimateDiscountPercent + '% 风险折扣）' : '';
    const purchaseDetails = [
      ['本批预计净收益', amount.format(purchase.gain) + ' 商会币' + (ship.profitMargin ? '（含船级加成）' : '')],
      ['本批占舱', amount.format(space) + ' 格' + (purchase.count > 1 ? '（每件 ' + purchase.capacity + ' 格）' : '')],
      ['本港买价', versusBase(purchase.price, definition.unitPrice)],
      ['卖价依据', purchase.priceSource + (purchase.priceSource === '商品基准价' ? '' : '（' + versusBase(purchase.referencePrice, definition.unitPrice) + '）')],
    ];
    if (strict) purchaseDetails.push(['装入后舱位', amount.format(occupied + space) + ' / ' + amount.format(ship.capacity) + ' 格']);
    if (buyRoute.onward) purchaseDetails.push(['下一程已知销路', buyRoute.port.cityId + ' 号港特产可运往 ' +
      connections.get(buyRoute.port.cityId).next + ' 号紧缺港，到港复核本金与库存']);
    if (buyRoute.approximate) purchaseDetails.push(['配货方式', '组合搜索近似估算']);
    return { kind: 'buy', mode: tradeMode, city: cargo.cityId, destination: buyRoute.port.cityId, goodsId: purchase.goodsId,
      count: purchase.count, price: purchase.price, expectedProfit: buyRoute.net, ...discountedOutcome(buyRoute, buyRoute.purchases),
      estimated: true, purchases: buyRoute.purchases,
      ...(stagedRoute && { nextCheckAt: timing.nextRefreshAt }),
      ...(reference && !hasDiscountedRoute && { waitForFirstDeparture: true }),
      approximate: buyRoute.approximate, arrival,
      latestActionAt: Math.min(buyEnd - (buyRoute.purchases.length - 1) * actionSeconds,
        saleEnd - travel - (buyRoute.batches.length + buyRoute.purchases.length * 2 + 1) * actionSeconds),
      purchaseDetails,
      label: (buyRoute.purchases.length > 1 ? '组合 ' + buyRoute.purchases.length + ' 种，本笔' : '') +
        (stagedRoute ? '刷新前买入' : '买入') + definition.itemName + ' ×' + amount.format(purchase.count) +
        '，单价 ' + amount.format(purchase.price) + '，' + buyRoute.port.cityId + ' 号港预计卖价 ' + amount.format(purchase.expectedPrice) +
        '。每格价差 ' + amount.format(purchase.marginPerSlot) + ' 商会币，' + (stagedRoute ? '已配货预计净收益 ' : '整船预计净收益 ') +
        amount.format(buyRoute.net) + ' 商会币' + riskNote + (advance ? '，为 ' + openLabel + ' 开市备货' : '') };
  }
  if (moveRoute) {
    if (strict && !advance) {
      // 抵港留出售和首笔采购的时间。若对齐刷新会少跑一趟、或已经进入刷新窗口，则直接发船。
      const atArrival = merchantTiming(config, event, arrival);
      const leadTime = (moveRoute.batches.length + 1) * actionSeconds;
      const departure = atArrival.nextRefreshAt - timing.travelSeconds - leadTime;
      const cycle = timing.travelSeconds + leadTime + actionSeconds;
      const trips = start => Math.floor((timing.tradeEndTime - 1 - start - timing.travelSeconds - leadTime) / cycle);
      if (atArrival.nextRefreshAt < timing.tradeEndTime && departure > time &&
        arrival - atArrival.previousRefreshAt > settings.refreshWindowMinutes * 60 && trips(departure) >= trips(time))
        return wait('已满舱，等待出发以便在目的港刷新前卖货并采购', { mode: 'WAIT_DEPARTURE', nextCheckAt: departure });
    }
    const lead = [...moveRoute.batches].sort((a, b) => b.gain - a.gain || a.batch.pid - b.batch.pid)[0];
    const priceNote = saleEstimate(definitions.get(lead.batch.goodsId), lead.referencePrice, lead.source, lead.price);
    return { kind: 'move', mode: tradeMode, city: cargo.cityId, destination: moveRoute.port.cityId,
      ...(reference && !hasDiscountedRoute && { waitForFirstDeparture: true }),
      goodsId: lead.batch.goodsId, priceNote,
      arrival, expectedProfit: moveRoute.cargoOutcome.net, ...discountedOutcome(moveRoute), expectedScore: moveRoute.cargoOutcome.score, estimated: true,
      latestActionAt: saleEnd - travel - Math.max(1, moveRoute.batches.length) * actionSeconds,
      ...(advance && { plannedOpening: opening }),
      salePids: moveRoute.batches.map(row => row.batch.pid), accelerationRequired: 0,
      label: (strict ? '满舱 ' + occupied + '/' + ship.capacity + ' 格，商船从港口 ' : '商船从港口 ') + cargo.cityId + ' 前往 ' + moveRoute.port.cityId + '，' + estimateLabel + moveRoute.cargoOutcome.net +
        (moveRoute.onward ? '；该港特产可续运 ' + connections.get(moveRoute.port.cityId).next + ' 号紧缺港' : '') +
        (moveRoute.cargoOutcome.net !== moveRoute.cargoOutcome.score ? '，预计累计利润增加 ' + moveRoute.cargoOutcome.score : '') +
        '，预计释放舱位 ' + moveRoute.released + '；' + priceNote +
        (advance ? '；提前出航，' + openLabel + ' 开市且到港后重读实价' : '；到港重读实价') };
  }

  if (strict) {
    let reason = '等待折价库存或可盈利的满舱组合';
    const costs = market.goods.filter(q => positive(q.price) && positive(definitions.get(q.goodsId)?.capacity))
      .map(q => q.price / definitions.get(q.goodsId).capacity);
    if (free && costs.length && Math.ceil(free * Math.min(...costs)) > player.coins)
      reason = '以本港当前单价，余款 ' + player.coins + ' 商会币不足以补满 ' + free + ' 格';
    if (!destinations.length) reason = '等待双向特产与紧缺情报匹配，商船留港';
    return wait('舱位 ' + occupied + '/' + ship.capacity + ' 格，' + reason, { nextCheckAt: timing.nextRefreshAt });
  }

  // 在没有已知盈利路线时，有限寻价仍可帮助没有联盟共享的账号取得本港报价。
  // 不回访执行层标记的已访问港口；空船须留出到港采购后再航行出售的时间。
  if (!liquidation) {
    const explore = destinations.filter(port => !visited.includes(port.cityId) && !history.has(port.cityId) &&
      (player.goods.length ? player.goods.some(batch => batch.cityId !== port.cityId && port.specGoodsId !== batch.goodsId) :
        positive(definitions.get(port.specGoodsId)?.unitPrice)))
      .sort((a, b) => nextTrade(b, player.coins, free, 0) - nextTrade(a, player.coins, free, 0) ||
        Number(player.goods.some(g => g.goodsId === b.rareGoodsId)) - Number(player.goods.some(g => g.goodsId === a.rareGoodsId)) || a.cityId - b.cityId)[0];
    const possibleBatches = explore && player.goods.filter(batch => batch.cityId !== explore.cityId && explore.specGoodsId !== batch.goodsId).length;
    const explorationBuffer = player.goods.length ? timing.travelSeconds + Math.max(1, possibleBatches) * actionSeconds : timing.travelSeconds * 2 + actionSeconds * 4;
    let latestDeparture = saleEnd - explorationBuffer;
    if (!player.goods.length) {
      if (player.coins === 0) return wait('空船没有采购本金，留港等待');
      latestDeparture = Math.min(latestDeparture, event.endTime - settings.liquidationMinutes * 60 - timing.travelSeconds - actionSeconds);
    }
    // 提前到港的等待时间不能充作采购、第二程航行或售货时间。
    if (explore && Math.max(time, opening - travel) < latestDeparture) return {
      kind: 'move', mode, city: cargo.cityId, destination: explore.cityId, goodsId: player.goods[0]?.goodsId ?? explore.specGoodsId,
      expectedProfit: 0, estimated: true, exploration: true, arrival,
      latestActionAt: latestDeparture,
      ...(advance && { plannedOpening: opening }),
      label: '商船从港口 ' + cargo.cityId + ' 前往 ' + explore.cityId + ' 寻价，暂无可确认的盈利路线' +
        (advance ? '；提前出航，' + openLabel + ' 开市且到港后询价' : '；到港读取实价')
    };
  }
  return wait(liquidation ? '清仓阶段，停止新采购，等待符合止损上限的可执行卖价' :
    !destinations.length ? '本港暂无适合出售的批次，等待可用港口列表' : '当前没有值得执行的交易，等待本港报价或库存刷新',
    { nextCheckAt: timing.nextRefreshAt });
}
