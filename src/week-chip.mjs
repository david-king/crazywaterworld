import { createHash } from 'node:crypto';

// 芯片宝箱玩法说明中的加工积分。特级硅晶只产道具。
const crystals = [
  { id: '白芯片宝箱', name: '初级硅晶', points: 1 },
  { id: '绿芯片宝箱', name: '中级硅晶', points: 10 },
  { id: '蓝芯片宝箱', name: '高级硅晶', points: 20 },
  { id: '紫芯片宝箱', name: '优质硅晶', points: 50 },
];
const allCrystals = [...crystals, { id: '橙芯片宝箱', name: '特级硅晶', points: 0 }];
const crystalPoints = new Map(allCrystals.map(item => [item.id, item.points]));

function rewardPoints(reward = []) {
  return reward.reduce((sum, [id, count]) => sum + (crystalPoints.get(id) ?? 0) * count, 0);
}

function returnedCrystals(reward = []) {
  return reward.filter(([id, count]) => crystalPoints.has(id) && count > 0);
}

function factoryBalanceKnown(stage, score) {
  return Number.isSafeInteger(stage) && stage >= 0 && Number.isSafeInteger(score) && score >= 0;
}

function readyFactoryTier(tiers, stage, score) {
  if (!factoryBalanceKnown(stage, score)) return;
  return tiers?.find(t => t.level === stage && Number.isSafeInteger(t.score) && t.score > 0 && score >= t.score);
}

// 登录角色提供芯片厂档位。后续加工、领取的回包只更新这条连接的工厂积分。
export function updateChipFactoryScore(player, name, body) {
  if (name === 'ChipChestGotScoreResponse') {
    player.chipStage = body.stage;
    player.chipScore = body.score;
  } else if (name === 'ChipChestOpenResponse') {
    if (Number.isSafeInteger(player.chipScore) && Number.isSafeInteger(body.addScore)) player.chipScore += body.addScore;
    else if (Object.hasOwn(body, 'score')) player.chipScore = body.score;
    else player.chipScore = null;
  }
}

export function weekChipStatistics(config, plan, info, stock, player, freePack) {
  const inventory = allCrystals.map(({ id, name, points }) => ({ id, name, count: stock.get(id) ?? 0, points }));
  const tiers = [...config.tables.WeekChipPointsCfg.data].sort((a, b) => a.amount - b.amount);
  const claimed = Array.isArray(info.gotTaskId) ? new Set(info.gotTaskId) : null;
  const settled = claimed && tiers.every(tier => claimed.has(tier.rwdId)) && plan.score >= plan.target;
  const completed = Math.min(plan.roundLimit, plan.round - 1 + (settled ? 1 : 0));
  const cap = plan.target;
  const roundScore = cap - plan.gap;
  const gift = !Array.isArray(config.tables.WeekChipPackCfg?.data) || !Array.isArray(info.gifts) ? null :
    freePack?.pack && !freePack.done ? rewardPoints(freePack.pack.reward) : 0;
  const factoryTier = config.tables.ChestScoreCfg?.data?.find(row => row.level === player?.chipStage);
  const factoryKnown = factoryTier && Number.isSafeInteger(player.chipScore) && player.chipScore >= 0;
  let factory = factoryKnown ? 0 : null;
  let forecast = roundScore + plan.available + (gift ?? 0);
  let weekly = claimed ? 0 : null;
  let factoryAdded = false;
  // 当前已知工厂档只加入一次。预计加工所得与已有的工厂余额可以共同解锁该档。
  const addFactoryReward = () => {
    if (!factoryKnown || factoryAdded) return;
    const earned = Math.min(plan.gap, forecast - roundScore);
    if (player.chipScore + earned < factoryTier.score) return;
    factoryAdded = true;
    factory = rewardPoints([factoryTier.reward]);
    forecast += factory;
  };
  addFactoryReward();
  if (claimed && plan.round <= plan.roundLimit) {
    for (const tier of tiers) {
      if (claimed.has(tier.rwdId)) continue;
      if (forecast < tier.amount) break;
      const points = rewardPoints(tier.reward);
      weekly += points;
      forecast += points;
      addFactoryReward();
    }
  }
  return { inventory, completed, cap, forecast: Math.min(cap, forecast), weekly, gift, factory,
    factoryStage: factoryKnown ? factoryTier.level : null,
    qualified: Math.min(plan.roundLimit, Math.floor(plan.total / plan.target)) };
}

