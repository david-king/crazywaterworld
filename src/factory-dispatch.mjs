import { commitFactoryLane, nextFactoryLane } from './production-timing.mjs';

// Find a short batch that would release an otherwise idle downstream factory.
// Only the first link is queued. Later links wait for confirmed inventory.
export function shortFactoryFeed({ idle, recipes, rank, room, free, incoming, seconds, revisit, slots, defaultHeads }) {
  if (idle.length < 2) return;
  const suppliers = new Map();
  for (const row of recipes) {
    const building = idle.find(b => b.type === row.buildType && b.level >= row.unlockLevel);
    if (building && room(row) > 0) suppliers.set(row.itemId, { building, row });
  }
  const offers = [];
  function trace(path, units) {
    const {building,row} = path.at(-1);
    const missing = row.costItem.map(([id,n]) => [id, n * units - free(row,id)]).filter(([,n]) => n > 0);
    if (!missing.length) {
      if (path.length > 1) offers.push({path,units,span:seconds(building,row)*units});
      return;
    }
    if (missing.length !== 1 || path.length >= 3) return;
    const [id,quantity] = missing[0], supplier = suppliers.get(id);
    if (!supplier || incoming.get(id) > 0 || path.some(link => link.building === supplier.building)
      || quantity > slots || room(supplier.row) < quantity || seconds(supplier.building,supplier.row)*quantity > revisit) return;
    trace([...path,{...supplier,units:quantity}],quantity);
  }
  for (const dest of suppliers.values()) trace([{...dest,units:1}],1);
  if (!offers.length) return;
  const heads = defaultHeads();
  const byId = new Map(recipes.map(row => [row.itemId,row]));
  offers.sort((a,b) => b.path.length-a.path.length || rank(a.path[0].row)-rank(b.path[0].row) || a.span-b.span);
  for (const offer of offers) {
    const {path,units,span} = offer, source = path.at(-1), head = byId.get(heads.get(source.building.buildingId));
    if (path.slice(0,-1).some(link => heads.has(link.building.buildingId))) continue;
    const intermediateSeconds = path.length === 3 ? seconds(path[1].building,path[1].row)*path[1].units : 0;
    if (head && (units >= slots || seconds(source.building,head) <= span + intermediateSeconds + revisit)) continue;
    // Protect the other inputs of every downstream job and one normal head.
    const bill = new Map();
    for (const [i,link] of path.entries()) for (const [id,n] of link.row.costItem) {
      const covered = path[i+1]?.row.itemId === id ? path[i+1].units : 0;
      bill.set(id,(bill.get(id)??0)+Math.max(0,n*link.units-covered));
    }
    if (head) for (const [id,n] of head.costItem) bill.set(id,(bill.get(id)??0)+n);
    if ([...bill].some(([id,n]) => path.some(link => free(link.row,id)<n))) continue;
    const higher = recipes.filter(row => rank(row)<rank(source.row) && room(row)>0);
    if (source.row.costItem.some(([id,n]) => free(source.row,id) < n*units
      + higher.reduce((sum,row)=>sum+(row.costItem.find(cost=>cost[0]===id)?.[1]??0),0))) continue;
    return { building:source.building, row:source.row, units };
  }
}

