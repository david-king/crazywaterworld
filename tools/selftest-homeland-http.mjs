import assert from 'node:assert/strict';
import { createHomelandHarness } from './fixtures/homeland-console.mjs';

const h = await createHomelandHarness({ http: true });
const a = h.fixtures.get('a'), b = h.fixtures.get('b');
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; };
const read = async (account = 'a') => ok(await h.api('homeland', undefined, account));
const body = action => ({ id: action.id, token: action.token, confirm: true });
const denied = response => assert(response.status >= 400 || ['rejected', 'cancelled'].includes(response.data.status), JSON.stringify(response));
try {
  denied(await h.api('homeland', undefined, null));
  denied(await h.api('homeland', undefined, 'offline'));
  const view = await read(); assert.equal(a.state.writes.length, 0);
  const tech = view.actions.find(row => row.kind === 'tech');
  denied(await h.api('homeland/action', body(tech), null));
  denied(await h.api('homeland/action', body(tech), 'offline'));
  denied(await h.api('homeland/action', body(tech), 'b')); // Account-bound preview.
  denied(await h.api('homeland/action', { ...body(tech), confirm: false }));
  const results = await Promise.all([h.api('homeland/action', body(tech)), h.api('homeland/action', body(tech))]);
  assert.equal(results.filter(row => row.data.status === 'confirmed').length, 1);
  assert.equal(a.state.writes.length, 1); assert.equal(b.state.writes.length, 0);
  assert.equal((await read()).techLevel, 1);
  console.log('通过：只读、明确账号、离线拒绝、确认、跨账号隔离、并发双击只写一次');

  const current = ok(await h.api('settings'));
  Object.assign(current.settings.homeland, { enabled: true, tech: true, targetTech: 2 }); current.settings.loop.world = true;
  ok(await h.api('settings', { settings: current.settings, revision: current.revision, baseRevision: current.baseRevision }));
  const preview = ok(await h.api('settings/preview', { category: 'homeland', settings: current.settings }));
  assert(preview.actions.some(row => /科技 2/.test(row.label))); assert.equal(a.state.writes.length, 1);
  const action = (await read()).actions.find(row => row.kind === 'tech');
  h.app.sessions.get('a').paused = true;
  denied(await h.api('homeland/action', body(action))); assert.equal(a.state.writes.length, 1);
  h.app.sessions.get('a').paused = false;
  // JSON fields must not replace trusted runtime identity, preferences or ledger.
  assert.equal(ok(await h.api('homeland/action', { ...body(action), player: b.player, automatic: false, settings: { homeland: { dailyCoinLimit: 999999 } } })).status, 'confirmed');
  assert.equal(a.state.home.techLevel, 2); assert.equal(b.state.home.techLevel, 0);
  console.log('通过：配置保存、专属只读预览、暂停阻断、请求字段不能覆盖运行上下文');

  a.state.cells = [0, 1].map(cellId => ({ cellId, state: 2, piece: { uid: 500 + cellId, pieceCfgId: '鱼1' } }));
  a.state.warehouse = [];
  a.state.orders = [{ slot: 0, orderId: 12, kind: 2, orderType: 0, expireTs: 0, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }];
  const draft = (await h.api('settings')).data.settings;
  draft.homeland.submitOrders = true;
  let mergePreview = ok(await h.api('settings/preview', { category: 'homeland', settings: draft }));
  assert(!mergePreview.actions.some(row => /×2 →/.test(row.label)));
  draft.homeland.mergeOrders = true;
  mergePreview = ok(await h.api('settings/preview', { category: 'homeland', settings: draft }));
  assert(mergePreview.actions.some(row => /鱼 ×2 → 生鱼片/.test(row.label)));
  assert(mergePreview.notes.some(row => /备料最少 1 步/.test(row)));
  const writesBefore = a.state.writes.length;
  a.state.orders.push({ ...structuredClone(a.state.orders[0]), slot: 1, orderId: 13 });
  const mergeActions = (await read()).actions.filter(row => row.kind === 'mergeOrders');
  assert.equal(mergeActions.length, 2);
  assert.notEqual(mergeActions[0].id, mergeActions[1].id, '相同配方在不同订单有独立按钮身份');
  const merge = mergeActions.find(row => row.orderSlot === 1);
  assert(merge);
  assert.equal(a.state.writes.length, writesBefore, '读取与草稿预览只读');
  denied(await h.api('homeland/action', body(merge), 'b'));
  const merged = await Promise.all([h.api('homeland/action', body(merge)), h.api('homeland/action', body(merge))]);
  assert.equal(merged.filter(row => row.data.status === 'confirmed').length, 1);
  assert.equal(a.state.writes.length, writesBefore + 1);
  assert((await read()).orders[0].ready);
  a.state.orders.pop();
  a.state.orders[0].reqs[0].pieceCfgId = '鱼4';
  const waiting = ok(await h.api('settings/preview', { category: 'homeland', settings: draft }));
  assert(waiting.notes.some(note => /现有棋子无法补齐订单/.test(note)));
  console.log('通过：合成草稿开关与等待原因、预览只读、跨账号拒绝、合成并发防重及交单状态刷新');

  a.state.cells = ['鱼4', '鱼1'].map((pieceCfgId, cellId) => ({ cellId, state: 2, piece: { uid: 600 + cellId, pieceCfgId } }));
  a.state.warehouse = [{ uid: 602, pieceCfgId: '鱼1' }];
  a.state.orders = [{ slot: 0, orderId: 14, kind: 2, orderType: 0, expireTs: 0, reqs: [{ pieceCfgId: '鱼2', count: 1 }] }];
  const prefs = ok(await h.api('settings')); Object.assign(prefs.settings.homeland, { submitOrders: true, mergeOrders: true, takeWarehouse: true, warehouseBuffer: true });
  const beforeBuffer = a.state.writes.length;
  const transitPreview = ok(await h.api('settings/preview', { category: 'homeland', settings: prefs.settings }));
  assert(transitPreview.actions.some(row => /暂存鱼丸到仓库/.test(row.label)));
  ok(await h.api('settings', { settings: prefs.settings, revision: prefs.revision, baseRevision: prefs.baseRevision }));
  const transit = (await read()).actions.find(row => row.kind === 'warehouseBuffer'); assert(transit);
  const optimal = (await read()).orders[0].synthesis;
  assert.equal(optimal.status, 'optimal'); assert.equal(optimal.steps, 3); assert.equal(optimal.lowerBound, 3);
  assert.equal(a.state.writes.length, beforeBuffer);
  denied(await h.api('homeland/action', body(transit), 'b'));
  const transfers = await Promise.all([h.api('homeland/action', body(transit)), h.api('homeland/action', body(transit))]);
  assert.equal(transfers.filter(row => row.data.status === 'confirmed').length, 1);
  assert.equal(a.state.writes.length, beforeBuffer + 1);
  assert.equal((await read()).warehouse.used, 2);
  console.log('通过：仓库中转草稿预览只读、开关保存、账号隔离与并发存入只执行一次');
} finally { await h.close(); }
