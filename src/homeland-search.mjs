// Unit-cost A* over interchangeable pieces, not cell permutations. The model
// preserves exact reserved UIDs when it binds the first operation for execution.
// No adjacency rules exist in DualCombineMove: only piece type and lock state
// affect legality. Producers, usable items and unrelated merges are excluded.
const cache = new Map();
const ordinary = row => ['普通', '产品'].includes(row?.type);
const total = rows => rows.reduce((sum, count) => sum + count, 0);

class OpenSet {
  rows = [];
  before(a, b) { return a.f < b.f || a.f === b.f && (a.g > b.g || a.g === b.g && a.serial < b.serial); }
  push(node) {
    const rows = this.rows; let i = rows.length; rows.push(node);
    while (i) { const p = (i - 1) >> 1; if (!this.before(node, rows[p])) break; rows[i] = rows[p]; i = p; }
    rows[i] = node;
  }
  pop() {
    const rows = this.rows, first = rows[0], last = rows.pop();
    if (rows.length) {
      let i = 0;
      while (i * 2 + 1 < rows.length) {
        let child = i * 2 + 1;
        if (child + 1 < rows.length && this.before(rows[child + 1], rows[child])) child++;
        if (!this.before(rows[child], last)) break;
        rows[i] = rows[child]; i = child;
      }
      rows[i] = last;
    }
    return first;
  }
}

function modelFor({ byId, previous, state, request, requests, takeWarehouse, warehouseBuffer }) {
  const relevant = new Set(request.needs.keys());
  for (const id of relevant) if (previous.get(id)) relevant.add(previous.get(id));
  const ids = [...relevant].sort((a, b) => (byId.get(b)?.level ?? 0) - (byId.get(a)?.level ?? 0) || a.localeCompare(b));
  const types = [], free = new Map();
  for (const id of ids) { free.set(id, types.length); types.push({ id, role: 'free', store: ordinary(byId.get(id)), load: true }); }
  // All unrelated or other-order-reserved ordinary board pieces have the same
  // effect: they can be parked but never consumed or unnecessarily fetched.
  const spare = types.length; types.push({ id: '', role: 'spare', store: true, load: false });
  const reserved = new Map();
  for (const row of requests) if (row !== request) for (const piece of row.reserved) reserved.set(piece.uid, spare);
  const n = types.length, initial = Array(n * 3).fill(0), pools = types.map(() => ({ board: [], warehouse: [], half: [] })), uidType = new Map();
  const put = (piece, location) => {
    let index = reserved.get(piece.uid);
    if (index === undefined) index = free.get(piece.id) ?? spare;
    // Spare producers/usable items and irrelevant half-locked cells stay fixed.
    if (index === spare && (!ordinary(byId.get(piece.id)) || location !== 'board')) return;
    if (location === 'warehouse' && !takeWarehouse) return;
    initial[index + (location === 'board' ? 0 : location === 'warehouse' ? n : n * 2)]++;
    pools[index][location].push(piece); uidType.set(piece.uid, index);
  };
  for (const cell of state.cells) if (cell.piece && [1, 2].includes(cell.state)) {
    const location = cell.state === 1 ? 'half' : 'board';
    put({ ...cell.piece, cellId: cell.cellId, state: cell.state, location }, location);
  }
  for (const piece of state.warehouse) put({ ...piece, location: 'warehouse' }, 'warehouse');
  for (const pool of pools) for (const values of Object.values(pool)) values.sort((a, b) => a.uid - b.uid);
  const recipes = [];
  for (const id of ids) {
    const lower = previous.get(id);
    if (lower && free.has(lower)) recipes.push({ from: free.get(lower), to: free.get(id) });
  }
  const goals = [...request.needs].map(([id, count]) => ({ index: free.get(id), count }));
  const boardCapacity = state.emptyCells + total(initial.slice(0, n)) + total(initial.slice(n * 2));
  const fixedWarehouse = state.warehouse.length - total(initial.slice(n, n * 2));
  const warehouseCapacity = Number.isSafeInteger(state.warehouseCapacity) && state.warehouseCapacity > 0 ? state.warehouseCapacity : 0;
  const store = !!(takeWarehouse && warehouseBuffer && warehouseCapacity);
  return { types, n, initial, pools, uidType, free, ids, previous, recipes, goals, boardCapacity, fixedWarehouse,
    warehouseCapacity, store, take: !!takeWarehouse };
}

