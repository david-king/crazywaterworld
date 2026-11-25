// Issue #32: production switches, shortest jobs, and bounded material planning.
import assert from 'node:assert/strict';
import { defaultSettings } from '../src/automation-settings.mjs';
import { baseDemands } from '../src/base-automation.mjs';
import { planWorld, runWorld, surveyWorld } from '../src/world.mjs';

let passed = 0;
const test = (name, work) => { work(); passed++; console.log('通过：' + name); };
const table = data => ({ data });
function fixture() {
  const config = { materialName: id => id, tables: {
    BuildingCfg: table([{ buildingType: '食品厂', name: '食品厂' }, { buildingType: '民居', name: '民居' }]),
    BuildingProduceCfg: table([
      { itemId: '短时品', buildType: '食品厂', unlockLevel: 1, costItem: [['木材', 1]], produceTime: 1 },
      { itemId: '长时品', buildType: '食品厂', unlockLevel: 1, costItem: [['木材', 1]], produceTime: 60 },
    ]),
  } };
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true });
  Object.assign(settings.building, { enabled: true, build: true, upgrade: true });
  settings.weekOrder.enabled = true;
  settings.factory.keepStock = 6; settings.factory.demandFirst = false;
  settings.factory.speedUp = settings.building.speedUp = false;
  const stock = new Map([['木材', 100], ['短时品', 2]]);
  const factory = { buildingId: '1食品厂', type: '食品厂', level: 1, product: [],
    factory: { factoryQ: [], finishedProducts: [] } };
  const survey = { now: 100, serverNow: 100, player: { level: 40 }, stock, have: id => stock.get(id) ?? 0,
    buildings: [factory], factories: [factory], orders: [], notes: [], weekOrder: new Map(), cargoOrder: new Map(),
    stockCap: 50, factorySlots: 6, population: 10, futurePopulation: 10, maxPopulation: 100,
    orderOfTheDay: { orderNum: 0, rewardedNum: 0 } };
  const plan = () => planWorld(survey, { config, settings, enabled: kind => ['startProduce', 'buildSupply'].includes(kind) });
  return { config, settings, stock, factory, survey, plan };
}
const products = plan => plan.actions.filter(step => step.request === 'StartFactoryProduceRequest').map(step => step.body.productId);

test('低优先级等待项和急件可同时开工时保留排队项，另一座空厂也可接急单', () => {
  const f = fixture();
  Object.assign(f.settings.factory,{demandFirst:true, demandPriority:['cargo'], keepStock:0});
  f.config.tables.MonthCardCfg = table([{id:'普通月卡', effectList:[['第二生产位',1]]}]);
  f.survey.productionTiming = {monthCards:{cardItem:[{type:1,endTime:-1}]}};
  f.stock.set('短时品',0);
  f.survey.cargoOrder.set('短时品',1);
  const queue = f.factory.factory.factoryQ;
  queue.push({idx:1,productId:'长时品',finishTime:200},{idx:2,productId:'长时品',finishTime:200},
    {idx:3,productId:'长时品'},{idx:4,productId:'短时品'});
  assert(!f.plan().actions.some(step=>step.queueReplan),'双生产位同时释放，急件不会延迟');
  f.survey.productionTiming.monthCards.cardItem = [];
  queue.splice(1,1);
  assert(f.plan().actions.some(step=>step.queueReplan && step.body.index===3));
  queue.pop();
  const second = structuredClone(f.factory);
  second.buildingId = '2食品厂'; second.factory.factoryQ = [];
  f.survey.buildings = f.survey.factories = [f.factory,second];
  const actions = f.plan().actions;
  assert(!actions.some(step=>step.queueReplan));
  assert(actions.some(step=>step.body.buildingId==='2食品厂' && step.body.productId==='短时品'));
});

test('每座工厂独立触发补库，仓容限制派单数，其他工厂继续普通生产', () => {
  const {settings,survey,config,factory,stock} = fixture();
  const second = structuredClone(factory); second.buildingId = '2食品厂';
  survey.factories = survey.buildings = [factory,second];
  survey.stockCap = 3;
  settings.factory.refillRules = [{buildingId:'1食品厂', productId:'长时品', trigger:0, target:null}];
  const plan = () => planWorld(survey,{settings,config,enabled:kind=>kind === 'startProduce'}).actions;
  assert.deepEqual(plan().filter(s=>s.refillRule).map(s=>s.body.productId),Array(3).fill('长时品'));
  assert(plan().some(s=>s.body.buildingId === '2食品厂' && s.body.productId === '短时品'));
  stock.set('加速器',1); settings.resources.keepAccelerators = 1;
  factory.factory.factoryQ = [{idx:0,productId:'短时品',finishTime:1000}, {idx:1,productId:'长时品'}];
  settings.factory.refillRules[0].target = 1;
  settings.factory.refillSpeedUp = true;
  assert.equal(plan().filter(s=>s.refillRule).length,0,'保留量内的加速器不能花');
  stock.set('加速器',3);
  assert.deepEqual(plan().filter(s=>s.refillRule).map(s=>s.request),['SpeedUpFactoryProduceRequest'],'补库品虽已排足，仍应加速阻塞它的产品');
  settings.factory.refillSpeedUp = false;
  assert.equal(plan().filter(s=>s.refillRule).length,0,'关闭后即使加速器充足，也等在产品自然完工');
  factory.factory.factoryQ = [];
  assert.deepEqual(plan().filter(s=>s.refillRule).map(s=>s.body.productId),['长时品'],'生产位空出后继续补库');
  survey.stockKnown = false;
  assert(!plan().some(s=>s.body.buildingId === '1食品厂'));
  survey.stockKnown = true; factory.factory.autoProductId = '短时品'; survey.autoProduceForever = true;
  assert(!plan().some(s=>s.refillRule));
});

test('补库先等原料并撤下等待项，单生产位加速一件、双生产位分别加速', () => {
  const {settings,stock,factory,plan} = fixture();
  settings.factory.refillRules = [{buildingId:factory.buildingId, productId:'长时品', trigger:0, target:1}];
  settings.factory.refillSpeedUp = true;
  stock.set('加速器',30);
  const queue = factory.factory.factoryQ;
  for (let i = 0; i < 5; i++) queue.push({idx:i + 10, productId:'短时品',finishTime:i === 0 ? 300 : 0});
  const changes = () => plan().actions.filter(s => s.refillRule && s.request !== 'StartFactoryProduceRequest')
    .map(s => [s.request,s.body.index]);
  stock.set('木材',0);
  assert.deepEqual(changes(), [], '缺少一件产品的原料时保留原队列');
  stock.set('木材',1);
  assert.deepEqual(changes(), [14,13,12,11].map(i => ['CancelFactoryProduceRequest',i]));
  queue.splice(1,3);
  assert.deepEqual(changes(), [['CancelFactoryProduceRequest',14]], '撤单未全部生效时仍不加速');
  queue[1].finishTime = 200;
  assert.deepEqual(changes(), [['SpeedUpFactoryProduceRequest',10],['SpeedUpFactoryProduceRequest',14]]);
  queue[0].productId = '长时品';
  settings.factory.refillRules[0].target = 2;
  assert.deepEqual(changes(), [['SpeedUpFactoryProduceRequest',14]], '一个生产位已做补库品时只加速另一个旧品');
  queue[0].productId = '短时品';
  stock.set('加速器',4); settings.resources.keepAccelerators = 1;
  assert.deepEqual(changes(), [['SpeedUpFactoryProduceRequest',10]], '第一个生产位用尽可花余额后不再加速第二个');
  queue.pop();
  assert.deepEqual(changes(), [['SpeedUpFactoryProduceRequest',10]], '按服务端队首任务编号加速');
  queue[0].productId = '长时品';
  assert.deepEqual(changes(), [], '补库品开工后不再为腾位使用加速器');
});

