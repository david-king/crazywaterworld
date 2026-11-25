const rows = (config, name) => config?.tables?.[name]?.data ?? [];
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const qualityIndices = { GREEN: 0, BLUE: 1, PURPLE: 2, ORANGE: 3, RED: 4 };

// Offline client evidence: BuildTeamPop._heroMatchCondition adds exclusive
// stars to hero stars and checks quality, career and faction. Matching grants
// heroEvalScore; it is a recommendation, not a requirement for dispatch.
function recommendationKnown(condition) {
  return integer(condition?.heroStar) && integer(condition?.heroQualityIndex)
    && typeof condition?.careerLimit === 'string' && typeof condition?.factionLimit === 'string';
}

function heroQuality(heroConfig) {
  const quality = qualityIndices[heroConfig?.quality] ?? heroConfig?.qualityIndex;
  return integer(quality) ? quality : null;
}

function heroStars(hero) {
  const star = hero?.star ?? 0, exclusiveStar = hero?.exclusive?.star ?? 0;
  return integer(star) && integer(exclusiveStar) ? star + exclusiveStar : null;
}

function heroRecommendationKnown(hero, heroConfig, condition) {
  return recommendationKnown(condition) && heroQuality(heroConfig) !== null && heroStars(hero) !== null
    && (!condition.careerLimit || typeof heroConfig.career === 'string')
    && (!condition.factionLimit || typeof heroConfig.faction === 'string');
}

export function matchesMuseumRecommendation(hero, heroConfig, condition) {
  if (!recommendationKnown(condition) || !heroConfig) return false;
  const stars = heroStars(hero), quality = heroQuality(heroConfig);
  return stars !== null && quality !== null
    && stars >= condition.heroStar && quality >= condition.heroQualityIndex
    && (!condition.careerLimit || heroConfig.career === condition.careerLimit)
    && (!condition.factionLimit || heroConfig.faction === condition.factionLimit);
}

// Keep recommended heroes in power order. Fill spare slots with lower-quality,
// lower-star heroes so other maps can use the more demanding recommendations.
// Callers include both active expeditions and unconfirmed/planned dispatches
// in busyHeroIds so a hero cannot be allocated twice in the same round.
function museumCandidates(stage, heroes, config, busyHeroIds) {
  const conditions = rows(config, 'MuseumExpeditionConditionCfg')
    .filter(row => row.conditionId === stage.expedition?.conditionId);
  const condition = conditions.length === 1 ? conditions[0] : null;
  const requiredCount = integer(condition?.heroCount, 1) ? condition.heroCount : 0;
  const result = { heroIds: [], requiredCount, recommendedCount: 0, allRecommended: false,
    conditionKnown: requiredCount > 0, recommendationKnown: recommendationKnown(condition), ready: false, reason: '' };
  if (!requiredCount) return { ...result, reason: '未确认本次探险所需英雄人数' };
  if (!Array.isArray(heroes)) return { ...result, reason: '未取得完整英雄名单' };
  const seen = new Set(), busy = new Set(busyHeroIds), candidates = [];
  for (const hero of heroes) {
    if (typeof hero?.heroId !== 'string' || !hero.heroId || seen.has(hero.heroId))
      return { ...result, reason: '英雄名单含重复或缺失编号' };
    seen.add(hero.heroId);
    if (busy.has(hero.heroId)) continue;
    const configs = rows(config, 'HeroCfg').filter(row => row.id === hero.heroId);
    const heroConfig = configs.length === 1 ? configs[0] : null;
    candidates.push({ heroId: hero.heroId,
      recommendationKnown: heroRecommendationKnown(hero, heroConfig, condition),
      recommended: matchesMuseumRecommendation(hero, heroConfig, condition),
      quality: heroQuality(heroConfig) ?? Infinity, stars: heroStars(hero) ?? Infinity,
      power: Number.isFinite(hero.power) && hero.power >= 0 ? hero.power : 0 });
  }
  candidates.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (!a.recommended && a.quality !== b.quality) return a.quality - b.quality;
    if (!a.recommended && a.stars !== b.stars) return a.stars - b.stars;
    return b.power - a.power || a.heroId.localeCompare(b.heroId);
  });
  return { ...result, candidates };
}

