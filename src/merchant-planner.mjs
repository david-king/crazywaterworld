// 海商王的纯决策层。异地卖价依据已知商情估算，成交使用到港实价。
import { fullMerchantLoad } from './merchant-loading.mjs';
const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => natural(value) && value > 0;
const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const param = (config, key) => rows(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
const dayOf = time => Math.floor((time + 28800) / 86400);
const safe = value => Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

export const MERCHANT_DEFAULTS = Object.freeze({
  fullCargoRoutes: false,
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
  refreshWindowMinutes: 8, dailyPointerLimit: 28, autoBuyPointers: false, pointerDailyDiamondLimit: 0,
  profitLimit: 0, firstDepartureMode: 'smart', firstDepartureTime: '10:00', firstDepartureWaitMinutes: 29,
  autoUpgrade: false
});

export function merchantSpeedMode(value = MERCHANT_DEFAULTS.speedUpMode) {
  return value === 'profit' ? 'deadline' : value;
}

export function merchantSettings(input = {}) {
  const output = { ...MERCHANT_DEFAULTS };
  for (const [key, fallback] of Object.entries(output)) {
    const value = input?.[key];
    if (typeof fallback === 'boolean') output[key] = typeof value === 'boolean' ? value : fallback;
    else if (key === 'speedUpMode') output[key] = ['deadline', 'refresh', 'arrival', 'race', 'full'].includes(value) ? value : fallback;
    else if (key === 'firstDepartureMode') output[key] = ['smart', 'time'].includes(value) ? value : fallback;
    else if (key === 'firstDepartureTime') output[key] = typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    else if (natural(value)) output[key] = value;
  }
  output.estimateDiscountPercent = Math.min(100, output.estimateDiscountPercent);
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

function comparableQuotes(markets, definitions) {
  const groups = new Map();
  for (const [city, market] of markets) {
    for (const quote of market.goods) {
      const def = definitions.get(quote.goodsId), role = marketRole(market, quote.goodsId);
      if (!positive(def?.unitPrice) || !positive(quote.price) || !['紧缺', '普通'].includes(role)) continue;
      const key = role + priceTier(def);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ city, goodsId: quote.goodsId, price: quote.price, base: def.unitPrice });
    }
  }
  return groups;
}