export function weekChipProgress(info, tiers) {
  const target = Math.max(...tiers.map(tier => tier.amount));
  const round = info?.round, total = info?.score;
  const score = total - (round - 1) * target;
  if (!Number.isSafeInteger(target) || target <= 0 || !Number.isSafeInteger(round) || round < 1 ||
      !Number.isSafeInteger(total) || !Number.isSafeInteger(score) || score < 0) throw Error('硅晶轮次或积分未同步');
  return { round, total, score, target };
}

// 背包有数量上限。逐个面值保存可达分数的前驱，取达标组合中溢分最少的一个。
function selectCrystals(stock, gap, order = crystals) {
  const limit = gap + crystals.at(-1).points - 1;
  const via = new Int8Array(limit + 1).fill(-1);
  via[0] = crystals.length;
  for (const [index, { id, points }] of order.entries()) {
    const count = stock.get(id) ?? 0;
    for (let offset = 0; offset < points; offset++) {
      let left = 0;
      for (let sum = offset; sum <= limit; sum += points) {
        if (via[sum] !== -1) left = count;
        else if (left > 0) { via[sum] = index; left--; }
      }
    }
  }
  let sum = via.findIndex((index, sum) => sum >= gap && index !== -1);
  if (sum < 0) return [];
  const counts = Array(crystals.length).fill(0);
  while (sum > 0) {
    const index = via[sum];
    counts[index]++;
    sum -= order[index].points;
  }
  return order.flatMap((item, index) => counts[index] ? [{ ...item, count: counts[index] }] : []);
}

// 预览和执行共用同一份有序方案。库存不够时先解锁下一档，把返晶放入模拟背包后才可配入下一批。
function roundActions(config, plan, info, stock, player, freePack) {
  if (plan.round > plan.roundLimit || plan.statistics.forecast < plan.target) return [];
  const bag = new Map(stock), actions = [];
  const tiers = [...config.tables.WeekChipPointsCfg.data].sort((a, b) => a.amount - b.amount);
  const pending = Array.isArray(info.gotTaskId) ? tiers.filter(t => !info.gotTaskId.includes(t.rwdId)) : [];
  let factory = config.tables.ChestScoreCfg?.data?.find(t => t.level === plan.statistics.factoryStage && plan.statistics.factory > 0);
  const free = freePack?.pack?.price === 0 ? freePack.pack : null;
  let gift = Array.isArray(info.gifts) && !freePack?.done ? free : null;
  let score = plan.score, available = plan.available;
  function claim(kind, id, reward = [], threshold = 0) {
    const returned = returnedCrystals(reward);
    actions.push({ kind, id, returned, threshold });
    for (const [item, count] of returned) bag.set(item, (bag.get(item) ?? 0) + count);
    available += rewardPoints(returned);
  }
  function claimTier(tier) {
    claim('weekly', tier.rwdId, tier.reward, tier.amount);
    pending.splice(pending.indexOf(tier), 1);
  }
  while (score < plan.target) {
    const gap = plan.target - score;
    let needed = gap;
    if (available < gap) {
      const next = pending.find(t => rewardPoints(t.reward) > 0);
      if (next && score >= next.amount) { claimTier(next); continue; }
      if (next && next.amount - score <= available) needed = next.amount - score;
      else if (factory && player.chipScore + score - plan.score >= factory.score) {
        claim('factory', factory.level, [factory.reward], factory.score);
        factory = null;
        continue;
      } else if (factory && factory.score - player.chipScore - (score - plan.score) <= available) {
        needed = factory.score - player.chipScore - (score - plan.score);
      } else if (gift && rewardPoints(gift.reward) > 0) {
        claim('gift', gift.packId, gift.reward);
        gift = null;
        continue;
      } else return [];
    }
    // 中途解锁档位优先用高面值，保留低面值硅晶给最后一批凑分。
    const items = selectCrystals(bag, needed, needed === gap ? crystals : [...crystals].reverse());
    if (!items.length) return [];
    for (const { id, count, points } of items) {
      bag.set(id, bag.get(id) - count);
      available -= count * points;
      score += count * points;
      for (let left = count; left > 0; left -= 500) actions.push({ kind: 'open', id, count: Math.min(left, 500) });
    }
  }
  // 最后一份周奖励可能直接换轮。先领其他已达档和礼包，并按工厂回包领完可领档位。
  const lastTier = pending.pop();
  for (const tier of [...pending]) claimTier(tier);
  const factoryTiers = config.tables.ChestScoreCfg?.data;
  if (factoryTiers?.length && (plan.gap || readyFactoryTier(factoryTiers, player?.chipStage, player?.chipScore) ||
      (lastTier && !factoryBalanceKnown(player?.chipStage, player?.chipScore))))
    actions.push({ kind: 'factoryRewards' });
  // 礼包可能在加工期间刷新或已由其他入口领取，结算前以最近一次活动回包为准。
  if (free && (gift || plan.gap || lastTier)) claim('gift', free.packId, free.reward);
  if (lastTier) claim('weekly', lastTier.rwdId, lastTier.reward, lastTier.amount);
  return actions;
}