function selectedTeam(pool, selected) {
  const { candidates, ...result } = pool;
  if (!candidates) return result;
  const { requiredCount } = result;
  result.heroIds = selected.map(hero => hero.heroId);
  result.recommendedCount = selected.filter(hero => hero.recommended).length;
  result.ready = selected.length === requiredCount;
  result.allRecommended = result.ready && result.recommendedCount === requiredCount;
  // A full confirmed recommended team is enough. Otherwise missing hero
  // metadata must not be confused with a confirmed zero-recommendation team.
  result.recommendationKnown = result.recommendationKnown
    && (result.allRecommended || candidates.every(hero => hero.recommendationKnown));
  if (!result.ready) result.reason = '没有足够的空闲英雄';
  return result;
}

export function selectMuseumHeroes(stage, heroes, config, busyHeroIds = new Set()) {
  const pool = museumCandidates(stage, heroes, config, busyHeroIds);
  return selectedTeam(pool, pool.candidates?.slice(0, pool.requiredCount) ?? []);
}

// Match one recommended hero per map before filling the other slots. An
// augmenting path can move a flexible hero to free a specialist for another map.
export function allocateMuseumTeams(stages, snapshot, config, settings, busy, limit, available) {
  if (limit < 2 || stages.length < 2 || settings.museum.factorMode !== 'recommended') return new Map();
  const pools = stages.map(stage => museumCandidates(stage, snapshot.heroes, config, busy));
  const eligible = pools.map((pool, index) => ({ pool, index })).filter(({pool}) =>
    pool.requiredCount && pool.candidates?.length >= pool.requiredCount);
  let best = { teams: new Map(), full: 0, recommended: 0 };
  function evaluate(group) {
    const slots = group.map(({pool, index}) => Array.from({ length: pool.requiredCount }, () => ({ pool, index })));
    const assigned = new Map(), used = new Map();
    function match(slot, seen) {
      for (const hero of slot.pool.candidates) {
        if (!hero.recommended || seen.has(hero.heroId)) continue;
        seen.add(hero.heroId);
        const old = used.get(hero.heroId);
        if (old && !match(old, seen)) continue;
        assigned.set(slot, hero); used.set(hero.heroId, slot);
        return true;
      }
      return false;
    }
    for (const team of slots) match(team[0], new Set());
    for (const team of slots) for (const slot of team.slice(1)) match(slot, new Set());
    const teams = new Map(), totals = new Map();
    let full = 0, recommended = 0;
    for (const team of slots) {
      const { index, pool } = team[0], stage = stages[index];
      const selected = [];
      for (const slot of team) {
        const hero = assigned.get(slot) ?? pool.candidates.find(h => !used.has(h.heroId));
        if (!hero) return;
        selected.push(hero); used.set(hero.heroId, slot);
      }
      const result = selectedTeam(pool, selected), { factor, costs } = museumExploreFactor(stage, snapshot, config, settings, result);
      if (!factor || !costs.length) return;
      for (const cost of costs) {
        if (typeof cost.id !== 'string' || !integer(cost.num, 1)) return;
        const total = (totals.get(cost.id) ?? 0) + factor * cost.num;
        if (total > available(cost.id)) return;
        totals.set(cost.id, total);
      }
      teams.set(stage.stageId, result);
      full += Number(result.allRecommended); recommended += result.recommendedCount;
    }
    if (teams.size > best.teams.size || teams.size === best.teams.size &&
      (full > best.full || full === best.full && recommended > best.recommended)) best = { teams, full, recommended };
  }
  function visit(group, from) {
    if (group.length >= 2) evaluate(group);
    if (group.length >= limit) return;
    for (let i = from; i < eligible.length; i++) visit([...group, eligible[i]], i + 1);
  }
  visit([], 0);
  return best.teams;
}

