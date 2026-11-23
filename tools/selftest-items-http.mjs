// 装备页的 HTTP 接线：列表 / 手动洗炼 / 自动洗炼（假 client，不连游戏）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-items-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_RESOURCE_AUTO_UPDATE = '0';

const enumOf = entries => {
  const table = {};
  for (const [name, value] of Object.entries(entries)) {
    table[name] = value;
    table[value] = name;
  }
  return table;
};

fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([
  [0, 'EquipCfg', { data: [
    { id: '橙饰品2', name: '电刀', type: '饰品', quality: 'ORANGE', qualityIndex: 4, icon: 'equip_c6' },
    { id: '紫饰品2', name: '热能匕首', type: '饰品', quality: 'PURPLE', qualityIndex: 3, icon: 'equip_c1' },
  ] }],
  [1, 'EquipAttrCfg', { data: [
    { id: '橙饰品2', star: '3', maxLv: 115, extraAtts: [30004, 30004],
      baseAttrs: [['基础攻击', 568], ['基础法强', 243], ['法抗穿透', 16]],
      growAttrs: [['基础攻击', 19.9], ['基础法强', 8.5], ['法抗穿透', 0.6]] },
    { id: '紫饰品2', star: '1', maxLv: 70, extraAtts: [20002],
      baseAttrs: [['基础攻击', 100], ['基础法强', 20]], growAttrs: [['基础攻击', 2], ['基础法强', 1]] },
  ] }],
  [2, 'EquipRerollCfg', { data: [{ quality: 4, star: 3, lockCount: 0, cost: ['装备洗炼石', 10], lockCost: [] }] }],
  [3, 'HeroBadgeCfg', { data: [
    { id: '橙射手徽章', name: '白银徽章·射手', career: '射手', quality: 'ORANGE', qualityIndex: 3, icon: 'badge_sheshou_5' },
  ] }],
  [4, 'HeroBadgeAttrCfg', { data: [
    { id: '橙射手徽章', star: 5, maxLevel: 120,
      baseAttrs: [['基础生命', 3803], ['基础攻击', 761], ['基础法强', 101]],
      growAttrs: [['基础生命', 58.9], ['基础攻击', 11.8], ['基础法强', 1.6]] },
  ] }],
  [5, 'AdditionAttrOverviewCfg', { data: [
    { id: '基础攻击', enhanceAttr: 'attriGain_attackDamage_base', name: '攻击', type: '数值' },
    { id: '基础法强', enhanceAttr: 'attriGain_abilityPower_base', name: '技能强度', type: '数值' },
    { id: '法抗穿透', enhanceAttr: 'attriGain_mgResisPenetration', name: '抗性穿透', type: '数值' },
    { id: '基础生命', enhanceAttr: 'attriGain_healthPoint_base', name: '生命', type: '数值' },
    { id: '攻击百分比', enhanceAttr: 'attriGain_attackDamage_ratio', name: '攻击', type: '百分比' },
    { id: '命中百分比', enhanceAttr: 'attriGain_hitChance_ratio', name: '命中', type: '百分比' },
  ] }],
  [6, 'HeroCfg', { data: [{ id: '兰博', name: '兰博' }] }],
]));

const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('../src/server.mjs');
const account = 'items-a';
saveStore({ activeId: account, accounts: [{ id: account, label: account, url: 'ws://fixture.invalid', login: {}, automation: { enabled: false, autoStart: false } }] });

const enhance = enumOf({
  attriGain_healthPoint_base: 1,
  attriGain_attackDamage_base: 2,
  attriGain_abilityPower_base: 3,
  attriGain_attackDamage_ratio: 5,
  attriGain_hitChance_ratio: 22,
  attriGain_mgResisPenetration: 18,
});

let equip = {
  uid: { low: 1208549744519 & 0xffffffff, high: Math.floor(1208549744519 / 4294967296), unsigned: false },
  equipId: '橙饰品2', level: 1, star: 3, refineLv: 0,
  attr: [{ attr: 5, value: 0.048, rating: 1 }, { attr: 22, value: 0.0702, rating: 2 }],
};
const purple = {
  uid: { low: 999, high: 0, unsigned: false },
  equipId: '紫饰品2', level: 1, star: 1, refineLv: 0,
  attr: [{ attr: 5, value: 0.012, rating: 0 }],
};
const badge = {
  uid: { low: 1206988296648 & 0xffffffff, high: Math.floor(1206988296648 / 4294967296), unsigned: false },
  badgeId: '橙射手徽章', level: 1, exp: 0, star: 5,
  attr: { attr: 22, value: 0.1053, rating: 2 },
};
let stones = 5505;
const calls = [];