test('强制补库按多级配方补缺口，上游先做自己的强制物品，原料在途不重复生产', () => {
  const {settings,survey,config,factory,stock,plan} = fixture();
  const mill = {...factory,buildingId:'1磨坊',type:'磨坊',factory:{factoryQ:[],finishedProducts:[]}};
  const workshop = {...mill,buildingId:'1加工厂',type:'加工厂',factory:{factoryQ:[],finishedProducts:[]}};
  survey.factories = survey.buildings = [workshop,mill,factory];
  const recipe = (buildType,itemId,costItem) => ({buildType,itemId,costItem,unlockLevel:1,produceTime:10});
  config.tables.BuildingProduceCfg.data = [recipe(factory.type,'面包',[['面粉',2]]),recipe(mill.type,'面粉',[['谷粒',1]]),
    recipe(mill.type,'自选品',[]),recipe(workshop.type,'谷粒',[['木材',1]])];
  const bread = {buildingId:factory.buildingId,productId:'面包',trigger:0,target:2};
  const custom = {buildingId:mill.buildingId,productId:'自选品',trigger:0,target:1};
  settings.factory.refillRules = [bread,custom];
  settings.factory.refillSpeedUp = true;
  stock.set('加速器',50); stock.set('面粉',1); stock.set('谷粒',1);
  const forced = () => plan().actions.filter(a => a.refillRule && a.request === 'StartFactoryProduceRequest');
  assert.deepEqual(forced().map(s => s.body.productId),['自选品','谷粒','谷粒']);
  stock.set('自选品',1);
  assert.deepEqual(forced().map(s => s.body.productId),['谷粒','谷粒','面粉']);
  settings.factory.refillRules.push({buildingId:mill.buildingId,productId:'面粉',trigger:1,target:4});
  assert.equal(forced().filter(s => s.body.productId === '谷粒').length,2,'显式面粉目标和面包所需面粉共用同一笔谷粒');
  settings.factory.refillRules.pop();
  workshop.factory.finishedProducts = [{id:'谷粒',num:1}];
  workshop.factory.factoryQ = [{idx:1,productId:'谷粒',finishTime:150}];
  assert.deepEqual(forced().map(s => s.body.productId),['面粉']);
  stock.set('谷粒',3);
  workshop.factory.finishedProducts = []; workshop.factory.factoryQ = [];
  mill.factory.factoryQ = [{idx:1,productId:'旧品',finishTime:150}];
  assert(!plan().actions.some(s => s.refillSupply && s.request === 'SpeedUpFactoryProduceRequest'));
  assert.deepEqual(forced().map(s => s.body.productId),['面粉','面粉','面粉']);
  stock.set('面包',2);
  assert.equal(forced().length,0,'下游达标后取消临时的上游需求');
  stock.set('面包',0); stock.set('面粉',0); stock.set('谷粒',0);
  config.tables.BuildingProduceCfg.data.find(r => r.itemId === '谷粒').costItem = [['面粉',1]];
  assert.equal(forced().length,0,'配方循环不会反复派单');
});

test('同厂也能逐级自供原料，可以开工的显式规则优先于临时补料', () => {
  const {settings,config,factory,stock,plan} = fixture(), type = factory.type;
  config.tables.BuildingProduceCfg.data = [['成品','半成品'],['半成品','木材'],['自选品','木材']].map(([id,input]) =>
    ({itemId:id,buildType:type,unlockLevel:1,produceTime:5,costItem:[[input,1]]}));
  settings.factory.refillRules = ['成品','自选品'].map(productId => ({buildingId:factory.buildingId,productId,trigger:0,target:1}));
  const next = () => plan().actions.filter(s => s.refillRule).map(s => [s.body.productId,!!s.refillSupply]);
  assert.deepEqual(next(),[['自选品',false]]);
  stock.set('自选品',1);
  assert.deepEqual(next(),[['半成品',true]]);
  stock.set('半成品',1);
  assert.deepEqual(next(),[['成品',false]]);
});

test('同时缺货时各厂按本厂物品顺序生产，规则跨厂排列不决定谁先分配原料', () => {
  const {settings,survey,config,factory,stock} = fixture();
  const other = {...factory, buildingId:'2食品厂'};
  survey.factories = survey.buildings = [factory,other];
  survey.factorySlots = 1; stock.set('短时品',0);
  const makeRule = (buildingId, productId) => ({buildingId,productId,trigger:0,target:5});
  const a = ['长时品','短时品'].map(id => makeRule(factory.buildingId,id));
  const b = ['短时品','长时品'].map(id => makeRule(other.buildingId,id));
  const starts = rules => {
    settings.factory.refillRules = rules;
    return planWorld(survey, {config,settings,enabled:kind => kind === 'startProduce'}).actions
      .filter(step => step.refillRule).map(step => [step.body.buildingId,step.body.productId]);
  };
  assert.deepEqual(starts([...b,...a]), [['1食品厂','长时品'],['2食品厂','短时品']]);
  assert.deepEqual(starts([...b,...a.toReversed()]), [['1食品厂','短时品'],['2食品厂','短时品']]);
  stock.set('木材',1);
  assert.deepEqual(starts([...a,...b]), [['1食品厂','长时品']]);
  assert.deepEqual(starts([...b,...a]), starts([...a,...b]));
});

function materialFixture() {
  const f = fixture();
  Object.assign(f.factory, { buildingId: '1材料厂', type: '材料厂' });
  const recipes = [['布匹', 3], ['长绳', 4], ['粗纸', 5], ['颜料', 1]].map(([itemId, produceTime]) => ({
    itemId, produceTime, buildType: '材料厂', unlockLevel: 1, costItem: [['木材', 1]],
  }));
  f.config.tables.BuildingProduceCfg.data = recipes;
  Object.assign(f.settings.factory, { demandFirst: true, demandPriority: ['cargo', 'factory'], keepStock: 3 });
  const materialRestock = {};
  const factoryWaitHistory = new Map();
  const schedule = (state = materialRestock) => products(planWorld(f.survey, {
    config: f.config, settings: f.settings, materialRestock: state, factoryWaitHistory, enabled: kind => kind === 'startProduce',
  }));
  return { ...f, recipes, schedule };
}

test('模拟原生先做主产物，实际耗时 5 秒的候补归入短件档，同档按库存选品', () => {
  const f = fixture(), rows = f.config.tables.BuildingProduceCfg.data;
  const [short, long] = rows;
  Object.assign(f.settings.factory,{strategy:'nativeSimulation',simulatedTargets:[long.itemId],keepStock:0,demandFirst:true});
  f.survey.cargoOrder.set(short.itemId,10);
  assert.deepEqual(products(f.plan()),[long.itemId]);
  f.stock.set(long.itemId,f.survey.stockCap);
  rows.push({...short,itemId:'另一候补',produceTime:200});
  const observed = seconds => ({ kind:'factory',buildingId:f.factory.buildingId,productId:'另一候补',seconds,samples:1 });
  f.survey.productionTiming = {observedDurations:[observed(4)]};
  assert.deepEqual(products(f.plan()),['另一候补']);
  f.survey.productionTiming.observedDurations=[observed(5)];
  assert.deepEqual(products(f.plan()),['另一候补']);
  f.survey.productionTiming.observedDurations=[observed(6)];
  assert.deepEqual(products(f.plan()),[short.itemId]);
  short.produceTime=8;
  f.survey.productionTiming.observedDurations=[observed(80)];
  assert.deepEqual(products(f.plan()),['另一候补']);
  long.costItem=[['缺料',1]]; f.stock.set(long.itemId,0);
  assert.deepEqual(products(f.plan()),['另一候补']);
  f.factory.factory.factoryQ=[{idx:1,productId:short.itemId,finishTime:200}];
  assert.deepEqual(products(f.plan()),[]);
  f.factory.factory.factoryQ=[]; f.survey.autoProduceForever=true; f.factory.factory.autoProductId=short.itemId;
  f.settings.factory.cooperateNative=true;
  assert(!f.plan().actions.some(job=>job.kind==='startProduce'));
});

