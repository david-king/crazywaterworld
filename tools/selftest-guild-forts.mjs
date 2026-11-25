import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-guild-forts-'));process.env.CW_DATA_DIR=dir;
const {loadProtocol}=await import('../src/proto.mjs');
const {readGuildForts,serviceGuildForts}=await import('../src/guild-forts.mjs');
const {createUsageLedger}=await import('../src/automation-settings.mjs');
const {guildShipFixture,config}=await import('./fixtures/guild-ships.mjs');
const {pendingOrderMaterialSpends}=await import('../src/order-reservations.mjs');
const protocol=loadProtocol();let passed=0;
const check=async(name,work)=>{await work();passed++;console.log('通过：'+name);};
const fixture=()=>guildShipFixture(protocol,dir);
const read=f=>readGuildForts(f.client,protocol,config,f.options);
const run=f=>serviceGuildForts(f.client,protocol,config,f.options);
try{
 await check('本人捐赠达上限后跳过库存和后续工事进度推送',async()=>{
   const {rewardSchedule}=await import('../src/reward-schedule.mjs');
   const f=fixture();
   f.settings.guildFort.dailyLimit=f.state.dailyDonateNum=10;
   f.options.scheduler=rewardSchedule(f.client);
   assert.match((await run(f)).reason,/上限/);
   assert(!f.state.calls.some(row=>row.name==='AllItemRequest'));
   f.state.calls.length=0;
   f.client.emit('message',{name:'SCFortProcess',body:{}});
   await run(f); assert.equal(f.state.calls.length,0);
 });
 await check('工事冷却保留上次实查原因，不用等待提示覆盖运行状态',async()=>{
   const {rewardSchedule}=await import('../src/reward-schedule.mjs');
   const f=fixture(), scheduler=rewardSchedule(f.client), reports=[];
   f.player.worldId='2000001';
   f.options.scheduler=scheduler;
   f.options.report=entry=>{reports.push(entry);scheduler.observe(entry.key,entry.reason);};
   const first=await run(f);assert.match(first.reason,/赛季/);
   const reads=f.state.calls.length;
   assert.equal((await run(f)).reason,first.reason);
   assert.equal(reports.length,1);
   assert.equal(f.state.calls.length,reads);
 });
 await check('真实工事协议编码字段，默认关闭和赛季未开放无消费',async()=>{const f=fixture();const body={cityId:1,item:{itemId:'耐火砖',num:10},selectPackNum:0};assert.equal(protocol.DonateFortRequest.decode(protocol.DonateFortRequest.encode(body).finish()).selectPackNum,0);f.settings.guildFort.enabled=false;assert((await run(f)).skipped);assert.equal(f.state.calls.length,0);f.settings.guildFort.enabled=true;f.player.worldId='2000001';assert.match((await run(f)).reason,/赛季/);assert.equal(f.state.writes.length,0);});
 await check('工事捐赠留空任选、选择后只捐所选，排除优先于两种模式',async()=>{
   for(const [materials,blockedMaterials,expected] of [
     [[],[],['耐火砖','高温合金']],
     [[],['耐火砖'],['高温合金']],
     [['高温合金'],[],['高温合金']],
     [['耐火砖','高温合金'],['耐火砖'],['高温合金']],
     [['耐火砖'],['耐火砖'],[]],
     [[],['耐火砖','高温合金'],[]],
   ]){
     const f=fixture();
     f.settings.alliance.allowedMaterials=['橡胶圈'];
     Object.assign(f.settings.guildFort,{materials,blockedMaterials});
     assert.deepEqual((await read(f)).candidates.map(row=>row.id),expected);
     await run(f);
     assert.deepEqual(f.state.writes.map(row=>row.body.item.itemId),expected.slice(0,1));
   }
 });
 await check('库存核对期间排除待捐物料会取消本轮捐赠',async()=>{
   const f=fixture(); let reads=0;
   f.state.hook=async name=>{
     if(name==='AllItemRequest' && ++reads===2) f.settings.guildFort.blockedMaterials=['耐火砖'];
   };
   assert((await run(f)).skipped);
   assert.equal(f.state.writes.length,0);
 });
 await check('工事物料接口按账号区服读取实际缺口，重新展开可见进度变化',async()=>{
   process.env.CW_RESOURCE_AUTO_UPDATE='0';
   process.env.CW_CONFIG_PACK=path.join(dir,'fort-config.json');
   fs.writeFileSync(process.env.CW_CONFIG_PACK,JSON.stringify(Object.entries(config.tables).map(([name,table],i)=>[i,name,table])));
   const {saveStore}=await import('../src/accounts.mjs');
   const {createConsole}=await import('../src/server.mjs');
   const a=fixture(), b=guildShipFixture(protocol,dir,{worldId:'4000001'});
   a.state.fort.process[0].num=100;
   b.state.fort.process[1].num=100;
   const accounts=['fort-a','fort-b'].map(id=>({id,url:'wss://fixture.invalid',login:{},automation:{paused:true}}));
   saveStore({activeId:'fort-a',accounts});
   const app=createConsole({port:0,protocol});
   try{
     const base=await app.listen();
     const list=async id=>{
       const response=await fetch(base+'/api/settings/guild-fort-materials?account='+id);
       assert(response.ok,await response.clone().text());
       return (await response.json()).itemIds;
     };
     for(const [id,f] of [['fort-a',a],['fort-b',b]]){
       assert.equal(await list(id),null);
       Object.assign(app.sessions.get(id),{client:f.client,player:f.player,paused:false});
     }
     assert.deepEqual(await list('fort-a'),['高温合金']);
     assert.deepEqual(await list('fort-b'),['耐火砖']);
     a.state.fort.process[1].num=100;
     assert.deepEqual(await list('fort-a'),[]);
     assert.deepEqual(await list('fort-b'),['耐火砖']);
     b.player.worldId='2000001';
     assert.deepEqual(await list('fort-b'),[]);
     for(const f of [a,b]){
       assert(f.state.calls.every(row=>['GuildInfoRequest','GuildCityInfoRequest','CityFortInfoRequest'].includes(row.name)));
       assert.equal(f.state.writes.length,0);
     }
   }finally{
     for(const session of app.sessions.values())session.client=null;
     app.server.closeAllConnections(); await app.close();
   }
 });
 await check('只捐库存选中材料，预留竞争订单和库存阈值，从不购买/兑换/建造',async()=>{const f=fixture();f.state.stock.耐火砖=30;f.settings.guildFort.reserve=5;f.state.workerOrder=[{index:1,requirements:[{type:0,id:'耐火砖',num:10}]}];assert.equal((await read(f)).candidates[0].num,15);const r=await run(f);assert.equal(r.ok,true,r.error);assert.deepEqual(f.state.writes,[{name:'DonateFortRequest',body:{cityId:1,item:{itemId:'耐火砖',num:15},selectPackNum:0}}]);assert.equal(f.state.stock.耐火砖,15);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(f.player).length,0);});
 await check('总进度上限和每日已捐数量限制，0仅表示不加额外日限',async()=>{const f=fixture();f.state.fort.process[0].num=90;f.state.dailyDonateNum=17;f.settings.guildFort.dailyLimit=20;assert.equal((await read(f)).candidates[0].num,3);assert.equal((await run(f)).ok,true);assert.equal(f.state.fort.process[0].num,93);assert((await run(f)).skipped);assert.equal(f.state.writes.length,1);const g=fixture();g.state.fort.process[0].num=99;assert.equal((await run(g)).ok,true);assert.equal(g.state.writes[0].body.item.num,1);});
 await check('工事已经建成不捐，城市身份或进度变化发送前停止',async()=>{const f=fixture();f.state.fort.state=1;assert((await run(f)).skipped);assert.equal(f.state.writes.length,0);const g=fixture();let count=0;g.state.hook=async name=>{if(name==='CityFortInfoRequest'&&++count===3)g.state.fort.process[0].num=99;};await run(g);assert.equal(g.state.writes.length,0);});
 await check('关闭开关/切换联盟/修改库存保留后不发送旧计划',async()=>{for(const mode of ['off','guild','reserve']){const f=fixture();let count=0;f.state.hook=async name=>{if(name==='CityFortInfoRequest'&&++count===3){if(mode==='off')f.settings.guildFort.enabled=false;if(mode==='guild')f.player.guildId='999';if(mode==='reserve')f.settings.guildFort.reserve=50;}};await run(f);assert.equal(f.state.writes.length,0);}});
 await check('未知超时跨重启和换日不重复，公共进度增长不能冒充本人成功',async()=>{const f=fixture();f.state.writeHook=async()=>{throw new Error('超时');};assert((await run(f)).pending);assert.equal(f.ledger.snapshot().counters.guildFortDonations,50);f.state.fort.process[0].num=50;f.advance(86400);f.options.ledger=createUsageLedger('qa',{file:f.file,now:()=>f.state.now*1000});assert((await run(f)).pending);assert.equal(f.state.writes.length,1);});
 await check('明确未发送释放次数与材料，允许新鲜状态下重新执行',async()=>{const f=fixture();f.state.writeHook=async()=>{throw Object.assign(new Error('未发送'),{notSent:true});};assert.equal((await run(f)).pending,false);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(f.player).length,0);f.state.writeHook=async()=>{};assert.equal((await run(f)).ok,true);});
 await check('回执后完整库存失败保留材料，同批补产不会导致误判重复',async()=>{const f=fixture();f.state.hook=async name=>{if(name==='AllItemRequest'&&f.state.writes.length)throw new Error('暂不可读');};assert.equal((await run(f)).ok,true);assert.equal(pendingOrderMaterialSpends(f.player).length,1);f.state.hook=async()=>{};f.state.stock.耐火砖=5;f.settings.guildFort.reserve=5;await run(f);assert.equal(pendingOrderMaterialSpends(f.player).length,0);assert.equal(f.state.writes.length,1);});
 console.log(`联盟工事 ${passed} 项测试通过。`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
