import assert from 'node:assert/strict';
import { createHomelandHarness } from './fixtures/homeland-console.mjs';
import { planHomelandMerges } from '../src/homeland-merge.mjs';

const h = await createHomelandHarness();
const request = ids => ({ slot: 0, orderId: 1, reqs: ids.map(id => ({ pieceCfgId: '鱼' + id, count: 1 })) });
const stateFor = (board, bag, goals, capacity = 5) => ({ now: 1, emptyCells: board.filter(x => !x).length, warehouseCapacity: capacity,
  cells: board.map((x, i) => ({ cellId: i * 100, state: x < 0 ? 1 : 2, piece: x ? { uid: i + 1, id: '鱼' + Math.abs(x) } : null })),
  warehouse: bag.map((x, i) => ({ uid: 100 + i, id: '鱼' + x })), orders: [request(goals)] });
const plan = (state, options = {}) => planHomelandMerges(h.config, state, { takeWarehouse: true, warehouseBuffer: true, ...options })[0];
// Independent, physical-piece BFS. It knows nothing about A*, demand relaxation,
// compressed type vectors, the incumbent, or their implementations.
function minimum(board, bag, goals, capacity) {
  const needs = new Map(); for (const id of goals) needs.set(id, (needs.get(id) ?? 0) + 1);
  const ceiling = Math.max(...goals), queue = [[board, bag, 0]], visited = new Set();
  for (let head = 0; head < queue.length; head++) {
    const [cells, warehouse, distance] = queue[head];
    const key = [...cells].sort((a, b) => a-b).join(',') + '/' + [...warehouse].sort((a, b) => a-b).join(',');
    if (visited.has(key)) continue; visited.add(key);
    if ([...needs].every(([id, count]) => cells.filter(x => x === id).length >= count)) return distance;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) for (let k = 0; k < warehouse.length; k++) {
        const next = [...cells], stock = [...warehouse]; next[i] = stock.splice(k, 1)[0]; queue.push([next, stock, distance + 1]);
      }
      if (cells[i] > 0 && warehouse.length < capacity) {
        const next = [...cells]; next[i] = 0; queue.push([next, [...warehouse, cells[i]], distance + 1]);
      }
      if (cells[i] <= 0 || cells[i] >= ceiling) continue;
      for (let j = 0; j < cells.length; j++) if (i !== j && Math.abs(cells[j]) === cells[i]) {
        const next = [...cells]; next[j] = cells[i] + 1; next[i] = 0; queue.push([next, warehouse, distance + 1]);
      }
    }
  }
  return null;
}
function advance(state, action) {
  if (action.kind === 'warehouseBuffer') {
    const cell = state.cells.find(row => row.piece?.uid === action.piece.uid); assert(cell && cell.state === 2);
    assert(state.warehouse.length < state.warehouseCapacity);
    state.warehouse.push(cell.piece); cell.piece = null;
  } else if (action.kind === 'takeWarehouse') {
    const index = state.warehouse.findIndex(row => row.uid === action.piece.uid), cell = state.cells.find(row => row.state === 2 && !row.piece);
    assert(index >= 0 && cell); cell.piece = state.warehouse.splice(index, 1)[0];
  } else {
    const from = state.cells.find(row => row.cellId === action.from.cellId), to = state.cells.find(row => row.cellId === action.to.cellId);
    assert(from !== to && from.state === 2 && [1, 2].includes(to.state));
    assert.equal(from.piece.id, to.piece.id); from.piece = null; to.state = 2; to.piece.id = action.nextId;
  }
  state.emptyCells = state.cells.filter(row => row.state === 2 && !row.piece).length;
}
try {
  const alternative = stateFor([1, 1], [2], [2], 2);
  const old = plan(alternative, { searchLimits: { maxExpanded: 0 } }), best = plan(alternative);
  assert.equal(old.status, 'feasible'); assert.equal(old.steps, 2);
  assert.equal(best.status, 'optimal'); assert.equal(best.steps, 1); assert.equal(best.next.kind, 'mergeOrders');
  const mixed = stateFor([2, 2], [2], [2, 3], 2);
  assert.equal(plan(mixed, { searchLimits: { maxExpanded: 0 } }).steps, 4);
  assert.equal(plan(mixed).steps, 2);
  console.log('通过：整单搜索将腾位取成品的 2 步缩为 1 步，将混合等级订单的 4 步缩为 2 步');

  const noIncumbent = plan(alternative, { warehouseBuffer: false, searchLimits: { maxExpanded: 0 } });
  assert.equal(noIncumbent.status, 'limited'); assert.equal(noIncumbent.steps, null); assert.equal(noIncumbent.next, null);
  assert.equal(plan(alternative, { warehouseBuffer: false }).status, 'optimal', '较小预算的结果不能污染正常搜索缓存');
  for (const limits of [{ maxExpanded: 0 }, { maxStates: 0 }, { maxMilliseconds: 0 }]) {
    const result = plan(mixed, { searchLimits: limits }); assert.equal(result.status, 'feasible');
    assert(result.lowerBound <= 2 && result.steps >= 2);
  }
  const empty = stateFor([0, 0], [], [3]); assert.equal(plan(empty).status, 'unreachable');
  assert.throws(() => plan(empty, { searchLimits: { maxExpanded: -1 } }));
  console.log('通过：节点、状态和时间预算区分可行、未找到与无解，缓存按预算隔离');

  const other = stateFor([1, 1, 1], [], [2]); other.orders.push({ ...request([1]), slot: 1, orderId: 2 });
  const protectedUid = 1, first = plan(other);
  assert.equal(first.status, 'optimal'); assert.equal(first.steps, 1);
  assert(![first.next.from.uid, first.next.to.uid].includes(protectedUid));
  const renamed = structuredClone(other); for (const cell of renamed.cells) cell.piece.uid += 500;
  const rebound = plan(renamed);
  assert(rebound.next.from.uid >= 500 && rebound.next.to.uid >= 500, '缓存操作必须重新绑定当前 UID');
  assert(![rebound.next.from.uid, rebound.next.to.uid].includes(protectedUid + 500));
  console.log('通过：保留其他订单现货，计数状态缓存重新绑定真实棋子编号与格子');

  const { readHomeland, runHomeland } = await import('../src/homeland.mjs');
  const f = h.fixture();
  f.state.cells = [1, 2].map(uid => ({ cellId: uid * 100, state: 2, piece: { uid, pieceCfgId: '鱼2' } }));
  f.state.warehouse = [{ uid: 100, pieceCfgId: '鱼2' }]; f.state.warehouseCapacity = 2;
  f.state.orders = [request([2, 3])]; f.state.mergeUid = 'new';
  Object.assign(f.settings.homeland, { enabled: true, submitOrders: true, mergeOrders: true, takeWarehouse: true, warehouseBuffer: true });
  assert.equal((await readHomeland(f.client, h.config, f.options)).orders[0].synthesis.steps, 2);
  await runHomeland(f.client, h.config, f.options);
  assert.equal(f.state.orders.length, 0);
  assert.deepEqual(f.state.writes.map(row => row.name), ['DualCombineMoveRequest', 'DualCombineTakeFromWarehouseRequest', 'DualCombineSubmitOrderRequest']);
  console.log('通过：真实协议按最短 2 步备料再交单，新合成 UID 回读后继续执行');

  const twoChains = { tables: { DualCombinePieceCfg: { data: [...h.config.tables.DualCombinePieceCfg.data,
    ...[1, 2, 3].map(level => ({ pieceId: '菜' + level, pieceGroup: '菜', type: '普通', level, nextId: level < 3 ? '菜' + (level + 1) : '' }))] } } };
  const cross = stateFor([1, 1, 4], [1, 1], [2], 3);
  cross.cells[1].piece.id = '菜1'; cross.warehouse[1].id = '菜1'; cross.orders[0].reqs.push({ pieceCfgId: '菜2', count: 1 });
  const across = planHomelandMerges(twoChains, cross, { takeWarehouse: true, warehouseBuffer: true })[0];
  assert.equal(across.status, 'optimal'); assert.equal(across.steps, 5); assert.equal(across.merges, 2); assert.equal(across.stores, 1);
  console.log('通过：多个合成链共享棋盘和仓库空间，联合比较总操作数');

  let cases = 0, replayed = 0;
  for (const a of [0, 1, 2, 3, -1, -2]) for (const b of [0, 1, 2, 3, -1, -2])
    for (const bag of [[], [1, 2], [1, 1, 2], [2, 2], [1, 1, 1, 1]])
      for (const goals of [[3], [2, 3], [2, 2], [1, 3], [2]]) for (const room of [0, 1]) {
        const board = [a, b], capacity = bag.length + room, expected = minimum(board, bag, goals, capacity);
        const state = stateFor(board, bag, goals, capacity), result = plan(state, { searchLimits: { maxMilliseconds: 1000 } });
        const evidence = JSON.stringify({ board, bag, goals, capacity, expected, result });
        assert.equal(result.steps, expected, evidence); assert.equal(result.status, expected === null ? 'unreachable' : 'optimal', evidence);
        if (expected !== null && cases % 17 === 0) {
          for (let remaining = expected; remaining > 0; remaining--) {
            const next = plan(state); assert.equal(next.steps, remaining, evidence); advance(state, next.next);
          }
          assert.equal(plan(state).steps, 0, evidence); replayed++;
        }
        cases++;
      }
  assert.equal(cases, 1800); assert(replayed > 20);
  console.log(`通过：独立 BFS 比较 ${cases} 种混合等级与数量需求的最短步数，并回放 ${replayed} 条完整路径`);

  const large = stateFor(Array(63).fill(1), [], [4, 4, 4, 4]);
  const began = performance.now(), result = plan(large);
  assert.equal(result.status, 'optimal'); assert.equal(result.steps, 28); assert.equal(result.stores, 0);
  assert.equal(result.expanded, 0, '可行上界与可采纳下界相等时直接证明最优，不枚举棋子排列');
  assert(performance.now() - began < 1000);
  console.log('通过：63 格重复棋子压缩为数量状态，28 步方案无需扩展节点即可证明最优');
} finally { await h.close(); }
