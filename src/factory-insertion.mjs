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
import { factoryProductionKey, factoryRecipeAvailability, factoryRecipeCosts, startManualFactoryProduction } from './world.mjs';

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const stamp = queue => JSON.stringify(queue.map(j => [j.idx ?? 0, j.productId, j.finishTime ?? 0]));
const add = (map, id, num) => map.set(id, (map.get(id) ?? 0) + num);
const nativeOn = (water, building, now) => building.factory.autoProductId && (water.autoProduceForever || water.autoProduceEndTime > now);
const stale = () => new Error('工厂队列或所选任务已变化，请重新生成排产计划');

// Resolve the displayed batch to individual game indices or original dispatch order.
// Two lanes can share a start time and their finish order need not match dispatch order.
export function locateFactoryInsertion(trace, forecast, target, previous) {
  const { from, id, lane, status, offset = 0 } = target;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(from)) throw stale();
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
  if (previous?.flight || previous?.remove?.length || previous?.revision !== trace.revision) throw stale();
  const position = locateFactoryInsertion(trace, { ...forecast, startAt:quote.forecast.startAt, endAt:quote.forecast.endAt }, target, previous);
  if (position.remove.length && !protocol.CancelFactoryProduceRequest) throw new Error('当前游戏协议无法调整已排队的任务');
  if (submit && position.remove.length) await confirmFactoryProductionBeforeHarvest(client, protocol, buildingId, { player, enabled });
  const { available, water:raw } = await readOrderReservedStock(client, protocol, config, { player, settings, enabled });
  const water = normalize(raw), live = factoryProductionSnapshot(water, buildingId), now = clock(client);
  if (!live || stamp(live.queue) !== stamp(trace.queue) || nativeOn(water, live.building, now) || !enabled()) throw stale();
  const recipes = rows(config, 'BuildingProduceCfg');
  const held = new Map();
  for (const e of Object.values(entries)) {
    for (const job of e.jobs.filter(j => j.pinned)) {
      for (const [id,n] of recipes.find(r => r.itemId === job.id)?.costItem ?? []) add(held,id,n * (job.quantity ?? 1));
    }
  }
  const products = [];
  for (const r of recipes) {
    if (r.buildType !== trace.type || !Number.isSafeInteger(r.unlockLevel) || r.unlockLevel > live.building.level
      || !factoryRecipeAvailability(r,client.festivals,now).allowed) continue;
    const costs = factoryRecipeCosts(r);
    if (!costs) continue;
    let max = Infinity;
    for (const { id,num } of costs) {
      const free = (available.get(id) ?? 0) - (resourceReserve(settings,id) || 0) - (held.get(id) ?? 0);
      max = Math.min(max, Math.floor(free / num));
    }
    products.push({ id:r.itemId, name:displayMaterial(config,r.itemId), max:costs.length ? Math.max(0,max) : null });
  }
  if (!submit) return { products, count:position.count, reordersQueue:position.remove.length > 0 };
  const product = products.find(p => p.id === target.productId), n = target.quantity;
  if (!product || !Number.isSafeInteger(n) || n < 1) throw new Error('请选择已解锁的产物，并输入有效的正整数件数');
  if (product.max !== null && n > product.max) throw new Error('按当前可用原料最多可插入 ' + product.max + ' 件');
  const inserted = { id:product.id, quantity:n, pinned:true, ...(target.status === 'gap' ? { at:target.from } : {}) };
  const restored = position.remove.toReversed().map(q => ({ id:q.id, pinned:true }));
  const jobs = [...position.before, inserted, ...restored, ...position.after];
  const rewrite = position.remove.length ? { remove:position.remove, expected:trace.queue, restored:[], rollback:previous?.jobs ?? [] } : {};
  saveFactoryInsertion(player, buildingId, previous, { jobs, ...rewrite }, entries);
  return { label:'已插入' + product.name + ' ×' + n };
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
    if (!e.remove?.length && !e.flight && e.jobs[0]?.at > clock(client)) return;
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
          expected:e.expected.filter(q => (q.idx ?? 0) !== idx), restored:[{ id, pinned:true }, ...e.restored] } : { jobs:e.jobs });
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
    const alternativeStock = isFull(e.jobs[0].id) ? await readInsertionAlternativeStock(client, protocol, config, e, ctx, isFull) : null;
    if (!enabled()) return;
    const free = item => ((alternativeStock ?? stock).get(item) ?? 0) - resourceReserve(ctx.settings,item);
    const now = clock(client);
    const index = nextInsertionIndex(e.jobs, now, isFull, id =>
      insertionRecipeReady(recipes.find(r => r.itemId === id), live.building.level, client.festivals, now, free));
    if (index < 0) { note(displayMaterial(config, e.jobs[0].id) + '已满仓，消耗后优先补产'); return; }
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
