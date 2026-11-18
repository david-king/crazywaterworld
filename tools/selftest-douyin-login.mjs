import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createDouyinLogin, inspectDouyinLoginDom, readDouyinLoginPage } from '../src/douyin-login.mjs';
import { DouyinGameAuthError } from '../src/douyin-game-auth.mjs';

const initialNow = 1_800_000_000_000;
const qr = suffix => 'data:image/png;base64,' + Buffer.from('offline-qr-' + suffix).toString('base64');
const credential = { source:'douyin',url:'wss://dhyaoj-gate.khlgamen.com/ws',capturedAt:new Date(initialNow).toISOString(),
  login:{eworldParams:{openId:'private-openid',token:'private-game-token',sign:'private-sign',timestamp:'1800000000'},
    eworldClientInfo:{appId:'fixture-app',channelId:'fixture-channel',clientVersion:'1.2.3.4'},worldId:0} };
const deferred = () => { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const settle = async () => { for(let index=0;index<12;index++) await new Promise(resolve=>setImmediate(resolve)); };
const managers = new Set();
let passed=0;

function fixture(options={}) {
  let time=initialNow,sequence=0;
  const timers=new Map();
  const env={launches:0,launchModes:[],browsers:[],exchanges:[],clicks:0,reads:0,cookies:[],entryVisible:true,pageState:{image:qr('one'),verification:false,expired:false}};
  const launch=async settings=>{
    env.launches++;
    env.launchModes.push(settings.headless);
    await options.launchGate?.promise;
    if(options.launchError)throw new Error('private launch details');
    const browser=new EventEmitter();browser.closed=0;
    browser.close=async()=>{browser.closed++;browser.emit('disconnected');};
    browser.newContext=async settings=>{
      assert.deepEqual(settings,{viewport:{width:1280,height:900},locale:'zh-CN'});
      const context=new EventEmitter();context.closed=0;browser.context=context;
      context.close=async()=>{context.closed++;await options.closeGate?.promise;};
      context.cookies=async url=>{assert.equal(url,'https://www.douyin.com/');await options.cookieGate?.promise;return structuredClone(env.cookies);};
      context.newPage=async()=>{
        const page=new EventEmitter();context.page=page;
        page.url=()=>options.pageUrl||'https://www.douyin.com/jingxuan';
        page.goto=async(url,settings)=>{assert.equal(url,'https://www.douyin.com/');assert.equal(settings.waitUntil,'domcontentloaded');if(options.gotoError)throw new Error('private navigation URL');};
        page.evaluate=async()=> 'fixture-browser-ua';
        page.close=async()=>page.emit('close');
        const entry={count:async()=>2,nth:index=>({isVisible:async()=>index===1&&env.entryVisible,click:async()=>{env.clicks++;}})};
        page.locator=()=>({getByText:()=>entry});page.getByRole=()=>entry;
        context.emit('page',page);return page;
      };
      return context;
    };
    env.browsers.push(browser);return browser;
  };
  env.manager=createDouyinLogin({launch,
    ...(options.prepare ? { prepare: options.prepare } : {}),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    readPage:async()=>{env.reads++;await options.readGate?.promise;if(options.readError)throw new Error('private page text');return structuredClone(env.pageState);},
    exchange:async input=>{env.exchanges.push(input);await options.exchangeGate?.promise;if(options.exchangeError)throw options.exchangeError;return structuredClone(options.credential??credential);},
    now:()=>time,startTimeoutMs:options.startTimeoutMs??10_000,qrTimeoutMs:5_000,verificationTimeoutMs:9_000,exchangeTimeoutMs:6_000,capturedTimeoutMs:7_000,pollIntervalMs:100,
    setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,at:time+delay});return id;},clearTimeout(id){timers.delete(id);},
  });
  managers.add(env.manager);
  env.advance=async ms=>{time+=ms;for(const [id,timer] of [...timers]){if(timer.at<=time){timers.delete(id);timer.callback();}}await settle();};
  env.respond=(data,{url='https://sso.douyin.com/passport/web/check_qrconnect/',json}={})=>{
    env.browsers.at(-1).context.emit('response',{url:()=>url,json:json??(async()=>data)});
  };
  env.loginCookie=()=>{env.cookies=[{name:'sessionid',domain:'.douyin.com',value:'private-web-cookie',expires:-1}];};
  return env;
}
async function test(name,run){try{await run();console.log('通过：'+name);passed++;}finally{for(const manager of managers)await manager.close();managers.clear();}}