// Arrival times are planning hints. Only the caller's confirmed warehouse
// balance can pay for a job. Keep new commitments local to this snapshot.
export function createFactoryDispatch(survey, timing, collectable, crops) {
  const now = survey.serverNow ?? survey.now;
  const queues = new Map();
  const arrivals = new Map();
  const durations = new Map();
  const addArrival = (item, count, at) => {
    if (!(count > 0) || !Number.isFinite(at)) return;
    if (!arrivals.has(item)) arrivals.set(item, []);
    const arrival = { count, at };
    arrivals.get(item).push(arrival);
    return arrival;
  };
  for (const building of survey.factories) {
    const queue = timing.factoryQueue(building);
    queues.set(building, { ...queue, count: building.factory.factoryQ?.length ?? 0 });
    if (!collectable(building)) continue;
    for (const entry of queue.jobs) {
      if (!queue.missing.length || entry.basis.source === 'server') addArrival(entry.job.productId, 1, entry.finish);
    }
    for (const item of building.factory.finishedProducts ?? []) addArrival(item.id, Number(item.num), now);
  }
  for (const building of survey.buildings) {
    if (!building.farm?.ripeTime || !collectable(building)) continue;
    const crop = crops.find(row => row.id === building.farm.productId);
    if (crop) addArrival(crop.id, crop.produceNum, Math.max(now, building.farm.ripeTime));
  }
  function seconds(building, recipe) {
    const key = building.buildingId + '\0' + recipe.itemId;
    if (!durations.has(key)) durations.set(key, timing.factory(recipe, { building }).seconds ?? Infinity);
    return durations.get(key);
  }
  function batchFitsBy(building, recipe, units, deadline) {
    const queue = queues.get(building);
    const finishes = [...queue.finishes];
    const duration = seconds(building, recipe);
    for (let n = 0; n < units; n++) {
      const lane = nextFactoryLane(finishes, queue.lanes.expiresAt, duration);
      if (lane.finish > deadline) return false;
      commitFactoryLane(finishes, lane);
    }
    return true;
  }
  function readyAt(recipe, free, batches = 1) {
    let at = now;
    for (const [item, count] of recipe.costItem ?? []) {
      let shortage = count * batches - free(recipe, item);
      if (shortage <= 0) continue;
      for (const arrival of [...(arrivals.get(item) ?? [])].sort((a,b) => a.at - b.at)) {
        shortage -= arrival.count;
        if (shortage <= 0) { at = Math.max(at, arrival.at); break; }
      }
      if (shortage > 0) return Infinity;
    }
    return at;
  }
  function fits(building, recipe, waiting, revisit) {
    const queue = queues.get(building), duration = seconds(building, recipe);
    const lane = nextFactoryLane(queue.finishes, queue.lanes.expiresAt, duration);
    // Reserve time for actual waiting demand. Ordinary stock replenishment
    // may fill cancellable queue slots even behind a long-running product.
    if ((waiting.length && !waiting.some(job => Number.isFinite(job.at)) && lane.start > now + revisit)
      || (queue.missing.length && queue.count >= queue.lanes.count)) return false;
    const before = [...queue.finishes], after = [...before];
    commitFactoryLane(after, lane);
    for (const job of waiting) {
      const unknown = !Number.isFinite(job.at);
      const release = unknown ? now + revisit : job.at;
      const urgent = seconds(building, job.row);
      const parallel = before.length > 1 && (queue.lanes.expiresAt === null || release + urgent <= queue.lanes.expiresAt);
      // Bound the wait for unobserved supply. Longer non-preemptible jobs
      // justify more observation, up to three configured review intervals.
      const patience = job.earlyFallback ? 0 : Math.min(3 * revisit, Math.max(revisit, Math.sqrt(duration * revisit)));
      // While the priority output is full, a short refill batch can finish
      // before its next capacity check, even after a long wait for space.
      const fitsBeforeCapacityCheck = job.capacityBlocked && lane.finish <= release;
      if (unknown && job.waited >= patience && !fitsBeforeCapacityCheck) {
        if (lane.start > now) return false;
        if (parallel && nextFactoryLane(after, queue.lanes.expiresAt, urgent).start
          > nextFactoryLane(before, queue.lanes.expiresAt, urgent).start) return false;
        continue;
      }
      const wave = Math.min(job.quantity ?? 1, parallel ? before.length : 1);
      for (let n = 0; n < wave; n++) {
        for (const calendar of [before, after]) for (let i = 0; i < calendar.length; i++)
          calendar[i] = Math.max(calendar[i], release);
        const original = nextFactoryLane(before, queue.lanes.expiresAt, urgent);
        const delayed = nextFactoryLane(after, queue.lanes.expiresAt, urgent);
        if (delayed.start > original.start) return false;
        commitFactoryLane(before, original);
        commitFactoryLane(after, delayed);
      }
    }
    return true;
  }
  function commit(building, recipe) {
    const queue = queues.get(building);
    const lane = nextFactoryLane(queue.finishes, queue.lanes.expiresAt, seconds(building, recipe));
    commitFactoryLane(queue.finishes, lane);
    queue.count++;
    if (collectable(building)) return addArrival(recipe.itemId, 1, lane.finish);
  }
  return { queues, seconds, readyAt, batchFitsBy, fits, commit };
}