test('默认配方暂时不可用时直接比较候补，恢复开放后重选主产物', () => {
  const f = fixture(), recipes = f.config.tables.BuildingProduceCfg.data;
  const [ordinary, primary] = recipes;
  ordinary.produceTime = 30;
  primary.limitType = '限时配方';
  const fast = { ...ordinary, itemId: '快件', produceTime: 2 };
  recipes.push(fast);
  f.settings.factory.strategy = 'nativeSimulation';
  for (const targetFrom of ['工厂', '模拟设置']) {
    f.factory.factory.autoProductId = targetFrom === '工厂' ? primary.itemId : ordinary.itemId;
    f.settings.factory.simulatedTargets = targetFrom === '工厂' ? [] : [primary.itemId];
    f.survey.festivals = [];
    assert.deepEqual(products(f.plan()), [fast.itemId]);
    f.survey.festivals = [{ festivalData: { limitTimeItem: [{ item: primary.limitType, openTime: 50, closeTime: 150 }] } }];
    assert.deepEqual(products(f.plan()), [primary.itemId]);
  }
  f.survey.festivals = [];
  ordinary.produceTime = 4;
  f.stock.set(ordinary.itemId, 0);
  assert.deepEqual(products(f.plan()), [ordinary.itemId], '两个短件库存相同时沿用配方顺序');
  f.stock.set(ordinary.itemId, 1);
  assert.deepEqual(products(f.plan()), [fast.itemId], '同档改选库存较少的短件');
  f.survey.stockKnown = false;
  assert.deepEqual(products(f.plan()), [], '仓库未读全时不能将未知库存当作零库存');
});

test('订单优先级不改变模拟原生选品，已安排交单的材料只能使用一次', () => {
  const f = fixture();
  f.stock.set('木材', 1);
  f.survey.cargoOrder.set('木材', 1);
  f.settings.factory.demandFirst = true;
  assert.deepEqual(products(f.plan()), [], '智能排产给待交货单留料');
  f.settings.factory.strategy = 'nativeSimulation';
  f.settings.factory.simulatedTargets = ['长时品'];
  for (const priority of [['cargo', 'factory'], ['factory', 'cargo']]) {
    f.settings.factory.demandPriority = priority;
    assert.deepEqual(products(f.plan()), ['长时品'], '主产物可用待交订单也需要的最后一件原料');
  }
  f.survey.cargoOrder.clear();
  f.settings.resident.enabled = true;
  f.survey.orders = [{ index:1, requirements:[{ id:'木材', num:1 }], rewardExp:1000, rewardGold:1000 }];
  const dispatched = planWorld(f.survey, { config:f.config, settings:f.settings,
    enabled:kind => kind === 'finishOrder' || kind === 'startProduce' });
  assert(dispatched.actions.some(step => step.kind === 'finishOrder'));
  assert.deepEqual(products(dispatched), [], '先执行的交单已用掉同一件原料');
});

test('模拟原生只用已解锁的并行位，两个开工计划共同扣料并检查月卡到期', () => {
  const f=fixture(), primary='长时品';
  Object.assign(f.settings.factory,{strategy:'nativeSimulation',simulatedTargets:[primary]});
  f.config.tables.MonthCardCfg=table([{id:'普通月卡',effectList:[['第二生产位',1]]}]);
  const card={type:1,endTime:200};
  f.survey.productionTiming={monthCards:{cardItem:[card]}};
  assert.deepEqual(products(f.plan()),[primary,primary]);
  f.stock.set('木材',1);
  assert.deepEqual(products(f.plan()),[primary]);
  f.stock.set('木材',100);
  card.endTime=120;
  assert.deepEqual(products(f.plan()),[primary,'短时品']);
  card.endTime=90;
  assert.deepEqual(products(f.plan()),[primary]);
});

test('模拟原生随本轮真实扣料重排主产物与候补，在产成品不能提前付料', () => {
  const f = fixture(), [a,b] = f.config.tables.BuildingProduceCfg.data;
  const child = { ...f.factory, buildingId:'1装配厂', type:'装配厂', factory:{factoryQ:[],finishedProducts:[]} };
  const assembly = { itemId:'装配件', buildType:child.type, unlockLevel:1, costItem:[[a.itemId,3]], produceTime:60 };
  f.config.tables.BuildingProduceCfg.data.push(assembly);
  const cap = f.survey.stockCap;
  f.settings.factory.strategy = 'nativeSimulation';
  f.settings.factory.simulatedTargets = [a.itemId];
  f.stock.set(a.itemId,cap); f.stock.set(b.itemId,cap);
  f.survey.buildings.push(child); f.survey.factories.push(child);
  assert.deepEqual(products(f.plan()), [assembly.itemId,a.itemId], '先前满仓的上游可在下游扣料后开工');
  f.survey.factories.reverse();
  assert.deepEqual(products(f.plan()), [assembly.itemId,a.itemId]);
  const primary={...b,itemId:'主产物'};
  f.config.tables.BuildingProduceCfg.data.push(primary);
  f.settings.factory.simulatedTargets=[primary.itemId];
  f.stock.set(primary.itemId,cap); f.stock.set(a.itemId,4); f.stock.set(b.itemId,3);
  a.produceTime=8;
  assert.deepEqual(products(f.plan()), [assembly.itemId,a.itemId], '原有四件扣到一件后优先于三件的同档候补');
  f.survey.factories.reverse();
  f.stock.set(a.itemId,0); assembly.costItem=[[a.itemId,1]];
  assert.deepEqual(products(f.plan()), [a.itemId], '新增在产只占仓容，必须完工入库后才能支付下游');
  f.stock.set(a.itemId,1);
  assert(products(f.plan()).includes(assembly.itemId), '下一次读数包含实物，沿用同一套规则');
});

test('模拟原生优先用本轮可领取的上游成品做主产物，排除禁收、选种厂及仍在产的材料', () => {
  const f=fixture(), [fallback,primary]=f.config.tables.BuildingProduceCfg.data;
  Object.assign(f.settings.factory,{strategy:'nativeSimulation',gain:true,simulatedTargets:[primary.itemId]});
  primary.costItem=[['配料',1]];
  const upstream={...f.factory,type:'材料厂',buildingId:'1材料厂',factory:{factoryQ:[],finishedProducts:[{id:'配料',num:1}]}};
  f.survey.factories.push(upstream);
  const head=()=>products(planWorld(f.survey,{config:f.config,settings:f.settings,enabled:k=>['gainFactory','startProduce'].includes(k)}))[0];
  assert.equal(head(),primary.itemId);
  f.settings.factory.blockedCollectionTypes=[upstream.type];
  assert.equal(head(),fallback.itemId);
  f.settings.factory.blockedCollectionTypes=[];
  upstream.type='种子厂';
  assert.equal(head(),fallback.itemId);
  upstream.type='材料厂';
  upstream.factory.finishedProducts=[]; upstream.factory.factoryQ=[{idx:1,productId:'配料',finishTime:105}];
  assert.equal(head(),fallback.itemId);
});

test('新版按本号耗时补足两段短件再回到长单，同步保留长单原料', () => {
  const f=fixture(), [source,urgent]=f.config.tables.BuildingProduceCfg.data;
  urgent.produceTime=600;f.stock.set(source.itemId,0);
  f.settings.factory.demandFirst=f.settings.factory.gain=true;
  f.survey.cargoOrder.set(urgent.itemId,1);
  for(const [type,item,input,count,seconds] of [['中间厂','中间件',source.itemId,2,2],['装配厂','总成','中间件',1,60]]){
    const b={...f.factory,buildingId:'1'+type,type,factory:{factoryQ:[],finishedProducts:[]}};
    f.survey.factories.push(b);f.survey.buildings.push(b);
    f.config.tables.BuildingProduceCfg.data.push({itemId:item,buildType:type,unlockLevel:1,produceTime:seconds,costItem:[[input,count]]});
  }
  const heads=()=>products(planWorld(f.survey,{config:f.config,settings:f.settings,enabled:k=>['gainFactory','startProduce'].includes(k)}));
  assert.deepEqual(heads().slice(0,3),[source.itemId,source.itemId,urgent.itemId]);
  f.stock.set('木材',2);
  assert.equal(heads()[0],urgent.itemId);
  f.stock.set('木材',100);source.produceTime=100;
  assert.equal(heads()[0],urgent.itemId);
});