export function weekChipPlan(config, event, activityId, owner, info, stock, player, freePack) {
  const progress = weekChipProgress(info, config?.tables?.WeekChipPointsCfg?.data ?? []);
  const period = config?.tables?.WeekChipPeriodCfg?.data?.find(row => row.periodId === event.period);
  if (progress.target !== 8000 || !Number.isSafeInteger(period?.round) || period.round < 1 ||
      progress.round > period.round + 1) throw Error('本期硅晶达标配置未同步');
  const gap = progress.round > period.round ? 0 : Math.max(0, progress.target - progress.score);
  const available = crystals.reduce((sum, item) => sum + (stock.get(item.id) ?? 0) * item.points, 0);
  const plan = { ...progress, roundLimit: period.round, available, gap };
  plan.statistics = weekChipStatistics(config, plan, info, stock, player, freePack);
  const actions = roundActions(config, plan, info, stock, player, freePack);
  const counts = new Map();
  for (const step of actions) if (step.kind === 'open') counts.set(step.id, (counts.get(step.id) ?? 0) + step.count);
  const items = crystals.filter(c => counts.has(c.id)).map(c => ({ ...c, count: counts.get(c.id) }));
  const gain = items.reduce((sum, item) => sum + item.count * item.points, 0);
  const key = actions.length ? createHash('sha256').update(JSON.stringify([owner, activityId, event.endTime, progress, actions])).digest('hex') : null;
  return { ...plan, actions, items, gain, key };
}

