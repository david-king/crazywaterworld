import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { planWorld, displayBuilding } from './world.mjs';
import { insertionRecipeReady } from './production-eligibility.mjs';
import { createProductionTiming, nextFactoryLane, commitFactoryLane } from './production-timing.mjs';
import { resourceReserve } from './automation-policy.mjs';
import { consumeInsertionUnit, insertionYieldsToProduction, nextInsertionIndex } from './factory-insertion-queue.mjs';

const hour = 3600;
const day = 24 * hour;
const add = (map, id, n) => map.set(id, (map.get(id) ?? 0) + n);
const rows = (config, name) => config?.tables?.[name]?.data ?? [];

// A job crossing an hour appears in both hours, but counts as finished only once.
// Overlapping parallel lanes contribute only once to a factory's running time.
function factoryScheduleRecorder(startAt, name) {
  const hours = Array.from({ length: 24 }, () => ({ intervals: [], products: new Map() }));
  const runs = [];
  const lastByLane = new Map();
  function record(id, start, end, status, index) {
    const lo = Math.max(start, startAt),
      hi = Math.min(end, startAt + day);
    if (!(hi > lo)) return;
    const existing = status !== 'planned';
    const last = lastByLane.get(index);
    if (last && last.id === id && last.status === status && last.to === lo) {
      last.to = hi;
      last.quantity++;
      last.continues = end > startAt + day;
    } else {
      const run = { id, name: name(id), from: lo, to: hi, quantity: 1, lane: index + 1, status, existing, continues: end > startAt + day };
      runs.push(run);
      lastByLane.set(index, run);
    }
    for (let i = Math.floor((lo - startAt) / hour); i < Math.ceil((hi - startAt) / hour); i++) {
      const bucket = hours[i],
        from = Math.max(lo, startAt + i * hour),
        to = Math.min(hi, startAt + (i + 1) * hour);
      bucket.intervals.push([from, to]);
      const key = JSON.stringify([id, status]);
      const product = bucket.products.get(key) ?? {
        id,
        name: name(id),
        status,
        existing,
        from,
        to,
        completed: 0,
        continues: false,
      };
      product.from = Math.min(product.from, from);
      product.to = Math.max(product.to, to);
      product.continues ||= end > startAt + day;
      if (end === to) product.completed++;
      bucket.products.set(key, product);
    }
  }
  function summarize() {
    return hours.map(({ intervals, products }) => {
      let last = 0,
        busySeconds = 0;
      for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
        busySeconds += Math.max(0, to - Math.max(last, from));
        last = Math.max(last, to);
      }
      return { busySeconds, products: [...products.values()].sort((a, b) => a.from - b.from) };
    });
  }
  return { record, summarize, runs };
}

