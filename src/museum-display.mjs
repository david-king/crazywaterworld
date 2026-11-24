import { findMuseumCase, museumCases, planMuseumCaseWork } from './museum-cases.mjs';
import { exactAutomationId, AutomationSkip } from './automation-policy.mjs';
import { createPendingOperation } from './pending-operation.mjs';

const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const activeAccounts = new Set();
const REQUEST = 'MuseumExhibitRequest';
const RESPONSE = 'MuseumCaseUpdateResponse';
const settingEnabled = settings => settings?.loop?.world === true && settings.museum?.runEnabled === true && settings.museum?.display === true;

function ownedAntiques(antiques) {
  if (!Array.isArray(antiques)) throw new Error('已拥有藏品列表未完整读取');
  const ids = new Set();
  for (const antique of antiques) {
    if (typeof antique?.id !== 'string' || !antique.id || !integer(antique.star) || ids.has(antique.id)) throw new Error('已拥有藏品标识或星级异常');
    ids.add(antique.id);
  }
  return antiques;
}

function ratedAntiques(antiques, config, notes, excluded = new Set()) {
  return ownedAntiques(antiques).flatMap(antique => {
    if (excluded.has(antique.id)) return [];
    const bases = rows(config, 'AntiqueBaseCfg').filter(row => row.antiqueId === antique.id);
    if (bases.length !== 1 || bases[0].isAntique !== true) return [];
    const base = bases[0], field = { ORANGE: 'orangePopularity', RED: 'redPopularity' }[base.color];
    const popularity = rows(config, 'AntiquePopularityCfg').filter(row => row.star === antique.star);
    if (!field || popularity.length !== 1 || !integer(popularity[0][field], 1)) {
      notes.push((base.showName || antique.id) + '：缺少可靠的人气配置，暂不上架');
      return [];
    }
    return [{ id: antique.id, name: base.showName || antique.id, popularity: popularity[0][field] }];
  }).sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id));
}

// Automatic display fills empty booths. Replacements are preview suggestions only.
export function planMuseumDisplay(museum, antiques, config) {
  const { cases, displayed } = museumCases(museum);
  const notes = [], actions = [];
  const candidates = ratedAntiques(antiques, config, notes, displayed);
  const empty = cases.flatMap(item => {
    if (!item.unlocked || item.level < 1 || item.antiqueId || item.upgradeFinishTime > 0) return [];
    const cfg = rows(config, 'MuseumDisplayCaseCfg').filter(row => row.areaId === item.exhibitionId && row.displayCaseId === item.caseIndex && row.level === item.level);
    if (cfg.length !== 1 || !integer(cfg[0].areaLevelReq, 1) || cfg[0].areaLevelReq > item.areaLevel || !integer(cfg[0].popularityBonus)) {
      notes.push(`展区 ${item.exhibitionId} 展柜 ${item.caseIndex}：配置未确认，暂不上架`);
      return [];
    }
    return [{ ...item, bonus: cfg[0].popularityBonus }];
  }).sort((a, b) => b.bonus - a.bonus || a.exhibitionId - b.exhibitionId || a.caseIndex - b.caseIndex);
  for (let index = 0; index < Math.min(empty.length, candidates.length); index++) {
    const item = empty[index], antique = candidates[index];
    actions.push({ kind: 'museumDisplay', setting: 'museum.display', scope: 'base', request: REQUEST, response: RESPONSE,
      body: { exhibitionId: item.exhibitionId, caseIndex: item.caseIndex, antiqueId: antique.id },
      label: `展区 ${item.exhibitionId} 展柜 ${item.caseIndex} 上架${antique.name}` });
  }
  if (!actions.length && !notes.length) notes.push(empty.length ? '暂无未上架的已激活博物馆藏品' : '暂无已解锁且空闲的空展柜');
  return { actions, notes };
}

