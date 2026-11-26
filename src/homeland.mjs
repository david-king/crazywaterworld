import { clock, dayOf, digest, natural, positive, table } from './activity-actions.mjs';
import { exactAutomationId, createActionGuard } from './automation-policy.mjs';
import { toNumber } from './client.mjs';
import { gameplayOpenDay, worldOpenDays } from './extra-rewards.mjs';
import { HOMELAND_ACTIONS, HOMELAND_DEFAULTS, homelandEnabled } from './homeland-settings.mjs';
import { planHomelandMerges, sortHomelandOrders } from './homeland-merge.mjs';

const COIN = '家园币', SHOP = 15;
const requests = {
  freeStamina: ['DualCombineBuyStaminaRequest', 'DualCombineBuyStaminaResponse'],
  freeBox: ['BuyShopProductRequest'], submitOrders: ['DualCombineSubmitOrderRequest'],
  takeWarehouse: ['DualCombineTakeFromWarehouseRequest', 'DualCombineTakeFromWarehouseResponse'],
  mergeOrders: ['DualCombineMoveRequest', 'DualCombineMoveResponse'],
  warehouseBuffer: ['DualCombinePutToWarehouseRequest', 'DualCombinePutToWarehouseResponse'],
  unlockFloors: ['HomelandUnlockRequest'], clean: ['HomelandFinishTaskRequest'],
  tech: ['HomelandTechUpRequest'], upgrade: ['HomelandLevelUpRequest'],
};
const settingsOf = options => ({ ...HOMELAND_DEFAULTS, ...(options.getSettings?.() ?? options.settings)?.homeland });
const scopeOf = player => {
  const role = exactAutomationId(player?.playerId), world = exactAutomationId(player?.worldId);
  if (!role || !world) throw Error('无法确认家园角色和区服');
  return `homeland:${world}:${role}:`;
};
const count = (value, label) => {
  const n = value == null ? NaN : toNumber(value);
  if (!natural(n)) throw Error(`${label}未完整同步`);
  return n;
};
const list = (value, label) => { if (!Array.isArray(value)) throw Error(`${label}未完整同步`); return value; };
const check = options => { if (options.enabled && !options.enabled()) throw Object.assign(Error('家园操作已暂停或连接已更换'), { notSent: true }); };
async function read(client, options, name, body = {}) {
  check(options);
  const reply = await client.request(name + 'Request', body, name + 'Response');
  check(options);
  if (!reply || typeof reply !== 'object') throw Error('未收到' + name + '状态');
  return reply;
}
function available(client, config, player) {
  for (const name of ['Homeland', 'DualCombineInfo', 'CounterInfo', 'AllItem', 'AllResource', 'ShopInfo']) {
    if (!client.protocol?.[name + 'Request'] || !client.protocol?.[name + 'Response']) return '当前协议不支持家园，请更新游戏协议';
  }
  for (const name of ['HomelandLevelCfg', 'HomelandTechCfg', 'HomelandFloorCfg', 'HomelandCleanTaskCfg', 'DualCombinePieceCfg']) {
    if (!table(config, name).length) return '家园配置尚未同步，请更新游戏资源';
  }
  const level = table(config, 'ModuleOpenCfg').find(row => row.moduleId === '家园')?.playerLevel;
  if (!positive(level) || !positive(player?.level)) return '等待家园开放条件和角色等级同步';
  if (player.level < level) return `家园需要角色 ${level} 级`;
  const days = worldOpenDays(player, clock(client)), open = gameplayOpenDay(config, player, '家园');
  if (days !== null && days < open) return `家园在本赛季第 ${open} 天开放`;
  return '';
}
const pieceName = (config, id) => table(config, 'DualCombinePieceCfg').find(row => row.pieceId === id)?.name ?? id;
const assets = (config, value) => (value ?? []).map(([id, num]) => ({ id, num,
  name: config.materialName?.(id) && config.materialName(id) !== '未知材料' ? config.materialName(id) : pieceName(config, id) }));
