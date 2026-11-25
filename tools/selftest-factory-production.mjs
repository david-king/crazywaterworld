import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { loadProtocol } from '../src/proto.mjs';
import { defaultSettings } from '../src/automation-settings.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import { runFactoryProductionBatch } from '../src/factory-production.mjs';
import { nativeFactoryControl, toggleNativeFactory, planWorld, runWorld } from '../src/world.mjs';
import { pendingOrderMaterialSpends, beginOrderMaterialSpend, cancelOrderMaterialSpend } from '../src/order-reservations.mjs';

const protocol = loadProtocol(), now = () => Math.floor(Date.now() / 1000);
let serial = 32000000, passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
function fixture() {
  const player = { playerId: ++serial, worldId: 1, level: 40, vip: { vipLevel: 0 } }, settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true, gain: true, demandFirst: true });
  settings.weekOrder.enabled = true;
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '材料厂' }] },
    BuildingProduceCfg: { data: [{ buildType: '材料厂', itemId: '产品甲', unlockLevel: 1, produceTime: 1, costItem: [['木材', 1]] },
      { buildType: '材料厂', itemId: '产品乙', unlockLevel: 1, produceTime: 1, costItem: [['金属', 1]] }] },
    BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 6 }] },
    GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
  } };
  const state = { stock: new Map([['木材', 100], ['金属', 100]]), reads: [], writes: [], harvests: 0, active: true, instant: false,
    building: { buildingId: '1材料厂', level: 10, factory: { factoryQ: [], finishedProducts: [] } }, mode: '', failAt: 0, inFlight: 0 };
  const codec = (name, body) => { const type = protocol[name]; assert(type, name); return type.decode(type.encode(body).finish()); };
  const add = productId => {
    const recipe = config.tables.BuildingProduceCfg.data.find(row => row.itemId === productId);
    for (const [id, count] of recipe.costItem) state.stock.set(id, state.stock.get(id) - count);
    if (state.instant) {
      let product = state.building.factory.finishedProducts.find(row => row.id === productId);
      if (!product) { product = { type: 0, id: productId, num: 0 }; state.building.factory.finishedProducts.push(product); }
      product.num++;
    } else state.building.factory.factoryQ.push({ idx: state.building.factory.factoryQ.reduce((n,row) => Math.max(n,row.idx + 1), 0), productId, finishTime: now() + 100 });
  };
  const client = { connected: true, festivals: [], async request(name, body = {}, response) {
    codec(name, body); state.reads.push(name);
    let result;
    if (name === 'GainFactoryProduceRequest') {
      const assets = state.building.factory.finishedProducts;
      for (const row of assets) state.stock.set(row.id, (state.stock.get(row.id) ?? 0) + row.num);
      result = { products: { asset: structuredClone(assets) } }; state.building.factory.finishedProducts = []; state.harvests++;
    } else if (name === 'OnWaterRequest') result = { building: [state.building, ...(state.otherBuildings ?? [])], workerOrder: [], ...state.water };
    else if (name === 'AllItemRequest') {
      if (state.badBag && state.writes.length) throw new Error('测试库存读取失败');
      result = { items: [...state.stock].map(([itemId, num]) => ({ itemId, num })) };
    } else throw new Error('禁止未声明读取：' + name);
    const reply = codec(response, result);
    await state.afterRead?.(name);
    return reply;
  }, async sendWatch(name, body) {
    assert.equal(++state.inFlight, 1, '批次写请求必须串行');
    try {
      const request = codec(name, body); assert.equal(name, 'StartFactoryProduceRequest');
      assert.deepEqual(Object.keys(request).sort(), ['buildingId', 'productId']);
      state.writes.push({ name, body });
      const failing = state.failAt === state.writes.length;
      if (failing && state.mode === 'reject') throw Object.assign(new Error('明确拒绝'), { prompt: {}, request: name });
      if (failing && state.mode === 'notSent') throw Object.assign(new Error('未发送'), { notSent: true });
      if (failing && state.mode === 'unknown') throw new Error('结果未知');
      add(body.productId);
      await state.afterSend?.(state.writes.length);
      if (failing && state.mode === 'lost') throw new Error('回包丢失');
      return { seq: state.writes.length };
    } finally { state.inFlight--; }
  } };
  const step = (productId = '产品甲') => ({ kind: 'startProduce', request: 'StartFactoryProduceRequest', response: null,
    body: { buildingId: '1材料厂', productId }, costs: config.tables.BuildingProduceCfg.data.find(row => row.itemId === productId).costItem.map(([id,num])=>({id,num})), label: '排产' });
  const options = () => ({ config, player, getSettings: () => settings, enabled: () => state.active, window: 0 });
  const batch = (steps = Array.from({ length: 6 }, () => step()), extra = {}) => runFactoryProductionBatch(client, protocol, steps, { ...options(), ...extra });
  return { player, settings, config, state, client, add, step, options, batch };
}