await test('创建不启动浏览器，同会话并发开始只启动一个隔离浏览器',async()=>{
  const env=fixture();assert.equal(env.launches,0);assert.equal(env.manager.status().phase,'cancelled');
  const [first,second]=await Promise.all([env.manager.start(),env.manager.start()]);
  assert.equal(env.launches,1);assert.equal(first.id,second.id);assert.equal(first.phase,'waiting');
  assert.equal(first.qrImage,qr('one'));assert.equal(first.expiresAt,initialNow+5000);
  assert.deepEqual(Object.keys(first).sort(),['error','expiresAt','id','phase','qrImage','verification']);
  assert.doesNotMatch(JSON.stringify(first),/private|sessionid|openid|token/);
  assert.throws(()=>env.manager.takeCredential(first.id),/尚未取得/);
});

await test('Passport确认不能替代官方浏览器Cookie，拿到Cookie后只兑换一次',async()=>{
  const gate=deferred();const env=fixture({exchangeGate:gate});const first=await env.manager.start();
  env.respond({message:'success',data:{status:'3',session_key:'private-response-token'}});await settle();
  assert.equal(env.exchanges.length,0);assert.equal(env.manager.status().phase,'waiting');
  env.loginCookie();await env.advance(100);
  assert.equal(env.exchanges.length,1);assert.equal(env.exchanges[0].sessionId,'private-web-cookie');
  assert.equal(env.exchanges[0].userAgent,'fixture-browser-ua');assert.equal(env.manager.status().phase,'authorizing');
  assert.equal(env.manager.status().qrImage,null);await env.advance(100);assert.equal(env.exchanges.length,1);
  gate.resolve();await settle();const state=env.manager.status(first.id);
  assert.equal(state.phase,'captured');assert.equal(env.browsers[0].closed,1);assert.equal(env.browsers[0].context.closed,1);
  assert.doesNotMatch(JSON.stringify(state),/private|sessionid|token|openId/);
  const saved=env.manager.takeCredential(first.id);assert.deepEqual(saved,credential);saved.login.eworldParams.token='mutated';
  assert.equal(env.manager.takeCredential(first.id).login.eworldParams.token,'private-game-token');
});

await test('身份验证使用新二维码和固定提示，验证码不自动操作',async()=>{
  const env=fixture();await env.manager.start();
  env.pageState={image:qr('verify'),verification:true,expired:false};await env.advance(100);
  const state=env.manager.status();assert.equal(state.phase,'verifying');assert.equal(state.qrImage,qr('verify'));
  assert.match(state.verification,/手机完成官方身份验证/);assert.equal(state.expiresAt,initialNow+100+9000);
  assert.equal(env.clicks,0);assert.equal(env.exchanges.length,0);
  await env.advance(100);assert.equal(env.manager.status().expiresAt,state.expiresAt,'轮询不能无限延长同一验证会话');
  env.pageState={image:null,verification:true,expired:false};await env.advance(100);
  assert.equal(env.manager.status().qrImage,null);assert.match(env.manager.status().verification,/验证/);
});

await test('二维码变更更新有效期，过期状态关闭浏览器',async()=>{
  const env=fixture();await env.manager.start();await env.advance(500);
  env.pageState.image=qr('two');await env.advance(100);
  assert.equal(env.manager.status().qrImage,qr('two'));assert.equal(env.manager.status().expiresAt,initialNow+5600);
  env.pageState.expired=true;await env.advance(100);assert.equal(env.manager.status().phase,'expired');assert.equal(env.browsers[0].closed,1);
});

