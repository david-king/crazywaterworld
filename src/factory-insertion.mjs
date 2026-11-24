import { normalize } from './worlds.mjs';
import { displayMaterial } from './config.mjs';
import { confirmedFactoryIncoming, confirmFactoryProductionBeforeHarvest, factoryStockCapacity, readInsertionAlternativeStock } from './factory-production.mjs';
import { insertionRecipeReady } from './production-eligibility.mjs';
import { consumeInsertionUnit, nextInsertionIndex } from './factory-insertion-queue.mjs';
import { farmInventory } from './farm-planting.mjs';
import { resourceReserve } from './automation-policy.mjs';
import { readOrderReservedStock } from './order-reservations.mjs';
import { factoryProductionSnapshot } from './spend-evidence.mjs';
import { factoryInsertions, saveFactoryInsertion } from './factory-insert-store.mjs';
import { factoryProductionKey, factoryRecipeAvailability, factoryRecipeCosts, runWorld, startManualFactoryProduction } from './world.mjs';
import { insertionSupplyPlanner } from './factory-insertion-supply.mjs';

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const stamp = queue => JSON.stringify(queue.map(j => [j.idx ?? 0, j.productId, j.finishTime ?? 0]));
const nativeOn = (water, building, now) => building.factory.autoProductId && (water.autoProduceForever || water.autoProduceEndTime > now);
const stale = () => new Error('工厂队列或所选任务已变化，请重新生成排产计划');

// Resolve the displayed batch to individual game indices or original dispatch order.
// Two lanes can share a start time and their finish order need not match dispatch order.
export function locateFactoryInsertion(trace, forecast, target, previous) {
  const { from, id, lane, status, offset = 0 } = target;
  if (!Number.isSafeInteger(offset) || offset < 0) throw stale();
  if (status === 'batch') {
    const index = target.planIndex;
    const job = previous?.jobs[index], count = job?.quantity ?? 1;
    if (!Number.isSafeInteger(index) || !job?.pinned || job.id !== id || offset >= count) throw stale();
    const before = previous.jobs.slice(0, index);
    if (offset) before.push({ ...job, quantity:offset });
    const after = [offset ? { ...job, quantity:count-offset } : job, ...previous.jobs.slice(index+1)];
    return { before, after, remove:[], count };
  }
  if (!Number.isSafeInteger(from)) throw stale();
  let targetUnit, count = 1;
  const units = trace.units;
  if (status === 'gap') {
    if (from < forecast.startAt || from >= forecast.endAt || (from !== forecast.startAt && !units.some(u => u.to === from))
      || units.some(u => u.from <= from && from < u.to)) throw stale();
    targetUnit = units.filter(u => u.from > from).sort((a,b) => a.from - b.from)[0];
  } else {
    const run = forecast.runs.find(r => r.from === from && r.id === id && r.lane === lane && r.status === status);
    if (!run) throw stale();
    const matches = units.filter(u => u.from >= run.from && u.from < run.to && u.lane === lane && u.id === id && u.status === status);
    count = status === 'running' ? 1 : matches.length;
    targetUnit = matches[offset];
    if (!targetUnit) throw stale();
  }
  if (offset >= count) throw stale();
  const queue = trace.queue;
  let cut = queue.length;
  if (status === 'running') cut = 1;
  else if (targetUnit?.status === 'queued') {
    cut = queue.findIndex(q => (q.idx ?? 0) === targetUnit.idx);
    if (cut <= 0 || queue[cut].finishTime) throw stale();
  }
  const remove = queue.slice(cut).filter(q => !q.finishTime).map(q => ({ idx:q.idx ?? 0, id:q.productId })).reverse();
  const planned = units.filter(u => u.status === 'planned');
  const prefix = targetUnit?.status === 'planned' ? planned.slice(0, planned.indexOf(targetUnit))
    : status === 'gap' && !targetUnit ? planned : [];
  const remaining = previous?.jobs.slice() ?? [];
  const earlier = targetUnit?.manual ? targetUnit.sourceIndex : 0;
  const before = remaining.slice(0, earlier);
  for (const u of prefix) {
    if (!u.manual) { before.push({ id:u.id, at:u.at }); continue; }
    if (u.sourceIndex < earlier) continue;
    const job = remaining[u.sourceIndex];
    if (job?.id !== u.id) throw stale();
    if (job.quantity > 1) {
      remaining[u.sourceIndex] = { ...job, quantity:job.quantity - 1 };
      before.push({ ...job, quantity:1 });
    } else {
      remaining[u.sourceIndex] = null;
      before.push(job);
    }
  }
  // A full product may not appear in the forecast. Keep its priority when
  // inserting before a later unit in the saved queue.
  const after = remaining.slice(earlier).filter(Boolean);
  if (targetUnit?.status === 'planned' && !targetUnit.manual) after.push({ id:targetUnit.id, at:targetUnit.at });
  return { before, remove, after, count };
}

