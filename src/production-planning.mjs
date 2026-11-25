import { optimizeProductionSchedule } from './production-optimizer.mjs';
import { planStockRefills, scheduleRankedStock } from './production-restock.mjs';
import { nativeMaterialReceipts, simulateNativeFactoryStarts } from './factory-native-simulation.mjs';
import { refillGoal, snapshotRefills } from './factory-refill.mjs';
import { createProductionTiming } from './production-timing.mjs';
import { productionDemandConsumes, resourceReserve, worldPreferenceEnabled } from './automation-policy.mjs';
import { activityProductionEnabled } from './activity-automation.mjs';
import { createProductionEligibility } from './production-eligibility.mjs';
import { cropRelatedMaterialIds, residentMaterialRule, residentMaterialReasons } from './resident-materials.mjs';
import { displayBuilding } from './world.mjs';

const rows = (config, key) => config?.tables?.[key]?.data ?? [];
const sourceNames = { resident: '居民订单', merchant: '不差钱商人', cargo: '贸易港', guildRecruit: '联盟募兵',
  heroRaid: '超凡英雄', refugee: '难民订单', building: '建筑备料', museum: '博物馆', guildShip: '联盟商船',
  petAdvance: '海兽进阶', petFeed: '海兽投喂', factory: '常规备货' };
const timingNames = { observed: '会话实测', server: '服务器完成时刻', 'effects-estimate': '加成公式估算', 'config-estimate': '配置耗时估算' };
const unique = values => [...new Set(values)];

function describeProductionBlocks(blocks, name) {
  const labels = {
    '所需工厂等级未达到或已禁用': '工厂等级不足或已停用',
    '订单已超过硬截止时间': '订单已过期',
    '单个订单齐套数量超过该产物可达仓存上限': '仓库放不下这项需求的全部材料',
    '需保留的订单产物总量超过可达仓存上限': '仓库放不下所有订单要预留的材料',
    '外部原料不足，快照中没有确定到货': '原料不足，到货时间未知',
  };
  const groups = new Map();
  for (const block of blocks) {
    const label = labels[block.reason] ?? block.reason;
    if (!groups.has(label)) groups.set(label, new Set());
    if (block.itemId) groups.get(label).add(name(block.itemId) + (block.missingQuantity > 0 && block.kind ? '还差 ' + block.missingQuantity + ' 件' : ''));
  }
  return [...groups].map(([label, items]) => items.size ? label + '（' + [...items].join('、') + '）' : label).join('；');
}

function dependencyItems(orders, recipes, products = []) {
  const byItem = new Map(recipes.map(recipe => [recipe.productId, recipe]));
  const found = new Set();
  const visit = id => {
    if (found.has(id)) return;
    found.add(id);
    for (const input of byItem.get(id)?.costs ?? []) visit(input.id);
  };
  for (const order of orders) for (const item of order.requirements) visit(item.id);
  for (const id of products) visit(id);
  return found;
}

export function materialTreeRecipes(orders, recipes, products, name) {
  const materials = dependencyItems(orders, recipes, products);
  return recipes.filter(recipe => materials.has(recipe.productId) && recipe.output > 0 && recipe.costs?.length)
    .map(recipe => ({ productId: recipe.productId, output: recipe.output,
      inputs: recipe.costs.map(item => ({ ...item, name: name(item.id) })) }));
}

