import { EventEmitter } from 'node:events';
import { defaultSettings } from '../../src/automation-settings.mjs';
import { loadProtocol } from '../../src/proto.mjs';
export function pirateAdvanceFixture({mode='win',types=[1]}={}) {
 const protocol=loadProtocol(),client=new EventEmitter();client.connected=true;client.writes=[];
 const settings=defaultSettings();settings.pirateHunt={...settings.pirateHunt,maxFailures:1,fleetIds:['1远征船'],minDurabilityPercent:80,petrolReserve:0,fuelBudget:3000,checkEverySeconds:5};
 const player={playerId:'123',mainlineStage:10,level:37,worldId:1001001,scenarioId:1};
 const pirateRows=types.flatMap(type=>[1,2,3].map(level=>({season:1,type,level,showName:['','海盗先锋','海盗精锐','海盗头目'][type],power:10000*level})));
 const pirates=pirateRows.map(({type,level})=>({uid:100+100*type+level,type,level,cityId:1,gridIdx:300+100*type+level}));
 const config={tables:{ModuleOpenCfg:{data:[{moduleId:'世界',playerLevel:16}]},WorldPirateCfg:{data:pirateRows},'1_SeasonTaskCfg':{data:[{season:1,stage:1,maxPirateLevel:3}]},'1_CityCfg':{data:[{id:1,name:'试验岛'}]},WorldParamCfg:{data:[{paramName:'打野怪消耗汽油',paramValue:300}]},HeroCfg:{data:[{id:'瑞文',name:'骑士瑞文'}]}}};
 const fleet={buildingId:'1远征船',state:1,durability:1000,maxDura:1000,power:100000,curGridIdx:0,autoFight:{isOn:true}};
 const building={buildingId:fleet.buildingId,level:1,fleet:{formation:{presetId:1,heroPositions:[{heroId:'瑞文',pos:{x:1,y:1}}]}}};
 config.tables.FormationTypePositionCfg={data:[{id:1,position:[1,1]},{id:1,position:[2,1]}]};
 config.tables.FormationHeroNumCfg={data:[{mainlineStage:0,heroNum:1}]};
 const defaultFormation=structuredClone(building.fleet.formation);
 const state={level:0,levels:{},pirates,fuel:3000,stage:1,mode,floaters:[{floaterId:'深海宝箱1',num:1},{floaterId:'塑料垃圾1',num:3}],reads:[]};
 client.request=async(name,body={},response)=>{
  state.reads.push(name);if(protocol[name])protocol[name].decode(protocol[name].encode(body).finish());
  let data;
  if(name==='GetFormationRequest')data={formation:defaultFormation};
  else if(name==='AllHeroRequest')data={heroes:[{heroId:'瑞文'}]};
  else if(name==='MyFormationPresetRequest')data={ids:[]};
  else if(name==='AllPetRequest')data={pets:[]};
  else if(name==='OnWaterRequest')data={building:[building],floater:state.floaters};
  else if(name==='SeasonTaskStageRequest')data={stage:state.stage};
  else if(name==='UniteWorldsPlanRequest')data={worldIds:[],executeTs:0};
  else if(name==='AllItemRequest')data={items:[{itemId:'汽油',num:state.fuel},{itemId:'RUBY',num:1000}]};
  else if(name==='PirateKillRecordRequest')data={records:types.map(type=>({type,maxKilledLevel:type===1?state.level:state.levels[type]??0}))};
  else if(name==='AllPirateRequest')data={pirates:state.pirates};
  else if(name==='MyFleetsRequest')data={fleets:[fleet]};
  else if(name==='PickUpFloaterRequest'){
   client.writes.push({name,body});
   if(state.pickMode==='unknown')throw Error('打捞超时');
   if(state.pickMode==='denied')data={deniedFloaterIds:body.floaterId};
   else{state.floaters=state.floaters.map(f=>f.floaterId===body.floaterId[0]?{...f,num:f.num-1}:f);data={reward:{asset:[{id:'藏品蓝1碎片',num:1}]},deniedFloaterIds:[]};}
  }else data={};
  if(response && protocol[response])return protocol[response].decode(protocol[response].encode(data).finish());
  return data;
 };
 client.sendWatch=async(name,body)=>{
  protocol[name].decode(protocol[name].encode(body).finish());client.writes.push({name,body});
  if(name==='FleetSaveFormationRequest'){
   if(body.buildingId!==building.buildingId)throw Error('模拟舰队编号错误');
   building.fleet.formation=structuredClone(body.formation);return;
  }
  if(state.mode==='unknown')throw Error('派遣超时');
  const {level,type,gridIdx}=pirates.find(pirate=>pirate.uid===body.uid);state.fuel-=300;
  Object.assign(fleet,{state:2,targetGridIdx:gridIdx,targetCityId:1});client.emit('message',{name:'SCMyFleetUpdate',body:{fleets:[fleet]}});
  if(state.mode==='wait')return;
  Object.assign(fleet,{state:3,curGridIdx:gridIdx});client.emit('message',{name:'SCMyFleetUpdate',body:{fleets:[fleet]}});
  client.emit('message',{name:'SCPirateCampaignEnd',body:{uid:body.uid,isWin:state.mode==='win'}});
  Object.assign(fleet,{state:1,curGridIdx:0,targetGridIdx:0});
  if(state.mode==='win'){
   if(type===1)state.level=level;else state.levels[type]=level;
   client.emit('message',{name:'SCPirateKillRecordUpdate',body:{record:{type,maxKilledLevel:level}}});
  }
 };
 return {client,config,player,settings,state,fleet,building};
}
