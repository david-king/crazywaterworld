// 装备与徽章：属性数值、评级、词条位、穿戴归属与洗炼动作（假 client，不连游戏）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createGameItems } = await import('../src/items.mjs');

// protobufjs 的枚举同时有「名字→数字」和「数字→名字」，这里照它的形状造一份。
const enumOf = entries => {
  const table = {};
  for (const [name, value] of Object.entries(entries)) {
    table[name] = value;
    table[value] = name;
  }
  return table;
};

const config = {
  tables: {
    EquipCfg: { data: [
      { id: '橙饰品2', name: '电刀', type: '饰品', quality: 'ORANGE', qualityIndex: 4, icon: 'equip_c6' },
    ] },
    EquipAttrCfg: { data: [
      { id: '橙饰品2', star: '3', maxLv: 115, extraAtts: [30004, 30004],
        baseAttrs: [['基础攻击', 568], ['基础法强', 243], ['法抗穿透', 16]],
        growAttrs: [['基础攻击', 19.9], ['基础法强', 8.5], ['法抗穿透', 0.6]] },
    ] },
    EquipRerollCfg: { data: [ { quality: 4, star: 3, lockCount: 0, cost: ['装备洗炼石', 10], lockCost: [] } ] },
    HeroBadgeCfg: { data: [
      { id: '橙射手徽章', name: '白银徽章·射手', career: '射手', quality: 'ORANGE', qualityIndex: 3, icon: 'badge_sheshou_5' },
    ] },
    HeroBadgeAttrCfg: { data: [
      { id: '橙射手徽章', star: 5, maxLevel: 120,
        baseAttrs: [['基础生命', 3803], ['基础攻击', 761], ['基础法强', 101]],
        growAttrs: [['基础生命', 58.9], ['基础攻击', 11.8], ['基础法强', 1.6]] },
    ] },
    AdditionAttrOverviewCfg: { data: [
      { id: '基础攻击', enhanceAttr: 'attriGain_attackDamage_base', name: '攻击', type: '数值' },
      { id: '基础法强', enhanceAttr: 'attriGain_abilityPower_base', name: '技能强度', type: '数值' },
      { id: '法抗穿透', enhanceAttr: 'attriGain_mgResisPenetration', name: '抗性穿透', type: '数值' },
      { id: '基础生命', enhanceAttr: 'attriGain_healthPoint_base', name: '生命', type: '数值' },
      { id: '攻击百分比', enhanceAttr: 'attriGain_attackDamage_ratio', name: '攻击', type: '百分比' },
      { id: '命中百分比', enhanceAttr: 'attriGain_hitChance_ratio', name: '命中', type: '百分比' },
    ] },
    HeroCfg: { data: [{ id: '兰博', name: '兰博' }] },
  },
};

const enhance = enumOf({
  attriGain_healthPoint_base: 1,
  attriGain_attackDamage_base: 2,
  attriGain_abilityPower_base: 3,
  attriGain_attackDamage_ratio: 5,
  attriGain_hitChance_ratio: 22,
  attriGain_mgResisPenetration: 18,
});

const equip = {
  uid: { low: 1208549744519 & 0xffffffff, high: Math.floor(1208549744519 / 4294967296), unsigned: false },
  equipId: '橙饰品2', level: 1, star: 3, refineLv: 0,
  attr: [
    { attr: 5, value: 0.048, rating: 1 },
    { attr: 22, value: 0.0702, rating: 2 },
  ],
};
const badge = {
  uid: { low: 1206988296648 & 0xffffffff, high: Math.floor(1206988296648 / 4294967296), unsigned: false },
  badgeId: '橙射手徽章', level: 1, exp: 0, star: 5,
  attr: { attr: 22, value: 0.1053, rating: 2 },
};

