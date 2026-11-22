import {recordsInWorld, checkFleetSettlement, settleFleetSnapshot} from './fleet-settlement.mjs';
import { fleetRecordReason, reserveDispatch, dispatchReservationReason } from './fleet-availability.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectHunt, pirateTypePlan, startPirateHunt } from './pirates.mjs';
import { normalize } from './worlds.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';
import { recoverFleetLineups, releaseLostPirateDispatch } from './fleet-lineups.mjs';

function otherFleetRecords(ledger, lineupKeys) {
 const records=ledger.keyRecords();
 for(const key of lineupKeys)delete records[key];
 return records;
}

// 汽油确认与终态在同一次账本写入中完成。迟到的行军消息不能覆盖已确认的战果。
export function savePirateOutcome(ledger, key, event, dispatchId) {
 const record = ledger.keyRecords()[key];
 if (!record || record.expired || (dispatchId && record.id!==dispatchId)) return;
 if (['won','lost'].includes(record.details?.outcome)) return record.details.outcome;
 const details = { ...record.details, outcome:event.status };
 if (event.arrivalAt) details.arrivalAt = event.arrivalAt;
 if (event.ownBattle) details.ownBattle = true;
 if (event.battleAt) details.battleAt = event.battleAt;
 if (['started','won','lost'].includes(event.status)) ledger.resolveKey(key, true, details);
 else ledger.updateKeyDetails(key, details);
 return event.status;
}

// 单次手动首杀与连续推进共用持久记录，防止回包延迟时其他玩法抢用同一队。
export async function runSinglePirateHunt(client,config,player,{targetKey,fleetKey,preset,enabled,getSettings,ledger,report,prepareDispatch=async()=>{}}) {
 let ticket,key;
 const update=event=>{
  if(key) savePirateOutcome(ledger,key,event,ticket?.id);
  report?.(event);
 };
 try{
  if(enabled()&&client.connected!==false)await checkFleetSettlement(client,player,ledger);
  const result=await startPirateHunt(client,config,player,{targetKey,fleetKey,preset,ledger,prepareDispatch,enabled,report:update,
   reservationReason:fleet=>dispatchReservationReason(client,getSettings(),'pirateHunt',fleet.buildingId),async beforeSend({view,target,fleet,lineupKeys}){
   await prepareDispatch();
   if(!enabled() || client.connected===false)throw Object.assign(Error('账号已暂停或断开，出征已取消'),{notSent:true});
   const settings=getSettings();
   const reason=fleetRecordReason(otherFleetRecords(ledger,lineupKeys),fleet.buildingId,String(normalize(player.worldId)))||dispatchReservationReason(client,settings,'pirateHunt',fleet.buildingId);
   if(reason)throw Error(reason);
   if(view.fuel-pendingPetrol(ledger)<view.fuelPerFleet)throw Error('可用汽油不足以出征');
   const world=String(normalize(player.worldId));key='pirate-first:'+world+':'+target.type+':'+target.level+':'+target.uid;
   releaseLostPirateDispatch(ledger,key);
   ticket=ledger.reserve({piratePetrol:view.fuelPerFleet},{},{},{uniqueKey:key,details:{kind:'pirateFirst',world,type:target.type,level:target.level,uid:target.uid,grid:target.gridIdx,scenarioId:player.scenarioId||1,sentAt:Date.now()+(client.serverClockOffsetMs||0),buildingId:fleet.buildingId,outcome:'sent'}});
   return {...ticket,key};
  }});
  update(result);return result;
 }catch(error){if(ticket&&(error.prompt&&error.request==='ChallengePirateRequest'||error.notSent===true))ledger.cancel(ticket);throw error;}
}

const sameOptions=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function pirateAutoDay(ledger, player, checkpoint) {
 if (!ledger?.snapshot) throw Error('未取得首杀出征确认记录');
 const {day, counters} = ledger.snapshot();
 const counter = 'pirateAutoRuns' + normalize(player.worldId);
 const scope = counter + ':' + day;
 const ownsRun = checkpoint?.scope === scope && checkpoint.started;
 return {day, counter, scope, reason: counters[counter] && !ownsRun ? '今日已执行过一轮海盗自动首杀，明日再试' : ''};
}

