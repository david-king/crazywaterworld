import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, validateSettings, importAutomationSettings, loadAutomationSettings, createUsageLedger, saveAutomationSettings } from '../src/automation-settings.mjs';
import { readTrialSweeps, executeTrialSweep, runExtraTrialSweeps } from '../src/trial-sweeps.mjs';
import { trialModesFixture } from './fixtures/trial-modes.mjs';
import { runLoop } from '../src/loop.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';
const parent=path.join(os.tmpdir(),'cw-trial-modes-tests');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'run-'));process.env.CW_DATA_DIR=dir;
const results=[];let n=0;const ledger=()=>createUsageLedger('qa',{file:path.join(dir,'ledger-'+n+++'.json')});
const read=(f,l=ledger(),id=1)=>readTrialSweeps(f.client,f.protocol,f.config,f.player,f.settings,id,{channel:f.channel,usage:l.snapshot(),records:l.keyRecords(),pendingDiamonds:l.pendingCounters().diamonds??0});
const run=(f,l,mode='paid',options={})=>executeTrialSweep(f.client,f.protocol,f.config,f.player,1,mode,{getSettings:()=>f.settings,ledger:l,channel:f.channel,...options});
const check=async(name,work)=>{try{await work();results.push({name,passed:true});console.log('通过：'+name);}catch(e){results.push({name,passed:false,error:e.stack});console.error('失败：'+name+'\n'+e.stack);}};
try{
 await check('益世界旧版与小程序均可按免广告权益扫荡，回读次数后确认',async()=>{
  for(const channel of ['17001784','1400']) for(const privilege of ['vip','首充']){
   const f=trialModesFixture();
   if(channel==='17001784'){
    Object.assign(f.channel.clientInfo,{channelId:channel,appId:'14021102',originVersion:'1.9.4.434'});
    f.config.tables.AdvChannelCfg.data.push({key:channel,isOpen:true,minAppVersion:'1.11.6'});
   }
   Object.assign(f.player,{channelId:channel,appId:f.channel.clientInfo.appId});
   if(privilege==='首充'){f.player.vip.vipLevel=1;f.state.firstCharge=[{chargedId:'test',gotStage:[]}];}
   const before=await read(f);
   assert.equal(before.adWaitMs,0);assert.equal(before.adLeft,1);
   const result=await run(f,ledger(),'ad');
   assert.equal(result.ok,true);
   assert.equal((await read(f)).adLeft,0);
   assert.equal(f.state.ruby,1000);
  }
 });
 await check('益世界按每日次数和角色权益判断广告扫荡',async()=>{
  for(const kind of ['次数用完','首充响应不完整']){
   const f=trialModesFixture();
   Object.assign(f.channel.clientInfo,{channelId:'17001784',appId:'14021102',clientVersion:'1.12.11',originVersion:'1.9.4.434'});
   f.config.tables.AdvChannelCfg.data.push({key:'17001784',isOpen:true,minAppVersion:'1.11.6'});
   if(kind==='首充响应不完整')f.player.vip.vipLevel=1;
   if(kind==='次数用完')f.state.adv.find(row=>row.id===4).gotTimes=1;
   if(kind==='首充响应不完整'){
    const request=f.client.request.bind(f.client);
    f.client.request=(name,...args)=>name==='FirstChargeRequest'?{}:request(name,...args);
   }
   const result=await run(f,ledger(),'ad');
   assert.equal(result.skipped,true,kind);
   const reason={'次数用完':/次数已用完/,'首充响应不完整':/权益未确认/};
   assert.match(result.reason,reason[kind]);
   assert.deepEqual(f.state.writes,[]);
  }
 });
 await check('无免广告权益账号不受客户端应用 ID、语言和角色渠道限制，按等待流程扫荡',async()=>{
  for(const mismatch of [false,true]){
   const f=trialModesFixture();
   Object.assign(f.channel.clientInfo,{channelId:'17001784',appId:'14021102',clientVersion:'1.12.11',originVersion:'1.9.4.434'});
   f.config.tables.AdvChannelCfg.data.push({key:'17001784',isOpen:true,minAppVersion:'1.11.6'});
   f.player.vip.vipLevel=1;f.settings.ads.waitSeconds=0.01;
   if(mismatch){f.player.channelId='1400';f.player.appId='14021170';f.channel.language='en';}
   const result=await run(f,ledger(),'ad');
   assert.equal(result.ok,true,mismatch?'客户端身份不一致':'客户端身份一致');
   assert.deepEqual(f.state.writes.map(row=>row.name),['WatchAdvRequest','TrialRaidBuySweepRequest']);
  }
 });
 await check('旧设置原值保留，新钻石/广告开关关闭，导入及加载不改旧文件',()=>{
  const old=validateSettings(defaultSettings());delete old.trials;delete old.schedule.trialPaidSweep;delete old.schedule.trialAdSweep;
  const file=path.join(dir,'old.json');fs.writeFileSync(file,JSON.stringify({version:1,accounts:{qa:{settings:old,revision:24}}}));const bytes=fs.readFileSync(file);
  const loaded=loadAutomationSettings('qa',{file});assert.equal(loaded.settings.trials.paid,false);assert.equal(loaded.settings.trials.ads,false);assert.deepEqual(fs.readFileSync(file),bytes);
  const imported=importAutomationSettings({format:'crazywaterword-automation',version:1,settings:old});assert.deepEqual(imported,loaded.settings);delete imported.trials;delete imported.schedule.trialPaidSweep;delete imported.schedule.trialAdSweep;assert.deepEqual(imported,old);
 });
 await check('首轮免费单独保留，不用钻石/广告开关消费免费档',async()=>{const f=trialModesFixture(),l=ledger();f.state.raids.get(1).buySweepTimes=0;const s=await read(f,l);assert.equal(s.paid.cost,0);assert.equal(s.ad.allowed,false);await run(f,l);await run(f,l,'ad');assert.equal(f.state.writes.length,0);});
 await check('普通上限包括基础、VIP与有效月卡，过期月卡不计入',async()=>{const f=trialModesFixture(),l=ledger();f.player.vip.vipLevel=4;f.state.cards=[{type:1,endTime:-1}];assert.equal((await read(f,l)).normalLimit,7);f.state.cards[0].endTime=1;assert.equal((await read(f,l)).normalLimit,5);f.state.cards=[{type:7,endTime:-1}];assert.equal((await read(f,l)).paid.allowed,false);});
 await check('已用次数超价格表时按客户端末档，费用仍受单次上限',async()=>{const f=trialModesFixture(),l=ledger();f.player.vip.vipLevel=4;f.state.raids.get(1).buySweepTimes=4;assert.equal((await read(f,l)).paid.cost,50);assert.equal((await read(f,l)).paid.allowed,true);f.settings.trials.maxSingleCost=49;assert.equal((await read(f,l)).paid.allowed,false);});
 await check('钻石扫荡费用及全局/试炼/每副本预算均记录，日上限阻断再扫',async()=>{const f=trialModesFixture(),l=ledger();const e=await run(f,l);assert.equal(e.ok,true);assert.equal(f.state.ruby,950);assert.equal(l.snapshot().counters.diamonds,50);assert.equal(l.snapshot().counters.trialDiamonds,50);assert.equal(l.snapshot().counters.trialPaid1,1);await run(f,l);assert.equal(f.state.writes.length,1);});
 await check('钻石总开关、保留量、两个日预算和游戏次数都独立阻断',async()=>{for(const kind of ['switch','reserve','global','trial','count','cap']){const f=trialModesFixture(),l=ledger();if(kind==='switch')f.settings.resources.allowDiamonds=false;if(kind==='reserve')f.settings.resources.diamondThreshold=951;if(kind==='global')f.settings.resources.diamondDailyLimit=49;if(kind==='trial')f.settings.trials.dailyDiamondBudget=49;if(kind==='count')f.state.raids.get(1).buySweepTimes=3;if(kind==='cap')f.settings.trials.paidPerRaidLimit=0;assert.equal((await run(f,l)).skipped,true,kind);assert.equal(f.state.writes.length,0);}});
 await check('未知渠道、低等级、次数用完或未确认时不发送广告准备',async()=>{
  for(const kind of ['channel','level','full','missing']){
   const f=trialModesFixture(),l=ledger();
   if(kind==='channel')f.channel.clientInfo.channelId='999';
   if(kind==='level')f.config.tables.ModuleOpenCfg.data[0].playerLevel=50;
   if(kind==='full')f.state.adv.find(r=>r.id===4).gotTimes=1;
   if(kind==='missing')f.state.adv=[];
   assert.equal((await run(f,l,'ad')).skipped,true,kind);
   assert.equal(f.state.writes.length,0);
  }
 });
 await check('首充记录可确认合法免广告权益，普通次数用尽仍可广告扫荡',async()=>{const f=trialModesFixture(),l=ledger();f.player.vip.vipLevel=1;f.state.firstCharge=[{chargedId:'test',gotStage:[]}];f.state.raids.get(1).buySweepTimes=3;const e=await run(f,l,'ad');assert.equal(e.ok,true);assert.deepEqual(f.state.writes.map(x=>x.name),['WatchAdvRequest','TrialRaidBuySweepRequest']);assert.equal(f.state.writes[0].body.id,4);assert.equal(f.state.writes[1].body.useAdvCard,true);assert.equal(f.state.ruby,1000);assert.equal(l.snapshot().counters.diamonds,undefined);await run(f,l,'ad');assert.equal(f.state.writes.length,2);});
 await check('三个副本使用各自广告ID且共享钻石预算',async()=>{const f=trialModesFixture(),l=ledger();f.settings.trials.dailyDiamondBudget=100;await runExtraTrialSweeps(f.client,f.protocol,f.config,f.player,{getSettings:()=>f.settings,ledger:l,channel:f.channel,enabled:()=>true,report:()=>{}});assert.deepEqual(f.state.writes.filter(x=>x.name==='WatchAdvRequest').map(x=>x.body.id),[4,3,5]);assert.equal(f.state.writes.filter(x=>x.name==='TrialRaidBuySweepRequest'&&!x.body.useAdvCard).length,2);assert.equal(l.snapshot().counters.diamonds,100);});
 await check('手动报价过期不会接受变化后的次数、进度或价格',async()=>{const f=trialModesFixture(),l=ledger(),s=await read(f,l);const expected={passedStage:s.passedStage,buyUsed:s.buyUsed,adUsed:s.adUsed,cost:s.paid.cost,day:s.day};f.state.raids.get(1).passedStage=1021;await assert.rejects(run(f,l,'paid',{manual:true,expected}),/已变化/);assert.equal(f.state.writes.length,0);});
 await check('发送前条件变化或暂停阻止消费，关闭自动不读取',async()=>{const f=trialModesFixture(),l=ledger();f.settings.trials.paid=false;await run(f,l);assert.equal(f.state.reads.length,0);f.settings.trials.paid=true;let reads=0;f.state.onRead=name=>{if(name==='TrialRaidInfoRequest'&&++reads===2)f.state.raids.get(1).buySweepTimes=2;};await run(f,l);assert.equal(f.state.writes.length,0);});
 await check('广告准备后暂停不发送扫荡，不重复准备',async()=>{const f=trialModesFixture(),l=ledger();let enabled=true;f.state.onWatch=()=>{enabled=false;};assert.equal((await run(f,l,'ad',{enabled:()=>enabled})).pending,true);enabled=true;await run(f,l,'ad');assert.equal(f.state.writes.length,1);});
 await check('未知钻石消费持久保留预算，后续实际次数确认才解锁',async()=>{const f=trialModesFixture(),file=path.join(dir,'pending.json');let l=createUsageLedger('qa',{file});f.state.failure='unknown';assert.equal((await run(f,l)).pending,true);l=createUsageLedger('qa',{file});await run(f,l);assert.equal(f.state.writes.length,1);assert.equal(l.pendingCounters().diamonds,50);f.state.failure='';f.state.raids.get(1).buySweepTimes=2;await run(f,l);assert.equal(l.pendingCounters().diamonds,undefined);assert.equal(Object.values(l.keyRecords())[0].confirmed,true);});
 await check('明确拒绝释放预约，未确认次数不报成功，跨日未知不重发',async()=>{const f=trialModesFixture(),l=ledger();f.state.failure='reject';await run(f,l);assert.equal(l.snapshot().counters.diamonds,0);f.state.failure='stale';assert.equal((await run(f,l)).pending,true);f.client.serverClockOffsetMs=86400000;await run(f,l);assert.equal(f.state.writes.length,2);});
 await check('同账号并发只消费一次，大额不精确钻石余额拒绝付费',async()=>{const f=trialModesFixture(),l=ledger();await Promise.all([run(f,l),run(f,l)]);assert.equal(f.state.writes.length,1);const g=trialModesFixture();g.state.ruby='9007199254740993';await run(g,ledger());assert.equal(g.state.writes.length,0);});
 await check('整轮挂机能独立执行新增扫荡，先免广告后钻石',async()=>{const f=trialModesFixture(),l=ledger();await runLoop(f.client,f.protocol,{config:f.config,player:f.player,adChannel:f.channel,allowMutate:true,rounds:1,everyMs:0,getSettings:()=>f.settings,isEnabled:key=>['trialPaidSweep','trialAdSweep'].includes(key),usageLedger:l});assert.equal(f.state.writes.filter(x=>x.name==='TrialRaidBuySweepRequest').length,6);assert.equal(f.state.writes[0].name,'WatchAdvRequest');});
 await check('海兽广告次数耗尽后，连续轮询、暂停恢复及重新连接均无重复请求和日志', async () => {
  const file = path.join(dir, 'exhausted-raid.json');
  async function idle(f, rounds) {
   f.settings.trials.raidIds = [3];
   const logs = [];
   await runLoop(f.client, f.protocol, {
    config: f.config, player: f.player, adChannel: f.channel, allowMutate: true, rounds, everyMs: 0,
    getSettings: () => f.settings, isEnabled: key => key === 'trialAdSweep',
    usageLedger: createUsageLedger('qa', { file }), includeRepeatedWaits: true,
    onStep: entry => { if (entry.taskKey === 'trialAdSweep:3') logs.push(entry); },
   });
   return logs;
  }
  const first = trialModesFixture();
  first.state.adv.find(row => row.id === 5).gotTimes = 1;
  const logs = await idle(first, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0].reason, /次数已用完.*次日 00:00/);
  assert.equal(first.state.reads.filter(row => row.name === 'TrialRaidInfoRequest').length, 1);
  first.state.reads.length = 0;
  assert.deepEqual(await idle(first, 1), []);
  const reconnect = trialModesFixture();
  assert.deepEqual(await idle(reconnect, 2), []);
  for (const f of [first, reconnect]) {
   const trialReads = ['TrialRaidInfoRequest', 'MonthCardRequest', 'AllResourceRequest', 'FirstChargeRequest', 'OnWaterRequest'];
   assert.deepEqual(f.state.reads.filter(row => trialReads.includes(row.name)), []);
   assert.deepEqual(f.state.writes, []);
   const schedule = rewardSchedule(f.client);
   assert.equal(schedule.nextCheck('trialAdSweep:3'), schedule.nextDay());
   assert.match(schedule.status('trialAdSweep').text, /海兽经验副本.*次日 00:00/);
  }
 });
 await check('最后一次广告扫荡回读即生效，次日北京时间零点恢复', async () => {
  const f = trialModesFixture();
  const midnight = Date.parse('2026-11-26T00:00:00+08:00');
  const setClock = time => { f.client.serverClockOffsetMs = time - Date.now(); };
  const l = createUsageLedger('qa', { file: path.join(dir, 'midnight.json'), now: () => Date.now() + f.client.serverClockOffsetMs });
  setClock(midnight - 30_000);
  const last = await run(f, l, 'ad');
  assert.equal(last.ok, true);
  assert.equal(last.nextCheckAt, midnight / 1000);
  f.state.reads.length = 0;
  assert.equal((await run(f, l, 'ad')).cached, true);
  assert.deepEqual(f.state.reads, []);
  const manual = await run(f, l, 'ad', { manual: true });
  assert.equal(manual.skipped, true);
  assert(f.state.reads.some(row => row.name === 'OnWaterRequest'));
  setClock(midnight);
  f.state.adv.find(row => row.id === 4).gotTimes = 0;
  assert.equal((await run(f, l, 'ad')).ok, true);
  assert.equal(f.state.writes.filter(row => row.name === 'TrialRaidBuySweepRequest').length, 2);
 });
 await check('耗尽记录按账号、区服、角色、副本和扫荡方式隔离', async () => {
  const file = path.join(dir, 'trial-scopes.json');
  const l = createUsageLedger('qa', { file });
  const f = trialModesFixture();
  f.state.adv.find(row => row.id === 4).gotTimes = 1;
  assert.match((await run(f, l, 'ad')).reason, /次数已用完/);
  assert.equal((await run(f, l, 'paid')).ok, true);
  assert.equal((await executeTrialSweep(f.client, f.protocol, f.config, f.player, 2, 'ad', {
   getSettings: () => f.settings, ledger: l, channel: f.channel,
  })).ok, true);
  for (const identity of ['account', 'worldId', 'playerId']) {
   const g = trialModesFixture();
   if (identity !== 'account') g.player[identity] = '9007199254740995';
   const scoped = identity === 'account' ? createUsageLedger('another', { file }) : l;
   assert.equal((await run(g, scoped, 'ad')).ok, true, identity);
  }
 });
 await check('查询失败、未决发送和跨日回包继续核对', async () => {
  const f = trialModesFixture(), l = ledger();
  f.state.onRead = name => { if (name === 'OnWaterRequest') throw Error('模拟超时'); };
  assert.match((await run(f, l, 'ad')).reason, /超时/);
  f.state.onRead = null;
  f.state.failure = 'unknown';
  assert.equal((await run(f, l, 'ad')).pending, true);
  f.state.reads.length = 0;
  assert.match((await run(f, l, 'ad')).reason, /待确认/);
  assert(f.state.reads.some(row => row.name === 'OnWaterRequest'));
  f.state.adv.find(row => row.id === 4).gotTimes = 1;
  assert.match((await run(f, l, 'ad')).reason, /次日/);
  assert.equal(l.snapshot().uncertain, 0);
  assert.equal((await run(f, l, 'ad')).cached, true);
  const g = trialModesFixture(), other = ledger();
  g.state.adv.find(row => row.id === 4).gotTimes = 1;
  g.state.onRead = name => { if (name === 'OnWaterRequest') g.client.serverClockOffsetMs = 86400_000; };
  assert.equal((await run(g, other, 'ad')).nextCheckAt, undefined);
  g.state.onRead = null;
  g.state.adv.find(row => row.id === 4).gotTimes = 0;
  assert.equal((await run(g, other, 'ad')).ok, true);
 });
 await check('已知广告用尽仍可核对后来产生的未决钻石扫荡', async () => {
  const f = trialModesFixture(), l = ledger();
  assert.equal((await run(f, l, 'ad')).ok, true);
  f.state.failure = 'unknown';
  assert.equal((await run(f, l, 'paid', { manual: true })).pending, true);
  assert.match((await run(f, l, 'ad')).reason, /待确认/);
  f.state.raids.get(1).buySweepTimes++;
  assert.match((await run(f, l, 'ad')).reason, /次日/);
  assert.equal(l.snapshot().uncertain, 0);
  assert.equal(l.confirmedCounters().trialPaid1, 1);
  f.state.reads.length = 0;
  assert.equal((await run(f, l, 'ad')).cached, true);
  assert.deepEqual(f.state.reads, []);
 });
 await check('保存耗尽记录失败时保留实际扫荡结果，下轮只复查次数', async () => {
  const f = trialModesFixture(), l = ledger();
  const failed = { ...l, markDailyCompletion() { throw Error('模拟写盘失败'); } };
  const result = await run(f, failed, 'ad');
  assert.equal(result.ok, true);
  assert.match(result.note, /保存当日耗尽记录失败/);
  assert.equal(l.snapshot().uncertain, 0);
  assert.match((await run(f, l, 'ad')).reason, /次日/);
  assert.equal(f.state.writes.filter(row => row.name === 'TrialRaidBuySweepRequest').length, 1);
  assert.equal((await run(f, l, 'ad')).cached, true);
 });
 await check('单副本广告和钻石扫荡分别休眠，调高钻石限额只恢复付费检查',async()=>{
  const f=trialModesFixture(), l=ledger();
  Object.assign(f.settings.trials,{raidIds:['1'],paidPerRaidLimit:1});
  const round=()=>runLoop(f.client,f.protocol,{config:f.config,player:f.player,adChannel:f.channel,
    allowMutate:true,rounds:1,getSettings:()=>f.settings,isEnabled:key=>['trialAdSweep','trialPaidSweep'].includes(key),usageLedger:l});
  await round();
  assert.equal(f.state.writes.filter(row=>row.name==='TrialRaidBuySweepRequest').length,2);
  f.state.reads.length=0; await round();
  assert(!f.state.reads.some(row=>['TrialRaidInfoRequest','MonthCardRequest','OnWaterRequest'].includes(row.name)));
  f.settings.trials.paidPerRaidLimit=2; await round();
  assert(f.state.reads.some(row=>row.name==='MonthCardRequest'));
  assert(!f.state.reads.some(row=>row.name==='OnWaterRequest'));
  assert.equal(f.state.writes.filter(row=>row.name==='TrialRaidBuySweepRequest').length,3);
 });
 await check('三种扫荡分别保留每个副本的跳过原因，检查本身不消耗次数',async()=>{
  const f=trialModesFixture(), l=ledger();
  f.state.raids.get(1).buySweepTimes=3;
  f.state.raids.get(2).passedStage=0;
  f.state.raids.get(3).buySweepTimes=3;
  f.channel.clientInfo.channelId='unknown';
  const keys=['trialSweep','trialAdSweep','trialPaidSweep'];
  const logs=[];
  await runLoop(f.client,f.protocol,{config:f.config,player:f.player,adChannel:f.channel,allowMutate:true,rounds:1,everyMs:0,
    getSettings:()=>f.settings,isEnabled:key=>keys.includes(key),usageLedger:l,onStep:entry=>logs.push(entry)});
  const schedule=rewardSchedule(f.client);
  for(const key of keys){
    assert.equal(schedule.status(key).state,'waiting',key);
    for(const raid of f.config.tables.TrialRaidCfg.data){
      const text=schedule.status(key+':'+raid.raidId).text;
      assert(schedule.status(key).text.includes(raid.title+'：'+text));
      assert(logs.some(entry=>entry.taskKey===key+':'+raid.raidId && entry.reason===text));
    }
  }
  assert.match(schedule.status('trialSweep:2').text,/通关/);
  assert.match(schedule.status('trialPaidSweep:1').text,/用完/);
  assert.match(schedule.status('trialAdSweep:1').text,/客户端/);
  assert.deepEqual(f.state.writes,[]);
 });
 await check('HTTP单次扫荡报价确认、重复提交拦截且不改自动设置',async()=>{
  const f=trialModesFixture();f.settings.trials.paid=false;f.settings.trials.ads=false;fs.writeFileSync(path.join(dir,'accounts.json'),JSON.stringify({version:1,activeId:'http-qa',accounts:[{id:'http-qa',label:'扫荡隔离验证',url:'ws://127.0.0.1:1',login:{eworldClientInfo:f.channel.clientInfo,language:f.channel.language},automation:{enabled:false,paused:true}}]}));saveAutomationSettings('http-qa',f.settings,{revision:0});const {createConsole}=await import('../src/server.mjs');const app=createConsole({port:0});await app.listen();const root='http://127.0.0.1:'+app.server.address().port;
  try{await fetch(root+'/api/settings');const session=app.sessions.get('http-qa');session.client=f.client;session.player=f.player;session.paused=false;const before=fs.readFileSync(path.join(dir,'automation-settings.json'));const rows=await fetch(root+'/api/trials').then(r=>r.json());const s=rows[0].sweeps;assert.equal(s.paid.allowed,true);const payload={confirm:true,raidId:1,mode:'paid',expected:{passedStage:s.passedStage,buyUsed:s.buyUsed,adUsed:s.adUsed,cost:s.paid.cost,day:s.day}};const post=()=>fetch(root+'/api/trials/sweep',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal((await(await post()).json()).ok,true);await post();assert.equal(f.state.writes.length,1);assert.deepEqual(fs.readFileSync(path.join(dir,'automation-settings.json')),before);assert.equal(session.loop.running,false);}finally{app.server.closeAllConnections();await app.close();}
 });
}finally{const report={at:new Date().toISOString(),kind:'受控虚构数据，实际协议编解码，不操作真实游戏',passed:results.filter(x=>x.passed).length,total:results.length,results};fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(report,null,2));console.log(`${report.passed}/${report.total} 通过`);console.log(path.join(dir,'result.json'));if(report.passed!==report.total)process.exitCode=1;}
