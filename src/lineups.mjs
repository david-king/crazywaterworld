import { createHash } from 'node:crypto';
import { toNumber } from './client.mjs';
import { isFleetReserved } from './fleet-reservations.mjs';
import { uidText, wireUid } from './hero-equipment.mjs';
import { describeLineupHeroes, describePets, formationSignature as fullSignature, getLineupCatalog, normalizeFormation, readLineupEditor, validateEditorFormation } from './saved-lineups.mjs';
import { tournamentRunning } from './tournament-state.mjs';

const mainlineModule = 1;
const defaultPreset = 1;
const fleetType = '远征船';
const careers = ['坦克', '战士', '法师', '射手'];
const shownRecommended = 3;
const shownNear = 3;
const nearGap = 2;
const rows = (config, table) => config?.tables?.[table]?.data ?? [];

// The strategy table labels lineups for broad situations, never for a game mode.
// These tiers are this tool's reading of those labels; the page says so.
const categoryOf = label => /世界BOSS/i.test(label) ? 'boss' : /PVP|巅峰赛|城战|克制/i.test(label) ? 'pvp' : /二队/.test(label) ? 'second' : 'general';
const tierTables = {
  mainline: () => ({ general: 0, pvp: 1, second: 1, boss: 2 }),
  fleet: later => later ? { second: 0, general: 1, pvp: 1, boss: 1 } : { general: 0, pvp: 0, boss: 1, second: 1 },
  expedition: () => ({ general: 0, pvp: 1, second: 1, boss: 2 }),
  league: later => later ? { second: 0, pvp: 1, general: 1, boss: 2 } : { pvp: 0, general: 1, second: 2, boss: 3 },
};

function presetSlots(config) {
  const slots = new Map();
  for (const row of rows(config, 'FormationTypePositionCfg')) {
    if (!slots.has(row.id)) slots.set(row.id, []);
    slots.get(row.id).push(row.position);
  }
  return slots;
}

function parseStance(value) {
  const [x, y, ...rest] = String(value).split(',').map(Number);
  return rest.length || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ? null : { x, y };
}

// A few table rows name a seat their preset does not have. Those are dropped, not repaired.
export function lineupCatalog(config) {
  const known = new Set(rows(config, 'HeroCfg').map(h => h.id));
  const slots = presetSlots(config);
  const lineups = new Map();
  for (const form of rows(config, 'HeroStrategyFormationCfg')) {
    const heroes = (form.heros ?? []).map(h => h?.[0]);
    const roles = (form.heroPos ?? []).map(r => r?.[0] ?? '');
    const seats = (form.heroStance ?? []).map(s => parseStance(s?.[0]));
    const allowed = new Set((slots.get(form.formId) ?? []).map(p => p.join(',')));
    const seatKeys = seats.map(s => s && s.x + ',' + s.y);
    if (!heroes.length || seats.length !== heroes.length || !heroes.every(h => known.has(h))
      || new Set(heroes).size !== heroes.length || new Set(seatKeys).size !== seats.length
      || !seatKeys.every(s => allowed.has(s))) continue;
    const members = heroes.map((heroId, i) => ({ heroId, role: roles[i], ...seats[i] }));
    const key = JSON.stringify([form.formId, [...members].sort((a, b) => a.heroId.localeCompare(b.heroId)).map(m => [m.heroId, m.x, m.y])]);
    const found = lineups.get(key);
    if (found) {
      if (!found.labels.includes(form.formInfo)) found.labels.push(form.formInfo);
      continue;
    }
    lineups.set(key, { presetId: form.formId, labels: [form.formInfo], pet: form.pet || '', members });
  }
  return [...lineups.values()];
}

function presetName(config, presetId) {
  if (presetId === defaultPreset) return '基础阵型';
  return rows(config, 'FormationTypeUnlockCfg').find(r => r.id === presetId)?.name ?? '阵型 ' + presetId;
}

