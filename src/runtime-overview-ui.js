// 总览、配置分组与只读预览都按同一条记录解释运行状态。
const runtimeLabels = {
  error: '失败', pending: '结果待确认', blocked: '开关受限', setup: '待配置',
  disabled: '已关闭', scope: '已开启', unseen: '待检查', unsynced: '待同步',
  idle: '未运行', offline: '未连接', stopping: '正在停止', recovery: '重连中',
  ok: '最近成功', sent: '已发送', waiting: '已检查', full: '耐久已满', busy: '舰队占用',
  repairing: '维修中', ready: '准备维修', fuelWait: '等待维修',
};
const attentionOrder = ['error', 'pending', 'blocked', 'setup'];

function loopPhase(data) {
  if (data.settingsRecovery?.required) return ['error', '配置待恢复', data.settingsRecovery.message];
  if (data.stopping) return ['stopping', '正在停止挂机'];
  if (data.recovery) return ['recovery', '正在重连', data.recovery.reason];
  if (data.error && !data.running) return ['error', '挂机已中止', data.error];
  if (!data.running) return ['idle', '挂机已停止'];
  if (data.connected === false) return ['offline', '等待连接'];
  return ['running', '挂机中'];
}

function runtimeControlItem(control, data) {
  const seen = control.observation ?? {};
  const group = control.group === '总控制' ? '运行范围与权限' : control.group;
  const item = {label: control.label, group, enabled: control.enabled, state: seen.state || 'unseen', detail: '', history: ''};
  if (!control.enabled) item.state = 'disabled';
  else if (control.blockedBy?.length) {
    item.state = 'blocked';
    item.detail = '受以下设置限制：'+control.blockedBy.join('、');
  } else if (control.configurationNote) {
    item.state = 'setup';
    item.detail = control.configurationNote;
  } else if (seen.state !== 'scope') {
    const [phase] = loopPhase(data);
    if (phase !== 'running' || control.stale) item.state = phase === 'running' || phase === 'error' ? 'idle' : phase;
  }
  const progress = control.progress && control.progress !== '—' ? control.progress : '';
  const observation = !['scope','unseen'].includes(seen.state) ? seen.text : '';
  const evidence = progress && observation && !observation.includes(progress)
    ? progress+' · '+observation : observation || progress;
  if (evidence) {
    if (item.state === seen.state) item.detail = evidence;
    else item.history = evidence;
  }
  return item;
}

function maintenanceItems(data) {
  const monitor = data.fleetMaintenance;
  if (!monitor || !(monitor.configured ?? monitor.enabled)) return [];
  const base = {group:'战后维修', enabled:true, history:''};
  if (!monitor.enabled || !monitor.rows?.length) {
    const state = !monitor.enabled ? 'idle' : monitor.reason ? 'pending' : monitor.checkedAt ? 'waiting' : 'unseen';
    return [{...base, label:'维修监控', state, detail:monitor.enabled ? monitor.reason || (monitor.checkedAt ? '本次没有匹配的舰队' : '') : ''}];
  }
  return monitor.rows.map(row => ({
    ...base, label:row.name, state:({unknown:'pending', waiting:'fuelWait'})[row.state] || row.state,
    detail:[row.source, row.durability != null && row.maxDura != null ? '耐久 '+row.durability+'/'+row.maxDura : '', row.condition].filter(Boolean).join(' · '),
  }));
}

function runtimeAttention(items) {
  return attentionOrder.flatMap(state => items.filter(item => item.state === state));
}

function runtimeBadge(state, label = runtimeLabels[state]) {
  const badge = el('span', 'runtime-badge', label);
  badge.dataset.state = state;
  return badge;
}

function runtimeDetail(text) {
  if (text.length <= 90) return el('span', 'runtime-detail', text);
  const details = el('details', 'runtime-detail');
  const excerpt = text.slice(0, 72) + '…';
  const summary = el('summary', '', excerpt);
  details.ontoggle = () => { summary.textContent = details.open ? '收起完整说明' : excerpt; };
  details.append(summary, el('p', '', text));
  return details;
}

function runtimeRow(item, { showGroup = false, history = false } = {}) {
  const row = el('div', 'runtime-row'), name = el('div', 'runtime-name');
  if (showGroup) name.append(el('span', 'runtime-group-name', item.group));
  name.append(el('strong', '', item.label));
  row.append(name, runtimeBadge(item.state));
  const text = [item.detail, history && item.history && '上次记录 · ' + item.history].filter(Boolean).join(' · ');
  if (text) row.append(runtimeDetail(text));
  return row;
}

let overviewLoopData = null, overviewLoopOwner = null;
const overviewList = $('overview-task-groups');
const overviewSlots = new Map();

