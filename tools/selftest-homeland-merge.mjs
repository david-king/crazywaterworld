import assert from 'node:assert/strict';
import { createHomelandHarness, createHomelandClient } from './fixtures/homeland-console.mjs';
import { planHomelandMerges } from '../src/homeland-merge.mjs';

const h = await createHomelandHarness();
const { readHomeland, executeHomeland, runHomeland } = await import('../src/homeland.mjs');
const { createActionGuard } = await import('../src/automation-policy.mjs');
const { importAutomationSettings, exportAutomationSettings, SETTINGS_FORMAT, createUsageLedger } = await import('../src/automation-settings.mjs');
const cell = (id, pieceId, state = 2) => ({ cellId: id, state, ...(pieceId ? { piece: { uid: id + 1, pieceCfgId: pieceId } } : {}) });
const order = (pieceId, slot = 0, count = 1, extra = {}) => ({ slot, orderId: slot + 100, reqs: [{ pieceCfgId: pieceId, count }], ...extra });
function setup(board, orders, warehouse = []) {
  const f = h.fixture();
  f.state.cells = board.map((row, id) => cell(id, Array.isArray(row) ? row[0] : row, Array.isArray(row) ? row[1] : 2));
  f.state.orders = orders;
  f.state.warehouse = warehouse.map((pieceCfgId, index) => ({ pieceCfgId, uid: index + 100 }));
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true, mergeOrders: true });
  return f;
}
const read = f => readHomeland(f.client, h.config, f.options);
const send = async (f, action, extra = {}) => executeHomeland(f.client, h.config, { ...f.options, ...action, ...extra,
  guard: createActionGuard(f.client, () => f.settings, f.ledger, { player: f.player, config: h.config, enabled: f.options.enabled }) });
