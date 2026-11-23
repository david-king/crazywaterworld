import { commitFactoryLane, nextFactoryLane } from './production-timing.mjs';

export const simulatedFactoryQueueKey = factory => JSON.stringify([
  factory.autoProductId ?? '', factory.factoryQ.map(job => [job.idx ?? 0,job.productId,job.finishTime ?? 0]),
]);

// Local picks for this dispatch only. Reconsider after confirmed completions.
export function simulateNativeFactoryStarts({ buildings, recipes, targets = [], timing, now, cap, slots, available, owned, insertions }) {
  const costs = new Map(), additions = new Map(), jobs = [];
  const stock = id => owned(id) + (additions.get(id) ?? 0);
  const preferred = new Set(targets);
  for (const building of buildings) {
    const factory = building.factory;
    if (!Array.isArray(factory?.factoryQ) || !Array.isArray(factory.finishedProducts)) continue;
    const local = recipes.filter(row => row.buildType === building.type && row.unlockLevel <= building.level);
    if (!local.length) continue;
    const primary = local.find(row => preferred.has(row.itemId))
      ?? local.find(row => row.itemId === factory.autoProductId) ?? local[0];
    const queue = timing.factoryQueue(building);
    if (queue.missing.length) continue;
    const freeLanes = Math.min(slots, queue.lanes.count) - factory.factoryQ.length;
    const limit = insertions?.[building.buildingId] ? Math.min(1, freeLanes) : freeLanes;
    const candidates = local.map(row => ({ row, seconds: timing.factory(row, { building }).seconds }));
    for (let i = 0; i < limit; i++) {
      const choices = candidates.filter(({ row, seconds }) => seconds > 0 && stock(row.itemId) < cap
        && row.costItem.every(([id,n]) => available(id) - (costs.get(id) ?? 0) >= n)
        && nextFactoryLane(queue.finishes, queue.lanes.expiresAt, seconds).start <= now);
      choices.sort((a,b) => Number(b.row === primary) - Number(a.row === primary)
        || Number(b.seconds < 5) - Number(a.seconds < 5)
        || stock(a.row.itemId) - stock(b.row.itemId));
      if (!choices.length) break;
      const { row, seconds } = choices[0];
      const lane = nextFactoryLane(queue.finishes, queue.lanes.expiresAt, seconds);
      commitFactoryLane(queue.finishes, lane);
      for (const [id,n] of row.costItem) costs.set(id, (costs.get(id) ?? 0) + n);
      additions.set(row.itemId, (additions.get(row.itemId) ?? 0) + 1);
      jobs.push({ building, row, lane, seconds, primary: row === primary,
        laneUntil: lane.index > 0 ? queue.lanes.expiresAt : null });
    }
  }
  return jobs;
}
