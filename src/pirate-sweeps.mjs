// 每日免费海盗扫荡：仅使用扫荡次数，不读取舰队或汽油，也不参与派遣调度。
import {exactAutomationId} from './automation-policy.mjs';
import {loadProtocol} from './proto.mjs';
const rows=(c,n)=>c?.tables?.[n]?.data??[];
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const day=t=>Math.floor((t+28800)/86400);
const active=new WeakSet(),rejections=new WeakMap();
const reward=r=>r?.reward?.asset?.some(a=>Number(a.num)>0)||['hero','antique','equipIds','badge','supply'].some(k=>r?.[k]?.length>0);
export async function readPirateSweeps(client,config,player,settings,keyRecords={}){
 const time=now(client),state={day:day(time),used:null,limit:null,left:null,allocations:[],target:null,reason:''};
 const world=exactAutomationId(player?.worldId),level=rows(config,'ModuleOpenCfg').find(r=>r.moduleId==='世界')?.playerLevel;
 state.world=world;
 if(!world||!valid(level)||!(player?.level>=level))return {...state,reason:'尚未确认世界玩法开放'};
 const sweep=settings.pirateSweep;
 if(!sweep.types.length)return {...state,reason:'未选择免费扫荡目标'};
 const base=rows(config,'PirateParamCfg').find(r=>r.paramName==='每日野怪扫荡次数')?.paramValue;
 const vip=rows(config,'VipLevelCfg').find(r=>r.level===player.vip?.vipLevel);
 if(!valid(base)||!vip)return {...state,reason:'每日扫荡次数或VIP权益未确认'};
 const [all,record,card]=await Promise.all([
  client.request('AllPirateRequest',{},'AllPirateResponse'),client.request('PirateKillRecordRequest',{},'PirateKillRecordResponse'),client.request('MonthCardRequest',{},'MonthCardResponse'),
 ]);
 if(!Array.isArray(all.pirates)||!valid(all.sweepTimes)||!Array.isArray(record.records)||!Array.isArray(card.cardItem))return {...state,reason:'海盗列表、每日次数、首杀记录或月卡状态未同步'};
 let limit=base;const add=effects=>{for(const [key,value]of effects??[])if(key==='野怪扫荡次数'){if(!valid(value))throw Error('海盗扫荡权益次数无效');limit+=value;}};
 add(vip.effects);
 const cardTypes=new Set(),enums=loadProtocol().MonthCardType;
 for(const item of card.cardItem){
  if(!Number.isSafeInteger(item.endTime)||cardTypes.has(item.type))throw Error('月卡有效期或类型未确认');cardTypes.add(item.type);
  if(item.endTime!==-1&&item.endTime<=time)continue;
  const id=item.type===enums.MONTH_CARD_NORMAL?'普通月卡':item.type===enums.MONTH_CARD_SENIOR?'高级月卡':null;
  const cfg=rows(config,'MonthCardCfg').find(r=>r.id===id);if(!cfg)throw Error('有效月卡配置未确认');add(cfg.effectList);
 }
 if(!valid(limit))throw Error('每日扫荡总次数无效');
 state.limit=limit;state.used=all.sweepTimes;state.left=Math.max(0,limit-state.used);
 const season=Math.floor(Number(world)/1e6)%1000;
 const configs=rows(config,'WorldPirateCfg').filter(row=>Number(row.season)===season);
 const prefix='pirate-sweep:'+world+':';
 const records=Object.entries(keyRecords).filter(([key,r])=>key.startsWith(prefix)&&!r.expired);
 const today=records.filter(([,r])=>r.details?.day===state.day);
 const uidCounts=new Map();
 for(const p of all.pirates)uidCounts.set(p.uid,(uidCounts.get(p.uid)??0)+1);
 for(const type of [1,2,3].filter(type=>sweep.types.includes(String(type)))){
  const name=configs.find(row=>row.type===type)?.showName??['','海盗先锋','海盗精锐','海盗头目'][type];
  const times=sweep['times'+type],used=today.filter(([,r])=>r.details?.type===type).length;
  const killed=record.records.filter(r=>r.type===type),level=killed[0]?.maxKilledLevel??0;
  const row={type,name,times,used,level,target:null,reason:''};
  if(killed.length>1||!valid(level))row.reason=name+'首杀等级未确认';
  else if(!level)row.reason=name+'尚未完成首杀';
  else if(!configs.some(r=>r.type===type&&r.level===level))row.reason=name+'最高已首杀等级配置未确认';
  else {
   row.target=all.pirates.filter(p=>p.type===type&&p.level===level&&valid(p.uid)&&p.uid>0&&valid(p.cityId)&&p.cityId>0&&uidCounts.get(p.uid)===1)
    .sort((a,b)=>a.cityId-b.cityId||a.uid-b.uid)[0];
   if(!row.target)row.reason='等待地图刷新'+name+' '+level+'级目标';
  }
  state.allocations.push(row);
 }
 if(records.some(([,r])=>!r.confirmed&&!(r.details?.day===state.day&&state.used>r.details.used)))return {...state,pending:true,reason:'前次扫荡次数尚未确认，未重复提交'};
 if(!state.left)return {...state,reason:'今日免费扫荡次数已用完（'+state.used+'/'+limit+'）'};
 const fixed=state.allocations.filter(row=>row.times>row.used);
 const reserved=fixed.reduce((sum,row)=>sum+row.times-row.used,0);
 const remaining=state.allocations.filter(row=>row.times===-1).sort((a,b)=>a.used-b.used||a.type-b.type);
 // 暂缺地图目标时保留该类固定次数，只有超出预留的次数才能用于其余目标。
 const eligible=state.left>reserved ? [...fixed,...remaining] : fixed;
 const next=eligible.find(row=>row.target);
 if(next)return {...state,type:next.type,name:next.name,level:next.level,target:next.target};
 return {...state,reason:eligible.map(row=>row.reason).join('，')||'今日所选海盗的扫荡次数已完成'};
}
export async function runPirateSweeps(client,config,player,{getSettings,ledger,enabled,report,scheduler}){
 if(!enabled()||active.has(client))return;
 active.add(client);
 const title='海盗日常扫荡',emit=e=>report({...e,label:e.label??title,taskKey:'pirate'});
 try{
  for(let attempts=0;attempts<100&&enabled();attempts++){
   const settings=getSettings(),records=ledger.keyRecords(),state=await readPirateSweeps(client,config,player,settings,records);
   const prefix='pirate-sweep:'+state.world+':';
   for(const [key,r]of Object.entries(records))if(key.startsWith(prefix)&&!r.confirmed&&r.details?.day===state.day&&valid(state.used)&&state.used>r.details.used)ledger.resolveKey(key,true);
   if(state.reason){emit({skipped:true,...(state.pending?{status:'pending'}:{}),reason:state.reason});if(state.left===0)scheduler?.defer('pirate',scheduler.nextDay());return;}
   const key=prefix+state.day+':'+state.used;
   if(ledger.hasKey(key)){emit({skipped:true,reason:'本次扫荡次数已记录，等待服务器计数更新'});return;}
   const signature=key+':'+state.target.uid,rejected=rejections.get(client);
   if(rejected?.signature===signature&&rejected.until>Date.now()){emit({skipped:true,reason:'服务器此前拒绝此目标，稍后核对再试'});return;}
   const fresh=await readPirateSweeps(client,config,player,getSettings(),ledger.keyRecords());
   if(!enabled()||getSettings()!==settings||day(now(client))!==state.day||exactAutomationId(player.worldId)!==state.world)return;
   if(fresh.reason||fresh.day!==state.day||fresh.world!==state.world||fresh.used!==state.used||fresh.target?.uid!==state.target.uid||fresh.target.cityId!==state.target.cityId||fresh.type!==state.type||fresh.level!==state.level){emit({skipped:true,reason:fresh.reason||'扫荡前目标或剩余次数已变化，等待重新核对'});return;}
   const ticket=ledger.reserve({pirateSweeps:1},{},{},{uniqueKey:key,details:{kind:'pirateSweep',day:state.day,used:state.used,type:state.type,level:state.level}});
   if(!enabled()){ledger.cancel(ticket);return;}
   try{
    const reply=await client.request('PirateSweepRequest',{uid:fresh.target.uid,cityId:fresh.target.cityId},'GotRewardResponse');
    let after;
    for(let i=0;i<4;i++){
     after=await client.request('AllPirateRequest',{},'AllPirateResponse');
     if(valid(after.sweepTimes)&&after.sweepTimes>state.used)break;
     if(i<3)await new Promise(resolve=>setTimeout(resolve,250));
    }
    if(day(now(client))!==state.day||!reward(reply)||!valid(after?.sweepTimes)||after.sweepTimes<=state.used)throw Error('奖励或每日扫荡次数尚未确认，保留记录等待核对');
    ledger.confirm(ticket);emit({label:title+' · '+state.name+' '+state.level+'级',ok:true,status:'confirmed',reason:'已确认领取奖励，今日已用 '+after.sweepTimes+'/'+state.limit+' 次'});
   }catch(error){const refused=error.prompt&&error.request==='PirateSweepRequest';if(refused){ledger.cancel(ticket);rejections.set(client,{signature,until:Date.now()+300000});}emit({ok:false,status:refused?'rejected':'unknown',error:error.message});return;}
  }
 }finally{active.delete(client);}
}