// 客户端通过海面已建成的芯片厂进入加工界面。登录时的 chipStage 只表示积分奖励档位。
export async function checkWeekChipFactory(client, config, player, plan) {
  if (!plan.gap && !plan.actions.some(step => step.kind === 'factoryRewards')) return plan;
  const blocked = reason => ({ ...plan, key: null, blockedReason: reason });
  function unbuilt(reason) {
    if (plan.gap) return blocked(reason);
    // 未建芯片厂也可补领周奖励和免费礼包。
    const actions = plan.actions.filter(step => step.kind !== 'factoryRewards');
    if (!actions.length) return blocked(reason);
    const key = createHash('sha256').update(JSON.stringify([plan.key, actions])).digest('hex');
    return { ...plan, actions, key };
  }
  const plots = config?.tables?.BuildingUnlockCfg?.data?.filter(row => row.buildingType === '芯片厂' && row.buildingId);
  if (!plots?.length) return blocked('缺少芯片厂的建筑配置，请刷新活动。');
  let water;
  try { water = await client.request('OnWaterRequest', {}, 'OnWaterResponse'); }
  catch { return blocked('芯片厂建筑状态读取失败，请刷新活动。'); }
  if (!Array.isArray(water?.building) || water.building.some(row => !row?.buildingId))
    return blocked('芯片厂建筑状态未同步，请刷新活动。');
  const ids = new Set(plots.map(row => row.buildingId));
  const factories = water.building.filter(row => ids.has(row.buildingId));
  if (factories.some(row => Number.isSafeInteger(row.level) && row.level > 0)) return plan;
  if (factories.some(row => row.buildStartTime > 0 || row.buildFinishTime > 0))
    return unbuilt('芯片厂正在建造，竣工后可加工硅晶。');
  if (factories.some(row => row.level !== 0)) return blocked('芯片厂等级未同步，请刷新活动。');
  const required = Math.min(...plots.map(row => row.playerLevel));
  if (Number.isSafeInteger(required) && Number.isSafeInteger(player?.level) && player.level < required)
    return unbuilt('当前角色 ' + player.level + ' 级，' + required + ' 级可建造芯片厂，建成后可加工硅晶。');
  return unbuilt('请先在海面建成芯片厂，再加工硅晶。');
}

function claimRecorded(state, details) {
  switch (details.kind) {
    case 'weekly': return state.plan.round > details.round ||
      (state.plan.round === details.round && state.info.gotTaskId?.includes(details.id));
    case 'gift': return state.info.gifts?.some(g => g.giftId === details.id && g.paidTimes > 0);
    case 'factory': return factoryBalanceKnown(state.chipStage, state.chipScore) &&
      (state.chipStage !== details.id || state.chipScore < details.beforeFactoryScore);
    default: return false;
  }
}

function operation(step, state) {
  const { kind, id } = step;
  if (kind === 'open') {
    const owned = state.stock.get(id) ?? 0;
    if (owned < step.count) throw Error('硅晶库存已变化，请刷新后继续');
    return { request: 'ChipChestOpenRequest', body: { item: { itemId: id, num: step.count } }, response: 'ChipChestOpenResponse',
      suffix: state.plan.total, details: { itemId: id, afterScore: state.plan.total + step.count * crystalPoints.get(id), afterStock: owned - step.count } };
  }
  const details = { kind, id, round: state.plan.round,
    balances: step.returned.map(([item, count]) => [item, (state.stock.get(item) ?? 0) + count]) };
  const suffix = [kind, state.plan.round, id, state.plan.total].join(':');
  if (kind === 'weekly' && state.plan.score >= step.threshold && state.info.gotTaskId?.includes(id) === false) {
    return { request: 'WeekChipGotTaskRequest', body: { round: details.round, taskId: id }, response: 'WeekChipGotTaskResponse', suffix, details };
  }
  if (kind === 'gift' && Array.isArray(state.info.gifts) && state.freePack.pack?.price === 0 && state.freePack.pack.packId === id && !state.freePack.done) {
    return { request: 'WeekChipGotFreeRequest', body: {}, response: 'GotRewardResponse', suffix, details };
  }
  if (kind === 'factory' && state.chipStage === id && state.chipScore >= step.threshold) {
    details.beforeFactoryScore = state.chipScore;
    return { request: 'ChipChestGotScoreRequest', body: {}, response: 'ChipChestGotScoreResponse',
      suffix: suffix + ':' + state.chipScore, details };
  }
  throw Error('本轮奖励领取条件已变化，请刷新后继续');
}

function received(state, details) {
  if (details.kind) return claimRecorded(state, details) &&
    details.balances.every(([item, count]) => (state.stock.get(item) ?? 0) >= count);
  return state.plan.total >= details.afterScore && (state.stock.get(details.itemId) ?? 0) <= details.afterStock;
}