const run = f => runHomeland(f.client, h.config, f.options);
const mergeAction = async f => (await read(f)).actions.find(row => row.kind === 'mergeOrders');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
try {
  await test('72 版配置保留已开启交单，自动合成默认关闭且可独立往返保存', async () => {
    const f = setup(['鱼1', '鱼1'], [order('鱼2')]);
    delete f.settings.homeland.mergeOrders;
    const migrated = importAutomationSettings({ format: SETTINGS_FORMAT, version: 72, settings: f.settings });
    assert.equal(migrated.homeland.submitOrders, true); assert.equal(migrated.homeland.mergeOrders, false);
    migrated.homeland.mergeOrders = true;
    assert.equal(importAutomationSettings(exportAutomationSettings(migrated)).homeland.mergeOrders, true);
    migrated.homeland.mergeOrders = 'true'; assert.throws(() => importAutomationSettings(exportAutomationSettings(migrated)));
    await run(f); assert.equal(f.state.writes.length, 0);
  });
  await test('真实协议多级合成后自动交单，兼容保留源 UID、目标 UID 和新 UID', async () => {
    for (const uid of ['source', 'target', 'new']) {
      const f = setup(Array(8).fill('鱼1'), [order('鱼4')]); f.state.mergeUid = uid;
      const view = await read(f); assert.equal(view.orders[0].synthesis.merges, 7); assert.equal(f.state.writes.length, 0);
      await run(f);
      assert.equal(f.state.orders.length, 0); assert.equal(f.state.writes.filter(row => row.name === 'DualCombineMoveRequest').length, 7);
      assert.equal(f.state.writes.length, 8); assert.equal(f.state.stamina, 10); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('保留所有订单现成物品，同一订单的高低级需求分别分配', async () => {
    const f = setup(Array(5).fill('鱼1'), [order('鱼3'), order('鱼1', 1)]);
    const action = await mergeAction(f); assert(action);
    // UID 1 is reserved for the direct low-level order.
    assert(!action.detail.includes('鱼饼 ×2'));
    assert.equal((await send(f, action)).status, 'confirmed');
    assert.equal(f.state.cells[0].piece?.pieceCfgId, '鱼1');
    await run(f); assert.equal(f.state.orders.length, 0);
    const mixed = order('鱼1'); mixed.reqs.push({ pieceCfgId: '鱼3', count: 1 });
    const g = setup(Array(5).fill('鱼1'), [mixed]); await run(g); assert.equal(g.state.orders.length, 0);
  });
  await test('优先限时订单并把半锁定棋子作为目标，完全锁定格不参与', async () => {
    const f = setup(['鱼1', ['鱼1', 1], ['鱼1', 0]], [order('鱼2'), order('鱼2', 1, 1, { orderType: 1 })]);
    const action = await mergeAction(f); assert.equal(action.orderSlot, 1);
    await run(f);
    assert.deepEqual(f.state.orders.map(row => row.slot), [0]); assert.equal(f.state.cells[2].state, 0);
    const move = f.state.writes.find(row => row.name === 'DualCombineMoveRequest');
    assert.equal(move.body.fromCellId, 0); assert.equal(move.body.toCellId, 1); assert.equal(f.state.cells[1].state, 2);
  });
  await test('两个半锁定棋子不能互相拖动，生产器、体力瓶和满级物品保持原状', async () => {
    for (const [board, request] of [[[['鱼1', 1], ['鱼1', 1]], '鱼2'], [['钩1', '钩1'], '钩2'], [['体力瓶1', '体力瓶1'], '体力瓶2'], [['鱼4', '鱼4'], '鱼1']]) {
      const f = setup(board, [order(request)]); const before = structuredClone(f.state.cells);
      await run(f); assert.equal(f.state.writes.length, 0); assert.deepEqual(f.state.cells, before);
    }
  });
  await test('仓库合成原料沿用取料开关，关闭合成不取料，完整链路逐步确认', async () => {
    const f = setup([null, null], [order('鱼2')], ['鱼1', '鱼1']);
    await run(f); assert.equal(f.state.writes.length, 0);
    f.settings.homeland.takeWarehouse = true; f.settings.homeland.mergeOrders = false;
    await run(f); assert.equal(f.state.writes.length, 0);
    f.settings.homeland.mergeOrders = true; await run(f);
    assert.deepEqual(f.state.writes.map(row => row.name), ['DualCombineTakeFromWarehouseRequest', 'DualCombineTakeFromWarehouseRequest', 'DualCombineMoveRequest', 'DualCombineSubmitOrderRequest']);
  });
  await test('先在满棋盘合成腾位，仓库所需空位不足时不取一半材料堵盘', async () => {
    const f = setup(['鱼1', '鱼1'], [order('鱼3')], ['鱼2']); f.settings.homeland.takeWarehouse = true;
    await run(f); assert.equal(f.state.writes[0].name, 'DualCombineMoveRequest'); assert.equal(f.state.orders.length, 0);
    const g = setup(['钩1', null], [order('鱼2')], ['鱼1', '鱼1']); g.settings.homeland.takeWarehouse = true;
    assert.match((await read(g)).orders[0].synthesis.reason, /需要 2 个空位/);
    await run(g); assert.equal(g.state.writes.length, 0);
  });
  await test('陈旧棋子 UID、发送前关闭合成、订单到期均取消且不占用账本', async () => {
    const f = setup(['鱼1', '鱼1'], [order('鱼2')]); const stale = await mergeAction(f);
    f.state.cells[0].piece.uid = 90; assert.equal((await send(f, stale)).status, 'rejected');
    for (const gate of ['merge', 'order', 'expired']) {
      const g = setup(['鱼1', '鱼1'], [order('鱼2', 0, 1, { expireTs: Math.floor(Date.now() / 1000) + 10 })]);
      g.state.beforeWrite = () => { if (gate === 'expired') g.client.serverClockOffsetMs += 20000;
        else g.settings.homeland[gate === 'merge' ? 'mergeOrders' : 'submitOrders'] = false; };
      assert.equal((await send(g, await mergeAction(g), { automatic: true })).status, 'cancelled');
      assert.equal(g.state.writes.length, 0); assert.equal(g.ledger.snapshot().uncertain, 0);
    }
  });
  await test('超时合成跨连接与跨日防重，必须同时核对原料与目标格的升级结果', async () => {
    const f = setup(['鱼1', '鱼1'], [order('鱼2')]); f.state.drop = 'DualCombineMoveRequest';
    assert.equal((await send(f, await mergeAction(f))).status, 'pending');
    const replacement = createHomelandClient(h.protocol, f.player.playerId - 1000, f.state).client; replacement.serverClockOffsetMs = 86400000;
    f.client = replacement; f.options.enabled = () => f.enabled && f.client.connected;
    f.ledger = createUsageLedger(f.ledgerId, { now: () => Date.now() + 86400000 });
    f.options.ledger = f.ledger;
    f.state.orders = []; await run(f); assert.equal(f.state.writes.length, 1); assert.equal((await read(f)).pending.length, 1);
    const source = f.state.cells[0].piece; delete f.state.cells[0].piece;
    f.state.cells[1].piece.pieceCfgId = '鱼2'; f.state.warehouse.push(source);
    assert.equal((await read(f)).pending.length, 1, '移到仓库不能冒充被合成消耗');
    f.state.warehouse = []; assert.equal((await read(f)).pending.length, 0);
    f.state.drop = null;
    const free = (await read(f)).actions.find(row => row.kind === 'freeStamina');
    assert.equal((await send(f, free)).status, 'confirmed'); assert.equal(f.ledger.snapshot().uncertain, 0);
    const g = setup(['鱼1', '鱼1'], [order('鱼2')]); g.state.drop = 'after:DualCombineMoveRequest';
    assert.equal((await send(g, await mergeAction(g))).status, 'confirmed');
  });
  await test('与独立棋盘状态枚举核对小棋盘合成可达性和空位需求', async () => {
    const reachable = (board, bag) => {
      const queue = [[board, bag]], visited = new Set();
      while (queue.length) {
        const [cells, warehouse] = queue.shift(), key = [...cells].sort((a,b)=>a-b).join(',') + '/' + warehouse.join(',');
        if (visited.has(key)) continue; visited.add(key);
        if (cells.includes(3)) return true;
        for (let i = 0; i < cells.length; i++) {
          if (cells[i] === 0 && warehouse.length) { const next = [...cells]; next[i] = warehouse[0]; queue.push([next, warehouse.slice(1)]); }
          if (![1, 2].includes(cells[i])) continue;
          for (let j = 0; j < cells.length; j++) if (i !== j && Math.abs(cells[j]) === cells[i]) {
            const next = [...cells]; next[j] = cells[i] + 1; next[i] = 0; queue.push([next, warehouse]);
          }
        }
      }
      return false;
    };
    const values = [0, 1, 2, -1, -2, 99]; let cases = 0;
    for (const a of values) for (const b of values) for (const c of values) for (const bag of [[], [1], [1, 1], [2]]) {
      const board = [a, b, c], state = { now: 1, emptyCells: board.filter(x => x === 0).length,
        cells: board.map((x, i) => ({ cellId: i, state: x === 99 ? 0 : x < 0 ? 1 : 2, piece: x ? { uid: i + 1, id: '鱼' + Math.abs(x) } : null })),
        warehouse: bag.map((level, i) => ({ uid: 100 + i, id: '鱼' + level })), orders: [order('鱼3')] };
      const result = planHomelandMerges(h.config, state, { takeWarehouse: true })[0];
      assert.equal(!!result.next, reachable(board, bag), JSON.stringify({ board, bag, result })); cases++;
    }
    assert.equal(cases, 864);
  });
  console.log(`家园合成专项 ${passed}/${passed} 通过`);
} finally { await h.close(); }
