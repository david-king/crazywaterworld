const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const positive = n => Number.isSafeInteger(n) && n > 0;
export const findMuseumCase = (cases, body) => cases.find(c => c.exhibitionId === body.exhibitionId && c.caseIndex === body.caseIndex);

export function museumCases(museum) {
  if (!Array.isArray(museum?.exhibitions)) throw new Error('博物馆展区状态未完整读取');
  const exhibitions = new Set(), locations = new Set(), displayed = new Set(), cases = [];
  for (const exhibition of museum.exhibitions) {
    if (!integer(exhibition?.exhibitionId, 1) || !integer(exhibition.level, 1) || exhibitions.has(exhibition.exhibitionId) || !Array.isArray(exhibition.cases)) {
      throw new Error('博物馆展区编号、等级或展柜列表无法确认');
    }
    exhibitions.add(exhibition.exhibitionId);
    for (const item of exhibition.cases) {
      const location = exhibition.exhibitionId + ':' + item?.caseIndex;
      if (!integer(item?.caseIndex, 1) || !integer(item.level) || typeof item.unlocked !== 'boolean' || typeof item.antiqueId !== 'string'
        || !integer(item.upgradeFinishTime ?? 0) || locations.has(location)) throw new Error('博物馆展柜状态不完整或重复');
      if (item.antiqueId && displayed.has(item.antiqueId)) throw new Error('博物馆藏品上架位置重复，等待状态同步');
      locations.add(location);
      if (item.antiqueId) displayed.add(item.antiqueId);
      cases.push({ ...item, upgradeFinishTime: item.upgradeFinishTime ?? 0, exhibitionId: exhibition.exhibitionId, areaLevel: exhibition.level });
    }
  }
  return { cases, displayed };
}

export const museumFinishKey = (area, index, time) => ['museum-case-finish', area, index, time].join(':');

function unlocked(booth) {
  return booth?.unlocked === true && positive(booth.level);
}

export function caseWorkObserved(booth, kind) {
  if (!booth) return false;
  return kind === 'museumCaseUnlock' ? positive(booth.upgradeFinishTime) || unlocked(booth)
    : unlocked(booth) && !(booth.upgradeFinishTime > 0);
}

export function planMuseumCaseWork(museum, config, now, cases = museumCases(museum).cases) {
  const actions = [];
  const configs = config.tables?.MuseumDisplayCaseCfg?.data ?? [];
  for (const area of museum.exhibitions) {
    // The client treats an absent row as level zero when its predecessor is already open.
    const firstLevels = configs.filter(c => c.areaId === area.exhibitionId && c.level === 1);
    for (const cfg of firstLevels) {
      const body = { exhibitionId: area.exhibitionId, caseIndex: cfg.displayCaseId };
      const booth = findMuseumCase(cases, body);
      if (!positive(body.caseIndex) || firstLevels.filter(c => c.displayCaseId === body.caseIndex).length !== 1) continue;
      const name = '展区 ' + area.exhibitionId + ' · ' + (cfg.nameParam || body.caseIndex) + ' 号展位';
      const common = { scope: 'base', setting: 'museum.unlockCases', body, response: 'MuseumCaseUpdateResponse' };
      if (booth?.upgradeFinishTime > 0) {
        if ((!booth.unlocked || booth.level === 0) && booth.upgradeFinishTime <= now) {
          actions.push({ ...common, kind: 'museumCaseFinish', request: 'MuseumFinishCaseUpgradeRequest',
            finishTime: booth.upgradeFinishTime, label: name + ' 解锁完工' });
        }
        continue;
      }
      if (booth && (booth.unlocked || booth.level !== 0 || booth.antiqueId)) continue;
      if (!positive(cfg.areaLevelReq) || area.level < cfg.areaLevelReq || !Array.isArray(cfg.prevCaseId)) continue;
      if (cfg.prevCaseId.length) {
        const [index, level] = cfg.prevCaseId;
        const previous = findMuseumCase(cases, { exhibitionId: area.exhibitionId, caseIndex: index });
        if (cfg.prevCaseId.length !== 2 || !positive(level) || !unlocked(previous) || previous.level < level) continue;
      } else if (!booth) continue; // The initial free stand is opened by the game.
      if (!Array.isArray(cfg.costArr) || !cfg.costArr.every(pair => Array.isArray(pair) && pair.length === 2
        && typeof pair[0] === 'string' && pair[0] && pair[0] !== 'RUBY' && positive(pair[1]))
        || new Set(cfg.costArr.map(pair => pair[0])).size !== cfg.costArr.length) continue;
      actions.push({ ...common, kind: 'museumCaseUnlock', request: 'MuseumUpgradeCaseRequest',
        costs: cfg.costArr.map(([id, num]) => ({ id, num })), label: '解锁' + name });
    }
  }
  return actions;
}