await test('库存消耗后重排游戏等待项，先复核库存和开工状态，再按新缺口补单', async () => {
  const {state, config, player, settings, client, options} = fixture();
  settings.factory.demandPriority = ['cargo', 'resident'];
  settings.factory.keepStock = 0;
  const building = state.building;
  building.type = '材料厂'; building.product = [];
  const queue = building.factory.factoryQ;
  queue.push({idx:40,productId:'产品甲',finishTime:now()+600}, {idx:41,productId:'产品乙'}, {idx:42,productId:'产品甲'});
  state.stock.set('产品甲',3);
  const survey = {now:now(),serverNow:now(), stock:state.stock, have:id=>state.stock.get(id)??0, stockKnown:true,
    stockCap:50, factorySlots:3, buildings:[building], factories:[building], orders:[], weekOrder:new Map(),
    cargoOrder:new Map([['产品甲',3]]), orderOfTheDay:{}, player};
  const plan = () => planWorld(survey, {config,settings,enabled:k=>k==='startProduce'});
  const run = (p,extra) => runWorld(client,protocol,p,{...options(),allowMutate:true,...extra});
  assert(!plan().actions.some(s=>s.queueReplan));
  state.stock.set('产品甲',0);
  const next = plan();
  assert.deepEqual(next.actions.map(s => [s.request,s.body.index]), [['CancelFactoryProduceRequest',41]]);
  state.stock.set('产品甲',3);
  assert((await run(next)).results[0].skipped);
  state.stock.set('产品甲',0);
  queue[1].finishTime = now()+500;
  assert((await run(next)).results[0].skipped);
  delete queue[1].finishTime;
  const start = client.sendWatch.bind(client);
  client.sendWatch = async (name,body,opts) => {
    opts.beforeSend();
    if (name !== 'CancelFactoryProduceRequest') return start(name,body,opts);
    const i = queue.findIndex(j=>j.idx === body.index);
    assert(i > 0 && !queue[i].finishTime);
    queue.splice(i,1);
    return {seq:1};
  };
  assert((await run(next,{factoryPlanCurrent:()=>false})).results[0].skipped);
  assert.equal((await run(next)).results[0].status,'confirmed');
  assert.deepEqual(queue.map(j=>j.idx),[40,42]);
  const refill = plan();
  assert.deepEqual(refill.actions.map(s=>s.body.productId),['产品甲']);
  assert((await run(refill)).results[0].ok);
  assert(!plan().actions.some(s=>s.queueReplan));
});