test('升级规划记录逐栋结构化原因，预览保留原文，补齐材料后安排升级', () => {
  const f = fixture();
  f.config.tables.BuildingUpgradeCfg = table([
    { buildingType: '食品厂', level: 2, consume: [['螺丝', 4]] },
    { buildingType: '民居', level: 2, playerLevel: 41, curPeople: 200 },
  ]);
  f.survey.buildings.push({ buildingId: '1民居', type: '民居', level: 1, product: [] });
  const inspect = () => planWorld(f.survey, { config: f.config, enabled: key => key === 'upgrade' });
  const before = inspect();
  assert.deepEqual(before.upgradeChecks.find(row => row.kind === 'materials').items, [{ id: '螺丝', name: '螺丝', missing: 4 }]);
  assert(before.upgradeReasons.includes('食品厂-1缺螺丝 ×4'));
  assert(before.upgradeReasons.includes('民居-1需要角色 41 级'));
  f.stock.set('螺丝', 4); f.survey.player.level = 41;
  const after = inspect();
  assert(after.actions.some(step => step.kind === 'upgrade' && step.body.buildingId === '1食品厂'));
  assert.equal(after.upgradeChecks.length, 1);
  assert.equal(after.upgradeChecks[0].kind, 'population');
});

test('低优先级工厂保留海兽已齐的整批进阶材料，优先级反转后正常生产', () => {
  const f = fixture();
  Object.assign(f.settings.factory, { demandFirst: true, demandPriority: ['petAdvance', 'cargo'], checkEverySeconds: 300 });
  f.settings.pet.enabled = f.settings.pet.advance = true;
  f.stock.set('木材', 6);
  f.survey.cargoOrder.set('长时品', 3);
  f.survey.buildings.push({ buildingId: '1民居', type: '民居', level: 1, product: [],
    petServe: { petUid: '101', upgradeRequirements: [{ id: '木材', num: 3 }, { id: '木材', num: 2 }] } });
  f.config.tables.PetAdvancedCfg = table([{ grade: 1, level: 5 }]);
  f.config.tables.PetFeedAttrCfg = table([{ level: 0, attrCounts: [1] }]);
  const pet = { uid: '101', grade: 0, profFeed: [] };
  const plan = () => planWorld(f.survey, { config: f.config, settings: f.settings, enabled: kind => kind === 'startProduce',
    extraDemand: baseDemands({ world: f.survey, now: f.survey.serverNow, pets: [pet] }, f.config, f.settings) });
  assert.deepEqual(products(plan()), ['长时品']);
  f.settings.factory.demandPriority.reverse();
  assert.equal(products(plan()).length, 3);
  f.settings.factory.demandPriority.reverse();
  pet.profFeed = [{ attrFeed: [{ times: 1 }] }];
  assert(!plan().demands.some(row => row.sources.includes('petAdvance')));
  assert.equal(products(plan()).length, 6, '投喂已满后不再为旧需求保留木材');
});

test('工厂加速跳过等待格，按服务器时钟计算零号位，只加速已选来源的在产缺口', () => {
  const f = fixture();
  Object.assign(f.settings.factory, { speedUpSources: ['petAdvance'], demandPriority: ['petAdvance', 'cargo'] });
  f.settings.pet.enabled = f.settings.pet.advance = true;
  f.stock.set('加速器', 10);
  f.settings.resources.keepAccelerators = 2;
  f.survey.serverNow = 200;
  f.factory.buildFinishTime = 900;
  f.factory.factory.factoryQ = [{ idx: 1, productId: '长时品' }, { idx: 4, productId: '短时品', finishTime: 199 },
    { productId: '长时品', finishTime: 260 }, { idx: 2, productId: '长时品', finishTime: 350 }];
  f.survey.cargoOrder.set('长时品', 5);
  const speed = () => planWorld(f.survey, { config: f.config, settings: f.settings, allowSpeedUp: true,
    extraDemand: [{ source: 'petAdvance', requirements: [{ id: '长时品', num: 1 }] }] }).actions
    .filter(step => step.kind === 'speedUpProduce').map(step => [step.body.index, step.body.speedUp.useNum]);
  assert.deepEqual(speed(), [[0, 1]]);
  f.factory.factory.factoryQ[1].productId = '长时品';
  assert.deepEqual(speed(), [], '已到完工时间的同种产品能覆盖缺口');
  f.factory.factory.factoryQ[1].productId = '短时品';
  f.factory.factory.finishedProducts.push({ id: '长时品', num: 1 });
  assert.deepEqual(speed(), [], '待收成品已填满海兽的缺口');
  f.settings.factory.speedUp = true;
  f.stock.set('加速器', 4);
  assert.deepEqual(speed(), [[0, 1], [2, 1]], '独立物品加速仍可使用保留量以上的两个加速器');
});

test('补料与订单都需要同一件在产货物时，按顺序归属来源加速', () => {
  const f = fixture();
  f.stock.set('加速器', 10);
  f.factory.factory.factoryQ = [{ productId: '长时品', finishTime: 160 }];
  f.survey.cargoOrder.set('长时品', 1);
  Object.assign(f.settings.factory, { keepStock: 1, demandFirst: true, demandPriority: ['factory', 'cargo'], speedUpSources: ['factory'] });
  const extraDemand = baseDemands({ world: f.survey, now: f.survey.now }, f.config, f.settings);
  const speed = () => planWorld(f.survey, { config: f.config, settings: f.settings, extraDemand, allowSpeedUp: true })
    .actions.filter(step => step.kind === 'speedUpProduce').map(step => step.demandSources);
  assert.deepEqual(speed(), [['factory']]);
  f.settings.factory.demandPriority.reverse();
  assert.deepEqual(speed(), []);
});

{
  const f = fixture();
  const finishTime = Math.floor(Date.now() / 1000) + 55;
  const job = { productId: '长时品', finishTime };
  f.factory.factory.factoryQ = [job];
  f.survey.now = f.survey.serverNow = finishTime - 300;
  f.stock.set('加速器', 10);
  f.settings.factory.speedUp = true;
  f.settings.factory.speedUpItems = ['长时品'];
  const plan = planWorld(f.survey, { config: f.config, settings: f.settings, allowSpeedUp: true, enabled: kind => kind === 'speedUpProduce' });
  assert.equal(plan.actions[0].body.speedUp.useNum, 5);
  const writes = [];
  const client = { request: async () => ({ building: [f.factory] }), sendWatch: async (name, body) => { writes.push(body); } };
  const run = () => runWorld(client, { SpeedUpFactoryProduceRequest: true }, plan, { allowMutate: true, settings: f.settings,
    beforeStep: async step => assert.equal(step.costs[0].num, 1), config: f.config });
  job.productId = '短时品';
  assert.equal((await run()).results[0].skipped, true);
  assert.equal(writes.length, 0);
  job.productId = '长时品';
  assert.equal((await run()).results[0].step.body.speedUp.useNum, 1);
  assert.deepEqual(writes, [{ buildingId: f.factory.buildingId, index: 0, speedUp: { type: 2, useNum: 1 } }]);
  passed++;
  console.log('通过：执行前跳过已换产品的生产格，并按当前剩余时间核减实际花费');
}

const shortestFirst = ['短时品', '短时品', '长时品'];
const parallelOrder = ['短时品', '长时品', '短时品'];
function timedDemand() {
  const f = fixture();
  f.stock.set('短时品', 0);
  Object.assign(f.settings.factory, { keepStock: 0, demandFirst: true, demandPriority: ['cargo', 'merchant'] });
  f.config.tables.BuildingProduceCfg.data[0].produceTime = 4;
  f.config.tables.BuildingProduceCfg.data[1].produceTime = 8;
  f.config.tables.MonthCardCfg = table([{ id: '普通月卡', effectList: [['第二生产位', 1]] }]);
  f.survey.cargoOrder = new Map([['短时品', 2], ['长时品', 1]]);
  f.survey.productionTiming = { monthCards: { cardItem: [{ type: 1, endTime: -1 }] } };
  return f;
}