export async function openWeekChipRound(client, { read, enabled, ledger, activityId, planKey, factoryTiers }) {
  let state = await read({ checkFactory: true });
  const { plan, event } = state;
  const prefix = 'week-chip:' + activityId + ':';
  function check() {
    const now = (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
    if (!enabled() || now < event.startTime || now >= event.endTime)
      throw Object.assign(Error('活动已结束或账号连接已变化，已停止开硅晶'), { notSent: true });
  }
  check();
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!key.startsWith('week-chip:')) continue;
    const expired = record.details?.endTime <= (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
    if (record.confirmed) {
      if (expired) ledger.releaseCompletedKey(key, record);
      else if (key.startsWith(prefix) && !record.details.kind && plan.total < record.details.afterScore) throw Error('上一批硅晶已开启，正在等待活动积分同步');
      continue;
    }
    if (expired && !record.expired) ledger.retireUnknownKey(key, record);
    if (!key.startsWith(prefix)) continue;
    if (!received(state, record.details)) throw Error('上一次加工或领奖结果尚未核实，请稍后刷新');
    ledger.resolveKey(key, true);
  }
  if (plan.blockedReason) throw Error(plan.blockedReason);
  if (!plan.key || plan.key !== planKey) throw Error('轮次、积分或可用硅晶已变化，请刷新后查看开晶方案');
  let total = plan.total;
  const claimed = { weekly: 0, gift: 0, factory: 0 };
  async function execute(step) {
    check();
    if (state.event.endTime !== event.endTime || state.plan.round !== plan.round || state.plan.total !== total)
      throw Error('活动期次、轮次或积分已变化，请刷新后继续');
    if ((step.kind === 'weekly' || step.kind === 'gift') && claimRecorded(state, { ...step, round: plan.round })) return;
    const { request, body, response, suffix, details } = operation(step, state);
    details.endTime = event.endTime;
    const ticket = ledger.reserve({}, {}, {}, { uniqueKey: prefix + suffix, details });
    let reply;
    try {
      reply = await client.request(request, body, response, undefined, check);
    } catch (error) {
      if (error.notSent === true || (error.prompt && error.request === request)) {
        ledger.cancel(ticket);
        if ((step.kind === 'open' || step.kind === 'factory') && error.request === request &&
            /^no building$/i.test(error.prompt?.args?.join(' ').trim()))
          throw Error('游戏未检测到已建成的芯片厂，请核对海面建筑后刷新活动。', { cause: error });
        throw error;
      }
      throw Error('本次加工或领奖结果待确认，请稍后刷新。' + error.message);
    }
    const opened = step.kind === 'open' && reply?.addScore === details.afterScore - total;
    if (opened) ledger.confirm(ticket);
    state = await read();
    if (!received(state, details)) throw Error('正在等待积分、领奖状态和硅晶库存同步，请稍后刷新');
    if (!opened) ledger.confirm(ticket);
    total = details.afterScore ?? total;
    if (details.kind) claimed[details.kind]++;
  }
  for (const step of plan.actions) {
    if (step.kind !== 'factoryRewards') {
      await execute(step);
      continue;
    }
    if (!factoryBalanceKnown(state.chipStage, state.chipScore))
      throw Error('本轮已达标，芯片厂档位或积分尚未同步。重新连接账号后可补领剩余奖励。');
    let tier;
    while ((tier = readyFactoryTier(factoryTiers, state.chipStage, state.chipScore))) {
      const before = state.chipScore;
      await execute({ kind: 'factory', id: tier.level, threshold: tier.score, returned: returnedCrystals([tier.reward]) });
      if (state.chipScore > before) throw Error('芯片厂领奖后积分异常增加，请刷新后继续领取');
    }
  }
  const rewards = [claimed.weekly && '周活动奖励 ' + claimed.weekly + ' 档', claimed.gift && '免费礼包',
    claimed.factory && '芯片厂积分奖励 ' + claimed.factory + ' 档'].filter(Boolean);
  const earned = plan.gain ? '本次加工获得 ' + plan.gain + ' 分。' : '';
  const receipt = rewards.length ? '已领取' + rewards.join('、') + '。' : '';
  return { claimed, message: '第 ' + plan.round + ' 轮硅晶已达标。' + earned + receipt };
}