export async function prepareFactoryInsertion(client, protocol, ctx, quote, target, submit) {
  const { config, player, settings, enabled } = ctx;
  const buildingId = target.buildingId, trace = quote.anchors.get(buildingId);
  const forecast = quote.forecast.factories.find(f => f.id === buildingId);
  if (!trace || !forecast || forecast.unknown || !enabled()) throw stale();
  if (!protocol.StartFactoryProduceRequest) throw new Error('当前游戏协议无法向工厂派单');
  const entries = factoryInsertions(player), previous = entries[buildingId];
  if (previous?.flight || previous?.remove?.length || previous?.stagedSupplies || previous?.revision !== trace.revision) throw stale();
  const position = locateFactoryInsertion(trace, { ...forecast, startAt:quote.forecast.startAt, endAt:quote.forecast.endAt }, target, previous);
  if (position.remove.length && !protocol.CancelFactoryProduceRequest) throw new Error('当前游戏协议无法调整已排队的任务');
  const { stock, reserved, water:raw } = await readOrderReservedStock(client, protocol, config, { player, settings, enabled });
  const water = normalize(raw), live = factoryProductionSnapshot(water, buildingId), now = clock(client);
  if (!live || stamp(live.queue) !== stamp(trace.queue) || nativeOn(water, live.building, now) || !enabled()) throw stale();
  const recipes = rows(config, 'BuildingProduceCfg');
  const supply = insertionSupplyPlanner({ config, water, stock, reserved, entries, settings, now,
    festivals:client.festivals, canPlant:!!(protocol.FarmPlantRequest && protocol.OkResponse), timing:quote.timing });
  const products = [];
  for (const r of recipes) {
    if (r.buildType !== trace.type || !Number.isSafeInteger(r.unlockLevel) || r.unlockLevel > live.building.level
      || !factoryRecipeAvailability(r,client.festivals,now).allowed) continue;
    const costs = factoryRecipeCosts(r);
    if (!costs) continue;
    if (!submit || r.itemId === target.productId) products.push({ id:r.itemId, name:displayMaterial(config,r.itemId), ...supply.option(r) });
  }
  if (!submit) return { products, count:position.count, reordersQueue:position.remove.length > 0 };
  const product = products.find(p => p.id === target.productId), n = target.quantity;
  if (!product || !Number.isSafeInteger(n) || n < 1) throw new Error('请选择已解锁的产物，并输入有效的正整数件数');
  const supplies = supply.plan(recipes.find(r => r.itemId === product.id), n, buildingId, product.id, { waitForInputs:true });
  const sameFactory = supplies[buildingId] ?? [];
  delete supplies[buildingId];
  const inserted = { id:product.id, quantity:n, pinned:true, ...(product.requiresMaterials ? {waitForMaterials:true} : {}),
    ...(target.status === 'gap' ? { at:target.from } : {}) };
  const restored = position.remove.toReversed().map(q => ({ id:q.id, pinned:true }));
  const jobs = [...position.before, ...sameFactory, inserted, ...restored, ...position.after];
  const rewrite = position.remove.length ? { remove:position.remove, expected:trace.queue, restored:[], rollback:previous?.jobs ?? [] } : {};
  const stage = position.remove.length && Object.keys(supplies).length;
  saveFactoryInsertion(player, buildingId, previous, { jobs, ...rewrite, ...(stage ? {stagedSupplies:supplies} : {}) },
    entries, stage ? {} : supplies);
  return { label:'已加入计划队列：' + product.name + ' ×' + n };
}

