import assert from 'node:assert/strict';
import { defaultSettings } from '../src/automation-settings.mjs';
import { buildProductionModel, planProduction } from '../src/production-planning.mjs';
import { forecastProductionDay } from '../src/production-day.mjs';
import { locateFactoryInsertion } from '../src/factory-insertion.mjs';

const table = data => ({ data });
const config = { tables: {
  BuildingProduceCfg: table([{ itemId: '面包', buildType: '食品厂', unlockLevel: 1, produceTime: 60, costItem: [['小麦', 1]] }]),
  FarmlandPlantCfg: table([{ id: '小麦', time: 30, produceNum: 5, material: ['小麦种子', 1] }]),
}, materialName: id => id };

function fixture() {
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true, demandFirst: true });
  Object.assign(settings.farm, { enabled: true, harvest: true, autoPlant: true });
  Object.assign(settings.building, { enabled: true, build: true, upgrade: true });
  settings.weekOrder.enabled = true;
  settings.factory.keepStock = 0;
  const snapshot = { serverNow: 1000, complete: true, missingReads: [], config: {},
    inventory: [{ id: '小麦', num: 10 }, { id: '小麦种子', num: 10 }], stockCap: 50,
    orders: [{ id: 'resident:1', source: 'resident', kind: 'order', requirements: [{ id: '面包', num: 2 }], metadata: { enabled: true } }],
    buildings: [{ id: '1食品厂', buildingId: '1食品厂', type: '食品厂', level: 1, factory: { factoryQ: [] } },
      { id: '1农田', buildingId: '1农田', type: '农田', level: 1 }],
    factories: [{ id: '1食品厂', type: '食品厂', level: 1, capacity: 6, enabled: true, queue: [], finished: [] }],
    farms: [{ id: '1农田', level: 1, enabled: true, productId: null }],
    recipes: [
      { id: '面包', productId: '面包', facilityType: '食品厂', costs: [{ id: '小麦', num: 1 }], output: 1, durationSeconds: 60, unlockLevel: 1, available: true },
      { id: '小麦', productId: '小麦', facilityType: '农田', costs: [{ id: '小麦种子', num: 1 }], output: 5, durationSeconds: 30, unlockLevel: 1, available: true },
    ],
    timing: { effects: { effects: [{ id: 1, value: 0 }, { id: 2, value: 0 }, { id: 11, value: 0 }] }, heroes: [], monthCards: { cardItem: [] } },
  };
  const plan = () => planProduction(snapshot, config, settings, { search: { maxMilliseconds: 200, maxNodes: 30000 } });
  return { snapshot, settings, plan };
}

let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }

test('模拟原生预览只展示可开工的下一批，已有队列占位时等待', () => {
  const {snapshot,settings,plan}=fixture();
  settings.factory.strategy='nativeSimulation';
  const first=snapshot.buildings[0];
  first.factory.finishedProducts=[];
  assert.deepEqual(plan().timeline.filter(j=>j.kind==='nativeSimulation').map(j=>[j.itemId,j.startAt,j.finishAt]),[['面包',1000,1060]]);
  first.factory.factoryQ=[{idx:1,productId:'面包',finishTime:1100}];
  snapshot.factories[0].queue=[{id:'1食品厂:1',productId:'面包',num:1,finishTime:1100}];
  assert.deepEqual(plan().timeline.map(j=>j.kind),['existing']);
});

test('关闭活动总开关后排程移除对应备料订单，其他订单继续参与', () => {
  const { snapshot, settings } = fixture();
  snapshot.orders.push(...['merchant', 'heroRaid'].map(source => ({
    ...snapshot.orders[0], id: source + ':1', source,
  })));
  settings.heroRaid.enabled = true;
  assert.equal(buildProductionModel(snapshot, config, settings).orderRows.length, 3);
  settings.heroRaid.enabled = settings.weekOrder.enabled = false;
  assert.deepEqual(buildProductionModel(snapshot, config, settings).orderRows.map(row => row.source), ['resident']);
});

test('共享库存只分配一次，现有队列按服务器时间贡献', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory.push({ id: '面包', num: 1 });
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ ...snapshot.orders[0], id: 'resident:2' });
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }];
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.completionAt, 1020);
  assert.deepEqual(result.recipes.map(recipe => [recipe.productId, recipe.output, recipe.inputs]), [
    ['面包', 1, [{ id: '小麦', num: 1, name: '小麦' }]],
    ['小麦', 5, [{ id: '小麦种子', num: 1, name: '小麦种子' }]],
  ]);
  assert.deepEqual(result.orders.map(order => order.completionAt).sort(), [1000, 1020]);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 0);
});

test('六个排队格遵守单生产位，队列成本已支付', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory = [{ id: '小麦', num: 1 }];
  snapshot.orders[0].requirements[0].num = 3;
  snapshot.factories[0].queue = [
    { id: 'q1', productId: '面包', num: 1, finishTime: 1020 },
    { id: 'q2', productId: '面包', num: 1, finishTime: null },
  ];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }, { productId: '面包' }];
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.completionAt, 1140);
  assert.equal(result.estimated, true);
  assert.match(result.statusLabel, /估算/);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 1);
});

test('单批五份按全部订单合并取整，并行农田按实际数量', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory = [{ id: '小麦种子', num: 2 }];
  snapshot.orders = [1, 2].map(id => ({ id: 'o' + id, source: 'resident', kind: 'order', requirements: [{ id: '小麦', num: 3 }], metadata: {} }));
  snapshot.farms.push({ ...snapshot.farms[0], id: '2农田' });
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.upperBound, 30);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 2);
});