/** Convert a complete read into a fixed scheduling model without changing it. */
export function buildProductionModel(snapshot, config, settings, { pendingMaterials = [] } = {}) {
  const now = snapshot.serverNow;
  const relative = time => Math.max(0, (time ?? now) - now);
  const timing = createProductionTiming({ config, ...snapshot.timing, serverNow: now });
  const prioritySources = unique(settings.factory?.demandPriority ?? []);
  const orderRows = snapshot.orders.filter(order => activityProductionEnabled(settings, order.source)).filter(order => order.kind === 'order'
    || order.kind === 'consumption' && prioritySources.includes(order.source)
      && (order.source !== 'building' || settings.building?.supply && worldPreferenceEnabled(settings, 'buildSupply')))
    .map(order => ({ ...order, priority: prioritySources.includes(order.source)
      ? prioritySources.indexOf(order.source) : prioritySources.length }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const priorityLabels = new Map([...new Set(orderRows.map(order => order.priority))].map(priority => [priority,
    unique(orderRows.filter(order => order.priority === priority).map(order => sourceNames[order.source] || order.source)).join('、')]));
  const stockPriority = settings.factory?.demandFirst ? prioritySources.indexOf('factory') : -1;
  if (stockPriority >= 0) priorityLabels.set(stockPriority, '工厂补料');
  const missingReads = snapshot.missingReads.map(read => read.request + ' · ' + read.reason);
  const notes = [];
  const timingByJob = new Map();
  const machines = [], incoming = [], fixedTimeline = [];
  let capacityEstimated = false;
  const stockCaps = {}, machineNames = new Map();
  const inventory = snapshot.inventory.map(item => ({ itemId: item.id,
    quantity: Math.max(0, item.num - (resourceReserve(settings, item.id) || 0)) }));
  const factoryConfigs = new Map(rows(config, 'BuildingProduceCfg').map(recipe => [recipe.itemId, recipe]));
  const cropConfigs = new Map(rows(config, 'FarmlandPlantCfg').map(recipe => [recipe.id, recipe]));
  const cropRelatedIds = cropRelatedMaterialIds(config, cropConfigs.keys());
  const factoryMachines = new Map();
  const uncertainSupply = new Map();
  const nativeReceipts = worldPreferenceEnabled(settings, 'gainFactory');
  const blockedCollection = new Set(settings.factory?.blockedCollectionTypes ?? []);
  const addIncoming = (id, itemId, quantity, finishTime) => {
    if (quantity > 0) incoming.push({ id, itemId, quantity, readyAt: relative(finishTime) });
  };
  const addFixed = (machine, job, start, finish, basis, collect = true) => {
    if (collect) addIncoming(job.id, job.productId, job.num, finish);
    fixedTimeline.push({ kind: 'existing', machineId: machine.id, itemId: job.productId, quantity: job.num,
      startAt: start, finishAt: finish, timingLabel: timingNames[basis.source] ?? basis.source, estimated: basis.estimated });
  };
  for (const factory of snapshot.factories) {
    const building = snapshot.buildings.find(row => row.id === factory.id);
    const name = displayBuilding(config, { buildingId: factory.id, type: factory.type });
    const { lanes, finishes, jobs, missing } = timing.factoryQueue(building, factory.queue);
    // Only take confirmed timers from a native queue if its remaining order is uncertain.
    // An unknown handoff there does not change availability at other facilities.
    (factory.nativeAutoActive ? notes : missingReads).push(...missing.map(reason => name + reason));
    capacityEstimated ||= lanes.estimated || lanes.count > 1 && lanes.expiresAt !== null;
    const facilityMachines = Array.from({ length: lanes.count }, (_, index) => ({
      id: factory.id + ':' + (index + 1), availableAt: relative(finishes[index]),
      ...(index > 0 && lanes.expiresAt !== null ? { availableUntil: relative(lanes.expiresAt) } : {}),
    }));
    for (const [index, machine] of facilityMachines.entries()) {
      machineNames.set(machine.id, name + (facilityMachines.length > 1 ? ' 第' + (index + 1) + '生产位' : ''));
    }
    factoryMachines.set(factory.id, facilityMachines);
    const collect = !factory.nativeAutoActive || (nativeReceipts && !blockedCollection.has(factory.type));
    for (const { job, index, start, finish, basis } of jobs) {
      if (factory.nativeAutoActive && missing.length && basis.source !== 'server') continue;
      addFixed(facilityMachines[index], job, start, finish, basis, collect);
    }
    machines.push(...facilityMachines);
    if (collect) for (const item of factory.finished) addIncoming(factory.id + ':finished:' + item.id, item.id, item.num, now);
    if (lanes.estimated || lanes.expiresAt !== null) notes.push(name + ' · ' + lanes.reasons.join('，'));
  }
  const collectNativeCrop = worldPreferenceEnabled(settings, 'farm') && settings.farm?.harvest
    && !settings.factory?.blockedCollectionTypes?.includes('农田');
  const harvestReason = collectNativeCrop ? '等待原生农田下一茬' : '自动收获已关闭，原生农田来料时间待确认';
  for (const farm of snapshot.farms) {
    const machine = { id: farm.id, availableAt: Math.max(relative(farm.upgradingUntil), relative(farm.ripeTime)) };
    machines.push(machine);
    machineNames.set(machine.id, displayBuilding(config, { buildingId: farm.id, type: '农田' }));
    if (farm.productId && farm.ripeTime) addFixed(machine,
      { id: farm.id + ':crop', productId: farm.productId, num: farm.num }, now, Math.max(now, farm.ripeTime),
      { source: 'server', estimated: false }, !snapshot.autoFarming || collectNativeCrop);
  }
  if (snapshot.autoFarming) notes.push(collectNativeCrop ? '原生农田计入在田作物的已知收成，下一茬待游戏确定。' : harvestReason);
  const localFactories = new Map();
  for (const recipe of snapshot.recipes) {
    if (recipe.facilityType === '农田') {
      if (snapshot.autoFarming) uncertainSupply.set(recipe.productId, { kind: 'future-harvest', reason: harvestReason });
      continue;
    }
    const eligible = snapshot.factories.filter(factory => factory.enabled && factory.type === recipe.facilityType
      && factory.level >= recipe.unlockLevel);
    const local = eligible.filter(factory => !factory.nativeAutoActive && settings.factory?.produce !== false);
    localFactories.set(recipe.productId, local);
    const managed = eligible.filter(factory => factory.nativeAutoActive);
    if (recipe.available && !local.length && managed.length) {
      const facility = managed.length === 1 ? displayBuilding(config, { buildingId: managed[0].id, type: recipe.facilityType })
        : managed.length + ' 座' + recipe.facilityType;
      uncertainSupply.set(recipe.productId, { kind: 'native-factory', reason: nativeReceipts && !blockedCollection.has(recipe.facilityType)
        ? '等待' + facility + '确认后续产出' : facility + '的自动收取已关闭，入库时间待确认' });
    }
  }
  if (!Number.isSafeInteger(snapshot.stockCap) || snapshot.stockCap <= 0) missingReads.push('加工品存量上限未确认');
  const incomingStock = new Map();
  for (const item of incoming) incomingStock.set(item.itemId, (incomingStock.get(item.itemId) ?? 0) + item.quantity);
  const eligibility = createProductionEligibility(config, {
    buildings: snapshot.buildings.map(building => ({ ...building,
      ...snapshot.factories.find(factory => factory.id === building.id) })),
    settings, stock: new Map(inventory.map(item => [item.itemId, item.quantity])), incoming: incomingStock,
    uncertainSupply,
  });
  const skippedOrders = new Map();
  const waitingSupply = new Map();
  const onHand = new Map(inventory.map(item => [item.itemId, item.quantity]));
  const available = id => onHand.get(id) ?? 0;
  const activeOrderRows = orderRows.filter(order => {
    if (order.metadata?.recruitBlock) {
      skippedOrders.set(order.id, [order.metadata.recruitBlock]);
      return false;
    }
    const rule = order.source === 'resident' && residentMaterialRule(settings.resident, order.requirements, cropRelatedIds,
      (snapshot.inventoryKnown ?? snapshot.complete) ? available : null);
    if (rule) {
      skippedOrders.set(order.id, [{ reason: residentMaterialReasons[rule] }]);
      return false;
    }
    const blocked = snapshot.complete ? eligibility(order.requirements, { reserve: true }) : [];
    if (blocked.length) {
      const waiting = blocked.every(block => block.kind === 'future-harvest' || block.kind === 'native-factory');
      (waiting ? waitingSupply : skippedOrders).set(order.id, blocked);
    } else if (settings.resident?.skipProduction &&
      (order.source !== 'merchant' || order.requirements.every(item => available(item.id) >= item.num))) {
      for (const { id, num } of order.requirements) onHand.set(id, Math.max(0, available(id) - num));
    }
    return blocked.length === 0;
  });
  const needed = dependencyItems(activeOrderRows, snapshot.recipes);
  const recipes = snapshot.recipes.map(recipe => {
    const farm = recipe.facilityType === '农田';
    const targets = farm
      ? snapshot.farms.filter(plot => !snapshot.autoFarming && plot.enabled && (settings.farm?.customPlant
        ? settings.farm.crops.some(crop => crop.id === recipe.productId && crop.target > 0)
        : settings.farm?.autoPlant !== false)).map(plot => machines.find(machine => machine.id === plot.id))
      : localFactories.get(recipe.productId).flatMap(factory => factoryMachines.get(factory.id));
    const durationByMachine = {};
    for (const machine of targets) {
      const building = snapshot.buildings.find(row => row.id === machine.id.replace(/:\d+$/, ''));
      const duration = farm ? timing.farm(cropConfigs.get(recipe.productId)) : timing.factory(factoryConfigs.get(recipe.productId), { building });
      durationByMachine[machine.id] = duration.seconds;
      timingByJob.set(machine.id + '\0' + recipe.productId, duration);
    }
    const durations = Object.values(durationByMachine).filter(value => value > 0);
    stockCaps[recipe.productId] = snapshot.stockCap * (farm ? 5 : 1);
    if (farm && !snapshot.autoFarming && settings.farm?.customPlant) {
      stockCaps[recipe.productId] = Math.min(stockCaps[recipe.productId],
        settings.farm.crops.find(crop => crop.id === recipe.productId)?.target ?? 0);
    }
    const original = factoryConfigs.get(recipe.productId);
    if (needed.has(recipe.productId) && (original?.limitType || original?.buildType === '活动工厂')
      && !Array.isArray(snapshot.raw?.festivals)) missingReads.push(recipe.productId + '活动配方开放状态未同步');
    const windows = original?.limitType ? (snapshot.raw?.festivals ?? []).flatMap(event => event.festivalData?.limitTimeItem ?? [])
      .filter(window => window.item === original.limitType && window.openTime <= now && window.closeTime >= now) : [];
    return { id: recipe.id, itemId: recipe.productId, outputQuantity: recipe.output,
      durationSeconds: durations.length ? Math.min(...durations) : recipe.durationSeconds, durationByMachine,
      inputs: (recipe.costs ?? []).map(item => ({ itemId: item.id, quantity: item.num })), machineIds: targets.map(machine => machine.id),
      enabled: recipe.available && targets.length > 0, blockedReason: recipe.reason || '当前设置下没有可用生产设施',
      ...(windows.length ? { availableUntil: relative(Math.max(...windows.map(window => window.closeTime))) } : {}),
    };
  });
  // The search may produce extra downstream items to free capped storage.
  // Their inputs must respect the same unresolved-spend barriers as the BOM.
  const candidateMaterials = new Set([...needed, ...recipes.filter(recipe => recipe.enabled)
    .flatMap(recipe => recipe.inputs.map(item => item.itemId))]);
  for (const pending of pendingMaterials) {
    if ([...(pending.scope ?? [])].some(id => candidateMaterials.has(id))) missingReads.push('订单或候选配方材料存在待确认扣款 · ' + pending.label);
  }
  const orders = activeOrderRows.map(order => ({ id: order.id, source: order.source, priority: order.priority,
    requirements: order.requirements.map(item => ({ itemId: item.id, quantity: item.num })),
    consumeOnCompletion: productionDemandConsumes(order, settings),
    populationGain: order.metadata?.populationGain ?? 0,
    ...(order.deadline ? { deadline: order.deadline - now } : {}),
  }));
  return {
    input: { snapshotTime: now, complete: snapshot.complete && !missingReads.length, missingReads: unique(missingReads),
      inventory, orders, recipes, machines, incoming, stockCaps, stockCapMode: 'start-projected',
      populationRoom: Math.max(0, (snapshot.population?.max ?? 0) - (snapshot.population?.future ?? 0)) },
    orderRows, activeOrderRows, skippedOrders, waitingSupply, timingByJob, machineNames, fixedTimeline, notes, capacityEstimated, priorityLabels, stockPriority,
  };
}

/** Optimize completion by configured priority, sharing materials and capacity. */
export function planProduction(snapshot, config, settings, options = {}) {
  const model = buildProductionModel(snapshot, config, settings, options);
  const waitingLabels = new Map();
  let waitingHarvestCount = 0;
  for (const [id, blocks] of model.waitingSupply) {
    const harvest = blocks.some(b => b.kind === 'future-harvest');
    const factory = blocks.some(b => b.kind === 'native-factory');
    if (harvest) waitingHarvestCount++;
    waitingLabels.set(id, harvest && factory ? '等待原生来料' : factory ? '等待原生工厂' : '等待农田来料');
  }
  const waitingSupplyCount = waitingLabels.size;
  const {active:refillsInProgress} = snapshotRefills(snapshot, config, settings);
  const refillNote = refillsInProgress.map(rule => {
    const factory = snapshot.factories.find(f => f.id === rule.buildingId);
    return displayBuilding(config, {...factory, buildingId:factory.id}) + '优先补' + (config?.materialName?.(rule.productId) || rule.productId)
      + '至 ' + refillGoal(rule, snapshot.stockCap) + ' 件';
  }).join('，');
  if (settings.factory?.strategy === 'nativeSimulation') {
    const name = id => config?.materialName?.(id) || id;
    const now = snapshot.serverNow;
    const eligible = new Set(snapshot.factories.filter(f => f.enabled && !f.nativeAutoActive).map(f => f.id));
    const unlocked = new Set(snapshot.recipes.filter(r => r.available).map(r => r.productId));
    const stock = new Map(snapshot.inventory.map(item => [item.id, item.num]));
    const warehouse = new Map(stock);
    const receipts = nativeMaterialReceipts(snapshot.buildings, b => worldPreferenceEnabled(settings, 'gainFactory')
      && !settings.factory.blockedCollectionTypes?.includes(b.type));
    for (const f of snapshot.factories) {
      for (const item of [...f.finished, ...f.queue.map(job => ({ id: job.productId, num: 1 }))]) {
        stock.set(item.id, (stock.get(item.id) ?? 0) + item.num);
      }
    }
    const pendingInputs = new Set((options.pendingMaterials ?? []).flatMap(entry => [...(entry.scope ?? [])]));
    const canPlan = (snapshot.inventoryKnown ?? snapshot.complete) && now > 0 && snapshot.stockCap > 0
      && settings.factory.enabled && settings.factory.produce && settings.loop?.world !== false;
    const picks = canPlan ? simulateNativeFactoryStarts({
      buildings: snapshot.buildings.filter(b => eligible.has(b.id) && !refillsInProgress.some(rule => rule.buildingId === b.id)),
      recipes: rows(config, 'BuildingProduceCfg'), availableProducts: unlocked,
      targets: settings.factory.simulatedTargets,
      timing: createProductionTiming({ config, ...snapshot.timing, serverNow: now }),
      now, cap: snapshot.stockCap, slots: snapshot.factories[0]?.capacity ?? 0,
      available: id => pendingInputs.has(id) ? 0 : (warehouse.get(id) ?? 0) + (receipts.get(id) ?? 0) - (resourceReserve(settings, id) || 0),
      owned: id => stock.get(id) ?? 0,
    }) : [];
    const next = picks.map(({ building, row, lane }) => ({
      kind: 'nativeSimulation', machineId: building.id + ':' + (lane.index + 1), itemId: row.itemId,
      quantity: 1, startAt: lane.start, finishAt: lane.finish,
    }));
    const timeline = [...model.fixedTimeline, ...next].map(job => ({
      ...job, machineName: model.machineNames.get(job.machineId), productName: name(job.itemId),
    }));
    return {
      strategy: 'nativeSimulation', status: 'next-dispatch', scope: 'next-dispatch', snapshotTime: now, timeline, refillNote,
      config: snapshot.config, estimated: true, completionAt: null, upperBound: null, lowerBound: null, stockTarget: snapshot.stockCap,
      statusLabel: '模拟原生 · 本轮排产', missingReads: model.input.missingReads,
      pending: pendingInputs.size > 0, waitingHarvestCount, waitingSupplyCount,
      orders: model.orderRows.map(order => ({ ...order, label: sourceNames[order.source] || order.source,
        requirements: order.requirements.map(item => ({ ...item, name: name(item.id) })), completionAt: null,
        skipped: model.skippedOrders.has(order.id),
        waitingForSupply: waitingLabels.has(order.id), statusLabel: waitingLabels.get(order.id),
        reason: describeProductionBlocks(model.skippedOrders.get(order.id) ?? model.waitingSupply.get(order.id) ?? [], name),
      })),
      recipes: materialTreeRecipes(model.orderRows, snapshot.recipes, timeline.map(job => job.itemId), name),
    };
  }
  const stockTarget = Math.min(settings.factory?.keepStock ?? 0, snapshot.stockCap ?? 0);
  const higherWaiting = model.orderRows.some(order => order.priority < model.stockPriority && model.waitingSupply.has(order.id));
  const ranked = !higherWaiting && scheduleRankedStock(snapshot, model.input, stockTarget, model.stockPriority, options.search);
  const result = ranked || optimizeProductionSchedule(model.input, options.search);
  const name = id => config?.materialName?.(id) || id;
  const completions = new Map(result.orderCompletions.map(order => [order.orderId, order]));
  const refreshUncertain = new Set(model.orderRows.filter(order => order.metadata?.refreshAt
    && completions.has(order.id) && snapshot.serverNow + completions.get(order.id).completedAt >= order.metadata.refreshAt).map(order => order.id));
  const uncertainCompletion = refreshUncertain.size > 0 || waitingSupplyCount > 0;
  const refills = ranked || uncertainCompletion ? [] : planStockRefills(snapshot, model.input, result, stockTarget);
  const planned = [...result.timeline, ...refills].map(job => {
    const basis = model.timingByJob.get(job.machineId + '\0' + job.itemId);
    return { ...job, startAt: snapshot.serverNow + job.start, finishAt: snapshot.serverNow + job.end,
      estimated: basis?.estimated !== false, timingLabel: timingNames[basis?.source] ?? '耗时待确认' };
  });
  const timeline = [...model.fixedTimeline, ...planned].map(job => ({ ...job, machineName: model.machineNames.get(job.machineId), productName: name(job.itemId),
    priorityLabel: job.kind === 'existing' ? '已排队' : job.priority == null ? (job.kind === 'restock' ? '补至库存水位' : '腾仓辅助')
      : '第' + (job.priority + 1) + '级 · ' + (model.priorityLabels.get(job.priority) || '需求备料'),
    inheritedPriority: job.kind === 'production' && job.priority != null
      && !model.activeOrderRows.some(order => order.priority === job.priority && order.requirements.some(item => item.id === job.itemId)),
    inputs: job.inputs?.map(item => ({ ...item, name: name(item.itemId) })) }))
    .sort((a, b) => a.startAt - b.startAt || a.machineId.localeCompare(b.machineId));
  const estimated = model.capacityEstimated || [...model.timingByJob.values()].some(basis => basis.estimated)
    || timeline.some(job => job.estimated);
  const priorityObjective = result.objective === 'priority-makespan';
  const hasConsumption = model.orderRows.some(order => order.kind === 'consumption');
  const scope = model.skippedOrders.size ? (hasConsumption ? 'feasible-demands' : 'feasible-orders')
    : hasConsumption ? 'configured-demands' : 'all-orders';
  const subject = model.skippedOrders.size ? '参与排产的需求' : hasConsumption ? '全部需求' : '全部订单';
  const allSkipped = model.orderRows.length > 0 && model.activeOrderRows.length === 0;
  const optimalLabel = priorityObjective ? '按配置优先级的模型内最优' : '模型内最优';
  const labels = { optimal: optimalLabel + (estimated ? '，含估算条件' : ''),
    'best-known': '已找到可行方案，最优性尚未证明',
    infeasible: estimated ? '当前估算模型下' + subject + '无法在约束内齐套' : '当前资源与设施约束下' + subject + '无法齐套',
    incomplete: '数据或搜索尚不完整，完成时间待确认' };
  const blockedOrders = model.orderRows.map(order => {
    const dependencies = dependencyItems([order], snapshot.recipes);
    return [order.id, result.blockedOrders.filter(block => block.orderId === order.id || !block.orderId && dependencies.has(block.itemId))];
  });
  const blocks = new Map(blockedOrders);
  return {
    ...result, scope, refillNote, status: uncertainCompletion ? 'incomplete' : result.status,
    statusLabel: refreshUncertain.size ? '方案越过订单刷新边界，齐套时间待确认'
      : waitingSupplyCount ? '部分需求的原生来料时间待定'
      : allSkipped ? '当前需求已全部跳过排产'
        : !model.orderRows.length && result.status === 'optimal' ? (refills.length ? '当前按库存水位备货' : '当前没有待齐套订单') : labels[result.status], estimated, config: snapshot.config,
    stockTarget,
    lowerBound: uncertainCompletion ? null : result.lowerBound,
    upperBound: uncertainCompletion ? null : result.upperBound,
    objectiveLowerBound: uncertainCompletion ? null : result.objectiveLowerBound,
    objectiveUpperBound: uncertainCompletion ? null : result.objectiveUpperBound,
    completionAt: result.upperBound === null || uncertainCompletion || allSkipped ? null : snapshot.serverNow + result.upperBound,
    waitingHarvestCount, waitingSupplyCount,
    missingReads: model.input.missingReads,
    recipes: materialTreeRecipes(model.orderRows, snapshot.recipes, timeline.map(job => job.itemId), name),
    priorityPolicy: '在原料、设备和截止约束内，按用户配置逐级最小化齐套时间，同级优化共同工期，独立生产位并行安排',
    priorityBounds: (result.priorityBounds ?? []).map(bound => ({ ...bound,
      label: '第' + (bound.priority + 1) + '级 · ' + (model.priorityLabels.get(bound.priority) || '需求备料'),
      ...(uncertainCompletion ? { lowerBound: null, upperBound: null } : {}) })),
    notes: unique([...model.notes, ...result.reasons,
      ...(model.skippedOrders.size ? ['已跳过 ' + model.skippedOrders.size + ' 项需求，原因见对应订单，材料可用于其他排产'] : []),
      ...(refreshUncertain.size ? ['生产顺序按本次固定需求计算，联盟募兵订单刷新边界之后的实际需求需重新读取确认'] : []),
      ...(estimated ? ['候选方案比较含估算耗时或生产位条件，生产加成与容量变化后需重新读取计算'] : [])]),
    assumptions: [
      '以需求优先级列表为顺序，先优化高级需求及其上游材料，再逐级优化后续需求的齐套时间',
      '范围包括活动总开关允许的当前订单与已开启来源的消费备料，未列入优先级列表的当前订单置于最后一级',
      '建筑材料备齐、每轮开工数量大于零且人口空间足够时，按立即开工扣料估算，实际开工随挂机轮次执行。其余建筑、博物馆和海兽的备料继续占仓',
      '按需优先生产时，工厂补料按其配置位置参与排产，每种加工品最多补至账号仓容与设置水位中的较小值',
      '每座工厂预览最多一轮补货队列。已安排的补货占用对应原料和生产位，产物完工后可供后续需求使用',
      '固定当前生产加成、现有设施等级和已排队任务，新增任务按原料到齐立即开工估算',
      '生产、收获和已启用订单提交按零操作延迟计算，关闭提交的订单材料独占保留',
      '外部采集、购买、广告与道具加速、未来建筑升级收益需在新快照中确认后计算',
      '开工时检查库存、待收与在途总量，加工品上限来自当前配置，农产上限为其五倍',
    ],
    orders: model.orderRows.map(order => ({ ...order, label: (sourceNames[order.source] || order.source)
      + (order.source === 'building' && order.metadata?.buildingId ? ' · ' + order.metadata.buildingId + ' ' + order.metadata.level + '级' : ''),
      priorityLabel: '第' + (order.priority + 1) + '级',
      requirements: order.requirements.map(item => ({ ...item, name: name(item.id) })),
      completionAt: completions.has(order.id) && !refreshUncertain.has(order.id) ? snapshot.serverNow + completions.get(order.id).completedAt : null,
      skipped: model.skippedOrders.has(order.id),
      waitingForSupply: waitingLabels.has(order.id),
      statusLabel: model.skippedOrders.has(order.id) ? '已跳过排产'
        : waitingLabels.has(order.id) ? waitingLabels.get(order.id)
        : completions.has(order.id) && !refreshUncertain.has(order.id) ? '联合方案已齐套' : '待确认',
      reason: refreshUncertain.has(order.id) ? '备齐前订单会刷新，请在刷新后重新生成计划'
        : describeProductionBlocks(model.waitingSupply.get(order.id) ?? model.skippedOrders.get(order.id) ?? blocks.get(order.id) ?? [], name),
    })),
    timeline,
  };
}
