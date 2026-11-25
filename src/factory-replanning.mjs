// Match identifiable game jobs to outstanding demand once across all factories.
// A lower-ranked predecessor only needs removing if a higher-ranked unit can start earlier.
export function waitingQueueChanges({ facilities, queues, claims, priority, recipes, newRank, stockUnits, stockRank, now, timing }) {
  const changes = new Map();
  if (!facilities.some(b => b.factory.factoryQ?.some(job => !job.finishTime))) return changes;
  const byArrival = [...queues.values()].flatMap(queue => queue.jobs)
    .filter(({ finish }) => finish > now).sort((a, b) => a.finish - b.finish);
  const allocated = new Map(), ranks = new Map();
  for (const { job } of byArrival) {
    const id = job.productId, unit = (allocated.get(id) ?? 0) + 1;
    allocated.set(id, unit);
    let cumulative = 0;
    const orders = claims.get(id);
    const rank = priority.findIndex(source => {
      if (source === 'factory') return false;
      cumulative += orders?.get(source) ?? 0;
      return cumulative >= unit;
    });
    ranks.set(job, Math.min(rank < 0 ? Infinity : rank, unit <= stockUnits(id) ? stockRank : Infinity));
  }
  for (const building of facilities) {
    const queue = building.factory.factoryQ;
    if (!queue?.[0]?.finishTime || queues.get(building).missing.length || queue.some(job => job.finishTime && job.finishTime <= now)) continue;
    const waiting = queue.filter(job => !job.finishTime);
    if (!waiting.length || waiting.some(job => !ranks.has(job))) continue;
    let best = Infinity, nextRecipe;
    for (const row of recipes) {
      if (row.buildType !== building.type || row.unlockLevel > building.level) continue;
      const rank = newRank(row);
      if (rank < best) { best = rank; nextRecipe = row; }
    }
    let target = nextRecipe?.itemId;
    const nextJob = nextRecipe && { productId:target };
    if (nextJob) ranks.set(nextJob, best);
    const displaced = [];
    for (const job of waiting.toReversed()) {
      const rank = ranks.get(job);
      if (rank > best) displaced.push({ job, target });
      else if (rank < best) { best = rank; target = job.productId; }
    }
    if (!displaced.length) continue;
    let otherFinish = Infinity;
    if (nextRecipe) for (const other of facilities) {
      if (other === building || other.type !== building.type || other.level < nextRecipe.unlockLevel || queues.get(other).missing.length) continue;
      const finish = timing.factoryQueue(other, [...other.factory.factoryQ, nextJob]).jobs.find(entry => entry.job === nextJob)?.finish;
      if (finish != null) otherFinish = Math.min(otherFinish, finish);
    }
    // Two lanes can start adjacent waiting jobs together. Try retaining each
    // proposed removal if it leaves every higher-priority finish undelayed.
    const omitted = new Set(displaced.map(entry => entry.job));
    function finishes() {
      const kept = queue.filter(job => !omitted.has(job));
      if (nextJob) kept.push(nextJob);
      return new Map(timing.factoryQueue(building, kept).jobs.map(entry =>
        [entry.job, entry.job === nextJob ? Math.min(entry.finish, otherFinish) : entry.finish]));
    }
    let earliest = finishes();
    for (const {job} of displaced) {
      omitted.delete(job);
      const withJob = finishes(), rank = ranks.get(job);
      if ([...earliest].some(([other, finish]) => ranks.get(other) < rank && withJob.get(other) > finish)) omitted.add(job);
      else earliest = withJob;
    }
    const needed = displaced.filter(entry => omitted.has(entry.job));
    if (needed.length) changes.set(building.buildingId, needed);
  }
  return changes;
}

export const queueStamp = queue => JSON.stringify(queue.map(job => [job.idx ?? 0, job.productId, job.finishTime ?? 0]));

export function productionDemandChanged(name, body) {
  return name === 'SCUpdateItem' && !!body?.items?.length
    || name === 'SCUpdateResource' && !!body?.list?.length
    || name === 'SCWorkerOrder' || name === 'SCGuildOrder';
}
