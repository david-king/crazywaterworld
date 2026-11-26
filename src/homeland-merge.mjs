import { natural, positive, table } from './activity-actions.mjs';
import { searchHomelandOrder } from './homeland-search.mjs';

// Plan a complete order from existing pieces. Recipes come exclusively from
// nextId; producers and usable rewards are never consumed by this planner.
const mergeableType = row => row && ['普通', '产品'].includes(row.type);
const copy = stock => new Map([...stock].map(([id, pieces]) => [id, [...pieces]]));
const add = (stock, piece) => stock.set(piece.id, [...(stock.get(piece.id) ?? []), piece]);
const take = (stock, id) => stock.get(id)?.shift();
const orderNeeds = order => {
  const needs = new Map();
  for (const row of order.reqs) needs.set(row.pieceCfgId, (needs.get(row.pieceCfgId) ?? 0) + row.count);
  return needs;
};
export const sortHomelandOrders = orders => [...orders].sort((a, b) => Number(b.orderType === 1) - Number(a.orderType === 1)
  || (Number(a.expireTs) || Infinity) - (Number(b.expireTs) || Infinity) || a.slot - b.slot);

// Minimum free-cell requirement for an expression tree. Withdrawals occupy a
// cell and each merge frees one. Schedule independent branches before taking
// finished products from the warehouse, so a last empty cell is not wasted.
function sequence(parts) {
  parts.sort((a, b) => {
    if ((a.delta >= 0) !== (b.delta >= 0)) return a.delta >= 0 ? -1 : 1;
    return a.delta >= 0 ? a.need - b.need : (b.need + b.delta) - (a.need + a.delta);
  });
  let need = 0, delta = 0;
  const steps = [];
  for (const part of parts) {
    need = Math.max(need, part.need - delta);
    delta += part.delta;
    steps.push(...part.steps);
  }
  return { need, delta, steps };
}
function schedule(piece) {
  if (piece.location === 'warehouse') return { need: 1, delta: -1, steps: [{ kind: 'takeWarehouse', piece }] };
  if (piece.location !== 'merge') return { need: 0, delta: 0, steps: [] };
  const result = sequence(piece.children.map(schedule));
  const [a, b] = piece.children;
  const from = a.location === 'half' ? b : a, to = a.location === 'half' ? a : b;
  result.steps.push({ kind: 'mergeOrders', from, to, output: piece, nextId: piece.id });
  result.delta++;
  return result;
}

// Simulate the complete recipe before authorizing a transfer. When a load needs
// a cell, park an ordinary piece whose next use is furthest away. This includes
// finished subrecipes: two work cells can build a deep chain with warehouse
// space. Track both capacities and load every final product before submission.
function withWarehouseBuffer(plan, products, state, byId) {
  const locations = new Map(), used = new Set();
  const visit = piece => {
    if (piece.children) piece.children.forEach(visit);
    else { locations.set(piece, piece.location); used.add(piece.uid); }
  };
  products.forEach(visit);
  for (const cell of state.cells) if (cell.state === 2 && cell.piece && !used.has(cell.piece.uid))
    locations.set({ ...cell.piece, cellId: cell.cellId }, 'board');
  let empty = state.emptyCells, stored = state.warehouse.length, moves = 0;
  const steps = [], finals = new Set(products);
  let reason = '', position = 0;
  const nextUse = piece => {
    for (let i = position; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.from === piece || step.to === piece) return i;
    }
    return finals.has(piece) ? plan.steps.length : Infinity;
  };
  const load = (piece, protectedPieces) => {
    if (['board', 'half'].includes(locations.get(piece))) return true;
    if (locations.get(piece) !== 'warehouse') { reason = '合成中转依赖未就绪'; return false; }
    if (!empty) {
      if (!positive(state.warehouseCapacity)) { reason = '仓库容量未确认，等待同步后中转'; return false; }
      if (stored >= state.warehouseCapacity) { reason = '仓库已满，无法中转腾位'; return false; }
      const candidates = [...locations].filter(([candidate, location]) => location === 'board'
        && !protectedPieces.has(candidate) && mergeableType(byId.get(candidate.id)))
        .map(([candidate]) => candidate).sort((a, b) => nextUse(b) - nextUse(a));
      const parked = candidates[0];
      if (!parked) { reason = '没有可暂存的普通棋子，合成配对、生产器与体力瓶保持原位'; return false; }
      locations.set(parked, 'warehouse');
      steps.push({ kind: 'warehouseBuffer', piece: parked });
      empty++; stored++; moves++;
    }
    steps.push({ kind: 'takeWarehouse', piece });
    locations.set(piece, 'board'); empty--; stored--;
    return true;
  };
  for (const step of plan.steps) {
    if (step.kind === 'takeWarehouse') {
      // The explicit recipe load may have already happened while restoring a
      // spilled operand. Never load the same piece twice.
      if (!load(step.piece, new Set([step.piece]))) return { reason };
    } else if (step.kind === 'mergeOrders') {
      const pair = new Set([step.from, step.to]);
      if (!load(step.from, pair) || !load(step.to, pair)) return { reason };
      if (locations.get(step.from) !== 'board') return { reason: '半锁定棋子不能作为合成源' };
      locations.delete(step.from); locations.delete(step.to);
      locations.set(step.output, 'board'); empty++;
      steps.push(step);
    }
    position++;
  }
  for (const piece of products) {
    if (!load(piece, finals)) return { reason };
  }
  return { ...plan, steps, stores: moves };
}