const calls = [];
function makeClient(overrides = {}) {
  return {
    protocol: { EnhanceAttr: enhance },
    async request(name) {
      calls.push(['request', name]);
      if (name === 'EquipsRequest') return { equip: [overrides.equip ?? equip] };
      if (name === 'BadgesRequest') return { badge: [overrides.badge ?? badge] };
      if (name === 'AllHeroRequest') return { heroes: overrides.heroes ?? [{ heroId: '兰博', showName: '兰博', equips: [equip], badges: [] }] };
      if (name === 'AllItemRequest') return { items: [{ itemId: '装备洗炼石', num: { low: 5505, high: 0, unsigned: false } }] };
      throw Error('未声明的请求 ' + name);
    },
    async sendWatch(name, body) {
      calls.push(['send', name, body]);
      if (name === 'EquipRerollAttrRequest' && !overrides.skipPending) {
        equip.rerollAttrs = [{ attr: 18, value: 36, rating: 1 }, { attr: 5, value: 0.039, rating: 2 }];
      }
      if (name === 'SaveEquipRerollRequest') {
        if (body.saveOrNot) equip.attr = equip.rerollAttrs;
        delete equip.rerollAttrs;
      }
    },
  };
}

const current = () => {};
const schedule = work => work();

calls.length = 0;
const items = createGameItems(makeClient(), { config });
const view = await items.read(schedule, current);
assert.deepEqual(calls.map(call => call[1]), ['EquipsRequest', 'BadgesRequest', 'AllHeroRequest', 'AllItemRequest']);
assert.equal(view.hint, '');
assert.equal(view.materials['装备洗炼石'], 5505, '列表读取要带回洗炼材料余量');
assert.equal(view.rows.length, 2, '装备与徽章都要出现');

const [equipRow, badgeRow] = view.rows;
assert.equal(equipRow.kind, 'equip');
assert.equal(equipRow.uid, '1208549744519', 'UID 必须精确成字符串');
assert.equal(equipRow.name, '电刀');
assert.equal(equipRow.slots, 2, '词条位来自装备模板');
assert.equal(equipRow.wornBy, '兰博', '要标出穿在哪个英雄身上');
assert.equal(equipRow.rerollable, true, '橙装可以洗炼');
assert.equal(equipRow.ratingLetter, 'B', '评级取该装备最好的一条');
// 基础属性 = 配置 base + grow × 等级；装备保留一位小数
assert.deepEqual(equipRow.baseAttrs.map(attr => [attr.name, attr.display]),
  [['攻击', '587.9'], ['技能强度', '251.5'], ['抗性穿透', '16.6']]);
// 附加属性：百分比取值 ×100，评级 1=C、2=B
assert.deepEqual(equipRow.attrs.map(attr => [attr.name, attr.display, attr.letter]),
  [['攻击', '4.80%', 'C'], ['命中', '7.02%', 'B']]);

assert.equal(badgeRow.kind, 'badge');
assert.equal(badgeRow.name, '白银徽章·射手');
assert.equal(badgeRow.slots, 1);
assert.equal(badgeRow.rerollable, false, '徽章不属于装备洗炼');
// 徽章基础属性游戏里取整
assert.deepEqual(badgeRow.baseAttrs.map(attr => [attr.name, attr.display]),
  [['生命', '3861'], ['攻击', '772'], ['技能强度', '102']]);
assert.deepEqual(badgeRow.attrs.map(attr => [attr.display, attr.letter]), [['10.53%', 'B']]);

// ---- 洗炼 ----
calls.length = 0;
const rolled = await items.reroll({ uid: '1208549744519', lockedSlots: [0] }, schedule, current);
const rerollCall = calls.find(call => call[1] === 'EquipRerollAttrRequest');
assert.equal(rerollCall[2].uid.low, equip.uid.low, '洗炼请求要带 int64 形状的 uid');
assert.deepEqual(rerollCall[2].specAttrs, []);
assert.deepEqual(rerollCall[2].lockedSlots, [0]);
assert.deepEqual(rolled.equip.pending.map(attr => [attr.name, attr.display, attr.letter]),
  [['抗性穿透', '36', 'C'], ['攻击', '3.90%', 'B']]);
assert.equal(rolled.materials.before['装备洗炼石'], 5505);
assert.equal(rolled.equip.attrs.length, 2, '洗炼结果未保存前原属性不变');

