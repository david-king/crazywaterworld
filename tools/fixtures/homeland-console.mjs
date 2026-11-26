import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Independent server model. Every reply and request passes through the shipped codecs.
export const homelandTables = {
  ModuleOpenCfg: [{ moduleId: '家园', playerLevel: 20 }],
  GameplayOpenCfg: [{ gameplay: '家园', openDays: [2, 1] }],
  ItemCfg: ['家园币', '藏品券'].map(id => ({ id, show_name: id })),
  ResourceCfg: [{ id: 'DUAL_COMBINE_STAMINA', show_name: '工坊体力' }],
  HomelandLevelCfg: [
    { level: 1, name: '漏水木板房', capacity: 1500, cost: 0, playerLevel: 20, heroStar: [] },
    { level: 2, name: '漏水木板房', capacity: 1800, cost: 100, playerLevel: 21, heroStar: [] },
    { level: 3, name: '边角料小屋', capacity: 2100, cost: 250, playerLevel: 22, heroStar: [] },
    { level: 4, name: '边角料小屋', capacity: 2400, cost: 550, playerLevel: 23, desc1: '通过关卡', levelProgress: 300, heroStar: [] },
  ],
  HomelandTechCfg: [1, 2, 3].map(level => ({ level, name: ['生命', '法强', '攻击'][level - 1], homelandLevel: 2, camp: '阵营A', unlockCost: ['家园币', 50], attr: ['最终生命', 1500] })),
  HomelandFloorCfg: [
    { floor: 1, unlockLevel: 1, taskIds: [1, 2] },
    { floor: 2, unlockLevel: 3, taskIds: [3] },
  ],
  HomelandCleanTaskCfg: [1, 2, 3].map(id => ({ id, cost: ['家园币', id + 2], rewards: [['藏品券', 1]] })),
  DualCombinePieceCfg: [
    ...[1, 2, 3, 4].map(level => ({ pieceId: '鱼' + level, pieceGroup: '鱼', type: level < 3 ? '普通' : '产品',
      name: ['鱼', '生鱼片', '鱼饼', '鱼丸'][level - 1], level, nextId: level < 4 ? '鱼' + (level + 1) : '', price: level })),
    ...[1, 2].map(level => ({ pieceId: '钩' + level, pieceGroup: '钩', type: '生产器', name: '生产器', level, nextId: level === 1 ? '钩2' : '' })),
    ...[1, 2].map(level => ({ pieceId: '体力瓶' + level, pieceGroup: '体力', type: '可使用', name: '体力瓶', level, nextId: level === 1 ? '体力瓶2' : '' })),
  ],
};
const configPack = () => Object.entries(homelandTables).map(([name, data], i) => [i, name, { data }]);

