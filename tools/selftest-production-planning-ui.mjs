import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../src/production-planning-ui.js', import.meta.url), 'utf8');
let passed = 0;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture() {
  const nodes = new Map();
  const env = { calls: [], errors: [], tables: [], current: 'account-a', snapshot: { connected: true, paused: false }, disconnected: new Set() };
  function element(tag = 'div', className = '', value = '') {
    let text = String(value ?? '');
    return {
      tagName: tag, className, disabled: false, children: [], attributes: {},
      style: { setProperty(name, value) { this[name] = value; } },
      querySelector(selector) { return descendants(this).find(node => '.' + node.className === selector); },
      get firstElementChild() { return this.children[0]; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { text = String(value ?? ''); this.children = []; },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    };
  }
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  env.element = element;
  env.clear = node => { node.textContent = ''; return node; };
  env.table = (headers, rows) => {
    env.tables.push({ headers, rows });
    return element('table', '', [headers, ...rows].flat().map(cell => cell.textContent ?? cell).join(' '));
  };
  env.respond = async () => ({ statusLabel: '固定快照模型内最优', snapshotTime: 1767225600,
    completionAt: 1767225661, upperBound: 61, lowerBound: 60, scope: 'all-orders',
    orders: [{ id: 'resident:1', label: '居民订单', requirements: [{ id: 'bread', name: '面包', num: 2 }], completionAt: 1767225661, statusLabel: '联合方案已齐套' }],
    timeline: [{ machineId: 'factory:1', machineName: '食品厂', itemId: 'bread', productName: '面包', quantity: 2,
      startAt: 1767225600, finishAt: 1767225661, timingLabel: '会话实测' }],
    notes: ['共同材料只分配一次'], missingReads: [], assumptions: ['共同材料只分配一次'],
  });
  env.call = async route => { env.calls.push(route); return env.respond(route); };
  newStateFunction('env', `
    'use strict';
    const $ = env.node, el = env.element, clear = env.clear, table = env.table;
    const chip = (state, label) => el('span', state, label);
    const call = env.call, reportError = error => env.errors.push(error), disconnected = env.disconnected;
    const openConfirm = (title, nodes, onOk) => {
      clear($('m-body'));
      nodes.forEach(node => $('m-body').appendChild(node));
      $('m-ok').onclick = onOk;
      $('m-ok').disabled = false;
      $('modal').open = true;
    };
    let current = env.current, snapshot = env.snapshot;
    ${script}
    env.reset = resetProductionPlan;
    env.enter = refreshProductionPlan;
    env.time = productionPlanTime;
    env.duration = productionPlanDuration;
    env.render = renderProductionPlan;
    env.changeAccount = account => {
      current = account;
      resetProductionPlan();
      $('production-plan-refresh').disabled = !snapshot.connected || snapshot.paused || disconnected.has(current);
    };
    env.setCurrent = account => { current = account; };
  `)(env);
  env.click = () => env.node('production-plan-refresh').disabled ? undefined : env.node('production-plan-refresh').onclick();
  return env;
}

async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}

await test('按钮触发真实读取脚本，展示北京时间、逐单完成与生产顺序', async () => {
  const env = fixture();
  await env.click();
  assert.deepEqual(env.calls, ['/api/world/production-plan']);
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.match(env.node('production-plan-status').textContent, /数据更新于 .*北京时间/);
  const text = env.node('production-plan-result').textContent;
  assert.match(text, /全部需求预计/);
  assert.match(text, /01\/01.*08:01:01/);
  assert.match(text, /约需 1分1秒/);
  assert.match(text, /面包 ×2/);
  assert.doesNotMatch(text, /模型内最优|会话实测|工期下界|共同材料只分配一次/);
  assert.equal(env.tables.length, 2);
  assert.equal(env.errors.length, 0);
});

await test('断开、暂停、无账号和主动断开状态均不发送读取', async () => {
  for (const mode of ['disconnected', 'paused', 'no-account', 'explicit-disconnect']) {
    const env = fixture();
    if (mode === 'disconnected') env.snapshot.connected = false;
    if (mode === 'paused') env.snapshot.paused = true;
    if (mode === 'no-account') env.setCurrent(null);
    if (mode === 'explicit-disconnect') env.disconnected.add('account-a');
    await env.click();
    assert.deepEqual(env.calls, []);
  }
});

