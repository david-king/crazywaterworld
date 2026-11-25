import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { checkSeasonMerit } from '../src/season-merit.mjs';
import { runLoop } from '../src/loop.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-season-merit-'));
let serial = 0;
function fixture() {
  const settings = defaultSettings();
  settings.seasonMerit = { enabled: true, targetRank: 1, leadMinutes: 7 };
  const player = { playerId: 91, worldId: 4000012 };
  const state = { end: Math.floor(Date.now()/1000) + 240, mine: 90, ownRank: 2, target: 100,
    mail: 6, report: 5, got: false, received: false, pause: false };
  const file = path.join(temp, ++serial + '.json');
  const writes = [], reads = [];
  const asset = num => ({type:0,id:'功勋',num});
  const client = Object.assign(new EventEmitter().setMaxListeners(32), {
    connected: true, serverClockOffsetMs: 0,
    async request(name, body, _response, _timeout, beforeSend) {
      reads.push(name);
      if(name === 'SeasonRankInfoRequest') return {endTime:state.end, midEndTime:state.end-100000};
      if(name === 'EmailBoxRequest') return {total:1,email:[{emailId:'11',status:1,got:state.got,attachment:{assets:{asset:[asset(state.mail)]}}}]};
      if(name === 'CampaignReportsRequest') return {total:1,reports:[{uid:'22',received:state.received,rewards:{assetPackage:{asset:[asset(state.report)]}}}]};
      if(name === 'SeasonRankPlayerRequest') {
        assert.equal(body.type,0);
        if (state.pages) return {maxPage:2,
          player:Array.from({length:30},(_,i)=>({rank:(body.page-1)*30+i+1,playerId:1000+(body.page-1)*30+i,score:state.target})),
          myRank:{playerId:91,rank:70,score:state.mine}};
        return {maxPage:1,player:[{rank:1,playerId:state.ownRank===1?91:72,score:state.target}],
          myRank:{playerId:91,rank:state.ownRank,score:state.mine}};
      }
      assert.equal(name,'QuickGotCampaignReportRequest');
      assert.equal(body.all,true);
      beforeSend?.(); writes.push(name); state.received=true;
      return {reward:{asset:[asset(state.report)]}};
    },
    async sendWatch(name,body,{beforeSend}) {
      assert.equal(name,'QuickGotReadEmailRequest'); assert.equal(body.all,true);
      state.beforeMail?.(); beforeSend?.(); writes.push(name);
      if (!state.unknown) state.got=true;
      state.afterMail?.();
    },
  });
  const opts = () => ({ledger:createUsageLedger('a',{file}), enabled:()=>!state.pause, getPreference:()=>settings.seasonMerit});
  return {settings,state,client,reads,writes, run:()=>checkSeasonMerit(client,player,opts()),
    round:()=>runLoop(client,{}, {config:{tables:{}},player,rounds:1,allowMutate:true,
      isEnabled:()=>false,getSettings:()=>settings,usageLedger:opts().ledger})};
}

try {
  const early=fixture(); early.state.end+=86400;
  assert((await early.run()).nextAt> Date.now()/1000); assert.deepEqual(early.reads,['SeasonRankInfoRequest']);
  const late=fixture();late.client.serverClockOffsetMs=300000;await late.run();assert.equal(late.writes.length,0);
  const tie=fixture(); tie.state.target='9007199254741004'; tie.state.mine='9007199254740993';
  assert.match((await tie.run()).reason,/还差 1 功勋/); assert.equal(tie.writes.length,0);
  const behind=fixture();behind.state.target=102;await behind.run();assert.equal(behind.writes.length,0);
  const ahead=fixture();ahead.state.ownRank=1; await ahead.run();assert.equal(ahead.writes.length,0);
  const missing=fixture();missing.settings.seasonMerit.targetRank=60;await missing.run();assert.equal(missing.writes.length,0);
  const secondPage=fixture();secondPage.settings.seasonMerit.targetRank=53;secondPage.state.pages=true;
  assert((await secondPage.run()).ok);assert.equal(secondPage.reads.filter(name=>name==='SeasonRankPlayerRequest').length,2);
  const changed=fixture();changed.state.beforeMail=()=>{changed.settings.seasonMerit.targetRank=5;};
  await assert.rejects(changed.run(),/设置已变化/);assert.equal(changed.writes.length,0);
  const expired=fixture();expired.state.beforeMail=()=>{expired.client.serverClockOffsetMs=300000;};
  await assert.rejects(expired.run(),/已到结算时间/);assert.equal(expired.writes.length,0);
  const stale=fixture();stale.state.beforeMail=()=>stale.client.emit('sent',{name:'QuickGotReadEmailRequest'});
  await assert.rejects(stale.run(),/领取状态已变化/);assert.equal(stale.writes.length,0);
  const good=fixture();
  const round=await good.round();
  assert(round.history[0].tasks.results.some(e=>e.taskKey==='seasonMerit' && e.ok));
  assert.deepEqual(good.writes,['QuickGotReadEmailRequest','QuickGotCampaignReportRequest']);
  await good.run();assert.equal(good.writes.length,2);
  const disabled=fixture();disabled.settings.seasonMerit.enabled=false;await disabled.round();
  assert.equal(disabled.reads.length,0);
  const paused=fixture();paused.state.afterMail=()=>{paused.state.pause=true;};
  await paused.run();assert.equal(paused.writes.length,1);
  paused.state.ownRank=1;paused.state.pause=false;
  assert((await paused.run()).ok);assert.deepEqual(paused.writes,good.writes);
  const unknown=fixture();unknown.state.unknown=true;
  assert.equal((await unknown.run()).status,'pending');assert.equal((await unknown.run()).status,'pending');
  assert.equal(unknown.writes.length,1);unknown.state.got=true;
  assert((await unknown.run()).ok);assert.deepEqual(unknown.writes,good.writes);
  console.log('通过：赛季末时段、精确分数、并列和超位保留、缺榜、发送前改目标或到期、挂机独立运行和双来源续领');
} finally {
  if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('cw-season-merit-'))
    fs.rmSync(temp,{recursive:true,force:true});
}
