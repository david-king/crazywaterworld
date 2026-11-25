import { createHash } from 'node:crypto';
import { exactAutomationId, resourceReserve } from './automation-policy.mjs';
import { displayMaterial } from './config.mjs';
import { EXTENDED_DEFAULTS } from './extended-settings.mjs';
import { toNumber } from './client.mjs';
import { goodsRubyPrice, readDiamondBalance, readGoodsPurchaseBalances } from './goods-purchase.mjs';
import { readOrderReservedStock, beginOrderMaterialSpend, cancelOrderMaterialSpend,
  confirmOrderMaterialOperation, refreshOrderMaterialSpends } from './order-reservations.mjs';

const activityByClient = new WeakMap(), busy = new WeakSet();
const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const valid = value => Number.isSafeInteger(value) && value >= 0;
const dayOf = seconds => Math.floor((seconds + 28800) / 86400);
// TipsDescCfg[联盟商船]：结束前 10 分钟提前结算，停止应聘船长和补货。
const settlementSeconds = 10 * 60;
export const guildShipApplicationDeadline = endTime => valid(endTime) && endTime > 0 ? endTime - settlementSeconds : null;
const closedReason = (endTime, now) => endTime > 0 && now >= endTime
  ? '服务器已确认商船活动结束'
  : endTime > 0 && now >= guildShipApplicationDeadline(endTime)
    ? '联盟商船已进入活动结束前 10 分钟结算期，停止申请船长和补货' : '';
const observedEndTime = (client, period) => {
  const activity = activityByClient.get(client)?.period;
  return activity?.period === period && valid(activity.endTime) ? activity.endTime : 0;
};
const identity = player => [exactAutomationId(player?.worldId), exactAutomationId(player?.playerId), exactAutomationId(player?.guildId)].join(':');
const defaults = { ...EXTENDED_DEFAULTS.guildShip, coinFilter:true };
const prefOf = settings => ({ ...defaults, ...settings?.guildShip });
const quantity = (value, label) => { const n = toNumber(value); if (!valid(n)) throw new Error(label + '未完整确认'); return n; };
const array = (value, label) => { if (!Array.isArray(value)) throw new Error(label + '未完整返回'); return value; };
const isSelf = (ship, playerId) => ship.leaderId === playerId || ship.cabin.some(cabin => cabin.playerId === playerId);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);

export const isGuildShipPush = name => name.startsWith('SCGuildShip') || name === 'SCJoinGuild' || name === 'SCLeaveGuild';

// 必须在登录前注册，活动终止时刻只来自服务器推送，不能由活动期数猜测。
export function watchGuildShipPushes(client, scheduler) {
  let state = activityByClient.get(client);
  if (state) { if (scheduler) state.scheduler = scheduler; return state; }
  state = { period:null, revision:0, scheduler }; activityByClient.set(client, state);
  const clear = () => { state.revision++; state.period = null; state.lastResult = null; state.scheduler?.clearTask?.('guildShip'); };
  client.on?.('login', clear); client.on?.('close', clear);
  client.on?.('message', ({name,body}) => {
    if (name === 'SCGuildShipActivity') state.period = body?.period ? { ...body.period } : null;
    if (isGuildShipPush(name)) {
      state.revision++;
      state.scheduler?.clearTask?.('guildShip');
    }
  });
  return state;
}

function shipParameters(config, player) {
  const world = exactAutomationId(player?.worldId), season = world ? Number(BigInt(world) / 1000000n % 1000n) : 0;
  const param = rows(config,'GuildShipParamCfg').filter(row => row.season <= season).sort((a,b) => b.season-a.season)[0];
  if (!season || !param || !valid(param.shipNum) || param.shipNum < 1 || !valid(param.duration)
    || !Array.isArray(param.time) || !param.time.length || param.time.some(h => !valid(Number(h)) || Number(h) > 23)) throw new Error('当前赛季的商船队列或刷新配置未确认');
  return { ...param, time:[...new Set(param.time.map(Number))].sort((a,b)=>a-b) };
}

export function guildShipBatch(now, hours) {
  const midnight = dayOf(now) * 86400 - 28800;
  const points = [-1,0,1].flatMap(d => hours.map(hour => midnight + d * 86400 + hour * 3600)).sort((a,b)=>a-b);
  return { start:points.filter(time=>time<=now).at(-1), next:points.find(time=>time>now) };
}

