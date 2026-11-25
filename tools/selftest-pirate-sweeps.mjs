// 每日免费扫荡专项；只使用隔离账号、协议编解码与虚构计数。
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {EventEmitter} from 'node:events';
import {loadProtocol} from '../src/proto.mjs';
import {defaultSettings,createUsageLedger,importAutomationSettings,SETTINGS_FORMAT} from '../src/automation-settings.mjs';
import {readPirateSweeps,runPirateSweeps} from '../src/pirate-sweeps.mjs';
import {runLoop} from '../src/loop.mjs';
const p=loadProtocol(),root=fs.mkdtempSync(path.join(os.tmpdir(),'pirate-sweep-'));let count=0,serial=0;
const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
function setup(){
 const settings=defaultSettings(),client=new EventEmitter(),player={level:37,worldId:1001001,vip:{vipLevel:3}},events=[],calls=[];client.connected=true;
 const state={used:0,fail:null,cards:[],records:[1,2,3].map(type=>({type,maxKilledLevel:5})),pirates:[1,2,3].flatMap(type=>[4,5,6].map(level=>({uid:type*100+level,type,level,cityId:1})))};
 const config={tables:{ModuleOpenCfg:{data:[{moduleId:'世界',playerLevel:16}]},PirateParamCfg:{data:[{paramName:'每日野怪扫荡次数',paramValue:2}]},VipLevelCfg:{data:[{level:3,effects:[['野怪扫荡次数',1]]}]},MonthCardCfg:{data:[{id:'普通月卡',effectList:[['野怪扫荡次数',2]]}]},WorldPirateCfg:{data:state.pirates.map(t=>({season:1,type:t.type,level:t.level,showName:['','海盗先锋','海盗精锐','海盗头目'][t.type]}))}}};
 client.request=async(n,b={},r)=>{calls.push({n,b});assert(p[n],n);p[n].decode(p[n].encode(b).finish());let value;
  if(n==='AllPirateRequest')value={pirates:state.pirates,sweepTimes:state.used};
  else if(n==='PirateKillRecordRequest')value={records:state.records};
  else if(n==='MonthCardRequest')value={cardItem:state.cards};
  else if(n==='PirateSweepRequest'){if(state.fail==='unknown')throw Error('隔离超时');if(state.fail==='reject')throw Object.assign(Error('隔离拒绝'),{prompt:true,request:n});state.used++;value={reward:{asset:[{id:'木材',num:10}]}};}
  else if(n==='DailyTaskInfoRequest')value={dailyTask:[{id:1010,progress:10,targetProgress:10,rewardClaimed:true}]};
  else throw Error('禁止请求 '+n);
  return p[r].decode(p[r].encode(value).finish());
 };
 const ledger=createUsageLedger('fake',{file:path.join(root,++serial+'.json')}),options={getSettings:()=>settings,ledger,enabled:()=>true,report:e=>events.push(e)};
 return{settings,client,player,config,state,events,calls,ledger,options};
}
await test('三个可选种类分别扫荡最高已首杀等级，仅使用每日次数',async()=>{
 for(const type of ['1','2','3']){const f=setup();Object.assign(f.settings.pirateSweep,{types:[type],['times'+type]:-1});await runPirateSweeps(f.client,f.config,f.player,f.options);const writes=f.calls.filter(c=>c.n==='PirateSweepRequest');assert.equal(writes.length,3);assert(writes.every(c=>c.b.uid===Number(type)*100+5));assert(f.calls.every(c=>['AllPirateRequest','PirateKillRecordRequest','MonthCardRequest','PirateSweepRequest'].includes(c.n)));assert.equal(f.ledger.pendingCounters().pirateSweeps??0,0);}
});
await test('基础VIP和有效月卡次数合并，过期卡不计，永久卡有效',async()=>{const f=setup();f.state.cards=[{type:p.MonthCardType.MONTH_CARD_NORMAL,endTime:Math.floor(Date.now()/1000)-1}];assert.equal((await readPirateSweeps(f.client,f.config,f.player,f.settings)).limit,3);f.state.cards[0].endTime=-1;assert.equal((await readPirateSweeps(f.client,f.config,f.player,f.settings)).limit,5);});
await test('每日次数耗尽时不重复发送；切换种类仍共享今日次数',async()=>{const f=setup();await runPirateSweeps(f.client,f.config,f.player,f.options);f.settings.pirateSweep.types=['2'];await runPirateSweeps(f.client,f.config,f.player,f.options);assert.equal(f.calls.filter(c=>c.n==='PirateSweepRequest').length,3);assert.match(f.events.at(-1).reason,/已用完/);});
await test('没有首杀记录或最高等级目标时等待，不降级或派遣',async()=>{for(const mode of ['no-kill','no-target']){const f=setup();if(mode==='no-kill')f.state.records=[];else f.state.pirates=f.state.pirates.filter(p=>p.level!==5);await runPirateSweeps(f.client,f.config,f.player,f.options);assert(!f.calls.some(c=>c.n==='PirateSweepRequest'));assert(f.events.at(-1).skipped);}});
await test('未知回执持久防重，计数确认后从下一次继续',async()=>{const f=setup();f.state.fail='unknown';await runPirateSweeps(f.client,f.config,f.player,f.options);await runPirateSweeps(f.client,f.config,f.player,f.options);assert.equal(f.calls.filter(c=>c.n==='PirateSweepRequest').length,1);assert.equal(f.ledger.pendingCounters().pirateSweeps,1);f.state.fail=null;f.state.used=1;await runPirateSweeps(f.client,f.config,f.player,f.options);assert.equal(f.state.used,3);assert.equal(f.ledger.pendingCounters().pirateSweeps??0,0);});
await test('明确拒绝释放次数但不跨轮立即重试',async()=>{const f=setup();f.state.fail='reject';await runPirateSweeps(f.client,f.config,f.player,f.options);await runPirateSweeps(f.client,f.config,f.player,f.options);assert.equal(f.calls.filter(c=>c.n==='PirateSweepRequest').length,1);assert.equal(f.ledger.pendingCounters().pirateSweeps??0,0);});
await test('关闭开关不执行，预览不写次数记录',async()=>{const f=setup();await runPirateSweeps(f.client,f.config,f.player,{...f.options,enabled:()=>false});assert.equal(f.calls.length,0);await readPirateSweeps(f.client,f.config,f.player,f.settings);assert.deepEqual(f.ledger.keyRecords(),{});assert.equal(f.state.used,0);});
await test('海盗扫荡只按海盗开关和扫荡选择执行',async()=>{
 for(const [master,sweep,dailies,expected] of [[true,true,false,3],[false,true,true,0],[true,false,true,0]]){
  const f=setup();
  f.settings.pirate.enabled=master;
  f.settings.schedule.pirate=sweep;
  f.settings.loop.dailies=f.settings.dailies.enabled=dailies;
  await runLoop(f.client,p,{config:f.config,player:f.player,rounds:1,allowMutate:true,isEnabled:k=>k==='pirate',getSettings:()=>f.settings,usageLedger:f.ledger});
  assert.equal(f.state.used,expected);
  assert(!f.calls.some(c=>c.n==='DailyTaskInfoRequest'));
 }
});
await test('旧配置补默认先锋，保留连败上限及原扫荡开关',()=>{const s=defaultSettings();delete s.pirateSweep;s.schedule.pirate=false;s.pirateHunt.maxFailures=2;const next=importAutomationSettings({format:SETTINGS_FORMAT,version:1,settings:s});assert.deepEqual(next.pirateSweep,defaultSettings().pirateSweep);assert.equal(next.schedule.pirate,false);assert.deepEqual(next.pirateHunt,s.pirateHunt);});
const targets=f=>f.calls.filter(c=>c.n==='PirateSweepRequest').map(c=>c.b.uid);
const sweep=f=>runPirateSweeps(f.client,f.config,f.player,f.options);
await test('首杀未结算时为本类保留固定次数或应分余额，其他类型仍可扫荡',async()=>{
 for (const times1 of [2, -1]) {
  const f = setup();
  f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
  Object.assign(f.settings.pirateSweep, { types: ['1','2'], times1, times2: -1 });
  f.ledger.reserve({piratePetrol:300}, {}, {}, {uniqueKey:'pirate-first:1001001:1:6:106',
   details:{kind:'pirateFirst', world:'1001001', type:1, level:6, sentAt:Date.now(), outcome:'started'}});
  await sweep(f);
  assert.deepEqual(targets(f), [205]);
  assert.match(f.events.at(-1).reason, /等待海盗先锋 6级首杀战果/);
  f.state.records[0].maxKilledLevel = 6;
  await sweep(f);
  assert.deepEqual(targets(f), [205,106,106]);
 }
});
await test('首杀已推送胜利时等待个人记录同步，超时或关闭首杀后按当前等级扫荡',async()=>{
 const f = setup();
 f.settings.pirate.enabled = f.settings.pirateHunt.enabled = true;
 const key = 'pirate-first:1001001:1:6:106';
 const details = {kind:'pirateFirst', world:'1001001', type:1, level:6, sentAt:Date.now(), outcome:'won'};
 const records = {[key]: {confirmed:true, details}};
 const preview = () => readPirateSweeps(f.client,f.config,f.player,f.settings,records);
 assert.equal((await preview()).pending,true);
 f.state.records[0].maxKilledLevel = 6;
 assert.equal((await preview()).target.uid,106);
 f.state.records[0].maxKilledLevel = 5;
 details.outcome = 'unknown';
 f.client.serverClockOffsetMs = 16*60000;
 assert.equal((await preview()).target.uid,105);
 f.client.serverClockOffsetMs = 0;
 f.settings.pirateHunt.enabled = false;
 assert.equal((await preview()).target.uid,105);
});
await test('固定次数优先，外部扫荡只扣共享次数，全部配完后保留余额',async()=>{
 for(const [settings,used,expected] of [
  [{types:['3','2','1'],times1:1,times2:1,times3:-1},1,[105,205]],
  [{types:['1','2','3'],times1:0,times2:1,times3:1},0,[205,305]],
  [{types:['3','1'],times1:2,times3:2},0,[105,105,305]],
  [{types:['1','2','3'],times1:-1,times2:1,times3:-1},0,[205,105,305]],
  [{types:[]},0,[]],
 ]){
  const f=setup();Object.assign(f.settings.pirateSweep,settings);f.state.used=used;
  await sweep(f);await sweep(f);assert.deepEqual(targets(f),expected);
 }
});
await test('固定目标暂缺时保留次数，余额可先扫，地图刷新后补齐',async()=>{
 const f=setup(),all=f.state.pirates;
 Object.assign(f.settings.pirateSweep,{types:['1','2'],times1:2,times2:-1});
 f.state.pirates=all.filter(row=>row.uid!==105);
 await sweep(f);assert.deepEqual(targets(f),[205]);
 assert.match(f.events.at(-1).reason,/等待地图刷新海盗先锋/);
 f.state.pirates=all;await sweep(f);assert.deepEqual(targets(f),[205,105,105]);
});
await test('未知回执重启后仍占本类次数，预览与执行选择相同，次日重新分配',async()=>{
 const f=setup(),file=path.join(root,'restart.json');
 f.options.ledger=createUsageLedger('isolated',{file});
 Object.assign(f.settings.pirateSweep,{types:['1','2'],times1:1,times2:1});
 f.state.fail='unknown';await sweep(f);
 f.options.ledger=createUsageLedger('isolated',{file});await sweep(f);assert.deepEqual(targets(f),[105]);
 f.state.fail=null;f.state.used=1;
 const preview=await readPirateSweeps(f.client,f.config,f.player,f.settings,f.options.ledger.keyRecords());
 assert.equal(preview.type,2);assert.deepEqual(preview.allocations.map(row=>row.used),[1,0]);
 await sweep(f);assert.deepEqual(targets(f),[105,205]);
 f.client.serverClockOffsetMs=86400000;f.state.used=0;
 f.options.ledger=createUsageLedger('isolated',{file,now:()=>Date.now()+86400000});
 await sweep(f);assert.deepEqual(targets(f),[105,205,105,205]);
});
console.log('海盗免费扫荡专项 '+count+'/'+count+' 通过');
