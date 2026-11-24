import { commitFactoryLane, nextFactoryLane } from './production-timing.mjs';
import { toNumber } from './client.mjs';

export const simulatedFactoryQueueKey = factory => JSON.stringify([
  factory.autoProductId ?? '', factory.factoryQ.map(job => [job.idx ?? 0,job.productId,job.finishTime ?? 0]),
]);

// TipsDescCfg / 自动生产 excludes the seed factory from material-pull collection.
export function nativeMaterialReceipts(buildings, willCollect) {
  const receipts = new Map();
  for (const b of buildings) {
    if (b.type === '种子厂' || !b.factory?.finishedProducts?.length || !willCollect(b)) continue;
    for (const { id, num } of b.factory.finishedProducts) {
      const quantity = toNumber(num);
      if (id && Number.isSafeInteger(quantity) && quantity > 0) receipts.set(id, (receipts.get(id) ?? 0) + quantity);
    }
  }
  return receipts;
}

// Local picks for this dispatch only. Reconsider after confirmed completions.
export function simulateNativeFactoryStarts({ buildings, recipes, availableProducts, targets = [], timing, now, cap, slots, available, owned, insertions }) {
  const costs = new Map(), additions = new Map(), jobs = [];
  const stock = id => owned(id) + (additions.get(id) ?? 0) - (costs.get(id) ?? 0);
  const preferred = new Set(targets);
  let waiting = [];
  for (const building of buildings) {
    const factory = building.factory;
    if (!Array.isArray(factory?.factoryQ) || !Array.isArray(factory.finishedProducts)) continue;
    const local = recipes.filter(row => row.buildType === building.type);
    const unlocked = local.filter(row => row.unlockLevel <= building.level && (!availableProducts || availableProducts.has(row.itemId)));
    if (!unlocked.length) continue;
    // Resolve the selected product even if it cannot currently be made.
    // Only an unconfigured factory gets the first unlocked recipe as its default.
    const primaryId = local.find(row => preferred.has(row.itemId))?.itemId || factory.autoProductId || unlocked[0].itemId;
    const queue = timing.factoryQueue(building);
    if (queue.missing.length) continue;
    const freeLanes = Math.min(slots, queue.lanes.count) - factory.factoryQ.length;
    const limit = insertions?.[building.buildingId] ? Math.min(1, freeLanes) : freeLanes;
    if (limit <= 0) continue;
    const candidates = unlocked.map(row => ({ row, primary: row.itemId === primaryId, seconds: timing.factory(row, { building }).seconds }));
    waiting.push({ building, queue, limit, candidates });
  }
  function startGroup({ building, queue, limit, candidates }) {
    const before = jobs.length;
    for (let i = 0; i < limit; i++) {
      const choices = candidates.filter(({ row, seconds }) => seconds > 0 && stock(row.itemId) < cap
        && row.costItem.every(([id,n]) => available(id) - (costs.get(id) ?? 0) >= n)
        && nextFactoryLane(queue.finishes, queue.lanes.expiresAt, seconds).start <= now);
      // Within each fallback tier use projected stock, then the stable recipe order.
      choices.sort((a,b) => Number(b.primary) - Number(a.primary)
        || Number(b.seconds <= 5) - Number(a.seconds <= 5)
        || stock(a.row.itemId) - stock(b.row.itemId));
      if (!choices.length) break;
      const { row, seconds, primary } = choices[0];
      const lane = nextFactoryLane(queue.finishes, queue.lanes.expiresAt, seconds);
      commitFactoryLane(queue.finishes, lane);
      for (const [id,n] of row.costItem) costs.set(id, (costs.get(id) ?? 0) + n);
      additions.set(row.itemId, (additions.get(row.itemId) ?? 0) + 1);
      jobs.push({ building, row, lane, seconds, primary,
        laneUntil: lane.index > 0 ? queue.lanes.expiresAt : null });
    }
    return jobs.length > before;
  }
  // A downstream start can free warehouse space for a previously blocked
  // factory. Keep each factory's writes together for queue confirmation.
  while (waiting.length) {
    const blocked = [];
    for (const state of waiting) {
      if (!startGroup(state)) blocked.push(state);
    }
    if (blocked.length === waiting.length) break;
    waiting = blocked;
  }
  return jobs;
}