function formationSignature(formation) {
  return [formation?.presetId ?? 0, (formation?.heroPositions ?? []).map(p => [p.heroId, p.pos?.x, p.pos?.y])
    .sort((a, b) => a[0].localeCompare(b[0]))];
}

// Rearranges the same heroes the way the client does when a preset is switched.
function defaultSeats(config, members) {
  const career = new Map(rows(config, 'HeroCfg').map(h => [h.id, h.career]));
  const slots = (presetSlots(config).get(defaultPreset) ?? []).slice().sort((a, b) => b[0] - a[0]);
  if (slots.length < members.length) return null;
  return [...members].sort((a, b) => careers.indexOf(career.get(a.heroId)) - careers.indexOf(career.get(b.heroId)) || a.heroId.localeCompare(b.heroId))
    .map((member, i) => ({ ...member, x: slots[i][0], y: slots[i][1] }));
}

function resolveGuideFormation(config, lineup, unlocked) {
  const locked = lineup.presetId !== defaultPreset && !unlocked.has(lineup.presetId);
  const seats = locked ? defaultSeats(config, lineup.members) : lineup.members;
  if (!seats) return null;
  return {
    presetId: locked ? defaultPreset : lineup.presetId,
    heroPositions: seats.map(s => ({ heroId: s.heroId, pos: { x: s.x, y: s.y } })),
    note: locked ? presetName(config, lineup.presetId) + '尚未解锁，使用基础阵型站位' : '',
  };
}

function recommend(target, { config, catalog, roster, names, unlocked, capacity }) {
  const tiers = tierTables[target.mode](target.later);
  const power = id => roster.get(id)?.power ?? 0;
  const currentPositions = target.current?.heroPositions ?? [];
  const currentPower = currentPositions.reduce((sum, p) => sum + power(p.heroId), 0);
  const currentSignature = JSON.stringify(formationSignature(target.current));
  const applicable = [], near = [];
  for (const lineup of catalog) {
    const tier = Math.min(...lineup.labels.map(label => tiers[categoryOf(label)]));
    const missing = lineup.members.filter(m => !roster.has(m.heroId)).map(m => names(m.heroId));
    const blocked = lineup.members.filter(m => roster.has(m.heroId) && target.blocked?.has(m.heroId))
      .map(m => names(m.heroId) + '（' + target.blocked.get(m.heroId) + '）');
    const total = lineup.members.reduce((sum, m) => sum + power(m.heroId), 0);
    const summary = {
      label: lineup.labels.join(' / '), tier, power: total,
      heroes: lineup.members.map(m => ({ heroId: m.heroId, name: names(m.heroId), role: m.role })),
    };
    if (missing.length || blocked.length) {
      if (missing.length + blocked.length <= nearGap) near.push({ ...summary, missing, blocked });
      continue;
    }
    if (lineup.members.length > capacity) continue;
    const resolved = resolveGuideFormation(config, lineup, unlocked);
    if (!resolved) continue;
    const { presetId, heroPositions, note } = resolved;
    const isCurrent = JSON.stringify(formationSignature({ presetId, heroPositions })) === currentSignature;
    applicable.push({
      ...summary, presetId, presetName: presetName(config, presetId), heroPositions, isCurrent,
      delta: total - currentPower, pet: lineup.pet,
      note,
      previewKey: isCurrent ? null : createHash('sha256').update(JSON.stringify([target.key, currentSignature, presetId, heroPositions])).digest('hex'),
    });
  }
  applicable.sort((a, b) => a.tier - b.tier || b.power - a.power);
  near.sort((a, b) => a.missing.length + a.blocked.length - b.missing.length - b.blocked.length || a.tier - b.tier || b.power - a.power);
  const distinctApplicable = mergeLabels(applicable, r => JSON.stringify(formationSignature(r)));
  const distinctNear = mergeLabels(near, r => r.heroes.map(h => h.heroId).sort().join());
  return {
    current: {
      presetName: currentPositions.length ? presetName(config, target.current.presetId) : '',
      power: currentPower,
      heroes: currentPositions.map(p => ({ heroId: p.heroId, name: names(p.heroId) })),
    },
    recommended: distinctApplicable.slice(0, shownRecommended),
    near: distinctNear.slice(0, shownNear),
  };
}