test('双生产位把同一货单的 4、4、8 秒任务从 12 秒缩为 8 秒，单线保留短时优先', () => {
  const f = timedDemand();
  assert.deepEqual(products(f.plan()), parallelOrder);
  for (const endTime of [99, 100, 105]) {
    f.survey.productionTiming.monthCards.cardItem[0].endTime = endTime;
    assert.deepEqual(products(f.plan()), shortestFirst);
  }
  f.survey.productionTiming.monthCards.cardItem = [];
  assert.deepEqual(products(f.plan()), shortestFirst);
});

test('六格内枚举五件订单，混合顺序比短时优先或长时优先再快一秒', () => {
  const f = timedDemand();
  f.config.tables.BuildingProduceCfg.data[0].produceTime = 2;
  f.config.tables.BuildingProduceCfg.data[1].produceTime = 3;
  f.survey.cargoOrder = new Map([['短时品', 3], ['长时品', 2]]);
  assert.deepEqual(products(f.plan()), ['短时品', '长时品', '短时品', '长时品', '短时品']);
});

test('双位派单尊重在产时刻、优先级、库存备货及同批原料限额', () => {
  const f = timedDemand();
  f.factory.factory.factoryQ = [{ idx: 0, productId: '旧产品', finishTime: 104 }];
  assert.deepEqual(products(f.plan()), shortestFirst, '已有一位占用时换序无法更早齐套');
  f.factory.factory.factoryQ = [];
  f.survey.cargoOrder.delete('长时品');
  f.survey.weekOrder.set('长时品', 1);
  assert.deepEqual(products(f.plan()), shortestFirst, '低优先级订单不能插队');
  f.survey.weekOrder.clear();
  f.settings.factory.keepStock = 1;
  assert.deepEqual(products(f.plan()), shortestFirst, '常规库存不能插队');
  f.survey.cargoOrder.set('长时品', 1);
  f.stock.set('木材', 2);
  assert.deepEqual(products(f.plan()), ['短时品', '短时品']);
});

test('升级中按当前等级派单，初建和下一等级配方仍不可用', () => {
  const f = timedDemand();
  f.factory.buildStartTime = 60;
  f.factory.buildFinishTime = 240;
  assert.deepEqual(products(f.plan()), parallelOrder);
  f.factory.level = 0;
  assert.deepEqual(products(f.plan()), []);
  f.factory.level = 1;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  assert.deepEqual(products(f.plan()), []);
});

{
  const f = timedDemand();
  f.config.tables.BuildingProduceParamCfg = table([{ paramName: '制造位上限', paramValue: 6 }]);
  f.config.tables.GameParamCfg = table([{ paramName: '产品存量初始上限', paramValue: 50 }]);
  const replies = {
    OnWaterRequest: { building: [f.factory] }, AllItemRequest: { items: [{ itemId: '木材', num: 3 }] },
    MonthCardRequest: f.survey.productionTiming.monthCards, GameEffectRequest: { effects: [] },
  };
  const protocol = Object.fromEntries(Object.keys(replies).flatMap(key => [[key, true], [key.replace('Request', 'Response'), true]]));
  const calls = [];
  const read = options => surveyWorld({ request: async key => { calls.push(key); return replies[key]; } },
    protocol, { config: f.config, includeWeekOrder: false, ...options });
  async function assign() {
    const survey = await read();
    survey.cargoOrders = [{ requirements: [...f.survey.cargoOrder].map(([id, num]) => ({ id, num })) }];
    return products(planWorld(survey, { config: f.config, settings: f.settings, enabled: kind => kind === 'startProduce' }));
  }
  assert.deepEqual(await assign(), parallelOrder);
  assert(calls.includes('MonthCardRequest'));
  assert(calls.includes('GameEffectRequest'));
  calls.length = 0;
  replies.MonthCardRequest = { cardItem: [] };
  assert.deepEqual(await assign(), shortestFirst);
  assert(calls.includes('GameEffectRequest'), '单生产位也需要账号工时来选择候选');
  calls.length = 0;
  await read({ ordersOnly: true });
  await read({ includeProductionTiming: false });
  assert(!calls.includes('MonthCardRequest'));
  f.factory.factory.factoryQ = Array.from({ length: 5 }, (_, idx) => ({ idx, productId: '短时品' }));
  await read();
  assert(calls.includes('MonthCardRequest'), '最后一个排队格也要核对实际开放的生产位');
  calls.length = 0;
  replies.OnWaterRequest.building = [{ buildingId: '1民居', level: 1, factory: { factoryQ: [] } }];
  await read();
  assert(!calls.includes('MonthCardRequest'), '非加工建筑的空嵌套消息不算空闲工厂');
  passed++;
  console.log('通过：单座工厂的实时探测读取账号月卡，权益变化后重新派单');
}

test('备货先排短时品，达到水位后再排长时品，一轮填满六个空槽', () => {
  const f = fixture();
  assert.deepEqual(products(f.plan()), ['短时品', '短时品', '短时品', '短时品', '长时品', '长时品']);
});
test('关闭原生协同不关闭普通按需生产，两个开关分别生效', () => {
  const f = fixture(); f.survey.cargoOrder.set('长时品', 2);
  f.settings.factory.demandFirst = true; f.settings.factory.demandPriority = ['cargo'];
  assert.equal(f.settings.factory.cooperateNative, false);
  assert.deepEqual(products(f.plan()).slice(0, 2), ['长时品', '长时品']);
  f.settings.factory.demandFirst = false;
  assert.equal(products(f.plan())[0], '短时品');
  f.settings.factory.produce = false;
  assert.equal(products(f.plan()).length, 0);
});
test('备货选中有订单需求的产品时，关闭按需优先后仍准确标记补库存', () => {
  const f = fixture(); f.survey.cargoOrder.set('短时品', 10);
  for (const step of f.plan().actions) { assert.match(step.label, /补库存/); assert.doesNotMatch(step.label, /贸易港缺/); }
});
test('同等需求来源先排短时，较大缺口不会抢先；来源优先级仍有效', () => {
  const f = fixture(); f.stock.set('短时品', 0); f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['cargo', 'merchant'];
  f.survey.cargoOrder = new Map([['短时品', 1], ['长时品', 5]]);
  assert.deepEqual(products(f.plan()), ['短时品', '长时品', '长时品', '长时品', '长时品', '长时品']);
  f.survey.cargoOrder = new Map([['长时品', 1]]); f.survey.weekOrder.set('短时品', 5);
  assert.equal(products(f.plan())[0], '长时品');
});
test('库存、待收、在产共同计入水位，不重复补货或超过实际空位', () => {
  const f = fixture();
  f.factory.factory.factoryQ = [{ idx: 1, productId: '短时品' }, { idx: 2, productId: '短时品' }];
  f.factory.factory.finishedProducts = [{ id: '短时品', num: 2 }];
  assert.deepEqual(products(f.plan()), ['长时品', '长时品', '长时品', '长时品']);
  f.survey.factorySlots = 3;
  assert.deepEqual(products(f.plan()), ['长时品']);
  f.survey.factorySlots = 2;
  assert.deepEqual(products(f.plan()), []);
});
test('仓容与原料共同限制整批数量，保留周订单用料', () => {
  const f = fixture(); f.survey.stockCap = 3; f.stock.set('长时品', 3);
  assert.deepEqual(products(f.plan()), ['短时品']);
  f.survey.stockCap = 50; f.stock.set('木材', 5); f.survey.weekOrder.set('木材', 3);
  assert.deepEqual(products(f.plan()), ['短时品', '短时品']);
  f.stock.set('木材', 3);
  assert.deepEqual(products(f.plan()), []);
});
test('建筑升级按缺口安排多件，已有库存、在产与待收不重复生产', () => {
  const f = fixture(); f.settings.building.supply = true;
  f.settings.factory.keepStock = 0; f.settings.factory.demandFirst = true; f.settings.factory.demandPriority = ['building'];
  f.config.tables.BuildingUpgradeCfg = table([{ buildingType: '民居', level: 2, playerLevel: 1, curPeople: 1, consume: [['长时品', 5]] }]);
  f.survey.buildings.push({ buildingId: '1民居', type: '民居', level: 1, product: [] });
  f.stock.set('长时品', 1);
  f.factory.factory.factoryQ = [{ idx: 1, productId: '长时品' }];
  f.factory.factory.finishedProducts = [{ id: '长时品', num: 1 }];
  assert.deepEqual(products(f.plan()), ['长时品', '长时品']);
  f.settings.building.supply = false;
  assert.deepEqual(products(f.plan()), []);
});
test('原生自动生产保持原目标，仅明确开启协同才允许切换', () => {
  const f = fixture(); f.factory.factory.autoProductId = '短时品'; f.survey.autoProduceForever = true;
  f.settings.factory.demandFirst = true; f.settings.factory.demandPriority = ['cargo']; f.survey.cargoOrder.set('长时品', 6);
  assert.equal(f.plan().actions.length, 0);
  f.settings.factory.cooperateNative = true;
  assert.deepEqual(f.plan().actions.map(step => step.request), ['SetFactoryAutoProduceRequest']);
  f.settings.factory.produce = false;
  assert.deepEqual(f.plan().actions.map(step => step.request), ['SetFactoryAutoProduceRequest']);
});