export function createHomelandClient(protocol, id = 1, shared) {
  const state = shared ?? {
    home: { level: 2, floor: 1, techLevel: 0, task: [], hero: [], orna: [], feat: 0 },
    coins: 200, spent: 100, stamina: 10, lastFree: 0, bought: 0,
    cells: [{ cellId: 0, state: 2, piece: { uid: 1, pieceCfgId: '鱼1' } }, { cellId: 1, state: 2 }, { cellId: 2, state: 1, piece: { uid: 3, pieceCfgId: '鱼2' } }],
    warehouse: [{ uid: 2, pieceCfgId: '鱼2' }],
    warehouseCapacity: 5,
    orders: [{ slot: 0, orderId: 11, kind: 2, orderType: 0, expireTs: 0, reqs: [{ pieceCfgId: '鱼1', count: 1 }] }],
    calls: [], writes: [], drop: null, reject: null, beforeWrite: null, beforeRead: null,
  };
  const player = { playerId: 1000 + id, worldId: 2001, guildId: 0, level: 30, mainlineStage: 501, worldOpenTime: 1700000000 };
  const client = Object.assign(new EventEmitter(), { connected: true, connectionEpoch: 1, protocol, serverClockOffsetMs: 0,
    snapshot() { return { state: 'READY' }; }, stop() { this.connected = false; },
  });
  const round = (name, value) => {
    assert(protocol[name], name);
    return protocol[name].decode(protocol[name].encode(value).finish());
  };
  function apply(name, body) {
    if (name === 'DualCombineBuyStaminaRequest') { assert.equal(body.isDailyFree, true); state.lastFree = Math.floor((Date.now() + client.serverClockOffsetMs) / 1000); state.stamina += 100; return { lastFreeStaminaTime: state.lastFree, buyStaminaTimes: 0 }; }
    if (name === 'BuyShopProductRequest') { assert.deepEqual({ type: body.type, id: body.id, num: body.num }, { type: 15, id: 3, num: 1 }); state.bought++; return {}; }
    if (name === 'HomelandTechUpRequest') { state.home.techLevel++; state.coins -= 50; state.spent += 50; return {}; }
    if (name === 'HomelandLevelUpRequest') { state.home.level++; return {}; }
    if (name === 'HomelandUnlockRequest') { state.home.floor = body.floor; return {}; }
    if (name === 'HomelandFinishTaskRequest') { state.home.task.push(body.taskId); state.coins -= body.taskId + 2; return {}; }
    if (name === 'DualCombineTakeFromWarehouseRequest') {
      const index = state.warehouse.findIndex(row => row.uid === body.pieceUid); assert(index >= 0);
      const cell = state.cells.find(row => row.state === 2 && !row.piece); assert(cell);
      cell.piece = state.warehouse.splice(index, 1)[0]; return { pieceUid: body.pieceUid, cell };
    }
    if (name === 'DualCombinePutToWarehouseRequest') {
      const cell = state.cells.find(row => row.cellId === body.cellId);
      assert(cell?.state === 2 && cell.piece);
      assert(state.warehouseCapacity > state.warehouse.length);
      const pieceUid = cell.piece.uid;
      state.warehouse.push(cell.piece); delete cell.piece;
      return { pieceUid, cell };
    }
    if (name === 'DualCombineMoveRequest') {
      const from = state.cells.find(row => row.cellId === body.fromCellId), to = state.cells.find(row => row.cellId === body.toCellId);
      assert(from && to && from !== to && from.state === 2 && [1, 2].includes(to.state));
      assert(from.piece && to.piece && from.piece.pieceCfgId === to.piece.pieceCfgId);
      const cfg = homelandTables.DualCombinePieceCfg.find(row => row.pieceId === from.piece.pieceCfgId); assert(cfg?.nextId);
      const uid = state.mergeUid === 'source' ? from.piece.uid : state.mergeUid === 'new' ? (state.nextUid = (state.nextUid ?? 10000) + 1) : to.piece.uid;
      delete from.piece; to.state = 2; to.piece = { uid, pieceCfgId: cfg.nextId };
      return { cells: [from, to] };
    }
    if (name === 'DualCombineSubmitOrderRequest') {
      const order = state.orders.find(row => row.slot === body.slot); assert(order);
      for (const req of order.reqs) for (let i = 0; i < req.count; i++) {
        const cell = state.cells.find(row => row.state === 2 && row.piece?.pieceCfgId === req.pieceCfgId); assert(cell);
        delete cell.piece;
      }
      state.orders = state.orders.filter(row => row !== order); state.coins += 2; return {};
    }
    throw Error('意外写入 ' + name);
  }
  const write = async (name, body, beforeSend) => {
    await state.beforeWrite?.(name);
    beforeSend?.();
    body = round(name, body);
    state.writes.push({ name, body });
    if (state.reject === name) throw Object.assign(Error('明确拒绝'), { prompt: 1, request: name });
    if (state.drop === name) throw Error('模拟断线，结果未知');
    const result = apply(name, body);
    if (state.drop === 'after:' + name) throw Error('回执丢失');
    return result;
  };
  client.request = async (name, body, response, timeout, beforeSend) => {
    state.calls.push(name); round(name, body);
    if (['DualCombineBuyStaminaRequest', 'DualCombineTakeFromWarehouseRequest', 'DualCombinePutToWarehouseRequest', 'DualCombineMoveRequest'].includes(name)) return round(response, await write(name, body, beforeSend));
    await state.beforeRead?.(name);
    let value;
    if (name === 'HomelandRequest') value = state.home;
    else if (name === 'DualCombineInfoRequest') value = { cells: state.cells, warehouse: { pieces: state.warehouse, warehouseCap: state.warehouseCapacity, buyTimes: 0 }, orders: state.orders, lastFreeStaminaTime: state.lastFree, chestCount: state.bought, buyStaminaTimes: 0 };
    else if (name === 'CounterInfoRequest') value = { counters: [{ type: 'HOMELAND_COIN', num: state.spent }] };
    else if (name === 'AllHeroRequest') value = { heroes: [{ heroId: '测试英雄', star: 5 }] };
    else if (name === 'AllResourceRequest') value = { list: [1, 3, 4, 5, 6, 7, 8].map(res => ({ res, amount: res === 8 ? state.stamina : 1000 })) };
    else if (name === 'AllItemRequest') value = { items: [{ itemId: '家园币', num: state.staleCoins ?? state.coins }] };
    else if (name === 'ShopInfoRequest') { assert.equal(body.type, 15); value = { product: state.products ?? [{ id: 1, price: { id: 'RUBY', num: 50 }, limitBuyTimes: 1 }, { id: 3, price: null, buyTimes: state.bought, limitBuyTimes: 1 }] }; }
    else throw Error('意外读取 ' + name);
    return round(response, value);
  };
  client.sendWatch = (name, body, options = {}) => write(name, body, options.beforeSend);
  return { client, player, state };
}