export function museumBoothAdvice(museum, antiques, config, stock) {
  const { cases, displayed } = museumCases(museum);
  const notes = [], upgrades = [], placements = [];
  const rated = ratedAntiques(antiques, config, notes);
  const owned = new Map(rated.map(item => [item.id, item]));
  const table = rows(config, 'MuseumDisplayCaseCfg');
  const stands = [];
  const points = (base, bonus) => Math.floor(base * (10000 + bonus) / 10000);
  // The game can offer a position before sending its first case row.
  const offered = planMuseumCaseWork(museum, config, 0, cases).filter(step => step.kind === 'museumCaseUnlock'
    && !findMuseumCase(cases, step.body));
  const newCases = offered.map(({ body }) => ({ ...body, level: 0, unlocked: false, antiqueId: '',
    areaLevel: museum.exhibitions.find(ex => ex.exhibitionId === body.exhibitionId).level }));
  for (const booth of [...cases, ...newCases]) {
    const configs = table.filter(row => row.areaId === booth.exhibitionId && row.displayCaseId === booth.caseIndex);
    const current = configs.find(row => row.level === booth.level), next = configs.find(row => row.level === booth.level + 1);
    const info = next ?? current;
    if (!info) continue;
    const name = `展区 ${booth.exhibitionId} · ${info.nameParam || booth.caseIndex} 号柜`;
    const art = owned.get(booth.antiqueId), bonus = current?.popularityBonus ?? 0;
    if (booth.unlocked && current && !booth.upgradeFinishTime && (!booth.antiqueId || art)) {
      stands.push({ name, bonus, art });
    }
    if (!next) continue;
    const reasons = [];
    if (booth.upgradeFinishTime) reasons.push(booth.unlocked ? '升级中或待完工' : '解锁施工中或待完工');
    if (booth.areaLevel < next.areaLevelReq) reasons.push('需要展区 ' + next.areaLevelReq + ' 级');
    if (next.prevCaseId?.length) {
      const [id, level] = next.prevCaseId;
      const prev = cases.find(item => item.exhibitionId === booth.exhibitionId && item.caseIndex === id);
      const prevName = table.find(row => row.areaId === booth.exhibitionId && row.displayCaseId === id)?.nameParam || id;
      if (!prev?.unlocked || prev.level < level) reasons.push(`前置展柜 ${prevName} 需要 ${level} 级`);
    }
    const costs = (next.costArr ?? []).map(([id, num]) => ({ name: config.materialName?.(id) || id, num, missing: Math.max(0, num - (stock.get(id) ?? 0)) }));
    if (costs.some(row => row.missing)) reasons.push('缺' + costs.filter(row => row.missing).map(row => row.name + ' ×' + row.missing).join('、'));
    upgrades.push({ name, level: next.level, costs, reason: reasons.join('；') || (booth.unlocked ? '可以升级' : '可以解锁'),
      bonusChange: (next.popularityBonus - bonus) / 100, gain: art ? points(art.popularity, next.popularityBonus) - points(art.popularity, bonus) : booth.antiqueId ? null : 0 });
  }
  const bestUnused = rated.find(item => !displayed.has(item.id));
  for (const [index, stand] of stands.entries()) {
    const base = stand.art?.popularity ?? 0;
    const better = bestUnused?.popularity > base ? bestUnused : null;
    if (better) placements.push({ name: stand.name, from: stand.art?.name || '空柜', to: better.name,
      gain: points(better.popularity, stand.bonus) - points(base, stand.bonus) });
    for (const other of stands.slice(index + 1)) {
      const second = other.art?.popularity ?? 0;
      const gain = points(second, stand.bonus) + points(base, other.bonus) - points(base, stand.bonus) - points(second, other.bonus);
      if (gain > 0) placements.push({ name: stand.name + ' ↔ ' + other.name, from: stand.art?.name || '空柜', to: other.art?.name || '空柜', gain });
    }
  }
  // Only the best single change: alternatives may use the same exhibit twice.
  placements.sort((a, b) => b.gain - a.gain);
  return { upgrades, placement: placements[0] ?? null, notes };
}

function actor(player) {
  const playerId = exactAutomationId(player?.playerId), worldId = exactAutomationId(player?.worldId);
  if (!playerId || !worldId) throw new Error('无法确认博物馆上架账号与区服');
  return worldId + ':' + playerId;
}

function displayedAt(museum, details) {
  const { cases } = museumCases(museum);
  return cases.some(item => item.exhibitionId === details.exhibitionId && item.caseIndex === details.caseIndex && item.antiqueId === details.antiqueId);
}