test('已建工厂升级期间继续已有生产，并在生产位释放时开工', () => {
  const { snapshot, plan } = fixture();
  snapshot.factories[0].upgradingUntil = 1050;
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }];
  assert.equal(plan().completionAt, 1080);
});

test('升级中的农田仍需竣工才能播种', () => {
  const { snapshot, plan } = fixture();
  snapshot.inventory = [{ id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements = [{ id: '小麦', num: 1 }];
  snapshot.farms[0].upgradingUntil = 1050;
  assert.equal(plan().completionAt, 1080);
});

test('工厂按各自实测时长排产', () => {
  const { snapshot, plan } = fixture();
  snapshot.factories.push({ ...snapshot.factories[0], id: '2食品厂' });
  snapshot.buildings.push({ ...snapshot.buildings[0], id: '2食品厂', buildingId: '2食品厂' });
  snapshot.timing.observedDurations = [
    { buildingId: '1食品厂', productId: '面包', seconds: 20, samples: 1 },
    { buildingId: '2食品厂', productId: '面包', seconds: 100, samples: 1 },
  ];
  assert.equal(plan().upperBound, 40);
});

test('过期队列条目立即入库且不会提前释放仍在产的设施', () => {
  const { snapshot, settings } = fixture();
  snapshot.factories[0].queue = [
    { id: 'q1', productId: '面包', num: 1, finishTime: 1100 },
    { id: 'q2', productId: '面包', num: 1, finishTime: 990 },
  ];
  snapshot.buildings[0].factory.factoryQ = snapshot.factories[0].queue.map((job, idx) => ({ idx, productId: job.productId, finishTime: job.finishTime }));
  const model = buildProductionModel(snapshot, config, settings);
  assert.equal(model.input.machines.filter(machine => machine.id.startsWith('1食品厂:')).length, 1);
  assert.equal(model.input.machines[0].availableAt, 100);
  assert.deepEqual(model.input.incoming.map(job => job.readyAt).sort((a, b) => a - b), [0, 100]);
});

test('订单截止时间为硬约束', () => {
  const { snapshot, plan } = fixture();
  snapshot.orders[0].deadline = 1030;
  assert.equal(plan().status, 'infeasible');
  assert.match(plan().statusLabel, /估算模型/);
});

test('联盟刷新边界作为重新核验条件，越界方案保留待确认', () => {
  const { snapshot, plan } = fixture();
  snapshot.orders[0].source = 'guildRecruit';
  snapshot.orders[0].metadata.refreshAt = 1030;
  const result = plan();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completionAt, null);
  assert.equal(result.lowerBound, null);
  assert.equal(result.upperBound, null);
  assert.equal(result.objectiveLowerBound, null);
  assert.equal(result.objectiveUpperBound, null);
  assert.ok(result.priorityBounds.every(bound => bound.lowerBound === null && bound.upperBound === null));
  assert.match(result.orders[0].reason, /备齐前订单会刷新/);
});

test('月卡位到期后现有排队任务转入常驻位，已启动任务保留服务器时刻', () => {
  const { snapshot, settings } = fixture();
  const cardConfig = { ...config, tables: { ...config.tables,
    MonthCardCfg: table([{ id: '普通月卡', effectList: [['第二生产位', 1]] }]) } };
  snapshot.timing.monthCards = { cardItem: [{ type: 1, endTime: 1030 }] };
  snapshot.factories[0].queue = [
    { id: 'q1', productId: '面包', num: 1, finishTime: 1010 },
    { id: 'q2', productId: '面包', num: 1, finishTime: 1020 },
    { id: 'q3', productId: '面包', num: 1, finishTime: null },
  ];
  snapshot.buildings[0].factory.factoryQ = snapshot.factories[0].queue.map((job, idx) => ({ idx, productId: job.productId, finishTime: job.finishTime ?? 0 }));
  const model = buildProductionModel(snapshot, cardConfig, settings);
  const queued = model.fixedTimeline.find(job => job.startAt > 1000);
  assert.equal(queued.machineId, '1食品厂:1');
  assert.equal(queued.startAt, 1020);
  assert.equal(queued.finishAt, 1080);
  assert.deepEqual(model.input.incoming.slice(0, 2).map(job => job.readyAt).sort(), [10, 20]);
  assert.equal(model.input.machines[1].availableUntil, 30);
});

test('升级中的空厂依据有效月卡同时开工两件，只有一件在产时第二位可立即接单', () => {
  const { snapshot, settings } = fixture();
  const cardConfig = { ...config, tables: { ...config.tables,
    MonthCardCfg: table([{ id: '普通月卡', effectList: [['第二生产位', 1]] }]) } };
  snapshot.factories[0].upgradingUntil = 2000;
  snapshot.timing.monthCards = { cardItem: [{ type: 1, endTime: 1500 }] };
  const plan = () => planProduction(snapshot, cardConfig, settings);
  const empty = plan();
  assert.equal(empty.completionAt, 1060);
  assert.deepEqual(empty.timeline.map(job => job.startAt), [1000, 1000]);
  assert.equal(new Set(empty.timeline.map(job => job.machineId)).size, 2);
  snapshot.timing.monthCards.cardItem[0].endTime = 1000;
  assert.equal(plan().completionAt, 1120);
  snapshot.timing.monthCards.cardItem[0].endTime = -1;
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ idx: 5, productId: '面包', finishTime: 1020 }];
  assert.equal(plan().completionAt, 1060);
});

test('其他配方限制继续给出对应订单的真实阻塞', () => {
  const { snapshot, plan } = fixture();
  snapshot.recipes[0].available = false;
  snapshot.recipes[0].reason = '配方活动未开放';
  const result = plan();
  assert.equal(result.status, 'infeasible');
  assert.equal(result.completionAt, null);
  assert.match(result.orders[0].reason, /配方活动未开放/);
});

