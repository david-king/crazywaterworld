import { recordsInWorld, settleFleetSnapshot } from './fleet-settlement.mjs';
import { isFleetReserved, registerFleetReservations } from './fleet-reservations.mjs';

const migrationOwner = 'dispatch-ledger';
export const isMiningSilicon = fleet => fleet?.state === 5 && !!fleet.chipWar && fleet.curGridIdx > 0;
export const fleetStateName = fleet => ({ 1: fleet.curGridIdx > 0 ? '驻守在外' : '空闲', 2: '行军中', 3: '战斗中', 4: '维修中', 5: '排队中' })[fleet.state] || '未知';
// 两代调度器共享舰队占用证据；桥接谓词忽略自身，避免递归检查。
export function bridgeFleetReservations(client, getSettings, ledger, worldId) {
 const contains = id => Boolean(fleetRecordReason(ledger?.keyRecords() ?? {}, id, worldId) ||
  dispatchReservationReason(client, getSettings(), 'legacy', id, {ignoreLegacy:true}));
 const hasAny = () => {
  const ids = new Set(Object.values(recordsInWorld(ledger?.keyRecords() ?? {}, worldId))
   .map(record => record.details?.buildingId).filter(Boolean));
  for (const record of dispatchStates.get(client)?.values() ?? []) for (const id of record.ids) ids.add(id);
  return [...ids].some(contains);
 };
 registerFleetReservations(client, migrationOwner, contains, hasAny);
}
const recordNotes={
 radarSend:'情报派遣待核对', pirateFirst:'首杀战果待确认', worldBoss:'世界Boss首战待核对',
 cityDispatch:'城战派遣待核对', citySlot:'城战派遣待核对', cityRepair:'维修待核对',
 treasureDispatch:'货轮派遣待核对', treasureRepair:'维修待核对', treasureSpeed:'货轮加速待核对',
 siliconDispatch:'硅矿派遣待核对', siliconRepair:'硅矿维修待核对', siliconRetreat:'硅矿撤回待核对',
 siliconSpeed:'硅矿加速待核对', resourceFieldDispatch:'占田派遣待核对', fleetSpeed:'舰队加速待核对'
};
function recordReason(key,r){
  if(r.details.kind==='worldBossLineup'&&r.details.active!==false)return '舰队的世界Boss临时阵容尚待恢复';
  if(r.details.kind==='pirateLineup'&&r.details.active!==false)return '舰队的海盗挑战阵容尚待恢复';
  if(r.details.kind==='pirateFirst'&&r.details.active===false)return '';
  if(r.details.kind==='worldBoss'&&r.details.active===false)return '';
  if(!r.confirmed)return '舰队有结果待确认的任务';
  if(r.details.kind==='worldBoss'&&r.details.active!==false)return '舰队的世界Boss首战尚未结束';
  if(r.details.kind==='siliconDispatch'&&r.details.active!==false)return '舰队的硅矿任务尚未结束';
  if(r.details.kind==='resourceFieldDispatch'&&r.details.active!==false)return '舰队的资源田占领尚未结束';
  if(['siliconRepair','siliconRetreat','siliconSpeed'].includes(r.details.kind)&&r.details.active!==false)return '舰队的硅矿操作尚未结束';
  if(r.details.kind==='radarSend'&&r.details.active!==false)return '舰队的联盟情报尚未结束';
  if(r.details.kind==='pirateFirst'&&!['won','lost'].includes(r.details.outcome))return '舰队的首杀战果尚未确认';
  if(key.startsWith('cityWar:'))return '舰队的城战任务尚未结束';
 return '';
}
// 配置勾选只表示允许使用；持久记录会限制派遣，不能单凭它推断舰队的位置。
export function fleetRecordHold(records,buildingId,worldId){
 for(const [key,r] of Object.entries(recordsInWorld(records??{},worldId))){
  if(r.expired||!r.details||r.details.buildingId!==buildingId)continue;
  const reason=recordReason(key,r);
  if(reason)return {reason,note:recordNotes[r.details.kind]??reason};
 }
 return null;
}
export function fleetRecordReason(records,buildingId,worldId){
 return fleetRecordHold(records,buildingId,worldId)?.reason??'';
}