// Different table rows can end up identical once a locked preset falls back to default seats.
function mergeLabels(list, keyOf) {
  const seen = new Map();
  for (const item of list) {
    const key = keyOf(item);
    const found = seen.get(key);
    if (!found) seen.set(key, { ...item, labels: item.label.split(' / ') });
    else for (const label of item.label.split(' / ')) if (!found.labels.includes(label)) found.labels.push(label);
  }
  return [...seen.values()].map(({ labels, ...item }) => ({ ...item, label: labels.join(' / ') }));
}

function matches(formation, recommendation) {
  return JSON.stringify(formationSignature(formation)) === JSON.stringify(formationSignature(recommendation))
    && (recommendation.petUid == null || fullSignature(formation) === fullSignature(recommendation));
}

function withPet(formation, petUid) {
  return petUid == null ? formation : { petUid, ...formation };
}

function failNotice(title) {
  return new Error(title + '未确认这次换阵，请刷新后查看');
}

async function mainlineTarget(client) {
  const { formation } = await client.request('GetFormationRequest', { module: mainlineModule }, 'GetFormationResponse');
  if (!formation) throw new Error('主线阵容尚未同步');
  return {
    key: 'mainline', mode: 'mainline', title: '主线闯关',
    hint: '普通试炼和竞技场防守也使用这套阵容',
    current: formation,
    async save(next, beforeSend) {
      const reply = await client.request('SaveFormationRequest', { module: mainlineModule, formation: withPet(next, formation?.petUid) }, 'SaveFormationResponse', undefined, beforeSend);
      if (!matches(reply.formation, next)) throw failNotice('主线闯关');
    },
  };
}

function moduleLevel(config, moduleId) {
  const level = rows(config, 'ModuleOpenCfg').find(r => r.moduleId === moduleId)?.playerLevel;
  if (!Number.isSafeInteger(level) || level < 1) throw new Error('缺少' + moduleId + '开放等级配置');
  return level;
}

async function fleetTargets(client, config, player) {
  const required = moduleLevel(config, '世界');
  const group = { key: 'fleet', mode: 'fleet', title: '远征舰队' };
  if (!(player?.level >= required)) return [{ ...group, reason: '世界在角色 ' + required + ' 级开放' }];
  const buildings = (await client.request('OnWaterRequest', {}, 'OnWaterResponse')).building;
  if (!Array.isArray(buildings)) throw new Error('无法确认已建成的远征舰队');
  const docks = buildings.filter(b => b.level > 0 && b.buildingId?.endsWith(fleetType))
    .sort((a, b) => a.buildingId.localeCompare(b.buildingId, 'zh-CN', { numeric: true }));
  if (!docks.length) return [{ ...group, reason: '尚未建成远征舰队' }];
  const fleets = (await client.request('MyFleetsRequest', {}, 'MyFleetsResponse')).fleets;
  if (!Array.isArray(fleets)) throw new Error('无法确认世界舰队状态');
  const nameOf = dock => {
    const number = dock.buildingId.match(/^(\d+)/)?.[1];
    return number ? '远征舰队 ' + number + ' 队' : '远征舰队';
  };
  return docks.map((dock, index) => {
    const fleet = fleets.find(f => f.buildingId === dock.buildingId);
    const blocked = new Map();
    for (const other of docks) {
      if (other === dock) continue;
      for (const p of other.fleet?.formation?.heroPositions ?? []) blocked.set(p.heroId, '在' + nameOf(other));
    }
    const busy = fleet && (fleet.state !== 1 || fleet.curGridIdx > 0 || fleet.autoFight?.isOn || uidText(fleet.treasureLootUid) || fleet.chipWar?.rewardTs);
    const title = nameOf(dock);
    return {
      key: 'fleet:' + dock.buildingId, mode: 'fleet', title, later: index > 0, blocked,
      current: dock.fleet?.formation,
      reason: busy ? '舰队正在执行其他任务，返航后才能换阵' : isFleetReserved(client, dock.buildingId) ? '舰队的上次派遣结果未确认，暂不换阵' : '',
      async save(next, beforeSend) {
        await client.sendWatch('FleetSaveFormationRequest', { buildingId: dock.buildingId, formation: next }, { beforeSend });
        const after = (await client.request('OnWaterRequest', {}, 'OnWaterResponse')).building?.find(b => b.buildingId === dock.buildingId);
        if (!matches(after?.fleet?.formation, next)) throw failNotice(title);
      },
    };
  });
}