async function advanceInsertionCrop(client, protocol, ctx, buildingId, entry) {
  const { config, player, settings, enabled } = ctx, job = entry.jobs[0];
  const save = next => { entry = saveFactoryInsertion(player, buildingId, entry, next); };
  const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
  if (!enabled()) return;
  const plot = water.building?.find(b => b.buildingId === buildingId);
  if (!plot) return;
  if (entry.flight) {
    if (entry.flight.kind !== 'plant' || plot.farm?.productId !== job.id || !(plot.farm.plantTime > 0)
      || !(plot.farm.ripeTime >= plot.farm.plantTime)) return;
    const jobs = entry.jobs.slice();
    consumeInsertionUnit(jobs, 0);
    save(jobs.length ? { jobs } : null);
    return;
  }
  if (water.autoFarming || plot.buildStartTime || plot.buildFinishTime || plot.farm?.productId) return;
  const crop = rows(config,'FarmlandPlantCfg').find(r => r.id === job.id);
  if (!crop) return;
  const [id, num] = crop.material;
  const entries = factoryInsertions(player);
  const materials = await readOrderReservedStock(client, protocol, config, { ...ctx, itemIds:[id] });
  if (!enabled() || (materials.stock.get(job.id) ?? 0) >= factoryStockCapacity(config,player) * 5) return;
  if ((materials.available.get(id) ?? 0) - resourceReserve(settings,id) < num) {
    try {
      replenishInsertion(client, protocol, ctx, buildingId, entry, {itemId:crop.id,costItem:[crop.material]}, materials, entries);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (entry.note !== error.message) save({...entry,note:error.message});
    }
    return;
  }
  const step = { kind:'farm', request:'FarmPlantRequest', manualCheck:true, body:{args:[{buildingId,productId:job.id}]},
    costs:[{id,num}], label:'为插单播种' + displayMaterial(config,job.id),
    beforePlantSend() { save({ ...entry, flight:{kind:'plant',id:job.id} }); } };
  const {results:[result]} = await runWorld(client, protocol, {actions:[step]}, { config, player, enabled, allowMutate:true });
  if (entry.flight && result && !result.ok && result.status !== 'unknown') save({jobs:entry.jobs});
}

// Another consumer may spend stock between submission and dispatch. Requote
// the waiting batch without charging its own inputs twice.
function replenishInsertion(client, protocol, ctx, buildingId, entry, recipe, materials, entries) {
  const { config, player, settings, enabled } = ctx;
  const {water:raw, stock, reserved} = materials;
  if (!enabled()) return;
  const head = entry.jobs[0];
  if (entries[buildingId]?.revision !== entry.revision) throw stale();
  if (Object.values(entries).some(e => e.flight || e.remove?.length || e.stagedSupplies)) return;
  const others = { ...entries, [buildingId]:{jobs:entry.jobs.slice(1)} };
  const planner = insertionSupplyPlanner({ config, water:normalize(raw), stock, reserved, entries:others, settings,
    now:clock(client), festivals:client.festivals, canPlant:!!(protocol.FarmPlantRequest && protocol.OkResponse) });
  const supplies = planner.plan(recipe, head.quantity ?? 1, head.supplyTarget ?? buildingId, head.supplyFor ?? head.id);
  if (!Object.keys(supplies).length) return;
  const jobs = [...(supplies[buildingId] ?? []), ...entry.jobs];
  delete supplies[buildingId];
  return saveFactoryInsertion(player, buildingId, entry, { jobs }, entries, supplies);
}

