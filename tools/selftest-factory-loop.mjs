// 独立生产调度集成测试：真实 runLoop、虚构客户端与虚拟时钟。
// 默认验证真实协议编解码；--offline 显式使用消息白名单验证调度行为。
// 必须在任何业务模块加载前隔离数据目录，不连接游戏或现有控制台。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-factory-loop-'));
const originalDataDir = process.env.CW_DATA_DIR, originalNow = Date.now;
process.env.CW_DATA_DIR = folder;
const base = Date.UTC(2026, 10, 14, 4);
let wall = base, serial = 0;
Date.now = () => wall;
const results = [];

try {
  const { runLoop } = await import('../src/loop.mjs');
  const { loadProtocol } = await import('../src/proto.mjs');
  const { defaultSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
  const protocol = process.argv.includes('--offline') ? createDeclaredProtocol([
    'OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse',
    'AllResourceRequest', 'AllResourceResponse', 'MyResFieldsRequest', 'MyResFieldsResponse',
    'MyFleetsRequest', 'MyFleetsResponse', 'WeekInfoRequest', 'WeekInfoResponse',
    'GuildInfoRequest', 'GuildInfoResponse', 'GainFactoryProduceRequest', 'GainFactoryProduceResponse',
    'StartFactoryProduceRequest', 'GameEffectRequest', 'GameEffectResponse',
    'CargoShipsRequest', 'CargoShipsResponse', 'FillCargoShipRequest', 'FillCargoShipResponse',
    'WeekOrderInfoRequest', 'WeekOrderInfoResponse', 'DenyOrderRequest', 'SCUpdateItem', 'SCUpdateWaterBuilding',
  ]) : loadProtocol();

  function integration({ rounds = 2, mainEveryMs = 3600000, cli = false, offset = 0, finishAfterMs = 5000, fallbackSeconds = 30, pushUpdates = false } = {}) {
    const settings = defaultSettings();
    const disable = value => {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'boolean') value[key] = false;
        else if (item && typeof item === 'object') disable(item);
      }
    };
    disable(settings);
    Object.assign(settings.loop, { world: true, everySeconds: mainEveryMs / 1000 });
    Object.assign(settings.factory, { enabled: true, gain: true, produce: true, demandFirst: false, keepStock: 10, checkEverySeconds: fallbackSeconds });
    const player = { playerId: 32300000 + (++serial), worldId: 1, guildId: 1, level: 40, vip: { vipLevel: 0 } };
    const config = { tables: {
      BuildingCfg: { data: [{ buildingType: '材料厂' }] },
      BuildingProduceCfg: { data: [{ buildType: '材料厂', itemId: '产品甲', unlockLevel: 1, produceTime: 120, costItem: [['木材', 1]] }] },
      BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 1 }] },
      GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 50 }] },
      ModuleOpenCfg: { data: [{ moduleId: '联盟', playerLevel: 1 }] },
    } };
    const ledger = createUsageLedger('虚构生产调度账号-' + serial, { file: path.join(folder, serial + '.json') });
    const controller = new AbortController(), stop = controller.signal;
    const flags = new Set(['collect', 'startProduce']);
    const sleeps = [], reports = [], roundsDone = [], protocolCalls = [], protocolErrors = [], violations = [];
    const state = { stock: new Map([['木材', 100]]),
      building: { buildingId: '1材料厂', level: 10, factory: { factoryQ: [{ idx: 0, productId: '产品甲',
        ...(finishAfterMs == null ? {} : { finishTime: Math.floor((base + offset + finishAfterMs) / 1000) }) }], finishedProducts: [] } } };
    // 完整循环会安装各业务的连接级推送观察器；与 GameClient 一样允许多个模块订阅。
    const client = new EventEmitter(); client.setMaxListeners(50);
    Object.assign(client, { connected: true, festivals: [], serverClockOffsetMs: offset });
    let currentSettings = settings, active = false, scheduled = 0, readsInFlight = 0, writesInFlight = 0;
    let queue = Promise.resolve(), sleepHook, beforeRead, afterWrite, reportHook, roundHook;
    const codec = (name, value) => {
      const type = protocol[name]; assert(type, '测试协议必须明确声明：' + name);
      return type.decode(type.encode(value).finish());
    };
    const finish = () => {
      const q = state.building.factory.factoryQ;
      if (!q.length) return;
      let product = state.building.factory.finishedProducts.find(row => row.id === '产品甲');
      if (!product) { product = { type: 0, id: '产品甲', num: 0 }; state.building.factory.finishedProducts.push(product); }
      product.num += q.length; q.length = 0;
    };
    const mature = () => {
      const q = state.building.factory.factoryQ;
      if (q.length && q.every(row => row.finishTime > 0 && row.finishTime * 1000 <= wall + offset)) finish();
    };
    const schedule = work => {
      const job = queue.then(async () => {
        if (active) violations.push('同账号队列任务重入');
        assert.equal(active, false, '同账号不能同时执行两个队列任务');
        active = true; scheduled++;
        try { return await work(); } finally { active = false; }
      });
      queue = job.catch(() => {}); return job;
    };
    const enter = (method, name, body, write) => {
      if (!active) violations.push(name + '绕过账号队列');
      if (writesInFlight || write && readsInFlight) violations.push(name + '与其他协议重叠');
      assert.equal(active, true, '所有生产读写必须经同账号队列');
      assert.equal(writesInFlight, 0, '生产写协议期间不能重入协议');
      if (write) { assert.equal(readsInFlight, 0, '生产写入不能与读取交叉'); writesInFlight++; }
      else readsInFlight++;
      protocolCalls.push({ method, name, body, at: wall, job: scheduled });
    };
    const leave = write => { if (write) writesInFlight--; else readsInFlight--; };
    const pushStock = ids => {
      if (pushUpdates) client.emit('message', { name: 'SCUpdateItem', body: codec('SCUpdateItem', {
        items: ids.map(itemId => ({ itemId, num: state.stock.get(itemId) ?? 0 })),
      }) });
    };
    const pushFactory = building => {
      if (pushUpdates) client.emit('message', { name: 'SCUpdateWaterBuilding', body: codec('SCUpdateWaterBuilding', { building: [building] }) });
    };
    client.request = async (name, body = {}, response = name.replace(/Request$/, 'Response'), timeout, beforeSend) => {
      beforeSend?.();
      const write = ['GainFactoryProduceRequest', 'FillCargoShipRequest'].includes(name); enter('request', name, body, write);
      try {
        codec(name, body); await beforeRead?.(name); mature();
        let result;
        if (name === 'OnWaterRequest') result = { building: [state.building, ...(state.otherBuildings ?? [])], workerOrder: state.orders ?? [] };
        else if (name === 'AllItemRequest') result = { items: [...state.stock].map(([itemId, num]) => ({ itemId, num })) };
        else if (name === 'AllResourceRequest') result = { list: [] };
        else if (name === 'GameEffectRequest') result = { effects: [{ id: 1, value: 0 }, { id: 2, value: 0 }] };
        else if (name === 'MyResFieldsRequest') result = { fields: [] };
        else if (name === 'MyFleetsRequest') result = { fleets: [] };
        else if (name === 'WeekInfoRequest') result = { activityTime: [] };
        else if (name === 'CargoShipsRequest') result = { ship: state.ships ?? [] };
        else if (name === 'FillCargoShipRequest') {
          const ship = state.ships.find(row => row.index === body.shipIndex);
          assert.deepEqual(body.cargoIndex, [1]);
          assert.equal(ship.status, 0);
          assert.equal(state.stock.get('产品甲'), 1);
          state.stock.set('产品甲', 0);
          ship.orderItem[0].filled = true;
          ship.status = 1;
          result = {};
        }
        else if (name === 'GuildInfoRequest') result = { guild: { guildId: 1, welfarePack: [], gotWelfareTime: 0 }, gotTitle: 0, gotTitleTime: 0 };
        else if (name === 'GainFactoryProduceRequest') {
          const assets = state.building.factory.finishedProducts;
          result = { products: { asset: structuredClone(assets) } };
          for (const row of assets) state.stock.set(row.id, (state.stock.get(row.id) ?? 0) + row.num);
          state.building.factory.finishedProducts = [];
          pushStock(assets.map(row => row.id)); pushFactory(state.building);
          await afterWrite?.(name);
        } else throw new Error('禁止未声明协议：' + name);
        const reply = codec(response, result);
        if (pushUpdates) client.emit('message', { name: response, body: reply });
        return reply;
      } catch (error) { protocolErrors.push({ name, message: error.message }); throw error; }
      finally { leave(write); }
    };
    client.sendWatch = async (name, body, options = {}) => {
      options.beforeSend?.();
      enter('sendWatch', name, body, true);
      try {
        const request = codec(name, body);
        if (name === 'DenyOrderRequest') {
          assert(state.orders.some(order => order.index === request.index));
          return { seq: protocolCalls.length };
        }
        assert.equal(name, 'StartFactoryProduceRequest');
        assert.deepEqual(Object.keys(request).sort(), ['buildingId', 'productId']);
        const building = [state.building, ...(state.otherBuildings ?? [])].find(row => row.buildingId === body.buildingId);
        assert(building.factory.factoryQ.length < Number(config.tables.BuildingProduceParamCfg.data[0].paramValue), '不能重复占用生产槽位');
        const costs = config.tables.BuildingProduceCfg.data.find(row => row.itemId === body.productId).costItem;
        for (const [id, num] of costs) state.stock.set(id, (state.stock.get(id) ?? 0) - num);
        building.factory.factoryQ.push({ idx: Math.max(-1, ...building.factory.factoryQ.map(row => row.idx ?? 0)) + 1,
          productId: request.productId, ...(building.factory.factoryQ.length ? {} : { finishTime: Math.floor((wall + offset) / 1000) + 120 }) });
        for (const [id] of costs) pushStock([id]);
        pushFactory(building);
        await afterWrite?.(name); return { seq: protocolCalls.length };
      } catch (error) { protocolErrors.push({ name, message: error.message }); throw error; }
      finally { leave(true); }
    };
    const run = async (options = {}) => {
      const result = await runLoop(client, protocol, {
        config, player, rounds, everyMs: mainEveryMs, getEveryMs: () => mainEveryMs,
        allowMutate: true, ...(cli ? {} : { isEnabled: key => flags.has(key) }),
        getSettings: () => currentSettings, usageLedger: ledger, stop, schedule, ...options,
        sleep: async ms => {
          assert(ms > 0, '生产调度不能零毫秒忙轮询');
          sleeps.push(ms); assert(sleeps.length < 100, '调度等待应有界');
          if (sleepHook) await sleepHook(ms, sleeps.length); else wall += ms;
        },
        onStep: row => { reports.push(row); reportHook?.(row); },
        onRound: row => { roundsDone.push(row); roundHook?.(row); },
      });
      await queue; return result;
    };
    const clean = async () => {
      assert.deepEqual(violations, [], '协议不得并行或绕过账号队列');
      assert.deepEqual(protocolErrors, [], '不得将未声明协议错误吞进循环备注');
      assert.deepEqual(reports.filter(row => row.error && !row.skipped), [], '不得吞掉执行错误');
      assert.equal(client.listenerCount('automationSettingsChanged'), 0, '循环结束应移除配置监听');
      const count = protocolCalls.length;
      client.emit('automationSettingsChanged');
      for (let n = 0; n < 10; n++) client.emit('message', { name: 'SCUpdateWaterBuilding', body: { building: [state.building] } });
      await Promise.resolve(); await Promise.resolve(); await queue;
      assert.equal(protocolCalls.length, count, '退出后的配置与推送不能再发送协议');
    };
    return { client, state, settings, config, flags, stop, sleeps, reports, roundsDone, protocolCalls, finish, schedule, run, clean,
      abort: () => controller.abort(), getSettings: () => currentSettings, setSettings: value => { currentSettings = value; },
      scheduled: () => scheduled, isScheduled: () => active,
      sleepHook: fn => { sleepHook = fn; }, beforeRead: fn => { beforeRead = fn; }, afterWrite: fn => { afterWrite = fn; },
      reportHook: fn => { reportHook = fn; }, roundHook: fn => { roundHook = fn; } };
  }
  const test = async (name, work) => {
    wall = base;
    try { await work(); results.push(true); console.log('通过：' + name); }
    catch (error) { results.push(false); console.error('失败：' + name + '\n' + error.stack); }
  };
  const writes = f => f.protocolCalls.filter(row => ['GainFactoryProduceRequest', 'StartFactoryProduceRequest'].includes(row.name));
  const stopAfterRefill = f => f.reportHook(row => { if (row.step?.kind === 'startProduce' && row.status === 'confirmed') f.abort(); });

  for (const harvest of [false, true]) await test('真实扣料推送不打断同批和后续工厂，保留已开工任务' + (harvest ? '，收货后本轮续产' : ''), async () => {
    const f = integration({ rounds: 1, pushUpdates: true, finishAfterMs: 600000 });
    f.settings.factory.demandFirst = true;
    f.settings.factory.demandPriority = ['factory'];
    f.config.tables.BuildingProduceParamCfg.data[0].paramValue = 3;
    const running = structuredClone(f.state.building.factory.factoryQ[0]);
    const other = structuredClone(f.state.building); other.buildingId = '2材料厂';
    f.state.otherBuildings = [other];
    f.state.building.factory.factoryQ = [];
    if (harvest) f.state.building.factory.finishedProducts = [{ type: 0, id: '产品甲', num: 1 }];
    await f.run();
    assert.equal(writes(f).filter(row => row.name === 'StartFactoryProduceRequest').length, 5, '空厂应填满三格，另一厂保留在产并补两格：' + JSON.stringify(f.reports.filter(row => row.error || row.skipped).map(row => row.error ?? row.reason)));
    assert.equal(f.state.building.factory.factoryQ.length, 3);
    assert.equal(other.factory.factoryQ.length, 3);
    assert.deepEqual(other.factory.factoryQ[0], running, '既有开工项不得取消或改动');
    assert.equal(f.state.stock.get('木材'), 95);
    assert.equal(f.state.stock.get('产品甲') ?? 0, harvest ? 1 : 0);
    assert(!f.reports.some(row => /库存或需求已变化/.test(row.error ?? row.reason ?? '')));
    await f.clean();
  });

  await test('轮间巡检收货后多原料分包扣减仍连续补满生产格', async () => {
    const f = integration({pushUpdates:true});
    Object.assign(f.settings.factory,{demandFirst:true,demandPriority:['factory']});
    f.config.tables.BuildingProduceParamCfg.data[0].paramValue = 3;
    f.config.tables.BuildingProduceCfg.data[0].costItem = [['鱼',1],['木材',5]];
    f.state.stock.set('鱼',5914); f.state.stock.set('木材',5630);
    const running = f.state.building.factory.factoryQ[0];
    f.state.building.factory.factoryQ = [0,1,2].map(idx => ({...running,idx}));
    stopAfterRefill(f);
    await f.run();
    assert.equal(f.roundsDone.length,1,'应由轮间巡检续产，不等待下一主轮');
    assert.deepEqual(writes(f).map(row=>row.name),['GainFactoryProduceRequest',...Array(3).fill('StartFactoryProduceRequest')]);
    assert.equal(f.state.building.factory.factoryQ.length,3);
    assert.equal(f.state.stock.get('鱼'),5911); assert.equal(f.state.stock.get('木材'),5615);
    assert(!f.reports.some(row=>/库存或需求已变化/.test(row.error??'')));
    await f.clean();
  });

  await test('收货途中新增完工产品时及时重新排产，保留在产并恢复补库', async () => {
    const f = integration({pushUpdates:true,finishAfterMs:1000});
    Object.assign(f.settings.factory,{demandFirst:true,demandPriority:['factory']});
    f.config.tables.BuildingProduceParamCfg.data[0].paramValue = 3;
    f.state.building.factory.finishedProducts = [{type:0,id:'产品甲',num:1}];
    let extraFinished = false;
    f.beforeRead(name=>{if(name==='GainFactoryProduceRequest'&&!extraFinished){extraFinished=true;wall+=1000;}});
    stopAfterRefill(f);
    await f.run();
    assert.equal(f.state.stock.get('产品甲'),2,'收取规划后才完成的产品');
    assert.equal(f.state.building.factory.factoryQ.length,3,'补足生产格，不因收货变化持续空闲');
    assert.equal(writes(f).filter(row=>row.name==='StartFactoryProduceRequest').length,3);
    assert(writes(f).at(-1).at<=base+3000,'新增收货使计划失效后应立即复查，不等下一主轮');
    await f.clean();
  });

  for (const change of ['stock','order']) await test('正常扣料期间出现真实' + (change === 'stock' ? '额外消耗' : '订单变化') + '仍暂停旧排产', async () => {
    const f = integration({rounds:1,pushUpdates:true});
    Object.assign(f.settings.factory,{demandFirst:true,demandPriority:['factory']});
    f.config.tables.BuildingProduceParamCfg.data[0].paramValue = 3;
    f.state.building.factory.factoryQ = [];
    f.afterWrite(name => {
      if (name !== 'StartFactoryProduceRequest') return;
      if (change === 'stock') {
        f.state.stock.set('木材',f.state.stock.get('木材') - 10);
        f.client.emit('message',{name:'SCUpdateItem',body:{items:[{itemId:'木材',num:f.state.stock.get('木材')}]}});
      } else f.client.emit('message',{name:'SCWorkerOrder',body:{}});
    });
    await f.run();
    assert.equal(writes(f).length,1);
    assert.equal(f.state.building.factory.factoryQ.length,1,'已发送的生产保留');
    assert(f.reports.some(row => /库存或需求已变化/.test(row.error ?? '')));
    await f.clean();
  });

  await test('没有任何订单也补至库存水位，计入在产和待收，现货消耗后重新补库', async () => {
    const f = integration({rounds:1,pushUpdates:true});
    Object.assign(f.settings.factory,{demandFirst:true,demandPriority:['cargo','resident','factory'],keepStock:3});
    f.config.tables.BuildingProduceParamCfg.data[0].paramValue = 6;
    f.state.building.factory.factoryQ = [];
    await f.run();
    assert.equal(writes(f).length,3,'没有订单也应连续安排三件补库');
    await f.run();
    assert.equal(writes(f).length,3,'三件在产已经覆盖水位，不再生产');
    f.finish();
    await f.run();
    assert.equal(writes(f).length,4,'只收取成品，待收和已入库都不能重复补');
    assert.equal(f.state.stock.get('产品甲'),3);
    f.state.stock.set('产品甲',1);
    await f.run();
    assert.equal(writes(f).length,6,'现货少两件后自动补两件');
    assert.equal(f.state.building.factory.factoryQ.length,2);
    await f.clean();
  });

  await test('主循环一小时时仍按实际完工时间与服务端时差及时收货补产', async () => {
    const f = integration({ offset: 2000 }); stopAfterRefill(f);
    await f.run();
    assert.deepEqual(writes(f).map(row => row.name), ['GainFactoryProduceRequest', 'StartFactoryProduceRequest']);
    assert(writes(f)[0].at >= base + 5000 && writes(f)[0].at <= base + 6000, '应在五秒完工附近收货，不能等待主轮或三十秒兜底');
    assert.equal(f.roundsDone.length, 1, '辅助生产检查不能推进主轮计数');
    assert(f.scheduled() >= 2); await f.clean();
  });
  await test('轮间收取最后一件货时立即装船', async () => {
    const f = integration();
    f.settings.cargo.enabled = true; f.flags.add('cargo');
    f.state.ships = [{ index: 1, status: 0, orderItem: [{ filled: false, asset: { type: 0, id: '产品甲', num: 1 } }] }];
    f.sleepHook(ms => { if (wall >= base + 5000) f.abort(); else wall += ms; });
    await f.run();
    const loads = f.protocolCalls.filter(row => row.name === 'FillCargoShipRequest');
    assert.equal(loads.length, 1);
    const gain = f.protocolCalls.find(row => row.name === 'GainFactoryProduceRequest');
    assert.equal(loads[0].job, gain.job, '收取成品和装船应在同一次账号调度中完成');
    assert(loads[0].at >= base + 5000 && loads[0].at <= base + 6000);
    assert.equal(f.roundsDone.length, 1);
    await f.clean();
  });
  for (const factoryEnabled of [true, false]) await test('订单推送唤醒巡检并按材料规则换单，工厂' + (factoryEnabled ? '在产' : '关闭'), async () => {
    const f = integration({ finishAfterMs: 600000, fallbackSeconds: 300 });
    f.settings.resident.enabled = f.settings.resident.skipProduction = true;
    f.settings.factory.enabled = factoryEnabled;
    f.settings.factory.keepStock = 0;
    f.flags.add('finishOrder'); f.flags.add('denyOrder');
    f.sleepHook((ms, i) => {
      if (i === 1) {
        wall += 1000;
        f.state.orders = [{ index: 1, workerId: 8, requirements: [{ id: '产品甲', num: 1 }] }];
        f.client.emit('message', { name: 'SCWorkerOrder', body: { order: f.state.orders } });
      } else wall += ms;
    });
    f.reportHook(entry => { if (entry.step?.kind === 'denyOrder' && entry.ok) f.abort(); });
    await f.run();
    const denials = f.protocolCalls.filter(row => row.name === 'DenyOrderRequest');
    assert.equal(denials.length, 1);
    assert(denials[0].at <= base + 3000);
    assert.equal(writes(f).length, 0, '等待中的居民订单不能催生额外排产');
    await f.clean();
  });
  await test('模拟原生在首轮和完工补产时只需生产数据，即使设置保留了按订单优先', async () => {
    const f = integration();
    Object.assign(f.settings.factory, {strategy:'nativeSimulation', demandFirst:true, demandPriority:['cargo','factory']});
    stopAfterRefill(f);
    await f.run();
    assert.deepEqual(writes(f).map(row => row.name), ['GainFactoryProduceRequest','StartFactoryProduceRequest']);
    assert(!f.protocolCalls.some(row => ['WeekInfoRequest','WeekOrderInfoRequest','CargoShipsRequest'].includes(row.name)));
    await f.clean();
  });
  await test('缺少完工时间时按用户设置的七秒周期兜底检查', async () => {
    const f = integration({ finishAfterMs: null, fallbackSeconds: 7 }); stopAfterRefill(f);
    f.sleepHook(ms => { wall += ms; if (wall >= base + 7000) f.finish(); });
    await f.run();
    assert.equal(f.sleeps[0], 7000); assert.equal(writes(f)[0].at, base + 7000);
    assert.equal(writes(f).length, 2); await f.clean();
  });
  await test('三十秒升级巡检不会延后一百二十秒的生产兜底期限', async () => {
    const f = integration({ mainEveryMs: 600000, fallbackSeconds: 120 }); stopAfterRefill(f);
    f.state.building.factory.factoryQ = []; f.state.stock.set('木材', 0);
    Object.assign(f.settings.building, { enabled: true, upgrade: true }); f.flags.add('upgrade');
    f.sleepHook(ms => { wall += ms; if (wall > base + 30000) f.state.stock.set('木材', 100); });
    await f.run();
    assert.deepEqual(writes(f).map(row => row.name), ['StartFactoryProduceRequest']);
    assert.equal(writes(f)[0].at, base + 120000, '升级只读巡检不能不断推迟工厂补料期限');
    assert(f.sleeps.filter(ms => ms === 30000).length >= 4); await f.clean();
  });
  await test('工厂推送风暴提前唤醒，回调不发协议且在途推送不重复排产', async () => {
    const f = integration({ finishAfterMs: 600000, fallbackSeconds: 300 }); stopAfterRefill(f);
    const storm = () => {
      const count = f.protocolCalls.length;
      for (let n = 0; n < 30; n++) f.client.emit('message', { name: 'SCUpdateWaterBuilding', body: { building: [f.state.building] } });
      assert.equal(f.protocolCalls.length, count, '推送回调只能安排检查');
    };
    f.sleepHook((ms, index) => { if (index === 1) { wall += 1000; f.finish(); storm(); } else wall += ms; });
    f.afterWrite(storm);
    await f.run();
    assert.equal(writes(f).length, 2); assert(writes(f)[0].at <= base + 3000);
    await f.clean();
  });
  await test('配置启用会提前唤醒，读取期间关闭则取消尚未发送的生产', async () => {
    const f = integration(); f.settings.factory.enabled = false; f.finish(); stopAfterRefill(f);
    f.sleepHook((ms, index) => {
      if (index === 1) {
        wall += 1000; const next = structuredClone(f.getSettings()); next.factory.enabled = true; f.setSettings(next);
        const count = f.protocolCalls.length; f.client.emit('automationSettingsChanged');
        assert.equal(f.protocolCalls.length, count, '保存事件不能直接发送生产协议');
      } else wall += ms;
    });
    await f.run(); assert.equal(writes(f).length, 2); assert(writes(f)[0].at <= base + 3000); await f.clean();

    wall = base;
    const g = integration({ rounds: 1 }); g.finish(); let changed = false;
    g.beforeRead(name => {
      if (name === 'OnWaterRequest' && !changed) {
        changed = true; const next = structuredClone(g.getSettings()); next.factory.enabled = false; g.setSettings(next);
        g.client.emit('automationSettingsChanged');
      }
    });
    await g.run(); assert(changed); assert.equal(writes(g).length, 0); await g.clean();
  });
  await test('耗时业务结束的安全检查点先收货补产，再执行后续业务', async () => {
    const f = integration({ mainEveryMs: 1000 }); let guildReads = 0;
    f.roundHook(row => { if (row.round === 1) { f.flags.add('guildWelfare'); f.flags.add('guildTitleReward'); } });
    f.beforeRead(name => { if (name === 'GuildInfoRequest' && ++guildReads === 1) wall += 10000; });
    await f.run();
    const guild = f.protocolCalls.map((row, index) => ({ ...row, index })).filter(row => row.name === 'GuildInfoRequest');
    const gain = f.protocolCalls.findIndex(row => row.name === 'GainFactoryProduceRequest');
    assert.equal(guild.length, 2); assert(gain > guild[0].index && gain < guild[1].index, '工厂检查应插在完整业务之后、下个业务之前');
    assert.equal(writes(f).length, 2); assert.equal(writes(f)[0].job, guild[0].job, '主轮检查点直接复用当前账号队列，不嵌套排队');
    assert.equal(f.roundsDone.length, 2); await f.clean();
  });
  await test('命令行未传isEnabled也会在主轮之间独立检查生产', async () => {
    const f = integration({ cli: true }); stopAfterRefill(f);
    await f.run(); assert.equal(writes(f).length, 2); assert(writes(f)[0].at <= base + 6000);
    assert.equal(f.roundsDone.length, 1); await f.clean();
  });
  await test('命令行沿用账号禁止领取的建筑类型，仍可继续排产', async () => {
    const f = integration({ cli: true, rounds: 1 });
    f.finish();
    await f.run({ getBlockedCollectionTypes: () => ['材料厂'] });
    assert.deepEqual(writes(f).map(row => row.name), ['StartFactoryProduceRequest']);
    assert(f.state.building.factory.finishedProducts.some(item => item.id === '产品甲'));
    await f.clean();
  });
  await test('暂停或断线终止连接轮次后不会残留生产检查', async () => {
    for (const disconnected of [false, true]) {
      wall = base; const f = integration();
      f.sleepHook(() => {
        wall += 1000; f.finish();
        if (disconnected) { f.client.connected = false; f.client.emit('close'); }
        else f.abort();
        f.client.emit('message', { name: 'SCUpdateWaterBuilding', body: { building: [f.state.building] } });
      });
      await f.run(); assert.equal(writes(f).length, 0); await f.clean();
    }
  });
  await test('有限一轮完成即退出，不因生产计时器继续等待或后台运行', async () => {
    const f = integration({ rounds: 1 });
    f.settings.factory.cooperateNative = true;
    const result = await f.run(); assert.equal(result.history.length, 1); assert.deepEqual(f.sleeps, []);
    assert(f.reports.some(row => row.taskKey === 'nativeProduce' && row.reason === '当前没有开启原生自动生产的工厂'));
    assert.equal(writes(f).length, 0); f.finish(); await f.clean();
  });

  console.log('独立生产调度集成测试：' + results.filter(Boolean).length + '/' + results.length + ' 项通过');
  if (results.some(result => !result)) process.exitCode = 1;
} finally {
  Date.now = originalNow;
  if (originalDataDir === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalDataDir;
  fs.rmSync(folder, { recursive: true, force: true });
}
