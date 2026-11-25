// 四天配对行情模拟。输入只需海商王快照，未访问港按实测价格分布生成。
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { merchantPresets } from '../src/merchant-presets.mjs';
import { merchantPresetSettings } from '../src/merchant-preset-settings.mjs';
import { DEFAULT_SETTINGS } from '../src/automation-settings.mjs';
import { planMerchant, merchantTiming } from '../src/merchant-planner.mjs';
import { merchantStrategyPlan } from '../src/merchant-strategy.mjs';
import { planMerchantSpeed, merchantClosingRoute } from '../src/merchant-speed.mjs';

const [file, seedsArg = '8', grantSource = 'rewards', firstSeedArg = '1', selected, stockArg = '139', baseline = 'legacy'] = process.argv.slice(2);
const seeds = Number(seedsArg), firstSeed = Number(firstSeedArg);
const dailyGrant = /^\d+$/.test(grantSource) ? Number(grantSource) : null;
const sprintStock = Number(stockArg);
if (!file || !Number.isSafeInteger(seeds) || seeds < 1 || !Number.isSafeInteger(firstSeed) || firstSeed < 1 ||
  (dailyGrant !== null && !Number.isSafeInteger(dailyGrant)) || !Number.isSafeInteger(sprintStock) || sprintStock < 0 ||
  !['legacy', 'v70'].includes(baseline) || (selected && !merchantPresets.some(p => p.id === selected)))
  throw Error('用法：node tools/merchant-preset-forecast.mjs <单期观察文件> [行情组数] [rewards|到账记录.json|固定每日针数] [起始种子] [free|eventFree|sprint] [冲刺开局库存针数] [legacy|v70]');
const config = loadConfig(), defs = new Map(config.tables.TradeGoodsCfg.data.map(g => [g.goodsId, g]));
const snapshots = JSON.parse(fs.readFileSync(file, 'utf8')).entries.filter(e => e.type === 'snapshot');
const event = snapshots[0]?.event, day = 86400, pointer = '海商王加速';
if (!event || event.endTime - event.startTime !== 4 * day || snapshots.some(s =>
  s.event.period !== event.period || s.event.startTime !== event.startTime)) throw Error('需要同一完整四天期次的行情样本');
const ports = snapshots.at(-1).radar.radar.filter(p => defs.has(p.specGoodsId));
const goods = [...new Set(ports.map(p => p.specGoodsId))];
// 固定每日针数保留旧模拟口径。其余场景也把开局以后到账的免费奖励计入冲刺库存。
function forecastFunding(source) {
  if (dailyGrant !== null) return (time, profit, d, rounds) => d * dailyGrant + Math.floor(rounds * dailyGrant / 6);
  if (source !== 'rewards') {
    const ledger = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (ledger?.period !== event.period || ledger.startTime !== event.startTime || !Array.isArray(ledger.grants) || ledger.grants.some(g =>
      !g || !Number.isSafeInteger(g.time) || g.time < event.startTime || g.time >= event.endTime || !Number.isSafeInteger(g.amount) || g.amount <= 0))
      throw Error('到账记录需要同一期次及有效的到账时间和数量');
    return time => ledger.grants.reduce((sum, g) => sum + (g.time <= time ? g.amount : 0), 0);
  }
  const quantity = rewards => rewards.reduce((n, [item, count]) => n + (item === pointer ? count : 0), 0);
  const tasks = config.tables.TradeGuildTaskCfg.data;
  const reports = config.tables.TradeDayRewardCfg.data;
  const pass = config.tables.TradePassCfg.data.filter(row => row.period === event.period && quantity(row.freeReward));
  // 联盟满参与情景：把当天任务和三档商情奖励分配到六轮刷新；战令按模拟累计利润解锁。
  const byDay = [];
  let prior = 0;
  for (let d = 0; d < 4; d++) {
    const unlocked = tasks.filter(row => row.day === d + 1);
    const grants = Array.from({length: 7}, (_, rounds) => prior + [unlocked, reports].reduce((sum, rows) =>
      sum + rows.slice(0, Math.floor(rounds * rows.length / 6)).reduce((n, r) => n + quantity(r.rewards), 0), 0));
    byDay.push(grants);
    prior = grants[6];
  }
  return (time, profit, d, rounds) => byDay[d][rounds] + pass.reduce((sum, tier) => sum + (profit >= tier.reqScore ? quantity(tier.freeReward) : 0), 0);
}
const earnedAt = forecastFunding(grantSource);
const roles = new Map(), seen = new Set();
const timings = new Map();
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
function addSample(key, value) {
  if (!roles.has(key)) roles.set(key, []);
  roles.get(key).push(value);
}
for (const s of snapshots) {
  const m = s.market, key = m.cityId + ':' + s.marketEpoch;
  if (!m.rareGoodsId || !merchantTiming(config, event, m.observedAt).tradingOpen) continue;
  if (Number.isFinite(s.actionSeconds) && s.actionSeconds > 0) {
    if (!timings.has(key)) timings.set(key, []);
    timings.get(key).push(s.actionSeconds);
  }
  if (seen.has(key)) continue;
  seen.add(key);
  for (const row of m.goods) {
    const def = defs.get(row.goodsId);
    const role = row.goodsId === m.specGoodsId ? 'special' : row.goodsId === m.rareGoodsId ? 'rare' : 'ordinary';
    const observed = { priceRatio: row.price / def.unitPrice, usedFraction: row.stock / def.maxCount };
    addSample(role, observed);
    addSample(role + def.qualityIndex, observed);
  }
}
if (!roles.has('special') || !roles.has('rare') || !roles.has('ordinary') || !timings.size) throw Error('快照缺少可用的行情或操作间隔');
const step = Math.max(60, Math.ceil(median(Array.from(timings.values(), median))));
function makeWorld(seed) {
  let randomState = seed;
  const random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
  const world = [];
  for (let d = 0; d < 4; d++) {
    const order = ports.map(p => ({ ...p, roll: random() })).sort((a,b) => a.roll-b.roll);
    const offset = 1 + Math.floor(random() * (order.length - 1));
    const cities = order.map((p,i) => ({ cityId: p.cityId, specGoodsId: p.specGoodsId,
      rareGoodsId: order[(i + offset) % order.length].specGoodsId, reveal: Math.floor(i * 6 / order.length) }));
    for (let round = 0; round < 6; round++) {
      const markets = new Map(cities.map(port => [port.cityId, { ...port, goods: goods.map(goodsId => {
        const def = defs.get(goodsId), role = goodsId === port.specGoodsId ? 'special' : goodsId === port.rareGoodsId ? 'rare' : 'ordinary';
        const pool = roles.get(role + def.qualityIndex) ?? roles.get(role);
        const observed = pool[Math.floor(random() * pool.length)];
        return { goodsId, price: Math.round(def.unitPrice * observed.priceRatio), stock: Math.round(def.maxCount * observed.usedFraction) };
      }) }]));
      world.push({ cities, markets });
    }
  }
  return world;
}