function pieces(value, label) {
  const rows = list(value, label).map(row => ({ uid: count(row.uid, label + '编号'), id: row.pieceCfgId }));
  if (rows.some(row => !positive(row.uid) || typeof row.id !== 'string' || !row.id) || new Set(rows.map(row => row.uid)).size !== rows.length) throw Error(label + '编号无效');
  return rows;
}
const orderIdentity = order => digest([order.slot, order.orderId, order.kind ?? 0, order.orderType ?? 0,
  count(order.expireTs ?? 0, '订单到期时间'), order.reqs.map(row => [row.pieceCfgId, row.count])]);
const quantities = pieces => {
  const out = {};
  for (const { id } of pieces) out[id] = (out[id] ?? 0) + 1;
  return out;
};

// Business state is always read before the complete bag, including reconciliation.
async function snapshot(client, config, options) {
  const home = await read(client, options, 'Homeland');
  const level = count(home.level ?? 0, '家园等级'), floor = count(home.floor ?? 0, '楼层');
  if (level === 0) throw Error('请先在游戏完成家园开启引导，再刷新家园');
  const techLevel = count(home.techLevel ?? 0, '科技等级');
  const task = list(home.task ?? [], '打扫进度').map(id => count(id, '打扫任务编号'));
  const feat = count(home.feat ?? 0, '家园功勋');
  const workshop = await read(client, options, 'DualCombineInfo');
  const cells = list(workshop.cells, '工坊棋盘');
  const cellIds = cells.map(cell => count(cell.cellId, '棋盘格子'));
  if (new Set(cellIds).size !== cellIds.length || cells.some(cell => ![0, 1, 2].includes(cell.state))) throw Error('棋盘格子状态无效');
  const board = pieces(cells.filter(cell => cell.state === 2 && cell.piece).map(cell => cell.piece), '棋盘物品');
  const warehouse = pieces(workshop.warehouse?.pieces, '工坊仓库');
  const warehouseCapacity = positive(workshop.warehouse?.warehouseCap) ? workshop.warehouse.warehouseCap : null;
  const mergeCells = cells.map(cell => ({ cellId: cell.cellId, state: cell.state,
    piece: cell.piece && cell.state !== 0 ? pieces([cell.piece], '合成棋子')[0] : null }));
  const orders = list(workshop.orders, '工坊订单');
  if (new Set(orders.map(order => order.slot)).size !== orders.length) throw Error('工坊订单槽位重复');
  for (const order of orders) {
    count(order.slot, '订单槽位'); count(order.orderId, '订单编号');
    if (!list(order.reqs, '订单需求').length || order.reqs.some(row => !positive(row.count) || typeof row.pieceCfgId !== 'string' || !row.pieceCfgId)) throw Error('订单需求无效');
  }
  const shop = await read(client, options, 'ShopInfo', { type: SHOP });
  const products = list(shop.product, '工坊商店');
  const counters = list((await read(client, options, 'CounterInfo')).counters, '累计消费');
  const matches = counters.filter(row => row.type === 'HOMELAND_COIN');
  if (matches.length > 1) throw Error('家园累计消费计数重复');
  const spent = matches.length ? count(matches[0].num, '家园累计消费') : 0;
  const next = table(config, 'HomelandLevelCfg').find(row => row.level === level + 1);
  let heroes = [];
  if (next?.heroStar?.length) heroes = list((await read(client, options, 'AllHero')).heroes, '英雄星级');
  const resources = list((await read(client, options, 'AllResource')).list, '资源库存');
  const staminaRows = resources.filter(row => row.res === 8);
  if (staminaRows.length > 1) throw Error('工坊体力记录重复');
  const stamina = staminaRows.length ? count(staminaRows[0].amount, '工坊体力') : 0;
  const items = list((await read(client, options, 'AllItem')).items, '家园币库存');
  const coins = items.filter(row => row.itemId === COIN);
  if (coins.length > 1) throw Error('家园币库存记录重复');
  return { level, floor, techLevel, task, feat, board, cells: mergeCells, warehouse, warehouseCapacity, orders, products, spent, heroes,
    coins: coins.length ? count(coins[0].num, '家园币') : 0, stamina,
    freeStaminaTime: count(workshop.lastFreeStaminaTime ?? 0, '免费体力时间'),
    emptyCells: cells.filter(cell => cell.state === 2 && !cell.piece).length,
    placed: list(home.orna ?? [], '家具').length, day: dayOf(clock(client)), now: clock(client),
  };
}

