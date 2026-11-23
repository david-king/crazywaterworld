// 装备与徽章：属性数值、评级、星级、词条位、穿戴归属，以及洗炼的三个动作。
// 数值全部来自游戏协议（EquipsRequest / BadgesRequest），名字与基础属性由配置表补齐。
// 评级是协议自带的 rating：1=C、2=B、3=A、4=S，0 表示游戏里不显示评级。
import { exactAutomationId } from './automation-policy.mjs';
import { iconEntry } from './art.mjs';
import { syncItems } from './item-store.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';

const RATING_LETTERS = { 0: '', 1: 'C', 2: 'B', 3: 'A', 4: 'S' };
export const REROLL_MATERIALS = ['装备洗炼石', '红装备洗炼石', '锁定石'];
const rows = (config, table) => config?.tables?.[table]?.data ?? [];

function attrTables(config) {
  const list = rows(config, 'AdditionAttrOverviewCfg');
  return {
    byEnhance: new Map(list.filter(row => row.enhanceAttr).map(row => [row.enhanceAttr, row])),
    byId: new Map(list.map(row => [row.id, row])),
  };
}

// protobufjs 的枚举同时保存「名字→数字」和「数字→名字」，这里取后者。
function enhanceNames(protocol) {
  const source = protocol?.EnhanceAttr;
  const map = new Map();
  if (!source || typeof source !== 'object') return map;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isNaN(Number(key))) map.set(value, key);
  }
  return map;
}

function computeAttrs(list, tables, names) {
  return (Array.isArray(list) ? list : []).map(entry => {
    const id = Number(entry?.attr ?? 0);
    const key = names.get(id) ?? '';
    const row = tables.byEnhance.get(key) ?? tables.byId.get(key);
    const type = row?.type ?? '数值';
    const value = Number(entry?.value ?? 0);
    const rating = Number(entry?.rating ?? 0);
    return {
      name: row?.name ?? '属性' + id,
      type,
      value,
      display: type === '百分比' ? (value * 100).toFixed(2) + '%' : String(Math.round(value * 100) / 100),
      rating,
      letter: RATING_LETTERS[rating] ?? '',
    };
  });
}

function computeBase(row, level, kind, tables) {
  const base = Array.isArray(row?.baseAttrs) ? row.baseAttrs : [];
  const grow = Array.isArray(row?.growAttrs) ? row.growAttrs : [];
  return base.map((entry, index) => {
    const key = entry?.[0] ?? '';
    const meta = tables.byId.get(key);
    const type = meta?.type ?? '数值';
    const value = Number(entry?.[1] ?? 0) + Number(grow[index]?.[1] ?? 0) * Number(level ?? 0);
    // 徽章的基础值游戏里取整；装备保留一位小数（587.9 / 251.5）。
    const display = type === '百分比' ? (value * 100).toFixed(2) + '%'
      : kind === 'badge' ? String(Math.floor(value))
        : String(Math.round(value * 10) / 10);
    return { name: meta?.name ?? key, type, value, display };
  });
}

const bestRating = attrs => attrs.reduce((best, attr) => (attr.rating > best ? attr.rating : best), 0);

