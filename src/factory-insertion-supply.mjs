import { resourceReserve } from './automation-policy.mjs';
import { factoryRecipeAvailability, factoryRecipeCosts } from './production-eligibility.mjs';
import { confirmedFactoryIncoming } from './factory-production.mjs';
import { makeTypeResolver } from './world.mjs';
import { factoryProductionSnapshot } from './spend-evidence.mjs';
import { createProductionTiming, nextFactoryLane } from './production-timing.mjs';

const rows = (config, name) => config.tables[name]?.data ?? [];
function checked(n) {
  if (!Number.isSafeInteger(n)) throw new RangeError('插单所需材料数量超出安全范围');
  return n;
}

// Each quote gets its own balance. Shared ingredients and a crop's surplus
// are therefore consumed only once, even across branches of the recipe tree.
export function insertionSupplyPlanner({ config, water, stock, reserved, entries, settings, now, festivals, canPlant, timing }) {
  const typeOf = makeTypeResolver(config);
  const recipes = new Map(rows(config, 'BuildingProduceCfg').map(r => [r.itemId, r]));
  const crops = new Map(rows(config, 'FarmlandPlantCfg').map(r => [r.id, r]));
  const incoming = confirmedFactoryIncoming(water);
  const passive = new Set(), makers = new Map(), balance = new Map();
  const clock = createProductionTiming({ ...timing, config, serverNow:now });
  const facilities = water.building.filter(b => b.level > 0).map(b => ({ ...b, type:typeOf(b.buildingId) }));
  for (const b of facilities) {
    const crop = crops.get(b.farm?.productId);
    if (crop && b.farm.ripeTime > 0) incoming.set(crop.id, (incoming.get(crop.id) ?? 0) + crop.produceNum);
    const upgrade = rows(config, 'BuildingUpgradeCfg').find(r => r.buildingType === b.type && r.level === b.level);
    for (const [id, amount] of upgrade?.product ?? []) if (amount > 0) passive.add(id);
  }
  function load(id) {
    if (!balance.has(id)) balance.set(id, checked((stock.get(id) ?? 0) + (incoming.get(id) ?? 0)
      - (reserved.get(id) ?? 0) - (resourceReserve(settings, id) || 0)));
    return balance.get(id);
  }
  for (const [buildingId, entry] of Object.entries(entries)) {
    const jobs = [...entry.jobs, ...Object.values(entry.stagedSupplies ?? {}).flat()];
    let observed;
    const flight = entry.flight;
    if (flight?.kind === 'start' && factoryProductionSnapshot(water, buildingId)?.totals.get(flight.id) > flight.baseline
      || flight?.kind === 'plant' && facilities.find(b => b.buildingId === buildingId)?.farm?.productId === flight.id) {
      observed = entry.jobs[flight.jobIndex ?? 0];
    }
    let scheduledLater = false;
    for (const job of jobs) {
      scheduledLater ||= job.at > now;
      if (!job.pinned) continue;
      const count = (job.quantity ?? 1) - Number(job === observed), crop = job.crop && crops.get(job.id);
      for (const [id, n] of crop ? [crop.material] : recipes.get(job.id)?.costItem ?? []) {
        balance.set(id, checked(load(id) - checked(n * count)));
      }
      if (!entry.remove?.length && !entry.stagedSupplies && !scheduledLater) {
        balance.set(job.id, checked(load(job.id) + checked(count * (crop?.produceNum ?? 1))));
      }
    }
  }
  function maker(id) {
    if (makers.has(id)) return makers.get(id);
    const recipe = recipes.get(id), crop = crops.get(id);
    const type = recipe?.buildType ?? (crop && '农田');
    const costs = recipe ? factoryRecipeCosts(recipe) : factoryRecipeCosts({costItem:crop && [crop.material]});
    const enabled = recipe ? Number.isSafeInteger(recipe.unlockLevel) && factoryRecipeAvailability(recipe, festivals, now).allowed
      : canPlant && !water.autoFarming && Number.isSafeInteger(crop?.produceNum) && crop.produceNum > 0;
    const candidates = enabled && costs ? facilities.filter(b => b.type === type && (!recipe || (b.factory && b.level >= recipe.unlockLevel))
      && !b.buildStartTime && !b.buildFinishTime
      && !settings.factory?.disabledTypes?.some(key => key === b.type || key === b.buildingId)
      && !(b.factory?.autoProductId && (water.autoProduceForever || water.autoProduceEndTime > now))
      && !entries[b.buildingId]?.flight && !entries[b.buildingId]?.remove?.length && !entries[b.buildingId]?.stagedSupplies) : [];
    const startAt = b => {
      if (crop) return Math.max(now, b.farm?.ripeTime ?? 0);
      const { lanes, finishes, missing } = clock.factoryQueue(b);
      if (missing.length) return Infinity;
      return nextFactoryLane(finishes, lanes.expiresAt, clock.factory(recipe,{building:b}).seconds ?? recipe.produceTime).start;
    };
    candidates.sort((a,b) => startAt(a) - startAt(b) || (a.factory?.factoryQ.length ?? 0) - (b.factory?.factoryQ.length ?? 0));
    const result = candidates.length ? { buildingId:candidates[0].buildingId, costs, output:crop?.produceNum ?? 1, crop:!!crop } : null;
    makers.set(id, result);
    return result;
  }
  function plan(recipe, quantity, target, productId = recipe.itemId, { waitForInputs = false } = {}) {
    const left = new Map(), jobs = new Map(), visiting = new Set([recipe.itemId]);
    function requireItem(id, n) {
      const needed = checked(n - (left.get(id) ?? load(id)));
      left.set(id, Math.max(0, -needed));
      if (needed <= 0) return;
      const facility = maker(id);
      if (!facility) {
        if (waitForInputs || passive.has(id)) return;
        throw new RangeError((config.materialName?.(id) ?? id) + '还缺 ' + needed + ' 件，当前没有可插单的生产设施');
      }
      if (visiting.has(id)) throw new RangeError('原料配方存在循环依赖');
      visiting.add(id);
      const batches = Math.ceil(needed / facility.output);
      for (const cost of facility.costs) requireItem(cost.id, checked(cost.num * batches));
      visiting.delete(id);
      left.set(id, checked(batches * facility.output) - needed);
      const job = jobs.get(id) ?? { id, quantity:0, pinned:true, supplyFor:productId, supplyTarget:target, ...(facility.crop ? {crop:true} : {}) };
      job.quantity = checked(job.quantity + batches);
      jobs.set(id, job);
    }
    for (const cost of factoryRecipeCosts(recipe)) requireItem(cost.id, checked(cost.num * quantity));
    const byBuilding = {};
    for (const job of jobs.values()) (byBuilding[maker(job.id).buildingId] ??= []).push(job);
    return byBuilding;
  }
  function option(recipe) {
    const costs = factoryRecipeCosts(recipe);
    return { max:null, requiresMaterials:costs.length > 0, autoSupply:costs.some(c => maker(c.id)) };
  }
  return { plan, option };
}