const saved = await items.decide({ uid: '1208549744519', save: true }, schedule, current);
const decideCall = calls.find(call => call[1] === 'SaveEquipRerollRequest');
assert.equal(decideCall[2].saveOrNot, true);
assert.deepEqual(saved.equip.attrs.map(attr => attr.name), ['抗性穿透', '攻击']);
assert.deepEqual(saved.equip.pending, []);

// 缺少洗炼结果时不能当成成功
const noPending = createGameItems(makeClient({ skipPending: true }), { config });
await assert.rejects(noPending.reroll({ uid: '1208549744519' }, schedule, current), /没有等到洗炼结果/);
await assert.rejects(items.reroll({ uid: '', lockedSlots: [] }, schedule, current), /请选择要洗炼的装备/);
await assert.rejects(items.reroll({ uid: '1208549744519', lockedSlots: [9] }, schedule, current), /锁定的词条位置无效/);
await assert.rejects(items.decide({ uid: '1208549744519', save: 'yes' }, schedule, current), /需要明确保存或放弃/);

// 同一件装备被记到两个英雄名下要报错，而不是随便归给一个人
const conflict = createGameItems(makeClient({
  heroes: [{ heroId: '兰博', showName: '兰博', equips: [equip], badges: [] },
    { heroId: '兰博', showName: '米娅', equips: [equip], badges: [] }],
}), { config });
await assert.rejects(conflict.read(schedule, current), /同一件装备被记到两个英雄名下/);

// ---- 入库时间 ----
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-items-store-'));
process.env.CW_DATA_DIR = storeDir;
const { syncItems, itemsStatePath } = await import('../src/item-store.mjs');
const { evaluateRoll: evaluate, normalizeRequirements: normalize } = await import('../src/reroll-runner.mjs');

const stateFile = itemsStatePath('acct');
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, baselineAt: 10, items: {
  'equip:1': { firstSeen: 10, read: false },
  'badge:2': { firstSeen: 12, read: true },
} }));
const rows = [{ kind: 'equip', uid: '1' }, { kind: 'badge', uid: '1' }];
syncItems('acct', rows, 20);
assert.deepEqual(rows.map(row => row.firstSeen), [10, 20], '保留已有入库时间，新徽章使用本次时间');
assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).items, {
  'equip:1': { firstSeen: 10 }, 'badge:1': { firstSeen: 20 },
});
syncItems('acct', rows, 30);
assert.deepEqual(rows.map(row => row.firstSeen), [10, 20], '刷新不改变入库时间');
syncItems('acct-b', rows, 40);
assert.deepEqual(rows.map(row => row.firstSeen), [40, 40], '每个账号独立记录入库时间');

// ---- 自动洗炼条件 ----
const attr = (name, rating) => ({ name, rating });
const reqs = normalize([{ attr: '攻击速度', minRating: 2, count: 2 }], 3);
assert.equal(evaluate([attr('攻击速度', 2), attr('攻击速度', 3), attr('生命', 1)], reqs).satisfied, true, '3 条攻速也满足 2 条需求');
assert.equal(evaluate([attr('攻击速度', 3), attr('攻击速度', 1)], reqs).satisfied, false, '评级不够不算');
assert.equal(evaluate([attr('攻击速度', 3)], normalize([{ attr: '攻击速度', minRating: 1, count: 1 }], 2)).satisfied, true, '设 C 出 A 也要停');
assert.equal(evaluate([attr('生命', 1), attr('护甲', 1), attr('攻击速度', 1)],
  normalize([{ attr: '攻击速度', minRating: 1, count: 1 }], 3)).satisfied, true, '不区分第几条');
assert.equal(evaluate([attr('生命', 4), attr('闪避', 4), attr('暴击', 1)],
  normalize([{ attr: '*', minRating: 3, count: 2 }], 3)).satisfied, true, '任意属性按条数判定');
assert.throws(() => normalize([{ attr: '攻击', minRating: 1, count: 3 }], 2), /只有 2 条词条位/, '需求超过词条位要拒绝');
assert.throws(() => normalize([{ attr: '', minRating: 1, count: 1 }], 2), /缺少属性名/);

console.log('selftest-items state ok: 入库时间 / 自动洗炼条件');
console.log('selftest-items ok: 属性数值 / 评级 / 词条位 / 穿戴归属 / 洗炼与保存');