function businessConfirmed(expected, state) {
  switch (expected.kind) {
    case 'upgrade': return state.level >= expected.target;
    case 'tech': return state.techLevel >= expected.target;
    case 'clean': return state.task.includes(expected.target);
    case 'unlockFloors': return state.floor >= expected.target;
    case 'freeStamina': return state.freeStaminaTime > 0 && dayOf(state.freeStaminaTime) === expected.day;
    case 'freeBox': return state.day === expected.day && state.products.some(row => row.id === expected.target && row.buyTimes >= expected.bought + 1);
    case 'takeWarehouse': return !state.warehouse.some(row => row.uid === expected.target) && state.board.some(row => row.uid === expected.target);
    case 'warehouseBuffer': {
      const source = state.cells.find(cell => cell.cellId === expected.cellId);
      return source?.state === 2 && !source.piece
        && !state.cells.some(cell => cell.piece?.uid === expected.pieceUid)
        && state.warehouse.some(piece => piece.uid === expected.pieceUid && piece.id === expected.pieceId);
    }
    case 'mergeOrders': {
      const from = state.cells.find(cell => cell.cellId === expected.from.cellId), to = state.cells.find(cell => cell.cellId === expected.to.cellId);
      if (!from || from.state !== 2 || from.piece || !to || to.state !== 2 || to.piece?.id !== expected.nextId) return false;
      const current = [...state.cells.flatMap(cell => cell.piece ? [cell.piece] : []), ...state.warehouse];
      // Servers may preserve either input UID. It may survive only as the
      // upgraded piece in the destination, never as an unconsumed ingredient.
      return [expected.from.uid, expected.to.uid].every(uid => current.every(piece => piece.uid !== uid || piece === to.piece));
    }
    case 'submitOrders': {
      if (state.orders.some(order => orderIdentity(order) === expected.target)) return false;
      const current = new Set([...state.board, ...state.warehouse].map(piece => piece.uid));
      // Expiration alone is not a receipt: the submitted ingredients must also be gone.
      return expected.ingredients.every(({ uids, num }) => uids.filter(uid => !current.has(uid)).length >= num);
    }
    default: return false;
  }
}
const fullyConfirmed = (expected, state) => businessConfirmed(expected, state)
  && (!expected.coinCost || state.coins <= expected.coinsBefore - expected.coinCost);
function recordsFor(options) {
  const scope = scopeOf(options.player);
  return Object.entries(options.ledger?.keyRecords() ?? {}).filter(([key, row]) => key.startsWith(scope) && !row.confirmed && !row.expired);
}
const oldFreeClaim = (expected, state) => ['freeStamina', 'freeBox'].includes(expected?.kind)
  && natural(expected.day) && state.day > expected.day && !expected.coinCost;