export function museumStar(config, progress) {
  const thresholds = rows(config, 'MuseumStageStarCfg');
  if (!integer(progress) || !thresholds.length) return null;
  return Math.max(0, ...thresholds.filter(row => row.exploreValue <= progress).map(row => row.star));
}

export function museumTargetDrops(config, stageId, star, targets) {
  return rows(config, 'MuseumExpeditionRewardCfg').filter(row => row.stageId === stageId && (star == null || row.star === star)
    && row.randomRewards?.some(([id, count], index) => count > 0 && row.randomRewardWeights?.[index] > 0 && targets.includes(id)));
}

// The client unlocks the listed factors at their configured player levels.
// Keep the discrete values: Math.min(selected, maximum) could invent an
// unavailable intermediate factor when the table contains a gap.
export function availableMuseumFactors(config, playerLevel) {
  if (!integer(playerLevel)) return [];
  return [...new Set(rows(config, 'MuseumExploreTimeFactorCfg')
    .filter(row => integer(row.factor, 1) && integer(row.playerLevel) && row.playerLevel <= playerLevel)
    .map(row => row.factor))].sort((a, b) => a - b);
}

export function museumExploreFactor(stage, snapshot, config, settings, team) {
  const preference = settings.museum, mode = preference.factorMode ?? 'materials';
  const assets = stage.expedition?.cost?.asset;
  const costs = Array.isArray(assets) ? assets.map(item => Array.isArray(item)
    ? { id: item[0], num: Number(item[1]) } : { id: item?.id, num: Number(item?.num) }) : [];
  const have = id => typeof snapshot.world?.have === 'function' ? snapshot.world.have(id)
    : snapshot.world?.stock?.get(id) ?? 0;
  const matched = mode === 'materials' && !!preference.materialFactor && costs.some(item =>
    (preference.factorMaterials ?? []).includes(item.id) || (preference.stockThreshold > 0 && have(item.id) <= preference.stockThreshold));
  let selected = matched ? preference.matchedFactor : preference.factor;
  if (mode === 'recommended') {
    const busy = new Set((snapshot.museum?.exploreStages ?? [])
      .filter(item => item.expedition?.endTime > 0).flatMap(item => item.expedition.heroIds ?? []));
    const selectedTeam = team ?? selectMuseumHeroes(stage, snapshot.heroes, config, busy);
    if (!selectedTeam.ready) return { mode, factor: 0, matched: false, costs,
      reason: selectedTeam.reason || '没有足够的空闲英雄' };
    if (!selectedTeam.recommendationKnown) return { mode, factor: 0, matched: false, costs,
      reason: '未确认推荐英雄条件或英雄资料，等待同步后再派遣' };
    // These user-selected factors are tool settings, not a game-defined
    // mapping from recommendation score to duration or rewards.
    if (selectedTeam.allRecommended) selected = preference.fullRecommendedFactor ?? 3;
    else if (selectedTeam.recommendedCount > 0) selected = preference.partialRecommendedFactor ?? 2;
    else if (preference.noRecommendedFallback === true) selected = preference.noRecommendedFactor ?? 1;
    else return { mode, factor: 0, matched: false, costs, reason: '没有可用的推荐英雄，已关闭无推荐英雄时兜底' };
  } else if (mode !== 'materials') {
    return { mode, factor: 0, matched: false, costs, reason: '未识别的探宝倍数模式' };
  }
  const factors = availableMuseumFactors(config, snapshot.player?.level);
  const allowed = integer(selected, 1) ? factors.filter(factor => factor <= selected) : [];
  const factor = allowed.length ? allowed[allowed.length - 1] : 0;
  return { mode, factor, matched, costs, reason: factor ? '' : '未确认可用的探宝倍数' };
}
