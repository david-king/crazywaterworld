import { displayBuilding } from './world.mjs';
import { resourceReserve } from './automation-policy.mjs';

// Describe the snapshot behind the schedule. Inventory and outstanding jobs are
// shared by all batches; they are not a new reservation or a production request.
export function scheduleMaterials(snapshot, config, settings, entries, pending) {
  const materials = new Map();
  const name = id => {
    const label = config?.materialName?.(id);
    return label && label !== '未知材料' ? label : id;
  };
  const item = id => {
    if (!materials.has(id)) materials.set(id, { name:name(id), sources:config?.materialSources?.(id) ?? [] });
    return materials.get(id);
  };
  for (const recipe of snapshot.recipes) {
    const material = item(recipe.productId);
    material.inputs = recipe.costs;
    material.output = recipe.output;
    material.facility = config?.tables?.BuildingCfg?.data?.find(b => b.buildingType === recipe.facilityType)?.name || recipe.facilityType;
    for (const input of recipe.costs ?? []) item(input.id);
  }
  const buildings = new Map(snapshot.buildings.map(b => [b.id,b]));
  const upgrades = config?.tables?.BuildingUpgradeCfg?.data ?? [];
  for (const building of snapshot.buildings) {
    const upgrade = upgrades.find(r => r.buildingType === building.type && r.level === building.level);
    for (const [id, num] of upgrade?.product ?? []) {
      if (num > 0 && materials.has(id)) (item(id).producers ??= []).push(displayBuilding(config, building));
    }
  }
  for (const facility of snapshot.factories) {
    for (const job of facility.queue) {
      const m = item(job.productId);
      m.queued = (m.queued ?? 0) + 1;
    }
    for (const job of facility.finished) {
      const m = item(job.id);
      m.ready = (m.ready ?? 0) + job.num;
    }
  }
  for (const plot of snapshot.farms) if (plot.productId && plot.num > 0) {
    const m = item(plot.productId), key = plot.ripeTime <= snapshot.serverNow && plot.ripeTime > 0 ? 'ready' : 'queued';
    m[key] = (m[key] ?? 0) + plot.num;
  }
  function addPlans(id, jobs) {
    const facility = displayBuilding(config, buildings.get(id) ?? {buildingId:id});
    for (const job of jobs) {
      const m = item(job.id);
      const plans = m.plans ??= [];
      const crop = !!job.crop, target = job.supplyFor;
      let plan = plans.find(p => p.facility === facility && p.crop === crop && p.target === target);
      if (!plan) { plan = { facility, crop, target, quantity:0 }; plans.push(plan); }
      plan.quantity += job.quantity ?? 1;
    }
  }
  for (const [id, entry] of Object.entries(entries)) {
    addPlans(id, entry.jobs);
    for (const [facility,jobs] of Object.entries(entry.stagedSupplies ?? {})) addPlans(facility,jobs);
  }
  const inventory = new Map(snapshot.inventory.map(r => [r.id,r.num]));
  for (const [id, m] of materials) {
    m.stock = (snapshot.inventoryKnown ?? snapshot.complete) ? inventory.get(id) ?? 0 : null;
    if (pending.has(id)) m.stockUnconfirmed = true;
    const reserve = resourceReserve(settings,id);
    if (reserve > 0) m.reserve = reserve;
  }
  return Object.fromEntries(materials);
}

export function unscheduledBatches(jobs, visibleJobs, name) {
  return jobs.flatMap((job,index) => {
    const total = job.quantity ?? 1;
    const quantity = total - (visibleJobs.get(index)?.quantity ?? 0);
    return quantity > 0 ? [{ id:job.id, name:name(job.id), quantity, total, planIndex:index, at:job.at,
      inserted:!!job.pinned, supplyFor:job.supplyFor && name(job.supplyFor), supplyTarget:job.supplyTarget }] : [];
  });
}

// Even without a usable forecast, show the saved instructions and server observations.
export function observedSchedule(snapshot, config, entries, name, onlyMissing = false) {
  const known = new Set([...snapshot.factories,...snapshot.farms].map(f => f.id));
  const result = new Map();
  const buildings = new Map(snapshot.buildings.map(b => [b.id,b]));
  function facility(id, crop = false) {
    if (!result.has(id)) result.set(id, {id, name:displayBuilding(config,buildings.get(id) ?? {buildingId:id}),
      crop, runs:[], ready:[], untimedQueue:[], elapsed:[], pendingInsertions:[], unscheduled:[]});
    return result.get(id);
  }
  if (!onlyMissing) {
    for (const f of snapshot.factories) {
      const row = facility(f.id);
      for (const job of f.queue) {
        const batch = {id:job.productId,name:name(job.productId),quantity:1};
        if (job.finishTime > snapshot.serverNow && snapshot.serverNow > 0) {
          row.runs.push({...batch,from:snapshot.serverNow,to:job.finishTime,status:'running',existing:true});
        } else if (job.finishTime > 0 && snapshot.serverNow > 0) row.elapsed.push(batch);
        else row.untimedQueue.push(batch);
      }
      row.ready = f.finished.filter(j => j.num > 0).map(j => ({id:j.id,name:name(j.id),quantity:j.num}));
    }
    for (const f of snapshot.farms) {
      const row = facility(f.id,true);
      if (!f.productId) continue;
      const batch = {id:f.productId,name:name(f.productId),quantity:1};
      if (f.ripeTime > snapshot.serverNow && snapshot.serverNow > 0) {
        row.runs.push({...batch,from:snapshot.serverNow,to:f.ripeTime,status:'running',existing:true});
      } else if (f.ripeTime > 0 && snapshot.serverNow > 0) row.ready.push(batch);
      else row.untimedQueue.push(batch);
    }
  }
  function add(id,jobs) {
    if (onlyMissing && known.has(id)) return;
    const row = facility(id,!!jobs[0]?.crop);
    const batches = unscheduledBatches(jobs,new Map(),name);
    row.unscheduled.push(...batches);
    row.pendingInsertions.push(...batches.filter(j => j.inserted));
    if (!known.has(id)) row.unknown = '等待设施同步';
  }
  for (const entry of Object.values(entries)) {
    for (const [target,jobs] of Object.entries(entry.stagedSupplies ?? {})) add(target,jobs);
  }
  for (const [id,entry] of Object.entries(entries)) add(id,entry.jobs);
  return [...result.values()];
}