function reconcile(options, state) {
  for (const [key, record] of recordsFor(options)) {
    if (fullyConfirmed(record.details?.expected ?? {}, state)) options.ledger.resolveKey(key, true);
    // A new daily entitlement is independent of yesterday's free claim. Keep the
    // old attempt as expired, never rewrite its unknown outcome as success.
    else if (oldFreeClaim(record.details?.expected, state)) options.ledger.retireUnknownKey(key, record);
  }
}
function plan(config, state, options) {
  const pref = settingsOf(options), actions = [], scope = scopeOf(options.player);
  const pending = recordsFor(options).filter(([, row]) => !fullyConfirmed(row.details?.expected ?? {}, state) && !oldFreeClaim(row.details?.expected, state));
  const used = options.ledger?.snapshot().counters.homelandCoins ?? 0;
  const add = (kind, target, body, detail, coinCost = 0, reason = '', evidence = {}) => {
    if (kind === 'takeWarehouse') evidence = { ...evidence, transferState: digest([state.cells, state.warehouse]) };
    const expected = { kind, target, ...evidence, ...(coinCost ? { coinCost, coinsBefore: state.coins } : {}) };
    const token = digest([scope, expected, body, coinCost]);
    const identity = [kind, target, evidence.day ?? null, kind === 'submitOrders' ? evidence.ingredients : null];
    if (kind === 'takeWarehouse') identity.push([evidence.order, evidence.transferState]);
    const key = scope + digest(identity);
    if (pending.length) reason = '前次家园操作待确认，请刷新后核对';
    else if (options.ledger?.hasKey(key)) reason ||= '该状态已处理，等待游戏同步';
    if (coinCost) {
      if (state.coins - coinCost < pref.keepCoins) reason ||= '家园币不足或低于保留量';
      if (used + coinCost > pref.dailyCoinLimit) reason ||= '今日家园币预算不足';
    }
    if (requests[kind].some(name => !options.protocol?.[name] && !options.clientProtocol?.[name])) reason ||= '当前协议缺少此操作';
    if (kind === 'warehouseBuffer' && [...requests.takeWarehouse, ...requests.mergeOrders].some(name => !options.protocol?.[name] && !options.clientProtocol?.[name]))
      reason ||= '当前协议缺少后续取料或合成操作';
    const id = `${kind}:${target}` + (['takeWarehouse', 'mergeOrders', 'warehouseBuffer'].includes(kind) ? `:${evidence.order}` : '');
    actions.push({ id, kind, title: HOMELAND_ACTIONS[kind], detail, coinCost, reason, token, body, expected, key,
      forMerge: evidence.forMerge === true, orderSlot: evidence.orderSlot ?? null });
  };
  const current = table(config, 'HomelandLevelCfg').find(row => row.level === state.level);
  const next = table(config, 'HomelandLevelCfg').find(row => row.level === state.level + 1);
  const conditions = [];
  const condition = (label, have, need) => {
    if (!natural(have) || !natural(need)) throw Error(label + '条件配置无效');
    conditions.push({ label, have, need, met: have >= need });
  };
  if (next) {
    condition('累计消费家园币', state.spent, next.cost);
    condition('角色等级', options.player.level, next.playerLevel);
    if (next.desc1) condition('已通过关卡', Math.max(0, count(options.player.mainlineStage, '主线进度') - 1), next.levelProgress);
    if (next.desc2) {
      if (!Array.isArray(next.heroStar) || next.heroStar.length !== 2 || !next.heroStar.every(positive)) throw Error('英雄星级条件配置无效');
      condition(`${next.heroStar[1]} 星及以上英雄`, state.heroes.filter(row => count(row.star ?? 0, '英雄星级') >= next.heroStar[1]).length, next.heroStar[0]);
    }
    if (next.desc3) condition('家园解锁后功勋', state.feat, next.totalScore);
  }
  const freeStaminaClaimed = state.freeStaminaTime > 0 && dayOf(state.freeStaminaTime) === state.day;
  const freeProducts = [];
  if (!freeStaminaClaimed) add('freeStamina', state.day, { isDailyFree: true }, '领取每日免费工坊体力', 0, '', { day: state.day });
  for (const product of state.products) {
    // The daily shelves are 1..3. A decoded protobuf null price means free in
    // DualCombineShopItem; an undefined or malformed quote is not authoritative.
    if (![1, 2, 3].includes(product.id) || product.price === undefined
      || (product.price !== null && count(product.price.num ?? 0, '商品价格') !== 0)) continue;
    const bought = count(product.buyTimes ?? 0, '已购次数'), limit = count(product.limitBuyTimes, '限购次数');
    freeProducts.push({ bought, limit });
    if (bought < limit) add('freeBox', product.id, { type: SHOP, id: product.id, num: 1 }, '领取商店免费宝箱，进入工坊奖励区', 0, '', { day: state.day, bought });
  }
  const board = quantities(state.board), warehouse = quantities(state.warehouse);
  const orders = sortHomelandOrders(state.orders).map(order => {
    const requirements = new Map();
    for (const row of order.reqs) requirements.set(row.pieceCfgId, (requirements.get(row.pieceCfgId) ?? 0) + row.count);
    const needs = [...requirements].map(([id, num]) => ({ id, name: pieceName(config, id), num, board: board[id] ?? 0, warehouse: warehouse[id] ?? 0 }));
    const expiresAt = count(order.expireTs ?? 0, '订单到期时间');
    const expired = expiresAt > 0 && expiresAt <= state.now;
    const ready = needs.every(row => row.board >= row.num), target = orderIdentity(order);
    const label = `订单 ${order.slot + 1}：` + needs.map(row => `${row.name} ×${row.num}`).join('、');
    const ingredients = needs.map(row => ({ num: row.num, uids: state.board.filter(piece => piece.id === row.id).map(piece => piece.uid) }));
    add('submitOrders', target, { slot: order.slot }, label, 0, expired ? '订单已到期，等待刷新' : !ready ? '棋盘上物品不足' : '', { ingredients, orderSlot: order.slot });
    const missing = needs.find(row => row.num > row.board && row.warehouse > 0);
    if (missing && !expired) {
      const piece = state.warehouse.find(row => row.id === missing.id);
      add('takeWarehouse', piece.uid, { pieceUid: piece.uid }, `取出${missing.name}，用于订单 ${order.slot + 1}`, 0,
        state.emptyCells ? '' : '棋盘没有空位', { order: target, orderSlot: order.slot });
    }
    return { slot: order.slot, limited: order.orderType === 1, expiresAt, requirements: needs, ready: ready && !expired, synthesis: null };
  });
  for (const recipe of planHomelandMerges(config, state, { takeWarehouse: pref.takeWarehouse, warehouseBuffer: pref.warehouseBuffer })) {
    const order = orders.find(row => row.slot === recipe.slot), next = recipe.next;
    order.synthesis = { merges: recipe.merges, stores: recipe.stores, takes: recipe.takes, steps: recipe.steps,
      status: recipe.status, lowerBound: recipe.lowerBound, reason: recipe.reason };
    if (!next) continue;
    const evidence = { order: orderIdentity(recipe.order), orderSlot: recipe.slot, forMerge: true };
    if (next.kind === 'takeWarehouse') {
      const existing = actions.find(action => action.kind === 'takeWarehouse' && action.expected.target === next.piece.uid && action.orderSlot === recipe.slot);
      if (existing) existing.recipeStep = true;
      else
        add('takeWarehouse', next.piece.uid, { pieceUid: next.piece.uid }, `取出${pieceName(config, next.piece.id)}，用于合成订单 ${recipe.slot + 1}`, 0, '', evidence);
    } else if (next.kind === 'warehouseBuffer') {
      const { piece } = next;
      const target = digest([piece.uid, evidence.order, state.cells, state.warehouse]);
      add('warehouseBuffer', target, { cellId: piece.cellId }, `暂存${pieceName(config, piece.id)}到仓库，为订单 ${recipe.slot + 1} 腾位`, 0, '',
        { ...evidence, pieceUid: piece.uid, pieceId: piece.id, cellId: piece.cellId, warehouseCapacity: state.warehouseCapacity });
    } else {
      const { from, to, nextId } = next;
      if (from.location !== 'board' || !['board', 'half'].includes(to.location) || from.id !== to.id || from.uid === to.uid) throw Error('合成首步依赖尚未就绪');
      add('mergeOrders', digest([from.uid, to.uid, from.id, nextId]), { fromCellId: from.cellId, toCellId: to.cellId },
        `${pieceName(config, from.id)} ×2 → ${pieceName(config, nextId)}，用于订单 ${recipe.slot + 1}`, 0, '',
        { ...evidence, from: { uid: from.uid, cellId: from.cellId, id: from.id }, to: { uid: to.uid, cellId: to.cellId, state: to.state }, nextId });
    }
  }
  if (next) add('upgrade', next.level, {}, `家园 ${state.level} → ${next.level} 级`, 0,
    state.level === 0 ? '请先在游戏完成家园开启引导' : conditions.filter(row => !row.met).map(row => `${row.label} ${row.have}/${row.need}`).join('；'));
  const floors = table(config, 'HomelandFloorCfg').map(row => {
    if (!positive(row.floor) || !positive(row.unlockLevel)) throw Error('楼层配置无效');
    if (row.floor === state.floor + 1) add('unlockFloors', row.floor, { floor: row.floor }, `开放第 ${row.floor} 层`, 0,
      state.level < row.unlockLevel ? `需要家园 ${row.unlockLevel} 级` : '');
    const tasks = list(row.taskIds, '楼层打扫配置').map(id => {
      const cfg = table(config, 'HomelandCleanTaskCfg').find(task => task.id === id);
      if (!cfg || !Array.isArray(cfg.cost) || cfg.cost[0] !== COIN || !positive(cfg.cost[1])) throw Error('打扫费用配置无效');
      const done = state.task.includes(id);
      if (!done) add('clean', id, { taskId: id }, `打扫第 ${row.floor} 层 · 任务 ${id}`, cfg.cost[1], row.floor > state.floor ? '楼层尚未解锁' : '');
      return { id, done, cost: cfg.cost[1], rewards: assets(config, cfg.rewards) };
    });
    return { floor: row.floor, unlockLevel: row.unlockLevel, unlocked: row.floor <= state.floor, tasks };
  });
  const tech = table(config, 'HomelandTechCfg').find(row => row.level === state.techLevel + 1);
  if (tech) {
    if (!Array.isArray(tech.unlockCost) || tech.unlockCost[0] !== COIN || !positive(tech.unlockCost[1])) throw Error('科技费用配置无效');
    add('tech', tech.level, {}, `科技 ${tech.level} · ${tech.name}（${tech.camp || tech.career || '全部英雄'}）`, tech.unlockCost[1],
      state.level < tech.homelandLevel ? `需要家园 ${tech.homelandLevel} 级` : '');
  }
  return { actions, available: true, reason: '', level: state.level, name: current?.name ?? '尚未开启', floor: state.floor,
    techLevel: state.techLevel, coins: state.coins, spent: state.spent, stamina: state.stamina, placed: state.placed,
    capacity: Math.floor((current?.capacity ?? 0) / 100), nextLevel: next?.level ?? null, conditions,
    warehouse: { used: state.warehouse.length, capacity: state.warehouseCapacity },
    tech: tech ? { level: tech.level, name: tech.name, requirement: tech.homelandLevel, cost: tech.unlockCost[1], attribute: `${tech.attr?.[0]} +${tech.attr?.[1]}` } : null,
    floors, orders, freeStaminaClaimed,
    freeBoxClaimed: freeProducts.length > 0 && freeProducts.every(row => row.limit > 0 && row.bought >= row.limit),
    pending: pending.map(([, row]) => row.details?.label ?? '家园操作'),
    budget: { used, limit: pref.dailyCoinLimit, keep: pref.keepCoins }, checkedAt: new Date().toISOString(),
  };
}
const publicView = view => ({ ...view, actions: view.actions.map(({ body, expected, key, ...action }) => action) });
export async function readHomeland(client, config, options) {
  check(options);
  const reason = available(client, config, options.player);
  if (reason) return { available: false, reason };
  const state = await snapshot(client, config, options);
  return publicView(plan(config, state, { ...options, clientProtocol: client.protocol }));
}