await test('旧二维码迟到的Passport过期响应不能关闭新二维码',async()=>{
  const env=fixture();await env.manager.start();const response=deferred();
  env.respond(null,{json:()=>response.promise});env.pageState.image=qr('new');await env.advance(100);
  response.resolve({data:{status:'expired'},message:'二维码已过期'});await settle();
  assert.equal(env.manager.status().phase,'waiting');assert.equal(env.manager.status().qrImage,qr('new'));
});

await test('取消时在途二维码和交换结果都不能恢复会话',async()=>{
  const gate=deferred();const env=fixture({exchangeGate:gate});const first=await env.manager.start();
  env.loginCookie();await env.advance(100);await env.manager.cancel(first.id);
  assert.equal(env.exchanges[0].signal.aborted,true);gate.resolve();await settle();
  assert.equal(env.manager.status().phase,'cancelled');assert.throws(()=>env.manager.takeCredential(first.id),/尚未取得/);
  const readGate=deferred();const pending=fixture({readGate});const start=pending.manager.start();await settle();
  const id=pending.manager.status().id;await pending.manager.cancel(id);readGate.resolve();await start;await settle();
  assert.equal(pending.manager.status().phase,'cancelled');assert.equal(pending.browsers[0].closed,1);
});

await test('启动取消立即返回，迟到浏览器也被关闭，旧start不返回新会话',async()=>{
  const gate=deferred();const env=fixture({launchGate:gate});const one=env.manager.start(),two=env.manager.start();
  await settle();
  const old=env.manager.status().id;await env.manager.cancel(old);
  const next=env.manager.start();gate.resolve();await settle();
  assert.equal((await one).id,old);assert.equal((await two).id,old);assert.notEqual((await next).id,old);
  assert.equal(env.browsers[0].closed,1);assert.equal(env.manager.status().phase,'waiting');
});

await test('生成、扫码、验证、兑换与结果保留均有截止时间',async()=>{
  const never=deferred();const starting=fixture({launchGate:never});const pending=starting.manager.start();
  await settle();
  await starting.advance(10_001);assert.equal((await pending).phase,'error');never.resolve();await settle();assert.equal(starting.browsers[0].closed,1);
  const waiting=fixture();await waiting.manager.start();await waiting.advance(5001);assert.equal(waiting.manager.status().phase,'expired');
  const verifying=fixture();await verifying.manager.start();verifying.pageState.verification=true;await verifying.advance(100);await verifying.advance(9001);assert.equal(verifying.manager.status().phase,'expired');
  const exchangeGate=deferred();const authorizing=fixture({exchangeGate});await authorizing.manager.start();authorizing.loginCookie();await authorizing.advance(100);await authorizing.advance(6001);
  assert.equal(authorizing.manager.status().phase,'error');assert.equal(authorizing.exchanges[0].signal.aborted,true);exchangeGate.resolve();await settle();assert.equal(authorizing.manager.status().phase,'error');
  const captured=fixture();const state=await captured.manager.start();captured.loginCookie();await captured.advance(100);await captured.advance(7001);
  assert.equal(captured.manager.status().phase,'expired');assert.throws(()=>captured.manager.takeCredential(state.id),/尚未取得/);
});

await test('浏览器崩溃/断连及启动失败输出固定脱敏错误',async()=>{
  for(const type of ['crash','disconnected','close']){
    const env=fixture();await env.manager.start();
    (type==='disconnected'?env.browsers[0]:env.browsers[0].context.page).emit(type);await settle();
    assert.equal(env.manager.status().phase,'error');assert.equal(env.manager.status().qrImage,null);
  }
  const env=fixture({launchError:true});assert.equal((await env.manager.start()).phase,'error');assert.doesNotMatch(JSON.stringify(env.manager.status()),/private/);
});

await test('缺资源在打开浏览器前给出操作提示，host-only官网Cookie可认证',async()=>{
  const missing=fixture({prepare:()=>{throw new DouyinGameAuthError('resources');}});
  const state=await missing.manager.start();assert.equal(state.phase,'error');assert.match(state.error,/CW_DOUYIN_GAME_DIR/);assert.equal(missing.launches,0);
  const env=fixture();await env.manager.start();env.loginCookie();env.cookies[0].domain='www.douyin.com';await env.advance(100);
  assert.equal(env.manager.status().phase,'captured');
});

