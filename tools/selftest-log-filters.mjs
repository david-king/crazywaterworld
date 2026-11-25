// 真实 HTTP/SSE 验证跨账号日志、清空水位和重连；只用隔离账号，禁止连接游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatConsoleLog } from '../src/console-log.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-log-filters-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { saveStore } = await import('../src/accounts.mjs');
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('../src/server.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('日志验收禁止连接游戏'); };
saveStore({ version: 1, activeId: 'logs-a', accounts: ['logs-a', 'logs-b'].map(id => ({
  id, label: '日志测试', url: 'wss://fixture.invalid', login: {},
  automation: { enabled: false, autoStart: false, paused: id === 'logs-a' },
})) });
const terminal = [];
const app = createConsole({ port: 0, protocol: {}, onLog: entry => terminal.push(formatConsoleLog(entry)) });
const streams = new Set();
let base;
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, '等待超时：' + label);
    await sleep(10);
  }
}
function subscribe(query = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const stream = { events: [], response: null, request: null };
    streams.add(stream);
    stream.request = http.get(base + '/api/events' + query, { headers }, response => {
      stream.response = response;
      assert.equal(response.statusCode, 200);
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, end).split('\n'); buffer = buffer.slice(end + 2);
          const data = lines.find(line => line.startsWith('data: '));
          if (data) stream.events.push({ type: lines.find(line => line.startsWith('event: '))?.slice(7) || 'log', data: JSON.parse(data.slice(6)) });
        }
      });
      resolve(stream);
    });
    stream.request.on('error', reject);
  });
}
const messages = stream => stream.events.filter(event => event.type === 'log').map(event => event.data.message);
const clear = async query => {
  const response = await fetch(base + '/api/logs/clear?' + query, { method: 'POST', body: JSON.stringify({ confirm: true }) });
  assert.equal(response.status, 200); return response.json();
};

