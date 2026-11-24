export function stepObservation(entry) {
  const label = entry.step?.label || entry.title || entry.label;
  let state = 'ok';
  if (entry.pending || entry.materialsPending || ['unknown', 'pending'].includes(entry.status)) state = 'pending';
  else if (entry.skipped) state = 'waiting';
  else if (!entry.ok) state = 'error';
  else if ('sent' in entry && entry.status !== 'confirmed') state = 'sent';
  const fallback = {ok:'执行成功', sent:'请求已发送', waiting:'已检查', pending:'结果待确认', error:'检查失败'};
  const text = entry.reason || entry.error || entry.note || label || fallback[state];
  return { text, state };
}

// 调度可以合并检查，展示时仍需归到实际执行的建筑或工厂动作。
export const worldObservationKeys = {
  gainFactory: 'factory.gain', collectProduct: 'building.collect',
  speedUpUpgrade: 'building.speedUp', speedUpProduce: 'factory.speedUp',
};

export const runtimeObservationKeys = {
  'heroes.enabled':'loop.heroes', 'weeklyActivity.enabled':'weeklyActivity',
  'factory.produce':'startProduce', 'factory.cooperateNative':'nativeProduce',
  'building.build':'build', 'building.supply':'buildSupply', 'building.upgrade':'upgrade', 'building.finish':'finishUpgrade',
  'resident.enabled':'finishOrder', 'resident.reroll':'denyOrder', 'resident.rewards':'orderDaily',
  'farm.enabled':'farm', 'cargo.enabled':'cargo', 'radar.enabled':'联盟情报', 'treasure.enabled':'万吨巨轮',
  'cityWar.enabled':'城战接续', 'forge.enabled':'装备锻造', 'antique.enabled':'藏品养成', 'worldBoss.enabled':'worldBoss',
  'dailies.claimGift':'gift', 'trials.paid':'trialPaidSweep', 'trials.ads':'trialAdSweep',
  'gather.fishing':'autoFish', 'gather.upgradeFishing':'fishEnhance', 'gather.diving':'autoDive',
  'gather.salvage':'autoSalvage', 'gather.upgradeDiving':'diveEnhance', 'gather.upgradeSalvage':'salvageEnhance',
  'gather.floaters':'floaters', 'gather.antiqueFloaters':'antiqueFloaters',
  'schedule.worldOnline':'worldOnlineRewards', 'schedule.tradeTasks':'merchantRewards',
  'guildShip.enabled':'guildShip', 'guildFort.enabled':'guildFort', 'heroRaid.enabled':'heroRaid',
};
const sharedSchedules = {
  'dailies.claimDailyChest':'chests', 'dailies.claimWeeklyChest':'chests',
  'factory.gain':'collect', 'building.collect':'collect', 'factory.speedUp':'speedUp', 'building.speedUp':'speedUp',
  'dailies.claimTasks':'dailyRewards', 'arena.claimTask':'dailyRewards', 'league.claimTask':'dailyRewards',
};
const scopeControls = new Set(['loop.world','loop.dailies','loop.tasks','resources.allowDiamonds','dailies.enabled',
  'radar.runEnabled','pirate.enabled','building.enabled','factory.enabled','gather.enabled','progression.enabled']);

export function runtimeSources(control, settings) {
  const key = runtimeObservationKeys[control.key] ?? control.taskKey ?? control.key;
  let records = key === control.key ? [key] : [key, control.key];
  if (control.key === 'progression.mainline') records = ['stageAuto'];
  if (control.key === 'pirateHunt.enabled') records = ['pirateAuto'];
  if (control.key === 'progression.trials') records = settings.progression.raidIds.map(id => 'trialAuto:'+id);
  return {key, records, checkKey:sharedSchedules[key] ?? key, scope:scopeControls.has(control.key)};
}

// 已用完的免费副本会延至明天，不再查询。保留今天各个副本的最后一次实际结果。
export function summarizeTrialChecks(schedule, taskKey, raids) {
  const today = schedule.nextDay() - 86400;
  const statuses = raids.map(raid => ({ name: raid.title || '副本 ' + raid.raidId,
    result: schedule.status(taskKey + ':' + raid.raidId) })).filter(row => row.result?.checkedAt >= today);
  if (!statuses.length) return;
  const severity = ['error','pending','waiting','sent','ok'].find(value => statuses.some(row => row.result.state === value));
  schedule.observe(taskKey, statuses.map(row => row.name + '：' + row.result.text).join('；'), severity);
}