test('等级不足的商人整单跳过，已有材料可供其他订单齐套', () => {
  const { snapshot, settings } = fixture();
  const extendedConfig = { ...config, tables: { ...config.tables,
    BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data,
      { itemId: '电路板', buildType: '电子厂', unlockLevel: 2, produceTime: 60, costItem: [['小麦', 1]] }]),
  } };
  snapshot.buildings.push({ id: '1电子厂', buildingId: '1电子厂', type: '电子厂', level: 1, factory: { factoryQ: [] } });
  snapshot.factories.push({ id: '1电子厂', type: '电子厂', level: 1, capacity: 6, enabled: true, queue: [], finished: [] });
  snapshot.recipes.push({ id: '电路板', productId: '电路板', facilityType: '电子厂', costs: [{ id: '小麦', num: 1 }],
    output: 1, durationSeconds: 60, unlockLevel: 2, available: false });
  snapshot.inventory = [{ id: '面包', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ id: 'merchant:1', source: 'merchant', kind: 'order',
    requirements: [{ id: '面包', num: 1 }, { id: '电路板', num: 1 }], metadata: {} });
  settings.factory.demandPriority = ['merchant', 'resident'];
  const model = buildProductionModel(snapshot, extendedConfig, settings);
  assert.deepEqual(model.input.orders.map(order => order.id), ['resident:1']);
  assert.equal(model.skippedOrders.size, 1);
  const result = planProduction(snapshot, extendedConfig, settings);
  assert.equal(result.status, 'optimal');
  assert.equal(result.scope, 'feasible-orders');
  assert.equal(result.completionAt, snapshot.serverNow);
  assert.equal(result.orders.find(order => order.source === 'resident').completionAt, snapshot.serverNow);
  const merchant = result.orders.find(order => order.source === 'merchant');
  assert.equal(merchant.skipped, true);
  assert.equal(merchant.statusLabel, '已跳过排产');
  assert.match(merchant.reason, /电路板/);
  assert.equal(result.timeline.filter(job => job.kind === 'production').length, 0);
});

test('禁用工厂但库存、在产或待收已覆盖需求时保留订单', () => {
  for (const source of ['inventory', 'queue', 'finished']) {
    const { snapshot, settings, plan } = fixture();
    settings.factory.disabledTypes = ['食品厂'];
    snapshot.factories[0].enabled = false;
    snapshot.recipes[0].available = false;
    if (source === 'inventory') snapshot.inventory.push({ id: '面包', num: 2 });
    if (source === 'finished') snapshot.factories[0].finished.push({ id: '面包', num: 2 });
    if (source === 'queue') {
      snapshot.factories[0].queue = [1, 2].map(index => ({ id: 'q' + index, productId: '面包', num: 1, finishTime: 1000 + index * 60 }));
      snapshot.buildings[0].factory.factoryQ = snapshot.factories[0].queue;
    }
    const result = plan();
    assert.equal(result.status, 'optimal', source);
    assert.equal(result.orders[0].skipped, false, source);
    assert.equal(result.timeline.filter(job => job.kind === 'production').length, 0, source);
    assert.equal(result.completionAt, source === 'queue' ? 1120 : 1000, source);
  }
});

test('上游加工品等级不足跳过整单，普通原料短缺继续保留阻塞', () => {
  const { snapshot, settings } = fixture();
  snapshot.inventory = [];
  const extendedConfig = { ...config, tables: { ...config.tables,
    BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data,
      { itemId: '小麦种子', buildType: '种子厂', unlockLevel: 2, produceTime: 10, costItem: [] }]),
  } };
  snapshot.buildings.push({ id: '1种子厂', buildingId: '1种子厂', type: '种子厂', level: 1, factory: { factoryQ: [] } });
  snapshot.factories.push({ id: '1种子厂', type: '种子厂', level: 1, capacity: 6, enabled: true, queue: [], finished: [] });
  snapshot.recipes.push({ id: '小麦种子', productId: '小麦种子', facilityType: '种子厂', costs: [],
    output: 1, durationSeconds: 10, unlockLevel: 2, available: false });
  const result = planProduction(snapshot, extendedConfig, settings);
  assert.equal(result.orders[0].skipped, true);
  assert.match(result.orders[0].reason, /小麦种子/);
  const ordinary = fixture();
  ordinary.snapshot.inventory = [];
  const blocked = ordinary.plan();
  assert.equal(blocked.status, 'infeasible');
  assert.equal(blocked.orders[0].skipped, false);
});

test('全部跳过明确展示，恢复工厂后自动重新纳入排产', () => {
  const { snapshot, settings, plan } = fixture();
  settings.factory.disabledTypes = ['1食品厂'];
  snapshot.factories[0].enabled = false;
  snapshot.recipes[0].available = false;
  const skipped = plan();
  assert.equal(skipped.orders[0].skipped, true);
  assert.match(skipped.statusLabel, /全部跳过排产/);
  assert.equal(skipped.completionAt, null);
  settings.factory.disabledTypes = [];
  snapshot.factories[0].enabled = true;
  snapshot.recipes[0].available = true;
  const restored = plan();
  assert.equal(restored.status, 'optimal');
  assert.equal(restored.orders[0].skipped, false);
  assert.equal(restored.completionAt, 1120);
});