const client = Object.assign(new EventEmitter(), {
  connected: true,
  protocol: { EnhanceAttr: enhance },
  snapshot: () => ({ state: 'READY', connected: true }),
  stop() { this.connected = false; },
  async request(name) {
    calls.push(['request', name]);
    if (name === 'EquipsRequest') return { equip: [equip, purple] };
    if (name === 'BadgesRequest') return { badge: [badge] };
    if (name === 'AllHeroRequest') return { heroes: [{ heroId: '兰博', showName: '兰博', equips: [equip], badges: [] }] };
    if (name === 'AllItemRequest') return { items: [{ itemId: '装备洗炼石', num: { low: stones, high: 0, unsigned: false } }] };
    throw Error('未声明的请求 ' + name);
  },
  async sendWatch(name, body) {
    calls.push(['send', name, body]);
    if (name === 'EquipRerollAttrRequest') {
      stones -= 10;
      equip.rerollAttrs = [{ attr: 18, value: 36, rating: 1 }, { attr: 5, value: 0.039, rating: 2 }];
    }
    if (name === 'SaveEquipRerollRequest') {
      if (body.saveOrNot) equip.attr = equip.rerollAttrs;
      delete equip.rerollAttrs;
    }
  },
});

const app = createConsole({ port: 0, protocol: {} });
const base = await app.listen();
const session = app.sessions.get(account);
session.player = { playerId: '1', nickname: '船长', worldId: 3, scenarioId: 1, guildId: 1 };
session.client = client;

const get = async (path) => {
  const response = await fetch(base + path + (path.includes('?') ? '&' : '?') + 'account=' + account);
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
};
const post = async (path, body) => {
  const response = await fetch(base + path + '?account=' + account, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  return { status: response.status, value };
};

// 首次读取仓库和材料
const first = await get('/api/items');
assert.equal(first.rows.length, 3, '两件装备 + 一个徽章');
assert.equal(first.materials['装备洗炼石'], 5505);
const orange = first.rows.find(row => row.name === '电刀');
assert.equal(orange.rerollable, true, '橙装可洗炼');
assert.equal(orange.wornBy, '兰博');
assert.equal(first.rows.find(row => row.name === '热能匕首').rerollable, false, '紫装不能洗炼');
assert.equal(first.rows.find(row => row.kind === 'badge').rerollable, false, '徽章不能洗炼');

// 再次读取仓库时保留已有物品的入库时间
const extra = { ...purple, uid: { low: 1000, high: 0, unsigned: false } };
const original = client.request;
client.request = async (name, ...rest) => {
  if (name === 'EquipsRequest') return { equip: [equip, purple, extra] };
  return original.call(client, name, ...rest);
};
const second = await get('/api/items');
assert.equal(second.rows.find(row => row.uid === orange.uid).firstSeen, orange.firstSeen);
assert.ok(second.rows.find(row => row.uid === '1000').firstSeen > 0, '记录新增装备的入库时间');
assert.ok(!('unread' in second) && second.rows.every(row => !('read' in row) && !('isNew' in row)));
for (const path of ['/api/items/read', '/api/items/read-all']) {
  assert.equal((await post(path, { confirm: true })).status, 404);
}

// 手动洗炼 → 放弃保持原属性；再洗一次 → 保存
const rolled = await post('/api/items/reroll', { uid: '1208549744519', confirm: true });
assert.equal(rolled.status, 200);
assert.equal(rolled.value.equip.pending.length, 2);
assert.equal(rolled.value.materials.after['装备洗炼石'], 5495, '洗炼扣 10 个');
const dropped = await post('/api/items/decide', { uid: '1208549744519', save: false, confirm: true });
assert.deepEqual(dropped.value.equip.attrs.map(attr => attr.name), ['攻击', '命中'], '放弃保持原属性');
await post('/api/items/reroll', { uid: '1208549744519', confirm: true });
const saved = await post('/api/items/decide', { uid: '1208549744519', save: true, confirm: true });
assert.deepEqual(saved.value.equip.attrs.map(attr => attr.name), ['抗性穿透', '攻击']);

// 紫装洗炼被拒绝
const blocked = await post('/api/items/reroll', { uid: '999', confirm: true });
assert.equal(blocked.status, 400);
assert.match(blocked.value.error, /只有橙装和红装/);

// 自动洗炼：材料下限设成当前余量 → 立刻停止且不洗炼
const before = stones;
await post('/api/items/auto', {
  uid: '1208549744519', requirements: [{ attr: '*', minRating: 1, count: 1 }],
  maxRolls: 3, materialFloor: before, confirm: true,
});
let status = await get('/api/items/auto');
for (let i = 0; i < 20 && status.running; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 100));
  status = await get('/api/items/auto');
}
assert.equal(status.running, false);
assert.match(status.stopReason, /不足/);
assert.equal(stones, before, '材料不足时一次都不洗');

// 自动洗炼：材料足够、条件不可能满足 → 洗 1 次后放弃并停止
await post('/api/items/auto', {
  uid: '1208549744519', requirements: [{ attr: '攻击速度', minRating: 4, count: 2 }],
  maxRolls: 1, materialFloor: 0, confirm: true,
});
for (let i = 0; i < 30; i += 1) {
  await new Promise(resolve => setTimeout(resolve, 100));
  status = await get('/api/items/auto');
  if (!status.running) break;
}
assert.equal(status.running, false);
assert.equal(status.roll, 1);
assert.match(status.stopReason, /洗满 1 次/);
assert.equal(stones, before - 10, '自动洗炼只扣了一轮');

app.close?.();
console.log('selftest-items-http ok: 列表 / 入库时间 / 洗炼 / 自动洗炼 / 拦截');
