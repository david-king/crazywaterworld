let siliconOwner = null, siliconData = null, siliconLoading = false, siliconSerial = 0;
let siliconReceivedAt = 0, siliconLastAttempt = 0, siliconTimers = [];
let siliconAction = null, siliconResult = null;
const siliconSelection = new Map();
const siliconActionNames = { dispatch: '派遣采集', attack: '抢占矿位', retreat: '撤回舰队' };
const siliconConfirmNames = { dispatch: '确认派遣', attack: '确认抢占', retreat: '确认撤回' };
let siliconAutoRefresh = true, siliconRefreshSeconds = 30;
try {
  const saved = JSON.parse(localStorage.getItem('cw.silicon.refresh') || 'null');
  if (typeof saved?.enabled === 'boolean') siliconAutoRefresh = saved.enabled;
  if (Number.isInteger(saved?.seconds) && saved.seconds >= 5 && saved.seconds <= 300) siliconRefreshSeconds = saved.seconds;
} catch { /* 浏览器不允许存储时仍可在本次页面使用。 */ }
function applySiliconSnapshot(state) {
  siliconOwner = state.siliconOwner; siliconData = state.siliconData; siliconLoading = state.siliconLoading;
  siliconReceivedAt = state.siliconReceivedAt; siliconLastAttempt = state.siliconLastAttempt;
}
// 兼容现有页面与共享状态入口，刷新偏好不写入账号自动化设置。
if (typeof bindConsoleSlice === 'function') bindConsoleSlice('silicon', { siliconOwner, siliconData, siliconLoading, siliconReceivedAt, siliconLastAttempt }, applySiliconSnapshot);
function setSiliconSnapshot(patch) {
  if (typeof patchConsoleSlice === 'function') patchConsoleSlice('silicon', patch);
  else applySiliconSnapshot({ siliconOwner, siliconData, siliconLoading, siliconReceivedAt, siliconLastAttempt, ...patch });
}
const siliconNumber = value => Number.isSafeInteger(value) && value >= 0 ? fmt(value) : '未同步';
const siliconConnected = () => !!current && snapshot.connected && !snapshot.paused && !disconnected.has(current);
const siliconVisible = () => !document.hidden && !$('tab-overview').classList.contains('hidden');
const siliconStaleAfter = () => Math.max(90000, siliconAutoRefresh ? siliconRefreshSeconds * 3000 : 0);
const siliconStale = () => siliconReceivedAt && Date.now() - siliconReceivedAt > siliconStaleAfter();

