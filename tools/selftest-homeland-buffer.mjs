import assert from 'node:assert/strict';
import { createHomelandHarness, createHomelandClient } from './fixtures/homeland-console.mjs';
import { planHomelandMerges } from '../src/homeland-merge.mjs';

const h = await createHomelandHarness();
const { readHomeland, executeHomeland, runHomeland } = await import('../src/homeland.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { importAutomationSettings, exportAutomationSettings, SETTINGS_FORMAT, createUsageLedger } = await import('../src/automation-settings.mjs');
const order = (id, count = 1) => ({ slot: 0, orderId: 20, reqs: [{ pieceCfgId: id, count }] });
function setup(board = ['鱼4', '鱼1'], bag = ['鱼1'], request = order('鱼2'), capacity = 5) {
  const f = h.fixture();
  f.state.cells = board.map((id, cellId) => ({ cellId, state: 2, ...(id ? { piece: { uid: cellId + 1, pieceCfgId: id } } : {}) }));
  f.state.warehouse = bag.map((pieceCfgId, i) => ({ uid: 100 + i, pieceCfgId }));
  f.state.warehouseCapacity = capacity; f.state.orders = [request];
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true, mergeOrders: true, takeWarehouse: true, warehouseBuffer: true });
  return f;
}
const read = f => readHomeland(f.client, h.config, f.options);
const run = f => runHomeland(f.client, h.config, f.options);
const buffer = async f => (await read(f)).actions.find(action => action.kind === 'warehouseBuffer');
const send = (f, action, automatic = false) => executeHomeland(f.client, h.config, { ...f.options, ...action, automatic,
  guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config: h.config, enabled: f.options.enabled }) });