export function planHomelandMerges(config, state, { takeWarehouse = false, warehouseBuffer = false, searchLimits } = {}) {
  const configs = table(config, 'DualCombinePieceCfg'), byId = new Map(), previous = new Map();
  for (const row of configs) {
    if (!row.pieceId || byId.has(row.pieceId)) throw Error('工坊棋子配置编号重复或缺失');
    byId.set(row.pieceId, row);
  }
  for (const row of configs) {
    if (!row.nextId || !mergeableType(row)) continue;
    const next = byId.get(row.nextId);
    if (!mergeableType(next) || !positive(row.level) || next.level !== row.level + 1 || !row.pieceGroup || next.pieceGroup !== row.pieceGroup) continue;
    // An ambiguous inverse recipe cannot authorize an irreversible merge.
    previous.set(next.pieceId, previous.has(next.pieceId) ? null : row.pieceId);
  }
  const stock = new Map(), halves = new Map(), identities = new Set();
  const remember = piece => {
    if (!positive(piece.uid) || identities.has(piece.uid)) throw Error('工坊棋子编号未完整同步或重复');
    identities.add(piece.uid);
  };
  for (const cell of state.cells) {
    if (!cell.piece || ![1, 2].includes(cell.state)) continue;
    remember(cell.piece);
    const piece = { ...cell.piece, cellId: cell.cellId, state: cell.state, location: cell.state === 1 ? 'half' : 'board' };
    add(cell.state === 1 ? halves : stock, piece);
  }
  for (const piece of state.warehouse) {
    remember(piece);
    if (takeWarehouse) add(stock, { ...piece, location: 'warehouse' });
  }
  const active = sortHomelandOrders(state.orders).filter(order => !(Number(order.expireTs) > 0 && Number(order.expireTs) <= state.now));
  const requests = active.map(order => ({ order, needs: orderNeeds(order), reserved: [], missing: [] }));
  // Keep final-product reservations stable while pieces move between board and
  // warehouse. Preferring the board here would swap equal products on every
  // reload and could endlessly park/reload a mixed-level order's ingredients.
  if (warehouseBuffer) for (const rows of stock.values()) rows.sort((a, b) => a.uid - b.uid);
  // Reserve direct products for every live order before splitting any recipe.
  // Thus a high-tier order cannot merge away another order's existing goods.
  for (const request of requests) {
    for (const [id, num] of request.needs) {
      if (!positive(num)) throw Error('工坊合成需求无效');
      const reserved = Math.min(num, stock.get(id)?.length ?? 0);
      for (let i = 0; i < reserved; i++) request.reserved.push(take(stock, id));
      if (num > reserved) request.missing.push({ id, num: num - reserved });
    }
  }
  for (const rows of stock.values()) rows.sort((a, b) => Number(a.location === 'warehouse') - Number(b.location === 'warehouse'));
  const estimates = requests.map(({ order, reserved, missing }) => {
    const result = { slot: order.slot, order, merges: 0, stores: 0, next: null, reason: '' };
    const total = [...stock.values(), ...halves.values()].reduce((sum, rows) => sum + rows.length, 0);
    if (missing.reduce((sum, row) => sum + row.num, 0) > total) return { ...result, reason: '现有棋子不足，等待补充材料' };
    let visits = 0, preferBoard = false;
    function acquire(id, available, locked, depth = 0) {
      if (++visits > 4096 || depth > 64 || !mergeableType(byId.get(id))) return null;
      const existing = available.get(id)?.[0];
      const useExisting = () => {
        if (!existing) return null;
        const nextStock = copy(available);
        take(nextStock, id);
        return { piece: existing, stock: nextStock, halves: locked };
      };
      if (existing && (existing.location !== 'warehouse' || !preferBoard)) return useExisting();
      const lower = previous.get(id);
      if (!lower) return useExisting();
      // A half-locked piece is only a destination, never a drag source.
      // Combining two half-locked pieces is impossible; recursively build an
      // unlocked partner when lower-level materials can supply one.
      const half = locked.get(lower)?.[0];
      if (half) {
        const partner = acquire(lower, available, locked, depth + 1);
        if (partner) {
          const nextHalves = copy(partner.halves);
          take(nextHalves, lower);
          return { piece: { id, location: 'merge', children: [partner.piece, half] }, stock: partner.stock, halves: nextHalves };
        }
      }
      const first = acquire(lower, available, locked, depth + 1);
      if (!first) return useExisting();
      const second = acquire(lower, first.stock, first.halves, depth + 1);
      return second ? { piece: { id, location: 'merge', children: [first.piece, second.piece] }, stock: second.stock, halves: second.halves } : useExisting();
    }
    // Lower final products must be allocated first: higher recipes cannot take
    // a lower product that the same order still needs to deliver.
    missing.sort((a, b) => (byId.get(a.id)?.level ?? 0) - (byId.get(b.id)?.level ?? 0));
    const candidates = [];
    // A warehouse shortcut can be unusable on a full board. Also construct a
    // board-first recipe, then choose the plan requiring the least free space.
    for (preferBoard of [false, true]) {
      visits = 0;
      let available = copy(stock), locked = copy(halves), failed = false;
      const products = [...reserved];
      for (const need of missing) {
        for (let i = 0; i < need.num; i++) {
          const found = acquire(need.id, available, locked);
          if (!found) { failed = true; break; }
          available = found.stock; locked = found.halves; products.push(found.piece);
        }
        if (failed) break;
      }
      if (!failed) candidates.push({ ...sequence(products.map(schedule)), products });
    }
    const plan = candidates.sort((a, b) => a.need - b.need || a.steps.length - b.steps.length)[0];
    if (!plan) return { ...result, reason: visits > 4096 ? '合成规划达到检查上限，等待人工整理棋盘' : '现有棋子无法补齐订单，保留成品与生产器' };
    const merges = plan.steps.filter(step => step.kind === 'mergeOrders').length;
    if (!natural(state.emptyCells)) return { ...result, merges, reason: '棋盘空位尚未同步' };
    if (plan.need > state.emptyCells) {
      if (takeWarehouse && warehouseBuffer) {
        const buffered = candidates.map(candidate => withWarehouseBuffer(candidate, candidate.products, state, byId));
        const feasible = buffered.filter(candidate => candidate.steps).sort((a, b) => a.stores - b.stores || a.steps.length - b.steps.length)[0];
        if (feasible) return { ...result, merges: feasible.steps.filter(step => step.kind === 'mergeOrders').length,
          stores: feasible.stores, next: feasible.steps[0] ?? null, operations: feasible.steps };
        return { ...result, merges, reason: buffered[0].reason };
      }
      return { ...result, merges, reason: `合成取料需要 ${plan.need} 个空位，当前 ${state.emptyCells} 个` };
    }
    return { ...result, merges, next: plan.steps[0] ?? null, operations: plan.steps };
  });
  return requests.map((request, index) => {
    const { operations, ...estimate } = estimates[index];
    const result = searchHomelandOrder({ byId, previous, state, request, requests, takeWarehouse, warehouseBuffer, searchLimits }, operations);
    return { ...estimate, ...result, reason: result.status === 'limited' ? '规划达到检查上限，尚未找到完整方案，等待整理棋盘后重试'
      : result.status === 'unreachable' ? estimate.reason || '当前取料与保留规则下无法完成订单' : '' };
  });
}