async function expeditionTargets(client, config, player, roster) {
  const required = moduleLevel(config, '远征');
  const group = { key: 'expedition', mode: 'expedition', title: '远征' };
  if (!(player?.level >= required)) return [{ ...group, reason: '远征在角色 ' + required + ' 级开放' }];
  const info = await client.request('ExpeditionInfoRequest', {}, 'ExpeditionInfoResponse');
  const heroes = info.hero ?? [];
  if (!info.raidId || !heroes.length) return [{ ...group, reason: '本期还没选远征英雄，请先在游戏内开始远征' }];
  const alive = new Set(heroes.filter(h => toNumber(h.hp ?? 0) > 0).map(h => h.heroId));
  const listed = new Set(heroes.map(h => h.heroId));
  const blocked = new Map();
  for (const heroId of roster?.keys() ?? []) {
    if (!listed.has(heroId)) blocked.set(heroId, '不在本次远征名单');
    else if (!alive.has(heroId)) blocked.set(heroId, '已阵亡');
  }
  return [{
    ...group, key: 'expedition:' + info.raidId, blocked, allowedHeroes: [...alive],
    hint: '只能使用本次远征选中且存活的英雄',
    current: info.formation,
    async save(next, beforeSend) {
      const reply = await client.request('ExpeditionSaveFormationRequest', { raidId: info.raidId, formation: withPet(next, info.formation?.petUid) }, 'ExpeditionSaveFormationResponse', undefined, beforeSend);
      if (!matches(reply.formation, next)) throw failNotice('远征');
    },
  }];
}

async function leagueTargets(client, config, player) {
  const required = moduleLevel(config, '跨服积分赛');
  const group = { key: 'league', mode: 'league', title: '跨服积分赛' };
  if (!(player?.level >= required)) return [{ ...group, reason: '跨服积分赛在角色 ' + required + ' 级开放' }];
  const info = await client.request('LeagueInfoRequest', {}, 'LeagueInfoResponse');
  const own = info.ownFormations;
  if (!Array.isArray(own)) throw new Error('积分赛队伍尚未同步');
  const dan = rows(config, 'LeagueDanCfg').find(r => r.dan === (info.roomDan || info.dan));
  const teams = Math.max(dan?.teamCount ?? 0, ...own.map(team => team.index));
  if (!teams) return [{ ...group, reason: '无法确认当前段位的队伍数，请刷新后再试' }];
  return multiTeamTargets(group, indexedTeams(own, teams), async (id, formation, beforeSend) => {
    const reply = await client.request('LeagueSaveFormationRequest', { formation: { ...formation, index: id } }, 'LeagueFormationResponse', undefined, beforeSend);
    return reply.formations?.find(team => team.index === id);
  });
}

function indexedTeams(formations, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1, formation: formations.find(team => team.index === index + 1),
  }));
}

