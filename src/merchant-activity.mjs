import { exactAutomationId } from './automation-policy.mjs';
import { claimOnce } from './extra-free-rewards.mjs';
import { checkedAction, clock, dayOf, digest, hasReward, moduleOpen, natural, positive, read, table, waiting, windowOpen } from './activity-actions.mjs';
import { claimPass } from './seasonal-activities.mjs';
import { merchantActionSeconds, merchantFinalCargoStart, merchantSettings, merchantTiming, planMerchant } from './merchant-planner.mjs';
import { merchantSpeedMatches, runMerchantSpeed } from './merchant-speed.mjs';
import { rewardData } from './missing-rewards.mjs';
import { recordMerchantSnapshot, recordMerchantTrade, merchantJournalSummary, readMerchantJournal, knownMerchantMarkets } from './merchant-journal.mjs';
import { evaluateMerchantUpgrade, runMerchantUpgrade } from './merchant-upgrade.mjs';
import { watchMerchant } from './merchant-monitor.mjs';
import { merchantStrategyPlan, reconcileMerchantAction } from './merchant-strategy.mjs';
import { runMerchantReport } from './merchant-report.mjs';
import { merchantGoal } from './merchant-goal.mjs';
import { resolveMerchantIntel, merchantEditView, portRevision } from './merchant-intel.mjs';
import { materialIcon } from './art.mjs';

export { planMerchant } from './merchant-planner.mjs';
const param = (config, key) => table(config, 'ActivityTradeCfg').find(row => row.key === key)?.value;
function tradingHours(config, time) {
  return merchantTiming(config, null, time).tradingOpen;
}
const quantity = (state, id, city, price) => state.goods
  .filter(g => g.goodsId === id && g.cityId === city && (price == null || g.buyPrice === price))
  .reduce((sum, g) => sum + g.num, 0);
const fingerprint = state => ({ coins: state.player.coins, profit: state.player.profit, goods: state.player.goods, cargo: state.cargo });
const cargoSignature = state => digest([state.player.coins, state.player.goods?.map(g =>
  [g?.pid, g?.goodsId, g?.cityId, g?.buyPrice, g?.num]).sort((a, b) => a[0] - b[0])]);
function marketEpoch(config, time) {
  return merchantTiming(config, null, time).marketEpoch;
}
function voyageHistory(ledger, scope, epoch, state, time) {
  const signature = cargoSignature(state);
  const legs = Object.values(ledger?.keyRecords() ?? {}).filter(r => r.confirmed && r.details?.scope === scope)
    .map(r => r.details.expected).filter(e => e?.request === 'TradeMoveRequest' && (!positive(e.start) || e.start <= time));
  const previous = legs.filter(e => positive(e.start) && e.destination === state.cargo.cityId).sort((a, b) => b.start - a.start)[0];
  const visited = [...new Set(legs.filter(e => e.cargoSignature ? e.cargoSignature === signature : e.marketEpoch === epoch).map(e => e.city))];
  return { visited, preferredPort: previous?.city };
}
// 每期每港仅留一个亲自读取的快照。展示页只读，不能借展示更新采集时间。
function rememberMarket(ledger, snapshot) {
  if (!ledger || !positive(snapshot.cityId) || !Array.isArray(snapshot.goods) ||
    snapshot.goods.some(g => !g || !positive(g.goodsId) || !positive(g.price) || !natural(g.stock)) ||
    new Set(snapshot.goods.map(g => g.goodsId)).size !== snapshot.goods.length) return;
  const key = 'merchant-market:' + snapshot.startTime + ':' + snapshot.period + ':' + snapshot.cityId;
  const details = { merchantMarket: snapshot };
  if (ledger.hasKey(key)) ledger.resolveKey(key, true, details);
  else ledger.confirm(ledger.reserve({}, {}, {}, { uniqueKey: key, details }));
}
async function readMerchantPlan(config, event, state, time, ask, voyage, options = {}) {
  let market;
  try { market = await ask('TradeCity', { cityId: state.cargo.cityId }); }
  catch { return { kind: 'wait', reason: '等待本港报价更新' }; }
  const observedAt = options.now?.() ?? time;
  const marketSnapshot = { ...market, cityId: state.cargo.cityId, observedAt, period: event.period, startTime: event.startTime };
  options.remember?.(marketSnapshot);
  let radar;
  try { radar = await ask('TradeGuildRadar'); }
  catch { radar = null; }
  const plannedAt = options.now?.() ?? time;
  const intel = options.intel ?? resolveMerchantIntel(config, event, options.player, radar, plannedAt, options.ledger);
  const effective = intel.radar;
  const plan = planMerchant(config, event, state, marketSnapshot, effective, plannedAt, voyage.visited,
    { ...options, preferredPort: voyage.preferredPort });
  if (Array.isArray(effective?.radar) && effective.radar.some(port => port?.manualIntel && port.cityId === plan.destination))
    plan.label += '；目的港参考手动情报';
  options.observed?.({ state, market: marketSnapshot, radar: effective, plan });
  const strategy = merchantStrategyPlan(plan, config, event, state, merchantSettings(options.settings), options.now?.() ?? time, options.ledger);
  return { ...strategy, marketSnapshot, radarSnapshot: radar ?? { radar: [] }, intelScope: intel.scope, intelVersion: digest(intel.edits) };
}