await test('关闭会等待迟到启动和旧会话的浏览器清理',async()=>{
  const launchGate=deferred();const pending=fixture({launchGate});pending.manager.start();await settle();
  let closed=false;const close=pending.manager.close().then(()=>{closed=true;});await settle();assert.equal(closed,false);
  launchGate.resolve();await close;assert.equal(pending.browsers[0].closed,1);
  const closeGate=deferred();const env=fixture({closeGate});const first=await env.manager.start();
  const cancel=env.manager.cancel(first.id);await settle();await env.manager.start();
  let allClosed=false;const closeAll=env.manager.close().then(()=>{allClosed=true;});await settle();assert.equal(allClosed,false);
  closeGate.resolve();await cancel;await closeAll;assert(env.browsers.every(browser=>browser.closed===1));
});

await test('无效凭据/陌生Cookie/外站Passport响应不能混入授权，错误不泄漏',async()=>{
  const env=fixture({credential:{...credential,source:'wrong'}});await env.manager.start();
  env.cookies=[{name:'sessionid',domain:'.example.com',value:'private',expires:-1}];await env.advance(100);assert.equal(env.exchanges.length,0);
  env.respond({data:{status:'expired'}},{url:'https://evil.example/passport/web/check_qrconnect/'});await settle();assert.equal(env.manager.status().phase,'waiting');
  env.loginCookie();await env.advance(100);assert.equal(env.manager.status().phase,'error');assert.doesNotMatch(JSON.stringify(env.manager.status()),/private|wrong/);
  const failed=fixture({exchangeError:new Error('private-cookie sessionid=secret')});await failed.manager.start();failed.loginCookie();await failed.advance(100);
  assert.equal(failed.manager.status().phase,'error');assert.doesNotMatch(JSON.stringify(failed.manager.status()),/private-cookie|secret/);
});

await test('二维码读取只展示PNG，无法读取页面达到阈值后释放浏览器',async()=>{
  const env=fixture({readError:true});const pending=env.manager.start();await settle();
  for(let count=0;count<5;count++)await env.advance(100);
  assert.equal((await pending).phase,'error');assert.equal(env.browsers[0].closed,1);
  const page={evaluate:async()=>({image:null,clip:{x:1,y:2,width:180,height:180},verification:true,expired:false}),screenshot:async options=>{assert.equal(options.type,'png');assert.equal('path' in options,false);return Buffer.from('fixture');}};
  assert.deepEqual(await readDouyinLoginPage(page),{image:'data:image/png;base64,Zml4dHVyZQ==',verification:true,challenge:false,expired:false});
});

await test('Windows式可见临时浏览器遇网页挑战立即提示，人工完成后继续读码',async()=>{
  const env=fixture({headless:false});env.pageState={image:null,verification:false,challenge:true};
  const state=await env.manager.start();assert.equal(state.phase,'verifying');assert.match(state.verification,/临时抖音官方窗口/);
  assert.deepEqual(env.launchModes,[false]);assert.equal(env.clicks,0,'网页挑战只交给用户处理');
  env.pageState={image:null,verification:false,challenge:false};await env.advance(100);assert.equal(env.clicks,1);
  env.pageState={image:qr('after-human'),verification:false,challenge:false};await env.advance(100);
  assert.equal(env.manager.status().phase,'waiting');assert.equal(env.manager.status().qrImage,qr('after-human'));
});

await test('无头环境遇网页挑战明确阻塞，不自动解验证码',async()=>{
  const env=fixture({headless:true});env.pageState={image:null,challenge:true};
  const state=await env.manager.start();assert.equal(state.phase,'error');assert.match(state.error,/人工页面验证/);
  await settle();
  assert.equal(env.clicks,0);assert.equal(env.browsers[0].closed,1);
});

