import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDirectory } from './usage-ledger.mjs';
import { goldAccountKey } from './gold-reservations.mjs';
import { readJson, atomicJson, withFileLock } from './json-store.mjs';
import { createProductionEligibility, factoryRecipeCosts, factoryRecipeAvailability } from './production-eligibility.mjs';

export const refillGoal = (rule, cap) => Math.min(rule.target ?? cap, cap);
const refillKey = rule => JSON.stringify([rule.productId, rule.trigger, rule.target]);
export const editingFactoryQueue = entry => !!(entry?.flight || entry?.remove?.length || entry?.stagedSupplies);
export const readyRefillUnits = (buildings, id) => buildings.reduce((sum, b) => sum +
  (b.factory?.finishedProducts ?? []).reduce((n, item) => n + (item.id === id ? Number(item.num) : 0), 0), 0);

export function factoryIncomingStock(factories) {
  const incoming = new Map();
  const add = (id, num) => incoming.set(id, (incoming.get(id) ?? 0) + num);
  for (const { factory } of factories) {
    for (const job of factory.factoryQ ?? []) add(job.productId, 1);
    for (const item of factory.finishedProducts ?? []) add(item.id, Number(item.num));
  }
  return incoming;
}

// Preview and forecast use their own copy. Live checks persist only transitions,
// so a reconnect halfway through a refill does not release the factory.
export function refillHistoryFor(player) {
  if (!player?.playerId || !player.worldId) return { active:{} };
  const role = createHash('sha256').update(goldAccountKey(player)).digest('hex');
  const file = path.join(dataDirectory(), 'factory-refills', role + '.json');
  return { file, active:readJson(file, {}) };
}

export function refillFactoryType(config, building) {
  const id = building.buildingId ?? building.id;
  return building.type ?? config?.tables?.BuildingUnlockCfg?.data.find(r => r.buildingId === id)?.buildingType
    ?? config?.tables?.BuildingCfg?.data.map(r => r.buildingType).filter(t => id.endsWith(t)).sort((a,b) => b.length-a.length)[0];
}

export function refillRecipe(config, building, rule, festivals, now) {
  const type = refillFactoryType(config, building);
  const recipe = config?.tables?.BuildingProduceCfg?.data.find(row => row.itemId === rule.productId
    && row.buildType === type && row.unlockLevel <= building.level);
  return factoryRecipeAvailability(recipe, festivals, now).allowed && factoryRecipeCosts(recipe) ? recipe : null;
}

// Remember triggered items until they reach the warehouse target. The current
// rule order decides which of those items owns the factory on each check.
function triggeredFactoryRefills(rules, building, { config, festivals, now, owned, cap, history, record = false }) {
  const id = building.buildingId ?? building.id;
  const eligible = new Map(), triggered = new Set();
  for (const rule of rules) {
    if (rule.buildingId !== id) continue;
    const count = owned(rule.productId);
    if (count >= refillGoal(rule, cap)) continue;
    const recipe = refillRecipe(config, building, rule, festivals, now);
    if (!recipe) continue;
    const key = refillKey(rule);
    eligible.set(key, { rule, recipe });
    if (count <= rule.trigger) triggered.add(key);
  }
  function update(entries) {
    const previous = entries[id];
    // Single-item refills from older versions store their key as a string.
    const waiting = Array.isArray(previous) ? previous : typeof previous === 'string' ? [previous] : [];
    const next = [...eligible.keys()].filter(key => triggered.has(key) || waiting.includes(key));
    if (next.length) entries[id] = next.length === 1 ? next[0] : next;
    else delete entries[id];
    return next.map(key => eligible.get(key));
  }
  const previous = history.active[id];
  let selected = update(history.active);
  if (record && history.file && JSON.stringify(previous) !== JSON.stringify(history.active[id])) {
    withFileLock(history.file, () => {
      const entries = readJson(history.file, {});
      selected = update(entries);
      history.active = entries;
      atomicJson(history.file, entries);
    });
  }
  return selected;
}