function multiTeamTargets(group, teams, write) {
  return teams.map((team, index) => {
    const blocked = new Map(), blockedPets = new Map();
    for (const [otherIndex, other] of teams.entries()) {
      if (other === team) continue;
      const reason = '在第 ' + (otherIndex + 1) + ' 队';
      for (const slot of other.formation?.heroPositions ?? []) blocked.set(slot.heroId, reason);
      const uid = uidText(other.formation?.petUid);
      if (uid) blockedPets.set(uid, reason);
    }
    const title = group.title + '第 ' + (index + 1) + ' 队';
    return {
      ...group, key: group.key + ':' + team.id, title, later: index > 0,
      current: team.formation, blocked, blockedPets,
      async save(next, beforeSend) {
        const after = await write(team.id, withPet(next, team.formation?.petUid), beforeSend);
        if (!matches(after, next)) throw failNotice(title);
      },
    };
  });
}

async function ultraTargets(client, config, player) {
  const group = { key: 'ultra', mode: 'ultra', title: '极限试炼' };
  const level = moduleLevel(config, group.title);
  if (!(player?.level >= level)) return [{ ...group, reason: level + ' 级开放' }];
  const { raidId } = await client.request('UltraOpenRequest', {}, 'UltraOpenResponse');
  if (!raidId) return [{ ...group, reason: '本期尚未开放' }];
  const { forms } = await client.request('UltraInfoRequest', {}, 'UltraInfoResponse');
  if (!Array.isArray(forms)) throw new Error('极限试炼队伍尚未同步');
  return multiTeamTargets({ ...group, key: 'ultra:' + raidId }, indexedTeams(forms, 3), async (index, formation, beforeSend) => {
    const reply = await client.request('UltraSaveFormationRequest', { formation: { ...formation, index } }, 'UltraFormationResponse', undefined, beforeSend);
    return reply.formations?.find(team => team.index === index);
  });
}

async function tournamentTargets(client, config) {
  const group = { key: 'tournament', mode: 'tournament', title: '巅峰擂台赛' };
  if (!tournamentRunning(client.tournament)) return [{ ...group, reason: '当前未开放参赛布阵' }];
  if (!client.tournament.qualified) return [{ ...group, reason: '本期未取得参赛资格' }];
  const { team } = await client.request('TournamentFormationRequest', {}, 'TournamentFormationResponse');
  if (!team?.length || team.some(slot => !uidText(slot.uid))) throw new Error('擂台赛队伍尚未同步');
  const windowReason = () => {
    const { nextMatchTime, nextMatchTimeId } = client.tournament ?? {};
    const param = ['小组赛第1轮战力固定', '小组赛第2轮战力固定', '小组赛第3轮战力固定'][nextMatchTimeId - 1] ?? '淘汰赛战力固定';
    const lead = rows(config, 'TournamentParamCfg').find(row => row.param === param)?.value;
    if (!nextMatchTime || !Number.isFinite(lead)) return '尚未同步布阵截止时间';
    return Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000) > nextMatchTime - lead ? '本轮布阵已截止' : '';
  };
  return multiTeamTargets({ ...group, reason: windowReason() }, team.map(slot => ({ id: uidText(slot.uid), formation: slot.formation })), async (id, formation, beforeSend) => {
    const reply = await client.request('TournamentSaveFormationRequest', { uid: wireUid(id), formation }, 'TournamentSaveFormationResponse', undefined, () => {
      beforeSend?.();
      const reason = windowReason();
      if (reason || !client.tournament?.qualified || !tournamentRunning(client.tournament)) throw new Error(reason || '当前不可布阵');
    });
    return reply.team?.find(slot => uidText(slot.uid) === id)?.formation;
  });
}

const gameModes = {
  mainline: ['主线闯关', async client => [await mainlineTarget(client)]],
  fleet: ['远征舰队', fleetTargets], expedition: ['远征', expeditionTargets],
  league: ['跨服积分赛', leagueTargets], ultra: ['极限试炼', ultraTargets], tournament: ['巅峰擂台赛', tournamentTargets],
};

async function modeTargets(mode, client, config, player, roster) {
  const [title, read] = gameModes[mode];
  try { return await read(client, config, player, roster); }
  catch (error) { return [{ key: mode, mode, title, reason: '读取失败：' + error.message }]; }
}