function assets(raw, label) {
  const costs = new Map();
  for (const row of array(raw,label)) {
    if (row?.type !== 0 || typeof row.id !== 'string' || !row.id) throw new Error(label + '包含未支持的材料类型');
    const n = quantity(row.num,label + '数量'); if (n < 1) throw new Error(label+'数量异常');
    costs.set(row.id, quantity((costs.get(row.id) ?? 0)+n,label+'合计'));
  }
  return [...costs].map(([id,need])=>({id,need}));
}

function normalizeShip(raw, config) {
  if (!valid(raw?.shipId) || raw.shipId < 1 || ![1,2,3].includes(raw.type) || ![1,2].includes(raw.state)) throw new Error('联盟商船标识或状态无效');
  const cfg = rows(config,'GuildShipCfg').find(row => row.shipId === raw.type);
  if (!cfg || !valid(cfg.time) || cfg.time < 1 || !valid(cfg.num) || cfg.num < 1) throw new Error('商船航程或船舱配置未确认');
  const cabin = array(raw.cabin,'商船船舱').map(row => {
    if (!valid(row?.crewId) || row.crewId < 1) throw new Error('船舱编号无效');
    const playerId = row.player ? exactAutomationId(row.player.playerId) : null;
    if (row.player && !playerId) throw new Error('船员身份无法精确确认');
    return { crewId:row.crewId, playerId, costs:assets(row.order,'船舱材料') };
  });
  if (cabin.length !== cfg.num || new Set(cabin.map(row=>row.crewId)).size !== cabin.length) throw new Error('船舱列表不完整或重复');
  // 舱号标识实际位置。统一顺序后，同价选舱和发送前复核均不受服务端列表顺序影响。
  cabin.sort((a,b)=>a.crewId-b.crewId);
  const leaderId = raw.leader ? exactAutomationId(raw.leader.playerId) : null;
  if (raw.leader && !leaderId) throw new Error('船长身份无法精确确认');
  const reward = array(raw.reward?.asset,'商船奖励').map(row=>({id:row.id,num:quantity(row.num,'商船奖励数量')}));
  if (reward.some(row=>typeof row.id!=='string'||!row.id)) throw new Error('商船奖励编号无效');
  return { shipId:raw.shipId, type:raw.type, state:raw.state, cabin, leaderId, leaderCond:array(raw.leaderCond,'船长条件'), reward,
    preparedEndTime:quantity(raw.preparedEndTime ?? 0,'准备结束时间'), mvEndTime:quantity(raw.mvEndTime ?? 0,'抵港时间'),
    voyageSeconds:cfg.time * 60, coins:reward.filter(row=>row.id==='水姆币').reduce((sum,row)=>sum+row.num,0) };
}