// 按配置页的功能归并细项；没有独立配置分组的动作仍单独展示。
function overviewFeatures(data) {
  const groups = new Map();
  function add(id, label, target, item) {
    if (!groups.has(id)) groups.set(id, {id, label, target, items:[]});
    groups.get(id).items.push(item);
  }
  for (const control of data.controls) {
    const owner = !activityOwnedSettings.has(control.key) && configGroups.find(group =>
      control.configTarget ? group.id === control.configTarget : group.fields.some(field => field.key === control.key));
    const globalSwitch = control.group === '总控制' && control.key !== 'heroes.enabled';
    const item = {...runtimeControlItem(control, data), checkedAt:control.observation?.checkedAt || 0,
      scope:control.observation?.state === 'scope'};
    if (globalSwitch) add('global', '运行开关与权限', null, item);
    else add(owner?.id || control.configTarget || control.key, owner?.title || control.idleLabel || control.label,
      owner?.id, item);
  }
  for (const item of maintenanceItems(data)) add('maintenance', '战后维修', null, item);
  return [...groups.values()].sort((a,b) => Number(a.id === 'global') - Number(b.id === 'global')
    || Number(b.items.some(item => item.enabled)) - Number(a.items.some(item => item.enabled)));
}

function overviewFeatureResult(items, allItems) {
  const active = items.filter(item => item.enabled && item.state !== 'scope');
  const inspected = active.filter(item => item.detail);
  const sample = runtimeAttention(active)[0] || inspected.sort((a,b) => b.checkedAt - a.checkedAt)[0]
    || active[0] || items.find(item => item.enabled) || items[0];
  const relevant = allItems.filter(item => item.enabled && item.state !== 'scope');
  const same = relevant.filter(item => item.state === sample.state).length;
  let stateText = runtimeLabels[sample.state] || sample.state;
  if (same > 0 && same < relevant.length) stateText = same+' 项'+(sample.state === 'ok' ? '成功' : stateText);
  if (sample.state === 'scope' && !relevant.length && allItems.some(item => !item.scope && !item.enabled)) {
    stateText = '未开启动作';
  }
  const detail = sample.detail || (sample.history ? '上次记录 · '+sample.history : '');
  const shared = relevant.length > 1 && relevant.every(item => item.detail === sample.detail && item.state === sample.state);
  return {sample, stateText, detail, shared};
}

function updateOverviewFeature(section, feature, matches) {
  const {sample, stateText, detail, shared} = overviewFeatureResult(matches, feature.items);
  const reason = detail && !shared && feature.items.length > 1 && sample.label !== feature.label
    ? sample.label+' · '+detail : detail;
  const summaryKey = JSON.stringify([feature.label, sample.state, stateText, reason]);
  if (section.summaryKey !== summaryKey) {
    const title = section.querySelector('summary') || section.appendChild(el('summary'));
    clear(title).append(el('strong', '', feature.label), runtimeBadge(sample.state, stateText),
      el('span', 'overview-result', reason || '—'));
    section.summaryKey = summaryKey;
  }

  // 轮询时保留展开的行、配置链接的焦点和正在阅读的完整说明。
  const key = JSON.stringify(feature.items.map(({checkedAt, ...item}) => item));
  if (section.detailKey !== key) {
    let body = section.querySelector('.overview-actions');
    if (!body) body = section.appendChild(el('div', 'overview-actions'));
    clear(body);
    for (const item of feature.items) body.append(runtimeRow(item, {history:true}));
    section.detailKey = key;
  }
  if (feature.target && !section.querySelector('.overview-config-link')) {
    const link = el('a', 'overview-config-link', '查看'+feature.label+'配置');
    link.href = '#config-group-'+encodeURIComponent(feature.target);
    section.append(link);
  }
}

// 以实际行高占位，浏览器负责滚动和定位；只挂载视口附近的功能详情。
function mountOverviewSlot(slot) {
  const {feature, matches} = slot.entry;
  const section = slot.section || el('details', 'overview-feature');
  section.dataset.feature = feature.id;
  updateOverviewFeature(section, feature, matches);
  slot.section = section;
  if (section.parentNode === slot) return;
  const focused = document.activeElement === slot.placeholder;
  slot.replaceChildren(section);
  slot.style.height = '';
  if (focused) section.firstElementChild.focus({preventScroll:true});
}

function unmountOverviewSlot(slot) {
  const section = slot.section;
  if (!section || section.parentNode !== slot || slot.contains(document.activeElement)) return;
  const height = slot.getBoundingClientRect().height;
  if (!height) return;
  slot.style.height = height+'px';
  slot.replaceChildren(slot.placeholder);
  // 展开的原节点离开页面后保留，滚回来时长说明也仍在原处。
  if (!section.open) slot.section = null;
}