// 同一连接共享城战时段预留和正在启动的手动首杀；不抢占在途任务。
const dispatchStates = new WeakMap();
export const dispatchLabels={maintenance:'战后维修',cityWar:'城战接续',pirateHunt:'海盗首杀',worldBoss:'世界Boss首战',follow:'巨轮跟随',treasure:'巨轮普通参战',radar:'联盟情报',silicon:'硅矿采集',resourceFields:'资源田占领'};
export function reconcileBossFleets(ledger,fleets,worldId){
 if(!Array.isArray(fleets))return;
 if(!worldId){
   const worlds=new Set(Object.keys(ledger.keyRecords()).filter(k=>k.startsWith('world-boss:')).map(k=>k.split(':')[1]));
   if(worlds.size!==1)return;
   [worldId]=worlds;
 }
 settleFleetSnapshot(ledger,{worldId,fleets,kinds:['worldBoss']});
}
export function fleetDispatchView(client,settings,ledger,fleets,worldId){
 const records=ledger.keyRecords(),order=dispatchOrder(settings),time=Date.now();
 return fleets.map(f=>{
  const intents=order.filter(k=>{
   if(k==='radar'&&settings?.radar?.runEnabled===false)return false;
   if(k==='silicon')return settings?.silicon?.enabled&&settings.silicon.fleets?.some(policy=>policy.enabled&&policy.id===f.buildingId);
   if(k==='pirateHunt')return dispatchStates.get(client)?.get(k)?.until>time&&dispatchStates.get(client).get(k).ids.includes(f.buildingId);
   const p=settings[k==='follow'?'treasure':k];
   if(!p?.enabled||k==='follow'&&!p.follow||k==='treasure'&&p.follow)return false;
   return p.fleetIds?.includes(f.buildingId)||k==='worldBoss'&&!p.fleetIds?.length;
  });
  const held=[...(dispatchStates.get(client)??[])].filter(([owner,record])=>record.until>time && record.ids.includes(f.buildingId)
    && (owner!=='cityWar' || cityWarReservationEnabled(settings,f.buildingId)));
  const reservationNotes=held.map(([owner,record])=>owner==='cityWar' ? cityWarReservationNote(record.notes[f.buildingId]) : '预留给'+dispatchLabels[owner]);
  const hold=fleetRecordHold(records,f.buildingId,worldId);
  const reason=hold?.reason|| (f.state!==1||f.curGridIdx||f.treasureLootUid||f.chipWar?.rewardTs?'舰队已有在途或驻守任务':'');
  return {buildingId:f.buildingId,intents:intents.map(k=>({key:k,label:dispatchLabels[k]})),reserved:held.map(([owner])=>dispatchLabels[owner]),reservationNotes,reason,recordNote:hold?.note??'',targetGrid:f.state===2?f.targetGridIdx:f.curGridIdx||null};
 });
}
export const dispatchOrder = settings => [...new Set([...(settings?.fleetDispatch?.priority ?? []),'cityWar','pirateHunt','worldBoss','follow','treasure','radar','silicon','resourceFields'])];
export function reserveDispatch(client, task, ids, until = Date.now()+60000, notes = {}) {
 const state=dispatchStates.get(client)??new Map();dispatchStates.set(client,state);
 state.set(task,{ids:[...ids],until,notes:{...notes}});
}
export function legacyFleetReservationReason(client,id) {
 return isFleetReserved(client,id,migrationOwner) ? '舰队有原自动任务尚未确认结束' : '';
}
export function cityWarReservationNote(reason) {
 return reason ? '已为城战留队。上次检查时，' + reason : '已为城战留队，暂不参与其他任务';
}
function cityWarReservationEnabled(settings,id) {
 return settings?.cityWar?.enabled && settings.cityWar.reserveDuringWar && settings.cityWar.fleetIds.includes(id);
}
export function dispatchReservationReason(client,settings,task,id,{ignoreOwners=[],ignoreLegacy=false}={}) {
 const legacyReason=ignoreLegacy?'':legacyFleetReservationReason(client,id);
 if(legacyReason)return legacyReason;
 const order=dispatchOrder(settings);
 for(const [owner,record] of dispatchStates.get(client)??[]) {
  if(ignoreOwners.includes(owner))continue;
  if(owner==='cityWar'&&!cityWarReservationEnabled(settings,id))continue;
  if(owner===task || record.until<=Date.now() || !record.ids.includes(id))continue;
  if(owner==='cityWar')return cityWarReservationNote(record.notes[id]);
  if(owner==='maintenance' || order.indexOf(owner)<(order.includes(task)?order.indexOf(task):order.length))return '舰队预留给'+({maintenance:'战后维修',pirateHunt:'正在运行的首杀',treasure:'巨轮普通参战',follow:'巨轮跟随',worldBoss:'世界Boss首战',radar:'联盟情报',silicon:'硅矿采集',resourceFields:'资源田占领'}[owner]);
 }
 return '';
}