export function createGameItems(client, { config, accountId = '' } = {}) {
  const tables = attrTables(config);
  const names = enhanceNames(client.protocol);
  const equips = new Map(rows(config, 'EquipCfg').map(row => [row.id, row]));
  const equipAttr = new Map(rows(config, 'EquipAttrCfg').map(row => [row.id + '|' + String(row.star), row]));
  const badges = new Map(rows(config, 'HeroBadgeCfg').map(row => [row.id, row]));
  const badgeAttr = new Map(rows(config, 'HeroBadgeAttrCfg').map(row => [row.id + '|' + String(row.star), row]));
  const heroNames = new Map(rows(config, 'HeroCfg').map(row => [row.id, row.name]));
  // 只有配置了洗炼费用的品质才能洗（橙 qualityIndex 4、红 5；紫/蓝/绿没有）
  const rerollQualities = new Set(rows(config, 'EquipRerollCfg').map(row => Number(row.quality)));

  async function inventory(current) {
    const [equipment, badge, heroes] = await Promise.all([
      client.request('EquipsRequest', {}, 'EquipsResponse', 12000, current),
      client.request('BadgesRequest', {}, 'BadgesResponse', 12000, current),
      client.request('AllHeroRequest', {}, 'AllHeroResponse', 12000, current),
    ]);
    if (!Array.isArray(equipment?.equip)) throw Error('未能读取装备仓库');
    if (!Array.isArray(badge?.badge)) throw Error('未能读取徽章仓库');
    if (!Array.isArray(heroes?.heroes)) throw Error('未能读取英雄装备归属');
    return { equips: equipment.equip, badges: badge.badge, heroes: heroes.heroes };
  }

  function equipRow(equip) {
    const definition = equips.get(equip.equipId) ?? {};
    const growth = equipAttr.get(equip.equipId + '|' + String(equip.star)) ?? {};
    const attrs = computeAttrs(equip.attr, tables, names);
    const rating = bestRating(attrs);
    return {
      kind: 'equip', uid: exactAutomationId(equip.uid), id: equip.equipId,
      name: definition.name ?? equip.equipId, type: definition.type ?? '装备', career: '',
      quality: definition.quality ?? '', qualityIndex: Number(definition.qualityIndex ?? 0),
      level: Number(equip.level ?? 0), maxLevel: Number(growth.maxLv ?? 0), star: Number(equip.star ?? 0),
      refineLv: Number(equip.refineLv ?? 0),
      slots: Array.isArray(growth.extraAtts) ? growth.extraAtts.length : 0,
      baseAttrs: computeBase(growth, equip.level, 'equip', tables), attrs,
      pending: computeAttrs(equip.rerollAttrs, tables, names),
      rating, ratingLetter: RATING_LETTERS[rating] ?? '', wornBy: '',
      icon: iconEntry(definition.icon)?.thumb || '',
      rerollable: rerollQualities.has(Number(definition.qualityIndex ?? -1)),
    };
  }

  function badgeRow(badge) {
    const definition = badges.get(badge.badgeId) ?? {};
    const growth = badgeAttr.get(badge.badgeId + '|' + String(badge.star)) ?? {};
    const attrs = badge.attr ? computeAttrs([badge.attr], tables, names) : [];
    const rating = bestRating(attrs);
    return {
      kind: 'badge', uid: exactAutomationId(badge.uid), id: badge.badgeId,
      name: definition.name ?? badge.badgeId, type: '徽章', career: definition.career ?? '',
      quality: definition.quality ?? '', qualityIndex: Number(definition.qualityIndex ?? 0),
      level: Number(badge.level ?? 0), maxLevel: Number(growth.maxLevel ?? 0), star: Number(badge.star ?? 0),
      refineLv: 0, slots: 1,
      baseAttrs: computeBase(growth, badge.level, 'badge', tables), attrs, pending: [],
      rating, ratingLetter: RATING_LETTERS[rating] ?? '', wornBy: '', icon: iconEntry(definition.icon)?.thumb || '',
      rerollable: false,
    };
  }

  function wornBy(heroes) {
    const worn = new Map();
    for (const hero of heroes) {
      const name = hero?.showName || heroNames.get(hero?.heroId) || hero?.heroId || '';
      for (const equip of hero?.equips ?? []) {
        const uid = uidText(equip?.uid);
        if (!uid) throw Error('无法确认装备归属');
        if (worn.has(uid)) throw Error('同一件装备被记到两个英雄名下，请刷新英雄装备');
        worn.set(uid, name);
      }
      for (const badge of hero?.badges ?? []) {
        const uid = uidText(badge?.uid);
        if (uid && !worn.has(uid)) worn.set(uid, name);
      }
    }
    return worn;
  }

  async function read(schedule, current) {
    const state = await schedule(async () => {
      current();
      const value = await inventory(current);
      const counts = await materials(current);
      current();
      return { ...value, counts };
    });
    current();
    const worn = wornBy(state.heroes);
    const list = [...state.equips.map(equipRow), ...state.badges.map(badgeRow)];
    for (const row of list) {
      row.wornBy = worn.get(row.uid) ?? '';
      row.firstSeen = 0;
    }
    if (accountId) syncItems(accountId, list);
    return { rows: list, materials: state.counts, hint: '' };
  }

  async function materials(current) {
    const bag = await client.request('AllItemRequest', {}, 'AllItemResponse', 10000, current);
    const counts = {};
    for (const name of REROLL_MATERIALS) counts[name] = 0;
    for (const item of bag?.items ?? []) {
      if (REROLL_MATERIALS.includes(item?.itemId)) counts[item.itemId] = Number(exactAutomationId(item.num) ?? 0);
    }
    return counts;
  }

  /** 洗炼一次并回读结果：结果挂在装备的 pending 上，等保存或放弃。 */
  async function reroll({ uid, specAttrs = [], lockedSlots = [] }, schedule, current) {
    const target = exactAutomationId(uid);
    if (!target) throw Error('请选择要洗炼的装备');
    if (!Array.isArray(lockedSlots) || lockedSlots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 2)) {
      throw Error('锁定的词条位置无效');
    }
    if (!Array.isArray(specAttrs) || specAttrs.some(name => typeof name !== 'string')) throw Error('指定属性无效');
    return schedule(async () => {
      current();
      const before = await materials(current);
      await client.sendWatch('EquipRerollAttrRequest', {
        uid: wireUid(target), specAttrs, lockedSlots,
      }, { window: 900 });
      current();
      const state = await inventory(current);
      const equip = state.equips.find(row => exactAutomationId(row.uid) === target);
      if (!equip) throw Error('洗炼后没有读回这件装备');
      if (!rerollQualities.has(Number(equips.get(equip.equipId)?.qualityIndex ?? -1))) throw Error('只有橙装和红装能洗炼');
      const row = equipRow(equip);
      if (!row.pending.length) throw Error('没有等到洗炼结果，请刷新后重试');
      return { equip: row, materials: { before, after: await materials(current) } };
    });
  }

  async function decide({ uid, save }, schedule, current) {
    const target = exactAutomationId(uid);
    if (!target) throw Error('请选择要洗炼的装备');
    if (typeof save !== 'boolean') throw Error('需要明确保存或放弃');
    return schedule(async () => {
      current();
      await client.sendWatch('SaveEquipRerollRequest', { uid: wireUid(target), saveOrNot: save }, { window: 900 });
      current();
      const state = await inventory(current);
      const equip = state.equips.find(row => exactAutomationId(row.uid) === target);
      if (!equip) throw Error('保存后没有读回这件装备');
      const row = equipRow(equip);
      if (save && row.pending.length) throw Error('服务端未确认保存，请刷新后重试');
      return { equip: row };
    });
  }

  return { read, reroll, decide, materials };
}