const overviewObserver = new IntersectionObserver(entries => {
  const atEnd = overviewList.scrollTop > 0 &&
    overviewList.scrollHeight - overviewList.clientHeight - overviewList.scrollTop <= 1;
  for (const {target:slot, isIntersecting} of entries) {
    if (!overviewList.contains(slot)) continue;
    slot.near = isIntersecting;
    if (isIntersecting) mountOverviewSlot(slot);
    else unmountOverviewSlot(slot);
  }
  if (atEnd) overviewList.scrollTop = overviewList.scrollHeight;
}, {root:overviewList, rootMargin:'160px 0px'});

overviewList.addEventListener('keydown', event => {
  if (event.key !== 'Home' && event.key !== 'End') return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  overviewList.focus({preventScroll:true});
  overviewList.scrollTop = event.key === 'Home' ? 0 : overviewList.scrollHeight;
});

function createOverviewSlot(entry) {
  const slot = el('div', 'overview-slot');
  slot.entry = entry;
  const button = el('button', 'overview-placeholder', entry.feature.label);
  button.type = 'button';
  slot.placeholder = button;
  button.onfocus = () => { if (button.matches(':focus-visible')) mountOverviewSlot(slot); };
  button.onclick = () => {
    mountOverviewSlot(slot);
    slot.section.firstElementChild.focus({preventScroll:true});
    slot.section.open = !slot.section.open;
  };
  slot.onfocusout = () => queueMicrotask(() => {
    if (slot.isConnected && !slot.near) unmountOverviewSlot(slot);
  });
  slot.append(button);
  overviewObserver.observe(slot);
  return slot;
}

function resetAutomationOverview(message, resetFilters = true) {
  overviewLoopData = null;
  overviewLoopOwner = current;
  $('overview-task-summary').textContent = message;
  delete $('overview-task-summary').dataset.key;
  $('overview-loop-reason').hidden = true;
  overviewObserver.disconnect();
  overviewSlots.clear();
  clear(overviewList);
  $('overview-browser').hidden = true;
  if (resetFilters) {
    overviewList.scrollTop = 0;
    $('overview-task-search').value = '';
    $('overview-task-filter').value = 'all';
  }
}

function renderAutomationOverview(data) {
  overviewLoopOwner = current;
  overviewLoopData = data;
  if (!Array.isArray(data.controls)) { resetAutomationOverview('运行状态尚未同步', false); return; }
  const [phase, label, reason] = loopPhase(data);
  const summary = $('overview-task-summary');
  const showRound = Number.isInteger(data.completed) && (data.running || data.completed > 0);
  const count = data.running && data.rounds > 0 ? data.completed+' / '+data.rounds : data.completed;
  const rounds = showRound ? (data.running ? '本次完成 ' : '上次完成 ')+count+' 轮' : '';
  const phaseKey = JSON.stringify([phase, label, rounds, reason]);
  if (summary.dataset.key !== phaseKey) {
    clear(summary).append(runtimeBadge(phase, label));
    if (rounds) summary.append(el('span', 'overview-rounds', rounds));
    const message = $('overview-loop-reason');
    message.hidden = !reason;
    message.textContent = reason || '';
    summary.dataset.key = phaseKey;
  }

  $('overview-browser').hidden = false;
  const query = $('overview-task-search').value.trim().toLowerCase(), mode = $('overview-task-filter').value;
  const selected = [];
  for (const feature of overviewFeatures(data)) {
    const inMode = mode === 'issues' ? runtimeAttention(feature.items) :
      mode === 'enabled' ? feature.items.filter(item => item.enabled) : feature.items;
    const matches = !query || feature.label.toLowerCase().includes(query) ? inMode : inMode.filter(item =>
      [item.group, item.label, runtimeLabels[item.state], item.detail, item.history].join(' ').toLowerCase().includes(query));
    if (matches.length) selected.push({feature, matches});
  }
  const ids = new Set(selected.map(({feature}) => feature.id));
  for (const [id, slot] of overviewSlots) {
    if (!ids.has(id)) {
      overviewObserver.unobserve(slot);
      overviewSlots.delete(id);
      slot.remove();
    }
  }
  const empty = overviewList.querySelector('.overview-empty');
  if (empty && selected.length) empty.remove();
  selected.forEach((entry, index) => {
    const id = entry.feature.id;
    let slot = overviewSlots.get(id);
    if (!slot) {
      slot = createOverviewSlot(entry);
      overviewSlots.set(id, slot);
    } else {
      slot.entry = entry;
      if (slot.section?.parentNode === slot) updateOverviewFeature(slot.section, entry.feature, entry.matches);
    }
    const next = overviewList.children[index];
    if (next !== slot) overviewList.insertBefore(slot, next || null);
  });
  if (!selected.length) {
    const message = empty || overviewList.appendChild(el('p', 'runtime-message overview-empty'));
    message.textContent = query ? '没有找到匹配的功能或原因' : mode === 'issues' ? '当前没有需关注的功能'
      : mode === 'enabled' ? '当前没有已开启的功能' : '暂无功能记录';
  }
  const matches = $('overview-matches');
  const counter = '共 '+selected.length+' 个功能';
  if (matches.textContent !== counter) matches.textContent = counter;
}