const refillTest = (name,work) => test(name, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-factory-refill-'));
  const previous = process.env.CW_DATA_DIR;
  process.env.CW_DATA_DIR = directory;
  try {
    await work();
  } finally {
    if (previous === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = previous;
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

await refillTest('强制补库按实际库存触发，撤单、加速后跨轮独占本厂，入库达标再恢复', async () => {
  for (const strategy of ['smart','nativeSimulation']) {
    const {client, config, player, settings, state} = fixture();
    const building = state.building, buildingId = building.buildingId;
    const rule = {buildingId, productId:'产品甲', trigger:1, target:4};
    Object.assign(settings.factory, {strategy, demandFirst:false, keepStock:1, simulatedTargets:['产品乙'], refillRules:[rule]});
    settings.resources.keepAccelerators = 3;
    building.type = '材料厂'; building.product = [];
    const survey = () => ({now:now(), serverNow:now(), stock:state.stock, have:id => state.stock.get(id) ?? 0,
      stockKnown:true, stockCap:50, factorySlots:6, player, buildings:[building], factories:[building],
      orders:[], weekOrder:new Map(), orderOfTheDay:{}, notes:[]});
    const plan = () => planWorld(survey(), {config, settings, trackRefills:true, enabled:kind => kind === 'startProduce'});
    const run = plan => runWorld(client, protocol, plan, {config, player, settings, allowMutate:true});
    const queue = building.factory.factoryQ, done = building.factory.finishedProducts;
    queue.push({idx:0, productId:'产品乙', finishTime:now()+110}, {idx:1, productId:'产品乙'}, {idx:2, productId:'产品甲'}, {idx:3, productId:'产品乙'});
    state.stock.set('加速器',5); state.stock.set('产品甲',1);
    const expected = ['CancelFactoryProduceRequest','CancelFactoryProduceRequest','SpeedUpFactoryProduceRequest'];
    assert.deepEqual(plan().actions.map(s => s.request), expected.slice(0,2), '默认只撤下等待中的其他产品');
    settings.factory.refillSpeedUp = true;
    const first = plan();
    assert.deepEqual(first.actions.map(s => s.request), expected.slice(0,2));
    assert.deepEqual(first.actions.map(s => s.body.index), [3,1]);
    const sendStart = client.sendWatch.bind(client), writes = [];
    client.sendWatch = async (name,body,options) => {
      try { options.beforeSend?.(); }
      catch (error) { throw Object.assign(new Error(error.message, {cause:error}), {notSent:true}); }
      writes.push(name);
      if (name === 'StartFactoryProduceRequest') return sendStart(name,body,options);
      assert.equal(body.buildingId,buildingId);
      const index = queue.findIndex(j => j.idx === body.index);
      if (name === 'SpeedUpFactoryProduceRequest') {
        assert.deepEqual(body.speedUp,{type:2,useNum:2}); state.stock.set('加速器',3);
        done.push({id:queue[index].productId,num:1});
      } else assert(!queue[index].finishTime);
      queue.splice(index,1);
      if (!queue[0]?.finishTime && queue[0]) queue[0].finishTime = now()+60;
      return {seq:writes.length};
    };
    state.stock.set('产品甲',4);
    assert((await run(first)).results.every(e => e.skipped)); assert.deepEqual(writes,[]);
    state.stock.set('产品甲',1);
    queue[3].finishTime = now()+200;
    assert((await run({actions:first.actions.slice(0,1)})).results[0].skipped);
    delete queue[3].finishTime;
    settings.factory.refillRules = [];
    assert((await run(first)).results.every(e => e.skipped)); assert.deepEqual(writes,[]);
    settings.factory.refillRules = [rule];
    settings.factory.refillSpeedUp = false;
    const interrupted = await run(first);
    assert(interrupted.results.every(e => e.ok)); assert.deepEqual(writes,expected.slice(0,2));
    assert.equal(queue[0].productId,'产品乙'); assert.equal(state.stock.get('加速器'),5);
    settings.factory.refillSpeedUp = true;
    const accelerate = {actions:plan().actions.filter(s => s.request === 'SpeedUpFactoryProduceRequest')};
    assert.deepEqual(accelerate.actions.map(s => s.body.index), [0]);
    queue.push({idx:4, productId:'产品乙'});
    assert((await run(accelerate)).results[0].skipped, '撤单后又出现等待项，不能沿用旧的加速计划');
    queue.pop();
    const paidTarget = queue.pop();
    state.stock.set('木材',0);
    assert((await run(accelerate)).results[0].skipped, '已排补库品消失且原料用尽，不能加速');
    queue.push(paidTarget);
    const sendBeforeToggle = client.sendWatch;
    client.sendWatch = (name,body,options) => {
      settings.factory.refillSpeedUp = false;
      return sendBeforeToggle(name,body,options);
    };
    assert.match((await run(accelerate)).results[0].error, /设置或生产格已变化/, '发送前关闭时撤回旧加速计划');
    assert.deepEqual(writes,expected.slice(0,2)); assert.equal(state.stock.get('加速器'),5);
    client.sendWatch = sendBeforeToggle;
    settings.factory.refillSpeedUp = true;
    assert((await run(accelerate)).results[0].ok); assert.deepEqual(writes,expected);
    state.stock.set('木材',100);
    state.stock.set('产品甲',2); // above trigger, one target item already in production
    const refill = plan(); assert.deepEqual(refill.actions.map(s => s.body.productId),['产品甲']);
    assert((await run(refill)).results.every(e => e.ok));
    assert.equal(plan().actions.length,0);
    queue.length = 0; done.push({id:'产品甲',num:2});
    assert.equal(plan().actions.length,0,'待收达到目标时仍不能排其他物品');
    done.length = 0; state.stock.set('产品甲',4);
    assert(plan().actions.some(s => !s.refillRule && s.body.productId === '产品乙'));
    state.stock.set('产品甲',2);
    assert(!plan().actions.some(s => s.refillRule),'入库达标后要再次降至触发值才接管');

    settings.factory.refillRules = [rule, {buildingId, productId:'产品乙', trigger:0, target:3}];
    state.stock.set('产品甲',1); state.stock.set('产品乙',0);
    const firstShortage = plan();
    assert.deepEqual(firstShortage.actions.map(s => s.body.productId), Array(3).fill('产品甲'));
    queue.push({idx:0,productId:'产品乙',finishTime:now()+120},{idx:1,productId:'产品乙'});
    const cancel = plan().actions.find(s => s.request === 'CancelFactoryProduceRequest');
    const sendBeforeChange = client.sendWatch;
    client.sendWatch = (...args) => {
      settings.factory.refillRules = settings.factory.refillRules.toReversed();
      return sendBeforeChange(...args);
    };
    assert.match((await run({actions:[cancel]})).results[0].error, /设置或生产格已变化/, '发出撤单前改为优先乙，不撤下乙的队列');
    assert.equal(queue.length,2);
    client.sendWatch = sendBeforeChange;
    settings.factory.refillRules = settings.factory.refillRules.toReversed(); queue.length = 0;
    state.stock.set('产品乙',1); state.stock.set('产品甲',4);
    const secondShortage = plan();
    assert.deepEqual(secondShortage.actions.map(s => s.body.productId), ['产品乙','产品乙'], '等待期间库存略有回升仍补至目标');
    state.stock.set('产品甲',0);
    assert((await run(secondShortage)).results.every(e => e.skipped), '甲再次缺货时不可执行低优先级乙的旧计划');
    const urgent = plan();
    assert.deepEqual(urgent.actions.map(s => s.body.productId), Array(4).fill('产品甲'), '高优先级物品重新触发即接管工厂');
    state.stock.set('产品甲',4);
    assert.deepEqual(plan().actions.map(s => s.body.productId), ['产品乙','产品乙'], '甲达标后继续补库存仍高于触发值的乙');
    state.stock.set('产品甲',0); plan();
    settings.factory.refillRules = settings.factory.refillRules.toReversed();
    assert((await run(urgent)).results.every(e => e.skipped), '调整优先级后停止旧排产计划');
    assert((await run(secondShortage)).results.every(e => e.ok));
    assert.equal(plan().actions.length, 0, '第二种物品在产时保留队列，等实际入库');
    queue.length = 0; state.stock.set('产品乙',3);
    assert.deepEqual(plan().actions.map(s => s.body.productId), Array(4).fill('产品甲'), '按新优先级先补齐乙，再继续甲');
    state.stock.set('产品甲',4);
    assert(!plan().actions.some(s => s.refillRule));
  }
});

await refillTest('双生产位先撤等待项，再按原任务编号各加速一次，第二位已换单时跳过', async () => {
  for (const replaced of [false,true]) {
    const {client,config,player,settings,state} = fixture();
    const building = state.building;
    building.type = '材料厂'; building.product = [];
    settings.factory.refillRules = [{buildingId:building.buildingId,productId:'产品甲',trigger:0,target:3}];
    settings.factory.refillSpeedUp = true; settings.resources.keepAccelerators = 3;
    state.stock.set('加速器',8);
    const queue = building.factory.factoryQ;
    queue.push({idx:9,productId:'产品乙',finishTime:now()+110},{idx:3,productId:'产品乙',finishTime:now()+170},
      {idx:22,productId:'产品乙'},{idx:25,productId:'产品甲'},{idx:39,productId:'产品乙'});
    const plan = () => planWorld({now:now(),serverNow:now(),stock:state.stock,have:id => state.stock.get(id) ?? 0,
      stockKnown:true,stockCap:50,factorySlots:6,player,buildings:[building],factories:[building],orders:[],weekOrder:new Map(),
      orderOfTheDay:{},notes:[]},{config,settings,trackRefills:true,enabled:kind => kind === 'startProduce'});
    const run = actions => runWorld(client,protocol,{actions},{config,player,settings,allowMutate:true});
    const writes = [];
    client.sendWatch = async (name,body,options) => {
      options.beforeSend?.();
      const i = queue.findIndex(job => job.idx === body.index);
      assert(i >= 0);
      if (name === 'CancelFactoryProduceRequest') assert(!queue[i].finishTime);
      else {
        assert.equal(name,'SpeedUpFactoryProduceRequest');
        assert(queue[i].finishTime > now());
        state.stock.set('加速器',state.stock.get('加速器') - body.speedUp.useNum);
        const done = building.factory.finishedProducts;
        if (done.length) done[0].num++; else done.push({id:'产品乙',num:1});
        if (body.index === 9) {
          queue.find(j => j.idx === 25).finishTime = now()+60;
          if (replaced) queue.find(j => j.idx === 3).finishTime = now()+600;
        }
      }
      writes.push([body.index,body.speedUp?.useNum ?? 0]); queue.splice(i,1);
      return {seq:writes.length};
    };
    const cancels = plan().actions;
    assert.deepEqual(cancels.map(s => [s.request,s.body.index]),[39,22].map(i => ['CancelFactoryProduceRequest',i]));
    assert((await run(cancels)).results.every(e => e.ok));
    const speeds = plan().actions.filter(s => s.request === 'SpeedUpFactoryProduceRequest');
    assert.deepEqual(speeds.map(s => [s.body.index,s.body.speedUp.useNum]),[[9,2],[3,3]]);
    const result = await run(speeds);
    assert(result.results[0].ok);
    assert(replaced ? result.results[1].skipped : result.results[1].ok);
    assert.deepEqual(writes,replaced ? [[39,0],[22,0],[9,2]] : [[39,0],[22,0],[9,2],[3,3]]);
    assert.equal(state.stock.get('加速器'),replaced ? 6 : 3);
  }
});

await refillTest('上游派单发送前重查两座工厂：下游达标、移除规则或上游手动补库触发均停派', async () => {
  for (const strategy of ['smart','nativeSimulation']) {
    const {client,config,player,settings,state} = fixture();
    const upstream = state.building;
    upstream.type = '材料厂';
    const downstream = {buildingId:'1食品厂',type:'食品厂',level:1,factory:{factoryQ:[],finishedProducts:[]}};
    state.otherBuildings = [downstream];
    config.tables.BuildingCfg.data.push({buildingType:'食品厂'});
    config.tables.BuildingProduceCfg.data.push({buildType:'食品厂',itemId:'成品',unlockLevel:1,produceTime:10,costItem:[['产品乙',2]]});
    const root = {buildingId:downstream.buildingId,productId:'成品',trigger:0,target:1};
    const local = {buildingId:upstream.buildingId,productId:'产品甲',trigger:0,target:1};
    Object.assign(settings.factory,{strategy,keepStock:0,demandFirst:false,refillRules:[root,local]});
    state.stock.set('产品甲',1);
    const buildings = [downstream,upstream];
    const plan = () => planWorld({now:now(),serverNow:now(),stock:state.stock,have:id => state.stock.get(id) ?? 0,
      stockKnown:true,stockCap:50,factorySlots:6,player,buildings,factories:buildings,orders:[],weekOrder:new Map(),orderOfTheDay:{},notes:[]},
      {config,settings,enabled:kind => kind === 'startProduce'});
    const supply = {actions:plan().actions.filter(s => s.refillSupply)};
    assert.deepEqual(supply.actions.map(s => s.body.productId),['产品乙','产品乙']);
    const run = () => runWorld(client,protocol,supply,{config,player,settings,allowMutate:true});
    state.stock.set('成品',1);
    assert((await run()).results.every(e => e.skipped));
    state.stock.set('成品',0); settings.factory.refillRules = [local];
    assert((await run()).results.every(e => e.skipped));
    settings.factory.refillRules = [root,local]; state.stock.set('产品甲',0);
    assert((await run()).results.every(e => e.skipped));
    assert.equal(state.writes.length,0);
    state.stock.set('产品甲',1);
    const events = new EventEmitter();
    client.on = events.on.bind(events); client.off = events.off.bind(events);
    state.afterSend = () => {
      state.stock.set('成品',1);
      events.emit('message',{name:'SCUpdateItem',body:{items:[{itemId:'成品',num:1}]}});
    };
    const result = await run();
    assert(result.results[0].ok);
    assert.equal(state.writes.length,1,'批内下游达标时，停止第二个上游派单');
    assert.equal(events.listenerCount('message'),0);
    state.afterSend = null; state.stock.set('成品',0);
    const rest = {actions:plan().actions.filter(s => s.refillSupply)};
    assert.equal(rest.actions.length,1);
    assert((await runWorld(client,protocol,rest,{config,player,settings,allowMutate:true})).results[0].ok);
    assert.equal(state.writes.length,2);
    assert(!plan().actions.some(s => s.refillSupply),'上游排足后等待入库');
  }
});

await test('原生开关优先当前产物，关闭后按相同角色与工厂恢复原目标', async () => {
  const { player, client, config, state } = fixture();
  const building = state.building;
  state.water = {autoProduceForever:true};
  const survey = {player,serverNow:now(),...state.water};
  const control = (who=player) => nativeFactoryControl(client,{...building,type:'材料厂'},{...survey,player:who},config);
  assert.equal(control().productId,'产品甲');
  building.factory.factoryQ.push({idx:1,productId:'产品乙',finishTime:now()+60});
  assert.equal(control().productId,'产品乙');
  building.factory.autoProductId = '产品乙';
  building.factory.factoryQ = [];
  const { key, productId } = control();
  client.sendWatch = async (name,body,opts) => {
    opts.beforeSend();
    const type = protocol[name], decoded = type.decode(type.encode(body).finish());
    assert.equal(name,'CancelFactoryAutoProduceRequest');
    assert.equal(decoded.buildingId,building.buildingId);
    building.factory.autoProductId = '';
  };
  const result = await toggleNativeFactory(client,protocol,{buildingId:building.buildingId,on:false,productId,key},
    {player,config,enabled:()=>true});
  assert(result.confirmed);
  assert.equal(control().productId,'产品乙');
  assert.equal(control({...player,playerId:player.playerId+1}).productId,'产品甲');
});

await test('模拟原生按仓容派单，策略、主产物或队列变化后丢弃旧计划', async () => {
  const f = fixture();
  Object.assign(f.settings.factory,{strategy:'nativeSimulation',simulatedTargets:['产品甲'],keepStock:0});
  const step = {...f.step(),factoryStrategy:'nativeSimulation',simulatedTargetsKey:'["产品甲"]',
    simulatedQueueKey:'["",[]]',demandDriven:false};
  const run = () => runWorld(f.client,protocol,{actions:[step]},{...f.options(),allowMutate:true});
  f.settings.factory.strategy='smart'; await run();
  assert.equal(f.state.writes.length,0);
  f.settings.factory.strategy='nativeSimulation'; f.settings.factory.simulatedTargets=[]; await run();
  assert.equal(f.state.writes.length,0);
  f.settings.factory.simulatedTargets=['产品甲'];
  assert((await run()).results[0].ok);
  assert.equal(f.state.writes.length,1);
  await run();
  assert.equal(f.state.writes.length,1);
});

await test('模拟原生批内先扣上游成品再补回，反向顺序仍被满仓拦截', async () => {
  for (const canStart of [true,false]) {
    const f=fixture();
    f.settings.factory.strategy='nativeSimulation';
    f.config.tables.BuildingProduceCfg.data[1].costItem=[['产品甲',1]];
    f.state.stock.set('产品甲',50);
    const ids=canStart?['产品乙','产品甲']:['产品甲','产品乙'];
    const steps=ids.map(id=>({...f.step(id),factoryStrategy:'nativeSimulation',simulatedTargetsKey:'[]',
      simulatedQueueKey:'["",[]]',demandDriven:false}));
    const result=await f.batch(steps);
    assert.equal(f.state.writes.length,canStart?2:0);
    if (canStart) assert(result.results.every(r=>r.ok));
  }
});

await test('runWorld真实入口连续六件只在批首批末查询，不再逐件等待300毫秒', async () => {
  const f = fixture(), steps = Array.from({length:6}, () => f.step()), start = performance.now();
  const result = await runWorld(f.client, protocol, { actions: steps }, { ...f.options(), allowMutate: true });
  assert.equal(f.state.writes.length, 6); assert(result.results.every(row => row.status === 'confirmed'));
  assert(result.results[0].operationId);
  assert.equal(new Set(result.results.map(row => row.operationId)).size, 1);
  assert.match(result.results[0].operationSummary, /×6/);
  assert.equal(result.results.filter(row => row.operationMember).length, 5);
  assert.equal(f.state.reads.filter(name => name === 'OnWaterRequest').length, 2);
  assert.equal(f.state.reads.filter(name => name === 'AllItemRequest').length, 2);
  assert(performance.now() - start < 1200, '六件不应有逐件300毫秒固定等待');
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('秒产直接进入待收成品仍可确认整批，批内不无限补空槽', async () => {
  const f = fixture(); f.state.instant = true;
  const result = await f.batch(); assert.equal(f.state.writes.length, 6); assert(result.results.every(row => row.ok));
  assert.equal(f.state.building.factory.finishedProducts[0].num, 6);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('升级中的已建工厂可生产当前等级配方，升级在批内竣工也可确认', async () => {
  const f = fixture();
  Object.assign(f.state.building, { level: 1, buildStartTime: now() - 30, buildFinishTime: now() + 10 });
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  assert.equal((await f.batch([f.step('产品乙')])).results[0].skipped, true);
  assert.equal(f.state.writes.length, 0);
  f.state.afterSend = () => Object.assign(f.state.building, { level: 2, buildStartTime: 0, buildFinishTime: 0 });
  const result = await f.batch([f.step()]);
  assert.equal(f.state.writes.length, 1);
  assert.equal(result.results[0].status, 'confirmed');
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('首建中的工厂即使带有空生产队列也不能下单', async () => {
  const f = fixture();
  Object.assign(f.state.building, { level: 0, buildStartTime: now() - 30, buildFinishTime: now() + 60 });
  assert.equal((await f.batch([f.step()])).results[0].skipped, true);
  assert.equal(f.state.writes.length, 0);
});
await test('单凭升级竣工不能确认未知的排产', async () => {
  const f = fixture();
  Object.assign(f.state.building, { level: 1, buildStartTime: now() - 30, buildFinishTime: now() + 10 });
  f.state.mode = 'unknown';
  f.state.failAt = 1;
  const first = await f.batch([f.step()]);
  assert.equal(first.results[0].status, 'unknown');
  Object.assign(f.state.building, { level: 2, buildStartTime: 0, buildFinishTime: 0 });
  const retry = await f.batch([f.step()]);
  assert(retry.results[0].skipped);
  assert.equal(f.state.writes.length, 1);
});
await test('runWorld仅剩一个空槽的秒产也确认成品，不残留材料锁', async () => {
  const f = fixture(); for (let i=0;i<5;i++) f.add('产品乙'); f.state.instant = true;
  const result = await runWorld(f.client, protocol, { actions: [f.step()] }, { ...f.options(), allowMutate: true });
  assert.equal(f.state.writes.length, 1); assert.equal(result.results[0].status, 'confirmed');
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('实际空槽仅四格时只发送四件，容量使用配置值', async () => {
  const f = fixture(); f.config.tables.BuildingProduceParamCfg.data[0].paramValue = 5; f.add('产品乙');
  const result = await f.batch(); assert.equal(f.state.writes.length, 4); assert.equal(result.results.filter(row => row.ok).length, 4);
});
await test('第二件明确拒绝只核对首件，未发原料不会遗留阻塞', async () => {
  const f = fixture(); f.state.mode = 'reject'; f.state.failAt = 2;
  const result = await f.batch(); assert.equal(f.state.writes.length, 2); assert.equal(result.results[0].status, 'confirmed');
  assert.equal(result.results[1].ok, false); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  f.state.mode = ''; await f.batch(); assert.equal(f.state.writes.length, 7);
});
await test('第二件明确未发送释放剩余原料，共用guard可再次排产', async () => {
  const f = fixture(); f.state.stock.set('木材', 6); f.state.mode = 'notSent'; f.state.failAt = 2;
  const guard = createActionGuard(f.client, () => f.settings, null, { player: f.player, enabled: () => f.state.active });
  const options = { beforeStep: guard.before, afterStep: guard.after, cancelStep: guard.cancel };
  const first = await f.batch(undefined, options); assert.equal(first.results[0].ok, true);
  f.state.mode = ''; const next = await f.batch(undefined, options);
  assert.equal(next.results.filter(row => row.ok).length, 5); assert.equal(f.state.stock.get('木材'), 0);
});
await test('第二件未知只保留两件消耗，重连没有证据不重发', async () => {
  const f = fixture(); f.state.mode = 'unknown'; f.state.failAt = 2;
  const first = await f.batch(); assert.equal(first.results[0].status, 'unknown');
  const pending = pendingOrderMaterialSpends(f.player); assert.equal(pending.length, 1); assert.equal(pending[0].costs[0].need, 2);
  const second = await runFactoryProductionBatch({ ...f.client }, protocol, Array.from({length:6}, () => f.step()), f.options());
  assert(second.results.every(row => row.skipped)); assert.equal(f.state.writes.length, 2);
  f.add('产品甲'); f.state.mode = ''; const recovered = await f.batch();
  assert.equal(recovered.results.filter(row => row.ok).length, 4); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('旧队列自然成熟不能证明未知的新排产', async () => {
  const f = fixture(); f.add('产品甲'); f.state.mode = 'unknown'; f.state.failAt = 1;
  f.state.afterRead = name => {
    if (name === 'OnWaterRequest' && f.state.writes.length) {
      f.state.building.factory.factoryQ = []; f.state.building.factory.finishedProducts = [{type:0,id:'产品甲',num:1}];
    }
  };
  await f.batch(); await f.batch(); assert.equal(f.state.writes.length, 1);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
});
await test('批中暂停停止后续发送；恢复时先确认已发部分再补剩余空槽', async () => {
  const f = fixture(); f.state.afterSend = count => { if (count === 2) f.state.active = false; };
  const first = await f.batch(); assert.equal(f.state.writes.length, 2); assert.equal(first.results[0].status, 'unknown');
  assert.equal(pendingOrderMaterialSpends(f.player)[0].costs[0].need, 2);
  f.state.active = true; f.state.afterSend = null;
  const next = await f.batch(); assert.equal(next.results.filter(row => row.ok).length, 4); assert.equal(f.state.writes.length, 6);
});
await test('批中关闭普通排产或切号都不会继续发后续请求', async () => {
  for (const mode of ['off','account']) {
    const f = fixture(), original = { ...f.player };
    f.state.afterSend = () => { if (mode === 'off') f.settings.factory.produce = false; else f.player.playerId++; };
    await f.batch(); assert.equal(f.state.writes.length, 1);
    if (mode === 'account') assert.equal(pendingOrderMaterialSpends(original)[0].costs[0].need, 1);
  }
});
await test('批首拒绝缺料、库存满、原生自动生产和活动未开放', async () => {
  for (const mode of ['material','cap','native','event']) {
    const f = fixture();
    if (mode === 'material') f.state.stock.set('木材', 2);
    if (mode === 'cap') f.state.stock.set('产品甲', 49);
    if (mode === 'native') { f.state.water = { autoProduceForever: true }; f.state.building.factory.autoProductId = '产品乙'; }
    if (mode === 'event') f.config.tables.BuildingProduceCfg.data[0].limitType = '活动甲';
    const result = await f.batch(); assert.equal(f.state.writes.length, 0, mode); assert(result.results.every(row => row.skipped), mode);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0, mode);
  }
});
await test('旧材料消费未确认时不可绕过共享预留', async () => {
  const f = fixture(), held = beginOrderMaterialSpend(f.player, [{ id: '木材', have: 100, need: 2 }], '旧未知消费', { operation: {confirmed:false} });
  await f.batch(); assert.equal(f.state.writes.length, 0); cancelOrderMaterialSpend(held);
});
await test('批末库存读取失败保留证据，恢复后不重发已成功部分', async () => {
  const f = fixture(); f.state.badBag = true;
  const first = await f.batch(); assert(first.results.every(row => row.status === 'unknown'));
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  f.state.badBag = false; const next = await f.batch();
  assert(next.results.every(row => row.skipped)); assert.equal(f.state.writes.length, 6);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('不同产品的同批请求以各自数量证明，不能用一种成品冒充全部', async () => {
  const f = fixture(); f.state.instant = true;
  const result = await f.batch([f.step(), f.step('产品乙'), f.step(), f.step('产品乙')]);
  assert(result.results.every(row => row.ok)); assert.deepEqual(f.state.building.factory.finishedProducts.map(row => [row.id,row.num]), [['产品甲',2],['产品乙',2]]);
});
await test('第二个并发调用被拒不能释放第一个调用的锁给第三个调用', async () => {
  const f = fixture(); let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  f.state.afterRead = async name => { if (name === 'OnWaterRequest' && !f.state.writes.length) { entered(); await hold; } };
  const first = f.batch(); await waiting;
  const second = await f.batch(), third = await f.batch();
  assert(second.results.every(row => row.skipped)); assert(third.results.every(row => row.skipped));
  assert.equal(f.state.reads.length, 1); release(); await first; assert.equal(f.state.writes.length, 6);
});
await test('外部计划重复使用同一step对象时拒绝项也不能误报为成功', async () => {
  const f = fixture(); f.state.mode = 'reject'; f.state.failAt = 2;
  const result = await f.batch(Array(6).fill(f.step()));
  assert.equal(result.results.filter(row => row.ok).length, 1); assert.equal(result.results[1].ok, false);
});
await test('无需求的备货遵守新鲜库存水位，独立需求仍能超过备货水位', async () => {
  const f = fixture(); f.settings.factory.demandFirst = false; f.settings.factory.keepStock = 10; f.state.stock.set('产品甲', 9);
  const result = await f.batch(); assert(result.results.every(row => row.skipped)); assert.equal(f.state.writes.length, 0);
  const next = await f.batch(Array.from({length:6}, () => ({ ...f.step(), demandDriven: true })));
  assert.equal(next.results.filter(row => row.ok).length, 6);
});
await test('同厂末级备货在复核时已满，前面的急单仍能提交并确认', async () => {
  const f = fixture();
  f.settings.factory.keepStock = 3;
  f.state.stock.set('产品乙', 3);
  const actions = [{ ...f.step(), demandDriven: true }, { ...f.step('产品乙'), demandDriven: false }];
  const result = await runWorld(f.client, protocol, { actions }, { ...f.options(), allowMutate: true });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].skipped, true);
  assert.deepEqual(f.state.writes.map(x => x.body.productId), ['产品甲']);
  const g = fixture();
  g.state.mode = 'reject'; g.state.failAt = 1;
  const rejected = await runWorld(g.client, protocol, { actions }, { ...g.options(), allowMutate: true });
  assert.equal(rejected.results[1].skipped, true);
  assert.equal(g.state.writes.length, 1);
});
await test('原料为零的生产未知也按账号和工厂防重', async () => {
  const f = fixture(); f.config.tables.BuildingProduceCfg.data[0].costItem = []; f.state.mode = 'unknown'; f.state.failAt = 1;
  await f.batch(); await f.batch(); assert.equal(f.state.writes.length, 1);
  f.add('产品甲'); f.state.mode = ''; const next = await f.batch();
  assert.equal(next.results.filter(row => row.ok).length, 5);
});
await test('普通排产前提高原料保留量会停下整个待发送批次', async () => {
  const f = fixture(); f.config.tables.BuildingProduceCfg.data[0].costItem = [['加速器',1]]; f.state.stock.set('加速器',100);
  f.settings.resources.keepAccelerators = 0;
  f.state.afterSend = () => { f.settings.resources.keepAccelerators = 100; };
  await f.batch(); assert.equal(f.state.writes.length, 1); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('批末水面读取短暂失败后，下一轮先确认旧批次再领取和续产', async () => {
  const f = fixture(); f.state.instant = true;
  f.state.afterRead = name => { if (name === 'OnWaterRequest' && f.state.writes.length) throw new Error('测试临时水面读取失败'); };
  const initial = await runWorld(f.client, protocol, { actions: Array.from({length:6},()=>f.step()) }, { ...f.options(), allowMutate: true });
  assert(initial.results.every(row => row.status === 'unknown')); assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  f.state.afterRead = null;
  const harvest = { kind: 'gainFactory', request: 'GainFactoryProduceRequest', response: 'GainFactoryProduceResponse', body: { buildingId: '1材料厂' } };
  const next = await runWorld(f.client, protocol, { actions: [harvest, ...Array.from({length:6},()=>f.step())] }, { ...f.options(), allowMutate: true });
  assert.equal(f.state.harvests, 1); assert.equal(f.state.writes.length, 12);
  assert(next.results.every(row => row.ok)); assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('上次排产仍缺证据时暂停领取，保留自然成熟后的旧成品', async () => {
  const f = fixture(); f.add('产品甲'); f.state.mode = 'unknown'; f.state.failAt = 1;
  await f.batch(); f.state.building.factory.factoryQ = []; f.state.building.factory.finishedProducts = [{type:0,id:'产品甲',num:1}];
  const harvest = { kind: 'gainFactory', request: 'GainFactoryProduceRequest', response: 'GainFactoryProduceResponse', body: { buildingId: '1材料厂' } };
  const next = await runWorld(f.client, protocol, { actions: [harvest, ...Array.from({length:6},()=>f.step())] }, { ...f.options(), allowMutate: true });
  assert.equal(f.state.harvests, 0); assert.equal(f.state.writes.length, 1); assert(next.results.every(row => row.skipped));
});
await test('无关零级工厂的合法空消息不阻塞已建工厂，异常产品仍保守', async () => {
  const f = fixture(); f.state.otherBuildings = [{ buildingId:'2材料厂', level:0, factory:{} }];
  const result = await f.batch(); assert.equal(result.results.filter(row => row.ok).length,6);
  const g = fixture(); g.state.otherBuildings = [{ buildingId:'2材料厂', level:0, factory:{ finishedProducts:[{type:0,id:'产品甲',num:1}] } }];
  const blocked = await g.batch(); assert.equal(g.state.writes.length,0); assert(blocked.results.every(row=>row.skipped));
});
await test('单件兼容入口的秒产也核对成品，下一次消费不会残留材料锁', async () => {
  const f = fixture(); f.state.instant = true;
  const run = () => runWorld(f.client, protocol, { actions: [f.step()] }, { ...f.options(), config: undefined, allowMutate: true });
  const first = await run();
  assert.equal(first.results[0].status, 'confirmed');
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  assert.equal((await run()).results[0].status, 'confirmed');
  assert.equal(f.state.writes.length, 2);
});
await test('单件排产首次状态读取失败或基线不完整时不发送、不留下材料锁', async () => {
  for (const failure of ['read', 'missing', 'duplicate', 'queue', 'finished']) {
    const f = fixture(), original = f.client.request.bind(f.client);
    f.client.request = async (name, body, response) => {
      if (name !== 'OnWaterRequest') return original(name, body, response);
      if (failure === 'read') throw new Error('初次工厂状态读取失败');
      if (failure === 'missing') return {};
      const value = await original(name, body, response);
      if (failure === 'duplicate') value.building.push(structuredClone(value.building[0]));
      if (failure === 'queue') value.building[0].factory.factoryQ.push({ idx: 0, finishTime: now() + 60 });
      if (failure === 'finished') value.building[0].factory.finishedProducts.push({ type: 0, id: '产品甲', num: -1 });
      return value;
    };
    const run = () => runWorld(f.client, protocol, { actions: [f.step()] }, { ...f.options(), config: undefined, allowMutate: true });
    const result = (await run()).results[0];
    assert.equal(result.skipped, true, failure);
    assert.equal(result.ok, false, failure);
    assert.equal(f.state.writes.length, 0, failure);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0, failure);
    f.client.request = original;
    assert.equal((await run()).results[0].status, 'confirmed', failure + '：读取恢复后可以正常生产');
    assert.equal(f.state.writes.length, 1, failure);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0, failure);
  }
});
await test('不耗原料的单件兼容排产也必须先读取完整工厂基线', async () => {
  const f = fixture(); f.config.tables.BuildingProduceCfg.data[0].costItem = [];
  f.state.afterRead = name => { if (name === 'OnWaterRequest') throw new Error('初次工厂状态读取失败'); };
  const result = await runWorld(f.client, protocol, { actions: [f.step()] }, {
    ...f.options(), config: undefined, getSettings: () => null, allowMutate: true,
  });
  assert.equal(result.results[0].skipped, true); assert.equal(f.state.writes.length, 0);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('单件排产核对暂时失败，收成品前恢复证据和材料结算', async () => {
  const f = fixture(); f.state.instant = true;
  f.state.afterRead = name => { if (name === 'OnWaterRequest' && f.state.writes.length) throw new Error('测试临时水面读取失败'); };
  await runWorld(f.client, protocol, { actions: [f.step()] }, { ...f.options(), config: undefined, allowMutate: true });
  assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
  const harvest = { kind: 'gainFactory', request: 'GainFactoryProduceRequest', response: 'GainFactoryProduceResponse', body: { buildingId: '1材料厂' } };
  const blocked = await runWorld(f.client, protocol, { actions: [harvest] }, { ...f.options(), allowMutate: true });
  assert.equal(blocked.results[0].skipped, true); assert.equal(f.state.harvests, 0);
  f.state.afterRead = null;
  const recovered = await runWorld(f.client, protocol, { actions: [harvest, f.step()] }, { ...f.options(), allowMutate: true });
  assert(recovered.results.every(row => row.ok));
  assert.equal(f.state.harvests, 1); assert.equal(f.state.writes.length, 2);
  assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
});
await test('生产诊断保留期待数量与前后证据，日志观察者报错不影响结果', async () => {
  const f = fixture(), diagnostics = []; f.state.instant = true;
  f.client.emit = (event, data) => { assert.equal(event, 'diagnostic'); diagnostics.push(data); throw new Error('日志观察者失败'); };
  assert((await f.batch([f.step(), f.step()])).results.every(row => row.ok));
  const verified = diagnostics.find(row => row.event === 'factory-production-verification');
  assert.equal(verified.buildingId, '1材料厂'); assert.equal(verified.confirmed, true);
  assert.deepEqual(verified.expected, { '产品甲': 2 });
  assert.deepEqual(verified.before.totals, {}); assert.deepEqual(verified.after.totals, { '产品甲': 2 });
  const g = fixture(), failures = [];
  g.client.emit = (event, data) => failures.push(data); g.state.mode = 'unknown'; g.state.failAt = 1;
  await g.batch();
  assert(failures.some(row => row.event === 'factory-production-write-stopped' && !row.notSent && !row.rejected));
  assert(failures.some(row => row.event === 'factory-production-verification' && !row.confirmed && row.expected['产品甲'] === 1));
  assert.equal(pendingOrderMaterialSpends(g.player).length, 1);
});
await test('独立募兵备料在批次中途达到上限后停止后续开工', async () => {
  const f = fixture();
  f.settings.factory.demandFirst = false;
  Object.assign(f.settings.alliance, { enabled: true, recruit: true, recruitProduction: true });
  const actions = Array.from({ length: 3 }, () => ({ ...f.step(), factoryStrategy: 'smart',
    demandDriven: true, demandSources: ['guildRecruit'] }));
  const result = await runWorld(f.client, protocol, { actions }, { ...f.options(), allowMutate: true,
    factoryPlanCurrent: () => f.state.writes.length === 0 });
  assert.equal(f.state.writes.length, 1);
  assert.equal(result.results[0].ok, true);
  assert.match(result.results[1].error, /库存或需求已变化/);
});
await test('活动备料批次中途关闭总开关后停止后续开工并结算已发送生产', async () => {
  for (const source of ['merchant', 'heroRaid']) {
    const f = fixture(); f.settings.heroRaid.enabled = true;
    const steps = Array.from({ length: 3 }, () => ({ ...f.step(), demandSources: [source] }));
    f.state.afterSend = count => {
      if (count === 1) f.settings[source === 'merchant' ? 'weekOrder' : 'heroRaid'].enabled = false;
    };
    await f.batch(steps);
    assert.equal(f.state.writes.length, 1, source);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0, source);
  }
});
console.log('生产批次专项 ' + passed + '/' + passed + ' 通过');
