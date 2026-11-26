import assert from 'node:assert/strict';
import { createHomelandHarness, createHomelandClient } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness();
const { readHomeland, executeHomeland, runHomeland } = await import('../src/homeland.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { runLoop } = await import('../src/loop.mjs');
const { createUsageLedger, defaultSettings, validateSettings, importAutomationSettings, SETTINGS_FORMAT } = await import('../src/automation-settings.mjs');
const read = f => readHomeland(f.client, h.config, f.options);
const execute = async (f, kind, extra = {}) => {
  const view = await read(f), action = view.actions.find(row => row.kind === kind && !row.reason);
  assert(action, JSON.stringify(view.actions));
  return executeHomeland(f.client, h.config, { ...f.options, ...action, ...extra,
    guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config: h.config, enabled: f.options.enabled }) });
};
let passed = 0;
async function test(name, body) { await body(); passed++; console.log('通过：' + name); }
try {
  await test('旧设置迁移后家园保持关闭，严格验证预算与间隔', async () => {
    const old = defaultSettings(); delete old.homeland;
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 71, settings: old });
    for (const [key, value] of Object.entries(migrated.homeland)) if (typeof value === 'boolean') assert.equal(value, false, key);
    const invalid = defaultSettings(); invalid.homeland.checkEverySeconds = 1; assert.throws(() => validateSettings(invalid));
    invalid.homeland.checkEverySeconds = 30; invalid.homeland.dailyCoinLimit = -1; assert.throws(() => validateSettings(invalid));
  });
  await test('真实协议只读预览使用累计消费，正确还原家具上限和锁定棋子', async () => {
    const f = h.fixture(); f.state.coins = 10000;
    const view = await read(f); assert.equal(view.spent, 100); assert.equal(view.capacity, 18);
    assert.match(view.actions.find(row => row.kind === 'upgrade').reason, /累计消费/);
    assert.equal(view.orders[0].requirements[0].board, 1); assert.equal(f.state.writes.length, 0);
    f.client.protocol = {}; assert.equal((await read(f)).available, false);
  });
  await test('免费体力与免费宝箱领取一次，过期页面不能重复执行或购买付费货', async () => {
    const f = h.fixture(), view = await read(f), action = view.actions.find(row => row.kind === 'freeStamina');
    assert.equal((await execute(f, 'freeStamina')).status, 'confirmed');
    assert.equal(f.state.stamina, 110);
    const guard = createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player });
    assert.equal((await executeHomeland(f.client, h.config, { ...f.options, ...action, guard })).status, 'rejected');
    assert.equal((await execute(f, 'freeBox')).status, 'confirmed');
    assert.equal(f.state.bought, 1); assert.equal(f.state.coins, 200);
  });
  await test('科技消费、每日预算和保留量，升级不会再扣累计消费门槛', async () => {
    const f = h.fixture(); f.settings.homeland.dailyCoinLimit = 50;
    assert.equal((await execute(f, 'tech')).status, 'confirmed');
    assert.equal(f.state.coins, 150); assert.equal(f.state.spent, 150); assert.equal(f.ledger.snapshot().counters.homelandCoins, 50);
    assert.match((await read(f)).actions.find(row => row.kind === 'tech').reason, /预算/);
    f.settings.homeland.dailyCoinLimit = 500; f.settings.homeland.keepCoins = 140;
    assert.match((await read(f)).actions.find(row => row.kind === 'tech').reason, /保留/);
    f.state.spent = 250; f.state.coins = 0;
    assert.equal((await execute(f, 'upgrade')).status, 'confirmed'); assert.equal(f.state.home.level, 3); assert.equal(f.state.coins, 0);
  });
  await test('打扫独立消费且不增长升级计数，楼层达标才开放', async () => {
    const f = h.fixture(); assert.equal((await execute(f, 'clean')).status, 'confirmed');
    assert.equal(f.state.coins, 197); assert.equal(f.state.spent, 100);
    assert((await read(f)).actions.find(row => row.kind === 'unlockFloors').reason);
    f.state.home.level = 3; assert.equal((await execute(f, 'unlockFloors')).status, 'confirmed'); assert.equal(f.state.home.floor, 2);
  });
  await test('现货交单与仓库取出不会消费锁定物品，不同批次同一订单仍可完成', async () => {
    const f = h.fixture(); assert.equal((await execute(f, 'submitOrders')).status, 'confirmed');
    assert(f.state.cells[2].piece);
    f.state.orders = [{ slot: 0, orderId: 11, kind: 2, orderType: 0, expireTs: 0, reqs: [{ pieceCfgId: '鱼1', count: 1 }] }];
    f.state.cells[0].piece = { uid: 10, pieceCfgId: '鱼1' };
    assert.equal((await execute(f, 'submitOrders')).status, 'confirmed');
    f.state.orders = [{ slot: 1, orderId: 12, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }];
    assert((await read(f)).actions.find(row => row.kind === 'submitOrders').reason);
    assert.equal((await execute(f, 'takeWarehouse')).status, 'confirmed');
    assert.equal((await execute(f, 'submitOrders')).status, 'confirmed'); assert(f.state.cells[2].piece);
  });
  await test('断线未知消费跨重连及跨日保留，业务和库存都同步后恢复', async () => {
    const f = h.fixture('pending'); f.state.drop = 'HomelandTechUpRequest';
    assert.equal((await execute(f, 'tech')).status, 'pending');
    assert.equal(f.ledger.snapshot().uncertain, 1);
    const replacement = createHomelandClient(h.protocol, 1, f.state).client;
    replacement.serverClockOffsetMs = 86400000; f.client = replacement;
    f.ledger = createUsageLedger('pending', { now: () => Date.now() + replacement.serverClockOffsetMs }); f.options.ledger = f.ledger;
    assert.equal((await read(f)).pending.length, 1);
    f.state.home.techLevel = 1; f.state.spent = 150; // A stale bag cannot release the write.
    assert.equal((await read(f)).pending.length, 1);
    f.state.coins = 150; f.state.drop = null;
    assert.equal((await execute(f, 'clean')).status, 'confirmed');
    assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.state.writes.filter(row => row.name === 'HomelandTechUpRequest').length, 1);
  });
  await test('订单过期不是交单成功证据，必须同时核对所需棋子消耗', async () => {
    const f = h.fixture(); f.state.drop = 'DualCombineSubmitOrderRequest';
    assert.equal((await execute(f, 'submitOrders')).status, 'pending');
    f.state.orders = []; assert.equal((await read(f)).pending.length, 1);
    delete f.state.cells[0].piece; f.state.drop = null;
    assert.equal((await execute(f, 'freeStamina')).status, 'confirmed'); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('发送前暂停、预算降低和明确拒绝释放占用，回执丢失可回读确认', async () => {
    const f = h.fixture(); f.state.beforeWrite = () => { f.enabled = false; };
    assert.equal((await execute(f, 'tech')).status, 'cancelled'); assert.equal(f.state.writes.length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
    f.enabled = true; f.state.beforeWrite = () => { f.settings.homeland.dailyCoinLimit = 0; };
    assert.equal((await execute(f, 'tech')).status, 'cancelled'); assert.equal(f.state.writes.length, 0);
    f.state.beforeWrite = null; f.settings.homeland.dailyCoinLimit = 500; f.state.reject = 'HomelandTechUpRequest';
    assert.equal((await execute(f, 'tech')).status, 'rejected'); assert.equal(f.ledger.snapshot().uncertain, 0);
    f.state.reject = null; f.state.drop = 'after:HomelandTechUpRequest';
    assert.equal((await execute(f, 'tech')).status, 'confirmed');
  });
  await test('自动化受总开关、细项和目标约束，免费任务完成后停止当日读取', async () => {
    const f = h.fixture(); assert.deepEqual(await runHomeland(f.client, h.config, f.options), []);
    Object.assign(f.settings.homeland, { enabled: true, freeStamina: true, freeBox: true });
    await runHomeland(f.client, h.config, f.options);
    assert.equal(f.state.writes.length, 2); const calls = f.state.calls.length;
    f.client.serverClockOffsetMs += 600000;
    await runHomeland(f.client, h.config, f.options); assert.equal(f.state.calls.length, calls);
    Object.assign(f.settings.homeland, { tech: true, targetTech: 1 });
    await runHomeland(f.client, h.config, f.options); assert.equal(f.state.home.techLevel, 1);
    assert.equal(f.state.writes.filter(row => row.name === 'HomelandTechUpRequest').length, 1);
  });
  await test('昨日免费领取未知不冒充成功，新一天独立领取额度可继续', async () => {
    const f = h.fixture(); f.state.drop = 'DualCombineBuyStaminaRequest';
    assert.equal((await execute(f, 'freeStamina')).status, 'pending');
    f.client.serverClockOffsetMs += 86400000; f.state.drop = null;
    assert.equal((await execute(f, 'freeStamina')).status, 'confirmed');
    const records = Object.values(f.ledger.keyRecords());
    assert(records.some(row => row.expired && !row.confirmed)); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('商品未同步不冒充每日完成，首次家园引导前不进入工坊', async () => {
    const f = h.fixture(); Object.assign(f.settings.homeland, { enabled: true, freeBox: true });
    f.state.products = [];
    await runHomeland(f.client, h.config, f.options); assert.equal(f.state.writes.length, 0);
    f.state.products = null; f.client.serverClockOffsetMs += 600000;
    await runHomeland(f.client, h.config, f.options); assert.equal(f.state.bought, 1);
    const unopened = h.fixture(); unopened.state.home.level = 0;
    await assert.rejects(read(unopened), /开启引导/);
    assert.deepEqual(unopened.state.calls, ['HomelandRequest']);
  });
  await test('真实挂机经账号队列执行家园，关闭总控、细项或只读模式均不发送', async () => {
    for (const gate of ['world', 'enabled', 'freeStamina', 'dry', 'beforeSend', null]) {
      const f = h.fixture(); Object.assign(f.settings.homeland, { enabled: true, freeStamina: true });
      f.client.setMaxListeners(100);
      if (gate === 'world') f.settings.loop.world = false;
      if (gate === 'enabled' || gate === 'freeStamina') f.settings.homeland[gate] = false;
      if (gate === 'beforeSend') f.state.beforeWrite = () => { f.settings.homeland.freeStamina = false; };
      let queued = false;
      const request = f.client.request;
      f.client.request = (...args) => { assert(queued, '家园读写必须在账号队列内'); return request(...args); };
      const running = runLoop(f.client, h.protocol, { config: h.config, player: f.player,
        rounds: 1, allowMutate: gate !== 'dry', getSettings: () => f.settings, usageLedger: f.ledger,
        isEnabled: () => false, async schedule(work) {
          assert.equal(queued, false); queued = true;
          try { return await work(); } finally { queued = false; }
        } });
      const result = gate === 'dry' ? await assert.rejects(running, /需要 --yes/) : await running;
      assert.equal(f.state.writes.length, gate === null ? 1 : 0, String(gate));
      if (gate === null) assert(result.history[0].world.results.some(row => row.status === 'confirmed'));
      if (gate !== null && gate !== 'beforeSend') assert.equal(f.state.calls.length, 0, String(gate));
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('多订单共用仓库物品仍有独立操作，自动交单优先限时需求', async () => {
    const f = h.fixture(); f.state.orders = [0, 1].map(slot => ({ slot, orderId: 20 + slot,
      orderType: slot, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }));
    const view = await read(f), actions = view.actions.filter(row => row.kind === 'takeWarehouse');
    assert.equal(actions.length, 2); assert.notEqual(actions[0].id, actions[1].id);
    assert.equal((await executeHomeland(f.client, h.config, { ...f.options, ...actions[1],
      guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config: h.config }) })).status, 'confirmed');
    Object.assign(f.settings.homeland, { enabled: true, submitOrders: true });
    await runHomeland(f.client, h.config, f.options);
    assert.deepEqual(f.state.orders.map(row => row.slot), [0]);
    assert.equal(f.state.writes.filter(row => row.name === 'DualCombineSubmitOrderRequest').length, 1);
  });
  console.log(`家园离线验收通过 ${passed} 项`);
} finally { await h.close(); }