test('禁用配方的有限库存按优先级只分配一次，跳过后续不足订单', () => {
  const { snapshot, settings, plan } = fixture();
  settings.factory.disabledTypes = ['食品厂'];
  settings.factory.demandPriority = ['merchant', 'resident'];
  snapshot.factories[0].enabled = false;
  snapshot.recipes[0].available = false;
  snapshot.inventory = [{ id: '面包', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ ...snapshot.orders[0], id: 'merchant:1', source: 'merchant' });
  const result = plan();
  assert.equal(result.status, 'optimal');
  assert.equal(result.orders.find(order => order.source === 'merchant').skipped, false);
  assert.equal(result.orders.find(order => order.source === 'resident').skipped, true);
});

test('状态未读完整时保留待确认，避免用缺失设施跳过订单', () => {
  const { snapshot, plan } = fixture();
  snapshot.complete = false;
  snapshot.missingReads.push({ request: 'OnWaterRequest', reason: '未返回' });
  snapshot.buildings = snapshot.buildings.filter(building => building.type !== '食品厂');
  snapshot.factories = [];
  const result = plan();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.orders[0].skipped, false);
});

test('备货和未来候选不混入当前订单目标', () => {
  const { snapshot, plan } = fixture();
  snapshot.orders.push({ id: 'stock', source: 'factory', kind: 'stockTarget', requirements: [{ id: '未知', num: 50 }] });
  const result = plan();
  assert.equal(result.orders.length, 1);
  assert.equal(result.upperBound, 120);
});

test('未读库存、未知在产时刻与自动追加任务显式待确认', () => {
  for (const mode of ['missing', 'queue', 'native']) {
    const { snapshot, plan } = fixture();
    if (mode === 'missing') { snapshot.complete = false; snapshot.missingReads.push({ request: 'AllItemRequest', reason: '未返回' }); }
    if (mode === 'queue') snapshot.factories[0].queue = [{ id: 'q', productId: '面包', num: 1, finishTime: null }];
    if (mode === 'native') snapshot.factories[0].nativeAutoActive = true;
    const result = plan();
    assert.equal(result.status, 'incomplete');
    assert.equal(result.completionAt, null);
  }
});

test('原生工厂和农田并行时逐单分配库存、待收成品、已有队列和已种收成', () => {
  const { snapshot, settings, plan } = fixture();
  snapshot.autoFarming = true;
  settings.factory.gain = true;
  const factory = snapshot.factories[0];
  Object.assign(factory, { nativeAutoActive:true, nativeAutoProductId:'面包',
    finished:[{id:'面包',num:1}], queue:[{id:'q',productId:'面包',num:1,finishTime:1090}] });
  Object.assign(snapshot.farms[0], {productId:'小麦',ripeTime:1100,num:5});
  snapshot.inventory = [{id:'面包',num:1}];
  const order = (id, requirements) => ({...snapshot.orders[0], id, requirements});
  snapshot.orders = [
    order('a', [{id:'面包',num:2}]), order('b', [{id:'面包',num:1}]), order('c', [{id:'小麦',num:5}]),
    order('d', [{id:'面包',num:2},{id:'小麦',num:1}]),
  ];
  const mixed = plan();
  assert.deepEqual(mixed.missingReads, []);
  assert.deepEqual(mixed.orders.map(o=>o.completionAt), [1000,1090,1100,null]);
  assert.equal(mixed.waitingSupplyCount, 1);
  assert.equal(mixed.orders[3].statusLabel, '等待原生来料');
  assert.equal(mixed.orders[3].skipped, false);
  assert.match(mixed.orders[3].reason, /食品厂-1.*面包还差 2 件/);
  assert.match(mixed.orders[3].reason, /下一茬.*小麦还差 1 件/);
  assert.equal(mixed.upperBound, null);
  assert(mixed.timeline.every(job=>job.kind === 'existing'));
  snapshot.orders.pop();
  settings.factory.keepStock = 5;
  assert.equal(plan().completionAt, 1100);
  assert(plan().timeline.every(job=>job.kind === 'existing'));
  settings.factory.blockedCollectionTypes.push('食品厂');
  assert.match(plan().orders[0].reason, /自动收取已关闭.*面包还差 1 件/);
});

test('缺少原生上游的下游需求等待来料，同类有足够等级的可排工厂则可接单', () => {
  const { snapshot, settings } = fixture();
  const cake = {itemId:'蛋糕',buildType:'烘焙厂',unlockLevel:1,produceTime:50,costItem:[['面包',2]]};
  const local = {...config,tables:{...config.tables,BuildingProduceCfg:table([...config.tables.BuildingProduceCfg.data,cake])}};
  snapshot.factories[0].nativeAutoActive = true;
  snapshot.factories[0].queue = [{id:'q',productId:'面包',num:1,finishTime:null}];
  snapshot.recipes.push({...snapshot.recipes[0],id:'蛋糕',productId:'蛋糕',facilityType:'烘焙厂',costs:[{id:'面包',num:2}],durationSeconds:50});
  snapshot.orders[0].requirements = [{id:'蛋糕',num:1}];
  function addFactory(id, type) {
    snapshot.factories.push({...snapshot.factories[0],id,type,nativeAutoActive:false,queue:[]});
    snapshot.buildings.push({...snapshot.buildings[0],id,buildingId:id,type});
  }
  addFactory('1烘焙厂','烘焙厂');
  const blocked = planProduction(snapshot,local,settings);
  assert.deepEqual(blocked.missingReads, []);
  assert.match(blocked.orders[0].reason, /食品厂-1.*面包还差 2 件/);
  assert.equal(blocked.timeline.length, 0, '没有首项完工时刻时不可凭空预支面包');
  addFactory('2食品厂','食品厂');
  const possible = planProduction(snapshot,local,settings);
  assert.equal(possible.completionAt,1170);
  assert.deepEqual(possible.timeline.map(j=>j.machineId), ['2食品厂:1','2食品厂:1','1烘焙厂:1']);
});