function engine(model) {
  const { n, goals, recipes, types, boardCapacity, fixedWarehouse, warehouseCapacity } = model;
  const counts = state => ({ empty: boardCapacity - total(state.slice(0, n)) - total(state.slice(n * 2)),
    warehouse: fixedWarehouse + total(state.slice(n, n * 2)) });
  const goal = state => goals.every(row => state[row.index] >= row.count);
  const apply = (state, op) => {
    const { empty, warehouse } = counts(state), next = [...state], i = op.index;
    if (op.kind === 'mergeOrders') {
      if (!recipes.some(row => row.from === i && row.to === op.output)) return null;
      if (op.half) {
        if (state[i] < 1 || state[i + n * 2] < 1) return null;
        next[i]--; next[i + n * 2]--;
      } else { if (state[i] < 2) return null; next[i] -= 2; }
      next[op.output]++;
    } else if (op.kind === 'takeWarehouse') {
      if (!model.take || !types[i]?.load || empty < 1 || state[i + n] < 1) return null;
      next[i + n]--; next[i]++;
    } else if (op.kind === 'warehouseBuffer') {
      if (!model.store || !types[i]?.store || warehouse >= warehouseCapacity || state[i] < 1) return null;
      next[i]--; next[i + n]++;
    } else return null;
    return next;
  };
  // Relax board/warehouse capacity, treat half-locked items as freely usable,
  // and count only compulsory merges. Descending demands share available stock
  // across mixed-level goals. This cannot overestimate remaining operation cost.
  const heuristic = state => {
    const demands = new Map();
    let boardDeficit = 0;
    for (const row of goals) {
      demands.set(row.index, row.count);
      boardDeficit += Math.max(0, row.count - state[row.index]);
    }
    let merges = 0;
    for (const id of model.ids) {
      const i = model.free.get(id), available = state[i] + state[i + n] + state[i + n * 2];
      const missing = Math.max(0, (demands.get(i) ?? 0) - available);
      if (!missing) continue;
      const lower = model.previous.get(id);
      if (!lower || !model.free.has(lower)) return Infinity;
      merges += missing;
      const lowerIndex = model.free.get(lower);
      demands.set(lowerIndex, (demands.get(lowerIndex) ?? 0) + missing * 2);
    }
    return Math.max(merges, boardDeficit);
  };
  const successors = state => {
    const operations = [], { empty, warehouse } = counts(state);
    for (const row of recipes) {
      if (state[row.from] && state[row.from + n * 2]) operations.push({ kind: 'mergeOrders', index: row.from, output: row.to, half: true });
      if (state[row.from] >= 2) operations.push({ kind: 'mergeOrders', index: row.from, output: row.to, half: false });
    }
    for (let i = 0; i < n; i++) if (model.take && empty > 0 && types[i].load && state[i + n]) operations.push({ kind: 'takeWarehouse', index: i });
    for (let i = 0; i < n; i++) if (model.store && warehouse < warehouseCapacity && types[i].store && state[i]) operations.push({ kind: 'warehouseBuffer', index: i });
    return operations;
  };
  return { goal, apply, heuristic, successors };
}

function incumbentFor(steps, model, machine) {
  if (!steps) return null;
  const indexOf = piece => piece.uid ? model.uidType.get(piece.uid) : model.free.get(piece.id);
  const operations = [];
  let state = model.initial;
  for (const step of steps) {
    const index = indexOf(step.kind === 'mergeOrders' ? step.from : step.piece);
    if (index === undefined) return null;
    const op = step.kind === 'mergeOrders' ? { kind: step.kind, index, output: model.free.get(step.nextId), half: step.to.location === 'half' }
      : { kind: step.kind, index };
    if (step.kind === 'mergeOrders' && indexOf(step.to) !== index) return null;
    state = machine.apply(state, op); if (!state) return null;
    operations.push(op);
  }
  return machine.goal(state) ? operations : null;
}