/** Read-only event simulation using the same per-account dispatcher as the loop. */
export async function forecastProductionDay(
  snapshot,
  config,
  settings,
  orders,
  { pendingMaterials = [], checkCurrent = () => {}, insertions = {}, anchors } = {},
) {
  const startAt = snapshot.serverNow,
    endAt = startAt + day;
  const result = {
    startAt,
    endAt,
    nativeFarming: !!snapshot.autoFarming,
    strategy: settings.factory.strategy ?? 'smart',
    partial: snapshot.missingReads.length > 0 || pendingMaterials.length > 0,
    factories: [],
    completions: [],
  };
  if (!(startAt > 0) || !(snapshot.stockCap > 0) || !(snapshot.inventoryKnown ?? snapshot.complete)) {
    return { ...result, unavailable: '需要服务器时间、当前库存和仓容才能推演。' };
  }
  if (
    snapshot.missingReads.some(r =>
      ['OnWaterRequest', 'productionRecipes', 'BuildingProduceParamCfg'].includes(r.request),
    )
  ) {
    return { ...result, unavailable: '建筑、配方或生产位数据尚未读全，请刷新后再推演。' };
  }
  const name = id => config?.materialName?.(id) ?? id;
  const stock = new Map(snapshot.inventory.map(r => [r.id, r.num]));
  const held = new Map(),
    pending = new Set(pendingMaterials.flatMap(r => [...(r.scope ?? [])]));
  const have = id => (pending.has(id) ? 0 : Math.max(0, (stock.get(id) ?? 0) - (held.get(id) ?? 0)));
  const timingAt = now => createProductionTiming({ config, ...snapshot.timing, serverNow: now });
  const timing = timingAt(startAt);
  const collectionBlocked = new Set(settings.factory.blockedCollectionTypes);
  const byId = new Map(snapshot.buildings.map(b => [b.id, b]));
  const factories = snapshot.factories.map(f => {
    const original = byId.get(f.id) ?? {};
    const building = {
      ...original,
      buildingId: f.id,
      type: f.type,
      level: f.level,
      product: [],
      factory: {
        autoProductId: f.nativeAutoProductId,
        finishedProducts: f.finished.map(r => ({ ...r })),
        factoryQ: f.queue.map(q => ({ idx: q.index, productId: q.productId, finishTime: q.finishTime })),
      },
    };
    const queue = timing.factoryQueue(building);
    const entry = insertions[f.id];
    const trace = anchors && { type:f.type, queue: building.factory.factoryQ.slice(), units: [], revision: entry?.revision };
    if (trace) anchors.set(f.id, trace);
    const chart = factoryScheduleRecorder(startAt, name);
    const jobs = queue.jobs
      .filter(j => j.basis.source === 'server' || !queue.missing.length)
      .map(j => {
        // Only an unexpired game timer confirms that this entry has started.
        const status = j.job.finishTime > startAt ? 'running' : 'queued';
        if (j.finish > j.start) trace?.units.push({ id: j.job.productId, idx: j.job.idx, from: j.start, to: j.finish, lane: j.index + 1, status });
        chart.record(j.job.productId, j.start, j.finish, status, j.index);
        return { id: j.job.productId, idx: j.job.idx, start: j.start, end: j.finish };
      });
    const unknown = queue.missing.length
      ? '队列时间待确认'
      : f.nativeAutoActive
        ? '游戏原生接管，后续选品待定'
        : null;
    return {
      building,
      jobs,
      finishes: queue.finishes,
      chart,
      trace,
      manual: entry?.jobs.map((job, sourceIndex) => ({ ...job, sourceIndex })) ?? [],
      insertNote: entry?.note,
      editing: !!(entry?.remove?.length || entry?.flight || entry?.stagedSupplies),
      unknown,
      capacity: f.capacity,
      collect:
        settings.loop.world && settings.factory.enabled && settings.factory.gain && !collectionBlocked.has(f.type),
      disabled: !f.enabled || !settings.factory.produce || !settings.loop.world,
      serial: Math.max(0, ...f.queue.map(q => q.index ?? 0)),
    };
  });
  const cropRows = rows(config, 'FarmlandPlantCfg'),
    crops = new Map(cropRows.map(c => [c.id, c]));
  const farms = snapshot.farms.map(f => ({
    ...byId.get(f.id),
    buildingId: f.id,
    type: '农田',
    level: f.level,
    product: [],
    farm: f.productId ? { productId: f.productId, ripeTime: f.ripeTime } : null,
    yield: f.num ?? crops.get(f.productId)?.produceNum ?? 0,
    manual: insertions[f.id]?.jobs.map(job => ({...job})) ?? [],
    confirmingPlant: !!insertions[f.id]?.flight,
  }));
  const recipes = new Map(rows(config, 'BuildingProduceCfg').map(r => [r.itemId, r]));
  const remainder = orders.filter(o => !o.skipped);
  const active = new Map(factories.filter(f => !f.unknown && !f.disabled).map(f => [f.building.buildingId, f]));
  const manualFacilities = new Map(factories.filter(f => !f.unknown && !f.editing).map(f => [f.building.buildingId, f]));
  const factoryBuildings = factories.map(f => f.building);
  // Count all known incoming products, including those from native-managed factories.
  // Their future choices remain unknown and cannot be used to pay for new inputs.
  const dispatchSettings = {
    ...settings,
    factory: {
      ...settings.factory,
      disabledTypes: [
        ...settings.factory.disabledTypes,
        ...factoryBuildings.filter(b => !active.has(b.buildingId)).map(b => b.buildingId),
      ],
    },
  };
  const slots = snapshot.factories[0]?.capacity ?? 0;
  const waitHistory = new Map(),
    occupied = new Map();
  const stockNeeds = {
    source: 'factory',
    requirements: [
      ...new Set(snapshot.recipes.filter(r => r.available && r.facilityType !== '农田').map(r => r.productId)),
    ].map(id => ({ id, num: Math.min(settings.factory.keepStock, snapshot.stockCap) })),
  };
  const survey = {
    buildings: [...factoryBuildings, ...farms],
    factories: factoryBuildings,
    player: snapshot.player,
    productionTiming: snapshot.timing,
    stock,
    have,
    warehouseCount: id => stock.get(id) ?? 0,
    stockCap: snapshot.stockCap,
    factorySlots: slots,
    orders: [],
    weekOrder: new Map(),
    orderOfTheDay: {},
    festivals: snapshot.raw?.festivals,
    autoFarming: snapshot.autoFarming,
    population: snapshot.population?.current ?? 0,
    maxPopulation: snapshot.population?.max ?? 0,
    futurePopulation: snapshot.population?.future ?? 0,
  };
  let now = startAt,
    nextYield = performance.now() + 24;
  function processOrders() {
    const reserved = new Map();
    for (const order of [...remainder]) {
      const expiry = order.metadata?.refreshAt;
      if ((expiry && now >= expiry) || (order.deadline && now > order.deadline)) {
        remainder.splice(remainder.indexOf(order), 1);
        continue;
      }
      const free = id => Math.max(0, have(id) - (resourceReserve(settings, id) || 0) - (reserved.get(id) ?? 0));
      if (order.requirements.every(r => free(r.id) >= r.num)) {
        const consume =
          order.kind === 'order' &&
          (order.source === 'merchant' ? settings.schedule?.weekOrderSubmit : order.metadata?.enabled);
        for (const { id, num } of order.requirements) consume ? add(stock, id, -num) : add(held, id, num);
        result.completions.push({ id: order.id, at: now });
        remainder.splice(remainder.indexOf(order), 1);
      } else for (const { id, num } of order.requirements) add(reserved, id, Math.min(num, free(id)));
    }
  }
  for (;;) {
    if (performance.now() >= nextYield) {
      await yieldToLoop();
      checkCurrent();
      nextYield = performance.now() + 24;
    }
    for (const f of factories) {
      const factory = f.building.factory;
      for (const job of f.jobs.filter(j => j.end <= now)) {
        const item = factory.finishedProducts.find(r => r.id === job.id);
        if (item) item.num++;
        else factory.finishedProducts.push({ id: job.id, num: 1 });
      }
      f.jobs = f.jobs.filter(j => j.end > now);
      factory.factoryQ = f.jobs.map(j => ({
        idx: j.idx,
        productId: j.id,
        ...(j.start <= now ? { finishTime: j.end } : {}),
      }));
      if (f.collect) {
        for (const item of factory.finishedProducts) add(stock, item.id, item.num);
        factory.finishedProducts = [];
      }
    }
    const canHarvest =
      settings.loop.world && settings.farm.enabled && settings.farm.harvest && !collectionBlocked.has('农田');
    if (canHarvest)
      for (const plot of farms) {
        if (!plot.farm?.ripeTime || plot.farm.ripeTime > now) continue;
        const id = plot.farm.productId;
        add(stock, id, Math.max(0, Math.min(plot.yield, snapshot.stockCap * 5 - (stock.get(id) ?? 0))));
        plot.farm = null;
      }
    processOrders();
    if (now === endAt) break;
    survey.now = survey.serverNow = now;
    survey.cargoOrders = remainder.filter(o => o.source === 'cargo');
    survey.weekOrder = new Map();
    for (const order of remainder.filter(o => o.source === 'merchant')) {
      for (const item of order.requirements) add(survey.weekOrder, item.id, item.num);
    }
    const extraDemand = remainder.filter(o => !['merchant', 'cargo'].includes(o.source)).concat(stockNeeds);
    survey.factoryInsertions = Object.fromEntries(factories.filter(f => f.manual.length || f.editing)
      .map(f => [f.building.buildingId, { jobs:f.manual, flight:f.editing }]));
    for (const plot of farms) if (plot.manual.length) survey.factoryInsertions[plot.buildingId] = {jobs:plot.manual};
    const plan = planWorld(survey, {
      config,
      settings: dispatchSettings,
      extraDemand,
      factoryWaitHistory: waitHistory,
      enabled: kind => settings.loop.world && ['startProduce', 'gainFactory', 'farm'].includes(kind),
    });
    occupied.clear();
    for (const f of factories) {
      for (const j of f.jobs) add(occupied, j.id, 1);
      for (const r of f.building.factory.finishedProducts) add(occupied, r.id, r.num);
    }
    const liveTiming = timingAt(now);
    const isFull = id => (stock.get(id) ?? 0) + (occupied.get(id) ?? 0) >= snapshot.stockCap;
    const free = id => have(id) - (resourceReserve(settings,id) || 0);
    const ready = (factory, id) => insertionRecipeReady(recipes.get(id), factory.building.level, survey.festivals, now, free);
    function* productionSteps() {
      for (const plot of farms) {
        const job = plot.manual[0], crop = crops.get(job?.id);
        if (!crop || plot.farm || plot.confirmingPlant || snapshot.autoFarming || (stock.get(job.id) ?? 0) >= snapshot.stockCap * 5) continue;
        const [id,num] = crop.material;
        yield {request:'FarmPlantRequest', body:{args:[{buildingId:plot.buildingId,productId:job.id}]}, costs:[{id,num}], job};
      }
      for (const [buildingId, f] of manualFacilities) {
        while (f.jobs.length < f.capacity && f.manual.length) {
          const index = nextInsertionIndex(f.manual, now, isFull, id => ready(f,id)), job = f.manual[index];
          if (!job || !ready(f,job.id)) break;
          const queued = f.jobs.length;
          yield { job, index, request:'StartFactoryProduceRequest', body:{ buildingId, productId:job.id },
            costs:recipes.get(job.id).costItem.map(([id, num]) => ({ id, num })) };
          if (f.jobs.length === queued) break;
        }
      }
      yield* plan.actions;
    }
    let manualAdvanced = false;
    for (const step of productionSteps()) {
      if (step.request !== 'StartFactoryProduceRequest' && step.request !== 'FarmPlantRequest') continue;
      if (step.costs.some(r => have(r.id) - (resourceReserve(settings, r.id) || 0) < r.num)) continue;
      if (step.request === 'FarmPlantRequest') {
        const { buildingId, productId } = step.body.args[0],
          plot = farms.find(b => b.buildingId === buildingId),
          crop = crops.get(productId);
        const seconds = liveTiming.farm(crop).seconds;
        if (!plot || plot.farm || !(seconds > 0) || snapshot.autoFarming) continue;
        plot.farm = { productId, ripeTime: now + seconds };
        plot.yield = crop.produceNum;
        if (step.job) consumeInsertionUnit(plot.manual, 0);
      } else {
        const { buildingId, productId } = step.body,
          f = (step.job ? manualFacilities : active).get(buildingId);
        if (
          !f || f.jobs.length >= f.capacity || isFull(productId) ||
          (!step.job && !insertionYieldsToProduction(survey.factoryInsertions[buildingId], now, isFull, id => ready(f,id)))
        )
          continue;
        const duration = liveTiming.factory(recipes.get(productId), { building: f.building }).seconds;
        if (!(duration > 0)) continue;
        const lanes = liveTiming.lanes(f.building);
        const finishes = f.finishes.slice(0, lanes.count).map(t => Math.max(now, t));
        const lane = nextFactoryLane(finishes, lanes.expiresAt, duration);
        commitFactoryLane(finishes, lane);
        f.finishes = finishes;
        f.jobs.push({ id: productId, idx: ++f.serial, start: lane.start, end: lane.finish });
        f.chart.record(productId, lane.start, lane.finish, 'planned', lane.index);
        f.trace?.units.push({ id: productId, lane: lane.index + 1, from: lane.start, to: lane.finish,
          at: now, status: 'planned', manual: !!step.job, sourceIndex:step.job?.sourceIndex });
        if (step.job) consumeInsertionUnit(f.manual, step.index);
        if (step.job || f.manual.length) manualAdvanced = true;
        add(occupied, productId, 1);
      }
      for (const r of step.costs) add(stock, r.id, -r.num);
    }
    // Wake on a real change, or while the dispatcher is deliberately holding an idle slot.
    const revisit = settings.factory.checkEverySeconds ?? 30;
    const events = [
      ...factories.flatMap(f => f.jobs.map(j => j.end)),
      ...factories.map(f => f.manual.find(job => job.at > now)?.at),
      ...farms.map(f => f.farm?.ripeTime),
      ...(survey.festivals ?? []).flatMap(event =>
        (event.festivalData?.limitTimeItem ?? []).flatMap(w => [w.openTime, w.closeTime + 1]),
      ),
      ...remainder.map(o => o.metadata?.refreshAt),
      ...remainder.map(o => o.deadline && o.deadline + 1),
    ];
    if (manualAdvanced) events.push(now + 1);
    if ([...waitHistory.values()].some(t => now - t < 3 * revisit)) events.push(now + revisit);
    now = Math.min(endAt, ...events.filter(t => t > now));
  }
  const upstream = new Map();
  for (const [id, entry] of Object.entries(insertions)) {
    for (const job of entry.jobs) {
      if (!job.supplyTarget || job.supplyTarget === id) continue;
      const batches = upstream.get(job.supplyTarget) ?? [];
      batches.push({factory:displayBuilding(config, byId.get(id) ?? {buildingId:id}), name:name(job.id),
        quantity:job.quantity ?? 1, crop:!!job.crop});
      upstream.set(job.supplyTarget,batches);
    }
  }
  result.factories = factories.map(f => ({
    id: f.building.buildingId,
    name: displayBuilding(config, f.building),
    unknown: f.unknown,
    disabled: f.disabled,
    editing: f.editing,
    insertNote: f.insertNote || (f.editing ? '正在核对游戏队列，完成后可继续插单' : undefined),
    upstream: upstream.get(f.building.buildingId) ?? [],
    pendingInsertions: (insertions[f.building.buildingId]?.jobs ?? [])
      .filter(job => job.pinned)
      .map(job => ({ id: job.id, name: name(job.id), quantity: job.quantity ?? 1,
        ...(job.supplyFor ? {supplyFor:name(job.supplyFor)} : {}) })),
    hours: f.chart.summarize(),
    runs: f.chart.runs.sort((a, b) => a.from - b.from || a.lane - b.lane),
  }));
  return result;
}
