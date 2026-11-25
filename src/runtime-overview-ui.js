// 总览、配置分组与只读预览都按同一条记录解释运行状态。
const runtimeLabels = {
  error: '失败', pending: '结果待确认', blocked: '开关受限', setup: '待配置',
  disabled: '已关闭', scope: '已开启', unseen: '待检查', unsynced: '待同步',
  idle: '未运行', offline: '未连接', stopping: '正在停止', recovery: '重连中',
  ok: '最近成功', sent: '已发送', waiting: '已检查', full: '耐久已满', busy: '舰队占用',
  completed: '已完成', inProgress: '进行中', claimable: '可领取',
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

const merchantNumber = value => value == null ? '未同步' : value.toLocaleString('zh-CN');
const merchantAmount = value => value >= 10000 && value % 100 === 0
  ? merchantNumber(value / 10000) + ' 万' : merchantNumber(value);

function merchantFacts(rows) {
  const list = el('dl', 'merchant-facts');
  for (const [label, value] of rows) {
    const pair = el('div');
    pair.append(el('dt', null, label), el('dd', null, value));
    list.append(pair);
  }
  return list;
}

function merchantTierNode(tier, previousTarget, goal, items, state) {
  const node = el('li', 'merchant-tier');
  node.dataset.state = state;
  const states = { claimed: '已领取', ready: '可领取', reached: '已达成', next: '下一档', locked: '未达成', unknown: '待同步' };
  const caption = el('div', 'merchant-tier-caption');
  caption.append(el('span', null, '第 ' + tier.id + ' 档'), el('span', 'merchant-tier-state', states[state]));
  const rail = el('div', 'merchant-rail');
  const fill = el('span');
  rail.append(fill);
  if (state === 'next') {
    node.setAttribute('aria-current', 'step');
    const span = tier.target - previousTarget;
    fill.style.width = (span > 0 ? Math.max(0, (goal.profit - previousTarget) / span) * 100 : 0) + '%';
    rail.setAttribute('role', 'progressbar');
    rail.setAttribute('aria-label', '前往第 ' + tier.id + ' 档');
    rail.setAttribute('aria-valuemin', previousTarget);
    rail.setAttribute('aria-valuemax', tier.target);
    rail.setAttribute('aria-valuenow', Math.max(previousTarget, goal.profit));
    rail.setAttribute('aria-valuetext', '累计利润 ' + merchantNumber(goal.profit) + '，目标 ' + merchantNumber(tier.target));
  }
  const target = el('p', 'merchant-tier-target');
  target.append(el('strong', null, merchantAmount(tier.target)), el('span', null, '利润'));
  node.append(caption, rail, target);
  for (const [id, count] of tier.rewards) {
    const reward = el('div', 'merchant-reward');
    const item = items?.[id];
    if (item?.icon) reward.append(iconEl(item.icon, 22, item.name));
    const label = el('span', null, item?.name || id);
    label.append(' ', el('b', null, '×' + merchantAmount(count)));
    reward.title = id + ' ×' + merchantNumber(count);
    reward.append(label);
    node.append(reward);
  }
  if (!tier.rewards.length) node.append(el('span', 'merchant-caption', '奖励待同步'));
  return node;
}

let merchantRewardObserver;
function renderMerchantRewardStrip(section, actions, nodes, focusIndex, position) {
  const list = el('ol', 'merchant-tiers');
  list.id = 'merchant-reward-tiers';
  list.setAttribute('aria-label', '累计利润奖励档位');
  if (position != null) list.dataset.position = position;
  list.append(...nodes);
  section.append(list);

  let width = 0, stride = 0, cardsPerGroup = 1, lastLeft = 0;
  const controls = el('div', 'merchant-tier-controls');
  function arrow(id, label, direction) {
    const button = smallButton('');
    button.id = id;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-controls', list.id);
    button.onclick = () => {
      const groupWidth = cardsPerGroup * stride;
      const target = direction > 0 ? Math.floor((list.scrollLeft + 1) / groupWidth) + 1
        : Math.ceil((list.scrollLeft - 1) / groupWidth) - 1;
      list.scrollLeft = target * groupWidth;
      rememberPosition();
    };
    return button;
  }
  const prev = arrow('merchant-tier-prev', '上一组奖励', -1);
  const next = arrow('merchant-tier-next', '下一组奖励', 1);
  controls.append(prev, next);
  actions.append(controls);

  function updateArrows() {
    prev.disabled = list.scrollLeft <= 1;
    next.disabled = list.scrollLeft >= list.scrollWidth - width - 1;
  }
  function layout() {
    if (!list.clientWidth || width === list.clientWidth) return;
    width = list.clientWidth;
    const first = nodes[0].getBoundingClientRect();
    stride = nodes.length > 1 ? nodes[1].getBoundingClientRect().left - first.left : first.width;
    cardsPerGroup = Math.max(1, Math.round(width / stride));
    controls.hidden = list.scrollWidth <= width;
    list.tabIndex = controls.hidden ? -1 : 0;
    if (list.dataset.position != null) list.scrollLeft = Number(list.dataset.position) * stride;
    else if (controls.offsetWidth) list.scrollLeft = Math.floor(focusIndex / cardsPerGroup) * cardsPerGroup * stride;
    else list.scrollLeft = focusIndex * stride - (width - first.width) / 2;
    lastLeft = list.scrollLeft;
    updateArrows();
  }
  function rememberPosition() {
    if (list.clientWidth !== width || !stride || list.scrollLeft === lastLeft) return;
    lastLeft = list.scrollLeft;
    list.dataset.position = String(lastLeft / stride);
    updateArrows();
  }
  list.onscroll = rememberPosition;
  list.onkeydown = event => {
    if (event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    list.scrollLeft = event.key === 'Home' ? 0 : list.scrollWidth;
  };
  layout();
  merchantRewardObserver = new ResizeObserver(layout);
  merchantRewardObserver.observe(list);
}

function renderMerchantRewards(section, goal, items, position, intel) {
  const tiers = goal.tiers ?? [];
  const claimed = tier => goal.claimed != null && tier.id <= goal.claimed;
  const reached = tier => claimed(tier) || (goal.profit != null && goal.profit >= tier.target);
  const nextIndex = tiers.findIndex(tier => !reached(tier));
  const next = goal.profit != null ? tiers[nextIndex] : null;
  const head = el('div', 'merchant-scoreboard');
  const score = el('div', 'merchant-score');
  score.append(el('span', 'merchant-caption', '个人累计利润'), el('strong', null, merchantNumber(goal.profit)));
  head.append(score);
  if (next) {
    const gap = el('div', 'merchant-gap');
    gap.append(el('span', 'merchant-caption', '距第 ' + next.id + ' 档还差'), el('strong', null, merchantNumber(next.target - goal.profit)));
    head.append(gap);
  }
  const actions = el('div', 'merchant-score-actions');
  if (intel) {
    const button = smallButton('港口情报');
    button.id = 'merchant-intel-toggle';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'merchant-intel-dialog');
    button.onclick = openMerchantIntel;
    actions.append(button);
  }
  head.append(actions);
  section.append(head);
  if (!tiers.length) {
    section.append(el('p', 'merchant-caption', '本期奖励档位待同步'));
    return;
  }
  const ready = goal.claimed == null ? 0 : tiers.filter(tier => reached(tier) && !claimed(tier)).length;
  const status = goal.claimed == null ? '领取记录待同步' : tiers.every(claimed) ? '奖励已全部领取' : ready ? ready + ' 档可领取' : '';
  if (status) actions.before(el('span', 'merchant-caption', status));
  const nodes = tiers.map((tier, i) => {
    let state = 'locked';
    if (claimed(tier)) state = 'claimed';
    else if (reached(tier)) state = goal.claimed == null ? 'reached' : 'ready';
    else if (goal.profit == null) state = 'unknown';
    else if (tier === next) state = 'next';
    const node = merchantTierNode(tier, tiers[i - 1]?.target ?? 0, goal, items, state);
    node.value = tier.id;
    return node;
  });
  renderMerchantRewardStrip(section, actions, nodes, nextIndex < 0 ? tiers.length - 1 : nextIndex, position);
}

function renderMerchantTrade(section, goal, trade, purchaseDetailsOpen) {
  const heading = el('div', 'merchant-trade-heading');
  heading.append(el('h3', null, '商船动态'), el('span', null, trade.voyage.status));
  const rows = [...trade.voyage.facts, ['商会币', merchantNumber(trade.coins)], ['商船等级', merchantNumber(trade.level)]];
  if (goal.remainingTradingSeconds != null) rows.push(['剩余交易时间', goal.remainingTradingSeconds === 0
    ? '交易时段已结束' : (goal.remainingTradingSeconds / 3600).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 小时']);
  const voyage = el('div', 'merchant-voyage');
  voyage.append(heading, merchantFacts(rows));
  if (trade.voyage.purchaseDetails?.length) {
    const details = el('details');
    const summary = el('summary', 'merchant-caption', '采购明细');
    summary.id = 'merchant-purchase-summary';
    details.open = purchaseDetailsOpen;
    details.append(summary, merchantFacts(trade.voyage.purchaseDetails));
    voyage.append(details);
  }
  section.append(voyage);

  const trades = el('section', 'merchant-trade-group');
  trades.append(el('h3', null, '本期已核实交易'), merchantFacts([
    ['买入', merchantNumber(trade.buys) + ' 笔'], ['卖出', merchantNumber(trade.sells) + ' 笔'],
    ['已实现净利润', merchantNumber(trade.realizedProfit)], ['已用指南针', merchantNumber(trade.pointerUsed) + ' 根'],
    ['指南针加速', trade.autoSpeedUp ? '已开启' : '已关闭'], ['钻石补购', trade.autoBuyPointers ? '已开启' : '已关闭'],
  ]));
  const estimate = [['距目标还差', merchantNumber(goal.remaining)]];
  if (goal.requiredPerHour != null) estimate.push(['每小时需赚', merchantNumber(goal.requiredPerHour)]);
  if (goal.observedPerHour != null) estimate.push(['开放时段每小时实赚', merchantNumber(goal.observedPerHour)]);
  if (goal.remaining > 0 && goal.freeTrips != null) {
    estimate.push(['剩余免费卖货机会', '最多 ' + merchantNumber(goal.freeTrips) + ' 程']);
    if (goal.requiredPerFreeTrip != null) estimate.push(['每程需赚', merchantNumber(goal.requiredPerFreeTrip)]);
  }
  const forecast = el('section', 'merchant-trade-group');
  forecast.append(el('h3', null, merchantAmount(goal.target) + ' 利润目标'), merchantFacts(estimate));
  if (goal.remaining > 0 && goal.freeTrips != null) forecast.append(el('p', null, '免费航程按每程一批、当日到港卖出估算。'));
  for (const note of trade.notes) forecast.append(el('p', null, note));
  section.append(trades, forecast);
}

let merchantAutoRefresh = true, merchantRefreshSeconds = 30;
let merchantRefreshPending = false, merchantLastRefresh = 0, merchantRenderRevision = 0;
const merchantIntervalInput = $('merchant-refresh-seconds');
const merchantRefreshToggle = $('merchant-auto-refresh');
const validMerchantInterval = seconds => Number.isInteger(seconds) && seconds >= 5 && seconds <= 300;
try {
  const saved = JSON.parse(localStorage.getItem('cw.merchant.refresh'));
  if (typeof saved?.enabled === 'boolean') merchantAutoRefresh = saved.enabled;
  if (validMerchantInterval(saved?.seconds)) merchantRefreshSeconds = saved.seconds;
} catch { /* 存储不可用时沿用本页设置。 */ }

function paintMerchantRefresh() {
  merchantRefreshToggle.setAttribute('aria-pressed', String(merchantAutoRefresh));
  merchantRefreshToggle.textContent = '自动刷新：' + (merchantAutoRefresh ? '开' : '关');
  merchantIntervalInput.value = String(merchantRefreshSeconds);
  merchantIntervalInput.setCustomValidity('');
}
function saveMerchantRefresh() {
  try { localStorage.setItem('cw.merchant.refresh', JSON.stringify({ enabled: merchantAutoRefresh, seconds: merchantRefreshSeconds })); } catch {}
}
function merchantPollingActive() {
  return merchantAutoRefresh && current && snapshot.connected && !snapshot.paused && !snapshot.loginBlocked &&
    !disconnected.has(current) && !document.hidden && !$('tab-overview').classList.contains('hidden') && !$('merchant-overview').hidden;
}
async function maybeRefreshMerchant() {
  if (!merchantPollingActive() || merchantRefreshPending || overviewPending?.account === current ||
    Date.now() - merchantLastRefresh < merchantRefreshSeconds * 1000) return;
  const account = current, revision = merchantRenderRevision;
  const stillCurrent = () => current === account && revision === merchantRenderRevision && merchantPollingActive();
  merchantRefreshPending = true;
  try {
    const panel = await call('/api/merchant/overview?account=' + encodeURIComponent(account));
    if (stillCurrent()) renderMerchantOverview(panel);
  } catch (error) {
    if (stillCurrent()) reportError(error, '刷新海商王', account);
  } finally {
    merchantRefreshPending = false;
    merchantLastRefresh = Date.now();
  }
}
merchantRefreshToggle.onclick = () => {
  merchantAutoRefresh = !merchantAutoRefresh;
  paintMerchantRefresh();
  saveMerchantRefresh();
  if (merchantAutoRefresh) { merchantLastRefresh = 0; void maybeRefreshMerchant(); }
};
merchantIntervalInput.oninput = () => merchantIntervalInput.setCustomValidity('');
merchantIntervalInput.onchange = () => {
  const seconds = merchantIntervalInput.valueAsNumber;
  if (!validMerchantInterval(seconds)) {
    merchantIntervalInput.setCustomValidity('请输入 5–300 之间的整数秒数');
    merchantIntervalInput.reportValidity();
    return;
  }
  merchantRefreshSeconds = seconds;
  saveMerchantRefresh();
  void maybeRefreshMerchant();
};
paintMerchantRefresh();
setInterval(maybeRefreshMerchant, 1000);

let merchantOverviewTimer;
function renderMerchantOverview(merchant) {
  merchantRenderRevision++;
  merchantLastRefresh = Date.now();
  merchantRewardObserver?.disconnect();
  clearTimeout(merchantOverviewTimer);
  merchantOverviewTimer = null;
  const card = $('merchant-overview');
  const section = $('merchant-overview-progress');
  const key = merchant ? JSON.stringify([current, merchant.startTime, merchant.trade?.period]) : '';
  const samePeriod = key === section.dataset.period;
  const purchaseDetailsOpen = samePeriod && !!section.querySelector('.merchant-voyage details[open]');
  const position = samePeriod ? section.querySelector('.merchant-tiers')?.dataset.position : undefined;
  const focused = samePeriod && section.contains(document.activeElement) && document.activeElement.id;
  clear(section);
  section.dataset.period = key;
  card.hidden = true;
  syncMerchantIntel(merchant && merchant.serverNow >= merchant.startTime && merchant.serverNow < merchant.endTime ? merchant : null);
  if (!merchant || !(merchant.serverNow < merchant.endTime)) return;
  const upcoming = merchant.serverNow < merchant.startTime;
  const boundary = upcoming ? merchant.startTime : merchant.endTime;
  const delay = Math.ceil((boundary - merchant.serverNow) * 1000);
  if (delay <= 2147483647) merchantOverviewTimer = setTimeout(() => {
    merchantOverviewTimer = null;
    merchantRewardObserver?.disconnect();
    syncMerchantIntel(null);
    card.hidden = true;
    clear(section);
    if (upcoming && !document.hidden && !$('tab-overview').classList.contains('hidden')) void refreshOverview();
  }, delay);
  if (upcoming) return;
  card.hidden = false;
  const goal = merchant.goal;
  if (goal) renderMerchantRewards(section, goal, merchant.rewardItems, position, merchant.trade?.intel);
  if (goal && merchant.trade) renderMerchantTrade(section, goal, merchant.trade, purchaseDetailsOpen);
  else for (const line of merchant.lines ?? ['本期商船数据待同步，请刷新']) section.append(el('p', 'merchant-caption', line));
  if (goal?.checkedAt) {
    const period = merchant.trade ? '第 ' + merchant.trade.period + ' 期 · ' : '';
    section.append(el('p', 'merchant-updated', period + '更新于 ' + activityDate(goal.checkedAt) + '（北京时间）'));
  }
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
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