// 复用当前连接的只读诊断；航行中不探测异地报价。
export async function readMerchantStatus(client, config, { player, ledger, settings = {} } = {}) {
  const time = clock(client), event = client.tradeWindow && { ...client.tradeWindow };
  const history = merchantJournalSummary(ledger, undefined, { time });
  if (!event?.period || !windowOpen(event, time) || !moduleOpen(config, player, '海商王'))
    return { checkedAt: time, event, available: false, reason: '海商王当前未开放或未解锁', history };
  const state = await read(client, 'TradeInfo');
  if (state.period !== event.period || !state.cargo || !state.player)
    return { checkedAt: time, event, available: false, reason: '商船状态尚未同步', history };
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  const inTransit = state.cargo.moveEndTime > clock(client) || state.cargo.moveToCityId && state.cargo.moveToCityId !== state.cargo.cityId;
  const plan = inTransit ? { kind: 'wait', reason: '航行中，等待到港后读取本港报价' } :
    await readMerchantPlan(config, event, state, time, (name, body) => read(client, name, body),
      voyageHistory(ledger, scope, marketEpoch(config, time), state, time), { settings: settings.merchant, ledger, player,
        markets: knownMerchantMarkets(ledger, event), actionSeconds: merchantActionSeconds(settings), now: () => clock(client) });
  const upgrade = inTransit ? { eligible: false, reason: '航行中不升级' } :
    evaluateMerchantUpgrade(config, event, state, clock(client), settings.merchant);
  return { checkedAt: clock(client), available: true, event, state, plan, upgrade, goal: merchantGoal(config, event, state, clock(client), settings),
    journal: merchantJournalSummary(ledger, event, { time: clock(client) }), history,
    monitoring: watchMerchant(client).snapshot() };
}

export { readMerchantJournal, merchantJournalSummary };