function candidateList(view, settings) {
  const pref = prefOf(settings), now = view.now;
  const final = pref.mode === 'full' && view.activityEndTime > now && dayOf(view.activityEndTime-1) === dayOf(now)
    && ((now+28800)%86400) >= 23*3600+25*60;
  const fallback = pref.mode === 'full' && now >= view.batch.start+20*60;
  const relaxed = fallback || final;
  const kinds = final ? [3,2,1] : pref.mode==='small' ? [1] : pref.mode==='mediumSmall' ? [2,1] : pref.mode==='mediumLarge' ? [3,2] : [3,2,1];
  const result=[];
  view.blockedShips = [];
  const blocked = (ship, reason) => view.blockedShips.push({ shipId:ship.shipId, type:ship.type, reason });
  if (view.own.length >= view.maxShipNum) return result;
  const selected = [...view.ships].sort((a,b)=>kinds.indexOf(a.type)-kinds.indexOf(b.type)||a.shipId-b.shipId);
  for (const ship of selected) {
    if (!kinds.includes(ship.type)) { blocked(ship,'不在所选船型范围'); continue; }
    if (ship.state!==1) { blocked(ship,'已经出航'); continue; }
    if (isSelf(ship,view.playerId)) { blocked(ship,'本人已在这艘船上'); continue; }
    const threshold = ({1:pref.minCoinsSmall,2:pref.minCoinsMedium,3:pref.minCoinsLarge})[ship.type];
    if (!final && pref.coinFilter && ship.coins < threshold) { blocked(ship,`水姆币 ${ship.coins} 低于门槛 ${threshold}`); continue; }
    if (!relaxed && pref.rewardFilter && pref.rewardItems.length && !ship.reward.some(row=>pref.rewardItems.includes(row.id))) { blocked(ship,'奖励未命中所选物品'); continue; }
    const arrival = (ship.leaderId ? ship.preparedEndTime : now+view.prepareSeconds) + ship.voyageSeconds;
    // 在下一批刷新时保留至少一个可用队列；到港预测只用于保留，不覆盖服务端实际占用。
    if (!relaxed && ['redFirst','full'].includes(pref.mode) && ship.type<3 && arrival>view.batch.next
      && view.own.filter(row=>row.arrival>view.batch.next).length+1 >= view.maxShipNum) { blocked(ship,'为下一批红船保留队列'); continue; }
    const before = result.length;
    if (ship.leaderId && ship.preparedEndTime>now && (pref.crew || relaxed)) {
      for (const cabin of ship.cabin) if (!cabin.playerId && cabin.costs.length && !cabin.costs.some(row=>pref.disabledMaterials.includes(row.id)))
        result.push({ kind:'crew', shipId:ship.shipId, crewId:cabin.crewId, type:ship.type, costs:cabin.costs, finalFallback:final,
          preparedEndTime:ship.preparedEndTime, stamp:digest([ship, cabin]), arrival });
    }
    if (!ship.leaderId && (pref.captain || relaxed)) {
      if (ship.type===3 && pref.redStartEnabled && !final) {
        if (!/^\d{2}:\d{2}$/.test(pref.redStartTime)) { blocked(ship,'申请船长时间无效'); continue; }
        const [h,m]=pref.redStartTime.split(':').map(Number);
        if (h>23 || m>59 || (now+28800)%86400<h*3600+m*60) { blocked(ship,'尚未到申请船长时间 '+pref.redStartTime); continue; }
      }
      if (ship.leaderCond.every(cond => {
        const hero=view.heroes.find(row=>row.heroId===cond.heroId);
        return hero && valid(hero.star) && valid(hero.exclusive?.star ?? 0) && valid(cond.star) && valid(cond.exStar)
          && hero.star+(hero.exclusive?.star ?? 0)>=cond.star+cond.exStar;
      })) result.push({kind:'captain',shipId:ship.shipId,type:ship.type,costs:[],finalFallback:final,preparedEndTime:0,stamp:digest(ship),arrival});
    }
    if (result.length === before) {
      const reason = !ship.leaderId
        ? (pref.captain || relaxed ? '船长英雄星级条件未满足' : '尚无船长，且未开启申请船长')
        : !(pref.crew || relaxed) ? '未开启担任船员'
        : ship.preparedEndTime<=now ? '准备时间已结束'
        : ship.cabin.every(row=>row.playerId) ? '船员舱位已满'
        : '空舱材料命中禁用清单或订单未确认';
      blocked(ship,reason);
    }
  }
  // 全程兜底按图示先做船员，再申请船长；普通模式维持红→中→小。
  for (const candidate of result) {
    candidate.priority = kinds.indexOf(candidate.type) + (relaxed && candidate.kind === 'captain' ? kinds.length : 0);
  }
  return result.sort((a,b)=>a.priority-b.priority);
}

const shipLabel = ship => `${['','紫船','橙船','红船'][ship.type]} #${ship.shipId}`;
const candidateReady = candidate => candidate.costs.every(cost=>cost.missing===0);
const applicationKey = (view, row) => `guildShip:${view.worldId}:${view.playerId}:${view.period}:${view.batch.start}:${row.shipId}:${row.preparedEndTime}`;
const purchaseKey = (view, row) => `guildShipBuy:${view.worldId}:${view.playerId}:${view.guildId}:${view.period}:${row.shipId}:${row.preparedEndTime}:${row.crewId}`;
const isApplication = details => details?.kind === 'guildShipCrew' || details?.kind === 'guildShipCaptain';
const sameSeat = (first, next) => first && next && first.stamp === next.stamp && first.shipId === next.shipId
  && first.crewId === next.crewId && first.kind === next.kind;