test('关闭提交的订单独占材料，待确认扣款阻断相关排程', () => {
  const { snapshot, settings } = fixture();
  snapshot.orders[0].metadata.enabled = false;
  const model = buildProductionModel(snapshot, config, settings, { pendingMaterials: [{ scope: new Set(['小麦']), label: '上次开工' }] });
  assert.equal(model.input.orders[0].consumeOnCompletion, false);
  assert.equal(model.input.complete, false);
  assert.match(model.input.missingReads.join(), /上次开工/);
});

test('用于腾仓的候选配方同样遵守原料待确认扣款', () => {
  const { snapshot, settings } = fixture();
  snapshot.recipes.push({ id: '饼干', productId: '饼干', facilityType: '食品厂', costs: [{ id: '面包', num: 1 }, { id: '糖', num: 1 }],
    output: 1, durationSeconds: 60, unlockLevel: 1, available: true });
  const extendedConfig = { ...config, tables: { ...config.tables, BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data,
    { itemId: '饼干', buildType: '食品厂', unlockLevel: 1, produceTime: 60 }]) } };
  const model = buildProductionModel(snapshot, extendedConfig, settings, { pendingMaterials: [{ scope: new Set(['糖']), label: '腾仓材料未结算' }] });
  assert.equal(model.input.complete, false);
  assert.match(model.input.missingReads.join(), /腾仓材料未结算/);
});

test('零份待收成品不制造虚假未知任务，输入保持原样', () => {
  const { snapshot, plan } = fixture();
  snapshot.factories[0].finished.push({ id: '面包', num: 0 });
  const before = JSON.stringify(snapshot);
  assert.equal(plan().status, 'optimal');
  assert.equal(JSON.stringify(snapshot), before);
});

test('真实配置来源顺序传入模型，未列出的当前订单置于最后', () => {
  const { snapshot, settings } = fixture();
  settings.factory.demandPriority = ['building', 'cargo', 'resident'];
  snapshot.orders.push({ ...snapshot.orders[0], id: 'cargo:1', source: 'cargo' });
  snapshot.orders.push({ ...snapshot.orders[0], id: 'merchant:1', source: 'merchant' });
  const model = buildProductionModel(snapshot, config, settings);
  assert.deepEqual(model.input.orders.map(order => [order.source, order.priority]), [['cargo', 1], ['resident', 2], ['merchant', 3]]);
});

test('高优先建筑需求及上游材料继承顺序，其他设备保持并行', () => {
  const { snapshot, settings } = fixture();
  settings.building.supply = true;
  settings.factory.demandPriority = ['building', 'resident'];
  snapshot.inventory = [{ id: '小麦种子', num: 3 }];
  snapshot.orders[0].requirements = [{ id: '小麦', num: 5 }];
  snapshot.orders.push({ id: 'building:1', source: 'building', kind: 'consumption',
    requirements: [{ id: '面包', num: 1 }], metadata: { buildingId: '1民居', level: 2 } });
  const result = planProduction(snapshot, config, settings, { search: { maxMilliseconds: 1000, maxNodes: 100000 } });
  assert.equal(result.objective, 'priority-makespan');
  assert.equal(result.scope, 'configured-demands');
  assert.equal(result.status, 'optimal');
  assert.equal(result.orders.find(order => order.source === 'building').completionAt, 1090);
  const wheat = result.timeline.filter(job => job.itemId === '小麦');
  assert.equal(wheat[0].priority, 0);
  assert.equal(wheat[0].inheritedPriority, true);
  assert.match(wheat[0].priorityLabel, /建筑备料/);
  const bread = result.timeline.find(job => job.itemId === '面包');
  assert(wheat.some(job => job.startAt === bread.startAt), '余下作物与建筑所需的面包在独立设施并行');
});

test('建筑备料关闭时不加入目标，开启后保护已经齐套的建筑材料', () => {
  const { snapshot, settings } = fixture();
  settings.factory.demandPriority = ['building', 'resident'];
  snapshot.inventory = [{ id: '小麦', num: 1 }, { id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ id: 'building:1', source: 'building', kind: 'consumption',
    requirements: [{ id: '小麦', num: 1 }], metadata: { buildingId: '1民居', level: 2, ready: true } });
  assert.equal(buildProductionModel(snapshot, config, settings).input.orders.length, 1);
  settings.building.supply = true;
  const model = buildProductionModel(snapshot, config, settings);
  assert.equal(model.input.orders[0].consumeOnCompletion, false);
  const result = planProduction(snapshot, config, settings, { search: { maxMilliseconds: 1000, maxNodes: 100000 } });
  assert.equal(result.orders.find(order => order.source === 'building').completionAt, 1000);
  assert.equal(result.orders.find(order => order.source === 'resident').completionAt, 1090);
});

test('交换用户来源优先级后共享库存分配与完成次序随之改变', () => {
  const { snapshot, settings } = fixture();
  snapshot.inventory = [{ id: '面包', num: 1 }, { id: '小麦', num: 1 }];
  snapshot.orders[0].requirements[0].num = 1;
  snapshot.orders.push({ ...snapshot.orders[0], id: 'cargo:1', source: 'cargo' });
  for (const sources of [['cargo', 'resident'], ['resident', 'cargo']]) {
    settings.factory.demandPriority = sources;
    const result = planProduction(snapshot, config, settings, { search: { maxMilliseconds: 1000, maxNodes: 100000 } });
    assert.equal(result.orders.find(order => order.source === sources[0]).completionAt, 1000);
    assert.equal(result.orders.find(order => order.source === sources[1]).completionAt, 1060);
    assert.equal(result.priorityBounds[0].upperBound, 0);
    assert.equal(result.priorityBounds[1].upperBound, 60);
  }
});

