import assert from 'node:assert/strict';
import fs from 'node:fs';

const script=fs.readFileSync(new URL('../src/gift-codes-ui.js',import.meta.url),'utf8');
const page=fs.readFileSync(new URL('../src/ui/pages.tsx',import.meta.url),'utf8').split('export function giftCodesPage() {')[1].split('export function overviewPage()')[0];
assert(page.indexOf('id="gift-code-start"')<page.indexOf('id="gift-code-library-rows"'));
assert(page.indexOf('id="gift-code-library-rows"')<page.indexOf('id="gift-code-history"'));
for(const removed of ['gift-add-row','gift-code-manual-rows','使用状态','来源 / 操作','手动添加的礼包码全部账号共享','自动兑换默认关闭','失效/不可用包含'])assert(!page.includes(removed),removed+' 应已移除');
assert(!script.includes('gift-add-row'));
assert(!script.includes('gift-auto-toggle'));
assert(!script.includes('gift-record-retry'));
assert.match(script,/el\('button',null,'重试'\)/,'重试按钮沿用无class原生按钮主题');

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const record=code=>({code,status:'success',detail:'金币 ×10',at:'2026-11-19T00:00:00Z',retryable:false});
function fixture(accountList=[{id:'a',title:'账号A',paused:false,running:false,connected:false,counts:{},total:0,available:2,autoRedeem:false}]){
  const env={nodes:new Map(),accounts:accountList,channels:[],calls:[],downloads:[],timers:[],csvVersion:'page-1',csvError:null,blobReads:0};
  class Node{
    constructor(tag='div'){this.tagName=tag;this.textContent='';this.children=[];this.attributes={};this.value='';this.disabled=false;this.checked=false;this.open=false;this.classList={contains:()=>false};}
    append(...items){this.children.push(...items);for(const item of items)item.parent=this;}
    appendChild(item){this.append(item);return item;}
    replaceChildren(...items){this.children=[];this.append(...items);}
    setAttribute(name,value){this.attributes[name]=value;}
    getAttribute(name){return this.attributes[name];}
    get firstChild(){return this.children[0];}
    get lastChild(){return this.children.at(-1);}
    get options(){return this.children;}
    focus(){env.focused=this;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    click(){if(this.tagName==='a')env.downloads.push({href:this.href,download:this.download});}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
  }
  env.node=id=>{if(!env.nodes.has(id))env.nodes.set(id,new Node());return env.nodes.get(id);};
  env.element=(tag,className,text)=>{const node=new Node(tag);node.className=className||'';node.textContent=text??'';return node;};
  env.clear=node=>{node.replaceChildren();return node;};
  env.library=[{code:'FIRST',eligible:true,expiresAt:null,usage:[]}];
  env.records=()=>({rows:[record('ROW')],total:1,pages:1,page:1});
  env.body=new Node('body');
  env.guard={version:'page-1',stale:false,isStale(){return this.stale;},check(response,data){const version=response?.headers.get('X-CW-Console-Version');if(version&&version!==this.version||data?.code==='CLIENT_VERSION_MISMATCH')this.stale=true;return !this.stale;}};
  env.call=async(path,options={})=>{
    const url=new URL(path,'http://fixture'),body=options.body?JSON.parse(options.body):null;
    env.calls.push({path:url.pathname,query:url.searchParams,body});
    if(url.pathname==='/api/gift-codes/accounts')return {accounts:env.accounts};
    if(url.pathname==='/api/gift-codes/initial'||url.pathname==='/api/gift-codes/load'){
      const selected=body?.accounts??JSON.parse(url.searchParams.get('accounts'));
      const rows=env.libraryFor?.(selected)??env.library;
      if(env.initialGate)await env.initialGate;
      const tryCodes=rows.filter(row=>row.eligible).map(row=>row.code);
      return {channels:env.channels,displayRows:rows,tryCodes,available:tryCodes.length,total:rows.length};
    }
    if(url.pathname==='/api/gift-codes/channels/preview')return {codes:['中文_礼包','VIP888']};
    if(url.pathname==='/api/gift-codes/channels/save'){env.channels=[{...body,id:'custom',enabled:true}];return {channels:env.channels};}
    if(url.pathname==='/api/gift-codes/manual'){
      if(env.manualGate)await env.manualGate;
      if(env.manualError)throw Error(env.manualError);
      env.library.push(...body.codes.map(code=>({code,expiresAt:body.expiresAt,eligible:true,usage:[]})));
      return {saved:body.codes.length,codes:body.codes.length};
    }
    if(url.pathname==='/api/gift-codes/auto'){
      if(env.autoGate)await env.autoGate;
      env.accounts.find(account=>account.id===url.searchParams.get('account')).autoRedeem=body.enabled;
      return {enabled:body.enabled};
    }
    if(url.pathname==='/api/gift-codes')return env.records(url.searchParams);
    if(url.pathname==='/api/gift-codes/redeem')return {accepted:body.accounts.length,results:body.accounts.map(id=>({id,title:id,accepted:true}))};
    if(url.pathname==='/api/gift-codes/retry')return {accepted:true};
    throw Error('unexpected '+path);
  };
  env.fetch=async(path,options)=>{
    env.exportRequest={path,options};
    if(env.fetchGate)await env.fetchGate;
    return {ok:!env.csvError,headers:{get:()=>env.csvVersion},json:async()=>({error:env.csvError,code:env.csvCode}),blob:async()=>{env.blobReads++;if(env.blobGate)await env.blobGate;return {};}};
  };
  env.api=new Function('env',`
    const $=env.node,el=env.element,clear=env.clear,when=value=>value||'';
    const call=env.call,fetch=env.fetch,confirm=()=>true;
    const window={cwConsoleVersion:env.guard};
    const document={body:env.body,createElement:env.element};
    const Option=function(text,value){const node=env.element('option');node.text=text;node.value=value;return node;};
    const URL={createObjectURL:()=>{env.objectUrls=(env.objectUrls||0)+1;return 'blob:fixture';},revokeObjectURL:()=>{}};
    const setTimeout=(fn,ms)=>{env.timers.push({fn,ms});return env.timers.length;},clearTimeout=()=>{};
    let current=env.accounts[0]?.id||'';
    ${script}
    return {refresh:refreshGiftCodes,refreshRecords:refreshGiftRecords,refreshLibrary:refreshGiftInitial,
      switchAccount(id){current=id;giftAccountChanged();},
      state:()=>({giftViewed,giftStatus,giftPage,giftTotal,rows:giftRows,library:giftInitial,loading:giftRecordsLoading})};
  `)(env);
  return env;
}
let passed=0;
const test=async(name,work)=>{await work();passed++;console.log('通过：'+name);};
await test('从渠道列表新增并预览，保存后返回表格继续编辑',async()=>{
  const e=fixture([]);await e.api.refresh();
  const list=e.node('gift-channel-list-dialog');
  assert.equal(list.open,false);
  e.node('gift-channel-show').onclick();assert(list.open);
  e.node('gift-channel-add').onclick();
  assert(e.node('gift-channel-dialog').open);
  e.node('gift-channel-name').value='活动公告';
  e.node('gift-channel-url').value='https://example.org/news';
  const pattern=e.node('gift-channel-pattern').value;
  assert.equal(new RegExp(pattern,'gmu').exec('礼包码：中文_礼包').groups.code,'中文_礼包');
  await e.node('gift-channel-preview').onclick();
  assert.match(e.node('gift-channel-result').textContent,/2 个.*\n中文_礼包\nVIP888/);
  assert.deepEqual(e.channels,[]);
  await e.node('gift-channel-save').onclick();
  assert.equal(e.node('gift-channel-dialog').open,false);
  assert(list.open);
  const row=e.node('gift-channel-list').firstChild;
  assert.equal(row.tagName,'tr');assert.equal(row.children.length,3);
  row.lastChild.firstChild.children.find(button=>button.textContent==='编辑').onclick();
  assert.equal(e.node('gift-channel-url').value,'https://example.org/news');
  assert.equal(e.node('gift-channel-pattern').value,pattern);
  e.node('gift-channel-cancel').onclick();assert(list.open);
  e.node('gift-channel-close').onclick();assert.equal(list.open,false);
  assert.equal(e.calls.some(call=>call.path.endsWith('/redeem')||call.path.endsWith('/auto')),false);
});
await test('最近一次同步列只显示最近成功时间，停用或同步失败仍保留时间',async()=>{
  const e=fixture([]),stamp='2026-11-20T02:09:59Z';
  e.channels=[
    {name:'正常',enabled:true,lastSuccessAt:stamp},
    {name:'暂停',enabled:false,lastSuccessAt:stamp},
    {name:'失联',enabled:true,lastSuccessAt:stamp,lastError:'连接超时'},
    {name:'新渠道',enabled:true},
  ];
  await e.api.refresh();e.node('gift-channel-show').onclick();
  assert(page.includes('<th scope="col">最近一次同步</th>'));
  assert.deepEqual(e.node('gift-channel-list').children.map(row=>row.children[1].textContent),[stamp,stamp,stamp,'未同步']);
  assert.equal(e.node('gift-channel-errors').firstChild.textContent,'失联 同步失败：连接超时');
});
await test('打开默认渠道编辑器时直接显示当前提取正则',async()=>{
  const e=fixture([]);
  e.channels=[{id:'game-wiki',name:'Wiki',mode:'raw',jsonField:'codes',pattern:'"code":"([^"]+)"'},
    {id:'ali213',name:'游侠网',mode:'text',pattern:'公告：(?<code>.+)'}]
    .map(channel=>({...channel,builtin:true,url:'https://example.org/'+channel.id,enabled:true}));
  await e.api.refresh();e.node('gift-channel-show').onclick();
  for(const [index,channel] of e.channels.entries()){
    const row=e.node('gift-channel-list').children[index];
    row.lastChild.firstChild.children.find(button=>button.textContent==='编辑').onclick();
    assert.equal(e.node('gift-channel-name').value,channel.name);
    assert.equal(e.node('gift-channel-url').value,channel.url);
    assert.equal(e.node('gift-channel-mode').value,channel.mode);
    assert(!e.node('gift-channel-pattern').hidden);
    assert.equal(e.node('gift-channel-pattern').value,channel.pattern);
    assert.equal(e.node('gift-channel-json').hidden,channel.mode!=='raw');
    e.node('gift-channel-cancel').onclick();
  }
});
assert(!page.includes('option value="wiki"')&&!page.includes('option value="article"'));
await test('没有账号也能批量保存，去重后全库共享且不发送兑换请求',async()=>{
  const e=fixture([]);await e.api.refresh();
  assert.equal(e.node('gift-code-start').disabled,true);
  e.node('gift-batch-add').onclick();assert(e.node('gift-batch-dialog').open);
  e.node('gift-batch-input').value=' ALPHA \nBETA\nALPHA\n';
  await e.node('gift-batch-save').onclick();
  const writes=e.calls.filter(row=>row.path==='/api/gift-codes/manual');
  assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{confirm:true,codes:['ALPHA','BETA'],expiresAt:null});
  assert.equal(e.node('gift-batch-dialog').open,false);
  assert.equal(e.node('gift-code-library-rows').children.length,3);
  assert.equal(e.calls.some(row=>row.path.endsWith('/redeem')||row.path.endsWith('/auto')),false);
});
await test('空批次不提交，保存失败保留原输入并恢复按钮',async()=>{
  const e=fixture();e.node('gift-batch-add').onclick();await e.node('gift-batch-save').onclick();
  assert.equal(e.calls.length,0);assert.match(e.node('gift-batch-error').textContent,/至少/);
  e.node('gift-batch-input').value='INVALID!';e.manualError='礼包码格式无效';await e.node('gift-batch-save').onclick();
  assert.equal(e.node('gift-batch-input').value,'INVALID!');assert(e.node('gift-batch-dialog').open);
  assert.equal(e.node('gift-batch-save').disabled,false);assert.match(e.node('gift-batch-error').textContent,/格式/);
});
await test('批量保存单飞，等待期间取消与Escape不能关闭弹窗',async()=>{
  const e=fixture([]),gate=deferred();e.manualGate=gate.promise;
  e.node('gift-batch-add').onclick();e.node('gift-batch-input').value='ONE';
  const job=e.node('gift-batch-save').onclick();await tick();
  await e.node('gift-batch-save').onclick();e.node('gift-batch-cancel').onclick();
  let prevented=false;e.node('gift-batch-dialog').oncancel({preventDefault(){prevented=true;}});
  assert(prevented);assert(e.node('gift-batch-dialog').open);assert.equal(e.calls.filter(row=>row.path.endsWith('/manual')).length,1);
  gate.resolve();await job;assert.equal(e.node('gift-batch-dialog').open,false);
});
await test('码库仅显示三列，并可切换已处理记录',async()=>{
  const e=fixture();e.library.push({code:'DONE',eligible:false,expiresAt:'2026-12-01',usage:[{status:'success'}]});await e.api.refresh();
  let rows=e.node('gift-code-library-rows').children;assert.equal(rows.length,1);assert.equal(rows[0].children.length,3);
  assert.deepEqual(rows[0].children.map(cell=>cell.attributes['data-label']),['礼包码','可用状态','到期日期']);
  e.node('gift-show-processed').checked=true;e.node('gift-show-processed').onchange();assert.equal(e.node('gift-code-library-rows').children.length,2);
});
await test('自动兑换只在显式点击后写入，暂停账号仍可修改开关且不重复发送',async()=>{
  const e=fixture([{id:'a',title:'账号A',paused:true,running:false,counts:{},available:1,autoRedeem:false}]);await e.api.refresh();
  assert.equal(e.calls.some(row=>row.path.endsWith('/auto')),false);
  const row=e.node('gift-account-list').children[0],button=row.children[2];assert(row.firstChild.disabled);assert(!button.disabled);assert.equal(button.className,'','自动兑换沿用无class原生按钮主题');
  const gate=deferred();e.autoGate=gate.promise;const job=button.onclick({preventDefault(){}});await tick();
  await button.onclick({preventDefault(){}});assert.equal(e.calls.filter(item=>item.path.endsWith('/auto')).length,1);
  assert.deepEqual(e.calls.find(item=>item.path.endsWith('/auto')).body,{confirm:true,enabled:true});
  gate.resolve();await job;assert.equal(button.attributes['aria-pressed'],'true');assert.equal(e.node('gift-code-start').disabled,true);
});
await test('记录筛选的晚到响应不能覆盖新筛选结果',async()=>{
  const e=fixture();await e.api.refresh();const gate=deferred();
  e.records=query=>query.get('status')==='all'?gate.promise:{rows:[record('SUCCESS')],total:1,pages:1,page:1};
  e.node('gift-record-status').value='all';e.node('gift-record-status').onchange();await tick();
  e.node('gift-record-status').value='success';e.node('gift-record-status').onchange();await tick();
  assert.equal(e.api.state().rows[0].code,'SUCCESS');
  gate.resolve({rows:[record('LATE')],total:5,pages:1,page:1});await tick();
  assert.equal(e.api.state().rows[0].code,'SUCCESS');assert.equal(e.api.state().giftTotal,1);
});
await test('切换账号后晚到的旧账号记录不能显示',async()=>{
  const e=fixture([{id:'a',title:'A',counts:{},available:1},{id:'b',title:'B',counts:{},available:1}]);await e.api.refresh();const gate=deferred();
  e.records=query=>query.get('account')==='a'?gate.promise:{rows:[record('B-ROW')],total:1,pages:1,page:1};
  const job=e.api.refreshRecords();await tick();e.api.switchAccount('b');await tick();
  gate.resolve({rows:[record('A-LATE')],total:1,pages:1,page:1});await job;await tick();
  assert.equal(e.api.state().giftViewed,'b');assert.equal(e.api.state().rows[0].code,'B-ROW');
});
await test('A 兑换后手动选过 A，再切到 B 仍可兑换同一码',async()=>{
  const e=fixture([{id:'a',title:'A'},{id:'b',title:'B'}]);
  const redeemed=new Set();
  e.libraryFor=ids=>[{code:'SHARED',eligible:ids.some(id=>!redeemed.has(id))}];
  await e.api.refresh();
  e.node('gift-select-none').onclick();
  const [a,b]=e.node('gift-account-list').children.map(row=>row.firstChild);
  a.checked=true;a.onchange();await tick();
  await e.node('gift-code-start').onclick();
  redeemed.add('a');await e.api.refresh();
  assert.deepEqual(e.api.state().library.tryCodes,[]);

  const late=deferred();e.initialGate=late.promise;
  const oldRequest=e.api.refreshLibrary();
  e.initialGate=null;e.api.switchAccount('b');await tick();
  late.resolve();await oldRequest;
  assert.equal(a.checked,false);assert.equal(b.checked,true);
  assert.deepEqual(e.api.state().library.tryCodes,['SHARED']);
  assert.equal(e.node('gift-code-start').disabled,false);
  await e.node('gift-code-start').onclick();
  assert.deepEqual(e.calls.filter(call=>call.path.endsWith('/redeem')).map(call=>call.body.accounts),[['a'],['b']]);
});
await test('手动更换兑换目标后立即清除旧码库，单选记录跟随目标，多选可持续刷新',async()=>{
  const e=fixture([{id:'a',title:'A'},{id:'b',title:'B'}]);
  e.libraryFor=ids=>[{code:'SHARED',eligible:ids.includes('a')}];
  await e.api.refresh();
  e.node('gift-select-all').onclick();await tick();await e.api.refresh();
  assert.deepEqual(JSON.parse(e.calls.filter(call=>call.path.endsWith('/initial')).at(-1).query.get('accounts')),['a','b']);
  const gate=deferred();e.initialGate=gate.promise;
  const a=e.node('gift-account-list').firstChild.firstChild;
  a.checked=false;a.onchange();await tick();
  assert.equal(e.api.state().giftViewed,'b');
  assert.equal(e.node('gift-code-library-rows').children.length,0);
  assert.equal(e.node('gift-code-start').disabled,true);
  gate.resolve();await tick();
  assert.deepEqual(e.api.state().library.tryCodes,[]);
  assert.equal(e.node('gift-code-start').disabled,true);
});
await test('CSV使用独立导出接口并携带页面版本及筛选条件',async()=>{
  const e=fixture();await e.api.refresh();e.node('gift-record-status').value='success';e.node('gift-record-status').onchange();await tick();
  await e.node('gift-record-export').onclick();
  assert.equal(e.exportRequest.options.headers['X-CW-Console-Version'],'page-1');
  const query=new URL(e.exportRequest.path,'http://fixture').searchParams;assert.equal(query.get('account'),'a');assert.equal(query.get('status'),'success');
  assert.equal(e.downloads.length,1);assert.equal(e.downloads[0].download,'礼包兑换记录.csv');
});
await test('CSV返回新版本或读blob期间页面失效时不能下载',async()=>{
  const e=fixture();await e.api.refresh();e.csvVersion='page-2';await e.node('gift-record-export').onclick();
  assert.equal(e.downloads.length,0);assert.equal(e.blobReads,0);assert.match(e.node('gift-record-notice').textContent,/刷新/);
  const second=fixture();await second.api.refresh();const gate=deferred();second.blobGate=gate.promise;
  const job=second.node('gift-record-export').onclick();await tick();second.guard.stale=true;gate.resolve();await job;
  assert.equal(second.downloads.length,0);assert.equal(second.objectUrls??0,0);
});
await test('读取CSV期间改变筛选条件时丢弃旧导出',async()=>{
  const e=fixture();await e.api.refresh();const gate=deferred();e.blobGate=gate.promise;
  const job=e.node('gift-record-export').onclick();await tick();
  e.node('gift-record-status').value='success';e.node('gift-record-status').onchange();await tick();gate.resolve();await job;
  assert.equal(e.downloads.length,0);
});
await test('兑换只在点击后提交共享码库及选择账号',async()=>{
  const e=fixture();await e.api.refresh();assert.equal(e.calls.some(row=>row.path.endsWith('/redeem')),false);
  await e.node('gift-code-start').onclick();
  assert.deepEqual(e.calls.find(row=>row.path.endsWith('/redeem')).body,{confirm:true,library:true,accounts:['a']});
});
console.log(`礼包码界面专项 ${passed}/${passed} 通过（离线模拟，零游戏请求）`);