await test('隐藏登录入口不消耗尝试次数，加载后的可见入口仍能点击',async()=>{
  const env=fixture({startTimeoutMs:60_000});env.pageState={image:null,verification:false,challenge:false};env.entryVisible=false;
  const start=env.manager.start();await settle();
  for(let count=0;count<4;count++)await env.advance(6000);
  assert.equal(env.clicks,0);env.entryVisible=true;await env.advance(6000);assert.equal(env.clicks,1);
  env.pageState={image:qr('late'),verification:false,challenge:false};await env.advance(100);
  assert.equal((await start).phase,'waiting');
});

await test('SSR入口早期点击无效果时，间隔重试等到登录组件可用',async()=>{
  const env=fixture({startTimeoutMs:60_000,headless:false});env.pageState={image:null,verification:false,challenge:false};
  const start=env.manager.start();await settle();assert.equal(env.clicks,1);
  await env.advance(100);assert.equal(env.clicks,1,'不能紧接重试');
  for(let count=0;count<3;count++)await env.advance(5000);
  assert.equal(env.clicks,4,'三次SSR假成功不能提前终止入口重试');
  env.pageState.image=qr('hydrated');await env.advance(100);assert.equal((await start).phase,'waiting');
});

await test('真实QR形态：aria-only与中心logo仍可读，验证浮层完整覆盖的旧码被排除',async()=>{
  const make=(id,left,attributes={})=>({id,attributes,complete:true,naturalWidth:200,naturalHeight:200,innerText:'',
    getBoundingClientRect:()=>({left,top:20,right:left+200,bottom:220,width:200,height:200}),
    contains:node=>node.id===id,getAttribute:key=>attributes[key]??null,parentElement:null});
  const old=make('old',20,{alt:'二维码'}),fresh=make('fresh',300,{alt:'','aria-label':'二维码'});
  const logo={id:'sibling-logo',contains:()=>false},portal={id:'covering-verification-portal',contains:()=>false};
  let drawn,nodes=[fresh];
  const document={
    querySelectorAll:selector=>selector.startsWith('img')?nodes.filter(node=>
      (node.attributes.alt==='二维码'&&selector.includes('img[alt="二维码"]'))
      ||(node.attributes['aria-label']==='二维码'&&selector.includes('img[aria-label="二维码"]'))
      ||(node.inQrContainer&&selector.includes('#douyin_login_comp_scan_code_qrcode img'))):[],
    elementFromPoint:(x,y)=>x<250?portal:Math.abs(x-400)<25&&Math.abs(y-120)<25?logo:fresh,
    createElement:()=>({getContext:()=>({drawImage:node=>{drawn=node.id;}}),toDataURL:()=>qr(drawn)})};
  const inspect=()=>vm.runInNewContext('('+inspectDouyinLoginDom.toString()+')()',{document,innerWidth:1280,innerHeight:900,getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'})});
  let result=inspect();assert.equal(drawn,'fresh');assert.equal(result.image,qr('fresh'));assert.equal(result.verification,false);
  nodes=[old,fresh];fresh.parentElement={innerText:'手机刷脸验证',parentElement:null,getAttribute:()=> 'dialog'};
  result=inspect();assert.equal(result.image,qr('fresh'));assert.equal(result.verification,true);
  nodes=[old];drawn=null;result=inspect();assert.equal(result.image,null);assert.equal(drawn,null,'旧码虽存在DOM但被整体覆盖，不能读取');
  nodes=[fresh];delete fresh.attributes['aria-label'];fresh.inQrContainer=true;
  result=inspect();assert.equal(result.image,qr('fresh'),'已观察的官方容器也能定位无alt的二维码');
  document.title='验证码中间页';document.querySelectorAll=()=>[];
  const challenge=inspect();
  assert.equal(challenge.challenge,true);assert.equal(challenge.image,null);
});

await test('过期id不能取消新会话，关闭后不能重新开始',async()=>{
  const env=fixture();const first=await env.manager.start();await env.manager.cancel(first.id);const second=await env.manager.start();
  await assert.rejects(()=>env.manager.cancel(first.id),/失效/);assert.equal(env.manager.status().id,second.id);
  await env.manager.close();await assert.rejects(()=>env.manager.start(),/已关闭/);
});

console.log(`抖音扫码登录自检通过：${passed} 项（无真实浏览器、账号或网络操作）。`);