const finish = async f => {
  for (let i = 0; i < 5 && f.state.orders.length; i++) { await run(f); f.client.serverClockOffsetMs += 301000; }
  assert.equal(f.state.orders.length, 0, JSON.stringify({ writes: f.state.writes.map(row => row.name), view: await read(f) }));
};
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
try {
  await test('73 版升级保留原合成开关，中转默认关闭且独立保存', async () => {
    const f = setup(); delete f.settings.homeland.warehouseBuffer;
    const upgraded = importAutomationSettings({ format: SETTINGS_FORMAT, version: 73, settings: f.settings });
    assert.equal(upgraded.homeland.mergeOrders, true); assert.equal(upgraded.homeland.warehouseBuffer, false);
    upgraded.homeland.warehouseBuffer = true;
    assert.equal(importAutomationSettings(exportAutomationSettings(upgraded)).homeland.warehouseBuffer, true);
    upgraded.homeland.warehouseBuffer = 1;
    assert.throws(() => exportAutomationSettings(upgraded));
  });
  await test('满棋盘暂存一件闲置物后合成交单，后续订单按需取回', async () => {
    const f = setup(); const view = await read(f);
    assert.deepEqual(view.warehouse, { used: 1, capacity: 5 }); assert.equal(view.orders[0].synthesis.stores, 1);
    await finish(f);
    assert.deepEqual(f.state.writes.map(row => row.name), ['DualCombinePutToWarehouseRequest', 'DualCombineTakeFromWarehouseRequest', 'DualCombineMoveRequest', 'DualCombineSubmitOrderRequest']);
    assert.deepEqual(f.state.warehouse, [{ uid: 1, pieceCfgId: '鱼4' }]);
    f.state.orders = [{ ...order('鱼4'), orderId: 21 }]; await finish(f);
    assert.equal(f.state.warehouse.length, 0); assert.equal(f.state.stamina, 10);
  });
  await test('仓库仅一个空位可交替存取腾出两格，仓库满也可先取再存', async () => {
    const f = setup(['鱼4', '鱼4'], ['鱼1', '鱼1'], order('鱼2'), 3);
    assert.equal((await read(f)).orders[0].synthesis.stores, 2); await finish(f);
    assert.deepEqual(f.state.writes.slice(0, 4).map(row => row.name), ['DualCombinePutToWarehouseRequest', 'DualCombineTakeFromWarehouseRequest', 'DualCombinePutToWarehouseRequest', 'DualCombineTakeFromWarehouseRequest']);
    const g = setup(['鱼4', null], ['鱼1', '鱼1'], order('鱼2'), 2); await finish(g);
    assert.equal(g.state.writes[0].name, 'DualCombineTakeFromWarehouseRequest');
    assert.equal(g.state.writes[1].name, 'DualCombinePutToWarehouseRequest');
  });
  await test('两格工作区借仓库暂存中间产物完成七次合成，交单前取回所有成品', async () => {
    const f = setup([null, null], Array(8).fill('鱼1'), order('鱼4'), 8); await finish(f);
    assert.equal(f.state.writes.filter(row => row.name === 'DualCombineMoveRequest').length, 7);
    assert(f.state.writes.some(row => row.name === 'DualCombinePutToWarehouseRequest'));
    assert.equal(f.state.warehouse.length, 0);
    const g = setup(['鱼2', null], ['鱼1', '鱼1'], order('鱼2', 2), 2); await finish(g);
    assert.equal(g.state.warehouse.length, 0);
    // A warehouse piece loaded earlier can be parked and loaded again in the same order.
    const mixed = order('鱼3'); mixed.reqs.push({ pieceCfgId: '鱼2', count: 1 });
    const j = setup([null, null], ['鱼2', '鱼1', '鱼1', '鱼1', '鱼1'], mixed, 5); await finish(j);
    assert.equal(j.ledger.snapshot().uncertain, 0);
  });
  await test('容量未知、两处全满、最终成品放不下及生产器占位均不提前搬运', async () => {
    const full = setup(['鱼4', '鱼1'], ['鱼1'], order('鱼2'), 1);
    assert.match((await read(full)).orders[0].synthesis.reason, /仓库已满/);
    const unknown = setup(); unknown.state.warehouseCapacity = undefined;
    assert.match((await read(unknown)).orders[0].synthesis.reason, /容量未确认/);
    const producer = setup(['钩1', null], ['鱼1', '鱼1']);
    const bottle = setup(['体力瓶1', null], ['鱼1', '鱼1']);
    const tooMany = setup([null, null], Array(6).fill('鱼1'), order('鱼2', 3), 6);
    const incomplete = setup(['鱼4', null], ['鱼1'], order('鱼3'));
    for (const f of [full, unknown, producer, bottle, tooMany, incomplete]) { await run(f); assert.equal(f.state.writes.length, 0); }
  });
  await test('所有父开关、发送前暂停和订单到期阻止存入，容量变化与陈旧棋子拒绝', async () => {
    for (const key of ['enabled', 'submitOrders', 'mergeOrders', 'takeWarehouse', 'warehouseBuffer']) {
      const f = setup(); f.settings.homeland[key] = false; await run(f); assert.equal(f.state.writes.length, 0, key);
      const g = setup(); const action = await buffer(g);
      g.state.beforeWrite = () => { g.settings.homeland[key] = false; };
      assert.equal((await send(g, action, true)).status, 'cancelled', key);
      assert.equal(g.ledger.snapshot().uncertain, 0); assert.equal(g.state.writes.length, 0);
    }
    const f = setup(); const stale = await buffer(f); f.state.cells[0].piece.uid = 90;
    assert.equal((await send(f, stale)).status, 'rejected');
    const g = setup(); const action = await buffer(g); g.state.warehouseCapacity = 1;
    assert.equal((await send(g, action)).status, 'rejected');
    const expired = setup(); expired.state.orders[0].expireTs = Math.floor(Date.now() / 1000) + 10;
    expired.state.beforeWrite = () => { expired.client.serverClockOffsetMs = 20000; };
    assert.equal((await send(expired, await buffer(expired), true)).status, 'cancelled');
    const oldProtocol = setup(); oldProtocol.client.protocol = { ...oldProtocol.client.protocol, DualCombineTakeFromWarehouseRequest: undefined };
    assert.match((await buffer(oldProtocol)).reason, /后续取料/); await run(oldProtocol); assert.equal(oldProtocol.state.writes.length, 0);
  });
  await test('存入超时跨重连与跨日防重，源格清空且同编号物品入库才确认', async () => {
    const f = setup(); f.state.drop = 'DualCombinePutToWarehouseRequest';
    assert.equal((await send(f, await buffer(f))).status, 'pending');
    f.client = createHomelandClient(h.protocol, f.player.playerId - 1000, f.state).client;
    f.client.serverClockOffsetMs = 86400000;
    f.ledger = createUsageLedger(f.ledgerId, { now: () => Date.now() + 86400000 }); f.options.ledger = f.ledger;
    f.options.enabled = () => f.enabled && f.client.connected;
    await run(f); assert.equal(f.state.writes.length, 1); assert.equal((await read(f)).pending.length, 1);
    const piece = f.state.cells[0].piece; delete f.state.cells[0].piece;
    assert.equal((await read(f)).pending.length, 1);
    f.state.warehouse.push({ ...piece, pieceCfgId: '鱼3' }); assert.equal((await read(f)).pending.length, 1);
    f.state.warehouse[f.state.warehouse.length - 1] = piece; assert.equal((await read(f)).pending.length, 0);
    f.state.drop = null; f.client.serverClockOffsetMs += 301000; await finish(f);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    const g = setup(); g.state.drop = 'after:DualCombinePutToWarehouseRequest';
    assert.equal((await send(g, await buffer(g))).status, 'confirmed');
  });
  await test('独立最短路枚举 2592 种棋盘与仓库状态，逐项核对最优步数', async () => {
    const reachable = (board, bag, capacity) => {
      const queue = [[board, bag, 0]], seen = new Set();
      for (let head = 0; head < queue.length; head++) {
        const [cells, warehouse, distance] = queue[head];
        const key = [...cells].sort((a, b) => a-b).join(',') + '/' + [...warehouse].sort((a, b) => a-b).join(',');
        if (seen.has(key)) continue; seen.add(key);
        if (cells.includes(3)) return distance;
        for (let i = 0; i < cells.length; i++) {
          if (!cells[i]) for (let k = 0; k < warehouse.length; k++) {
            const next = [...cells], stock = [...warehouse]; next[i] = stock.splice(k, 1)[0]; queue.push([next, stock, distance + 1]);
          }
          if ([1, 2, 4].includes(cells[i]) && warehouse.length < capacity) {
            const next = [...cells]; next[i] = 0; queue.push([next, [...warehouse, cells[i]], distance + 1]);
          }
          if (![1, 2].includes(cells[i])) continue;
          for (let j = 0; j < cells.length; j++) if (i !== j && Math.abs(cells[j]) === cells[i]) {
            const next = [...cells]; next[j] = cells[i] + 1; next[i] = 0; queue.push([next, warehouse, distance + 1]);
          }
        }
      }
      return null;
    };
    let cases = 0;
    const values = [0, 1, 2, -1, -2, 4];
    for (const a of values) for (const b of values) for (const c of values) for (const bag of [[], [1], [1, 1], [2]]) for (const room of [0, 1, 2]) {
      const board = [a, b, c], capacity = bag.length + room;
      const state = { now: 1, warehouseCapacity: capacity, emptyCells: board.filter(x => !x).length,
        cells: board.map((x, i) => ({ cellId: i, state: x < 0 ? 1 : 2, piece: x ? { uid: i + 1, id: '鱼' + Math.abs(x) } : null })),
        warehouse: bag.map((x, i) => ({ uid: 100 + i, id: '鱼' + x })), orders: [order('鱼3')] };
      const result = planHomelandMerges(h.config, state, { takeWarehouse: true, warehouseBuffer: true })[0];
      const distance = reachable(board, bag, capacity), evidence = JSON.stringify({ board, bag, capacity, result });
      assert.equal(result.steps, distance, evidence);
      assert.equal(result.status, distance === null ? 'unreachable' : 'optimal', evidence); cases++;
    }
    assert.equal(cases, 2592);
  });
  console.log(`家园仓库中转专项 ${passed}/${passed} 通过`);
} finally { await h.close(); }