function cargoQuote(candidate, config) {
  const goods = [];
  let cost = 0;
  for (const item of candidate.costs) {
    if (item.missing === 0) continue;
    const price = goodsRubyPrice(config, item.id);
    // 若已有预留本身尚有缺口，只购买本舱所需数量也无法装货。
    if (!price || !valid(item.missing) || item.reserved > item.have) return null;
    goods.push({ itemId: item.id, num: item.missing });
    cost += price * item.missing;
  }
  return valid(cost) && cost > 0 ? { goods, cost } : null;
}

export async function planGuildShipBoarding(client, config, view, settings, ledger, balance) {
  const stock = view.candidates.find(candidateReady);
  const fallback = { candidate: stock };
  const pref = prefOf(settings);
  const missing = view.candidates.filter(row => row.kind === 'crew' && !candidateReady(row)
    && (!stock || row.priority < stock.priority));
  if (!pref.allowDiamonds || !missing.length) return fallback;
  const records = ledger.keyRecords();
  if (Object.values(records).some(r => !r.confirmed && r.details?.kind === 'guildShipBuy' && sameActor(r.details, view))) {
    return { ...fallback, reason: '上次商船补货结果待确认，已保留钻石额度', pending: true };
  }
  const used = ledger.snapshot().counters;
  const daily = pref.diamondDailyLimit - (used.guildShipDiamonds ?? 0);
  const quotes = missing.filter(row => !records[applicationKey(view, row)] && !records[purchaseKey(view, row)])
    .map(candidate => ({ candidate, purchase: cargoQuote(candidate, config) }))
    .filter(plan => plan.purchase)
    // 同优先级比较整舱缺货总价，稳定排序在同价时沿用船号、舱号顺序。
    .sort((a,b) => a.candidate.priority - b.candidate.priority || a.purchase.cost - b.purchase.cost);
  if (!quotes.length) return { ...fallback, reason: '没有可按当前报价和库存预留补齐的新船舱' };
  if (!quotes.some(plan => plan.purchase.cost <= daily)) return { ...fallback, reason: '商船每日钻石剩余额度不足以补齐一舱' };
  try {
    balance ??= await readDiamondBalance(client);
  } catch (error) {
    return { ...fallback, reason: error.message };
  }
  const available = balance - (ledger.pendingCounters().diamonds ?? 0) - resourceReserve(settings, 'RUBY');
  return quotes.find(plan => plan.purchase.cost <= Math.min(daily, available))
    ?? { ...fallback, reason: '扣除保留量和待确认消费后，钻石余额不足以补齐一舱' };
}

// 规则候选不等于可以上船：船员还需扣除其他订单预留后有足够材料。
export function guildShipDiagnostics(view, settings, config, plan) {
  const candidates = view.candidates.map(row => ({ shipId:row.shipId, type:row.type, kind:row.kind,
    crewId:row.crewId ?? null, label:shipLabel(row)+(row.kind==='crew'?` ${row.crewId}号舱`:' 申请船长'),
    ready:candidateReady(row), costs:row.costs.map(cost=>({...cost,name:displayMaterial(config,cost.id)})) }));
  const eligible = candidates.filter(row=>row.ready).length;
  const notes = candidates.filter(row=>!row.ready).map(row=>row.label+'：'+row.costs.filter(cost=>cost.missing!==0).map(cost=>
    valid(cost.missing) ? `${cost.name}缺 ${cost.missing}（需 ${cost.need}，可用 ${cost.available}，已预留 ${cost.reserved}）` : `${cost.name}库存尚未核对`).join('、'));
  const blockedShips = (view.blockedShips ?? []).map(row=>({...row,label:shipLabel(row)}));
  notes.push(...blockedShips.map(row=>row.label+'：'+row.reason));
  if (plan?.purchase) notes.unshift(`${shipLabel(plan.candidate)} ${plan.candidate.crewId}号舱可用 ${plan.purchase.cost} 钻石补齐`);
  else if (plan?.reason) notes.unshift(plan.reason);
  if (prefOf(settings).produceMissing) notes.push('自动补料仅针对符合策略的红船船员位，紫船和橙船缺料不会自动补产。');
  const reason = view.reason || (view.own.length>=view.maxShipNum ? `游戏商船队列已满（${view.own.length}/${view.maxShipNum}）`
    : eligible || plan?.purchase ? '' : plan?.reason ? plan.reason
    : candidates.length ? '候选船位材料不足：'+notes.slice(0,2).join('；')+(candidates.length>2?`；另有 ${candidates.length-2} 个候选缺料`:'')
    : blockedShips.length ? blockedShips.map(row=>row.label+'：'+row.reason).join('；') : '当前没有可参与的商船');
  return { eligible, candidates, blockedShips, reason, notes };
}