function simulate(world, settings) {
  const cargo = { cityId: ports[0].cityId, cargoLv: 1, moveStartTime: 0, moveEndTime: 0, moveToCityId: 0 };
  const player = { coins: 10000, profit: 0, goods: [] }, state = { period: event.period, player, cargo };
  const markets = new Map(), seenToday = new Set(), departures = {}, itinerary = new Set();
  const daily = [0,0,0,0];
  const milestones = {};
  let time = event.startTime + 8 * 3600, priorDay = -1, pid = 0, pins = 0, moves = 0, voyage = {}, openingCargo = [];
  const possibleStock = earned => settings.speedUpMode === 'eventFree' ? earned : sprintStock + (dailyGrant === null ? earned : 0);
  while (time < event.endTime) {
    const d = Math.floor((time - event.startTime) / day);
    const timing = merchantTiming(config, event, time);
    const round = Math.max(0, Math.min(5, Math.floor((time - timing.tradeStartTime) / 7200)));
    const book = world[d * 6 + round];
    if (priorDay !== d) { priorDay = d; seenToday.clear(); }
    const radar = { radar: book.cities.map(p => ({ cityId: p.cityId, specGoodsId: p.specGoodsId,
      rareGoodsId: timing.tradingOpen && (p.reveal <= round || seenToday.has(p.cityId)) ? p.rareGoodsId : 0 })) };
    const earned = earnedAt(time, player.profit, d, time < timing.tradeStartTime ? 0 : round + 1);
    if (pins > possibleStock(earned)) throw Error('已用针数超过当时到账库存');
    const balance = possibleStock(earned) - pins;
    const budget = { stock: new Map([[pointer,balance]]), dailyUsed: daily[d], periodRemaining: Math.min(balance,
      settings.periodPointerLimit >= 0 ? settings.periodPointerLimit - pins : Infinity) };
    const history = [...markets.values()];
    if (cargo.moveToCityId && time < cargo.moveEndTime) {
      const speed = planMerchantSpeed(config,event,state,radar,budget.stock,settings,time,{...budget, markets:history,
        usedPointers:voyage.pins, closingPointers:voyage.closing, plannedOpening:voyage.opening, exploration:voyage.exploration, actionSeconds:step});
      if (speed.kind === 'speed') {
        pins += speed.useNum; daily[d] += speed.useNum; voyage.pins += speed.useNum;
        cargo.moveEndTime = speed.expected.afterEndTime;
        time += step;
      } else time = Math.min(cargo.moveEndTime, time + (settings.autoSpeedUp ? step : 7200));
      continue;
    }
    if (cargo.moveToCityId) {
      cargo.cityId = cargo.moveToCityId; cargo.moveStartTime = cargo.moveToCityId = cargo.moveEndTime = 0;
    }
    if (!timing.tradingOpen && (moves || d > 0)) {
      time = time < timing.tradeStartTime ? timing.tradeStartTime : timing.tradeStartTime + day; continue;
    }
    const nextLevel = config.tables.TradeShipCfg.data.find(s => s.lv === cargo.cargoLv + 1);
    if (settings.autoUpgrade && nextLevel && player.profit >= nextLevel.upMoney) { cargo.cargoLv++; time += step; continue; }
    const market = { ...book.markets.get(cargo.cityId), period:event.period, startTime:event.startTime, observedAt:time };
    if (timing.tradingOpen) {
      seenToday.add(cargo.cityId);
      radar.radar.find(p => p.cityId === cargo.cityId).rareGoodsId = market.rareGoodsId;
      markets.set(timing.marketEpoch + ':' + cargo.cityId, structuredClone(market));
    }
    const options = { markets:history, settings, actionSeconds:step, preferredPort:voyage.origin, plannedOpening:voyage.opening, openingCargoPids:openingCargo };
    let plan = planMerchant(config,event,state,market,radar,time,[...itinerary],options);
    if (settings.autoSpeedUp && ['goal', 'eventFree', 'targetFirst'].includes(settings.speedUpMode) && !openingCargo.length &&
      timing.tradingOpen && (plan.kind === 'wait' || plan.exploration || plan.mode === 'OVERNIGHT') &&
      time + timing.travelSeconds + (1 + 2 * market.goods.length + player.goods.length) * step >= timing.tradeEndTime)
      plan = merchantClosingRoute(config,event,state,market,radar,radar,time,[...itinerary],options,budget) ?? plan;
    plan = merchantStrategyPlan(plan,config,event,state,settings,time,{keyRecords:()=>departures});
    if (plan.kind === 'buy') {
      const q = market.goods.find(g => g.goodsId === plan.goodsId);
      if (plan.count * q.price > player.coins || q.stock + plan.count > defs.get(q.goodsId).maxCount) throw Error('采购越界');
      player.coins -= q.price * plan.count; q.stock += plan.count;
      const batch = player.goods.find(g => g.cityId === cargo.cityId && g.goodsId === q.goodsId && g.buyPrice === q.price);
      if (batch) batch.num += plan.count;
      else player.goods.push({ pid:++pid, goodsId:q.goodsId, num:plan.count, cityId:cargo.cityId, buyPrice:q.price });
      itinerary.clear();
    } else if (plan.kind === 'sell') {
      const g = player.goods.find(b => b.pid === plan.pid);
      player.coins += g.buyPrice * g.num + plan.gain; player.profit += Math.max(0,plan.gain);
      for (const target of [1000000,5000000,50000000]) {
        if (player.profit >= target && milestones[target] === undefined) milestones[target] = pins;
      }
      player.goods = player.goods.filter(b => b.pid !== g.pid);
      openingCargo = openingCargo.filter(p => p !== g.pid); itinerary.clear();
    } else if (plan.kind === 'move') {
      voyage = {origin:cargo.cityId, opening:plan.plannedOpening, exploration:plan.exploration, pins:0, closing:plan.accelerationRequired};
      openingCargo = plan.plannedOpening ? player.goods.map(b => b.pid) : [];
      itinerary.add(cargo.cityId); cargo.moveStartTime = time; cargo.moveEndTime = time + timing.travelSeconds;
      cargo.moveToCityId = plan.destination;
      departures[++moves] = {confirmed:true, details:{scope:'merchant:'+event.startTime+':'+event.period, expected:{request:'TradeMoveRequest',start:time}}};
    } else {
      const next = Math.min(plan.nextCheckAt || Infinity, timing.nextRefreshAt || Infinity, timing.tradeEndTime > time ? timing.tradeEndTime : Infinity);
      time = Math.max(time + step, Math.min(next, timing.tradingOpen ? time + 900 : timing.tradeStartTime)); continue;
    }
    time += step;
  }
  const earned = earnedAt(event.endTime - 1, player.profit, 3, 6);
  if (pins > (settings.periodPointerLimit < 0 ? Infinity : settings.periodPointerLimit) ||
    daily.some(n => n > settings.dailyPointerLimit) || pins > possibleStock(earned))
    throw Error('指针使用超过预算');
  return {profit:player.profit,pins,moves,milestones,earned,dailyPins:daily};
}
for (let seed = firstSeed; seed < firstSeed + seeds; seed++) {
  for (const preset of merchantPresets) {
    if (selected && preset.id !== selected) continue;
    const current = preset.settings.merchant;
    const old = merchantPresetSettings(DEFAULT_SETTINGS.merchant, baseline)[preset.id];
    const before = simulate(makeWorld(seed),old), after = simulate(makeWorld(seed),current);
    console.log(JSON.stringify({seed,preset:preset.id,grantSource,dailyGrant,sprintStock,baseline,actionSeconds:step,before,after,saved:before.pins-after.pins}));
  }
}
