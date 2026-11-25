import { newStateFunction } from './fixtures/console-state.mjs';
import assert from 'node:assert/strict';
import { PAGE } from '../src/page.mjs';
import { describeAccount } from '../src/accounts.mjs';

const script = [...PAGE.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(value => value.includes('function createAccountCard('));
assert.ok(script, '页面包含实际账号卡片逻辑');
const accountStart = script.indexOf('let snapshot =');
const accountEnd = script.indexOf('// ---- 总览', accountStart);
const cardsStart = script.indexOf('function accountChannel(');
const cardsEnd = script.indexOf('// ---- 添加账号', cardsStart);
assert.ok(accountStart >= 0 && accountEnd > accountStart && cardsEnd > cardsStart);
const accountScript = script.slice(accountStart, accountEnd);
const cardsScript = script.slice(cardsStart, cardsEnd);
const template = PAGE.match(/<template id="ui-account-card">([\s\S]*?)<\/template>/)?.[1];
assert.ok(template, '构建后的页面提供账号卡片模板');
assert.doesNotMatch(PAGE, /id="account-info-dialog"|data-account-action="details"/);
const fields = [...template.matchAll(/data-account-field="([^"]+)"/g)].map(match => match[1]);
const actions = [...template.matchAll(/data-account-action="([^"]+)"/g)].map(match => match[1]);
assert.match(template, /class="account-card-heading">.*?data-account-field="title"[^>]*><\/div><span[^>]*data-account-field="status"/s,
  '连接状态紧跟卡片名称');
assert.equal(fields.filter(name => name === 'status').length, 1);
assert.match(template, /class="basis-full"><dt>闯关挂机收益<\/dt>/);
let passed = 0;

async function test(name, run) {
  await run();
  passed++;
  console.log('通过：' + name);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function makeNode(tag = 'div', className = '', text = '') {
  const classes = new Set(String(className || '').split(/\s+/).filter(Boolean));
  const listeners = new Map();
  let content = text;
  return {
    tag, children: [], options: [], dataset: {}, value: '', disabled: false, hidden: false, open: false,
    parentNode: null, title: '',
    classList: {
      contains: name => classes.has(name),
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    get textContent() { return content + this.children.map(child => child.textContent).join(''); },
    set textContent(value) {
      content = String(value ?? '');
      for (const child of this.children) child.parentNode = null;
      this.children = [];
    },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    appendChild(child) { return this.insertBefore(child, null); },
    insertBefore(child, before) {
      child.remove();
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    },
    replaceChildren(...children) {
      if (children.some(child => 'text' in child)) this.options = children;
      else { this.textContent = ''; this.append(...children); }
    },
    contains(node) { return this === node || this.children.some(child => child.contains(node)); },
    get isConnected() { return this.tag === 'document' || !!this.parentNode?.isConnected; },
    before(node) { this.parentNode.insertBefore(node, this); },
    querySelector(selector) {
      const match = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1))
        : selector === '[data-slot="card-content"]' ? node.dataset.slot === 'card-content'
        : selector.startsWith('[data-account-field=') ? node.dataset.accountField === selector.match(/"([^"]+)"/)[1]
          : selector.startsWith('[data-account-action=') ? node.dataset.accountAction === selector.match(/"([^"]+)"/)[1]
            : node.tag === selector;
      for (const child of this.children) {
        if (match(child)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
    addEventListener(name, handler) { listeners.set(name, handler); },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function sampleAccounts() {
  return [
    { id: 'fixture-private-a', label: '主号', title: '主号 · 海风船长 · 海港10服', source: 'alipay',
      status: { connected: true }, lastSeen: { nickname: '海风船长', worldName: '海港10服', level: 28, power: 12345, at: 'fixture-time-a' },
      url: 'wss://fixture-secret.invalid', loginFrameHex: 'fixture-secret-frame', raw: { token: 'fixture-secret-token', sign: 'fixture-secret-sign' } },
    { id: 'fixture-private-b', label: null, title: '星海船长', source: 'phone', status: { paused: true },
      lastSeen: { nickname: '星海船长', worldName: '海港2服', level: 42, power: 23456, at: 'fixture-time-b' } },
  ];
}

function fixture(initial = sampleAccounts()) {
  const nodes = new Map();
  const env = { calls: [], cardReads: [], effects: [], exports: [], dialogs: [], allowed: true, dialogResult: null,
    serverRows: structuredClone(initial), selected: initial[0]?.id ?? null, errors: [] };
  env.node = id => {
    if (!nodes.has(id)) nodes.set(id, makeNode());
    return nodes.get(id);
  };
  env.component = name => {
    assert.equal(name, 'ui-account-card');
    const card = makeNode('article', 'account-card');
    const content = makeNode('div');
    content.dataset.slot = 'card-content';
    card.append(content);
    for (const name of fields) {
      const field = makeNode('span');
      field.dataset.accountField = name;
      if (['role', 'world', 'level', 'power', 'afk'].includes(name)) {
        const row = makeNode('div');
        row.append(field);
        card.append(row);
      } else {
        card.append(field);
      }
    }
    const menu = makeNode('details');
    card.append(menu);
    for (const name of actions) {
      const button = makeNode('button');
      button.dataset.accountAction = name;
      (['rename', 'export', 'remove'].includes(name) ? menu : card).append(button);
    }
    return card;
  };
  const page = makeNode('document');
  page.append(env.node('accounts'), env.node('account-worlds-dialog'));
  env.guard = async () => env.allowed;
  env.flush = async () => true;
  env.saveInterval = async () => true;
  env.respond = async (route, payload) => {
    const url = new URL(route, 'http://fixture.invalid');
    if (url.pathname === '/api/accounts/card') return null;
    if (url.pathname === '/api/connect') env.serverRows.find(row => row.id === (url.searchParams.get('account') || env.api.current())).status = { connected: true };
    if (['/api/accounts/pause', '/api/loop/stop'].includes(url.pathname)) {
      const row = env.serverRows.find(row => row.id === url.searchParams.get('account'));
      assert.ok(row, '必须明确指定目标账号');
      row.status = { connected: true, paused: false, looping: url.pathname === '/api/accounts/pause' };
      return url.pathname === '/api/loop/stop' ? { status: row.status } : row.status;
    }
    if (route === '/api/accounts/label') env.serverRows.find(row => row.id === payload.id).label = payload.label;
    if (route === '/api/accounts/remove') env.serverRows = env.serverRows.filter(row => row.id !== payload.id);
    if (route === '/api/accounts') return { accounts: structuredClone(env.serverRows), activeId: env.serverRows[0]?.id ?? null };
    return { ok: true };
  };
  env.call = async (route, options) => {
    const payload = options?.body ? JSON.parse(options.body) : null;
    if (route.startsWith('/api/accounts/card?')) env.cardReads.push(route);
    else env.calls.push({ route, payload });
    return env.respond(route, payload);
  };
  env.makeNode = makeNode;
  newStateFunction('env', `
    const $ = env.node, document = {hidden:false}, call = env.call, component = env.component;
    const Option = function(text,value) {this.text=text;this.value=value;};
    const clear = node => {node.textContent='';return node;};
    const el = env.makeNode;
    const fmt = value => Number(value).toLocaleString('en-US');
    const when = value => value;
    const reportError = error => env.errors.push(error);
    const configMayChangeAccount = async id => {env.effects.push(['guard',id]);return env.guard(id);};
    const configFlush = async () => {env.effects.push(['flush',current]);return env.flush();};
    const saveLoopInterval = async () => {env.effects.push(['interval',current]);return env.saveInterval();};
    const accountDialog = async (...args) => {env.dialogs.push(args);return env.dialogResult;};
    const exportAccounts = id => env.exports.push(id);
    const refreshProgression = () => {};
    const refreshSavedLineups = async () => {};
    const syncGameLineupPage = () => {};
    const refreshManualWorld = () => {};
    const refreshActivities = () => {};
    const refreshStages = () => {};
    const refreshLoop = () => {loopAccount=current;renderHostingControl();};
    let overviewPending = null;
    const refreshOverview = () => env.effects.push(['overview',current]);
    const cell = (_icon, _size, name, amount) => el('span', 'cell', name + ' ' + amount);
    const subscribe = () => {};
    const configAccountChanged = () => {};
    const giftAccountChanged = () => {};
    const loginSettingsAccountChanged = () => {};
    const siliconAccountChanged = () => {};
    const resourceFieldsAccountChanged = () => {};
    const resetWorldMap = () => {};
    const resetProductionPlan = () => {};
    const refreshChangedProductionPlan = () => {};
    let accounts=structuredClone(env.serverRows),current=env.selected,dailyAccount=current,dailyVersion=0;
    let worldMapOwner=null,productionPlanOwner=null,productionPlanBusy=false,loopAccount=current,loopVersion=0;
    ${accountScript}
    ${cardsScript}
    stateActions.replaceAccounts(structuredClone(env.serverRows), env.selected, { select: true });
    accountDetailsOwner=current;
    renderAccountSelect();
    env.api={renderAccounts,refreshAccountStatuses,selectLoadedAccount,setAccountStatus,
      overview(data) {stateActions.setGameData(current, 'overview', data);renderAccounts();},
      current:()=>current,rows:()=>accounts,snapshot:()=>snapshot,view:()=>consoleStore.getState().view,
      connectingAccounts: { has: id => connectingAccounts.has(id), add: id => stateActions.setFlag('connecting', id, true), delete: id => stateActions.setFlag('connecting', id, false) },
      replace(rows) {stateActions.replaceAccounts(structuredClone(rows), current);renderAccounts();}};
  `)(env);
  env.card = id => env.node('accounts').children.find(card => card.accountId === id);
  env.field = (id, name) => env.card(id).querySelector('[data-account-field="' + name + '"]');
  env.button = (id, name) => env.card(id).querySelector('[data-account-action="' + name + '"]');
  env.action = (id, name) => env.card(id).querySelector('[data-account-action="' + name + '"]').onclick();
  env.effects.length = 0;
  return env;
}

await test('登录设置绑定所点卡片，可配置非当前账号而不切号或连接游戏', async () => {
  const env = fixture();
  const [first, second] = sampleAccounts();
  await env.action(second.id, 'login-settings');
  assert.equal(env.api.view().loginSettingsAccountId, second.id);
  assert.equal(env.api.current(), first.id);
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.effects, []);
  await env.action(first.id, 'login-settings');
  assert.equal(env.api.view().loginSettingsAccountId, first.id);
  assert.doesNotMatch(PAGE, /data-tab="login-settings"|id="tab-login-settings"/);
  assert.match(PAGE, /id="account-login-dialog"/);
});

await test('每张卡片展示自己的资料、渠道和状态，默认不显示凭证或内部标识', async () => {
  const env = fixture();
  const [first, second] = sampleAccounts();
  assert.equal(env.field(first.id, 'title').textContent, '主号');
  assert.equal(env.field(first.id, 'role').textContent, '海风船长');
  assert.equal(env.field(first.id, 'world').textContent, '海港10服');
  assert.equal(env.field(first.id, 'level').textContent, '28');
  assert.equal(env.field(first.id, 'power').textContent, '12,345');
  assert.equal(env.field(first.id, 'channel').textContent, '支付宝');
  assert.equal(env.field(first.id, 'status').textContent, '已连接 · 未挂机');
  assert.equal(env.field(second.id, 'role').textContent, '星海船长');
  assert.equal(env.field(second.id, 'channel').textContent, '益世界 APP');
  assert.match(env.field(second.id, 'status').textContent, /已暂停/);
  assert.equal(env.field(first.id, 'current').hidden, false);
  assert.equal(env.field(second.id, 'current').hidden, true);
  assert.equal(env.field(first.id, 'role').parentNode.hidden, false, '人工备注标题保留角色行');
  assert.equal(env.field(second.id, 'role').parentNode.hidden, true, '纯昵称标题隐藏重复的角色行');
  for (const account of [first, second]) {
    assert.equal(env.card(account.id).hidden, false, '隐藏角色行保留整张卡片');
    for (const name of ['world', 'level', 'power']) {
      assert.equal(env.field(account.id, name).parentNode.hidden, false, '区服、等级和战力继续显示');
    }
  }
  assert.doesNotMatch(env.node('accounts').textContent, /fixture-private|fixture-secret|wss:\/\//);
  assert.doesNotMatch(PAGE, /id="cred(?:-show|-hide)?"|\/api\/accounts\/credential\?reveal=1/);
  assert.equal(env.calls.length, 0);
});

await test('账号公开描述保留原始备注字段', async () => {
  const account = { id: 'alipay:fixture-id', source: 'alipay', label: '人工备注',
    login: { eworldParams: { openId: 'fixture-id' } },
    lastSeen: { nickname: '角色名', worldId: 4000000785 } };
  const description = describeAccount(account);
  assert.equal(description.label, '人工备注');
  assert.equal(description.title, '人工备注 · 角色名 · 海灯785服');
  assert.equal(describeAccount({ ...account, label: undefined }).label, null);
});

await test('标题状态标签按账号原位更新，不重复创建', async () => {
  const env = fixture();
  const firstWorld = env.field('fixture-private-a', 'world');
  const firstStatus = env.field('fixture-private-a', 'status');
  const secondWorld = env.field('fixture-private-b', 'world');
  const secondStatus = env.field('fixture-private-b', 'status');
  assert.equal(firstStatus.textContent, '已连接 · 未挂机');
  assert.match(secondStatus.textContent, /已暂停/);
  env.api.setAccountStatus('fixture-private-a', { connected: false });
  env.api.setAccountStatus('fixture-private-b', { connected: true });
  env.api.renderAccounts();
  assert.equal(firstStatus.textContent, '未连接');
  assert.equal(secondStatus.textContent, '已连接 · 未挂机');
  assert.equal(firstWorld.textContent, '海港10服');
  assert.equal(secondWorld.textContent, '海港2服');
  assert.equal(env.field('fixture-private-a', 'status'), firstStatus);
  assert.equal(env.field('fixture-private-b', 'status'), secondStatus);
});

await test('挂机标签与按钮一致，连接、重连和暂停中的颜色与页头共用规则', async () => {
  const env = fixture();
  for (const [status, label, button, kind] of [
    [{ connected: true, looping: true }, '挂机中', '暂停挂机', 'done'],
    [{ connected: true, looping: false }, '已连接 · 未挂机', '开始挂机', 'done'],
    [{ connected: true, looping: true, loopStopping: true }, '暂停中…', '暂停中…', 'waiting'],
    [{ reconnecting: true }, '异地登录 · 等待重连', '暂停挂机', 'waiting'],
    [{ state: 'CONNECTING' }, '连接中…', '开始挂机', 'waiting'],
    [{ connected: false, looping: true }, '挂机中 · 等待连接', '暂停挂机', 'waiting'],
  ]) {
    env.api.replace(sampleAccounts().map(account => ({ ...account, status })));
    for (const { id } of sampleAccounts()) {
      assert.equal(env.field(id, 'status').textContent, label);
      assert.equal(env.field(id, 'status').classList.contains(kind), true);
      assert.equal(env.button(id, 'loop').textContent, button);
    }
  }
});

await test('空态和历史缺省资料可显示，删除最后一个账号后恢复空态', async () => {
  const env = fixture([]);
  const empty = env.node('accounts').children[0];
  assert.match(empty.textContent, /添加第一个游戏账号/);
  assert.equal(env.node('export-accounts').disabled, true);
  env.api.renderAccounts();
  assert.equal(env.node('accounts').children[0], empty);
  assert.equal(env.node('account-worlds-dialog').open, false);
  env.api.replace([{id:'legacy',title:'旧账号'}]);
  assert.equal(env.field('legacy','title').textContent,'旧账号');
  assert.equal(env.field('legacy','channel').textContent,'已导入账号');
  assert.equal(env.field('legacy','world').textContent,'待连接读取');
  assert.equal(env.field('legacy','level').textContent,'—');
  assert.equal(env.node('account-count').textContent,'1 个账号');
  env.api.replace([]);
  assert.equal(env.node('accounts').children.length,1);
  assert.ok(env.node('accounts').querySelector('.account-empty'));
  assert.equal(env.node('account-worlds-dialog').open, false);
  env.api.replace([{id:'again', title:'再次添加'}]);
  assert.ok(env.button('again','worlds'));
});

await test('状态及角色资料轮询原位更新卡片并保留打开的菜单', async () => {
  const env = fixture();
  const first = env.card('fixture-private-a');
  const second = env.card('fixture-private-b');
  const menu = second.querySelector('details');
  menu.open = true;
  env.serverRows[1].status = {connected:true};
  env.serverRows[1].label = '新备注';
  env.serverRows[1].lastSeen = {...env.serverRows[1].lastSeen,nickname:'新角色名',level:50,power:45678,worldName:'海灯3服'};
  await env.api.refreshAccountStatuses();
  assert.equal(env.card('fixture-private-a'),first);
  assert.equal(env.card('fixture-private-b'),second);
  assert.equal(menu.open,true);
  assert.equal(env.field(second.accountId,'title').textContent,'新备注');
  assert.equal(env.field(second.accountId,'role').textContent,'新角色名');
  assert.equal(env.field(second.accountId,'world').textContent,'海灯3服');
  assert.equal(env.field(second.accountId,'level').textContent,'50');
  assert.equal(env.field(second.accountId,'power').textContent,'45,678');
  assert.equal(env.field(second.accountId,'status').textContent,'已连接 · 未挂机');
  assert.deepEqual(env.calls.map(call=>call.route),['/api/accounts']);
  env.api.replace([...env.api.rows()].reverse());
  assert.equal(env.node('accounts').children[0],second, '卡片遵循账号列表顺序');
  assert.equal(menu.open,true);
});

await test('当前卡片内联显示角色和资源，切换时隔离资料并保留配置保护', async () => {
  const env = fixture();
  const [first, second] = sampleAccounts();
  env.api.overview({ player: { level: 30, power: 56789, worldId: 200000010 }, afk: { level: 67, capped: true }, resources: [{name: '金币', amount: 4321}] });
  assert.equal(env.field(first.id, 'power').textContent, '56,789');
  assert.equal(env.field(first.id, 'world').textContent, '海港10服');
  assert.match(env.field(first.id, 'afk').textContent, /等级 67 · 收益已满/);
  assert.match(env.field(first.id, 'resources').textContent, /金币 4,321/);
  env.allowed = false;
  await env.action(second.id,'select');
  assert.equal(env.api.current(),first.id);
  assert.equal(env.calls.length,0);
  env.allowed = true;
  await env.action(second.id,'select');
  assert.equal(env.api.current(),second.id);
  assert.equal(env.field(second.id, 'resources').textContent, '连接后读取资源');
  assert.match(env.field(first.id, 'resources').textContent, /金币 4,321/);
  assert.equal(env.node('accounts').children[0], env.card(first.id), '切换账号不移动卡片');
  assert.equal(env.field(second.id, 'afk').textContent, '待连接读取');
  assert.deepEqual(env.calls[0],{route:'/api/accounts/active',payload:{confirm:true,id:'fixture-private-b'}});
  await env.action(first.id,'select');
  assert.match(env.field(first.id, 'resources').textContent, /金币 4,321/);
});

await test('两张卡片刷新期间切号，乱序返回的余额仍各归原卡片', async () => {
  const rows = sampleAccounts().map(row => ({ ...row, status: { connected: true } }));
  const env = fixture(rows);
  const reads = rows.map(() => deferred());
  const respond = env.respond;
  env.respond = (route, payload) => {
    const index = rows.findIndex(row => route === '/api/accounts/card?account=' + row.id);
    return index === -1 ? respond(route, payload) : reads[index].promise;
  };
  const pending = rows.map(row => env.action(row.id, 'refresh'));
  await env.action(rows[1].id, 'select');
  for (const index of [1, 0]) {
    const sibling = env.card(rows[1 - index].id);
    const query = sibling.querySelector;
    let siblingReads = 0;
    sibling.querySelector = function (selector) { siblingReads++; return query.call(this, selector); };
    reads[index].resolve({ readAt: 123456, resources: [{ name: '金币', amount: index ? 0 : 2400 }] });
    await pending[index];
    sibling.querySelector = query;
    assert.equal(siblingReads, 0, '单张卡片资料返回时不遍历其他账号的 DOM');
  }
  assert.equal(env.field(rows[0].id, 'resources').textContent, '金币 2,400');
  assert.equal(env.field(rows[1].id, 'resources').textContent, '金币 0');
  assert.equal(env.api.current(), rows[1].id);
});

await test('非当前账号的区服管理独立寻址，关闭重开后忽略旧响应', async () => {
  const env = fixture();
  const [first, second] = sampleAccounts();
  const gate = deferred();
  const respond = env.respond;
  env.respond = (route, payload) => route === '/api/worlds?account=' + second.id ? gate.promise : respond(route, payload);
  await env.action(second.id, 'worlds');
  assert.match(env.node('account-worlds-title').textContent, /星海船长/);
  assert.equal(env.calls.length, 0);
  const loading = env.node('load-worlds').onclick();
  assert.equal(env.node('worlds-controls').disabled, true);
  env.node('account-worlds-close').onclick();
  await env.action(first.id, 'worlds');
  gate.resolve({ recentWorlds: [] });
  await loading;
  assert.equal(env.node('worlds').textContent, '');
  assert.equal(env.node('worlds-hint').textContent, '');
  env.node('account-worlds-close').onclick();
  await env.action(second.id, 'worlds');
  env.node('world-input').value = '9002';
  await env.node('enter-world').onclick();
  assert.equal(env.api.current(), first.id);
  assert.ok(env.calls.some(call => call.route === '/api/worlds/enter?account=' + second.id && call.payload.worldId === 9002));
  assert.equal(env.errors.length, 0);
});

await test('备注输入使用原始label，导出和移除使用所属卡片ID', async () => {
  const env = fixture();
  env.dialogResult = '新主号';
  await env.action('fixture-private-a','rename');
  assert.deepEqual(env.dialogs[0],['修改账号备注','海风船长','主号']);
  assert.deepEqual(env.calls[0],{route:'/api/accounts/label',payload:{confirm:true,id:'fixture-private-a',label:'新主号'}});
  env.dialogResult = null;
  await env.action('fixture-private-b','rename');
  assert.equal(env.dialogs.at(-1)[2],'');
  await env.action('fixture-private-b','export');
  assert.deepEqual(env.exports,['fixture-private-b']);
  const before = env.calls.length;
  await env.action('fixture-private-b','remove');
  assert.equal(env.calls.length,before,'取消删除不发请求');
  env.dialogResult = '';
  await env.action('fixture-private-b','remove');
  assert.deepEqual(env.calls.find(call=>call.route==='/api/accounts/remove'),
    {route:'/api/accounts/remove',payload:{confirm:true,id:'fixture-private-b'}});
  assert.equal(env.card('fixture-private-b'),undefined);
  assert.equal(env.api.current(),'fixture-private-a');
});

await test('未连接详情展示缓存，明确点击读取后才连接', async () => {
  const rows = sampleAccounts();
  rows[0].status = { connected: false };
  const env = fixture(rows);
  assert.equal(env.field(rows[0].id, 'role').textContent, rows[0].lastSeen.nickname);
  assert.equal(env.field(rows[0].id, 'resources').textContent, '连接后读取资源');
  assert.equal(env.calls.length, 0);
  assert.deepEqual(env.effects, []);
  assert.equal(env.button(rows[1].id, 'refresh').disabled, true, '暂停托管保留资料但禁用连接');
  await env.action(rows[0].id, 'refresh');
  await settle();
  assert.equal(env.calls.filter(call => call.route === '/api/connect').length, 1);
  assert.ok(env.cardReads.includes('/api/accounts/card?account=' + rows[0].id));
  assert.equal(env.button(rows[0].id, 'refresh').textContent, '刷新资料');
});

await test('旧卡片切换请求迟到不会覆盖后选卡片或下拉账号', async () => {
  for (const selection of ['card', 'dropdown']) {
    const env = fixture([...sampleAccounts(), { id: 'fixture-private-c', title: '第三角色', status: {} }]);
    const older = deferred();
    const respond = env.respond;
    env.respond = (route, payload) => route === '/api/accounts/active' && payload.id === 'fixture-private-b'
      ? older.promise : respond(route, payload);
    const switching = env.action('fixture-private-b', 'select');
    await settle();
    assert.equal(env.calls[0].payload.id, 'fixture-private-b');
    if (selection === 'card') await env.action('fixture-private-c', 'select');
    else {
      env.node('account').value = 'fixture-private-c';
      await env.node('account').onchange();
    }
    assert.equal(env.api.current(), 'fixture-private-c');
    older.resolve({ ok: true });
    await switching;
    assert.equal(env.api.current(), 'fixture-private-c');
    assert.equal(env.node('account').value, 'fixture-private-c');
    assert.equal(env.field('fixture-private-c','current').hidden, false);
  }
});

await test('卡片或下拉的旧配置确认迟到不再发送切号请求', async () => {
  for (const source of ['card', 'dropdown']) {
    const env = fixture([...sampleAccounts(), { id: 'fixture-private-c', title: '第三角色', status: {} }]);
    const older = deferred();
    env.guard = id => id === 'fixture-private-b' ? older.promise : Promise.resolve(true);
    let first;
    if (source === 'card') first = env.action('fixture-private-b', 'select');
    else {
      env.node('account').value = 'fixture-private-b';
      first = env.node('account').onchange();
    }
    await settle();
    assert.equal(env.calls.length, 0);
    await env.action('fixture-private-c', 'select');
    older.resolve(true);
    await first;
    assert.deepEqual(env.calls.filter(call => call.route === '/api/accounts/active').map(call => call.payload.id),
      ['fixture-private-c']);
    assert.equal(env.api.current(), 'fixture-private-c');
    assert.equal(env.node('account').value, 'fixture-private-c');
    assert.equal(env.field('fixture-private-c','current').hidden, false);
  }
});

await test('账号卡片直接开始及暂停非当前账号，不切号也不提交当前草稿', async () => {
  const env = fixture();
  const id = 'fixture-private-b';
  assert.equal(env.button(id, 'loop').textContent, '开始挂机');
  await env.action(id, 'loop');
  await settle();
  assert.deepEqual(env.calls[0], { route: '/api/accounts/pause?account=' + id,
    payload: { confirm: true, paused: false, start: true } });
  assert.equal(env.api.current(), 'fixture-private-a');
  assert.equal(env.api.snapshot().looping, undefined);
  assert.equal(env.api.rows()[1].status.paused, false);
  assert.equal(env.button(id, 'loop').textContent, '暂停挂机');
  assert.deepEqual(env.effects, []);
  await env.action(id, 'loop');
  await settle();
  assert.ok(env.calls.some(call => call.route === '/api/loop/stop?account=' + id));
  assert.equal(env.api.rows()[1].status.looping, false);
  assert.equal(env.api.rows()[1].status.connected, true);
  assert.equal(env.button(id, 'loop').textContent, '开始挂机');
  assert.equal(env.api.current(), 'fixture-private-a');
});

await test('当前账号开始前保存配置和间隔，暂停无需保存且同步页头状态', async () => {
  const env = fixture();
  const id = 'fixture-private-a';
  await env.action(id, 'loop');
  await settle();
  assert.deepEqual(env.effects, [['flush', id], ['interval', id]]);
  assert.equal(env.api.snapshot().looping, true);
  assert.equal(env.node('loop-toggle').textContent, '暂停挂机');
  env.effects.length = 0;
  await env.action(id, 'loop');
  await settle();
  assert.deepEqual(env.effects, []);
  assert.equal(env.node('loop-toggle').textContent, '开始挂机');
  assert.equal(env.api.snapshot().connected, true);
});

await test('保存失败或保存期间切号不启动旧账号，控件恢复可用', async () => {
  for (const failure of ['config', 'interval', 'switch']) {
    const env = fixture();
    const gate = deferred();
    if (failure === 'config') env.flush = async () => false;
    if (failure === 'interval') env.saveInterval = async () => false;
    if (failure === 'switch') env.flush = () => gate.promise;
    const pending = env.action('fixture-private-a', 'loop');
    await settle();
    if (failure === 'switch') {
      env.api.selectLoadedAccount('fixture-private-b');
      gate.resolve(true);
    }
    await pending;
    await settle();
    assert.equal(env.calls.some(call => call.route.startsWith('/api/accounts/pause')), false);
    assert.equal(env.button('fixture-private-a', 'loop').disabled, false);
    if (failure === 'config') assert.match(env.errors[0].message, /配置尚未保存/);
  }
});

await test('开始请求期间拒绝重复点击，迟到结果只更新目标账号', async () => {
  const env = fixture();
  const id = 'fixture-private-b';
  const gate = deferred();
  const respond = env.respond;
  env.respond = async (route, payload) => {
    if (route.startsWith('/api/accounts/pause')) await gate.promise;
    return respond(route, payload);
  };
  const pending = env.action(id, 'loop');
  await settle();
  assert.equal(env.button(id, 'loop').disabled, true);
  assert.equal(env.button(id, 'loop').textContent, '处理中…');
  await env.action(id, 'loop');
  assert.equal(env.calls.filter(call => call.route.startsWith('/api/accounts/pause')).length, 1);
  env.api.selectLoadedAccount(id);
  assert.equal(env.node('loop-toggle').disabled, true, '页头与卡片共用操作锁');
  env.api.selectLoadedAccount('fixture-private-a');
  gate.resolve();
  await pending;
  await settle();
  assert.equal(env.api.current(), 'fixture-private-a');
  assert.equal(env.api.snapshot().looping, undefined);
  assert.equal(env.api.rows()[1].status.looping, true);
  assert.equal(env.button(id, 'loop').disabled, false);
});

await test('重连中的账号可暂停，正在停止的账号不能再开始', async () => {
  const rows = sampleAccounts();
  rows[1].status = { reconnecting: true };
  const env = fixture(rows);
  assert.equal(env.button(rows[1].id, 'loop').textContent, '暂停挂机');
  await env.action(rows[1].id, 'loop');
  await settle();
  assert.equal(env.calls[0].route, '/api/loop/stop?account=' + rows[1].id);
  env.api.setAccountStatus(rows[1].id, { loopStopping: true });
  env.api.renderAccounts();
  assert.equal(env.button(rows[1].id, 'loop').textContent, '暂停中…');
  assert.equal(env.button(rows[1].id, 'loop').disabled, true);
  const count = env.calls.length;
  await env.action(rows[1].id, 'loop');
  assert.equal(env.calls.length, count);
});

await test('请求失败显示错误并释放锁，旧轮询不覆盖操作结果', async () => {
  const env = fixture();
  const id = 'fixture-private-b';
  const respond = env.respond;
  env.respond = (route, payload) => {
    if (route.startsWith('/api/accounts/pause')) throw new Error('测试连接失败');
    return respond(route, payload);
  };
  await env.action(id, 'loop');
  await settle();
  assert.match(env.errors[0].message, /测试连接失败/);
  assert.equal(env.button(id, 'loop').disabled, false);
  const gate = deferred();
  const stale = { accounts: structuredClone(env.serverRows) };
  env.respond = (route, payload) => route === '/api/accounts' ? gate.promise : respond(route, payload);
  const polling = env.api.refreshAccountStatuses();
  await env.action(id, 'loop');
  gate.resolve(stale);
  await polling;
  assert.equal(env.api.rows()[1].status.looping, true);
  assert.equal(env.button(id, 'loop').textContent, '暂停挂机');
});

console.log(`账号卡片自检通过 ${passed} 项`);