test('探宝与货船争用氧气瓶时，普通和原生工厂按优先级分配现货', () => {
  for (const native of [false, true]) {
    const f = fixture();
    const recipe = f.config.tables.BuildingProduceCfg.data[1];
    Object.assign(recipe, { itemId: '水族箱', costItem: [['氧气瓶', 1]] });
    Object.assign(f.settings.factory, { demandFirst: true, cooperateNative: true, keepStock: 0, demandPriority: ['museum', 'cargo'] });
    if (native) {
      f.survey.autoProduceForever = true;
      f.factory.factory.autoProductId = '短时品';
    }
    f.survey.cargoOrder.set('氧气瓶', 1);
    const demand = { source: 'museum', requirements: [{ id: '水族箱', num: 1 }] };
    const plan = () => planWorld(f.survey, { config: f.config, settings: f.settings, extraDemand: [demand], enabled: k => k === 'startProduce' });
    const wantsTank = result => result.actions.some(step => step.body.productId === '水族箱'
      && step.request === (native ? 'SetFactoryAutoProduceRequest' : 'StartFactoryProduceRequest'));
    assert.equal(wantsTank(plan()), false);
    f.stock.set('氧气瓶', 1);
    const first = plan();
    assert.equal(wantsTank(first), true);
    assert.equal(first.cargoLoadLimits.get('氧气瓶'), 0);
    assert.equal(new Map(first.reserved).get('氧气瓶'), 1);
    const weekly = planWorld(f.survey, { config: f.config, settings: f.settings, extraDemand: [demand],
      enabled: () => false, reserveFactoryInputs: true });
    assert.equal(wantsTank(weekly), false);
    assert.equal(weekly.cargoLoadLimits.get('氧气瓶'), 0);
    const control = native ? 'cooperateNative' : 'produce';
    f.settings.factory[control] = false;
    assert.equal(plan().cargoLoadLimits.has('氧气瓶'), false);
    f.settings.factory[control] = true;
    f.settings.factory.demandPriority.reverse();
    assert.equal(wantsTank(plan()), false);
    f.settings.factory.demandPriority.reverse();
    f.stock.set('氧气瓶', 2);
    const surplus = plan();
    assert.equal(wantsTank(surplus), true);
    assert.equal(surplus.cargoLoadLimits.get('氧气瓶'), 1);
    f.stock.set('氧气瓶', 1);
    f.factory.factory.factoryQ.push({ idx: 1, productId: '水族箱', finishTime: 200 });
    const queued = plan();
    assert.equal(wantsTank(queued), false);
    assert.equal(queued.cargoLoadLimits.has('氧气瓶'), false, '已有在产水族箱的原料已扣除');
    f.factory.factory.factoryQ.length = 0;
    recipe.unlockLevel = 2;
    assert.equal(plan().cargoLoadLimits.has('氧气瓶'), false, '未解锁的配方不能占用货船材料');
  }
});

test('商人整单缺少未解锁材料时释放库存，其他需求继续排产', () => {
  const f = fixture();
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['merchant', 'cargo'];
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('短时品', 0);
  f.stock.set('木材', 4);
  f.survey.weekOrder = new Map([['木材', 4], ['短时品', 2], ['长时品', 1]]);
  f.survey.cargoOrder = new Map([['短时品', 1]]);
  const result = f.plan();
  assert.deepEqual(products(result), ['短时品']);
  assert(!result.demands.some(need => need.sources.includes('merchant')));
  assert.equal(new Map(result.reserved).get('木材'), 1);
  assert.match(result.notes.join(' '), /不差钱商人.*已跳过排产.*长时品/);
  f.factory.level = 2;
  f.stock.set('木材', 100);
  assert(f.plan().demands.some(need => need.sources.includes('merchant')));
});

test('禁用需求工厂时整单停止备料，重新启用后恢复', () => {
  const f = fixture();
  f.config.tables.BuildingProduceCfg.data.push({ itemId: '颜料', buildType: '化工厂', unlockLevel: 1, costItem: [['短时品', 1]], produceTime: 60 });
  const chemical = { buildingId: '1化工厂', type: '化工厂', level: 1, product: [], factory: { factoryQ: [], finishedProducts: [] } };
  f.survey.buildings.push(chemical);
  f.survey.factories.push(chemical);
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.settings.factory.disabledTypes = ['1化工厂'];
  f.survey.weekOrder = new Map([['短时品', 2], ['颜料', 1]]);
  const skipped = f.plan();
  assert.equal(skipped.demands.length, 0);
  assert.equal(new Map(skipped.reserved).get('短时品'), undefined);
  assert.deepEqual(products(skipped), []);
  f.settings.factory.disabledTypes = [];
  assert(f.plan().demands.some(need => need.id === '颜料'));
  f.settings.factory.disabledTypes = ['化工厂'];
  chemical.factory.factoryQ.push({ productId: '颜料' });
  assert.equal(new Map(f.plan().reserved).get('短时品'), 2, '已在产覆盖缺料时继续保留整单');
});

test('不可生产商人单的现货可供居民直接交单', () => {
  const f = fixture();
  f.settings.resident.enabled = true;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.survey.weekOrder = new Map([['短时品', 2], ['长时品', 1]]);
  f.survey.orders = [{ index: 1, requirements: [{ id: '短时品', num: 2 }], rewardExp: 1000, rewardGold: 1000 }];
  const result = planWorld(f.survey, { config: f.config, settings: f.settings, enabled: kind => kind === 'finishOrder' });
  assert.equal(result.orderDecisions[0].status, 'ready');
  assert.equal(result.actions.filter(step => step.kind === 'finishOrder').length, 1);
  assert.deepEqual(result.actions[0].weeklyBorrowed, []);
});

test('多个贸易港货单仅跳过缺少未解锁材料的整单', () => {
  const f = fixture();
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('短时品', 0);
  f.survey.cargoOrders = [
    { requirements: [{ id: '长时品', num: 1 }, { id: '短时品', num: 5 }] },
    { requirements: [{ id: '短时品', num: 1 }] },
  ];
  f.survey.cargoOrder = new Map([['长时品', 1], ['短时品', 6]]);
  assert.deepEqual(products(f.plan()), ['短时品']);
});