// Journal each packet at the actual send boundary. A lost acknowledgement may
// only advance the journal after a fresh queue + uncollected-output observation.
export async function advanceFactoryInsertion(client, protocol, ctx, buildingId) {
  const { player, config, enabled } = ctx;
  let e = factoryInsertions(player)[buildingId];
  const save = next => { e = saveFactoryInsertion(player, buildingId, e, next); };
  const note = message => { if (e && e.note !== message) save({ ...e, note:message }); };
  const finishUnit = (index, id) => {
    if (e.jobs[index]?.id !== id) throw stale();
    const jobs = e.jobs.slice();
    consumeInsertionUnit(jobs, index);
    save(jobs.length ? { jobs } : null);
  };
  const abortRewrite = () => {
    const jobs = [...e.restored, ...e.rollback];
    save(jobs.length ? { jobs } : null);
    return '工厂队列已变化，插单已撤回，已移出的任务将按原顺序补回';
  };
  for (let i = 0; e && i < 16 && enabled(); i++) {
    if (e.stagedSupplies && !e.remove?.length && !e.flight) {
      const entries = factoryInsertions(player), supplies = e.stagedSupplies;
      if (Object.keys(supplies).some(id => entries[id]?.flight || entries[id]?.remove?.length || entries[id]?.stagedSupplies)) return;
      e = saveFactoryInsertion(player, buildingId, e, { jobs:e.jobs }, entries, supplies);
    }
    if (e.jobs[0]?.crop) return advanceInsertionCrop(client, protocol, ctx, buildingId, e);
    if (!e.remove?.length && !e.flight && e.jobs[0]?.at > clock(client)) return;
    if (e.remove?.length && !e.flight) await confirmFactoryProductionBeforeHarvest(client, protocol, buildingId, { player, enabled });
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    if (!enabled()) return;
    const live = factoryProductionSnapshot(water, buildingId);
    if (!live || nativeOn(water,live.building,clock(client))) { note('等待游戏原生自动生产关闭或工厂同步'); return; }
    const sum = id => live.totals.get(id) ?? 0;
    if (e.flight) {
      const { kind, id, idx, baseline } = e.flight;
      if (kind === 'cancel') {
        const original = live.queue.find(q => (q.idx ?? 0) === idx && q.productId === id);
        if (original?.finishTime) return abortRewrite();
        if (original || sum(id) >= baseline) {
          note('游戏撤单结果待确认'); return;
        }
        const remove = e.remove.slice(1);
        save(remove.length ? { ...e, remove, flight:null, note:null,
          expected:e.expected.filter(q => (q.idx ?? 0) !== idx), restored:[{ id, pinned:true }, ...e.restored] }
          : { jobs:e.jobs, ...(e.stagedSupplies ? {stagedSupplies:e.stagedSupplies} : {}) });
      } else {
        if (sum(id) <= baseline) { note('游戏入队结果待确认'); return; }
        finishUnit(e.flight.jobIndex ?? 0, id);
      }
      continue;
    }
    if (e.remove?.length) {
      const { idx,id } = e.remove[0], index = live.queue.findIndex(q => (q.idx ?? 0) === idx && q.productId === id);
      if (stamp(live.queue) !== stamp(e.expected) || index < 1 || live.queue[index].finishTime) return abortRewrite();
      try {
        await client.sendWatch('CancelFactoryProduceRequest', { buildingId,index:idx }, { beforeSend() {
          if (!enabled()) throw stale();
          if (live.queue.some(job => job.finishTime && job.finishTime <= clock(client))) throw stale();
          save({ ...e, flight:{ kind:'cancel',idx,id,baseline:sum(id) } });
        } });
      } catch (error) {
        if (error.prompt && error.request === 'CancelFactoryProduceRequest') return abortRewrite();
        throw error;
      }
      continue;
    }
    const slots = Number(rows(config,'BuildingProduceParamCfg').find(r => r.paramName === '制造位上限')?.paramValue);
    if (live.queue.length >= slots) return;
    const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
    if (!enabled()) return;
    const incoming = confirmedFactoryIncoming(water), cap = factoryStockCapacity(config, player);
    const isFull = id => (stock.get(id) ?? 0) + (incoming.get(id) ?? 0) >= cap;
    const recipes = rows(config,'BuildingProduceCfg');
    const head = e.jobs[0];
    const entries = (head.waitForMaterials || head.supplyFor) && !isFull(head.id) ? factoryInsertions(player) : null;
    const materials = entries ? await readOrderReservedStock(client, protocol, config, ctx) : null;
    const alternativeStock = isFull(head.id)
      ? await readInsertionAlternativeStock(client, protocol, config, e, ctx, isFull) : null;
    if (!enabled()) return;
    const free = item => ((materials?.available ?? alternativeStock ?? stock).get(item) ?? 0) - resourceReserve(ctx.settings,item);
    const now = clock(client);
    const index = nextInsertionIndex(e.jobs, now, isFull, id =>
      insertionRecipeReady(recipes.find(r => r.itemId === id), live.building.level, client.festivals, now, free));
    if (index < 0) {
      if (materials) {
        const recipe = recipes.find(r => r.itemId === head.id);
        if (!factoryRecipeCosts(recipe)) { note('插单配方已变化'); return; }
        try {
          const updated = replenishInsertion(client, protocol, ctx, buildingId, e, recipe, materials, entries);
          if (updated) { e = updated; continue; }
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          note(error.message);
          return;
        }
      }
      note(displayMaterial(config, head.id) + (isFull(head.id) ? '已满仓，消耗后优先补产' : '等待上游原料入库'));
      return;
    }
    const id = e.jobs[index].id, recipe = recipes.find(r => r.itemId === id);
    if (!recipe) { note('插单配方已变化'); return; }
    let result;
    try {
      result = await startManualFactoryProduction(client, protocol, { buildingId, productId:id,
        productionKey:factoryProductionKey(player,live.building,recipe) }, { ...ctx, beforeInsertSend() {
        save({ ...e, flight:{ kind:'start', id, jobIndex:index, baseline:sum(id) } });
      } });
    } catch (error) {
      if (e?.flight && error.notSent) save({ ...e, flight:null, note:error.message });
      else note(error.message);
      return;
    }
    if (!result.confirmed) { note('游戏入队结果待确认'); return; }
    finishUnit(index, id);
  }
}