function refreshOverviewFilter() {
  overviewList.scrollTop = 0;
  if (overviewLoopData && overviewLoopOwner === current) renderAutomationOverview(overviewLoopData);
}
$('overview-task-search').oninput = refreshOverviewFilter;
$('overview-task-filter').onchange = refreshOverviewFilter;

let merchantOverviewTimer;
function renderMerchantOverview(merchant) {
  clearTimeout(merchantOverviewTimer);
  merchantOverviewTimer = null;
  const card = $('merchant-overview');
  const section = clear($('merchant-overview-progress'));
  card.hidden = true;
  if (!merchant || !(merchant.serverNow < merchant.endTime)) return;
  const upcoming = merchant.serverNow < merchant.startTime;
  const boundary = upcoming ? merchant.startTime : merchant.endTime;
  const delay = Math.ceil((boundary - merchant.serverNow) * 1000);
  if (delay <= 2147483647) merchantOverviewTimer = setTimeout(() => {
    merchantOverviewTimer = null;
    card.hidden = true;
    clear(section);
    if (upcoming && !document.hidden && !$('tab-overview').classList.contains('hidden')) void refreshOverview();
  }, delay);
  if (upcoming) return;
  card.hidden = false;
  const goal = merchant.goal;
  if (goal) {
    const fmt = value => value == null ? '未同步' : value.toLocaleString('zh-CN');
    section.appendChild(el('strong', null, '个人累计利润 ' + fmt(goal.profit) + ' / ' + fmt(goal.target)));
    const bar = el('progress');
    bar.max = goal.target;
    if (goal.profit != null) bar.value = Math.min(goal.profit, goal.target);
    bar.setAttribute('aria-label', '5000 万利润目标');
    section.appendChild(bar);
    const reward = goal.reward.map(([item, count]) => item + ' ×' + count).join('、');
    const gap = goal.remaining == null ? '进度待同步' : goal.remaining === 0 ? '已达标' : '还差 ' + fmt(goal.remaining);
    section.appendChild(el('p', null, '5000 万目标' + (reward ? '奖励 ' + reward : '') + ' · ' + gap));
    if (goal.totalTiers && goal.claimed != null) {
      const next = goal.nextTier;
      const claimed = goal.claimed ? '已领至第 ' + goal.claimed + ' 档' : '尚未领取利润奖励';
      section.appendChild(el('p', null, next ? claimed + ' · 第 ' + next.id + ' 档需 ' + fmt(next.target) +
        ' 利润' + (goal.ready ? '（可领取）' : '') : '本期利润奖励已全部领取'));
    } else section.appendChild(el('p', 'dim', '本期利润奖励档位待同步'));
    if (goal.remaining > 0 && goal.remainingTradingSeconds != null) {
      section.appendChild(el('p', null, goal.remainingTradingSeconds > 0
        ? '剩余交易时间 ' + (goal.remainingTradingSeconds / 3600).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) +
          ' 小时 · 达标需每小时 ' + fmt(goal.requiredPerHour) + ' 利润' +
          (goal.observedPerHour == null ? '' : ' · 本期已开放时段平均 ' + fmt(goal.observedPerHour) + ' / 小时')
        : '本期交易时段已结束'));
    }
  }
  for (const line of merchant.lines ?? ['本期商船数据待同步，请刷新']) section.appendChild(el('p', null, line));
  if (goal?.checkedAt) section.appendChild(el('p', 'dim', '数据更新于 ' + activityDate(goal.checkedAt) + '（北京时间）'));
}

consoleStore.subscribe((state, previous) => {
  const account = state.currentAccountId;
  const status = CWConsoleState.selectCurrentStatus(state);
  const data = state.gameByAccount[account]?.overview;
  if (account !== previous.currentAccountId || !status.connected || status.paused || status.loginBlocked || state.disconnected.has(account)) {
    if (merchantOverviewTimer || !$('merchant-overview').hidden) renderMerchantOverview(null);
  } else if (data !== previous.gameByAccount[account]?.overview) {
    renderMerchantOverview(data?.merchant);
  }
});