test('多个货单共享不可再生产现货时只保留一单，跳过单释放其余材料', () => {
  const f = fixture();
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['cargo'];
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('长时品', 1);
  f.survey.cargoOrders = [
    { requirements: [{ id: '长时品', num: 1 }] },
    { requirements: [{ id: '长时品', num: 1 }, { id: '短时品', num: 2 }] },
  ];
  f.survey.cargoOrder = new Map([['长时品', 2], ['短时品', 2]]);
  const result = f.plan();
  assert.deepEqual(result.reserved, [['长时品', 1]]);
  assert.deepEqual(result.demands.map(need => [need.id, need.required]), [['长时品', 1]]);
  assert.deepEqual(products(result), []);
  assert.match(result.notes.join(' '), /贸易港.*已跳过排产.*长时品/);
});

test('商人与贸易港按配置优先级分配唯一现货，后续备料复用选单结果', () => {
  for (const priority of [['merchant', 'cargo'], ['cargo', 'merchant']]) {
    const f = fixture();
    f.settings.factory.keepStock = 0;
    f.settings.factory.demandFirst = true;
    f.settings.factory.demandPriority = priority;
    f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
    f.stock.set('长时品', 1);
    f.survey.weekOrder = new Map([['长时品', 1], ['短时品', 2]]);
    f.survey.cargoOrders = [{ requirements: [{ id: '长时品', num: 1 }, { id: '木材', num: 3 }] }];
    f.survey.cargoOrder = new Map([['长时品', 1], ['木材', 3]]);
    const result = f.plan();
    const expected = priority[0] === 'merchant' ? [['长时品', 1], ['短时品', 2]] : [['长时品', 1], ['木材', 3]];
    assert.deepEqual(result.reserved, expected);
    assert.deepEqual(result.demands.map(need => [need.id, need.required]), expected);
    assert.deepEqual(products(result), []);
  }
});

test('旧无设置入口和空优先级仍释放重复占用现货的货单材料', () => {
  const f = fixture();
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('长时品', 1);
  f.survey.weekOrder = new Map([['长时品', 1]]);
  f.survey.cargoOrder = new Map([['长时品', 1], ['短时品', 2]]);
  f.settings.factory.demandPriority = [];
  for (const settings of [null, f.settings]) {
    const result = planWorld(f.survey, { config: f.config, settings, enabled: () => false });
    assert.deepEqual(result.reserved, [['长时品', 1]]);
    assert.deepEqual(result.demands, []);
  }
});

test('居民和额外需求的上游工厂未解锁时跳过整条备料', () => {
  const f = fixture();
  f.settings.resident.enabled = true;
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.config.tables.BuildingProduceCfg.data[0].costItem = [['长时品', 1]];
  f.stock.set('短时品', 0);
  f.survey.orders = [{ index: 1, requirements: [{ id: '短时品', num: 1 }], rewardExp: 1000, rewardGold: 1000 }];
  const result = planWorld(f.survey, { config: f.config, settings: f.settings,
    enabled: kind => kind === 'startProduce', extraDemand: [{ source: 'museum', requirements: [{ id: '短时品', num: 1 }] }] });
  assert.equal(result.orderDecisions[0].status, 'productionSkipped');
  assert.equal(result.demands.length, 0);
  assert.deepEqual(products(result), []);
});
test('建筑备料遵守新增人口上限，已有施工占用人口空间', () => {
  for (const level of [0, 1]) {
    const f = fixture();
    f.settings.factory.keepStock = 0;
    f.settings.factory.demandFirst = true;
    f.settings.factory.demandPriority = ['building'];
    f.settings.building.supply = true;
    f.config.tables.BuildingUnlockCfg = table([{ buildingId: '1民居', buildingType: '民居',
      playerLevel: 1, curPeople: 1, consume: [['长时品', 2]] }]);
    f.config.tables.BuildingUpgradeCfg = table([
      { buildingType: '民居', level: 1, effect: [['人口增加', 10]] },
      { buildingType: '民居', level: 2, playerLevel: 1, curPeople: 1,
        consume: [['长时品', 2]], effect: [['人口增加', 20]] },
    ]);
    f.survey.buildings.push({ buildingId: '1民居', type: '民居', level, population: level * 10, product: [] });
    f.survey.maxPopulation = 19;
    const plan = () => planWorld(f.survey, { config: f.config, settings: f.settings });
    assert.deepEqual(products(plan()), [], '没有足够人口空间时不为首建或升级备料');
    if (level === 0) {
      const legacy = planWorld(f.survey, { config: f.config });
      assert(legacy.notes.some(note => note.includes('先建指标建筑')));
      assert(!legacy.actions.some(step => step.label?.includes('民居建造缺')));
    }
    f.survey.maxPopulation = 20;
    assert.deepEqual(products(plan()), ['长时品', '长时品'], '刚好容纳新增人口时正常备料');
    f.survey.futurePopulation = 20;
    assert.deepEqual(products(plan()), [], '已施工民居的新增人口先占用上限');
    f.config.tables.BuildingUpgradeCfg.data[level].effect = [['人口增加', level * 10]];
    assert.deepEqual(products(plan()), ['长时品', '长时品'], '不增加人口的工程仍可备料');
  }
});
test('跨厂急单先分配共享原料，交换建筑枚举顺序结果相同', () => {
  const f = fixture();
  const other = { ...f.factory, buildingId: '1机械厂', type: '机械厂', factory: { factoryQ: [], finishedProducts: [] } };
  f.config.tables.BuildingProduceCfg.data.push({ itemId: '电机', buildType: other.type, unlockLevel: 1, costItem: [['木材', 1]], produceTime: 180 });
  f.survey.factories.push(other);
  f.survey.buildings.push(other);
  f.stock.set('木材', 1);
  f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['cargo', 'merchant'];
  f.survey.weekOrder.set('长时品', 1);
  f.survey.cargoOrder.set('电机', 1);
  assert.deepEqual(products(f.plan()), ['电机']);
  f.survey.factories.reverse();
  assert.deepEqual(products(f.plan()), ['电机']);
});

test('备货塞进已知来料空档，等待中的材料不进入可花库存', () => {
  const f = fixture();
  const [clay, salt] = f.config.tables.BuildingProduceCfg.data;
  clay.produceTime = 108;
  salt.costItem = [['待到材料', 1], ['木材', 1]];
  f.survey.cargoOrder.set(salt.itemId, 1);
  f.stock.set(clay.itemId, 0);
  f.settings.factory.demandFirst = true;
  f.survey.factories.push({ ...f.factory, buildingId: '1上游厂', type: '上游厂',
    factory: { factoryQ: [{ idx: 1, productId: '待到材料', finishTime: f.survey.serverNow + 300 }], finishedProducts: [] } });
  assert.deepEqual(products(f.plan()), [clay.itemId, clay.itemId]);
  f.stock.set('待到材料', 1);
  assert.equal(products(f.plan())[0], salt.itemId);
});

test('下游同轮占用现货后，先遍历过的上游也能补回备货缺口', () => {
  const f = fixture();
  const other = { ...f.factory, buildingId: '1机械厂', type: '机械厂', factory: { factoryQ: [], finishedProducts: [] } };
  f.config.tables.BuildingProduceCfg.data.push({ itemId: '电机', buildType: other.type, unlockLevel: 1, costItem: [['短时品', 1]], produceTime: 100 });
  f.survey.factories.push(other);
  f.survey.buildings.push(other);
  f.stock.set('长时品', 6); f.stock.set('短时品', 6); f.stock.set('电机', 5);
  f.settings.factory.demandFirst = true;
  assert.deepEqual(products(f.plan()), ['电机', '短时品']);
});
test('工厂补料与订单竞争同一队列，按配置顺序生产且同一产物只补一次', () => {
  const f = fixture();
  f.stock.set('短时品', 0);
  Object.assign(f.settings.factory, { keepStock: 1, demandFirst: true, checkEverySeconds: 180 });
  f.survey.cargoOrder.set('长时品', 2);
  const extra = baseDemands({ world: f.survey, now: f.survey.now }, f.config, f.settings);
  assert(extra.some(record => record.source === 'factory'));
  for (const [order, expected] of [
    [['factory', 'cargo'], [['短时品', false], ['长时品', false], ['长时品', true]]],
    [['cargo', 'factory'], [['长时品', true], ['长时品', true], ['短时品', false]]],
  ]) {
    f.settings.factory.demandPriority = order;
    const result = planWorld(f.survey, { config: f.config, settings: f.settings, enabled: k => k === 'startProduce', extraDemand: extra });
    const jobs = result.actions.filter(job => job.request === 'StartFactoryProduceRequest');
    assert.deepEqual(jobs.map(job => [job.body.productId, job.demandDriven]), expected);
    assert.deepEqual(jobs.find(job => job.demandDriven).demandSources, ['cargo']);
  }
});