await test('等待期间按钮禁用，失败后恢复点击并显示错误状态', async () => {
  const env = fixture(), pending = deferred();
  env.respond = () => pending.promise;
  const running = env.click();
  assert.equal(env.node('production-plan-refresh').disabled, true);
  assert.match(env.node('production-plan-status').textContent, /正在生成计划/);
  env.click();
  assert.equal(env.calls.length, 1);
  const error = new Error('测试读取失败');
  pending.reject(error);
  await running;
  assert.equal(env.node('production-plan-refresh').disabled, false);
  assert.equal(env.node('production-plan-status').textContent, '生成失败，请重试');
  assert.deepEqual(env.errors, [error]);
});

await test('无需求、读取不全和条件不足时给出对应提示', () => {
  const env = fixture();
  const result = env.node('production-plan-result');
  env.render({ status: 'optimal', orders: [], completionAt: 1767225600, upperBound: 0 });
  assert.equal(result.textContent, '当前没有需要备料的需求。');
  env.render({ status: 'incomplete', missingReads: ['AllItemRequest'], orders: [] });
  assert.match(result.textContent, /生产数据还不完整/);
  assert.doesNotMatch(result.textContent, /AllItemRequest|没有需要/);
  env.render({ status: 'incomplete', missingReads: ['订单或候选配方材料存在待确认扣款 · 喂养培育队列 1',
    'OnWaterRequest · 生产队列未完整返回'], orders: [] });
  assert.match(result.textContent, /待确认扣款 · 喂养培育队列 1/);
  assert.match(result.textContent, /生产队列未完整返回/);
  env.render({ status: 'infeasible' });
  assert.match(result.textContent, /无法备齐所有需求/);
  env.render({});
  assert.match(result.textContent, /暂时无法预计/);
  assert.equal(env.time(null), '时间待定');
  assert.equal(env.duration(3661), '1小时1分1秒');
});

await test('进页立即展示加载状态，切号时新账号清单不受旧请求影响', async () => {
  const env = fixture(), first = deferred(), second = deferred();
  const card = env.node('production-day-card'), body = env.node('production-day-result');
  card.hidden = true;
  env.snapshot.syncingProduction = true;
  await env.enter();
  assert.equal(card.hidden,false);
  assert.match(body.textContent,/同步后自动显示/);
  assert.deepEqual(env.calls,[]);
  env.snapshot.syncingProduction = false;
  env.respond = () => first.promise;
  const older = env.enter();
  await env.enter();
  assert.equal(env.calls.length,1);
  assert.equal(body.attributes['aria-busy'],'true');
  assert.match(body.textContent,/正在读取/);
  env.setCurrent('account-b');
  env.respond = () => second.promise;
  const newer = env.enter();
  assert.equal(env.calls.length,2);
  const reply = name => ({forecast:{startAt:1000,endAt:87400,completions:[],factories:[{id:name,name,runs:[]}]}});
  second.resolve(reply('乙工厂'));
  await newer;
  first.resolve(reply('甲工厂'));
  await older;
  assert.equal(env.node('production-day-factory').value,'乙工厂');
  assert.equal(body.attributes['aria-busy'],'false');
});

await test('各需求保留状态与备齐时间，跳过的需求不计入完成时间', () => {
  const env = fixture();
  const now = 1767225600;
  const skipped = { label: '不差钱商人', skipped: true, reason: '工厂等级不足或已停用（电路板）',
    requirements: [{ id: '电路板', num: 1 }] };
  env.render({ scope: 'feasible-demands', snapshotTime: now, completionAt: now + 60, upperBound: 60,
    priorityBounds: [{ label: '第1级' }], orders: [
      skipped, { label: '建筑备料', completionAt: now }, { label: '居民订单', completionAt: now + 60 },
    ] });
  assert.match(env.node('production-plan-result').textContent, /参与排产的需求预计/);
  assert.deepEqual(env.tables[0].headers, ['需求来源', '所需物品', '预计备齐']);
  assert.deepEqual(env.tables[0].rows.map(row => row.map(cell => cell.textContent)), [
    ['不差钱商人', '电路板 ×1工厂等级不足或已停用（电路板）', '已跳过'],
    ['建筑备料', '', '现在可备齐'], ['居民订单', '', env.time(now + 60)],
  ]);
  env.render({ orders: [skipped] });
  assert.match(env.node('production-plan-result').textContent, /本次需求均已跳过/);
});

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