export async function runMuseumDisplay(client, protocol, config, { player, getSettings, ledger, enabled = () => true, report } = {}) {
  const entries = [];
  const emit = entry => { const row = { key: 'museum.display', setting: 'museum.display', label: '自动上架展品', ...entry }; entries.push(row); report?.(row); };
  if (!enabled() || !settingEnabled(getSettings?.())) return entries;
  let account, operation, locked = false;
  try {
    account = actor(player);
    if (activeAccounts.has(account)) { emit({ skipped: true, reason: '正在核对博物馆上架结果' }); return entries; }
    activeAccounts.add(account); locked = true;
    if (!ledger?.keyRecords || !ledger?.resolveKey || !ledger?.releaseCompletedKey || !ledger?.reserve) throw new Error('缺少持久上架记录，暂不上架');
    const initialSettings = getSettings(), socket = client.socket, epoch = client.connectionEpoch;
    const check = () => {
      if (!enabled() || !settingEnabled(getSettings()) || getSettings() !== initialSettings || client.connected === false
        || client.socket !== socket || client.connectionEpoch !== epoch || actor(player) !== account) throw new AutomationSkip('上架已暂停，或设置、账号、连接已变化');
    };
    const get = async (request, body = {}, response = request.replace(/Request$/, 'Response')) => {
      check();
      if (!protocol?.[request] || !protocol?.[response]) throw new Error('当前协议缺少' + request + '或回执');
      const value = await client.request(request, body, response, 8000);
      check();
      return value;
    };
    if (!protocol?.[REQUEST] || !protocol?.[RESPONSE]) throw new Error('当前协议不支持完整确认博物馆上架');
    const buildingRows = rows(config, 'BuildingUnlockCfg').filter(row => row.buildingType === '博物馆');
    if (buildingRows.length !== 1 || !buildingRows[0].buildingId || !integer(buildingRows[0].playerLevel, 1) || !integer(player.level, 1)) throw new Error('博物馆开放配置或角色等级未确认');
    if (player.level < buildingRows[0].playerLevel) { emit({ skipped: true, reason: `角色 ${buildingRows[0].playerLevel} 级开放博物馆` }); return entries; }
    const read = async () => {
      const water = await get('OnWaterRequest');
      if (!Array.isArray(water?.building)) throw new Error('博物馆建筑状态未完整读取');
      const buildings = water.building.filter(row => row.buildingId === buildingRows[0].buildingId);
      if (buildings.length !== 1 || !integer(buildings[0].level, 1) || (buildings[0].buildFinishTime ?? 0) > 0) throw new AutomationSkip('博物馆尚未建成，暂不上架');
      const inventory = await get('AllAntiqueRequest');
      ownedAntiques(inventory?.antiques);
      // Read cases last so the target vacancy and all existing placements are
      // checked after inventory, immediately before reserving the operation.
      const museum = await get('MuseumInfoRequest');
      museumCases(museum);
      return { museum, antiques: inventory.antiques };
    };
    const prefix = 'museumDisplay:' + account + ':';
    const reconcile = museum => {
      for (const [key, record] of Object.entries(ledger.keyRecords())) {
        if (!key.startsWith(prefix)) continue;
        if (record.confirmed) { ledger.releaseCompletedKey(key); continue; }
        if (record.details && displayedAt(museum, record.details)) {
          ledger.resolveKey(key, true);
          ledger.releaseCompletedKey(key);
          emit({ ok: true, status: 'confirmed', reason: '已从服务器展柜状态确认上次上架' });
        }
      }
      return Object.entries(ledger.keyRecords()).some(([key, record]) => key.startsWith(prefix) && !record.confirmed);
    };
    const initial = await read();
    if (reconcile(initial.museum)) { emit({ skipped: true, status: 'pending', reason: '上次上架结果尚未确认，暂不重复上架或移动藏品' }); return entries; }
    const initialPlan = planMuseumDisplay(initial.museum, initial.antiques, config);
    for (const reason of initialPlan.notes) emit({ skipped: true, reason });
    for (let index = 0; index < Math.min(initialPlan.actions.length, 20); index++) {
      const fresh = await read();
      if (reconcile(fresh.museum)) break;
      const step = planMuseumDisplay(fresh.museum, fresh.antiques, config).actions[0];
      if (!step) break;
      check();
      const uniqueKey = prefix + step.body.exhibitionId + ':' + step.body.caseIndex;
      operation = createPendingOperation(ledger, { client, module: 'museum.display', request: REQUEST, label: step.label });
      operation.reserve({}, {}, {}, { uniqueKey, details: { kind: 'museumDisplay', ...step.body } });
      try { check(); } catch (error) { operation.cancel(); throw error; }
      const reply = await operation.send(() => client.request(REQUEST, step.body, RESPONSE, 8000));
      check();
      const matching = Array.isArray(reply?.cases) ? reply.cases.filter(item => item.caseIndex === step.body.caseIndex) : [];
      if (matching.length !== 1 || matching[0].antiqueId !== step.body.antiqueId) throw new Error('服务器上架回执未确认目标展柜与藏品');
      const after = await get('MuseumInfoRequest');
      if (!displayedAt(after, step.body)) throw new Error('上架后的展柜状态尚未同步');
      const operationId = operation.operationId;
      operation.confirm(); operation = null;
      ledger.releaseCompletedKey(uniqueKey);
      emit({ step, label: step.label, ok: true, status: 'confirmed', operationId });
    }
  } catch (error) {
    const failure = operation?.fail(error);
    emit({ ok: false, operationId: operation?.operationId, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}),
      status: failure?.pending ? 'pending' : 'waiting', reason: error.message, error: error.message });
  } finally {
    if (locked) activeAccounts.delete(account);
  }
  return entries;
}
