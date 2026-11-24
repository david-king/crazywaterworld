import { planBaseAutomation } from './base-automation.mjs';
import { museumExploreFactor, museumStar, museumTargetDrops } from './museum-exploration.mjs';
import { museumBoothAdvice } from './museum-display.mjs';
import { normalize } from './worlds.mjs';
import { RESOURCE } from './config.mjs';

const rows = (cfg, name) => cfg.tables?.[name]?.data ?? [];
const grades = ['', 'D', 'C', 'B', 'A', 'S'];

function gradeOdds(config, stage, star, count) {
  if (!Number.isInteger(count) || star == null) return '';
  const reward = rows(config, 'MuseumExpeditionRewardCfg').find(r => r.stageId === stage.stageId && r.star === star);
  const condition = rows(config, 'MuseumExpeditionConditionCfg').find(r => r.conditionId === stage.expedition?.conditionId);
  const score = reward?.baseEvalScore + count * condition?.heroEvalScore;
  const tier = rows(config, 'MuseumExpeditionEvalCfg').filter(r => r.evalScore <= score).sort((a,b) => b.evalScore - a.evalScore)[0];
  if (!tier || !tier.evalWeights?.length || tier.evalWeights.length !== tier.evalTiers?.length) return '';
  const total = tier.evalWeights.reduce((sum, value) => sum + value, 0);
  return total > 0 ? tier.evalTiers.map((grade, i) => grades[grade] + ' ' + +(100 * tier.evalWeights[i] / total).toFixed(1) + '%').join(' · ') : '';
}

export function museumPreview(snapshot, antiques, config, settings, usage) {
  const plan = planBaseAutomation(snapshot, config, settings, usage), { museum, now, world } = snapshot;
  const pref = settings.museum, targets = pref.targetFragments ?? [];
  const heroNames = new Map(rows(config, 'HeroCfg').map(h => [h.id, h.showName || h.name || h.id]));
  const maps = [], drops = [];
  const nameOf = id => config.materialName?.(id) || id;
  for (const map of rows(config, 'MuseumExpeditionStageCfg')) {
    const stage = museum.exploreStages?.find(s => s.stageId === map.stageId);
    const star = museumStar(config, stage?.progress);
    const [area, level] = map.areaLevelReq ?? [];
    const unlocked = !area || museum.exhibitions?.some(ex => ex.exhibitionId === area && ex.level >= level);
    const blocked = unlocked ? '' : `需要展区 ${area} 达到 ${level} 级`;
    const step = plan.actions.find(a => a.kind === 'museumStart' && a.body.stageId === map.stageId);
    const trip = stage?.expedition, active = trip?.endTime > 0;
    let status;
    if (active) status = trip.endTime <= now ? '到期待领取' : '探险中';
    else if (blocked) status = blocked;
    else if (!stage) status = '服务端尚未开放此地图';
    else if (!settings.loop.world || !pref.runEnabled || !pref.enabled) status = '自动探宝已暂停';
    else if (pref.maps.length && !pref.maps.includes(String(map.stageId))) status = '未勾选此地图';
    else if (targets.length && (star == null || !museumTargetDrops(config, map.stageId, star, targets).length)) status = '当前星级无已确认的目标掉落';
    else if (step) status = '本轮拟派遣';
    else status = plan.notesBySetting['museum.enabled']?.find(note => note.startsWith('地图 '+map.stageId+'：') || note.startsWith('派遣地图 '+map.stageId+'，'))
      ?? '本轮没有可用队伍或已达到派遣上限';
    let costs = step?.costs ?? [];
    if (stage && !active && !step && status.includes('材料不足')) {
      const quote = museumExploreFactor(stage, snapshot, config, settings);
      costs = quote.costs.map(c => ({ id: c.id, num: c.num * quote.factor }));
      const missing = costs.filter(c => c.num > (world.stock.get(c.id) ?? 0));
      if (missing.length) status = '缺' + missing.map(c => nameOf(c.id)+' ×'+(c.num - (world.stock.get(c.id) ?? 0))).join('、');
    }
    const ids = step?.body.heroIds ?? (active ? trip.heroIds ?? [] : []);
    maps.push({ name: map.name, star, status, heroes: ids.map(id => heroNames.get(id) ?? id),
      recommended: step?.recommendedCount ?? null, factor: step?.body.factor ?? (active ? trip.factor : null),
      odds: step ? gradeOdds(config, stage, star, step.recommendedCount) : '',
      costs: costs.map(c => ({ name: nameOf(c.id), num: c.num })),
      until: active ? trip.endTime : step && map.exploreTime > 0 ? now + map.exploreTime * step.body.factor : null });
    for (const id of targets) {
      const matching = museumTargetDrops(config, map.stageId, null, [id]).sort((a,b) => a.star - b.star);
      if (!matching.length) continue;
      const current = star != null && matching.some(row => row.star === star);
      const next = matching.find(row => star == null || row.star >= star);
      const threshold = rows(config, 'MuseumStageStarCfg').find(r => r.star === next?.star)?.exploreValue;
      const remaining = stage && Number.isSafeInteger(threshold) ? Math.max(0, threshold - stage.progress) : null;
      drops.push({ item: nameOf(id), map: map.name, first: matching[0].star, status: blocked || (!stage ? '地图未开放' : current ? '当前可掉落' :
        remaining != null ? `距 ${next.star} 星还差 ${remaining} 进度` : '当前星级无已确认掉落') });
    }
  }
  const display = museumBoothAdvice(museum, antiques ?? [], config, world.stock);
  if (!antiques) display.notes.push('藏品清单未同步，暂无法估算摆放收益');
  return { maps, drops, display, actions: plan.actions.filter(a => a.setting.startsWith('museum.')),
    notes: [...(plan.notesBySetting.museum ?? []), ...Object.entries(plan.notesBySetting).filter(([k]) => k.startsWith('museum.')).flatMap(([,v]) => v), ...display.notes] };
}

export async function readMuseumPreview(client, config, player, settings, usage, check = () => {}) {
  const get = async name => {
    check();
    const reply = await client.request(name+'Request', {}, name+'Response', 8000);
    check();
    return normalize(reply);
  };
  const museum = await get('MuseumInfo');
  if (!Array.isArray(museum?.exploreStages) || !Array.isArray(museum.exhibitions)) throw new Error('博物馆状态尚未完整同步');
  const heroes = (await get('AllHero'))?.heroes;
  const items = (await get('AllItem'))?.items, resources = (await get('AllResource'))?.list;
  if (!Array.isArray(heroes) || !Array.isArray(items) || !Array.isArray(resources)) throw new Error('英雄或库存清单尚未完整同步');
  const stock = new Map([...items.map(i => [i.itemId, i.num]), ...resources.map(r => [RESOURCE[r.res] ?? String(r.res), r.amount])]);
  const world = { stock, have: id => stock.get(id) ?? 0, buildings: [], factories: [], stockCap: 0 };
  const antiques = (await get('AllAntique').catch(() => null))?.antiques;
  const now = Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
  return museumPreview({ museum, heroes, world, player, now, pets: [], choices: [], raids: [], notes: [] }, antiques, config, settings, usage);
}