// All callers use the account write queue. A durable key is acquired before any mutation.
export async function executeHomeland(client, config, options) {
  const { id, token, ledger } = options;
  if (!ledger || !options.guard) throw Error('家园消费保护尚未就绪');
  check(options);
  const reason = available(client, config, options.player);
  if (reason) return { status: 'rejected', message: reason };
  const epoch = client.connectionEpoch, scope = scopeOf(options.player);
  const active = () => (!options.enabled || options.enabled()) && client.connected !== false
    && epoch === client.connectionEpoch && scopeOf(options.player) === scope;
  const state = await snapshot(client, config, { ...options, enabled: active });
  reconcile(options, state);
  const view = plan(config, state, { ...options, clientProtocol: client.protocol });
  const action = view.actions.find(row => row.id === id);
  if (!action || action.token !== token || action.reason) return { status: 'rejected', message: action?.reason || '家园状态已变化，请刷新后重试' };
  const permitted = () => active()
    && (action.kind !== 'warehouseBuffer' || settingsOf(options).warehouseBuffer && settingsOf(options).takeWarehouse)
    && (!options.automatic || homelandEnabled(options.getSettings())
    && settingsOf(options)[action.kind] === true
    && (action.kind !== 'takeWarehouse' || settingsOf(options).submitOrders === true)
    && (action.kind !== 'mergeOrders' || settingsOf(options).submitOrders === true)
    && (action.kind !== 'warehouseBuffer' || settingsOf(options).submitOrders === true)
    && (!action.forMerge || settingsOf(options).mergeOrders === true)
    && (action.kind !== 'upgrade' || action.expected.target <= settingsOf(options).targetLevel)
    && (action.kind !== 'tech' || action.expected.target <= settingsOf(options).targetTech));
  const [request, response] = requests[action.kind];
  const step = { kind: 'homeland', request, body: action.body, label: action.detail,
    costs: action.coinCost ? [{ id: COIN, num: action.coinCost }] : [],
    verifyGrowth: async connection => businessConfirmed(action.expected, await snapshot(connection, config,
      { ...options, enabled: () => connection.connected !== false && scopeOf(options.player) === scope })) };
  let hold, ticket, attempted = false, writeRejected = false;
  try {
    if (!permitted()) return { status: 'cancelled', message: '家园操作已关闭或目标已达到' };
    ticket = await options.guard.before(step);
    const final = await snapshot(client, config, { ...options, enabled: active });
    const fresh = plan(config, final, { ...options, clientProtocol: client.protocol }).actions.find(row => row.id === id);
    if (!fresh || fresh.token !== token || fresh.reason) throw Object.assign(Error(fresh?.reason || '发送前家园状态已变化'), { notSent: true });
    hold = ledger.reserve(action.coinCost ? { homelandCoins: action.coinCost } : {},
      { homelandCoins: settingsOf(options).dailyCoinLimit }, {}, { uniqueKey: action.key, details: { expected: action.expected, label: action.detail } });
    const beforeSend = () => {
      const latest = settingsOf(options);
      if (!permitted() || (action.expected.day !== undefined && dayOf(clock(client)) !== action.expected.day)
        || (action.coinCost && (final.coins - action.coinCost < latest.keepCoins
          || ledger.snapshot().counters.homelandCoins > latest.dailyCoinLimit))) throw Object.assign(Error('开关、预算、日期或连接已变化'), { notSent: true });
      if (['submitOrders', 'mergeOrders', 'takeWarehouse', 'warehouseBuffer'].includes(action.kind)) {
        const order = final.orders.find(row => row.slot === action.orderSlot);
        if (!order || (count(order.expireTs ?? 0, '订单到期时间') > 0 && count(order.expireTs, '订单到期时间') <= clock(client))) throw Object.assign(Error('订单已到期'), { notSent: true });
      }
    };
    try {
      attempted = true;
      if (response) await client.request(request, action.body, response, 15000, beforeSend);
      else await client.sendWatch(request, action.body, { beforeSend });
    } catch (error) {
      writeRejected = error.notSent === true || !!(error.prompt && error.request === request);
      if (writeRejected) throw error;
      // Missing acknowledgements are resolved only by business evidence below.
    }
    const after = await snapshot(client, config, { ...options, enabled: active });
    if (!fullyConfirmed(action.expected, after)) throw Error('等待游戏回读确认进度与库存');
    ledger.confirm(hold);
    const result = { status: 'confirmed', ok: true, message: action.detail + '，已确认', label: action.detail };
    try { await options.guard.after(step, ticket, result); } catch { /* A failed observer cannot undo confirmed business and inventory evidence. */ }
    return result;
  } catch (error) {
    const notSent = !attempted || (writeRejected && error.notSent === true);
    if (notSent || writeRejected) ledger.cancel(hold);
    await options.guard.cancel(step, ticket, { notSent, error: writeRejected ? error : { message: error.message } });
    return { status: notSent ? 'cancelled' : writeRejected ? 'rejected' : 'pending',
      message: action.detail + '：' + (notSent || writeRejected ? error.message : '结果待确认，暂停后续家园操作。' + error.message) };
  }
}