await test('插单立即弹窗，读取期间可关闭，旧请求不会覆盖新弹窗', async () => {
  const env = fixture(), first = deferred(), second = deferred();
  const startAt = 1767225600, factory = {id:'a', name:'食品厂', runs:[]};
  env.render({forecast:{startAt, endAt:startAt+86400, completions:[], insertKey:'plan', factories:[factory]}});
  const panel = env.node('production-day-result').querySelector('.plan-day-panel');
  panel.isConnected = true;
  const insert = panel.querySelector('.production-batch-insert');
  const dialog = env.node('modal'), body = env.node('m-body'), ok = env.node('m-ok');
  env.respond = () => first.promise;
  const older = insert.onclick();
  assert(dialog.open && ok.disabled);
  assert.match(body.textContent, /正在核对库存/);
  dialog.open = false;
  env.respond = () => second.promise;
  const newer = insert.onclick();
  second.resolve({products:[{id:'面包',name:'面包',max:2},{id:'淡水',name:'淡水',max:null}], count:1});
  await newer;
  assert(!ok.disabled);
  assert.match(body.textContent, /面包.*最多 2 件/);
  const qty = descendants(body).find(node => node.tagName === 'input');
  const select = descendants(body).find(node => node.tagName === 'select');
  qty.value = '100';
  qty.oninput();
  assert(ok.disabled);
  select.value = '淡水';
  select.onchange();
  assert(!ok.disabled);
  assert.equal(qty.max,'');
  assert.match(body.textContent,/淡水（无需原料）/);
  first.reject(new Error('已关闭弹窗的请求失败'));
  await older;
  assert(!ok.disabled);
  assert.doesNotMatch(body.textContent, /失败|正在核对库存/);
  env.respond = async () => { throw new Error('库存未同步'); };
  await insert.onclick();
  assert.match(body.textContent, /库存未同步/);
  assert(ok.disabled);
  assert.deepEqual(env.calls, Array(3).fill('/api/world/production-insert-options'));
});

await test('满仓插单后刷新可见剩余 340 件，撤回后清除记录', async () => {
  const env = fixture();
  const factory = { id:'a', name:'水厂', runs:[] };
  const plan = { forecast: { startAt:1000, endAt:87400, insertKey:'plan', completions:[],
    factories:[factory] } };
  env.render(plan);
  for (const warning of [undefined, '工厂队列已变化，插单已撤回']) {
    env.respond = async route => {
      if (route.endsWith('-options')) return { products:[{ id:'淡水', name:'淡水', max:null }], count:1 };
      if (route.endsWith('-insert')) {
        factory.pendingInsertions = warning ? [] : [{id:'淡水',name:'淡水',quantity:340}];
        factory.insertNote = warning ? undefined : '淡水已满仓，消耗后优先补产';
        return { label:warning || '已插入淡水 ×340', warning };
      }
      return plan;
    };
    const panel = env.node('production-day-result').querySelector('.plan-day-panel');
    panel.isConnected = true;
    await panel.querySelector('.production-batch-insert').onclick();
    descendants(env.node('m-body')).find(node => node.tagName === 'input').value = '340';
    await env.node('m-ok').onclick();
    const day = env.node('production-day-result');
    if (warning) {
      assert.doesNotMatch(day.textContent, /待入队插单|淡水/);
    } else {
      assert.match(day.textContent, /待入队插单.*淡水 ×340.*淡水已满仓/);
      assert.match(day.querySelector('.plan-day-totals').textContent, /运行 0秒.*空闲 24小时/);
    }
    assert.equal(env.node('hint').textContent, '');
    assert.deepEqual(env.calls.slice(-2), ['/api/world/production-insert', '/api/world/production-plan']);
  }
});