function expectedPrice(def, port, snapshot, pastRounds, peers, origin, freshAtArrival, discount) {
  if (!positive(def?.unitPrice)) return null;
  const role = marketRole(port, def.goodsId) ?? '普通';
  const quote = snapshot?.goods.find(g => g.goodsId === def.goodsId);
  let basis = def.unitPrice, source = '商品基准价';
  if (quote && freshAtArrival) {
    basis = quote.price;
    source = '目的港到访报价';
  } else {
    // 每轮每港只贡献一个样本，且特产、紧缺状态须与本次估价一致。
    const past = [];
    for (const round of pastRounds?.values() ?? []) {
      if (marketRole(round, def.goodsId) !== role) continue;
      const price = round.goods.find(g => g.goodsId === def.goodsId)?.price;
      if (positive(price)) past.push(price);
    }
    if (past.length >= 2) {
      basis = median(past);
      source = '目的港' + past.length + '轮同商品' + role + '报价中位数';
    } else if (role === '特产') {
      if (!quote) return null;
    } else {
      // 以各商品自己的基准价换算涨跌幅，排除本港该商品的买入报价。
      const samples = (peers.get(role + priceTier(def)) ?? [])
        .filter(s => s.city !== origin || s.goodsId !== def.goodsId)
        .map(s => def.unitPrice * s.price / s.base);
      if (role === '紧缺' && samples.length) {
        basis = Math.floor(Math.min(...samples));
        source = '同档紧缺货最低涨跌幅';
      } else if (role === '普通' && samples.length >= 2) {
        basis = median(samples);
        source = '同档普通货涨跌幅中位数';
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

export function planMerchant(config, event, state, market, radar, time, visited = [], options = {}) {
  const settings = merchantSettings(options.settings), timing = merchantTiming(config, event, time);
  const actionSeconds = merchantActionSeconds({}, options.actionSeconds);
  const liquidation = positive(event?.endTime) && event.endTime - time <= settings.liquidationMinutes * 60;
  const mode = liquidation ? 'FINAL_LIQUIDATION' : 'TRADE';
  const wait = (reason, extra = {}) => ({ kind: 'wait', mode, reason, ...extra });
  if (!positive(event?.startTime) || !positive(event.endTime) || event.startTime > time || event.endTime <= time ||
    state?.period !== event.period || !timing.tradingOpen) return wait('等待本期开放交易时段');
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
  const { ports, history, pastRounds } = portsAndHistory(config, event, radar, options.markets, time, settings, timing.marketEpoch);
  const observedMarkets = new Map(history).set(cargo.cityId, market);
  const peers = comparableQuotes(observedMarkets, definitions);
  const arrival = time + (timing.travelSeconds ?? Infinity);
  const sameRound = merchantTiming(config, event, arrival).marketEpoch === timing.marketEpoch;
  const canArrive = count => positive(timing.travelSeconds) && arrival + Math.max(1, count) * actionSeconds < timing.tradeEndTime;
  const strict = settings.fullCargoRoutes;
  const localIntel = ports.find(port => port.cityId === cargo.cityId);
  const specialty = market.specGoodsId || localIntel?.specGoodsId;
  const shortage = market.rareGoodsId || localIntel?.rareGoodsId;
  const destinations = ports.filter(port => port.cityId !== cargo.cityId && (!strict ||
    (positive(specialty) && positive(shortage) && specialty !== shortage &&
      port.rareGoodsId === specialty && port.specGoodsId === shortage)));
  const estimates = new Map();
  const estimate = (definition, port) => {
    const key = port.cityId + ':' + definition.goodsId;
    if (!estimates.has(key)) {
      const snapshot = history.get(port.cityId);
      estimates.set(key, expectedPrice(definition, port, snapshot, pastRounds.get(port.cityId), peers, cargo.cityId,
        sameRound && snapshot && arrival - snapshot.observedAt <= settings.quoteMaxAgeSeconds, settings.estimateDiscountPercent));
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
    const definition = definitions.get(quote.goodsId), target = definition && estimate(definition, port);
    if (!definition || !positive(quote.price) || !natural(quote.stock) || !positive(definition.capacity) || !natural(definition.maxCount) ||
      quote.stock > definition.maxCount || !target) return [];
    const expectedPrice = reference ? target.referencePrice : target.price;
    if (expectedPrice <= quote.price) return [];
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
    const snapshot = history.get(route.port.cityId);
    if (!snapshot || arrival - snapshot.observedAt > settings.quoteMaxAgeSeconds ||
      merchantTiming(config, event, arrival).marketEpoch !== timing.marketEpoch) return false;
    return route.batches.some(row => {
      const local = quotes.get(row.batch.goodsId)?.price;
      return row.gain > 0 && positive(local) && row.price > local;
    });
  };
  // 指针不足时仍可自然航行并出售高价值子集，不能因其余批次来不及出售而放弃整条路线。
  // 规划从不依赖尚未确认能够使用的指针；来源与止损不满足的批次继续保留。
  const slotsAt = arrivalTime => Math.max(0, Math.floor((timing.tradeEndTime - arrivalTime - 1) / actionSeconds));
  const saleSlots = slotsAt(arrival);
  const bestBatches = (batches, slots) => [...batches].sort((a, b) => b.gain - a.gain || b.space - a.space || a.batch.pid - b.batch.pid)
    .slice(0, Math.max(0, slots));
  // 每笔盈利累计活动积分，亏损只减少周转资金。积分相同时优先保住本金。
  const outcome = (batches, gain = 0, purchaseProfit = 0) => ({
    score: batches.reduce((sum, row) => sum + Math.max(0, row.gain), Math.max(0, gain) + purchaseProfit),
    net: batches.reduce((sum, row) => sum + row.gain, gain + purchaseProfit)
  });
  const byOutcome = (a, b) => b.score - a.score || b.net - a.net;
  const cargoRoutesFor = (ports, reference = false) => ports.map(port => {
    const allBatches = player.goods.map(batch => batchAt(batch, port, reference)).filter(row => row && saleAllowed(row.batch, row.gain));
    const batches = bestBatches(allBatches, saleSlots);
    return { port, allBatches, batches };
  }).filter(route => canArrive(route.batches.length) && eligible(route));
  const cargoRoutes = cargoRoutesFor(destinations);

  // 新货每种需要一轮买入和一轮出售，旧货只占出售轮数。纯出航沿用当前轮即可发船的余量。
  const loadFor = (port, held, space, cash, slots, reset = false, reference = false) => {
    const ranked = bestBatches(held, slots);
    let best = { batches: ranked, purchases: [], profit: 0, approximate: false, ...outcome(ranked) };
    if (liquidation || !space || !cash) return best;
    if (strict) {
      const types = Math.floor((slots - 1 - held.length) / 2);
      if (types < 1) return best;
      const purchase = optimize(port, space, cash, types, reset, reference);
      return { ...purchase, batches: ranked, ...outcome(ranked, 0, purchase.profit) };
    }
    let types = Math.min(market.goods.length, Math.floor((slots - 1) / 2));
    while (types > 0) {
      const purchase = optimize(port, space, cash, types, reset, reference), used = purchase.purchases.length;
      if (!used) break;
      const batches = ranked.slice(0, slots - 1 - used * 2);
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
    return { ...route, ...load, matched, cargoOutcome: outcome(load.batches),
      released: load.batches.reduce((sum, row) => sum + row.space, 0) };
  }).filter(route => !strict || (route.net >= settings.minExpectedProfit &&
    (route.purchases.some(p => p.goodsId === specialty) || route.batches.some(r => r.batch.goodsId === specialty &&
      r.batch.cityId === cargo.cityId && r.batch.buyPrice < definitions.get(specialty)?.unitPrice && r.gain > 0)) &&
    (!free || route.purchases.length))).sort((a, b) =>
    (strict && (Number(b.port.cityId === options.preferredPort) - Number(a.port.cityId === options.preferredPort))) ||
    byOutcome(a, b) || b.released - a.released || b.matched - a.matched || a.port.cityId - b.port.cityId);
  const routes = buildRoutes(saleSlots), best = routes[0];
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
    const sale = sales[0], batch = sale.batch;
    return { kind: 'sell', mode: sale.swap ? 'SWAP' : mode, city: cargo.cityId, pid: batch.pid, goodsId: batch.goodsId, count: batch.num,
      price: sale.price, gain: sale.gain, expectedProfit: sale.gain, estimated: false,
      ...(sale.swap && { latestActionAt: sale.swap.latestActionAt }),
      label: (sale.swap ? '平价换货，出售' : sale.gain < 0 ? '清仓出售' : '出售') + definitions.get(batch.goodsId).itemName + ' ×' + batch.num +
        '，本港报价收益 ' + sale.gain + '；释放舱位 ' + batch.num * definitions.get(batch.goodsId).capacity +
        (sale.swap ? '，换货比继续持有预计多赚 ' + sale.swap.extra : sale.opportunity > 0 ? '，再采购预计收益 ' + sale.opportunity : '') };
  }
  // 一程未必出售全部持货；具体路线已按可出售批次数检查，不能用无关滞销批次阻塞它。
  if (!canArrive(1)) return wait('本时段剩余时间不足以航行并完成出售', { mode: 'FINAL_LIQUIDATION' });

  // 刷新会改变价格，不能把补货当成确定收益：仅以本港已见折价做再折扣估算。
  const refreshIn = timing.nextRefreshAt === null ? Infinity : timing.nextRefreshAt - time;
  let stagedRoute;
  if (strict && !liquidation && free && refreshIn > 0 && (!best || refreshIn <= settings.refreshWaitSeconds) &&
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
  if (!strict && !liquidation && free > 0 && refreshIn > 0 && refreshIn <= settings.refreshWaitSeconds &&
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
    (liquidation && route.cargoOutcome.score === 0 && (route.cargoOutcome.net === 0 || settings.maxLossPercent > 0)));
  let buyRoute = stagedRoute ?? (worthBuying(best) ? best : null);
  let moveRoute = routes.find(worthSailing);
  const hasDiscountedRoute = !!moveRoute;
  let reference = false;
  const canLoad = free > 0 && player.coins > 0 && saleSlots >= 3;
  const allowReference = !liquidation && settings.estimateDiscountPercent > 0 && settings.estimateDiscountPercent < 100;
  if (!buyRoute && allowReference && (canLoad || occupied > 0)) {
    // 已有载货航线时只补同港货物，并为原本能卖的所有批次留足操作时间。
    const ports = moveRoute ? [moveRoute.port] : destinations;
    const alternatives = buildRoutes(saleSlots, false, cargoRoutesFor(ports, true), true);
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
  let estimateLabel = '整船预计净收益 ';
  if (reference) estimateLabel = '整船按未打折参考价估算收益 ';
  else if (settings.estimateDiscountPercent) estimateLabel = '整船按 ' + settings.estimateDiscountPercent + '% 风险折扣估算净收益 ';
  const saleEstimate = (def, basis, source, price) => def.itemName + '参考涨跌 ' + changeLabel(basis, def.unitPrice) +
    '（' + source + '），预计卖价 ' + price;
  if (buyRoute) {
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
    if (buyRoute.approximate) purchaseDetails.push(['配货方式', '组合搜索近似估算']);
    return { kind: 'buy', mode: tradeMode, city: cargo.cityId, destination: buyRoute.port.cityId, goodsId: purchase.goodsId,
      count: purchase.count, price: purchase.price, expectedProfit: buyRoute.net, estimated: true, purchases: buyRoute.purchases,
      ...(stagedRoute && { nextCheckAt: timing.nextRefreshAt }),
      ...(reference && !hasDiscountedRoute && { waitForFirstDeparture: true }),
      approximate: buyRoute.approximate, arrival,
      latestActionAt: timing.tradeEndTime - timing.travelSeconds - (buyRoute.batches.length + buyRoute.purchases.length * 2 + 1) * actionSeconds,
      purchaseDetails,
      label: (buyRoute.purchases.length > 1 ? '组合 ' + buyRoute.purchases.length + ' 种，本笔' : '') +
        (stagedRoute ? '刷新前买入' : '买入') + definition.itemName + ' ×' + amount.format(purchase.count) +
        '，单价 ' + amount.format(purchase.price) + '，' + buyRoute.port.cityId + ' 号港预计卖价 ' + amount.format(purchase.expectedPrice) +
        '。每格价差 ' + amount.format(purchase.marginPerSlot) + ' 商会币，' + (stagedRoute ? '已配货预计净收益 ' : '整船预计净收益 ') +
        amount.format(buyRoute.net) + ' 商会币' + riskNote };
  }
  if (moveRoute) {
    if (strict) {
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
      arrival, expectedProfit: moveRoute.cargoOutcome.net, expectedScore: moveRoute.cargoOutcome.score, estimated: true,
      latestActionAt: timing.tradeEndTime - timing.travelSeconds - Math.max(1, moveRoute.batches.length) * actionSeconds,
      salePids: moveRoute.batches.map(row => row.batch.pid), accelerationRequired: 0,
      label: (strict ? '满舱 ' + occupied + '/' + ship.capacity + ' 格，商船从港口 ' : '商船从港口 ') + cargo.cityId + ' 前往 ' + moveRoute.port.cityId + '，' + estimateLabel + moveRoute.cargoOutcome.net +
        (moveRoute.cargoOutcome.net !== moveRoute.cargoOutcome.score ? '，预计累计利润增加 ' + moveRoute.cargoOutcome.score : '') +
        '，预计释放舱位 ' + moveRoute.released + '；' + priceNote + '；到港重读实价' };
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
      .sort((a, b) => Number(player.goods.some(g => g.goodsId === b.rareGoodsId)) - Number(player.goods.some(g => g.goodsId === a.rareGoodsId)) || a.cityId - b.cityId)[0];
    const possibleBatches = explore && player.goods.filter(batch => batch.cityId !== explore.cityId && explore.specGoodsId !== batch.goodsId).length;
    const explorationBuffer = player.goods.length ? timing.travelSeconds + Math.max(1, possibleBatches) * actionSeconds : timing.travelSeconds * 2 + actionSeconds * 4;
    let latestDeparture = timing.tradeEndTime - explorationBuffer;
    if (!player.goods.length) {
      if (player.coins === 0) return wait('空船没有采购本金，留港等待');
      latestDeparture = Math.min(latestDeparture, event.endTime - settings.liquidationMinutes * 60 - timing.travelSeconds - actionSeconds);
    }
    if (explore && time < latestDeparture) return {
      kind: 'move', mode, city: cargo.cityId, destination: explore.cityId, goodsId: player.goods[0]?.goodsId ?? explore.specGoodsId,
      expectedProfit: 0, estimated: true, exploration: true, arrival,
      latestActionAt: latestDeparture,
      label: '商船从港口 ' + cargo.cityId + ' 前往 ' + explore.cityId + ' 寻价，暂无可确认的盈利路线；到港读取实价'
    };
  }
  return wait(liquidation ? '清仓阶段，停止新采购，等待符合止损上限的可执行卖价' :
    !destinations.length ? '本港暂无适合出售的批次，等待可用港口列表' : '当前没有值得执行的交易，等待本港报价或库存刷新',
    { nextCheckAt: timing.nextRefreshAt });
}