const schedules = new WeakMap();
export async function runHomeland(client, config, options) {
  const settings = options.getSettings(), pref = settingsOf(options), now = clock(client);
  if (!homelandEnabled(settings) || !Object.keys(HOMELAND_ACTIONS).some(key => pref[key]) || !options.enabled()) return [];
  const signature = digest([pref, dayOf(now)]), previous = schedules.get(client);
  if (previous?.signature === signature && previous.next > now) return [];
  const result = [], report = entry => { result.push(entry); options.report?.({ ...entry, label: entry.message, taskKey: 'homeland.enabled' }); };
  const dailyOnly = !['submitOrders', 'unlockFloors', 'clean', 'tech', 'upgrade'].some(key => pref[key]);
  const completion = scopeOf(options.player) + 'daily:' + dayOf(now) + ':' + digest([pref.freeStamina, pref.freeBox]);
  if (dailyOnly && options.ledger.hasDailyCompletion(completion)) return [];
  try {
    for (let i = 0; i < 20 && options.enabled() && homelandEnabled(options.getSettings()); i++) {
      const reason = available(client, config, options.player);
      if (reason) { report({ skipped: true, message: reason }); break; }
      const state = await snapshot(client, config, options);
      reconcile(options, state);
      const view = plan(config, state, { ...options, clientProtocol: client.protocol });
      const current = settingsOf(options);
      const priority = ['freeStamina', 'freeBox', 'submitOrders', 'mergeOrders', 'warehouseBuffer', 'takeWarehouse', 'upgrade', 'unlockFloors', 'clean', 'tech'];
      const candidates = view.actions.filter(action => current[action.kind] === true
        && (action.kind !== 'takeWarehouse' || current.submitOrders)
        && (action.kind !== 'mergeOrders' || current.submitOrders)
        && (action.kind !== 'warehouseBuffer' || current.submitOrders && current.takeWarehouse)
        && (!action.forMerge || current.mergeOrders)
        && (action.kind !== 'upgrade' || action.expected.target <= current.targetLevel)
        && (action.kind !== 'tech' || action.expected.target <= current.targetTech));
      const action = candidates.filter(action => !action.reason).sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind)
        || Number(b.recipeStep || b.forMerge) - Number(a.recipeStep || a.forMerge))[0];
      if (!action) {
        const waiting = candidates.map(row => row.reason);
        if (current.submitOrders && current.mergeOrders) waiting.push(...view.orders.map(row => row.synthesis?.reason));
        if (dailyOnly && !view.pending.length && (!current.freeStamina || view.freeStaminaClaimed)
          && (!current.freeBox || view.freeBoxClaimed)) options.ledger.markDailyCompletion(completion);
        report({ skipped: true, status: view.pending.length ? 'pending' : 'waiting', message: view.pending.length
          ? '前次家园操作待确认' : [...new Set(waiting.filter(Boolean))].join('；') || '所选家园任务已完成，等待下一次检查' });
        break;
      }
      const outcome = await executeHomeland(client, config, { ...options, id: action.id, token: action.token, automatic: true,
        guard: createActionGuard(client, options.getSettings, options.ledger, { player: options.player, config, enabled: options.enabled }) });
      report(outcome);
      if (outcome.status !== 'confirmed') break;
    }
  } finally { schedules.set(client, { signature, next: clock(client) + pref.checkEverySeconds }); }
  return result;
}