function gameTargetView(target, player) {
  const { key, mode, title, reason, hint, allowedHeroes } = target;
  if (!target.save) return { key, mode, title, reason };
  const formation = target.current ? normalizeFormation(target.current, { allowEmpty: true })
    : { presetId: 1, heroPositions: [], petUid: '0' };
  const version = createHash('sha256').update(JSON.stringify([
    uidText(player?.playerId), uidText(player?.worldId), key, fullSignature(formation),
  ])).digest('hex');
  return { key, mode, title, reason, hint, version, formation, allowedHeroes,
    blockedHeroes: Object.fromEntries(target.blocked ?? []), blockedPets: Object.fromEntries(target.blockedPets ?? []) };
}

export async function readGameLineups(client, config, player) {
  const targets = [];
  for (const mode of Object.keys(gameModes)) {
    for (const target of await modeTargets(mode, client, config, player)) {
      try { targets.push(gameTargetView(target, player)); }
      catch (error) { targets.push({ key: target.key, mode, title: target.title, reason: '阵容数据不完整：' + error.message }); }
    }
  }
  // Keep the teams visible if optional portrait or pet details cannot be read.
  const catalog = getLineupCatalog(config);
  let heroes = catalog.heroes, pets = [];
  try {
    const response = await client.request('AllHeroRequest', {}, 'AllHeroResponse');
    heroes = describeLineupHeroes(response.heroes, catalog);
  } catch { /* Use configured names and base portraits. */ }
  if (targets.some(team => team.mode !== 'fleet' && team.formation && team.formation.petUid !== '0')) {
    try {
      const response = await client.request('AllPetRequest', {}, 'AllPetResponse');
      pets = describePets(response.pets, config);
    } catch { /* The detail view still shows the exact assigned UID. */ }
  }
  const modeNames = Object.fromEntries(Object.entries(gameModes).map(([mode, [name]]) => [mode, name]));
  return { targets, catalog: { ...catalog, heroes, pets, modeNames } };
}

export async function applyGameLineup(client, config, player, payload, enabled = () => true) {
  const mode = String(payload.targetKey).split(':')[0];
  if (!Object.hasOwn(gameModes, mode)) throw new Error('找不到这个玩法');
  const editor = await readLineupEditor(client, config, player, { includeMainline: false, includePets: mode !== 'fleet' });
  const formation = validateEditorFormation(payload.formation, editor);
  const targets = await modeTargets(mode, client, config, player, new Map(editor.heroes.map(hero => [hero.heroId, hero])));
  const target = targets.find(team => team.key === payload.targetKey);
  if (!target?.save || target.reason) throw new Error(target?.reason || '队伍已变化，请重新读取游戏阵容');
  if (gameTargetView(target, player).version !== payload.version) throw new Error('游戏阵容已变化，请重新读取后再应用');
  for (const { heroId } of formation.heroPositions) {
    if (target.blocked?.has(heroId)) throw new Error(heroId + '：' + target.blocked.get(heroId));
  }
  if (target.blockedPets?.has(formation.petUid)) throw new Error('所选海兽' + target.blockedPets.get(formation.petUid));
  if (mode === 'fleet' && formation.petUid !== '0') throw new Error('舰队编队不支持更换海兽');
  const next = { presetId: formation.presetId, heroPositions: formation.heroPositions };
  if (mode !== 'fleet') next.petUid = wireUid(formation.petUid);
  const beforeSend = () => { if (!enabled()) throw new Error('账号已暂停或连接已更换'); };
  beforeSend();
  await target.save(next, beforeSend);
  return { targetKey: target.key, label: '已应用到' + target.title };
}