// Explicit rules keep their trigger history. Supply targets exist only for the
// current snapshot, and share one balance across the active recipe trees.
export function resolveFactoryRefills(buildings, settings, ctx) {
  const {config, cap, owned, available = owned, incoming, now, festivals} = ctx;
  const factory = settings.factory, rules = factory.refillRules ?? [];
  const selected = new Map();
  if (!rules.length || !(cap > 0)) return selected;
  const makers = buildings.filter(b => b.level > 0 && b.factory
    && !(b.factory.autoProductId && (ctx.autoProduceForever || ctx.autoProduceEndTime > now))
    && !factory.disabledTypes.includes(b.buildingId) && !factory.disabledTypes.includes(refillFactoryType(config,b)));
  const roots = new Map();
  const busy = new Set();
  for (const b of makers) {
    const pending = triggeredFactoryRefills(rules,b,ctx);
    if (!pending.length) continue;
    const runnable = pending.find(({rule,recipe}) => b.factory.factoryQ?.some(j => j.productId === rule.productId)
      || refillGoal(rule,cap) <= owned(rule.productId) + (incoming.get(rule.productId) ?? 0)
      || factoryRecipeCosts(recipe).every(({id,num}) => available(id) >= num));
    if (runnable) busy.add(b.buildingId);
    selected.set(b.buildingId,runnable ?? pending[0]);
    // Keep sourcing the first choice even when a runnable lower choice fills the gap.
    for (const task of new Set([pending[0], runnable].filter(Boolean))) {
      const {rule} = task, id = rule.productId;
      const count = refillGoal(rule,cap) - owned(id) - (incoming.get(id) ?? 0);
      if (count > 0 && (!roots.has(id) || roots.get(id).count < count)) roots.set(id,{...task,count});
    }
  }
  if (!roots.size) return selected;
  const recipes = config?.tables?.BuildingProduceCfg?.data ?? [];
  const stock = new Map();
  for (const recipe of recipes) for (const {id} of factoryRecipeCosts(recipe) ?? []) stock.set(id,Math.max(0,available(id)));
  // A manual target for an intermediate already covers this many units of
  // downstream demand. Expand its own recipe once, alongside the other roots.
  const expected = new Map(incoming);
  for (const [id,{count}] of roots) expected.set(id,(expected.get(id) ?? 0) + count);
  const allocate = createProductionEligibility(config,{buildings:makers,settings,stock,incoming:expected});
  const needs = new Map();
  for (const {rule,recipe,count} of roots.values()) {
    const inputs = factoryRecipeCosts(recipe).map(({id,num}) => ({id,num:num*count}));
    allocate(inputs,{reserve:true,acceptBatches:batches => {
      for (const material of batches.keys()) {
        if (material.itemId === rule.productId || !factoryRecipeAvailability(material,festivals,now).allowed) return false;
      }
      for (const [material,num] of batches) {
        const need = needs.get(material) ?? {quantity:0, forProducts:new Set()};
        need.quantity += num; need.forProducts.add(rule.productId); needs.set(material,need);
      }
      return true;
    }});
  }
  for (const b of makers) {
    if (busy.has(b.buildingId)) continue;
    const ownProduct = selected.get(b.buildingId)?.rule.productId;
    const candidates = ownProduct ? [...needs].sort((a,b) => Number(b[1].forProducts.has(ownProduct)) - Number(a[1].forProducts.has(ownProduct))) : needs;
    for (const [recipe,need] of candidates) {
      const id = recipe.itemId;
      if (recipe.buildType !== refillFactoryType(config,b) || recipe.unlockLevel > b.level
        || !factoryRecipeCosts(recipe)?.every(({id,num}) => available(id) >= num)) continue;
      const onHandAndIncoming = owned(id) + (incoming.get(id) ?? 0);
      const target = Math.min(cap,onHandAndIncoming + need.quantity);
      if (target <= onHandAndIncoming) continue;
      selected.set(b.buildingId,{recipe,rule:{buildingId:b.buildingId,productId:id,target},supply:true});
      break;
    }
  }
  return selected;
}