test('自定义农田读取作物对象和水位，自动种植开关关闭时仍可按自定义种植', () => {
  const { snapshot, settings } = fixture();
  settings.farm.autoPlant = false;
  settings.farm.customPlant = true;
  settings.farm.crops = [{ id: '小麦', target: 5 }];
  snapshot.inventory = [{ id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements = [{ id: '小麦', num: 5 }];
  const model = buildProductionModel(snapshot, config, settings);
  assert.deepEqual(model.input.recipes.find(recipe => recipe.itemId === '小麦').machineIds, ['1农田']);
  assert.equal(model.input.stockCaps['小麦'], 5);
  assert.equal(planProduction(snapshot, config, settings).upperBound, 30);
  settings.farm.crops[0].target = 0;
  assert.equal(buildProductionModel(snapshot, config, settings).input.recipes.find(recipe => recipe.itemId === '小麦').enabled, false);
});

test('订单后按账号上限逐品补货，已预留或仅待收的库存继续占仓', () => {
  const { snapshot, settings, plan } = fixture();
  snapshot.stockCap = 5;
  settings.factory.keepStock = 50;
  snapshot.inventory.push({ id: '面包', num: 2 });
  snapshot.factories[0].finished = [{ id: '面包', num: 2 }];
  snapshot.factories[0].queue = [{ id: 'q1', productId: '面包', num: 1, finishTime: 1020 }];
  snapshot.buildings[0].factory.factoryQ = [{ productId: '面包', finishTime: 1020 }];
  const refills = result => result.timeline.filter(job => job.kind === 'restock');
  snapshot.orders[0].metadata.enabled = false;
  assert.equal(refills(plan()).length, 0);
  snapshot.orders[0].metadata.enabled = true;
  const consumed = plan();
  assert.equal(consumed.stockTarget, 5);
  assert.equal(consumed.orders[0].completionAt, 1000);
  assert.deepEqual(refills(consumed).map(job => job.start), [20, 80]);
  snapshot.orders = [];
  assert.equal(refills(plan()).length, 0);
  snapshot.inventory[2].num = 0;
  settings.factory.keepStock = 4;
  assert.equal(refills(plan()).length, 1);
  settings.factory.keepStock = 0;
  assert.equal(refills(plan()).length, 0);
});

test('水位是末级软目标，缺原料不推迟订单，空厂一次展示一轮空档', () => {
  const { snapshot, settings, plan } = fixture();
  const urgentTime = plan().completionAt;
  snapshot.inventory = [{ id: '小麦', num: 2 }];
  settings.factory.keepStock = 20;
  const scarce = plan();
  assert.equal(scarce.completionAt, urgentTime);
  assert(!scarce.timeline.some(job => job.kind === 'restock'));
  snapshot.orders = [];
  snapshot.inventory[0].num = 30;
  assert.equal(plan().timeline.filter(job => job.kind === 'restock').length, snapshot.factories[0].capacity);
});

test('同厂补货可用已知来料前的空档，仍为订单保留共享原料和生产位', () => {
  const { snapshot, settings } = fixture();
  settings.factory.keepStock = 5;
  const rush = { itemId: '急件', buildType: '食品厂', unlockLevel: 1, produceTime: 75, costItem: [['小麦', 1], ['木材', 1]] };
  const local = { ...config, tables: { ...config.tables, BuildingProduceCfg: table([...config.tables.BuildingProduceCfg.data, rush]) } };
  snapshot.recipes.push({ ...snapshot.recipes[0], id: '急件', productId: '急件', durationSeconds: 75,
    costs: [{ id: '小麦', num: 1 }, { id: '木材', num: 1 }] });
  snapshot.inventory = [{ id: '小麦', num: 2 }];
  snapshot.orders[0].requirements = [{ id: '急件', num: 1 }];
  snapshot.farms[0] = { ...snapshot.farms[0], productId: '木材', num: 1, ripeTime: snapshot.serverNow + 70 };
  const result = planProduction(snapshot, local, settings);
  const demand = result.timeline.find(job => job.kind === 'production');
  assert.equal(demand.start, 70);
  assert.equal(result.upperBound, 145);
  const restock = result.timeline.filter(job => job.kind === 'restock');
  assert.deepEqual(restock.map(job => [job.itemId, job.start, job.end]), [['面包', 0, 60]]);
  settings.factory.demandPriority = ['factory', ...settings.factory.demandPriority.filter(source => source !== 'factory')];
  const refillFirst = planProduction(snapshot, local, settings);
  assert.deepEqual(refillFirst.timeline.filter(job => job.kind === 'restock').map(job => job.itemId), ['面包', '面包']);
  assert.equal(refillFirst.orders[0].completionAt, null, '仅够两份的小麦已排给高优先级补料');
});

test('同一工厂的补料排首位、中间和末位时，订单齐套时刻随实际生产顺序变化', () => {
  const { snapshot, settings } = fixture();
  settings.factory.keepStock = 1;
  const recipes = [['急件', 30], ['备货', 10], ['普通件', 20]].map(([itemId, produceTime]) =>
    ({ itemId, produceTime, buildType: '食品厂', unlockLevel: 1, costItem: [['小麦', 1]] }));
  const local = { ...config, tables: { ...config.tables, BuildingProduceCfg: table(recipes) } };
  snapshot.recipes = recipes.map(r => ({ ...snapshot.recipes[0], id: r.itemId, productId: r.itemId, durationSeconds: r.produceTime }));
  snapshot.inventory.push({ id: '急件', num: 1 }, { id: '普通件', num: 1 });
  snapshot.orders = [['cargo', '急件'], ['resident', '普通件']].map(([source, id]) =>
    ({ id: source, source, kind: 'order', requirements: [{ id, num: 2 }], metadata: { enabled: false } }));
  for (const [order, timeline, completions] of [
    [['factory', 'cargo', 'resident'], ['备货', '急件', '普通件'], [1040, 1060]],
    [['cargo', 'factory', 'resident'], ['急件', '备货', '普通件'], [1030, 1060]],
    [['cargo', 'resident', 'factory'], ['急件', '普通件', '备货'], [1030, 1050]],
  ]) {
    settings.factory.demandPriority = order;
    const result = planProduction(snapshot, local, settings);
    assert.deepEqual(result.timeline.map(job => job.itemId), timeline);
    assert.deepEqual(result.orders.map(row => row.completionAt), completions);
  }
});

test('先排的补货到货后可交低级订单，独立农田仍能同时开工', () => {
  const { snapshot, settings, plan } = fixture();
  settings.factory.demandPriority = ['factory', 'resident'];
  settings.factory.keepStock = 2;
  snapshot.inventory = [{ id: '小麦', num: 2 }, { id: '小麦种子', num: 1 }];
  snapshot.orders[0].requirements.push({ id: '小麦', num: 5 });
  const result = plan();
  assert.deepEqual(result.timeline.filter(job => job.itemId === '面包').map(job => [job.kind, job.start]), [['restock', 0], ['restock', 60]]);
  assert.equal(result.timeline.find(job => job.itemId === '小麦').start, 0);
  assert.equal(result.orders[0].completionAt, 1120);
  settings.factory.keepStock = 0;
  assert(!plan().timeline.some(job => job.kind === 'restock'));
});

test('原生种植只限制依赖未知下一茬的需求，库存和确定收成可逐单估时', () => {
  const { snapshot, settings, plan } = fixture();
  snapshot.autoFarming = true;
  assert.equal(plan().completionAt, 1120);
  snapshot.inventory = [{ id:'小麦种子', num:20 }];
  Object.assign(snapshot.farms[0], { productId:'小麦', num:5, ripeTime:1200 });
  const known = plan();
  assert.equal(known.completionAt, 1320);
  assert(!known.timeline.some(j => j.itemId === '小麦' && j.kind !== 'existing'));
  snapshot.orders.push({ ...snapshot.orders[0], id:'resident:2', requirements:[{id:'小麦',num:5}] });
  const mixed = plan();
  assert.equal(mixed.waitingHarvestCount, 1);
  assert.deepEqual(mixed.missingReads, []);
  assert.equal(mixed.completionAt, null);
  assert.equal(mixed.orders[0].completionAt, 1320);
  assert.equal(mixed.orders[1].skipped, false);
  assert.match(mixed.orders[1].reason, /小麦还差 2 件/);
  settings.farm.harvest = false;
  const noHarvest = plan();
  assert.equal(noHarvest.waitingHarvestCount, 2);
  assert.match(noHarvest.orders[0].reason, /收获已关闭/);
});

for (const strategy of ['smart','nativeSimulation']) {
  const { snapshot, settings, plan } = fixture();
  settings.factory.strategy = strategy;
  settings.factory.gain = true;
  snapshot.autoFarming = true;
  snapshot.stockCap = 4;
  settings.factory.keepStock = 4;
  snapshot.timing.observedDurations = [{buildingId:'1食品厂',productId:'面包',seconds:3600,samples:3}];
  const original = JSON.stringify(snapshot);
  const day = await forecastProductionDay(snapshot, config, settings, plan().orders);
  assert.equal(JSON.stringify(snapshot), original);
  assert.equal(day.endAt - day.startAt, 86400);
  assert.equal(day.factories.length, 1);
  const hours = day.factories[0].hours;
  assert.equal(hours.length, 24);
  assert.equal(day.completions[0]?.at, 8200);
  assert.equal(hours.reduce((t,h) => t+h.busySeconds,0), 6*3600);
  assert.equal(hours.flatMap(h=>h.products).reduce((n,p)=>n+p.completed,0), 6);
  assert.equal(hours[23].busySeconds, 0);
  assert.deepEqual(day.factories[0].runs.map(r => [r.id, r.from, r.to, r.quantity, r.lane, r.status, r.existing]), [
    ['面包', day.startAt, day.startAt + 6 * 3600, 6, 1, 'planned', false],
  ]);
  console.log('通过：全天推演遵守消耗、仓容与工厂实测时长 · '+strategy);
}

test('缺少库存时保留原始读取错误', () => {
  const { snapshot, plan } = fixture();
  snapshot.autoFarming = true;
  snapshot.complete = false;
  snapshot.missingReads = [{ request:'AllItemRequest', reason:'未返回库存' }];
  assert.match(plan().missingReads.join(' '), /AllItemRequest/);
  assert.equal(plan().completionAt, null);
});

{
  const { snapshot, settings } = fixture(), id = '1食品厂', start = snapshot.serverNow;
  settings.loop.world = false;
  const entry = { revision:'v1', jobs:[{id:'面包',at:start+90,pinned:true},{id:'面包',pinned:true}] };
  const anchors = new Map();
  const day = await forecastProductionDay(snapshot,config,settings,[],{anchors,insertions:{[id]:entry}});
  const trace = anchors.get(id), f = { ...day.factories[0], startAt:start,endAt:day.endAt };
  assert.deepEqual(f.runs.map(r => [r.id,r.from,r.to,r.quantity]), [['面包',start+90,start+210,2]]);
  const [run] = f.runs;
  const position = locateFactoryInsertion(trace,f,{...run,offset:1},entry);
  assert.deepEqual(position.before,entry.jobs.slice(0,1));
  assert.deepEqual(position.after,entry.jobs.slice(1));
  const idle = locateFactoryInsertion(trace,f,{status:'gap',from:start},entry);
  assert.deepEqual(idle.before,[]);
  assert.deepEqual(idle.after,entry.jobs);
  assert.throws(() => locateFactoryInsertion(trace,f,{...run,offset:2},entry),/变化/);
  assert.throws(() => locateFactoryInsertion(trace,f,{status:'gap',from:start+91},entry),/变化/);
  console.log('通过：指定空档在到时后开始，计划批内前插保留此前与此后的手动任务');
}

for (const strategy of ['smart','nativeSimulation']) {
  const {snapshot,settings} = fixture(), id = '1食品厂';
  settings.factory.strategy = strategy;
  settings.factory.keepStock = 2;
  settings.factory.simulatedTargets = ['饼干'];
  settings.farm.enabled = false;
  snapshot.stockCap = 2;
  snapshot.inventory.push({id:'面包',num:2});
  const cookie = {itemId:'饼干',buildType:'食品厂',unlockLevel:1,produceTime:60,costItem:[['面包',1]]};
  const cake = {...cookie,itemId:'蛋糕',costItem:[['牛奶',1]]};
  const configWithCookies = {...config,tables:{...config.tables,BuildingProduceCfg:table([...config.tables.BuildingProduceCfg.data,cookie,cake])}};
  snapshot.recipes.push({...snapshot.recipes[0], id:'饼干', productId:'饼干', costs:[{id:'面包',num:1}]});
  const entry = {revision:'v1',jobs:[{id:'面包',quantity:3,pinned:true},{id:'饼干',pinned:true},{id:'蛋糕',pinned:true}]};
  const anchors = new Map();
  const day = await forecastProductionDay(snapshot,configWithCookies,settings,[],{anchors,insertions:{[id]:entry}});
  const trace = anchors.get(id), units = trace.units, f = {...day.factories[0],startAt:day.startAt,endAt:day.endAt};
  assert.deepEqual(units.slice(0,4).map(u => [u.id,u.sourceIndex]),[['饼干',1],['面包',0],['饼干',undefined],['面包',0]]);
  const first = locateFactoryInsertion(trace,f,f.runs[0],entry);
  assert.deepEqual(first.before,[entry.jobs[0]], '对越过满仓产物的任务再插单，也保留满仓批次的位置');
  assert.deepEqual(first.after,entry.jobs.slice(1));
  assert.equal(entry.jobs[0].quantity,3);
  console.log('通过：满仓插单让位给后面任务及普通排产，消耗后优先补回 · '+strategy);
}

{
  const { snapshot, settings } = fixture();
  const factory = snapshot.factories[0];
  factory.nativeAutoActive = true;
  factory.queue = [3600,90000].map((duration,index)=>({index,productId:'面包',num:1,finishTime:snapshot.serverNow+duration}));
  const day = await forecastProductionDay(snapshot, config, settings, []);
  const row = day.factories[0];
  assert.match(row.unknown, /原生接管/);
  assert(row.hours.every(h=>h.busySeconds===3600));
  assert.equal(row.hours[0].products[0].completed, 1);
  assert.equal(row.hours.at(-1).products[0].completed, 0);
  assert.equal(row.hours.at(-1).products[0].continues, true);
  assert(row.hours.flatMap(h=>h.products).every(p=>p.existing));
  assert.deepEqual(row.runs.map(r => r.lane), [1, 2]);
  assert(row.runs.every(r => r.from === day.startAt && r.status === 'running' && r.existing && r.quantity === 1));
  assert.equal(row.runs.find(r => r.continues)?.to, day.endAt);
  assert.equal(row.runs.find(r => !r.continues)?.to, day.startAt + 3600);
  console.log('通过：并行队列只计算一次工厂占用，跨日生产不提前计入完工');
}

{
  const { snapshot, settings } = fixture();
  const now = snapshot.serverNow;
  snapshot.autoFarming = true;
  Object.assign(settings.factory, { gain: true, keepStock: 5 });
  snapshot.factories[0].queue = [now - 1, now + 30, null, null].map((finishTime, index) => ({
    index, productId: '面包', num: 1, finishTime,
  }));
  const day = await forecastProductionDay(snapshot, config, settings, []);
  const { runs, hours } = day.factories[0];
  assert.deepEqual(runs.map(r => [r.status, r.from - now, r.to - now, r.quantity, r.existing]), [
    ['running', 0, 30, 1, true],
    ['queued', 30, 150, 2, true],
    ['planned', 150, 210, 1, false],
  ]);
  assert.deepEqual(hours[0].products.map(p => [p.status, p.completed]), [['running', 1], ['queued', 2], ['planned', 1]]);
  console.log('通过：同一产物按快照区分在产、游戏已排和计划待排，已完工条目不占时段');
}

{
  const { snapshot, settings, plan } = fixture();
  snapshot.autoFarming = true;
  settings.factory.gain = true;
  snapshot.inventory = [{id:'小麦种子',num:20}];
  Object.assign(snapshot.farms[0], { productId:'小麦',num:5,ripeTime:1200 });
  snapshot.orders.push({ ...snapshot.orders[0], id:'resident:2', requirements:[{id:'面包',num:5}] });
  const day = await forecastProductionDay(snapshot,config,settings,plan().orders);
  assert.deepEqual(day.completions,[{id:'resident:1',at:1320}]);
  assert(day.factories[0].hours.flatMap(h=>h.products).reduce((n,p)=>n+p.completed,0)<=5);
  console.log('通过：原生农田只在成熟后供应一次，不推测下一茬');
}

console.log(`生产排程适配测试 ${passed}/${passed} 通过`);