async function loadTargets(client, config, player) {
  const heroes = (await client.request('AllHeroRequest', {}, 'AllHeroResponse')).heroes;
  if (!Array.isArray(heroes)) throw new Error('无法读取英雄列表');
  const presets = (await client.request('MyFormationPresetRequest', {}, 'MyFormationPresetResponse')).ids;
  if (!Array.isArray(presets)) throw new Error('无法读取已解锁的阵型');
  const roster = new Map(heroes.map(h => [h.heroId, { ...h, power: toNumber(h.power ?? 0) }]));
  const configHeroes = new Map(rows(config, 'HeroCfg').map(h => [h.id, h]));
  const names = id => roster.get(id)?.showName || configHeroes.get(id)?.name || id;
  const capacity = rows(config, 'FormationHeroNumCfg').reduce((max, row) =>
    player?.mainlineStage > row.mainlineStage ? Math.max(max, row.heroNum) : max, 0);
  const context = { config, catalog: lineupCatalog(config), roster, names, unlocked: new Set(presets), capacity };

  // One unreadable mode must not hide the others.
  const targets = [];
  for (const mode of Object.keys(tierTables)) targets.push(...await modeTargets(mode, client, config, player, roster));
  return targets.map(target => {
    const shared = { ...target, blocked: undefined, blockedPets: undefined, allowedHeroes: undefined, later: undefined };
    if (!target.save) return { ...shared, recommended: [], near: [], current: null };
    return { ...shared, ...recommend(target, context) };
  });
}

export async function readLineups(client, config, player) {
  const targets = await loadTargets(client, config, player);
  return { targets: targets.map(({ save, ...target }) => target) };
}

// Saved challenge presets use the mainline formation module. The editor has
// already read the roster, unlocked formations and capacity for this account.
export function editorLineupRecommendations(config, editor) {
  const roster = new Map(editor.heroes.map(hero => [hero.heroId, hero]));
  const names = new Map(rows(config, 'HeroCfg').map(hero => [hero.id, hero.name]));
  const unlocked = new Set(editor.formations.filter(type => type.unlocked).map(type => type.presetId));
  return lineupCatalog(config).map(lineup => {
    const resolved = resolveGuideFormation(config, lineup, unlocked);
    const nameOf = id => roster.get(id)?.name || names.get(id) || id;
    const missing = lineup.members.filter(m => !roster.has(m.heroId)).map(m => nameOf(m.heroId));
    const reasons = [];
    if (missing.length) reasons.push('缺少' + missing.join('、'));
    if (lineup.members.length > editor.capacity) reasons.push('需要 ' + lineup.members.length + ' 个上阵名额，当前 ' + editor.capacity + ' 个');
    if (!resolved) reasons.push('尚未解锁该阵型，基础阵型站位不足');
    return {
      label: lineup.labels.join(' / '), heroes: lineup.members.map(m => nameOf(m.heroId)),
      presetName: presetName(config, lineup.presetId), note: resolved?.note || '', reason: reasons.join('。'),
      formation: reasons.length ? null : { presetId: resolved.presetId, heroPositions: resolved.heroPositions },
    };
  }).sort((a, b) => Number(!a.formation) - Number(!b.formation));
}

export async function applyLineup(client, config, player, { targetKey, previewKey, enabled = () => true }) {
  const targets = await loadTargets(client, config, player);
  const target = targets.find(t => t.key === targetKey);
  if (!target?.save) throw new Error(target?.reason || '找不到这个玩法或队伍，请刷新后再试');
  if (target.reason) throw new Error(target.reason);
  const choice = previewKey && target.recommended.find(r => r.previewKey === previewKey);
  if (!choice) throw new Error('阵容或英雄已变化，请刷新后重新选择');
  if (!enabled()) throw new Error('账号已暂停或连接已更换');
  await target.save({ presetId: choice.presetId, heroPositions: choice.heroPositions });
  const list = heroes => heroes.map(h => h.name).join('、') || '无';
  return {
    targetKey,
    label: target.title + '已换成「' + choice.label + '」：' + list(choice.heroes) + '。原阵容：' + list(target.current.heroes),
  };
}