export async function readMerchantOverview(client, config, context) {
  const event = { ...client.tradeWindow };
  const serverNow = () => (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
  const checkedAt = serverNow();
  if (!positive(event.period) || !positive(event.startTime) || !positive(event.endTime) ||
    event.endTime <= event.startTime || event.endTime <= checkedAt || !moduleOpen(config, context.player, '海商王')) return null;
  const window = { startTime: event.startTime, endTime: event.endTime };
  if (checkedAt < event.startTime) return { ...window, serverNow: checkedAt };
  let panel;
  try {
    panel = await readMerchantPanel(client, config, event, context);
  } catch {
    panel = { lines: ['本期商船数据读取失败，等待总览刷新'] };
  }
  const now = serverNow();
  if (!client.connected || !windowOpen(event, now) || event.period !== client.tradeWindow?.period ||
    event.startTime !== client.tradeWindow.startTime || event.endTime !== client.tradeWindow.endTime) return null;
  return { ...window, serverNow: now, ...panel };
}

async function readMerchantPanel(client, config, event, { player, ledger, settings }) {
  const state = await read(client, 'TradeInfo');
  if (state.period !== event.period || !state.player || !state.cargo) return { lines: ['本期商船数据待同步'] };
  const time = clock(client), goal = merchantGoal(config, event, state, time, settings);
  const format = value => natural(value) ? value.toLocaleString('zh-CN') : '未同步';
  const guildId = exactAutomationId(player.guildId);
  const reply = exactGuild(guildId) ? await read(client, 'TradeGuildRadar').catch(() => null) : null;
  const radar = guildId === exactAutomationId(player.guildId) ? reply : null;
  const resolved = resolveMerchantIntel(config, event, player, radar, clock(client), ledger);
  // 航行中也能查看联盟共享；靠港规划复用同一次读取。
  const ask = (name, body) => name === 'TradeGuildRadar' ? radar : read(client, name, body);
  const voyage = await readMerchantVoyage(config, event, state, player, time, ask, ledger, settings, resolved);
  const intel = merchantPortIntel(config, player, state.cargo, guildId === exactAutomationId(player.guildId) ? radar : null, resolved);
  const lines = ['第 ' + event.period + ' 期 · 商会币 ' + format(state.player.coins) + ' · 商船等级 ' + format(state.cargo.cargoLv), merchantVoyageText(voyage)];
  const journal = merchantJournalSummary(ledger, event, { time });
  lines.push('本期已核实买入 ' + journal.buys + ' 笔、卖出 ' + journal.sells + ' 笔 · 已实现净利润 ' + journal.realizedProfit.toLocaleString('zh-CN'));
  const policy = merchantSettings(settings?.merchant);
  lines.push('指南针加速' + (policy.autoSpeedUp ? '已开启' : '已关闭') +
    ' · 钻石补购' + (policy.autoBuyPointers ? '已开启' : '已关闭') +
    ' · 本期已核实用针 ' + format(journal.pointerUsed) + ' 根');
  const notes = [];
  if (goal.remaining > 0 && goal.freeTrips !== null) {
    lines.push('按当日到港卖出、每程一批估算，剩余免费卖货机会最多 ' + goal.freeTrips + ' 程' +
      (goal.freeTrips ? ' · 每程平均需赚 ' + format(goal.requiredPerFreeTrip) : ''));
    if (goal.benchmark && goal.requiredPerFreeTrip > goal.benchmark.profit)
      notes.push('按 ' + goal.benchmark.level + ' 级船满仓、零进货成本和折后基准价估算，每程利润最多约 ' +
        format(goal.benchmark.profit) + '。实际收益随港口报价变化。');
  }
  if (settings?.merchant?.profitLimit > 0 && settings.merchant.profitLimit < goal.target && goal.remaining > 0)
    notes.push('自动走商累计利润上限 ' + format(settings.merchant.profitLimit) + '，低于 5000 万目标');
  const rewardIds = new Set(goal.tiers.flatMap(tier => tier.rewards.map(([id]) => id)));
  const rewardItems = Object.fromEntries(Array.from(rewardIds, id => {
    const name = config.materialName(id);
    return [id, { name: name === '未知材料' ? id : name, icon: materialIcon(id) }];
  }));
  return { goal, lines: lines.concat(notes), rewardItems, trade: {
    period: event.period, coins: state.player.coins, level: state.cargo.cargoLv, voyage, intel,
    buys: journal.buys, sells: journal.sells, realizedProfit: journal.realizedProfit, pointerUsed: journal.pointerUsed,
    autoSpeedUp: policy.autoSpeedUp, autoBuyPointers: policy.autoBuyPointers, notes,
  } };
}

function merchantVoyageText({ facts, status }) {
  return [...facts.map(([label, value]) => label + '：' + value), status].filter(Boolean).join(' · ');
}

export async function merchantProgress(...args) {
  return merchantVoyageText(await readMerchantVoyage(...args));
}

function expectedProfitFact(amount, exploration = false) {
  return ['预期收益', exploration ? '待到港询价' : Number.isSafeInteger(amount)
    ? '约 ' + amount.toLocaleString('zh-CN') + ' 商会币' : '待估算'];
}

function departureProfit(config, event, state, scope, leg, ledger) {
  if (!leg || leg.exploration) return null;
  if (Number.isSafeInteger(leg.estimatedProfit)) return leg.estimatedProfit;
  // 旧出航记录没有保存估值，只用出发前已观察的商情还原同一程。
  const snapshots = readMerchantJournal(ledger, event).filter(entry => entry.type === 'snapshot' && entry.time <= leg.start);
  const signature = cargoSignature(state);
  const departure = snapshots.findLast(entry => entry.state.cargo.cityId === leg.city &&
    entry.state.cargo.cargoLv === state.cargo.cargoLv && cargoSignature(entry.state) === signature);
  if (!departure) return null;
  const voyage = voyageHistory(ledger, scope, marketEpoch(config, leg.start), departure.state, leg.start);
  const plan = planMerchant(config, event, departure.state, departure.market, departure.radar, leg.start, voyage.visited, {
      markets: snapshots.map(entry => entry.market), settings: { fullCargoRoutes: false, ...departure.settings },
      preferredPort: voyage.preferredPort, actionSeconds: departure.actionSeconds
    });
  return plan.kind === 'move' && !plan.exploration && plan.destination === leg.destination ? plan.expectedProfit : null;
}

function merchantNames(config, player) {
  const goods = table(config, 'TradeGoodsCfg');
  const cities = table(config, (player.scenarioId || 1) + '_CityCfg');
  return {
    goodsName: id => goods.find(g => g.goodsId === id)?.itemName || '商品 ' + id,
    cityName: id => cities.find(c => c.id === id)?.name || '港口 ' + id,
  };
}

function merchantPortIntel(config, player, cargo, radar, { scope, nextRefreshAt, edits }) {
  if (!exactGuild(player.guildId)) return { scope, message: '加入联盟后可查看港口情报。' };
  if (!Array.isArray(radar?.radar)) return { scope, message: '港口情报读取失败，请刷新总览重试。' };
  const { cityName, goodsName } = merchantNames(config, player);
  const destination = cargo.moveToCityId !== cargo.cityId ? cargo.moveToCityId : null;
  const ports = radar.radar.filter(row => positive(row?.cityId))
    .sort((a, b) => Number(b.cityId === destination) - Number(a.cityId === destination) || a.cityId - b.cityId)
    .map(row => ({
      cityId: row.cityId, city: cityName(row.cityId),
      revision: portRevision(row), specialtyId: row.specGoodsId || 0, shortageId: row.rareGoodsId || 0,
      position: row.cityId === destination ? '目的港' : row.cityId === cargo.cityId ? (destination ? '出发港' : '所在港') : null,
      specialty: positive(row.specGoodsId) ? goodsName(row.specGoodsId) : null,
      shortage: positive(row.rareGoodsId) ? goodsName(row.rareGoodsId) : null,
      reporter: row.reportName?.trim() || null,
    }));
  const catalog = table(config, 'TradeGoodsCfg').map(row => ({ id: row.goodsId, name: row.itemName }));
  const goods = [...new Set(catalog.map(row => row.name).filter(Boolean))];
  return { scope, ports, goods, catalog, edits: merchantEditView(edits), nextRefreshAt,
    ...(!ports.length && { message: '联盟暂无港口情报。' }) };
}

async function readMerchantVoyage(config, event, state, player, time, ask, ledger, settings, intel) {
  const cargo = state.cargo;
  const { cityName, goodsName } = merchantNames(config, player);
  const goods = state.player.goods;
  const stock = !Array.isArray(goods) ? '未同步' : goods.length ?
    goods.map(g => goodsName(g.goodsId) + ' ×' + g.num).join('、') : '空载';
  const facts = [['当前商品', stock]];
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  if (cargo.moveEndTime > time || (cargo.moveToCityId && cargo.moveToCityId !== cargo.cityId)) {
    const leg = Object.values(ledger?.keyRecords() ?? {}).find(r => {
      const e = r.details?.expected;
      return r.details?.scope === scope && e?.request === 'TradeMoveRequest' && e.city === cargo.cityId &&
        e.destination === cargo.moveToCityId && positive(cargo.moveStartTime) &&
        (r.details.after?.cargo?.moveStartTime === cargo.moveStartTime || Math.abs(e.start - cargo.moveStartTime) <= 2);
    })?.details.expected;
    if (leg?.goodsId) facts.push(['本程商品', goodsName(leg.goodsId)]);
    if (positive(cargo.cityId)) facts.push(['出发港', cityName(cargo.cityId)]);
    facts.push(['目标城池', positive(cargo.moveToCityId) ? cityName(cargo.moveToCityId) : '未同步']);
    facts.push(expectedProfitFact(departureProfit(config, event, state, scope, leg, ledger), leg?.exploration));
    return { facts, status: cargo.moveEndTime > time ? '航行中，预计 ' + new Date(cargo.moveEndTime * 1000)
      .toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 到港' + (leg?.priceNote ? '；出发时' + leg.priceNote : '') : '等待到港确认' };
  }
  if (positive(cargo.cityId)) facts.push(['所在城池', cityName(cargo.cityId)]);
  const wait = status => ({ facts: [...facts, ['目标城池', '待定'], expectedProfitFact(null)], status });
  if (!tradingHours(config, time)) return wait('等待开放交易时段');
  if (!exactGuild(player.guildId)) return wait('需加入联盟后参与贸易');
  if (!positive(cargo.cityId)) return wait('等待商船位置同步');
  const pending = Object.values(ledger?.keyRecords() ?? {}).find(r => !r.confirmed && r.details?.scope === scope);
  if (pending) return wait('前次操作结果待确认');
  const plan = await readMerchantPlan(config, event, state, time, ask,
    voyageHistory(ledger, scope, marketEpoch(config, time), state, time), {
      settings: settings?.merchant ?? settings, ledger, player, intel, markets: knownMerchantMarkets(ledger, event), actionSeconds: merchantActionSeconds(settings)
    });
  if (plan.kind === 'wait') return wait(plan.reason);
  if (plan.goodsId) facts.push(['计划' + ({ buy: '买入', sell: '卖出', move: '走商' })[plan.kind], goodsName(plan.goodsId)]);
  else facts.push(['计划走商', '换港寻价']);
  facts.push(['目标城池', cityName(plan.destination ?? plan.city)]);
  facts.push(expectedProfitFact(plan.expectedProfit, plan.exploration));
  return { facts, status: plan.label, ...(plan.purchaseDetails && { purchaseDetails: plan.purchaseDetails }) };
}
const samePlan = (a, b) => a.kind === b.kind &&
  ['city', 'destination', 'goodsId', 'pid', 'count', 'price', 'gain', 'mode', 'exploration'].every(k => a[k] === b[k]);
function validFingerprint(s) {
  return s?.cargo && natural(s.coins) && natural(s.profit) && Array.isArray(s.goods) &&
    s.goods.every(g => g && natural(g.pid) && positive(g.goodsId) && positive(g.cityId) && positive(g.buyPrice) && positive(g.num)) &&
    new Set(s.goods.map(g => g.pid)).size === s.goods.length;
}
function actionMatched(e, s, time) {
  if (!validFingerprint(s)) return false;
  if (e.request === 'TradeSpeedRequest') return merchantSpeedMatches(e, s, time);
  if (e.request === 'TradeBuyRequest')
    return s.coins === e.coins && quantity(s, e.goodsId, e.city, e.price) >= e.owned;
  if (e.request === 'TradeSellRequest') {
    if (s.goods.some(g => g.pid === e.pid)) return false;
    // 兼容历史账本；新记录还核对整批回款，亏损卖出不增加累计利润。
    if (e.gain == null) return s.coins > e.coins && s.profit > e.profit;
    return s.coins >= e.coins + e.proceeds && s.profit >= e.profit + Math.max(0, e.gain);
  }
  if (e.request !== 'TradeMoveRequest') return false;
  return s.cargo.cityId === e.destination ||
    (s.cargo.moveToCityId === e.destination && s.cargo.moveEndTime >= e.start);
}

export async function merchantActivity(client, config, ctx) {
  const event = client.tradeWindow && { ...client.tradeWindow };
  if (ctx.key === 'merchantTrade') {
    watchMerchant(client).observe({ event, time: clock(client), config, settings: ctx.settings?.() });
  }
  const actor = () => JSON.stringify([ctx.player?.playerId, ctx.player?.worldId, ctx.player?.guildId]);
  const identity = actor();
  const allowed = () => ctx.enabled() && ctx.settings?.()?.merchant?.enabled !== false && client.connected !== false && actor() === identity && moduleOpen(config, ctx.player, '海商王') &&
    windowOpen(client.tradeWindow, clock(client)) && client.tradeWindow?.period === event?.period &&
    client.tradeWindow.startTime === event.startTime && client.tradeWindow.endTime === event.endTime;
  if (!event?.period || !allowed()) return waiting(ctx, '海商王本期尚未开放');
  if (ctx.key === 'merchantTrade' && !exactGuild(ctx.player.guildId)) return waiting(ctx, '需加入联盟后参与贸易');
  const getState = () => read(client, 'TradeInfo');
  const info = await getState();
  if (!allowed()) return waiting(ctx, '开关、账号或活动状态已变化');
  if (info.period !== event.period || !info.player || !info.cargo) return waiting(ctx, '海商王期数或商船状态未确认');
  const scope = 'merchant:' + event.startTime + ':' + event.period;
  if (ctx.key === 'merchantRewards') {
    await merchantRewards(client, config, ctx, event, info, allowed, getState);
    return;
  }
  const onOutcome = data => recordMerchantTrade(ctx.ledger, { event, ...data, time: data.time ?? clock(client) });
  ctx = Object.assign(Object.create(ctx), { onMerchantOutcome: onOutcome });
  watchMerchant(client).observe({ event, state: info, time: clock(client), config, settings: ctx.settings?.() });
  // 已确认业务证据先持久化；统计写入失败或崩溃后仅补录，不重发游戏请求。
  for (const [key, record] of Object.entries(ctx.ledger?.keyRecords() ?? {})) {
    if (!record.confirmed || ![scope, 'merchant-upgrade:' + event.startTime + ':' + event.period].includes(record.details?.scope) ||
      record.details.journalRecorded || !record.details.before || !record.details.after) continue;
    try {
      onOutcome({ actionKey: key, expected: record.details.expected, before: record.details.before, after: record.details.after,
        attemptedAt: record.details.attemptedAt, time: record.details.confirmedAt, actualDiamondSpent: record.details.actualDiamondSpent, status: 'confirmed' });
      ctx.ledger.resolveKey(key, true, { ...record.details, journalRecorded: true });
    } catch (error) { waiting(ctx, '已确认成交的统计暂未补录：' + error.message); }
  }
  // 先核对上次写入，再检查航行/盈亏，避免已售批次消失后永久停在未知状态。
  const pending = Object.entries(ctx.ledger?.keyRecords() ?? {}).find(([, r]) => !r.confirmed && r.details?.scope === scope);
  if (pending) return reconcileMerchantAction(client, ctx, pending, fingerprint(info), actionMatched);
  if (!tradingHours(config, clock(client))) return waiting(ctx, '等待游戏规定的贸易时段 ' + param(config, '海商王贸易时间'));
  const profitLimit = ctx.settings?.()?.merchant?.profitLimit ?? 0;
  const profitReached = profitLimit > 0 && info.player.profit >= profitLimit;
  if (profitReached && (!merchantSettings(ctx.settings?.()?.merchant).autoShareIntel ||
    info.cargo.moveEndTime > clock(client) || info.cargo.moveToCityId && info.cargo.moveToCityId !== info.cargo.cityId))
    return waiting(ctx, '已达本期累计利润上限，领奖仍按独立开关执行');
  if (info.cargo.moveEndTime > clock(client)) {
    if (await runMerchantSpeed(client, config, ctx, event, info)) return;
    return waiting(ctx, '航行中，预计 ' + new Date(info.cargo.moveEndTime * 1000)
      .toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' 到港');
  }
  if (info.cargo.moveToCityId && info.cargo.moveToCityId !== info.cargo.cityId)
    return waiting(ctx, '等待服务端确认到港');
  const policy = merchantSettings(ctx.settings?.()?.merchant);
  const dockedAt = clock(client);
  const finalStart = merchantFinalCargoStart(merchantTiming(config, event, dockedAt), event, policy, info.player.goods, info.cargo.cityId);
  const unloading = finalStart !== null && dockedAt >= finalStart;
  const upgrade = () => runMerchantUpgrade(client, config, Object.assign(Object.create(ctx), { enabled: allowed }), event, info);
  if (!profitReached && !unloading && await upgrade()) return;
  const epoch = () => marketEpoch(config, clock(client));
  const currentEpoch = epoch();
  const policyStamp = JSON.stringify(policy);
  const actionSeconds = () => positive(ctx.merchantCadenceSeconds)
    ? Math.max(60, ctx.merchantCadenceSeconds)
    : merchantActionSeconds(ctx.settings?.(), Math.ceil((ctx.everyMs ?? 0) / 1000));
  const actionInterval = actionSeconds();
  const snapshot = state => readMerchantPlan(config, event, state, clock(client),
    (name, body) => read(client, name, body), voyageHistory(ctx.ledger, scope, currentEpoch, state, clock(client)), {
      settings: policy, ledger: ctx.ledger, player: ctx.player, markets: knownMerchantMarkets(ctx.ledger, event), now: () => clock(client), actionSeconds: actionInterval,
      remember: market => rememberMarket(ctx.ledger, market),
      observed: observed => {
        recordMerchantSnapshot(ctx.ledger, { ...observed, event, time: clock(client), config, settings: ctx.settings?.(), actionSeconds: actionInterval });
        watchMerchant(client).observe({ ...observed, event, time: clock(client), config, settings: ctx.settings?.() });
      }
    });
  const plan = await snapshot(info);
  if (!profitReached && unloading && plan.kind !== 'sell' && await upgrade()) return;
  if (plan.marketSnapshot) await runMerchantReport(client, config,
    Object.assign(Object.create(ctx), { enabled: allowed }), event, info, { market: plan.marketSnapshot });
  if (!allowed()) return waiting(ctx, '开关、账号或活动状态已变化');
  if (profitReached) return waiting(ctx, '已达本期累计利润上限，本港共享已检查，领奖仍按独立开关执行');
  if (plan.kind === 'wait') return waiting(ctx, plan.reason);
  const fresh = await getState();
  if (fresh.period !== event.period || !allowed()) return waiting(ctx, '期数或活动状态已变化');
  const verified = await snapshot(fresh);
  if (!samePlan(plan, verified) || epoch() !== currentEpoch)
    return waiting(ctx, '港口价格、库存或目的港已变化，下一轮重算');
  const state = fingerprint(fresh);
  const send = async (name, body, response) => {
    try { return rewardData(await client.request(name, body, response)); }
    catch (error) {
      // 只采用原写请求的未发送证据，回读失败不能释放已发送的票据。
      if (error.notSent === true) error.released = true;
      throw error;
    }
  };
  const common = {
    scope, before: state, label: verified.label, retainEvidence: true, attemptedAt: clock(client), onOutcome, now: () => clock(client),
    allowed: () => allowed() && tradingHours(config, clock(client)) && epoch() === currentEpoch &&
      JSON.stringify(merchantSettings(ctx.settings?.()?.merchant)) === policyStamp &&
      digest(ctx.ledger?.merchantEdits?.(verified.intelScope) ?? {}) === verified.intelVersion &&
      actionSeconds() === actionInterval &&
      clock(client) - verified.marketSnapshot.observedAt <= policy.quoteMaxAgeSeconds &&
      ((plan.kind === 'sell' && verified.latestActionAt == null) || (positive(verified.latestActionAt) && clock(client) < verified.latestActionAt)) &&
      (plan.kind === 'sell' || clock(client) + merchantTiming(config, event, clock(client)).travelSeconds + actionInterval <
        Math.min(event.endTime, merchantTiming(config, event, clock(client)).tradeEndTime)),
    inspect: async () => {
      const current = await getState();
      if (current.period !== event.period) return null;
      if (unloading && plan.kind === 'sell' && current.player?.goods?.some(g => g.cityId !== current.cargo?.cityId))
        watchMerchant(client).observe({ event, state: current, time: clock(client), config, settings: ctx.settings?.(), expedite: true });
      return fingerprint(current);
    },
    matches: (e, s) => actionMatched(e, s, clock(client))
  };
  if (plan.kind === 'buy') {
    const expected = {
      request: 'TradeBuyRequest', city: plan.city, goodsId: plan.goodsId, price: plan.price,
      owned: quantity(state, plan.goodsId, plan.city, plan.price) + plan.count,
      coins: state.coins - plan.price * plan.count
    };
    return checkedAction(ctx, { ...common, expected,
      send: () => send(expected.request, { cityId: plan.city, goodsId: plan.goodsId, buyNum: plan.count }, 'TradeBuyResponse'),
      accept: r => r.player && actionMatched(expected, fingerprint({ player: r.player, cargo: state.cargo }))
    });
  }
  if (plan.kind === 'sell') {
    const batch = state.goods.find(g => g.pid === plan.pid);
    const expected = { request: 'TradeSellRequest', pid: plan.pid, coins: state.coins, profit: state.profit,
      gain: plan.gain, proceeds: batch.buyPrice * plan.count + plan.gain };
    return checkedAction(ctx, { ...common, expected,
      send: () => send(expected.request, { cityId: plan.city, pid: plan.pid, sellNum: plan.count }, 'TradeSellResponse'),
      accept: r => r.player && actionMatched(expected, fingerprint({ player: r.player, cargo: state.cargo }))
    });
  }
  const expected = { request: 'TradeMoveRequest', city: plan.city, destination: plan.destination, goodsId: plan.goodsId,
    start: clock(client), marketEpoch: currentEpoch, cargoSignature: cargoSignature(fresh), exploration: !!plan.exploration,
    ...(!verified.exploration && { estimatedProfit: verified.expectedProfit, priceNote: verified.priceNote }) };
  return checkedAction(ctx, { ...common, expected,
    send: () => send(expected.request, { cityId: plan.city, mvToCityId: plan.destination }, 'TradeMoveResponse'),
    inspect: async () => {
      const current = await getState();
      if (current.period !== event.period) return null;
      if (policy.autoSpeedUp && current.cargo?.moveToCityId === plan.destination) {
        const now = clock(client);
        const finalStart = merchantFinalCargoStart(merchantTiming(config, event, now), event, policy, current.player?.goods, plan.destination);
        const expedite = ['race', 'full'].includes(policy.speedUpMode) || (finalStart !== null && now >= finalStart);
        if (expedite || finalStart !== null)
          watchMerchant(client).observe({ event, state: current, time: now, config, settings: ctx.settings?.(), expedite });
      }
      return fingerprint(current);
    },
    accept: r => r.cargo?.moveToCityId === plan.destination || r.cargo?.cityId === plan.destination
  });
}

async function merchantRewards(client, config, ctx, event, info, allowed, getState) {
  const scope = event.startTime + ':' + event.period;
  await claimPass(
    client,
    { ...ctx, label: '海商王战令' },
    { type: 3, tiers: table(config, 'TradePassCfg').filter((t) => t.period === info.period), scope, allowed }
  );
  if (!allowed()) return;
  const stages = table(config, 'TradeAchieveRewardCfg').filter(
    (t) => t.id === info.period && t.rewardId > info.gotAchieveRwdId && t.target <= info.player.profit
  );
  if (stages.length)
    await claimOnce(client, {
      key: 'trade-profit:' + scope + ':' + info.gotAchieveRwdId,
      ledger: ctx.ledger,
      enabled: allowed,
      title: '海商王 · 累计利润奖励',
      report: ctx.report,
      request: 'GotTradeAchievementRequest',
      response: 'GotTradeAchievementResponse',
      verify: async (r) =>
        hasReward(r) &&
        r.gotAchieveRwdId > info.gotAchieveRwdId &&
        (await getState()).gotAchieveRwdId >= r.gotAchieveRwdId
    });
  const day = dayOf(clock(client)),
    dayNum = day - dayOf(event.startTime) + 1;
  if (!allowed() || !exactGuild(ctx.player.guildId)) return;
  const getTasks = async () => (await read(client, 'TradeTask')).guildTask;
  const task = await getTasks();
  if (!Array.isArray(task?.gotTaskId) || !natural(task.profit) || !natural(task.tradeTimes))
    return waiting(ctx, '联盟贸易任务进度未同步');
  const eligible = table(config, 'TradeGuildTaskCfg').filter(
    (t) =>
      t.day <= dayNum &&
      !task.gotTaskId.includes(t.id) &&
      (t.taskType === 0 ? task.profit : task.tradeTimes) >= t.tragetCount
  );
  for (const taskDay of new Set(eligible.map((t) => t.day))) {
    const ids = eligible.filter((t) => t.day === taskDay).map((t) => t.id);
    await claimOnce(client, {
      ledger: ctx.ledger,
      key: 'trade-task:' + scope + ':' + taskDay + ':' + ids.join('-'),
      enabled: allowed,
      report: ctx.report,
      title: '海商王 · 第' + taskDay + '天联盟任务',
      request: 'TradeGotTaskRequest',
      response: 'TradeGotTaskResponse',
      body: { day: taskDay },
      verify: async (r) => {
        if (!hasReward(r) || !ids.every((id) => r.gotTaskId.includes(id))) return false;
        const after = await getTasks();
        return ids.every((id) => after.gotTaskId.includes(id));
      }
    });
  }
  const reportTiers = table(config, 'TradeDayRewardCfg').filter(
    (t) => t.id > info.gotReportRwdId && t.roleNum <= info.guildReportNum
  );
  if (reportTiers.length)
    await claimOnce(client, {
      ledger: ctx.ledger,
      key: 'trade-report:' + scope + ':' + day + ':' + info.gotReportRwdId,
      enabled: () => allowed() && dayOf(clock(client)) === day,
      report: ctx.report,
      title: '海商王 · 联盟商情礼包',
      request: 'GotTradeReportRequest',
      response: 'GotTTradeReportResponse',
      verify: async (r) =>
        hasReward(r) &&
        r.gotReportRwdId > info.gotReportRwdId &&
        (await getState()).gotReportRwdId >= r.gotReportRwdId
    });
}
function exactGuild(id) {
  const value = exactAutomationId(id);
  return !!value && BigInt(value) % 1000n > 0n;
}