await test('独立卡片只显示一家工厂，切换与刷新保留选中项，换账号清除', () => {
  const env = fixture(), startAt = Date.UTC(2026, 10, 23, 15, 59) / 1000;
  const one = { id:'a', name:'金属厂-1', runs:[
    {name:'铜锭', from:startAt, to:startAt+2, status:'running', quantity:1, lane:1},
    {name:'电线', from:startAt+120, to:startAt+180, status:'planned', quantity:1, lane:1},
  ] };
  const two = { id:'b', name:'食品厂-1', unknown:'游戏原生接管', runs:[] };
  const forecast = {startAt, endAt:startAt+86400, strategy:'nativeSimulation', factories:[one,two], completions:[]};
  const main = env.node('production-plan-result'), card = env.node('production-day-card'), box = env.node('production-day-result');
  const picker = env.node('production-day-factory'), action = env.node('production-day-picker');
  env.render({orders:[{label:'居民订单'}], forecast});
  assert.equal(card.hidden, false);
  assert.equal(action.hidden, false);
  assert.deepEqual(picker.children.map(n => [n.value, n.textContent]), [['a', '金属厂-1'], ['b', '食品厂-1']]);
  assert.equal(picker.value, 'a');
  assert.match(main.textContent, /居民订单/);
  assert.match(box.textContent, /模拟游戏原生 · 北京时间 23:59 起.*预计备齐 0 \/ 1/);
  assert.match(box.querySelector('.plan-day-totals').textContent, /运行 1分.*空闲 23小时58分/);
  const [copper, gap, wire] = box.querySelector('.production-batches').children;
  assert.match(copper.textContent, /铜锭×1.*23:59:00 – 23:59:02.*2秒.*生产中/);
  assert.match(gap.textContent, /空闲.*23:59 – 次日 00:01/);
  assert.match(wire.textContent, /电线×1.*次日 00:01 – 次日 00:02.*计划排队中/);
  assert.equal(box.querySelector('.plan-day-track'), undefined);
  picker.selectedIndex = 1;
  picker.onchange();
  assert.match(box.textContent, /待定 24小时.*游戏原生接管/);
  assert.doesNotMatch(box.textContent, /铜锭|空闲/);
  picker.selectedIndex = 0;
  picker.onchange();
  env.render({forecast:{...forecast, factories:[two,one]}});
  assert.equal(picker.value, 'a');
  assert.equal(picker.children.length, 2);
  assert.deepEqual(env.calls, []);
  env.changeAccount('account-b');
  assert.equal(card.hidden, true);
  assert.equal(action.hidden, true);
  assert.equal(picker.children.length, 0);
  assert.equal(box.textContent, '');
  env.render({forecast:{...forecast, factories:[two,one]}});
  assert.equal(picker.value, 'b');
  env.render({forecast:{unavailable:'库存读取失败'}});
  assert.equal(box.textContent, '库存读取失败');
  assert.equal(action.hidden, true);
  env.render({forecast:{...forecast, factories:[]}});
  assert.match(box.textContent, /没有已建工厂/);
  assert.equal(picker.onchange, null);
  env.render({});
  assert.equal(card.hidden, true);
  assert.equal(box.textContent, '');
});

await test('高级配方显示上游工厂补料件数及农田播种茬数', () => {
  const env = fixture(), startAt = 1767225600;
  const factory = {id:'food', name:'食品厂', runs:[], upstream:[
    {factory:'海水提取厂-1', name:'淡水', quantity:7}, {factory:'农田-1', name:'小麦', quantity:2, crop:true},
  ]};
  env.render({forecast:{startAt,endAt:startAt+86400,completions:[],factories:[factory]}});
  assert.match(env.node('production-day-result').textContent, /上游补料插单.*海水提取厂-1 · 淡水 ×7.*农田-1 · 小麦 ×2 茬/);
});

await test('并行的一秒产物完整列出，长任务只列一次，翻页覆盖全部批次', () => {
  const env = fixture(), startAt = 1767225600;
  const runs = Array.from({length:25}, (_, i) => ({
    name:'任务' + i, from:startAt+i, to:startAt+i+1, quantity:1, lane:2, status:['running','queued'][i] ?? 'planned'
  }));
  runs.unshift({name:'长任务', from:startAt, to:startAt+86400, quantity:1, lane:1, status:'running', continues:true});
  env.render({forecast:{startAt,endAt:startAt+86400,completions:[],factories:[{id:'a',name:'材料厂',runs}]}});
  const box = env.node('production-day-result'), list = box.querySelector('.production-batches');
  assert.equal(list.children.length, 24);
  assert.match(list.children[0].textContent, /长任务×1.*24小时以上.*生产中/);
  assert.match(list.children[1].textContent, /任务0×1.*08:00:00 – 08:00:01.*1秒生产中/);
  assert.match(list.children[2].textContent, /1秒游戏内排队中/);
  assert.match(list.children[3].textContent, /1秒计划排队中/);
  assert.equal(list.children.filter(r => r.textContent.includes('长任务')).length, 1);
  assert.match(box.querySelector('.plan-day-totals').textContent, /运行 24小时.*空闲 0秒/);
  box.querySelector('.production-batches-nav').children.at(-1).onclick();
  assert.equal(list.children.length, 2);
  assert.match(list.children[1].textContent, /任务24×1.*1秒/);
});