// 博物馆统一由基地计划报告升级、领奖、上架和探宝状态。
export function museumRuntimeStatus(settings, { status, nextCheck }) {
  if (settings.museum?.runEnabled === false || !settings.loop?.world) return { observation: null, nextCheck: null };
  if (['enabled', 'upgrade', 'revenue', 'achievements', 'display', 'unlockCases'].some(key => settings.museum?.[key])) {
    return { observation: status('museum.runEnabled') ?? null, nextCheck: nextCheck('museum.runEnabled') ?? null };
  }
  return { observation: null, nextCheck: null };
}

// 只读展示层：进度使用已观测计数，条件保留真实阻断原因，不从开关推断已完成。
export function runtimeProgress(control,observation,usage={counters:{}},{running=false,connected=false,treasureReward='今日奖励未同步',freeTimes,now=Date.now()}={}){
 const text=observation?.text||'',state=observation?.state,counters=usage.counters??{};
 const mapping={
  'schedule.pirate':['pirateSweeps','本工具今日免费扫荡','次'],
  'cityWar.enabled':['cityWarDispatches','本工具今日出征','次'],
  'forge.enabled':['forgeStarts','本工具今日锻造','单'],
  'resident.enabled':['residentOrders','本工具今日交单','单'],
  'cargo.enabled':['cargoLoads','本工具今日装货','次'],
  'worldBoss.enabled':['worldBossPetrol','本工具今日首战用油',''],
  'trials.paid':['trialDiamonds','本工具今日扫荡用钻',''],
 };
 const count=mapping[control.key];
 let progress=count&&Number.isSafeInteger(counters[count[0]])?count[1]+' '+counters[count[0]]+count[2]:'—';
 let condition=state === 'unseen' ? '—' : text||'尚未同步当前条件';
 if(state==='scope' && !control.blockedBy?.length)
   return {progress:'—',condition:control.enabled ? control.configurationNote || '范围已开启' : '范围已关闭'};
 // 只拆显式的分隔句，避免把条件数字当作完成量。
 const trial=['trials.paid','trials.ads','schedule.trialSweep'].includes(control.key);
 const match=!trial && state==='waiting' && text.match(/^((?:今日免费扫荡次数已用完|已领至第|已领取|当前进度|任务进度)[^，；]*\d[^，；]*)(?:[，；]\s*(.+))?$/);
 if(control.key==='treasure.enabled'){
  progress='本工具今日出征 '+(counters.treasureDispatches??0)+'次 · '+treasureReward;
 }else if(match){progress=match[1];condition=match[2]||'—';}
 else if(/^(今日.*礼包|当前免费礼包|本期.*免费礼包).*已领取$/.test(text)){progress=text;condition='—';}
 else if(state==='ok'&&!trial){progress=text||'已确认执行成功';condition='—';}
 if(state==='error'||state==='pending')condition=text||'等待确认';
 if(!control.enabled)condition='已关闭'+(condition==='—'?'':'；'+condition);
 else if(control.blockedBy?.length)condition='受总控限制：'+control.blockedBy.join('、')+(condition==='—'?'':'；'+condition);
 else if(!connected)condition='账号未连接'+(condition==='—'?'':'；'+condition);
 else if(!running&&condition==='—')condition='挂机未运行';
 else if(state==='unseen')condition=control.configurationNote || '等待首次检查';
 const type={'schedule.freeRecruit':'hero','schedule.freeAntiqueRecruit':'antique'}[control.key];
 if(type&&connected){
  const ts=freeTimes?.[type];
  if(Number.isSafeInteger(ts)&&ts>=0){
   const day=ms=>new Date(ms+28800000).toISOString().slice(0,10);
   const time=new Date(ts*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
   const date=day(ts*1000);
   const prefix=date===day(now)?'':date===day(now+86400000)?'明日 ':date.slice(5)+' ';
   progress=ts*1000<=now?'冷却已到':'下次 '+prefix+time;
   if(condition.startsWith('下次免费招募'))condition='—';
  }
 }
 return {progress,condition};
}