try {
  for (const id of ['logs-a', 'logs-b']) {
    fs.writeFileSync(path.join(directory, 'factory-report-' + id + '.json'), JSON.stringify({
      time: '2026/11/23 18:33:27', lines: ['工厂历史记录'],
    }));
  }
  base = await app.listen();
  await fetch(base + '/api/accounts');
  const a = app.sessions.get('logs-a'), b = app.sessions.get('logs-b');
  app.emit(a, 'info', '甲账号旧记录'); app.emit(b, 'warn', '乙账号旧记录');
  app.emit(null, 'info', '共享系统旧记录');
  const all = await subscribe('?scope=all'), scoped = await subscribe('?account=logs-a'), system = await subscribe();
  await waitFor(() => messages(all).includes('乙账号旧记录') && messages(scoped).includes('甲账号旧记录') && messages(system).includes('共享系统旧记录'), '历史回放');
  assert(!messages(scoped).some(message => message.includes('上次工厂检查')), '暂停托管账号首次加载时不应将旧工厂报告作为新日志回放');
  assert(!messages(all).some(message => message.includes('上次工厂检查')), '账号未暂停但未开启挂机时，首次加载也不应回放旧工厂报告');
  assert(!messages(scoped).includes('乙账号旧记录'));
  assert(!messages(system).includes('甲账号旧记录'));
  assert(all.events.some(event => event.data.account === 'logs-b' && event.data.level === 'warn'));
  assert(all.events.some(event => event.data.accountName === '日志测试（1）'));
  assert(all.events.some(event => event.data.accountName === '日志测试（2）'));
  assert(terminal.some(line => line.includes('[日志测试（2）] [系统与连接] [警告] 乙账号旧记录')));
  console.log('通过：全账号、单账号和系统订阅保持各自范围，历史回放包含账号标识');

  const live = app.emit(b, 'error', '乙账号实时日志 token=private-value');
  app.emit(null, 'info', '实时发送完毕');
  await waitFor(() => [all, scoped, system].every(stream => messages(stream).includes('实时发送完毕')), '实时日志');
  assert(messages(all).some(message => message.includes('乙账号实时日志')));
  assert(!messages(scoped).some(message => message.includes('乙账号实时日志')));
  assert(!messages(system).some(message => message.includes('乙账号实时日志')));
  assert.doesNotMatch(JSON.stringify(all.events), /private-value/);
  assert.equal(live.account, 'logs-b');
  assert.equal(live.accountName, '日志测试（2）');
  console.log('通过：其他账号实时日志到达全账号订阅，敏感字段仍脱敏');

  const renamed = await fetch(base + '/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id: 'logs-a', label: '新船长名称' }) });
  assert.equal(renamed.status, 200);
  assert.equal(app.emit(a, 'info', '备注修改后的日志').accountName, '新船长名称');
  assert.equal(app.emit(b, 'info', '同名消除后的日志').accountName, '日志测试');
  const readFileSync = fs.readFileSync;
  try {
    fs.readFileSync = () => { throw new Error('日志输出不应重新读取账号文件'); };
    assert.equal(app.emit(a, 'info', '复用公开名称缓存').accountName, '新船长名称');
  } finally { fs.readFileSync = readFileSync; }
  console.log('通过：账号备注立即更新到业务日志，日志热路径不读取账号凭据文件');

  const cleared = await clear('account=logs-a');
  assert.equal(cleared.account, 'logs-a');
  await waitFor(() => [all, scoped].every(stream => stream.events.some(event => event.type === 'logs-cleared')), '清空通知');
  assert(!system.events.some(event => event.type === 'logs-cleared'));
  assert.equal(a.log.length, 0);
  assert(b.log.some(entry => entry.message === '乙账号旧记录'));
  const after = app.emit(a, 'info', '甲账号清空后新记录');
  const replay = await subscribe('?scope=all');
  await waitFor(() => messages(replay).includes(after.message), '清空后回放');
  assert(!messages(replay).includes('甲账号旧记录'));
  assert(messages(replay).includes('乙账号旧记录'));
  assert(messages(replay).includes('共享系统旧记录'));
  assert.deepEqual(replay.events[0], { type: 'logs-cleared', data: cleared });
  console.log('通过：清空按账号广播，全账号回放保留其他账号与系统记录');

  await clear('account=logs-b');
  const next = app.emit(b, 'info', '乙账号清空后新记录');
  const reconnect = await subscribe('?scope=all', { 'Last-Event-ID': String(after.id) });
  await waitFor(() => messages(reconnect).includes(next.message), '重连回放');
  assert.deepEqual(reconnect.events.slice(0, 2).map(event => event.data.account), ['logs-a', 'logs-b']);
  assert.deepEqual(messages(reconnect), ['乙账号清空后新记录']);
  const ids = all.events.filter(event => event.type === 'log').map(event => event.data.id);
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
  console.log('通过：重连先同步每个账号的清空水位，再按全局编号回放新增日志');

  const clearedAll = await clear('scope=all');
  assert.equal(clearedAll.scope, 'all');
  assert.equal(a.log.length, 0);
  assert.equal(b.log.length, 0);
  for (const stream of [all, scoped, system]) {
    await waitFor(() => stream.events.some(event => event.type === 'logs-cleared' && event.data.scope === 'all'), '全量清空通知');
  }
  const newSystem = app.emit(null, 'info', '全量清空后的系统记录');
  const newB = app.emit(b, 'info', '全量清空后的乙账号记录');
  const clearedA = await clear('account=logs-a');
  const replayAll = await subscribe('?scope=all', { 'Last-Event-ID': String(next.id) });
  await waitFor(() => messages(replayAll).includes(newB.message), '全量清空后断线重连');
  assert.deepEqual(replayAll.events, [
    { type: 'logs-cleared', data: clearedAll }, { type: 'logs-cleared', data: clearedA },
    { type: 'log', data: newSystem }, { type: 'log', data: newB },
  ]);
  const replaySystem = await subscribe();
  await waitFor(() => messages(replaySystem).includes(newSystem.message), '全量清空后回放系统记录');
  assert.deepEqual(replaySystem.events, [{ type: 'logs-cleared', data: clearedAll }, { type: 'log', data: newSystem }]);
  console.log('通过：全量清空同步到所有订阅，重连保留清空后的系统与账号日志');

  const baseline = terminal.length;
  const compact = await subscribe('?account=logs-a&compact=1');
  const wait = { waitScope: 'test-building', waitKey: 'level-28', category: 'building', diagnostic: '逐栋检查详情' };
  const firstWait = app.emit(a, 'info', '等待角色 28 级', wait);
  for (let index = 0; index < 410; index++) app.emit(a, 'info', '等待角色 28 级', wait);
  assert.equal(terminal.length, baseline + 1);
  const repeated = a.log.filter(row => row.rowId === firstWait.id);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].count, 411);
  await waitFor(() => compact.events.some(event => event.data.count === 411), '增量次数更新');
  const revisions = compact.events.filter(event => event.data.rowId === firstWait.id);
  assert.equal(revisions[0].data.detail, '逐栋检查详情');
  assert(revisions.slice(1).every(event => event.data.reuseDetail && !event.data.detail));
  const latest = await subscribe('?account=logs-a', { 'Last-Event-ID': String(firstWait.id) });
  await waitFor(() => messages(latest).includes('等待角色 28 级'), '去重后重连');
  assert.deepEqual(latest.events.filter(event => event.type === 'log').map(event => event.data.count), [411]);
  assert.equal(latest.events.at(-1).data.detail, '逐栋检查详情');
  app.emit(a, 'info', '工厂已开工', { waitScope: wait.waitScope });
  const again = app.emit(a, 'info', '等待角色 28 级', wait);
  assert.notEqual(again.rowId, firstWait.rowId);
  assert.equal(again.count, 1);

  const check = key => app.emit(a, 'info', '等待建材', { taskKey: key, waitKey: 'materials' });
  const upgrade = check('upgrade'), finish = check('finishUpgrade'), retry = check('upgrade');
  assert.equal(upgrade.category, finish.category);
  assert.notEqual(upgrade.feature.key, finish.feature.key);
  assert.notEqual(upgrade.rowId, finish.rowId);
  assert.equal(retry.rowId, upgrade.rowId);
  assert.equal(retry.count, 2);

  const batch = key => app.emit(a, 'info', '木板生产记录', { taskKey: key, batch: 'boards', factory: '木材厂', product: '木板' });
  const planned = batch('startProduce'), accelerated = batch('adSpeedUpProduce');
  assert.equal(planned.category, accelerated.category);
  assert.notEqual(planned.rowId, accelerated.rowId);
  assert.equal(batch('adSpeedUpProduce').count, 2);
  console.log('通过：同分类下的不同功能分别累计等待和批次记录');

  const shopTask = { taskKey: 'shop' };
  const emptyList = app.emit(a, 'info', '检查时该账号的购买清单为 0 项', shopTask);
  const paidRefresh = app.emit(b, 'info', '该账号购买清单 3 项，挂机只使用免费刷新', shopTask);
  assert.equal(emptyList.category, 'daily');
  assert.equal(paidRefresh.category, 'daily');
  assert.deepEqual([emptyList.account, paidRefresh.account], ['logs-a', 'logs-b']);

  for (let index = 0; index < 450; index++) app.emit(index % 2 ? a : b, 'info', '容量测试' + index);
  const bounded = await subscribe('?scope=all');
  await waitFor(() => messages(bounded).includes('容量测试449'), '容量回放');
  assert.equal(messages(bounded).length, 400);
  assert.equal(messages(bounded)[0], '容量测试50');
  assert.equal(connections, 0);
  console.log('通过：全账号历史合并保留最近400条，整个验证未连接游戏');
} finally {
  for (const stream of streams) { stream.request?.destroy(); stream.response?.destroy(); }
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