await test('两个生产位错峰时每批独立，空闲只计共同空档', () => {
  const env = fixture(), startAt = 1767225600;
  const runs = [[1,3600,10800],[2,7200,14400]].map(([lane,from,to]) => ({
    lane, from:startAt+from, to:startAt+to, name:'铜锭', quantity:1, status:'queued'
  }));
  env.render({forecast:{startAt,endAt:startAt+86400,completions:[],factories:[{id:'a',name:'金属厂',runs}]}});
  const box = env.node('production-day-result');
  assert.deepEqual(box.querySelector('.production-batches').children.map(r => r.className), [
    'production-batch gap','production-batch queued','production-batch queued','production-batch gap'
  ]);
  assert.match(box.querySelector('.plan-day-totals').textContent, /运行 3小时.*空闲 21小时/);
});

await test('旧版合并批次保留游戏内状态待确认', () => {
  const env = fixture(), startAt = 1767225600;
  const runs = [{name:'铜锭', from:startAt, to:startAt+3600, quantity:3, lane:1, existing:true}];
  env.render({forecast:{startAt,endAt:startAt+86400,completions:[],factories:[{id:'a',name:'金属厂',runs}]}});
  const first = env.node('production-day-result').querySelector('.production-batches').children[0];
  assert.match(first.textContent, /游戏内状态待确认/);
  assert.doesNotMatch(first.textContent, /生产中|游戏内排队中/);
});

await test('部分订单等待原生工厂时显示已知备齐时间和具体缺口', () => {
  const env = fixture(), now = 1767225600;
  env.render({ snapshotTime:now, waitingSupplyCount:1, missingReads:[], orders:[
    {id:'known',label:'居民订单',completionAt:now+90}, {id:'wait',label:'贸易港',waitingForSupply:true,
      statusLabel:'等待原生工厂',reason:'等待金属厂-1确认后续产出（铜锭还差 2 件）'},
  ] });
  const box = env.node('production-plan-result');
  assert.match(box.children[0].textContent, /1 笔需求已有备齐时间，1 笔需求等待原生来料/);
  assert.doesNotMatch(box.textContent, /生产数据还不完整/);
  assert.equal(env.tables[0].rows[0][2].textContent, env.time(now+90));
  assert.equal(env.tables[0].rows[1][2].textContent, '等待原生工厂');
  assert.match(box.textContent, /铜锭还差 2 件/);
});

await test('展开材料树按每批产量逐级换算，共用材料和循环配方可安全查看', () => {
  const env = fixture();
  env.render({ orders: [{ label: '贸易港', requirements: [{ id: '面包', num: 3 }, { id: '小麦', num: 1 }] }],
    recipes: [
      { productId: '面包', output: 1, inputs: [{ id: '小麦', num: 2 }] },
      { productId: '小麦', output: 5, inputs: [{ id: '种子', num: 1 }] },
      { productId: '种子', output: 1, inputs: [{ id: '小麦', num: 1 }] },
    ] });
  function expand(row) {
    const details = row.children[0];
    assert.equal(details.tagName, 'details');
    details.open = true;
    details.ontoggle();
    details.ontoggle();
    assert.equal(details.children.length, 2);
    return details.children[1].children[0];
  }
  const [source, materials] = env.tables[0].rows[0];
  assert.equal(source.tagName, 'strong');
  const [tree] = materials.children;
  const [bread, wheat] = tree.children;
  assert.ok(!bread.children[0].open);
  assert.equal(bread.children[0].name, wheat.children[0].name);
  assert.equal(bread.textContent, '面包 ×3');
  const ingredient = expand(bread);
  assert.equal(ingredient.textContent, '小麦 ×6');
  const seed = expand(ingredient);
  assert.equal(seed.textContent, '种子 ×2');
  assert.equal(expand(seed).children[0].tagName, 'span');
  assert.equal(expand(wheat).textContent, '种子 ×1');
});