export async function readGuildShips(client, protocol, config, {player,getSettings=()=>({}),enabled=()=>true,inventory=true,activityClient=client}={}) {
  const view={state:'blocked',reason:'',ships:[],own:[],candidates:[],requirements:[],now:nowOf(client)};
  const stamp=identity(player), playerId=exactAutomationId(player?.playerId), guildId=exactAutomationId(player?.guildId);
  const gate=rows(config,'ModuleOpenCfg').find(row=>row.moduleId==='联盟商船')?.playerLevel;
  if (!enabled()) return {...view,reason:'已暂停'};
  const scheduled = activityByClient.get(activityClient)?.period;
  if (valid(scheduled?.startTime) && scheduled.startTime > view.now && scheduled.endTime > scheduled.startTime) {
    return {...view,reason:'联盟商船活动未开放',nextCheckAt:scheduled.startTime};
  }
  if (!valid(gate)||!valid(player?.level)) return {...view,reason:'商船开放条件未确认'};
  if(player.level<gate) return {...view,reason:`联盟商船在角色 ${gate} 级开放`};
  if(!playerId||!guildId||!exactAutomationId(player?.worldId)) return {...view,reason:'当前没有可确认的联盟身份'};
  const param=shipParameters(config,player);
  for(const name of ['GuildInfoRequest','GuildInfoResponse','GuildShipRequest','GuildShipResponse','AllHeroRequest','AllHeroResponse']) if(!protocol?.[name]) throw new Error('缺少真实协议 '+name);
  const guild=await client.request('GuildInfoRequest',{},'GuildInfoResponse');
  if(exactAutomationId(guild?.guild?.guildId)!==guildId||stamp!==identity(player)||!enabled()) throw new Error('联盟身份已变化');
  const reply=await client.request('GuildShipRequest',{},'GuildShipResponse');
  if(!valid(reply?.period)) throw new Error('商船活动期数未确认');
  if(reply.period===0)return {...view,reason:'联盟商船活动未开放'};
  const ships=array(reply.ship,'联盟商船列表').map(row=>normalizeShip(row,config));
  const ownRun=array(reply.ownRun,'我的在途商船').map(row=>normalizeShip(row,config));
  if(new Set(ships.map(row=>row.shipId)).size!==ships.length||new Set(ownRun.map(row=>row.shipId)).size!==ownRun.length)throw new Error('商船列表重复');
  const ownMap=new Map(ownRun.filter(row=>row.mvEndTime>view.now).map(row=>[row.shipId,row]));
  for(const ship of ships)if(isSelf(ship,playerId)&&!(ship.mvEndTime>0&&ship.mvEndTime<=view.now))ownMap.set(ship.shipId,ship);
  const own=[...ownMap.values()].map(ship=>({...ship,arrival:ship.mvEndTime||ship.preparedEndTime+ship.voyageSeconds}));
  const heroes=array((await client.request('AllHeroRequest',{},'AllHeroResponse'))?.heroes,'船长英雄');
  const observed=activityByClient.get(activityClient)?.period;
  if(observed?.period===reply.period&&valid(observed.startTime)&&observed.startTime>view.now)
    return {...view,reason:'联盟商船活动未开放',nextCheckAt:observed.startTime};
  const activityEndTime=observedEndTime(activityClient,reply.period);
  view.now=nowOf(client);
  Object.assign(view,{state:'ready',identity:stamp,playerId,guildId,worldId:exactAutomationId(player.worldId),ships,own,heroes,
    period:reply.period,maxShipNum:param.shipNum,prepareSeconds:param.duration*60,batch:guildShipBatch(view.now,param.time),activityEndTime});
  // 保留本人船位供已发送申请核对，但结算期不再生成新候选或备料需求。
  const reason=closedReason(activityEndTime,view.now);
  if(reason)return {...view,state:'blocked',reason};
  view.candidates=candidateList(view,getSettings());
  const ids=[...new Set(view.candidates.flatMap(row=>row.costs.map(cost=>cost.id)))];
  if(inventory&&ids.length){
    const inventoryState=await readOrderReservedStock(client,protocol,config,{player,settings:getSettings(),enabled,itemIds:ids});
    for(const candidate of view.candidates)candidate.costs=candidate.costs.map(cost=>{
      const have=inventoryState.stock.get(cost.id)??0,reserved=inventoryState.reserved.get(cost.id)??0;
      const reserve=resourceReserve(getSettings(),cost.id),available=Math.max(0,have-reserved-reserve);
      return {...cost,have,reserved:reserved+reserve,available,missing:Math.max(0,cost.need-available)};
    });
  }
  if(!enabled()||stamp!==identity(player))throw new Error('账号或联盟已变化');
  const latestReason=closedReason(observedEndTime(activityClient,reply.period),nowOf(client));
  if(latestReason)return {...view,state:'blocked',reason:latestReason,candidates:[]};
  return view;
}