export function selectPirateAdvance(snapshot,options,{pendingFuel=0,firstSelection,autoState}={}) {
 const view=snapshot.view;
 const plan=pirateTypePlan(view.typeProgress,options,autoState);
 if(plan.done)return{completed:true,reason:plan.done};
 if(view.locked || view.reason) return{reason:view.reason||'世界尚未开放'};
 if(autoState && !plan.current)return{reason:'当前赛季的海盗首杀进度尚未确认'};
 const targets=view.targets.filter(t=>(!firstSelection || firstSelection.targetKey===t.targetKey) &&
  (autoState ? t.type===plan.current.type : !options.types?.length || options.types.includes(String(t.type))));
 if(!targets.length && autoState)return{reason:'等待地图刷新'+plan.current.name+' '+(plan.current.cleared+1)+' 级目标'};
 if(!targets.length)return{reason:firstSelection?'所选目标已变化，请刷新后再挑战':'当前没有所选类型的下一等级海盗'};
 const target=targets.filter(t=>!t.reason).sort((a,b)=>a.level-b.level || a.type-b.type)[0];
 if(!target)return{reason:targets[0].reason||'没有可派遣目标'};
 const candidates=view.fleets.filter(f=>options.fleetIds.includes(f.buildingId) && (!firstSelection || firstSelection.fleetKey===f.key));
 const fleet=candidates.find(f=>!f.reason && f.durability>0 && (options.minDurabilityPercent===undefined ||
  Number.isSafeInteger(f.maxDura) && f.maxDura>0 && f.durability>=Math.ceil(f.maxDura*options.minDurabilityPercent/100)));
 if(!fleet)return{reason:candidates.find(f=>f.reason)?.reason||'所选舰队未就绪或耐久低于设置阈值'};
 if(!Number.isSafeInteger(pendingFuel)||pendingFuel<0)return{reason:'未确认出征的汽油占用异常'};
 if(view.fuel-pendingFuel<view.fuelPerFleet)return{reason:'可用汽油不足以出征'};
 return{target,fleet,cost:view.fuelPerFleet,nextTypeName:plan.next?.name};
}
export async function runPirateAdvance({client,config,player,options,ledger,getSettings,optionsCurrent=()=>sameOptions(options,getSettings().pirateHunt),firstSelection,preset,enabled,schedule=fn=>fn(),signal,onState=()=>{},sleep=ms=>delay(ms,undefined,{signal}),now=Date.now,prepareDispatch=async()=>{},checkpoint={},dailyRun,oneCheck=false,maxFailures=options.maxFailures??1}) {
 const world=String(normalize(player?.worldId));
 if(!/^[1-9]\d*$/.test(world) || !options.fleetIds.length)throw Error('请先设置参与海盗首杀的舰队');
 if(!ledger?.reserve)throw Error('未取得首杀出征确认记录');
 const prefix='pirate-first:'+world+':';
 const state=checkpoint.state??={wins:0,failures:0,spent:0,target:null,reason:'正在检查首杀目标'};
 let active=checkpoint.active??null, fuelCeiling=checkpoint.fuelCeiling??null;
 if(!Number.isSafeInteger(maxFailures)||maxFailures<1||maxFailures>100)throw Error('海盗失败停止次数必须为1–100的整数');
 const live=()=>!signal?.aborted && enabled() && optionsCurrent() && String(normalize(player.worldId))===world
  && (!dailyRun || ledger.snapshot().day===dailyRun.day);
 const stopLabel=dailyRun?'今日海盗自动首杀已停止，明日再试':'本次首杀推进已停止，重新开启后可继续';
 const autoState=dailyRun ? state : undefined;
 const recordType=()=>{
  if(!autoState)return;
  if(state.type!==active.type)state.failures=0;
  state.type=active.type;
  state.typeName=active.name;
  state.nextTypeName=active.nextTypeName;
 };
 const stopFailedType=()=>{
  if(autoState){
   state.failedTypes??=[];
   if(state.failedTypes.includes(state.type))return;
   state.failedTypes.push(state.type);
  }
  state.reason=(state.typeName??'')+'连续战败 '+state.failures+' 次，达到失败停止次数';
  if(autoState && state.nextTypeName){
   state.reason+='，下一类挑战'+state.nextTypeName;
  }else{
   state.halted=true;
   state.reason+='，'+stopLabel;
  }
 };
 const publish=()=>onState({...state});
 const countOutcome=outcome=>{
  if(!active || active.counted || !['won','lost'].includes(outcome))return;
  active.counted=true;
  recordType();
  if(outcome==='won'){
   state.wins++;
   state.failures=0;
  }else state.failures++;
  const limit=dailyRun ? getSettings()?.pirateHunt?.maxFailures ?? maxFailures : maxFailures;
  if(state.failures>=limit)stopFailedType();
  else if(state.halted)state.reason=(outcome==='won'?'已确认首杀成功':'已确认首杀战败')+'；'+stopLabel;
 };
 const activeOutcome=record=>record?.id===active.id ? record.details?.outcome??active.result : active.result;
 const update=(key,event,dispatchId)=>{
  try {
   const outcome=savePirateOutcome(ledger,key,event,dispatchId);
   if(outcome && active?.key===key && active.id===dispatchId){
    active.result=outcome;
    if(dailyRun)countOutcome(outcome);
   }
  } catch(error){state.reason='首杀记录保存失败：'+error.message;}
 };
 try {
 if(!state.halted && state.failures>=maxFailures)stopFailedType();
 if(state.halted){
  // 停止继续派遣不等于停止结算；迟到战果仍须释放城战等玩法需要的舰队。
  await schedule(async()=>{
   if(!live())return;
   await checkFleetSettlement(client,player,ledger);
   if(active)countOutcome(activeOutcome(ledger.keyRecords()[active.key]));
  });
  publish();return state;
 }
 while(!signal?.aborted) {
  reserveDispatch(client,'pirateHunt',options.fleetIds,Date.now()+Math.max(60000,options.checkEverySeconds*3000));
  if(!enabled()){state.reason='账号已暂停或断开';break;}
  if(!optionsCurrent()){state.reason='首杀参数已修改，请重新开启推进';break;}
  const result=await schedule(async()=>{
   if(!live())return{stop:'执行条件已变化，停止推进'};
   await checkFleetSettlement(client,player,ledger);
   if(!live())return{stop:'执行条件已变化，停止推进'};
   if(preset)await recoverFleetLineups(client,player,ledger,{enabled:live});
   await prepareDispatch();
   const baseline=ledger.keyRecords();
   const snap=await inspectHunt(client,config,player,false,Boolean(preset),{advanceOptions:options,autoState,skipCapped:Boolean(dailyRun && !active)});
   if(!live())return{stop:'执行条件已变化，停止推进'};
   if(snap.doneReason && !active)return{stop:snap.doneReason,completed:true};
   if(!Array.isArray(snap.records)||!Array.isArray(snap.ownFleets))return{stop:snap.view.reason||'首杀记录或舰队信息不完整'};
   for(const [key,record]of Object.entries(ledger.keyRecords()).filter(([key])=>key.startsWith(prefix))) {
    const d=record.details;
    if(d && snap.records.some(r=>r.type===d.type && r.maxKilledLevel>=d.level))update(key,{status:'won'},record.id);
   }
   settleFleetSnapshot(ledger,{worldId:world,fleets:snap.ownFleets,kills:snap.records,
    now:Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000),kinds:['pirateFirst'],baseline});
   if(active) {
    const record=ledger.keyRecords()[active.key],outcome=activeOutcome(record);
    if(outcome==='unknown'){state.halted=true;return{stop:'出征或战果未确认，已停止并保留派遣记录'};}
    if(record?.details?.active===false&&!['won','lost'].includes(outcome)){state.halted=true;return{stop:'舰队已归队，首杀战果仍待确认，已停止推进并保留派遣记录'};}
    const fleet=snap.ownFleets.find(f=>f.buildingId===active.buildingId);
    if(outcome==='won'||outcome==='lost') {
     countOutcome(outcome);
     if(state.halted)return{stop:state.reason};
     if(dailyRun && snap.doneReason)return{stop:snap.doneReason,completed:true};
     if(fleet?.state===1 && !fleet.curGridIdx && !fleet.treasureLootUid && !fleet.chipWar?.rewardTs){active=null;}
     else {
      if(outcome==='won')state.reason='已确认首杀，等待舰队回城';
      else if(autoState?.failedTypes?.includes(active.type))state.reason='等待舰队回城后挑战'+state.nextTypeName;
      else state.reason='战败 '+state.failures+'/'+maxFailures+' 次，等待舰队回城后重试';
      return{wait:true};
     }
    } else {
     if(now()-active.sentAt>900000){state.halted=true;return{stop:'等待战果超时，已停止并保留派遣记录'};}
     state.reason=outcome==='started'||outcome==='ended'?'等待个人首杀记录更新':'等待服务器确认出征';return{wait:true};
    }
   }
   const unresolved=Object.values(ledger.keyRecords()).find(r=>r.details?.kind==='pirateFirst' && String(r.details.world)===world && !['won','lost'].includes(r.details.outcome));
   if(unresolved)return{stop:'前次首杀出征结果仍待确认，禁止重复派遣'};
   if(fuelCeiling!==null && Number.isSafeInteger(snap.view.fuel))snap.view.fuel=Math.min(snap.view.fuel,fuelCeiling);
   for(const f of snap.view.fleets)f.reason ||= fleetRecordReason(ledger.keyRecords(),f.buildingId,world) || dispatchReservationReason(client,getSettings(),'pirateHunt',f.buildingId);
   const picked=selectPirateAdvance(snap,options,{pendingFuel:pendingPetrol(ledger),firstSelection,autoState});
   if(picked.reason)return{stop:picked.reason,completed:picked.completed};
   const {target,fleet}=picked;
   const key=prefix+target.type+':'+target.level+':'+target.uid;
   let ticket,quotedFuel;
   const label=fleet.name+' → '+target.name+' '+target.level+'级';state.target=label;
   try {
    const reply=await startPirateHunt(client,config,player,{targetKey:target.targetKey,fleetKey:fleet.key,preset,ledger,prepareDispatch,enabled:live,
     reservationReason:raw=>dispatchReservationReason(client,getSettings(),'pirateHunt',raw.buildingId),
     async beforeSend({view,target:reviewed,fleet:raw,fleetKey,lineupKeys}) {
      await prepareDispatch();
      if(!live())throw Object.assign(Error('执行条件已变化，停止推进'),{notSent:true});
      const records=otherFleetRecords(ledger,lineupKeys);
      for(const f of view.fleets)f.reason ||= fleetRecordReason(records,f.buildingId,world) || dispatchReservationReason(client,getSettings(),'pirateHunt',f.buildingId);
      if(fuelCeiling!==null && Number.isSafeInteger(view.fuel))view.fuel=Math.min(view.fuel,fuelCeiling);
      const check=selectPirateAdvance({view},options,{pendingFuel:pendingPetrol(ledger),autoState,firstSelection:firstSelection && {...firstSelection,fleetKey}});
      if(check.reason || check.target?.uid!==reviewed.uid || check.fleet?.buildingId!==raw.buildingId || !live())throw Error(check.reason||'首杀目标或舰队已变化');
      if(Object.values(recordsInWorld(ledger.keyRecords(),world)).some(r=>!r.expired && r.details?.buildingId===raw.buildingId && (!r.confirmed||r.details?.kind==='radarSend'&&r.details.active!==false)))throw Error('舰队还有待确认任务');
      quotedFuel=view.fuel;
      // 首次出征与当日轮次一起占用，明确未发送时由同一张票据退回。
      const firstToday=dailyRun && !checkpoint.started;
      const counters={piratePetrol:view.fuelPerFleet}, limits={};
      if(firstToday){
       const {reason}=pirateAutoDay(ledger,player,checkpoint);
       if(reason)throw Error(reason);
       counters[dailyRun.counter]=1;
       limits[dailyRun.counter]=1;
      }
      releaseLostPirateDispatch(ledger,key);
      ticket=ledger.reserve(counters,limits,{},{uniqueKey:key,details:{kind:'pirateFirst',world,type:target.type,level:target.level,uid:target.uid,grid:reviewed.gridIdx,scenarioId:player.scenarioId||1,sentAt:Date.now()+(client.serverClockOffsetMs||0),buildingId:raw.buildingId,outcome:'sent'}});
      if(dailyRun && ticket.day!==dailyRun.day)throw Object.assign(Error('已换日，等待重新检查海盗首杀'),{notSent:true});
      active={key,id:ticket.id,type:target.type,name:target.name,nextTypeName:check.nextTypeName,buildingId:raw.buildingId,sentAt:now(),result:'sent',counted:false};
      return {...ticket,key};
     },report:event=>update(key,event,ticket?.id)});
    firstSelection=null;
    if(dailyRun){checkpoint.started=true;recordType();}
    state.spent+=picked.cost;fuelCeiling=quotedFuel-picked.cost;update(key,reply,ticket.id);
    if(state.halted)return{stop:state.reason};
    if(autoState?.failedTypes?.includes(target.type))return{wait:true};
    if(reply.status==='unknown'){
     if(dailyRun)state.halted=true;
     return{stop:reply.label};
    }
    state.reason=reply.label;return{wait:true};
   } catch(error){if(ticket && (error.prompt&&error.request==='ChallengePirateRequest' || error.notSent===true)){ledger.cancel(ticket);active=null;}return{stop:error.message};}
  });
  if(result.stop){
   state.reason=result.stop;
   if(dailyRun && checkpoint.started && result.completed){state.halted=true;state.reason+='，'+stopLabel;}
   publish();break;
  }
  publish();if(oneCheck)break;await sleep(options.checkEverySeconds*1000);
 }
 if(signal?.aborted)state.reason=signal.reason?.message||'已停止首杀推进';
 publish();return state;
 } finally { checkpoint.active=active;checkpoint.fuelCeiling=fuelCeiling;reserveDispatch(client,'pirateHunt',[]); }
}
export function createPirateAdvanceTask() {
 let controller=null;let state={running:false,stopping:false,wins:0,spent:0,target:null,reason:''};
 const view=()=>({...state});
 return{view,start(options,open,report,maxFailures=1){
  if(controller)throw Error('当前账号已在推进海盗首杀');
  if(!options.fleetIds.length)throw Error('请选择出征舰队');
  if(!Number.isSafeInteger(maxFailures)||maxFailures<1||maxFailures>100)throw Error('海盗失败停止次数必须为1–100的整数');
  controller=new AbortController();const signal=controller.signal;
  state={running:true,stopping:false,wins:0,spent:0,target:null,maxFailures,checkEverySeconds:options.checkEverySeconds,reason:'正在检查首杀条件'};
  (async()=>{try{const context=await open();await runPirateAdvance({...context,options:structuredClone(options),optionsCurrent:()=>true,maxFailures,signal,onState:update=>{Object.assign(state,update);report?.(view());}});}catch(error){state.reason=signal.aborted?signal.reason.message:error.message;}finally{state.running=state.stopping=false;controller=null;report?.(view());}})();return view();
 },stop(reason='已手动停止首杀推进'){if(controller){state.stopping=true;controller.abort(new Error(reason));}return view();}};
}