function search(model, estimate, limits) {
  const machine = engine(model), initialH = machine.heuristic(model.initial);
  let best = incumbentFor(estimate, model, machine), expanded = 0, serial = 0, limited = false;
  if (machine.goal(model.initial)) return { status: 'optimal', operations: [], lowerBound: 0, expanded };
  if (!Number.isFinite(initialH)) return { status: 'unreachable', operations: null, lowerBound: null, expanded };
  const open = new OpenSet(), costs = new Map(), root = { state: model.initial, g: 0, f: initialH, parent: null, op: null, serial: serial++ };
  open.push(root); costs.set(model.initial.join(','), 0);
  const started = performance.now();
  const path = node => { const result = []; for (; node.op; node = node.parent) result.push(node.op); return result.reverse(); };
  let lowerBound = initialH;
  while (open.rows.length) {
    const node = open.pop(), key = node.state.join(',');
    if (costs.get(key) !== node.g) continue;
    lowerBound = node.f;
    if (best && node.f >= best.length) return { status: 'optimal', operations: best, lowerBound: best.length, expanded };
    if (machine.goal(node.state)) return { status: 'optimal', operations: path(node), lowerBound: node.g, expanded };
    if (expanded >= limits.maxExpanded || costs.size >= limits.maxStates || performance.now() - started >= limits.maxMilliseconds) { limited = true; break; }
    expanded++;
    for (const op of machine.successors(node.state)) {
      const state = machine.apply(node.state, op), g = node.g + 1, stateKey = state.join(',');
      if ((costs.get(stateKey) ?? Infinity) <= g) continue;
      const h = machine.heuristic(state);
      if (!Number.isFinite(h) || best && g + h >= best.length) continue;
      const child = { state, g, f: g + h, parent: node, op, serial: serial++ };
      if (machine.goal(state)) { best = path(child); continue; }
      costs.set(stateKey, g); open.push(child);
    }
  }
  return { status: limited ? best ? 'feasible' : 'limited' : best ? 'optimal' : 'unreachable', operations: best,
    lowerBound: limited ? lowerBound : best?.length ?? null, expanded };
}

export function searchHomelandOrder(context, estimate) {
  const model = modelFor(context);
  const limits = { maxExpanded: 12000, maxStates: 40000, maxMilliseconds: 100, ...context.searchLimits };
  for (const key of Object.keys(limits)) if (!Number.isFinite(limits[key]) || limits[key] < 0) throw Error('合成搜索预算无效');
  const key = JSON.stringify([model.types, model.initial, model.recipes, model.goals, model.boardCapacity, model.fixedWarehouse,
    model.warehouseCapacity, model.store, model.take, limits]);
  let result = cache.get(key);
  if (!result) {
    result = search(model, estimate, limits);
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(key, result);
  }
  const op = result.operations?.[0];
  let next = null;
  if (op?.kind === 'mergeOrders') {
    const pool = model.pools[op.index];
    next = { kind: op.kind, from: pool.board[0], to: op.half ? pool.half[0] : pool.board[1], nextId: model.types[op.output].id };
  } else if (op) next = { kind: op.kind, piece: model.pools[op.index][op.kind === 'takeWarehouse' ? 'warehouse' : 'board'][0] };
  return { status: result.status, next, steps: result.operations?.length ?? null, lowerBound: result.lowerBound, expanded: result.expanded,
    merges: result.operations?.filter(op => op.kind === 'mergeOrders').length ?? 0,
    stores: result.operations?.filter(op => op.kind === 'warehouseBuffer').length ?? 0,
    takes: result.operations?.filter(op => op.kind === 'takeWarehouse').length ?? 0 };
}