export function guildShipDemands(view,settings,ledger){
  const pref=prefOf(settings);
  if(!pref.enabled||!pref.produceMissing||view?.state!=='ready')return [];
  if(ledger&&Object.values(ledger.keyRecords()).some(record=>!record.confirmed&&sameActor(record.details,view)&&isApplication(record.details)))return [];
  const chosen=view.candidates.find(row=>row.kind==='crew'&&row.type===3);
  return chosen?[{source:'guildShip',requirements:chosen.costs.map(row=>({id:row.id,num:row.need})),
    reserved:chosen.costs.map(row=>({id:row.id,num:row.reserved??0}))}]:[];
}

function sameActor(details,view){return !!view.worldId && !!view.playerId && details?.worldId===view.worldId&&details.playerId===view.playerId;}
function ownEvidence(view,details){
  if(view.period!==details.period||view.guildId!==details.guildId)return false;
  const ship=[...view.own,...view.ships].find(row=>row.shipId===details.shipId);
  return !!ship&&(details.kind==='guildShipCaptain'?ship.leaderId===view.playerId:ship.cabin.some(row=>row.crewId===details.crewId&&row.playerId===view.playerId));
}

async function purchasedCargoArrived(client, details, checkActor) {
  const stock = await readGoodsPurchaseBalances(client, checkActor);
  return details.expectedStock.every(({ id, num }) => (stock.get(id) ?? 0) >= num);
}

async function buyGuildShipCargo(client, protocol, ledger, settings, view, candidate, purchase, checkWindow, checkActor) {
  if (!protocol.CommonBuyGoodsRequest || !protocol.CommonBuyGoodsResponse) throw Error('缺少商船补货协议');
  const key = purchaseKey(view, candidate);
  const details = { kind:'guildShipBuy', worldId:view.worldId, playerId:view.playerId, guildId:view.guildId,
    period:view.period, shipId:candidate.shipId, crewId:candidate.crewId, ...purchase,
    expectedStock:candidate.costs.filter(item=>item.missing>0).map(item=>({id:item.id,num:item.have+item.missing})) };
  const ticket = ledger.reserve({ guildShipDiamonds:purchase.cost },
    { guildShipDiamonds:prefOf(settings).diamondDailyLimit }, {}, { uniqueKey:key, details });
  let attempted = false, received = false;
  try {
    const reason = checkWindow() || (ledger.snapshot().day !== ticket.day ? '商船补货已跨日，重新核对今日额度' : '');
    if (reason) { ledger.cancel(ticket); return { skipped:true, reason }; }
    attempted = true;
    const response = await client.request('CommonBuyGoodsRequest', { goods:purchase.goods }, 'CommonBuyGoodsResponse');
    received = true;
    const reward = assets(response?.reward?.asset, '商船补货回执');
    if (reward.length !== purchase.goods.length || !purchase.goods.every(item =>
      reward.some(row => row.id === item.itemId && row.need === item.num))) throw Error('商船补货回执与购买清单不符');
    ledger.updateKeyDetails(key, { ...details, acknowledged:true });
    if (!await purchasedCargoArrived(client, details, checkActor)) throw Error('购买回执已确认，等待所购材料入库');
    ledger.confirm(ticket);
    return { ok:true, label:`联盟商船 · 已花 ${purchase.cost} 钻石补齐${shipLabel(candidate)} ${candidate.crewId}号舱货物` };
  } catch (error) {
    const rejected = !attempted || !received && (error.notSent === true || error.prompt && error.request === 'CommonBuyGoodsRequest');
    if (rejected) ledger.cancel(ticket);
    return { ok:false, pending:!rejected, error:(rejected ? '商船补货未执行：' : '商船补货待确认，已保留钻石额度：') + error.message };
  }
}