test('补料排在两类订单之间，按水位计入现货、在产和待收，移除后回到兜底备货', () => {
  const f = fixture();
  f.config.tables.BuildingProduceCfg.data.push({ ...f.config.tables.BuildingProduceCfg.data[0], itemId: '备货品' });
  f.stock.set('短时品', 1); f.stock.set('长时品', 1);
  f.survey.cargoOrder.set('长时品', 2); f.survey.weekOrder.set('短时品', 2);
  Object.assign(f.settings.factory, { keepStock: 1, demandFirst: true, demandPriority: ['cargo', 'factory', 'merchant'], checkEverySeconds: 180 });
  assert.deepEqual(products(f.plan()), ['长时品', '备货品', '短时品']);
  f.factory.factory.finishedProducts = [{ id: '备货品', num: 1 }];
  assert.deepEqual(products(f.plan()), ['长时品', '短时品']);
  f.factory.factory.finishedProducts = [];
  f.factory.factory.factoryQ = [{ productId: '备货品', finishTime: 120 }];
  assert.deepEqual(products(f.plan()), ['长时品', '短时品']);
  f.factory.factory.factoryQ = [];
  f.settings.factory.demandPriority = ['cargo', 'merchant'];
  assert.deepEqual(products(f.plan()), ['长时品', '短时品', '备货品']);
});
test('满仓的优先品不占住空厂，两个空厂只为同一断货品补一件', () => {
  const f = fixture();
  const [empty, urgent] = f.config.tables.BuildingProduceCfg.data;
  f.survey.stockCap = 4;
  f.stock.set(empty.itemId, 0); f.stock.set(urgent.itemId, 4);
  f.settings.factory.demandFirst = true;
  // Both shipments need more of the urgent product in total than its cap.
  f.survey.cargoOrders = [3, 3].map(num => ({ requirements: [{ id: urgent.itemId, num }] }));
  const second = { ...f.factory, buildingId: '2食品厂', factory: { factoryQ: [], finishedProducts: [] } };
  f.survey.factories.push(second); f.survey.buildings.push(second);
  assert.deepEqual(products(f.plan()), [empty.itemId]);
  f.stock.set(empty.itemId, 4);
  assert.deepEqual(products(f.plan()), []);
  f.stock.set(empty.itemId, 0); f.stock.set(urgent.itemId, 3);
  f.stock.set('木材', 1);
  assert.deepEqual(products(f.plan()), [urgent.itemId], '有仓位、材料只够一件时，原订单先做');
  f.stock.set(urgent.itemId, 4); f.settings.factory.keepStock = 0;
  assert.deepEqual(products(f.plan()), []);
  f.settings.factory.demandPriority = ['cargo', 'merchant'];
  f.survey.weekOrder.set(empty.itemId, 1);
  assert.deepEqual(products(f.plan()), [empty.itemId], '水位为零时仍可补已启用的正式需求');
});
test('断货成品缺两份中间料，空闲上游可补差额，已在途的同一份不重复排', () => {
  const f = fixture();
  const [input, urgent] = f.config.tables.BuildingProduceCfg.data;
  f.survey.stockCap = 4;
  f.stock.set(input.itemId, 1); f.stock.set(urgent.itemId, 4);
  f.survey.cargoOrders = [3, 3].map(num => ({ requirements: [{ id: urgent.itemId, num }] }));
  f.settings.factory.demandFirst = true;
  const downstream = { ...f.factory, type: '装配厂', buildingId: '1装配厂', factory: { factoryQ: [], finishedProducts: [] } };
  f.survey.factories.push(downstream); f.survey.buildings.push(downstream);
  f.config.tables.BuildingProduceCfg.data.push({ itemId: '断货成品', buildType: downstream.type, unlockLevel: 1,
    costItem: [[input.itemId, 2]], produceTime: 15 });
  assert.deepEqual(products(f.plan()), [input.itemId]);
  f.factory.factory.factoryQ = [{ idx: 1, productId: input.itemId, finishTime: f.survey.now + 1 }];
  assert.deepEqual(products(f.plan()), []);
  f.factory.factory.factoryQ = []; f.stock.set('木材', 0);
  assert.deepEqual(products(f.plan()), []);
});
test('未知来料先保护急单，长期同一缺料只放行一件长任务，换账号独立计时', () => {
  const f = fixture();
  const [urgent, filler] = f.config.tables.BuildingProduceCfg.data;
  urgent.costItem = [['外部材料', 1]];
  filler.produceTime = 600;
  f.stock.set(urgent.itemId, 0);
  Object.assign(f.settings.factory, { demandFirst: true, keepStock: 3, checkEverySeconds: 30 });
  f.survey.cargoOrder.set(urgent.itemId, 1);
  const history = new Map();
  const at = (time, state = history) => {
    f.survey.now = f.survey.serverNow = time;
    return products(planWorld(f.survey, { config: f.config, settings: f.settings, factoryWaitHistory: state,
      enabled: kind => kind === 'startProduce' }));
  };
  assert.deepEqual(at(100), []);
  assert.deepEqual(at(189), []);
  assert.deepEqual(at(190), [filler.itemId]);
  assert.deepEqual(at(190, new Map()), []);
  f.stock.set('外部材料', 1);
  assert.equal(at(191)[0], urgent.itemId);
  assert.equal(history.size, 0);
});

test('双生产位按各批真实到料时间保护急单，两批同到时长任务不能抢第二位', () => {
  const f = timedDemand();
  const [urgent, filler] = f.config.tables.BuildingProduceCfg.data;
  urgent.costItem = [['在途料', 1]]; filler.produceTime = 600;
  Object.assign(f.settings.factory, { keepStock: 1 });
  f.survey.cargoOrder = new Map([[urgent.itemId, 2]]);
  const supply = finishTime => ({ buildingId: '供应' + finishTime, type: '供应厂', level: 1, product: [],
    factory: { factoryQ: [{ idx: 1, productId: '在途料', finishTime }], finishedProducts: [] } });
  const a = supply(150), b = supply(150); b.buildingId += 'B';
  f.survey.factories.push(a,b);
  assert.deepEqual(products(f.plan()), []);
  b.factory.factoryQ[0].finishTime = 800;
  assert.deepEqual(products(f.plan()), [filler.itemId]);
});

test('同级单线先给下游送一秒速料，长料同时加工，已有优先级保持不变', () => {
  const f = timedDemand();
  f.settings.factory.gain = true;
  f.survey.productionTiming.monthCards = [];
  const [a,b] = f.config.tables.BuildingProduceCfg.data;
  a.produceTime = 100; b.produceTime = 1;
  const downstream = { ...f.factory, buildingId: '1下游厂', type: '下游厂', factory: { factoryQ: [], finishedProducts: [] } };
  f.survey.factories.push(downstream); f.survey.buildings.push(downstream);
  for (const [input, time] of [[a,120],[b,9]]) f.config.tables.BuildingProduceCfg.data.push({
    itemId: input.itemId + '成品', buildType: downstream.type, unlockLevel: 1, costItem: [[input.itemId,1]], produceTime: time,
  });
  f.survey.cargoOrder = new Map([[a.itemId+'成品',1],[b.itemId+'成品',1]]);
  assert.deepEqual(products(f.plan()), [b.itemId,a.itemId]);
  f.survey.cargoOrder.delete(b.itemId+'成品'); f.survey.weekOrder.set(b.itemId+'成品',1);
  assert.deepEqual(products(f.plan()), [a.itemId,b.itemId]);
});
console.log('工厂排产计划专项 ' + passed + '/' + passed + ' 通过');