await test('生产顺序和已有队列默认收起，保留原料与并行开工时间', () => {
  const env = fixture();
  const now = 1767225600;
  env.render({ timeline: [
    { kind: 'existing', machineId: '材料厂', itemId: '木板', quantity: 1 },
    { machineId: '食品厂', itemId: '面包', quantity: 1, startAt: now, finishAt: now + 20,
      inputs: [{ itemId: '小麦', quantity: 1 }] },
    { machineId: '农田', itemId: '小麦', quantity: 1, startAt: now, finishAt: now + 5, inputs: [] },
  ] });
  const details = env.node('production-plan-result').children.filter(child => child.tagName === 'details');
  assert.deepEqual(details.map(node => node.children[0].textContent), ['建议生产顺序（2 批）', '游戏内生产队列（1 批）']);
  assert.ok(details.every(node => !node.open));
  assert.deepEqual(env.tables[0].rows[0].map(cell => cell.textContent ?? cell), ['食品厂', '面包 ×1', env.time(now), env.time(now + 20)]);
  const bread = env.tables[0].rows[0][1].children[0].children[0];
  bread.open = true;
  bread.ontoggle();
  assert.equal(bread.children[1].textContent, '小麦 ×1');
  assert.equal(env.tables[0].rows[1][2], env.time(now));
  assert.equal(env.tables[1].rows[0][1].textContent, '木板 ×1');
});

await test('切换账号清理结果，旧请求成功或失败均不会覆盖新账号', async () => {
  for (const outcome of ['success', 'error']) {
    const env = fixture(), pending = deferred();
    env.respond = () => pending.promise;
    env.node('production-plan-result').textContent = '旧账号方案';
    const running = env.click();
    env.changeAccount('account-b');
    assert.equal(env.node('production-plan-result').textContent, '');
    if (outcome === 'success') pending.resolve({ statusLabel: '过期方案' });
    else pending.reject(new Error('旧账号错误'));
    await running;
    assert.equal(env.node('production-plan-result').textContent, '');
    assert.equal(env.node('production-plan-status').textContent, '');
    assert.equal(env.node('production-plan-refresh').disabled, false);
    assert.deepEqual(env.errors, []);
  }
});

await test('读取期间暂停、网络或主动断开后丢弃旧结果', async () => {
  for (const mode of ['paused', 'explicit-disconnect', 'network-disconnect']) {
    const env = fixture(), pending = deferred();
    env.respond = () => pending.promise;
    const running = env.click();
    if (mode === 'paused') env.snapshot.paused = true;
    else if (mode === 'explicit-disconnect') env.disconnected.add('account-a');
    else env.snapshot.connected = false;
    pending.resolve({ statusLabel: '旧连接方案' });
    await running;
    assert.equal(env.node('production-plan-result').textContent, '');
    assert.equal(env.node('production-plan-refresh').disabled, true);
  }
});

await test('没有订单时单列本轮补货与实际水位', () => {
  const env = fixture();
  env.render({ orders: [], stockTarget: 65, status: 'optimal', timeline: [
    { kind: 'restock', itemId: '铜锭', machineName: '金属厂', quantity: 1, startAt: 10, finishAt: 12 },
  ] });
  const content = env.node('production-plan-result').textContent;
  assert.match(content, /当前按水位备货，每种加工品目标 65 件/);
  assert.match(content, /补至库存水位 · 每种 65 件/);
  assert.doesNotMatch(content, /建议生产顺序/);
});

await test('参与排序的工厂补料按开工顺序和订单同表显示一次', () => {
  const env = fixture();
  env.render({ stockTarget: 2, timeline: [
    { kind: 'restock', priority: 0, itemId: '铜锭', machineId: '金属厂', quantity: 1, startAt: 10, finishAt: 12 },
    { kind: 'production', priority: 1, itemId: '螺母', machineId: '金属厂', quantity: 1, startAt: 12, finishAt: 20 },
  ] });
  assert.equal(env.tables.length, 1);
  assert.deepEqual(env.tables[0].rows.map(row => row[1].textContent), ['铜锭（工厂补料） ×1', '螺母 ×1']);
});
console.log('排产界面测试通过 ' + passed + ' 项');