export async function createHomelandHarness({ http = false } = {}) {
  const temporary = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporary, 'cw-homeland-'));
  process.env.CW_DATA_DIR = directory;
  process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
  process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
  process.env.CW_RESOURCE_AUTO_UPDATE = '0';
  fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(configPack()));
  const { loadProtocol } = await import('../../src/proto.mjs');
  const { BUNDLED_PROTOCOL } = await import('../../src/protocol-source.mjs');
  const { loadConfig } = await import('../../src/config.mjs');
  const { defaultSettings } = await import('../../src/automation-settings.mjs');
  const { createUsageLedger } = await import('../../src/usage-ledger.mjs');
  const protocol = loadProtocol(BUNDLED_PROTOCOL), config = loadConfig({ file: process.env.CW_CONFIG_PACK });
  let serial = 0, app, root, originalConnect, GameClient;
  const fixtures = new Map();
  const fixture = (name = String(++serial), state) => {
    const value = createHomelandClient(protocol, ++serial, state);
    const settings = defaultSettings(); settings.loop.world = true;
    const ledger = createUsageLedger(name, { now: () => Date.now() + value.client.serverClockOffsetMs });
    const result = { ...value, settings, ledger, ledgerId: name, enabled: true, protocol, config };
    result.options = { player: result.player, ledger, getSettings: () => result.settings, enabled: () => result.enabled && result.client.connected };
    fixtures.set(name, result); return result;
  };
  const api = async (route, body, account = 'a') => {
    const response = await fetch(root + '/api/' + route + (account === null ? '' : '?account=' + account), {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, data: await response.json() };
  };
  if (http) {
    const { saveStore } = await import('../../src/accounts.mjs');
    ({ GameClient } = await import('../../src/client.mjs'));
    originalConnect = GameClient.prototype.connect;
    GameClient.prototype.connect = async () => { throw Error('离线验收禁止连接游戏'); };
    saveStore({ version: 1, activeId: 'a', accounts: ['a', 'b', 'offline'].map(id => ({ id, label: '家园验收 ' + id, login: {}, url: 'wss://fixture.invalid', automation: { enabled: false, autoStart: false } })) });
    const { createConsole } = await import('../../src/server.mjs');
    app = createConsole({ port: 0, protocol, resourceUpdates: false }); root = await app.listen();
    for (const id of ['a', 'b']) {
      await api('settings', undefined, id);
      const f = fixture(id); Object.assign(app.sessions.get(id), { client: f.client, player: f.player, paused: false, preferences: f.settings });
    }
  }
  return { fixture, fixtures, config, protocol, app, root, api, directory, async close() {
    try { if (app) { app.server.closeAllConnections(); await app.close(); } }
    finally { if (originalConnect) GameClient.prototype.connect = originalConnect;
      assert.equal(path.dirname(fs.realpathSync(directory)), temporary);
      assert(path.basename(directory).startsWith('cw-homeland-'));
      fs.rmSync(directory, { recursive: true, force: true }); }
  } };
}