export async function serviceGuildShips(client,protocol,config,{player,getSettings=()=>({}),enabled=()=>false,ledger,report=()=>{},scheduler}={}){
  const state=watchGuildShipPushes(client,scheduler);
  const pref=prefOf(getSettings());
  const preference=JSON.stringify(pref);
  if(state.preference!==preference){state.preference=preference;state.lastResult=null;}
  const finish=(entry,remember=true)=>{const result={key:'guildShip',label:'联盟商船',...entry};if(remember)state.lastResult=result;report(result);return result;};
  const active=()=>enabled()&&prefOf(getSettings()).enabled;
  if(!active())return finish({skipped:true,reason:'联盟商船已关闭'});
  // 间隔内没有新的检查结果，不发布占位日志覆盖上次缺料、门控或失败原因。
  if(scheduler&&!scheduler.due('guildShip'))return {key:'guildShip',label:'联盟商船',skipped:true,
    reason:state.lastResult?.reason||state.lastResult?.error||'等待下次检查',...(state.lastResult?.pending?{pending:true}:{})};
  if(busy.has(client))return finish({skipped:true,reason:'正在核对联盟商船'},false);
  const startedRevision=state.revision;
  let opensAt, nextBatchAt;
  busy.add(client);
  try{
    if(!ledger)throw new Error('商船持久账本不可用');
    const initial=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active,inventory:false});
    opensAt=initial.nextCheckAt;
    nextBatchAt=initial.batch?.next;
    const checkActor = () => {
      if (!active() || client.connected === false || identity(player) !== initial.identity) throw Error('账号、联盟或商船开关已变化');
    };
    for(const [key, record] of Object.entries(ledger.keyRecords())) {
      if (record.confirmed || !sameActor(record.details,initial)) continue;
      if (record.details.kind === 'guildShipBuy' && record.details.acknowledged) {
        if (await purchasedCargoArrived(client, record.details, checkActor)) ledger.resolveKey(key, true);
      } else if (isApplication(record.details) && ownEvidence(initial,record.details)) ledger.resolveKey(key,true);
    }
    if(initial.state!=='ready'){
      if(initial.identity)await refreshOrderMaterialSpends(client,player,{enabled:active});
      return finish({skipped:true,reason:initial.reason});
    }
    if(Object.values(ledger.keyRecords()).some(record=>!record.confirmed&&sameActor(record.details,initial)&&isApplication(record.details)))return finish({skipped:true,pending:true,reason:'上次上船结果待确认，保留队列和材料，不重复申请'});
    await refreshOrderMaterialSpends(client,player,{enabled:active});
    const first=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active});
    if(first.state!=='ready'){opensAt=first.nextCheckAt;return finish({skipped:true,reason:first.reason});}
    const policyOf=()=>{
      const settings=getSettings();
      return JSON.stringify([prefOf(settings),settings.resources?.keepAccelerators,settings.resources?.diamondThreshold]);
    };
    const policy=policyOf();
    const plan=await planGuildShipBoarding(client,config,first,getSettings(),ledger);
    const candidate=plan.candidate;
    if(!candidate)return finish({skipped:true,pending:plan.pending,reason:guildShipDiagnostics(first,getSettings(),config,plan).reason,demands:guildShipDemands(first,getSettings())});
    // 先核对钻石余额，再重读所有候选舱位与库存，避免在等待余额时错过可直接装货的红船。
    const balance=plan.purchase ? await readDiamondBalance(client) : 0;
    const readCurrent=()=>readGuildShips(client,protocol,config,{player,getSettings,enabled:active});
    let revision=state.revision;
    let current=await readCurrent();
    const fresh=await planGuildShipBoarding(client,config,current,getSettings(),ledger,balance);
    let chosen=fresh.candidate;
    const sameView=()=>current.identity===initial.identity&&current.period===first.period&&current.batch.start===first.batch.start;
    const verified = fresh.purchase
      ? sameSeat(candidate,chosen) && JSON.stringify(fresh.purchase)===JSON.stringify(plan.purchase)
      : first.candidates.some(row=>sameSeat(row,chosen));
    if(!verified||!active()||!sameView()||policy!==policyOf())return finish({skipped:true,reason:'商船、材料或配置已变化，下一轮重新核对'});
    const previousFinal=Object.values(ledger.keyRecords()).some(record=>sameActor(record.details,current)&&record.details.period===current.period&&record.details.finalFallback);
    if(chosen.finalFallback&&previousFinal)return finish({skipped:true,reason:'活动末日宽松兜底已申请过一船'});
    const request=chosen.kind==='crew'?'GuildShipOrderRequest':'GuildShipSeekRequest';
    if(!protocol[request])throw new Error('缺少真实协议 '+request);
    const key=applicationKey(current,chosen);
    if(ledger.hasKey(key))return finish({skipped:true,reason:'该商船本批次已有申请记录，等待服务端刷新'});
    const checkWindow=()=>{
      const now=nowOf(client);
      const closed=closedReason(observedEndTime(client,current.period)||current.activityEndTime,now);
      if(closed)return closed;
      if(state.revision!==revision)return '已收到新的商船或联盟状态，重新核对船位';
      if(!active()||client.connected===false||policy!==policyOf()||identity(player)!==current.identity||now>=current.batch.next
        ||(chosen.kind==='crew'&&now>=chosen.preparedEndTime))return '发送前开关、批次或船位已变化';
      return '';
    };
    if(fresh.purchase){
      const bought=await buyGuildShipCargo(client,protocol,ledger,getSettings(),current,chosen,fresh.purchase,checkWindow,checkActor);
      if(!bought.ok)return finish(bought);
      report({key:'guildShip',...bought});
      revision=state.revision;
      current=await readCurrent();
      chosen=current.candidates.find(row=>sameSeat(candidate,row)&&candidateReady(row));
      if(!chosen||!sameView()||checkWindow())return finish({skipped:true,reason:'已购买的货物留在库存，船位、可用材料或配置已变化'});
    }
    const details={kind:chosen.kind==='crew'?'guildShipCrew':'guildShipCaptain',worldId:current.worldId,playerId:current.playerId,guildId:current.guildId,
      period:current.period,shipId:chosen.shipId,crewId:chosen.crewId??0,finalFallback:chosen.finalFallback};
    const ticket=ledger.reserve({}, {}, {},{uniqueKey:key,details});let debit;
    try{if(chosen.costs.length)debit=beginOrderMaterialSpend(player,chosen.costs,'联盟商船',{operation:{verify:async(next,{enabled:allowed})=>{
      if(!allowed())return false;return ownEvidence(await readGuildShips(next,protocol,config,{player,getSettings,enabled:allowed,inventory:false}),details);
    }}});}catch(error){ledger.cancel(ticket);throw error;}
    const cutoffReason=checkWindow();
    if(cutoffReason){
      ledger.cancel(ticket);cancelOrderMaterialSpend(debit);
      return finish({skipped:true,reason:cutoffReason});
    }
    let sent=false;
    try{
      await client.sendWatch(request,{shipId:chosen.shipId,...(chosen.kind==='crew'?{crewId:chosen.crewId}:{})},{window:400});sent=true;
      const after=await readGuildShips(client,protocol,config,{player,getSettings,enabled:active,inventory:false});
      if(!ownEvidence(after,details))throw new Error('服务端尚未确认本人船位');
      ledger.confirm(ticket);confirmOrderMaterialOperation(debit);await refreshOrderMaterialSpends(client,player,{enabled:active});
      return finish({ok:true,label:`联盟商船 · 已${chosen.kind==='crew'?'担任船员':'申请船长'}（${['','紫船','橙船','红船'][chosen.type]} #${chosen.shipId}）`});
    }catch(error){const rejected=(!sent&&error.notSent===true)||error.prompt&&error.request===request;if(rejected){ledger.cancel(ticket);cancelOrderMaterialSpend(debit);}return finish({ok:false,pending:!rejected,error:(rejected?'商船申请未执行：':'商船申请结果待确认，已保留记录：')+error.message});}
  }catch(error){return finish({ok:false,error:error.message});}
  finally {
    busy.delete(client);
    // 检查期间收到的推送或配置变更仍需在下一个调度点处理。
    if (scheduler && state.revision === startedRevision && preference === JSON.stringify(prefOf(getSettings()))) {
      const next = opensAt ?? Math.min(scheduler.now() + pref.checkEverySeconds, nextBatchAt ?? Infinity);
      scheduler.defer('guildShip', next);
    }
  }
}