function siliconDuration(seconds) {
  const value = Math.max(0, Math.ceil(seconds)), days = Math.floor(value / 86400), hours = Math.floor(value % 86400 / 3600);
  if (days) return days + '天 ' + hours + '小时';
  if (hours) return hours + '小时 ' + Math.floor(value % 3600 / 60) + '分';
  return Math.floor(value / 60) + '分 ' + value % 60 + '秒';
}
function siliconTimerText(endAt, label, finished) {
  if (!endAt) return label + '：时间未同步';
  if (siliconStale()) return label + '：待同步';
  const remaining = endAt - siliconData.checkedAt - Math.max(0, (Date.now() - siliconReceivedAt) / 1000);
  return remaining > 0 ? label + ' ' + siliconDuration(remaining) : finished;
}
function siliconTimer(endAt, label, finished) {
  const node = el('span', 'silicon-countdown', siliconTimerText(endAt, label, finished));
  siliconTimers.push({ node, endAt, label, finished });
  if (endAt) node.title = new Date(endAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '（北京时间）';
  return node;
}
function resetSiliconOverview() {
  siliconAction = null; siliconResult = null; siliconSelection.clear();
  siliconSerial++; setSiliconSnapshot({ siliconOwner: null, siliconData: null, siliconLoading: false, siliconReceivedAt: 0, siliconLastAttempt: 0 }); siliconTimers = [];
  for (const id of ['silicon-summary', 'silicon-fleets', 'silicon-mines', 'silicon-notes']) clear($(id));
  $('silicon-overview').setAttribute('aria-busy', 'false');
}
function siliconAccountChanged() {
  if (siliconOwner !== null && (siliconOwner !== current || !siliconConnected())) resetSiliconOverview();
  updateSiliconControls();
  if (!siliconConnected()) $('silicon-status').textContent = !current ? '请选择账号查看硅矿' : snapshot.paused ? '账号已暂停，连接后可读取硅矿' : '连接账号后读取硅矿';
  else if (!siliconData && !siliconLoading) $('silicon-status').textContent = siliconAutoRefresh ? '等待读取硅矿' : '自动刷新已关闭，请手动刷新';
}
function siliconFacts(root, entries) {
  const list = el('dl', 'silicon-facts');
  for (const [label, value, title] of entries) {
    const content = el('dd', '', value);
    if (title) content.title = title;
    list.append(el('dt', '', label), content);
  }
  root.append(list);
}
function updateSiliconControls() {
  const busy = siliconAction !== null || siliconLoading;
  const refreshing = siliconLoading || siliconAction?.phase === 'preview' || siliconAction?.phase === 'sending' || !siliconConnected();
  $('silicon-refresh').disabled = refreshing;
  const refreshFleets = $('silicon-action-refresh');
  if (refreshFleets) refreshFleets.disabled = refreshing;
  for (const button of document.querySelectorAll('[data-silicon-action]')) {
    button.disabled = busy || !siliconConnected() || !!siliconStale() || !!button.dataset.unavailable;
    button.title = button.dataset.unavailable || (siliconStale() ? '信息已过期，请先刷新硅矿' : '');
  }
}
function siliconActionButton(intent, unavailable = '') {
  const button = smallButton(siliconActionNames[intent.kind]); button.type = 'button'; button.dataset.siliconAction = intent.kind;
  button.dataset.unavailable = unavailable; button.onclick = () => openSiliconAction(intent, button);
  return button;
}
function siliconRetreatButton(fleetId) {
  const fleet = siliconData.fleets.find(row => row.id === fleetId);
  return siliconActionButton({ kind: 'retreat', fleetId, gridId: fleet?.mineId, index: fleet?.slot - 1 },
    fleet?.retreatAllowed === true ? '' : fleet?.retreatAllowed === false ? '首奖后才能撤回' : '采矿状态未同步，请先刷新');
}
function cancelSiliconAction() {
  const action = siliconAction;
  if (!action || action.phase === 'sending') return;
  siliconAction = null; paintSiliconDetail(action.mine); updateSiliconControls();
  document.getElementById(action.triggerId)?.focus({ preventScroll: true });
}
async function openSiliconAction(intent, trigger) {
  if (!siliconConnected() || siliconAction || siliconLoading || siliconStale()) return;
  const mine = siliconData.mines.find(mine => mine.gridId === intent.gridId);
  if (!mine || mine.reason) return;
  const action = { account: current, intent, mine, triggerId: trigger.id, phase: 'preview', quote: null, fleetId: null };
  siliconSelection.set(mine.gridId, intent.index); siliconResult = null; siliconAction = action;
  paintSiliconDetail(mine); updateSiliconControls();
  $('silicon-action-cancel').focus({ preventScroll: !trigger.closest('.silicon-fleet') });
  await readSiliconAction(action);
}
async function readSiliconAction(action) {
  try {
    const quote = await call('/api/silicon/preview?account=' + encodeURIComponent(action.account), { method: 'POST',
      body: JSON.stringify({ ...action.intent, previousToken: action.quote?.token }) });
    if (siliconAction !== action || current !== action.account || !siliconConnected()) return;
    action.phase = 'ready'; action.quote = quote;
    if (!quote.fleets.some(fleet => fleet.available && fleet.id === action.fleetId)) action.fleetId = quote.fleets.find(fleet => fleet.available)?.id ?? null;
  } catch (error) {
    if (siliconAction !== action || current !== action.account) return;
    action.phase = 'error'; action.message = '无法准备操作：' + error.message;
  }
  const focus = document.activeElement.id;
  setSiliconSnapshot({ siliconLastAttempt: Date.now() });
  paintSiliconDetail(action.mine); updateSiliconControls();
  if (focus === 'silicon-action-cancel' || focus === 'silicon-action-refresh') $(focus)?.focus({ preventScroll: true });
}
async function submitSiliconAction() {
  const action = siliconAction;
  if (!action || action.phase !== 'ready' || !action.quote?.token || !action.fleetId || !siliconConnected() || action.account !== current) return;
  if (Date.now() >= action.quote.expiresAt) { expireSiliconAction(); return; }
  action.phase = 'sending'; paintSiliconDetail(action.mine); updateSiliconControls();
  try {
    const result = await call('/api/silicon/action?account=' + encodeURIComponent(action.account), { method: 'POST', body: JSON.stringify({ confirm: true, token: action.quote.token, fleetId: action.fleetId }) });
    if (siliconAction !== action || current !== action.account || !siliconConnected()) return;
    siliconResult = { ...action.intent, warning: !result.ok, text: result.ok ? ({ dispatch: '派遣已确认。', attack: '抢占舰队已派出。', retreat: '撤回已确认。' })[action.intent.kind]
      : result.status === 'unknown' ? '操作结果待确认，请刷新核对舰队状态。' : '操作未完成：' + (result.reason || result.error || '请刷新后重试') };
  } catch (error) {
    if (siliconAction === action && current === action.account) siliconResult = { ...action.intent, warning: true, text: '未取得操作结果：' + error.message + '。请刷新硅矿核对状态。' };
  } finally {
    if (siliconAction === action) {
      siliconAction = null; paintSiliconDetail(action.mine); updateSiliconControls();
      if (current === action.account && siliconConnected()) await refreshSiliconOverview();
    }
  }
}
function expireSiliconAction() {
  const action = siliconAction;
  if (action?.phase !== 'ready') return;
  action.phase = 'error'; action.message = '本次确认已过期，请刷新舰队。';
  paintSiliconDetail(action.mine); updateSiliconControls();
}
function paintSiliconAction(action, body, footer) {
  const { intent, phase, quote } = action;
  const cancel = smallButton('返回'), confirm = smallButton(siliconConfirmNames[intent.kind]);
  cancel.id = 'silicon-action-cancel'; cancel.onclick = cancelSiliconAction;
  confirm.id = 'silicon-action-confirm'; confirm.onclick = submitSiliconAction;
  cancel.disabled = phase === 'sending'; confirm.disabled = phase !== 'ready' || !quote?.token || !action.fleetId;
  const refresh = smallButton('刷新舰队');
  refresh.id = 'silicon-action-refresh'; refresh.onclick = refreshSiliconOverview;
  refresh.disabled = phase === 'preview' || phase === 'sending' || siliconLoading;
  footer.append(cancel, refresh, confirm);
  if (phase !== 'ready') {
    const message = el('p', phase === 'error' ? 'warn' : 'dim', action.message || (phase === 'sending' ? '正在等待服务器确认…' : '正在核对矿位、舰队和费用…'));
    message.setAttribute('role', 'status'); body.append(message); return;
  }
  if (!action.fleetId) {
    const message = el('p', 'dim', quote.reason || '暂无可用舰队');
    message.setAttribute('role', 'status'); body.append(message);
    for (const fleet of quote.fleets) {
      if (fleet.reason && fleet.reason !== quote.reason) body.append(el('p', 'dim', fleet.name + ' · ' + fleet.reason));
    }
    return;
  }
  if (quote.reason) body.append(el('p', 'warn', quote.reason));
  const field = el('div', 'silicon-fleet-choice'), picker = el('cw-select'), select = el('select');
  const label = el('label', 'dim', intent.kind === 'retreat' ? '撤回舰队' : '选择舰队');
  select.id = 'silicon-action-fleet'; label.htmlFor = select.id;
  picker.append(select); field.append(label, picker); body.append(field);
  const stats = el('p', 'dim');
  for (const fleet of quote.fleets) {
    const option = el('option', '', fleet.name);
    option.value = fleet.id; option.disabled = !fleet.available; select.append(option);
  }
  select.disabled = intent.kind === 'retreat';
  const showFleet = () => {
    const fleet = quote.fleets.find(row => row.id === action.fleetId);
    stats.textContent = '战力 ' + siliconNumber(fleet.power) + ' · 耐久 ' + siliconNumber(fleet.durability) + ' / ' + siliconNumber(fleet.maxDura);
  };
  select.value = action.fleetId; showFleet(); body.append(stats);
  select.onchange = () => { action.fleetId = select.value; showFleet(); };
}
function paintSiliconDetail(mine, panel = $('silicon-detail-' + mine.gridId)) {
  if (!panel) return;
  const index = siliconSelection.get(mine.gridId) ?? 0;
  const card = panel.closest('.silicon-mine');
  for (const slot of card.querySelectorAll('.silicon-slot')) slot.setAttribute('aria-pressed', String(Number(slot.dataset.slot) === index));
  const player = mine.positions.find(row => row.displayIndex === index)?.player;
  const order = siliconSlotDispatch(mine, index);
  const heading = el('div', 'silicon-detail-heading'), body = el('div', 'silicon-detail-body'), footer = el('div', 'silicon-detail-footer');
  const action = siliconAction?.intent.gridId === mine.gridId ? siliconAction : null;
  const status = el('span', 'dim', player ? ({ self: '我的舰队', ally: '同盟', other: '其他玩家' })[player.relation] : '空闲');
  heading.append(el('strong', '', (index + 1) + '号矿位'), status);
  panel.replaceChildren(heading, body, footer);
  if (action) {
    status.textContent = siliconActionNames[action.intent.kind];
    if (action.intent.kind === 'attack') {
      body.append(el('p', '', '抢占目标 · ' + action.intent.opponent.nickname));
      const remaining = action.quote?.fightsRemaining;
      if (action.phase === 'ready' && Number.isInteger(remaining)) {
        status.textContent = '今日共享抢占剩余 ' + remaining + ' 次';
        if (remaining <= 5) status.className = 'warn';
      }
    }
    paintSiliconAction(action, body, footer); return;
  }
  if (!order && siliconResult?.gridId === mine.gridId && siliconResult.index === index) {
    const message = el('p', siliconResult.warning ? 'warn' : 'silicon-mining-status', siliconResult.text);
    message.setAttribute('role', 'status'); body.append(message);
  }
  if (player) {
    siliconFacts(body, [['玩家', player.nickname], ['战力', siliconNumber(player.power)],
      ['联盟', player.guildName || (player.guildIdx ? '联盟 #' + player.guildIdx + '（名称未同步）' : '无联盟'), player.guildDefaultName ? '当前按游戏主城默认名显示' : ''],
      ['本次占矿已采', player.rewardTimes + ' 次']]);
  } else if (!order) body.append(el('p', 'dim', mine.personal ? '可派遣舰队到个人矿位采集。' : '当前无人占领，可派遣舰队采集。'));
  let button;
  if (player?.relation === 'self') button = siliconRetreatButton(player.fleetId);
  else if (order) {
    const state = siliconDispatchLabel(order);
    status.textContent = order.fleetId.replace('远征船', '号舰队');
    button = smallButton(state); button.disabled = true;
  }
  else if (!player || (!mine.personal && player.relation === 'other')) {
    const intent = player ? { kind: 'attack', gridId: mine.gridId, index, opponent: { nickname: player.nickname, guildIdx: player.guildIdx, power: player.power } } : { kind: 'dispatch', gridId: mine.gridId, index };
    const unavailable = !siliconData.reward ? '奖励额度未同步' : siliconData.reward.remaining <= 0 ? '本周期奖励额度已用完'
      : player && !siliconData.fights ? '抢占次数未同步' : player && siliconData.fights.remaining <= 0 ? '今日抢占次数已用完' : '';
    button = siliconActionButton(intent, unavailable);
  }
  if (button?.dataset.unavailable) body.append(el('p', 'dim', button.dataset.unavailable));
  if (button) { button.id = 'silicon-slot-action-' + mine.gridId; footer.append(button); }
}
function siliconSlotDispatch(mine, index) {
  return siliconData?.dispatches?.find(order => order.gridId === mine.gridId && order.index === index);
}
function siliconDispatchLabel(order) {
  return order.pending ? '待确认' : order.kind === 'attack' ? '抢占中' : '已派遣';
}
function selectSiliconSlot(mine, index) {
  if (siliconAction?.phase === 'sending') return;
  const previous = siliconAction?.mine;
  siliconAction = null; siliconResult = null;
  siliconSelection.set(mine.gridId, index);
  if (previous && previous !== mine) paintSiliconDetail(previous);
  paintSiliconDetail(mine); updateSiliconControls();
}
function paintSiliconMine(mine) {
  const card = el('article', 'silicon-mine'); card.dataset.tier = mine.tier;
  const heading = el('div', 'silicon-mine-heading'), title = el('h3', '', mine.name), crystal = el('span', 'silicon-crystal');
  crystal.setAttribute('aria-hidden', 'true'); title.prepend(crystal);
  heading.append(title, el('span', 'dim', mine.personal ? '个人矿位' : '公共矿位')); card.append(heading);
  if (mine.reason) card.append(el('p', 'warn', '矿位未同步：' + mine.reason));
  else {
    card.append(el('p', 'silicon-mine-count', (mine.personal ? '我的采集 ' : '已占 ') + mine.occupied + ' / ' + mine.positionCount + ' · 空位 ' + mine.empty));
    const grid = el('div', 'silicon-slots');
    grid.setAttribute('aria-label', mine.name + '矿位');
    // 异常的大容量也不生成数千个按钮；真实矿位总数仍完整显示。
    const shown = Math.min(mine.positionCount, 96);
    for (let index = 0; index < shown; index++) {
      const player = mine.positions.find(row => row.displayIndex === index)?.player;
      const relation = player?.relation || 'empty', order = siliconSlotDispatch(mine, index);
      const label = order && relation !== 'self' ? siliconDispatchLabel(order) : ({ self: '我的', ally: '同盟', other: '占领', empty: '空闲' })[relation];
      const button = el('button', 'silicon-slot'); button.type = 'button'; button.dataset.relation = relation; button.dataset.slot = String(index);
      button.id = 'silicon-slot-' + mine.gridId + '-' + index;
      button.setAttribute('aria-label', mine.name + ' ' + (index + 1) + '号矿位：' + (player ? player.nickname + '，' + label + '，战力 ' + siliconNumber(player.power) : label));
      button.setAttribute('aria-controls', 'silicon-detail-' + mine.gridId);
      button.append(el('span', '', String(index + 1)), el('small', '', label));
      button.onclick = () => selectSiliconSlot(mine, index);
      grid.append(button);
    }
    card.append(grid);
    if (shown < mine.positionCount) card.append(el('p', 'dim', '展示前 ' + shown + ' 个矿位'));
  }
  if (mine.rewards.length) {
    const rewards = el('div', 'silicon-rewards'); rewards.append(el('span', 'dim', '每轮可能产出'));
    const list = el('ul');
    for (const reward of mine.rewards) list.append(el('li', '', reward.name + ' ×' + reward.num));
    rewards.append(list); card.append(rewards);
  }
  if (!mine.reason && mine.positionCount > 0) {
    if ((siliconSelection.get(mine.gridId) ?? 0) >= mine.positionCount) siliconSelection.delete(mine.gridId);
    const detail = el('section', 'silicon-position-detail'); detail.id = 'silicon-detail-' + mine.gridId;
    detail.setAttribute('aria-label', mine.name + '矿位详情'); card.append(detail); paintSiliconDetail(mine, detail);
  }
  return card;
}
function paintSiliconOverview(data) {
  siliconTimers = [];
  const focus = $('silicon-overview').contains(document.activeElement) && document.activeElement.id;
  const anchor = document.activeElement.closest('.silicon-mine')?.querySelector('.silicon-position-detail')
    ?? $('silicon-detail-' + (siliconAction?.intent.gridId ?? siliconResult?.gridId));
  const before = anchor?.getBoundingClientRect();
  const summary = clear($('silicon-summary')), fleets = clear($('silicon-fleets')), mines = clear($('silicon-mines'));
  if (data.reward || data.fights || data.fleets.length || data.mines.length) {
    for (const [label, value, note] of [
      ['本周期已领', data.reward ? data.reward.claimed + ' / ' + data.reward.max + ' 次' : '未同步', '三天共享额度，非今日收益'],
      ['剩余奖励', data.reward ? data.reward.remaining + ' 次' : '未同步', '全部舰队共享'],
      ['今日抢占', data.fights ? data.fights.used + ' / ' + data.fights.max + ' 次' : '未同步', '玩家共享次数'],
    ]) {
      const item = el('div', 'silicon-stat'); item.append(el('span', 'dim', label), el('strong', '', value), el('small', 'dim', note)); summary.append(item);
    }
    const reset = el('div', 'silicon-stat'); reset.append(el('span', 'dim', '奖励重置'), siliconTimer(data.reward?.resetAt, '剩余', '已到重置时间，等待同步'));
    reset.append(el('small', 'dim', data.reward ? new Date(data.reward.resetAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + '（北京时间）' : '时间未同步')); summary.append(reset);
  }
  if (!data.fleetsSynced && data.mines.length) fleets.append(el('p', 'dim', '舰队状态未同步'));
  for (const fleet of data.fleets) {
    const card = el('article', 'silicon-fleet'), heading = el('div', 'silicon-fleet-heading');
    heading.append(el('h3', '', fleet.name), el('span', fleet.mining ? 'silicon-mining-status' : 'dim', fleet.status)); card.append(heading);
    const activity = el('div', 'silicon-fleet-activity');
    activity.append(el('p', 'silicon-fleet-location', fleet.mineName ? fleet.mineName + (fleet.slot ? ' · ' + fleet.slot + '号位' : '') : fleet.mining ? '采矿位置待同步' : '当前未占领硅矿'));
    if (fleet.collected != null) activity.append(el('span', 'dim silicon-fleet-collected', '已采 ' + siliconNumber(fleet.collected) + ' 次'));
    if (fleet.timerKind) activity.append(siliconTimer(fleet.endAt, ({ reward: '下次产奖', arrival: '预计抵达', repair: '维修剩余' })[fleet.timerKind], ({ reward: '产奖时间已到，等待服务器结算', arrival: '抵达时间已到，等待同步', repair: '维修时间已到，等待同步' })[fleet.timerKind]));
    if (fleet.mining) {
      const button = siliconRetreatButton(fleet.id);
      button.id = 'silicon-fleet-retreat-' + fleet.id;
      if (button.dataset.unavailable) {
        button.textContent = fleet.retreatAllowed === false ? '首奖后可撤回' : '撤回待同步';
        button.setAttribute('aria-label', '撤回舰队，' + button.textContent);
      }
      activity.append(button);
    }
    card.append(activity);
    siliconFacts(card, [['战力', siliconNumber(fleet.power)], ['耐久', siliconNumber(fleet.durability) + ' / ' + siliconNumber(fleet.maxDura)]]);
    fleets.append(card);
  }
  for (const mine of data.mines) mines.append(paintSiliconMine(mine));
  if (data.reason) mines.prepend(el('p', 'silicon-empty dim', data.reason));
  $('silicon-notes').textContent = data.notes.join(' ');
  if (focus && document.activeElement.id !== focus) document.getElementById(focus)?.focus({ preventScroll: true });
  if (before?.bottom > 0 && before.top < innerHeight && siliconVisible()) {
    const after = $(anchor.id)?.getBoundingClientRect();
    if (after && after.top !== before.top) window.scrollBy(0, after.top - before.top);
  }
}
function currentSiliconTarget(action, mine) {
  const { intent } = action;
  if (!mine || mine.reason || intent.index >= mine.positionCount) return false;
  const player = mine.positions.find(row => row.displayIndex === intent.index)?.player;
  if (intent.kind === 'retreat') return player?.fleetId === intent.fleetId;
  if (siliconSlotDispatch(mine, intent.index)) return false;
  return intent.kind === 'dispatch' ? !player : player?.relation === 'other' && player.nickname === intent.opponent.nickname
    && player.guildIdx === intent.opponent.guildIdx && player.power === intent.opponent.power;
}
async function refreshSiliconOverview() {
  const action = siliconAction;
  if (!siliconConnected() || siliconLoading || action?.phase === 'preview' || action?.phase === 'sending') return;
  const account = current, serial = ++siliconSerial; setSiliconSnapshot({ siliconOwner: account, siliconLoading: true, siliconLastAttempt: Date.now() });
  if (action) {
    action.phase = 'preview'; action.message = '';
    $('silicon-action-confirm').disabled = true;
  }
  updateSiliconControls(); $('silicon-status').textContent = '正在同步硅矿…'; $('silicon-overview').setAttribute('aria-busy', 'true');
  try {
    const data = await call('/api/silicon/overview');
    if (account !== current || serial !== siliconSerial || !siliconConnected()) return;
    setSiliconSnapshot({ siliconData: data, siliconReceivedAt: Date.now() });
    if (action && siliconAction === action) {
      const mine = data.mines.find(row => row.gridId === action.intent.gridId);
      if (currentSiliconTarget(action, mine)) action.mine = mine;
      else {
        siliconAction = null;
        siliconResult = { ...action.intent, warning: true, text: '矿位状态已变化，请重新选择。' };
      }
    }
    paintSiliconOverview(data);
    if (siliconResult && !siliconResult.warning && siliconResult.kind !== 'retreat') siliconResult = null;
    $('silicon-status').textContent = (data.notes.length || data.mines.some(mine => mine.reason) ? '部分信息未同步 · ' : '更新 ') + new Date(data.checkedAt * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    if (data.reason && !data.mines.length) $('silicon-status').textContent = data.reason;
    if (action && siliconAction === action) await readSiliconAction(action);
  } catch (error) {
    if (account === current && serial === siliconSerial) {
      $('silicon-status').textContent = '同步失败：' + error.message + (siliconData ? '；下方为上次同步结果' : '');
      if (siliconData) setSiliconSnapshot({ siliconReceivedAt: Date.now() - siliconStaleAfter() - 1 });
      if (action && siliconAction === action) {
        action.phase = 'error'; action.message = '未能刷新舰队：' + error.message; paintSiliconDetail(action.mine);
      }
    }
  } finally {
    if (serial === siliconSerial) { setSiliconSnapshot({ siliconLoading: false, siliconLastAttempt: Date.now() }); updateSiliconControls(); $('silicon-overview').setAttribute('aria-busy', 'false'); }
  }
}
function maybeRefreshSilicon() {
  siliconAccountChanged();
  const waiting = siliconAction?.phase === 'ready' && !siliconAction.fleetId || siliconAction?.phase === 'error';
  if (siliconAutoRefresh && siliconVisible() && siliconConnected() && !siliconLoading && (!siliconAction || waiting) && Date.now() - siliconLastAttempt >= siliconRefreshSeconds * 1000) void refreshSiliconOverview();
}
setInterval(() => {
  maybeRefreshSilicon();
  if (siliconAction?.phase === 'ready' && Date.now() >= siliconAction.quote.expiresAt) expireSiliconAction();
  if (!siliconVisible() || !siliconData) return;
  siliconTimers = siliconTimers.filter(timer => timer.node.isConnected);
  for (const timer of siliconTimers) timer.node.textContent = siliconTimerText(timer.endAt, timer.label, timer.finished);
}, 1000);
$('silicon-refresh').onclick = refreshSiliconOverview;
function paintSiliconRefresh() {
  const button = $('silicon-auto-refresh'); button.setAttribute('aria-pressed', String(siliconAutoRefresh));
  button.textContent = '自动刷新：' + (siliconAutoRefresh ? '开' : '关');
  button.title = '总览可见时自动刷新矿位及等待中的舰队。';
  $('silicon-refresh-seconds').value = String(siliconRefreshSeconds);
}
function saveSiliconRefresh() {
  try { localStorage.setItem('cw.silicon.refresh', JSON.stringify({ enabled: siliconAutoRefresh, seconds: siliconRefreshSeconds })); } catch {}
}
$('silicon-auto-refresh').onclick = () => {
  siliconAutoRefresh = !siliconAutoRefresh; paintSiliconRefresh(); saveSiliconRefresh();
  if (siliconAutoRefresh) { setSiliconSnapshot({ siliconLastAttempt: 0 }); maybeRefreshSilicon(); }
};
$('silicon-refresh-seconds').onchange = event => {
  const input = event.target, seconds = Number(input.value);
  if (!input.value || !Number.isInteger(seconds) || seconds < 5 || seconds > 300) {
    input.setCustomValidity('请输入 5–300 之间的整数秒数'); input.reportValidity(); return;
  }
  input.setCustomValidity(''); siliconRefreshSeconds = seconds; saveSiliconRefresh(); maybeRefreshSilicon();
};
$('silicon-refresh-seconds').oninput = event => event.target.setCustomValidity('');
paintSiliconRefresh();