// A preview starts from the warehouse snapshot, before simulated collection
// can lift the balance above the trigger. Never persist forecast transitions.
export function snapshotRefills(snapshot, config, settings) {
  const rules = settings.factory?.refillRules;
  const history = rules?.length ? refillHistoryFor(snapshot.raw?.player ?? {playerId:snapshot.player?.id, worldId:snapshot.player?.worldId}) : {active:{}};
  const active = [];
  if (!rules?.length || !settings.factory.enabled || !settings.factory.produce || settings.loop?.world === false ||
    !(snapshot.inventoryKnown ?? snapshot.complete) || !(snapshot.stockCap > 0)) return {history, active};
  const stock = new Map(snapshot.inventory.map(row => [row.id, row.num]));
  const buildings = snapshot.factories.map(b => ({buildingId:b.id,type:b.type,level:b.level,enabled:b.enabled && !b.nativeAutoActive,
    factory:{factoryQ:b.queue,finishedProducts:b.finished}}));
  const assignments = resolveFactoryRefills(buildings.filter(b => b.enabled),settings,{config,history,cap:snapshot.stockCap,
    festivals:snapshot.raw?.festivals,now:snapshot.serverNow,owned:id => stock.get(id) ?? 0,incoming:factoryIncomingStock(buildings)});
  for (const selected of assignments.values()) active.push(selected.rule);
  return {history, active};
}

export function refillCanTakeOver(queue, productId, missing, costs, available) {
  // A queued refill has already paid for its inputs.
  return queue.some((job, i) => i > 0 && job.productId === productId && !job.finishTime)
    || missing > 0 && costs.every(({id,num}) => available(id) >= num);
}

export function refillSpeedUpJobs(queue, productId, now) {
  if (queue.some(job => job.productId !== productId && !job.finishTime)) return [];
  const running = queue.filter(job => job.finishTime > now);
  // The game supports up to two running jobs; each timer identifies one job, not a queue position.
  return running.length <= 2 ? running.filter(job => job.productId !== productId) : [];
}

export function planFactoryRefill(building, rule, recipe, { survey, owned, incoming, free, reserve, credit, useAccelerators, supply, factoryName, productName }) {
  const { buildingId } = building, { productId } = rule;
  const queue = building.factory.factoryQ;
  const goal = refillGoal(rule, survey.stockCap);
  const missing = goal - owned(productId) - (incoming.get(productId) ?? 0);
  const steps = [];
  const step = (request, body, label, extra) => steps.push({ kind:'startProduce', request, response:null,
    body:{buildingId, ...body}, refillRule:rule, ...(supply ? {refillSupply:true} : {}), displayFactory:factoryName, label, ...extra });
  if (owned(productId) + readyRefillUnits(survey.factories, productId) >= goal ||
    !Array.isArray(queue) || editingFactoryQueue(survey.factoryInsertions?.[buildingId])) return steps;
  const costs = factoryRecipeCosts(recipe);
  if (!refillCanTakeOver(queue, productId, missing, costs, free)) return steps;
  const others = queue.filter(job => job.productId !== productId);
  const waiting = others.filter(job => !job.finishTime);
  for (const job of waiting.toReversed()) {
    if (job === queue[0]) continue; // A missing head timer cannot prove that the slot is cancellable.
    step('CancelFactoryProduceRequest', {index:job.idx ?? 0}, factoryName + '为补' + productName + '撤下排队的' + job.productId,
      { verify:{productId:job.productId} });
  }
  if (waiting.length) return steps;
  const now = survey.serverNow ?? survey.now;
  if (useAccelerators) {
    for (const job of refillSpeedUpJobs(queue, productId, now)) {
      const useNum = Math.min(Math.ceil((job.finishTime - now) / 60), free('加速器'));
      if (useNum <= 0) break;
      reserve('加速器', useNum);
      step('SpeedUpFactoryProduceRequest', {index:job.idx ?? 0, speedUp:{type:2, useNum}},
        factoryName + '使用 ' + useNum + ' 个加速器为' + productName + '腾出生产位',
        { verify:{productId:job.productId, finishTime:job.finishTime}, costs:[{id:'加速器', num:useNum}] });
    }
  }
  const slots = Math.min(missing, survey.factorySlots - queue.length);
  for (let n = 0; n < slots && costs.every(({id,num}) => free(id) >= num); n++) {
    for (const {id,num} of costs) reserve(id,num);
    incoming.set(productId, (incoming.get(productId) ?? 0) + 1); credit(productId, 1);
    step('StartFactoryProduceRequest', {productId}, factoryName + '优先补' + productName + '至 ' + goal + ' 件',
      { costs, demandDriven:false, displayProduct:productName,
        eligibilityKey:factoryRecipeAvailability(recipe, survey.festivals, now).signature + ':' + building.level });
  }
  return steps;
}
