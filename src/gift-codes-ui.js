const giftBatchLabels={success:'成功',used:'已兑换',rejected:'拒绝',unknown:'待确认',skipped:'未发送'};
const giftLabels={queued:'待兑换',sending:'兑换中',success:'兑换成功',used:'已兑换',rejected:'服务器拒绝',unknown:'待确认',skipped:'未发送'};
let giftAccounts=[],giftSelected=new Set(current?[current]:[]),giftStarting=false,giftNote='';
let giftInitial=null,giftLoading=false,giftInitialVersion=0,giftInitialError='';
let giftViewed='',giftRows=[],giftPage=1,giftPageSize=10,giftPages=1,giftTotal=0,giftStatus='exclude-invalid';
let giftExporting=false,giftRecordsLoading=false,giftRecordsVersion=0,giftBatchSaving=false;
let giftTimer,giftVersion=0,giftContext=0;
const giftRetrying=new Set(),giftAutoBusy=new Set();
const giftVisible=()=>!$('tab-giftcodes').classList.contains('hidden');
const giftRecordQuery=()=>new URLSearchParams({account:giftViewed,status:giftStatus,page:String(giftPage),pageSize:String(giftPageSize)});
function giftCanStart(account){return !account.paused&&!account.running&&!account.error;}
function giftTargets(){return giftAccounts.filter(account=>giftSelected.has(account.id)&&giftCanStart(account)).map(account=>account.id);}
function paintGiftStart(){
  $('gift-code-start').disabled=giftStarting||!giftTargets().length||!giftInitial?.tryCodes?.length;
}
function giftAccountNote(account){
  if(account.error)return account.error;
  if(account.paused)return '已暂停';
  if(account.running)return '兑换中 '+(account.total-(account.counts?.queued??0)-(account.counts?.sending??0))+' / '+account.total;
  const last=Object.entries(giftBatchLabels).filter(([status])=>account.counts?.[status]).map(([status,label])=>label+' '+account.counts[status]);
  return (account.connected?'已连接':'未连接')+' · 可兑换 '+(account.available??0)+' 条'+(last.length?' · 上批：'+last.join('，'):'');
}
function paintGiftState(){
  const running=giftAccounts.filter(account=>account.running).length;
  $('gift-code-state').textContent=[running?'正在兑换，剩余 '+running+' 个账号':'',giftNote||(!giftAccounts.length?'请先添加账号':'')].filter(Boolean).join('；');
}
function paintGiftAccounts(){
  const box=$('gift-account-list'),key=giftAccounts.map(account=>account.id+'\n'+account.title).join('\n');
  if(box.accountsKey!==key){
    box.accountsKey=key;clear(box);
    for(const account of giftAccounts){
      const input=el('input');input.type='checkbox';
      input.onchange=()=>{
        if(input.checked)giftSelected.add(account.id);else giftSelected.delete(account.id);
        giftSelectionChanged();
      };
      const automatic=el('button');automatic.type='button';
      automatic.onclick=async event=>{
        event.preventDefault();
        if(giftAutoBusy.has(account.id))return;
        const enabled=!giftAccounts.find(item=>item.id===account.id)?.autoRedeem,context=giftContext;
        giftAutoBusy.add(account.id);automatic.disabled=true;
        try{
          const result=await call('/api/gift-codes/auto?'+new URLSearchParams({account:account.id}),{method:'POST',body:JSON.stringify({confirm:true,enabled})});
          if(context===giftContext)giftNote=result.syncError?'自动兑换已开启，码库同步失败：'+result.syncError:enabled?'已开启自动兑换':'已关闭自动兑换';
        }catch(error){if(context===giftContext)giftNote=error.message;}
        finally{giftAutoBusy.delete(account.id);if(context===giftContext)await refreshGiftCodes();}
      };
      const row=el('label','gift-account');row.append(input,el('span','',account.title),automatic,el('span','dim'));box.append(row);
    }
  }
  giftAccounts.forEach((account,index)=>{
    const row=box.children[index];row.firstChild.checked=giftSelected.has(account.id);row.firstChild.disabled=giftStarting||!giftCanStart(account);
    const automatic=row.children[2];automatic.textContent=account.autoRedeem?'关闭自动兑换':'开启自动兑换';
    automatic.disabled=giftAutoBusy.has(account.id);automatic.setAttribute('aria-pressed',String(Boolean(account.autoRedeem)));
    automatic.setAttribute('aria-label',account.title+'：'+automatic.textContent);
    row.lastChild.textContent=giftAccountNote(account);
  });
  $('gift-selected-count').textContent='已选 '+giftTargets().length+' / '+giftAccounts.length;
  paintGiftStart();
  $('gift-select-all').disabled=giftStarting||!giftAccounts.some(giftCanStart);
  $('gift-select-none').disabled=giftStarting||!giftSelected.size;
  const picker=$('gift-record-account');
  if(picker.options.length!==giftAccounts.length||giftAccounts.some((account,index)=>picker.options[index]?.value!==account.id||picker.options[index]?.text!==account.title)){
    picker.replaceChildren(...giftAccounts.map(account=>new Option(account.title,account.id)));
  }
  picker.value=giftViewed;picker.disabled=!giftAccounts.length;
}
function paintGiftInitial(){
  paintGiftStart();
  paintGiftChannels(giftInitial?.channels??[]);
  $('gift-load-initial').disabled=giftLoading;
  $('gift-load-initial').textContent=giftLoading?'正在载入…':'载入未兑换码';
  const note=$('gift-code-initial-note');
  if(giftInitialError)note.textContent=giftInitialError;
  else if(!giftInitial)note.textContent=giftLoading?'':'正在读取码库…';
  else{
    const rows=giftInitial.displayRows??[];
    const summary=['码库 '+rows.length+' 条'];
    if(giftSelected.size)summary.push('所选账号可兑换 '+(giftInitial.available??giftInitial.tryCodes?.length??0)+' 条');
    if(giftInitial.lastSyncedAt)summary.push('上次同步 '+when(giftInitial.lastSyncedAt));
    if(giftInitial.lastError)summary.push('同步失败，使用缓存：'+giftInitial.lastError);
    note.textContent=summary.join(' · ');
  }
  note.hidden=!note.textContent;
  const body=clear($('gift-code-library-rows'));
  for(const entry of giftInitial?.displayRows??[]){
    const pending=entry.usage?.some(row=>['queued','sending'].includes(row.status));
    if(!entry.eligible&&!pending&&!$('gift-show-processed').checked)continue;
    const status=entry.eligible?(entry.expiresAt?'未到期':'有效期待确认'):pending?'处理中':entry.usage?.some(row=>row.status==='unknown')?'待确认':'已处理';
    const tr=el('tr');
    [entry.code,status,entry.expiresAt||'未注明'].forEach((value,index)=>{
      const cell=el('td','',value);cell.setAttribute('data-label',['礼包码','可用状态','到期日期'][index]);tr.append(cell);
    });
    body.append(tr);
  }
  if(giftInitial&&!body.children.length){const row=el('tr'),cell=el('td','','暂无符合条件的礼包码');cell.colSpan=3;row.append(cell);body.append(row);}
}
async function refreshGiftInitial(){
  const version=++giftInitialVersion,context=giftContext;
  const query=new URLSearchParams({accounts:JSON.stringify([...giftSelected])});
  try{
    const data=await call('/api/gift-codes/initial?'+query);
    if(version!==giftInitialVersion||context!==giftContext)return;
    giftInitial=data;giftInitialError='';paintGiftInitial();
  }catch(error){if(version===giftInitialVersion&&context===giftContext){giftInitialError='读取码库失败：'+error.message;paintGiftInitial();}}
}
$('gift-load-initial').onclick=async()=>{
  if(giftLoading)return;
  giftLoading=true;giftInitialError='';paintGiftInitial();
  const version=++giftInitialVersion,context=giftContext;
  try{
    const data=await call('/api/gift-codes/load',{method:'POST',body:JSON.stringify({confirm:true,accounts:[...giftSelected]})});
    if(version===giftInitialVersion&&context===giftContext){giftInitial=data;giftNote='已载入礼包码';}
  }catch(error){if(version===giftInitialVersion&&context===giftContext)giftInitialError='载入失败：'+error.message;}
  finally{
    giftLoading=false;paintGiftInitial();paintGiftState();
    if(version!==giftInitialVersion||context!==giftContext)void refreshGiftInitial();
  }
};
$('gift-show-processed').onchange=paintGiftInitial;
let giftChannelId=null,giftChannelBusy=false,giftChannelListKey='';
const giftChannelPost=(action,values)=>call('/api/gift-codes/channels/'+action,{method:'POST',body:JSON.stringify({confirm:true,...values})});
function paintGiftChannelMode(){
  const raw=$('gift-channel-mode').value==='raw';
  for(const field of ['json-label','json'])$('gift-channel-'+field).hidden=!raw;
}
function openGiftChannel(channel){
  if(giftChannelBusy)return;
  giftChannelId=channel?.id??null;
  $('gift-channel-title').textContent=channel?'编辑渠道':'添加渠道';
  $('gift-channel-name').value=channel?.name??'';
  $('gift-channel-url').value=channel?.url??'';
  $('gift-channel-mode').value=channel?.mode??'text';
  $('gift-channel-json').value=channel?.jsonField??'';
  $('gift-channel-pattern').value=channel?.pattern??'(?:礼包码|兑换码)[：:]\\s*(?<code>[\\p{L}\\p{N}_-]+)';
  $('gift-channel-result').textContent='';
  paintGiftChannelMode();
  $('gift-channel-dialog').showModal();$('gift-channel-name').focus();
}
function paintGiftChannels(channels){
  if(!$('gift-channel-list-dialog').open)return;
  const emptyNote=channels.length?'':giftInitialError||(giftInitial?'暂无渠道':'正在读取渠道…');
  const key=JSON.stringify([channels,giftChannelBusy,emptyNote]);
  if(key===giftChannelListKey)return;
  giftChannelListKey=key;
  const list=clear($('gift-channel-list'));
  const errors=clear($('gift-channel-errors'));
  $('gift-channel-add').disabled=giftChannelBusy;
  if(emptyNote){
    const row=el('tr'),cell=el('td','dim',emptyNote);
    cell.colSpan=3;row.append(cell);list.append(row);
  }
  for(const channel of channels){
    const row=el('tr'),info=el('td'),identity=el('div','gift-channel-identity');
    const name=el('span','gift-channel-name',channel.name),url=el('small','dim gift-channel-url',channel.url);
    name.title=channel.name;url.title=channel.url;
    identity.append(name,url);info.append(identity);
    const lastSync=channel.lastSuccessAt?when(channel.lastSuccessAt):'未同步';
    if(channel.enabled&&channel.lastError)errors.append(el('p','',channel.name+' 同步失败：'+channel.lastError));
    const actions=el('div','gift-channel-actions'),cell=el('td');
    cell.append(actions);row.append(info,el('td','gift-channel-time',lastSync),cell);
    function action(label,run){
      const button=el('button','',label);button.type='button';button.disabled=giftChannelBusy;
      button.setAttribute('aria-label',label+' '+channel.name);button.onclick=run;actions.append(button);
    }
    action('编辑',()=>openGiftChannel(channel));
    action(channel.enabled?'停用':'启用',()=>changeGiftChannel('toggle',{id:channel.id,enabled:!channel.enabled}));
    if(!channel.builtin){
      action('删除',()=>{if(confirm('删除渠道“'+channel.name+'”及其采集缓存？'))return changeGiftChannel('delete',{id:channel.id});});
    }
    list.append(row);
  }
}
function giftChannelSetBusy(value){
  giftChannelBusy=value;
  for(const id of ['name','url','mode','json','pattern','preview','save','cancel'])$('gift-channel-'+id).disabled=value;
  paintGiftChannels(giftInitial?.channels??[]);
}
async function changeGiftChannel(action,values){
  if(giftChannelBusy)return;
  giftChannelSetBusy(true);
  const status=$('gift-channel-status');status.textContent='';
  try{
    const result=await giftChannelPost(action,values);
    if(giftInitial)giftInitial.channels=result.channels;
    await refreshGiftCodes();
  }catch(error){(action==='save'?$('gift-channel-result'):status).textContent=error.message;return;}
  finally{giftChannelSetBusy(false);}
  if(action==='save')$('gift-channel-dialog').close();
}
function giftChannelDraft(){
  return { id:giftChannelId,name:$('gift-channel-name').value,url:$('gift-channel-url').value,
    mode:$('gift-channel-mode').value,jsonField:$('gift-channel-mode').value==='raw'?$('gift-channel-json').value:'',pattern:$('gift-channel-pattern').value };
}
$('gift-channel-add').onclick=()=>openGiftChannel();
$('gift-channel-show').onclick=()=>{
  $('gift-channel-status').textContent='';
  $('gift-channel-list-dialog').showModal();
  paintGiftChannels(giftInitial?.channels??[]);
};
$('gift-channel-close').onclick=()=>$('gift-channel-list-dialog').close();
$('gift-channel-dialog').onclose=()=>{
  const list=$('gift-channel-list-dialog');
  if(list.open&&!list.contains(document.activeElement))$('gift-channel-add').focus();
};
$('gift-channel-cancel').onclick=()=>{if(!giftChannelBusy)$('gift-channel-dialog').close();};
$('gift-channel-dialog').oncancel=event=>{if(giftChannelBusy)event.preventDefault();};
$('gift-channel-save').onclick=()=>changeGiftChannel('save',giftChannelDraft());
$('gift-channel-preview').onclick=async()=>{
  if(giftChannelBusy)return;
  const draft=giftChannelDraft(),result=$('gift-channel-result');
  giftChannelSetBusy(true);result.textContent='正在获取渠道内容…';
  try{
    const {codes}=await giftChannelPost('preview',draft);
    result.textContent='匹配到 '+codes.length+' 个不同礼包码\n'+codes.join('\n');
  }catch(error){result.textContent=error.message;}
  finally{giftChannelSetBusy(false);}
};
for(const field of ['name','url','mode','json','pattern'])$('gift-channel-'+field).oninput=()=>{$('gift-channel-result').textContent='';};
$('gift-channel-mode').onchange=paintGiftChannelMode;
function resetGiftSelectionView(){
  ++giftInitialVersion;
  giftInitial=null;giftInitialError='';giftNote='';
  paintGiftAccounts();paintGiftInitial();paintGiftState();
}
function giftSelectionChanged(){
  const [only]=giftSelected;
  if(giftSelected.size===1&&only!==giftViewed){
    giftViewed=only;giftRecordsReset();void refreshGiftRecords();
  }
  resetGiftSelectionView();void refreshGiftInitial();
}
$('gift-select-all').onclick=()=>{giftSelected=new Set(giftAccounts.filter(giftCanStart).map(account=>account.id));giftSelectionChanged();};
$('gift-select-none').onclick=()=>{giftSelected.clear();giftSelectionChanged();};
function paintGiftPage(){
  $('gift-prev').disabled=giftRecordsLoading||giftPage<=1;
  $('gift-next').disabled=giftRecordsLoading||giftPage>=giftPages;
  $('gift-record-export').disabled=giftExporting||giftRecordsLoading||!giftViewed||!giftTotal;
  $('gift-page').textContent=giftPage+' / '+giftPages+' 页，共 '+giftTotal+' 条';
  const body=clear($('gift-code-history'));
  for(const record of giftRows){
    const tr=el('tr');
    [record.code,giftLabels[record.status]||record.status,record.detail,when(record.at)].forEach((value,index)=>{
      const cell=el('td','',value);cell.setAttribute('data-label',['礼包码','状态','结果','时间'][index]);tr.append(cell);
    });
    const action=el('td');action.setAttribute('data-label','操作');
    if(record.retryable){
      const account=giftViewed,key=account+'\n'+record.code;
      const retry=el('button',null,'重试');retry.type='button';retry.disabled=giftRetrying.has(key)||giftAccounts.find(item=>item.id===account)?.running;
      retry.onclick=async()=>{
        if(giftRetrying.has(key)||!confirm('重试礼包码 '+record.code+'？'))return;
        giftRetrying.add(key);retry.disabled=true;const context=giftContext;
        try{
          await call('/api/gift-codes/retry?'+new URLSearchParams({account}),{method:'POST',body:JSON.stringify({confirm:true,code:record.code})});
          if(context===giftContext&&account===giftViewed)$('gift-record-notice').textContent='已提交重试';
        }catch(error){if(context===giftContext&&account===giftViewed)$('gift-record-notice').textContent=error.message;}
        finally{giftRetrying.delete(key);if(context===giftContext)await refreshGiftCodes();}
      };action.append(retry);
    }else action.textContent='—';
    tr.append(action);body.append(tr);
  }
  if(!giftRows.length){const row=el('tr'),cell=el('td','',giftRecordsLoading?'正在读取兑换记录…':'暂无符合条件的兑换记录');cell.colSpan=5;row.append(cell);body.append(row);}
}
function giftRecordsReset(){
  ++giftRecordsVersion;giftRecordsLoading=false;giftPage=1;giftRows=[];giftTotal=0;giftPages=1;
  $('gift-record-notice').textContent='';paintGiftPage();
}
async function refreshGiftRecords(){
  const version=++giftRecordsVersion,context=giftContext,viewed=giftViewed;
  if(!viewed){giftRecordsReset();return;}
  giftRecordsLoading=true;paintGiftPage();
  try{
    const data=await call('/api/gift-codes?'+giftRecordQuery());
    if(version!==giftRecordsVersion||context!==giftContext||viewed!==giftViewed)return;
    giftRows=data.rows;giftPage=data.page;giftPages=data.pages;giftTotal=data.total;
    if($('gift-record-notice').textContent.startsWith('读取记录失败：'))$('gift-record-notice').textContent='';
  }catch(error){
    if(version===giftRecordsVersion&&context===giftContext){giftRows=[];giftTotal=0;giftPages=1;giftPage=1;$('gift-record-notice').textContent='读取记录失败：'+error.message;}
  }finally{if(version===giftRecordsVersion&&context===giftContext){giftRecordsLoading=false;paintGiftPage();}}
}
$('gift-prev').onclick=()=>{if(giftPage>1&&!giftRecordsLoading){giftPage--;void refreshGiftRecords();}};
$('gift-next').onclick=()=>{if(giftPage<giftPages&&!giftRecordsLoading){giftPage++;void refreshGiftRecords();}};
$('gift-page-size').onchange=()=>{giftPageSize=Number($('gift-page-size').value);giftRecordsReset();void refreshGiftRecords();};
$('gift-record-status').onchange=()=>{giftStatus=$('gift-record-status').value;giftRecordsReset();void refreshGiftRecords();};
$('gift-record-account').onchange=()=>{giftViewed=$('gift-record-account').value;giftRecordsReset();void refreshGiftRecords();};
$('gift-record-export').onclick=async()=>{
  if(giftExporting||!giftViewed||!giftTotal)return;
  const viewed=giftViewed,status=giftStatus,context=giftContext,path='/api/gift-codes/export',query=giftRecordQuery();
  const guard=typeof window==='undefined'?null:window.cwConsoleVersion;
  const assertCurrent=response=>{
    if(guard?.check(response)===false||guard?.isStale?.())throw Error('控制台已更新，请刷新后重新导出');
  };
  giftExporting=true;paintGiftPage();
  try{
    assertCurrent();
    const response=await fetch(path+'?'+query,{headers:guard?.version?{'X-CW-Console-Version':guard.version}:{}});
    assertCurrent(response);
    if(!response.ok){const data=await response.json();if(guard?.check(response,data)===false)throw Error('控制台已更新，请刷新后重新导出');throw Error(data.error||'导出失败');}
    const blob=await response.blob();assertCurrent(response);
    if(context!==giftContext||status!==giftStatus||viewed!==giftViewed)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='礼包兑换记录.csv';document.body.append(link);
    try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
    $('gift-record-notice').textContent='已导出兑换记录';
  }catch(error){if(context===giftContext&&status===giftStatus&&viewed===giftViewed)$('gift-record-notice').textContent='导出失败：'+error.message;}
  finally{giftExporting=false;paintGiftPage();}
};
function giftBatchBusy(busy){
  giftBatchSaving=busy;
  for(const id of ['gift-batch-save','gift-batch-cancel','gift-batch-input','gift-batch-expiry'])$(id).disabled=busy;
}
$('gift-batch-add').onclick=()=>{
  if(giftBatchSaving)return;
  $('gift-batch-input').value='';$('gift-batch-expiry').value='';$('gift-batch-error').textContent='';
  $('gift-batch-dialog').showModal();$('gift-batch-input').focus();
};
$('gift-batch-cancel').onclick=()=>{if(!giftBatchSaving)$('gift-batch-dialog').close();};
$('gift-batch-dialog').oncancel=event=>{event.preventDefault();if(!giftBatchSaving)$('gift-batch-dialog').close();};
$('gift-batch-save').onclick=async()=>{
  if(giftBatchSaving)return;
  const codes=[...new Set($('gift-batch-input').value.split(/\r?\n/).map(code=>code.trim()).filter(Boolean))];
  if(!codes.length){$('gift-batch-error').textContent='请至少输入一条礼包码';$('gift-batch-input').focus();return;}
  if(codes.length>500){$('gift-batch-error').textContent='单次最多保存 500 条礼包码';return;}
  const expiresAt=$('gift-batch-expiry').value||null;
  giftBatchBusy(true);$('gift-batch-error').textContent='';
  try{
    const result=await call('/api/gift-codes/manual',{method:'POST',body:JSON.stringify({confirm:true,codes,expiresAt})});
    $('gift-batch-dialog').close();giftNote='已保存 '+(result.saved??result.codes)+' 条礼包码';
    await refreshGiftCodes();
  }catch(error){$('gift-batch-error').textContent=error.message;}
  finally{giftBatchBusy(false);}
};
function giftAccountChanged(){
  ++giftContext;++giftVersion;clearTimeout(giftTimer);
  giftSelected=new Set(current?[current]:[]);giftViewed=current||'';
  giftRecordsReset();resetGiftSelectionView();
  if(giftVisible())void refreshGiftCodes();
}
async function refreshGiftCodes(){
  const version=++giftVersion,context=giftContext;clearTimeout(giftTimer);
  try{
    const list=await call('/api/gift-codes/accounts');
    if(version!==giftVersion||context!==giftContext)return;
    giftAccounts=list.accounts;
    const selectedCount=giftSelected.size;
    for(const id of [...giftSelected])if(!giftAccounts.some(account=>account.id===id))giftSelected.delete(id);
    if(giftSelected.size!==selectedCount)resetGiftSelectionView();
    if(!giftAccounts.some(account=>account.id===giftViewed)){
      giftViewed=giftAccounts.some(account=>account.id===current)?current:giftAccounts[0]?.id||'';giftRecordsReset();
    }
    paintGiftAccounts();paintGiftState();
    await Promise.all([refreshGiftInitial(),refreshGiftRecords()]);
  }catch(error){if(version===giftVersion&&context===giftContext){giftNote=error.message;paintGiftState();}}
  finally{
    if(version===giftVersion&&context===giftContext&&giftVisible())giftTimer=setTimeout(refreshGiftCodes,giftAccounts.some(account=>account.running)?750:15000);
  }
}
$('gift-code-start').onclick=async()=>{
  if(giftStarting)return;
  const targets=giftTargets(),context=giftContext;
  if(!targets.length){giftNote='请至少选择一个可兑换账号';paintGiftState();return;}
  if(!giftInitial?.tryCodes?.length){giftNote='暂无可兑换礼包码，请载入或批量新增';paintGiftState();return;}
  ++giftVersion;clearTimeout(giftTimer);giftStarting=true;giftNote='';paintGiftAccounts();paintGiftState();
  try{
    const data=await call('/api/gift-codes/redeem',{method:'POST',body:JSON.stringify({confirm:true,library:true,accounts:targets})});
    if(context===giftContext){const refused=data.results.filter(result=>!result.accepted);giftNote=refused.length?'未开始：'+refused.map(result=>result.title+'（'+result.error+'）').join('、'):'已开始兑换';}
  }catch(error){if(context===giftContext)giftNote=error.message;}
  finally{giftStarting=false;await refreshGiftCodes();}
};
