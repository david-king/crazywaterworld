// Each activity owns a tab; task preferences remain scoped to the account.
let activitiesVersion = 0;
let activityExpiryTimer;
let activitiesData = null;
let activitiesAccount = null;
let activitiesReceivedAt = 0;
let selectedActivity = null;
let activityGroupSignature = '';
let discoveryVersion = 0;
const activitySelections = new Map();
const pendingActivities = new Set();
const activityTaskEdits = new Map();
const expandedActivityGroups = new Map();
let merchantSettingsData = null, merchantSettingsOwner = null, merchantSettingsVersion = 0;
let merchantSettingsStatus = '';
const savingMerchantSettings = new Set();
let heroRaidSettingsData = null, heroRaidSettingsOwner = null, heroRaidSettingsVersion = 0;
let heroRaidSettingsStatus = '';
const savingHeroRaidSettings = new Set();
let seaMerchantSettingsData = null, seaMerchantSettingsOwner = null, seaMerchantSettingsVersion = 0;
let seaMerchantSettingsStatus = '';
const savingSeaMerchantSettings = new Set();
let merchantManualOwner = null;
let guildShipSettingsData = null, guildShipSettingsOwner = null, guildShipSettingsVersion = 0;
let guildShipSettingsStatus = '';
const savingGuildShipSettings = new Set();
let activityAutomationData = null, activityAutomationOwner = null, activityAutomationVersion = 0;
let activityAutomationStatus = '';
const savingActivityAutomation = new Set();
const weekChipMessages = new Map();

bindConsoleSlice('activities', { activitiesData, activitiesAccount, activitiesReceivedAt, selectedActivity, merchantSettingsData, merchantSettingsOwner, merchantSettingsStatus, heroRaidSettingsData, heroRaidSettingsOwner, heroRaidSettingsStatus, seaMerchantSettingsData, seaMerchantSettingsOwner, seaMerchantSettingsStatus, guildShipSettingsData, guildShipSettingsOwner, guildShipSettingsStatus, activityAutomationData, activityAutomationOwner, activityAutomationStatus }, state => {
  activitiesData = state.activitiesData;
  activitiesAccount = state.activitiesAccount;
  activitiesReceivedAt = state.activitiesReceivedAt;
  selectedActivity = state.selectedActivity;
  merchantSettingsData = state.merchantSettingsData;
  merchantSettingsOwner = state.merchantSettingsOwner;
  merchantSettingsStatus = state.merchantSettingsStatus;
  heroRaidSettingsData = state.heroRaidSettingsData;
  heroRaidSettingsOwner = state.heroRaidSettingsOwner;
  heroRaidSettingsStatus = state.heroRaidSettingsStatus;
  seaMerchantSettingsData = state.seaMerchantSettingsData;
  seaMerchantSettingsOwner = state.seaMerchantSettingsOwner;
  seaMerchantSettingsStatus = state.seaMerchantSettingsStatus;
  guildShipSettingsData = state.guildShipSettingsData;
  guildShipSettingsOwner = state.guildShipSettingsOwner;
  guildShipSettingsStatus = state.guildShipSettingsStatus;
  activityAutomationData = state.activityAutomationData;
  activityAutomationOwner = state.activityAutomationOwner;
  activityAutomationStatus = state.activityAutomationStatus;
});

function isGuildShipActivity(row) {
  return (row.sourceId ?? row.id) === 'guildShip';
}

function isSeaMerchantActivity(row) {
  return (row.sourceId ?? row.id) === 'merchant';
}

function isHeroRaidActivity(row) {
  const id = row.sourceId ?? row.id;
  return id === 'hero-raid' || id.startsWith('hero-raid:') || row.type === 'heroRaid';
}

function activityNow() {
  return activitiesData?.serverNow ? activitiesData.serverNow + (Date.now() - activitiesReceivedAt) / 1000 : Date.now() / 1000;
}

const activityKinds = {
  limited: { tag: '限时', group: '限时活动' },
  weekly: { tag: '周期', group: '周期活动' },
  permanent: { tag: '常驻', group: '常驻活动' },
};

const activityStates = { upcoming: '未开放活动', ended: '已结束', unknown: '时间待确认' };

function activityLifecycle(row) {
  if (row.settingsOnly) return 'upcoming';
  if (row.kind === 'permanent') return 'active';
  const now = activityNow();
  if (row.startTime > 0 && row.endTime > 0 && row.endTime <= row.startTime) return 'unknown';
  if (row.endTime > 0 && row.endTime <= now) return 'ended';
  if (row.startTime > now && row.endTime > row.startTime) return 'upcoming';
  if (row.observed === false || row.lifecycle === 'unknown') return 'unknown';
  if (row.endTime > now) return 'active';
  return row.lifecycle || 'unknown';
}

function activityDate(time) {
  return time > 0 ? new Date(time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待确认';
}

function activityTimeLabel(row) {
  if (row.settingsOnly) return activitiesData && !activitiesData.catalogOnly ? '当前未开放' : '连接后读取活动状态';
  const state = activityLifecycle(row);
  if (state === 'upcoming') return activityDate(row.startTime) + ' 开始';
  if (state === 'ended') return activityDate(row.endTime) + ' 结束';
  if (state === 'unknown') return '开放状态待同步';
  return activityRemaining(row.endTime);
}

function activityGroupOpen(state) {
  return expandedActivityGroups.get(current)?.has(state) ?? false;
}

// Arrow keys follow the visible activities and skip collapsed groups.
function activityRows() {
  const rows = [...(activitiesData?.activities || [])];
  if (current && !rows.some(row => row.weekType === 5)) {
    rows.push({ id: 'rich-merchant', name: '不差钱商人', kind: 'weekly', weekType: 5, settingsOnly: true, taskKeys: [] });
  }
  if (current && !rows.some(isHeroRaidActivity)) {
    rows.push({ id: 'hero-raid', name: '超凡英雄活动', kind: 'weekly', settingsOnly: true, taskKeys: [] });
  }
  if (current && !rows.some(isSeaMerchantActivity)) {
    rows.push({ id: 'merchant', name: '海商王', kind: 'weekly', settingsOnly: true, taskKeys: [] });
  }
  if (current && !rows.some(isGuildShipActivity)) {
    rows.push({ id: 'guildShip', name: '联盟商船', kind: 'limited', settingsOnly: true, taskKeys: [] });
  }
  const order = Object.keys(activityKinds);
  const states = ['active', 'upcoming', 'ended', 'unknown'];
  return rows.sort((a, b) => states.indexOf(activityLifecycle(a)) - states.indexOf(activityLifecycle(b))
    || order.indexOf(a.kind) - order.indexOf(b.kind) || (a.group || '').localeCompare(b.group || '')
    || (activityLifecycle(a) === 'ended' ? (b.endTime ?? 0) - (a.endTime ?? 0) : (a.startTime ?? 0) - (b.startTime ?? 0)));
}

function activityBadge(kind, badge = el('span')) {
  badge.className = (badge.className + ' activity-badge ' + kind).trim();
  badge.textContent = activityKinds[kind].tag;
  return badge;
}

function activityRemaining(endTime) {
  if (!endTime) return '长期开放';
  const minutes = Math.max(1, Math.ceil((endTime - activityNow()) / 60));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return '剩余 ' + (days ? days + ' 天 ' + hours + ' 小时' : hours ? hours + ' 小时 ' + minutes % 60 + ' 分' : minutes + ' 分钟');
}

function paintActivityTime(node, endTime) {
  node.textContent = activityRemaining(endTime);
  node.classList.toggle('soon', Boolean(endTime) && endTime - activityNow() < 86400);
}

function activitySettingsKind(row) {
  if (!row) return null;
  if (row.weekType === 5) return 'week-order';
  if (isHeroRaidActivity(row)) return 'hero-raid';
  if (isSeaMerchantActivity(row)) return 'merchant';
  if (isGuildShipActivity(row)) return 'guild-ship';
  return 'automation:' + row.id;
}

function editingActivitySettings(section) {
  return section?.dataset.account === current && section.contains(document.activeElement);
}

function renderActivityTabs(provisional = false) {
  const rows = activityRows(), tabs = clear($('activity-tabs'));
  activityGroupSignature = rows.map(row => row.id + ':' + activityLifecycle(row)).join('|');
  const visible = rows.filter(row => activityLifecycle(row) === 'active' || activityGroupOpen(activityLifecycle(row)));
  // A live instance can replace the settings-only placeholder while its form is
  // being edited. Keep the same configuration selected across that transition.
  const editing = $('activities-list').querySelector('.activity-settings');
  if (!visible.some(row => row.id === selectedActivity) && editingActivitySettings(editing)) {
    const replacement = visible.find(row => activitySettingsKind(row) === editing.dataset.kind);
    if (replacement) setConsoleValue('activities', 'selectedActivity', replacement.id);
  }
  if (!visible.some(row => row.id === selectedActivity)) setConsoleValue('activities', 'selectedActivity', visible[0]?.id);
  if (!provisional) activitySelections.set(current, selectedActivity);
  const active = el('div', 'activity-current-tabs');
  tabs.appendChild(active);
  const containers = new Map([['active', active]]);
  for (const [state, label] of Object.entries(activityStates)) {
    const count = rows.filter(row => activityLifecycle(row) === state).length;
    if (!count) continue;
    const section = el('div', 'activity-state-group');
    const toggle = el('button', 'activity-state-toggle');
    toggle.type = 'button';
    toggle.dataset.activityGroup = state;
    toggle.setAttribute('aria-expanded', String(activityGroupOpen(state)));
    const content = el('div', 'activity-state-tabs');
    content.id = 'activity-group-' + state;
    content.hidden = !activityGroupOpen(state);
    toggle.setAttribute('aria-controls', content.id);
    toggle.append(el('span', null, label), el('span', 'dim', String(count)));
    toggle.onclick = () => {
      const expanded = expandedActivityGroups.get(current) || new Set();
      if (expanded.has(state)) expanded.delete(state); else expanded.add(state);
      expandedActivityGroups.set(current, expanded);
      renderActivityTabs();
      $('activity-tabs').querySelector('[data-activity-group=' + state + ']')?.focus();
    };
    section.append(toggle, content);
    tabs.appendChild(section);
    containers.set(state, content);
  }
  const groups = new Map();
  rows.forEach((row, index) => {
    const state = activityLifecycle(row), container = containers.get(state);
    const title = row.group || activityKinds[row.kind].group;
    if (title !== groups.get(state)) {
      groups.set(state, title);
      const heading = el('div', 'activity-group', title);
      heading.setAttribute('aria-hidden', 'true');
      container.appendChild(heading);
    }
    const button = el('button', 'activity-tab');
    button.type = 'button';
    button.id = 'activity-tab-' + index;
    button.dataset.activity = row.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(row.id === selectedActivity));
    button.setAttribute('aria-controls', 'activity-panel');
    button.tabIndex = row.id === selectedActivity ? 0 : -1;
    const head = el('span', 'activity-tab-head');
    head.append(el('span', 'activity-tab-name', row.name));
    if (state === 'active' && activitiesData?.status?.[row.id]?.ready) head.appendChild(el('span', 'activity-ready', activitiesData.status[row.id].badge));
    head.appendChild(activityBadge(row.kind));
    button.appendChild(head);
    const time = el('span', 'activity-tab-time', activityTimeLabel(row));
    if (state === 'active' && row.endTime) time.dataset.end = String(row.endTime);
    button.appendChild(time);
    button.onclick = () => selectActivity(row.id, true);
    button.onkeydown = event => {
      const position = visible.findIndex(item => item.id === row.id);
      const offsets = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -position, End: visible.length - position - 1 };
      if (!(event.key in offsets)) return;
      event.preventDefault();
      selectActivity(visible[(position + offsets[event.key] + visible.length) % visible.length].id, true);
    };
    container.appendChild(button);
  });
  renderActivityDetail();
}

setInterval(() => {
  if (!activitiesData) return;
  const signature = activityRows().map(row => row.id + ':' + activityLifecycle(row)).join('|');
  if (signature !== activityGroupSignature) { renderActivityTabs(); return; }
  for (const node of document.querySelectorAll('#activity-tabs [data-end]')) paintActivityTime(node, Number(node.dataset.end));
}, 30000);

function selectActivity(id, focus = false) {
  const row = activityRows().find(item => item.id === id);
  const state = row && activityLifecycle(row);
  if (state && state !== 'active') {
    const expanded = expandedActivityGroups.get(current) || new Set();
    expanded.add(state);
    expandedActivityGroups.set(current, expanded);
  }
  setConsoleValue('activities', 'selectedActivity', id);
  activitySelections.set(current, id);
  ++discoveryVersion;
  renderActivityTabs();
  const tab = $('activity-tabs').querySelector('[aria-selected=true]');
  if (focus) tab?.focus();
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderActivityDetail() {
  const row = activityRows().find(item => item.id === selectedActivity);
  const panel = $('activity-panel');
  panel.hidden = !row;
  const box = $('activities-list');
  const previousSettings = box.querySelector('.activity-settings');
  const settingsKind = activitySettingsKind(row);
  panel.classList.toggle('guild-ship-panel', settingsKind === 'guild-ship');
  const saving = [savingMerchantSettings, savingHeroRaidSettings, savingSeaMerchantSettings, savingGuildShipSettings, savingActivityAutomation]
    .some(pending => pending.has(current));
  const keepSettings = !saving && previousSettings?.dataset.kind === settingsKind && editingActivitySettings(previousSettings);
  if (keepSettings) {
    // Leave the focused form attached in its original position. Recreating or
    // detaching it would lose uncommitted input, native change state and focus.
    for (const child of [...box.children]) if (child !== previousSettings) child.remove();
  } else clear(box);
  clear($('activities-order'));
  if (!row) return;
  panel.setAttribute('aria-labelledby', $('activity-tabs').querySelector('[aria-selected=true]').id);
  $('activity-title').textContent = row.group ? row.group + ' · ' + row.name : row.name;
  clear($('activity-kind')).appendChild(activityBadge(row.kind, isGuildShipActivity(row) ? component('ui-badge') : undefined));
  $('activity-end').textContent = row.settingsOnly ? (activitiesData && !activitiesData.catalogOnly ? '当前未开放，可预先配置' : '连接后读取活动状态，可预先配置')
    : row.kind === 'permanent' ? '长期开放' : '开始 ' + activityDate(row.startTime) + ' · 结束 ' + activityDate(row.endTime) + '（北京时间）';
  if (row.rewardEndTime > row.endTime && row.endTime > 0) $('activity-end').textContent += ' · 奖励展示截至 ' + activityDate(row.rewardEndTime);
  const active = activityLifecycle(row) === 'active' && activitiesData && !activitiesData.catalogOnly;
  if (!keepSettings) {
    if (row.weekType === 5) renderMerchantSettings(box);
    if (isHeroRaidActivity(row)) renderHeroRaidSettings(box);
    if (isSeaMerchantActivity(row)) renderSeaMerchantSettings(box);
    if (isGuildShipActivity(row)) renderGuildShipSettings(box);
    if (row.weekType !== 5 && !isHeroRaidActivity(row) && !isSeaMerchantActivity(row) && !isGuildShipActivity(row)) renderActivityAutomation(box, row);
  }
  const settings = box.querySelector('.activity-settings');
  if (settings) {
    settings.dataset.account = current;
    settings.dataset.kind = settingsKind;
    settings.onfocusout = () => {
      // Let change/save handlers and the next focus target settle first.
      void Promise.resolve().then(() => {
        if (settings.parentElement === box && settings.dataset.account === current && !panel.contains(document.activeElement)) renderActivityDetail();
      });
    };
  }
  if (row.settingsOnly) return;
  if (!activitiesData) return;
  if (!active) {
    const messages = { upcoming: '活动尚未开放。',
      ended: '本期活动已结束。',
      unknown: '活动开放状态待同步，连接后刷新可核对最新时间。' };
    box.appendChild(el('p', 'dim', messages[activityLifecycle(row)] || '连接后刷新活动状态。'));
    for (const task of (row.taskKeys || []).map(key => activitiesData.eventTasks.find(task => task.key === key)).filter(Boolean)) {
      if (row.weekType !== 5 && !isSeaMerchantActivity(row)) renderActivityTask(box, row, task);
    }
    return;
  }
  if (!isSeaMerchantActivity(row)) {
    for (const line of activitiesData.status?.[row.id]?.lines ?? []) box.appendChild(el('p', null, line));
  }
  if (row.weekType === 4) {
    const lottery = activitiesData.lottery;
    box.appendChild(el('p', null, lottery ? '累计抽奖 ' + lottery.times + ' 次 · ' + (lottery.required == null ? '全部档位已领完' : '下一档 ' + lottery.required + ' 次' + (lottery.ready ? '（可领取）' : '')) : activitiesData.lotteryError ? '抽奖进度读取失败，详情见运行日志' : '暂无抽奖进度'));
  }
  if (row.weekType === 6) renderWeekChip(box, row);
  if (row.taskKeys?.includes('newbieLogin')) {
    const newbie = activitiesData.newbie;
    if (newbie) box.appendChild(el('p', null, '已登录 ' + newbie.loginDays + ' 天 · ' + (newbie.available.length ? '可领第 ' + newbie.available.join('、') + ' 天奖励' : '当前奖励已领完')));
  }
  const tasks = (row.taskKeys || []).map(key => activitiesData.eventTasks.find(task => task.key === key)).filter(Boolean);
  for (const task of tasks) {
    if (isSeaMerchantActivity(row)) continue;
    if (row.weekType === 5 && task.key === 'weekOrderSubmit') continue;
    renderActivityTask(box, row, task);
  }
  if (!tasks.length && row.weekType !== 5 && row.weekType !== 6 && !isHeroRaidActivity(row) && !isSeaMerchantActivity(row) && !isGuildShipActivity(row) && !row.automation) box.appendChild(el('p', 'dim', '当前活动暂未接入单次操作，可在游戏内参与。'));
  if (row.weekType === 5) renderActivityOrder();
}

function renderWeekChipStatistics(section, plan) {
  const stats = plan.statistics;
  const format = n => n.toLocaleString('zh-CN');
  const metrics = el('dl', 'week-chip-metrics');
  function metric(label, value, unit, className) {
    const cell = el('div', className), amount = el('dd');
    amount.appendChild(el('span', null, format(value)));
    if (unit) amount.appendChild(el('span', 'week-chip-unit', unit));
    cell.append(el('dt', null, label), amount);
    metrics.appendChild(cell);
    return amount;
  }
  if (plan.round <= plan.roundLimit) {
    const amount = metric('当前积分 / 本轮积分上限', plan.score, ' / ' + format(plan.target), 'week-chip-score');
    const meter = el('progress');
    meter.max = plan.target;
    meter.value = Math.min(plan.score, plan.target);
    meter.setAttribute('aria-label', '本轮已得积分');
    meter.setAttribute('aria-valuetext', format(plan.score) + ' 分，目标 ' + format(plan.target) + ' 分');
    amount.appendChild(meter);
  }
  if (stats) {
    metric('已完成轮次', stats.completed, ' / ' + plan.roundLimit);
    metric('当前累计积分', plan.total);
  }
  if (metrics.children.length) section.appendChild(metrics);
  if (!stats) return;
  if (stats.qualified > stats.completed) section.appendChild(el('p', 'dim', '已有 ' + stats.qualified + ' 轮积分达标，领完本轮档位奖励后计入完成轮次。'));
  const inventory = el('dl', 'week-chip-inventory');
  const title = el('h4', null, '硅晶库存');
  title.id = 'week-chip-stock-title';
  inventory.setAttribute('aria-labelledby', title.id);
  for (const item of stats.inventory) {
    const cell = el('div'), term = el('dt'), art = el('span', 'week-chip-crystal');
    art.dataset.points = item.points;
    art.setAttribute('aria-hidden', 'true');
    if (item.thumbnail) {
      const img = el('img');
      img.alt = '';
      img.width = img.height = 48;
      img.onerror = () => img.remove();
      img.src = item.thumbnail;
      art.appendChild(img);
    }
    term.append(art, el('span', null, item.name));
    const count = el('dd');
    count.append(el('span', null, format(item.count)), el('span', 'week-chip-unit', ' 个'));
    cell.append(term, count);
    inventory.appendChild(cell);
  }
  const stock = el('div', 'week-chip-stock');
  stock.append(title, inventory);
  section.appendChild(stock);
}

function renderWeekChip(box, row) {
  const account = activitiesAccount, status = activitiesData.status?.[row.id], plan = status?.chip;
  const section = el('section', 'week-chip-panel');
  const heading = el('div', 'week-chip-heading'), title = el('h3', null, '硅晶加工');
  title.id = 'week-chip-title';
  section.setAttribute('aria-labelledby', title.id);
  heading.appendChild(title);
  section.appendChild(heading);
  box.appendChild(section);
  if (!plan) {
    section.appendChild(el('p', 'dim', status?.chipError || '硅晶积分和库存待同步，请刷新活动。'));
    return;
  }
  const key = account + ':' + row.id;
  heading.appendChild(el('span', 'week-chip-round', plan.round > plan.roundLimit ? '本期全部轮次已完成' : '第 ' + plan.round + ' 轮'));
  renderWeekChipStatistics(section, plan);
  const footer = el('div', 'week-chip-footer');
  let notice = plan.blockedReason;
  if (!notice && !plan.key && plan.round <= plan.roundLimit) {
    const shortfall = plan.target - (plan.statistics?.forecast ?? Math.min(plan.target, plan.score + plan.available));
    notice = !plan.gap ? '本轮已达标。' : shortfall > 0 ? '本轮还缺 ' + shortfall + ' 分。' : '开晶方案待同步，请刷新活动。';
  }
  const claimOnly = !plan.gap && plan.key;
  const button = component('ui-confirm');
  button.type = 'button';
  button.textContent = pendingActivities.has(key) ? '正在处理…' : claimOnly ? '领取本轮达标奖励' : '一键开到 ' + plan.target + ' 分';
  if (notice) {
    const note = el('p', 'week-chip-notice', notice);
    note.id = 'week-chip-notice';
    button.setAttribute('aria-describedby', note.id);
    footer.appendChild(note);
  }
  button.dataset.activityRun = 'weekChipOpen';
  const unavailable = () => account !== current || activitiesAccount !== account || snapshot.connected !== true ||
    snapshot.paused || disconnected.has(account) || activitiesData?.catalogOnly || activityLifecycle(row) !== 'active';
  button.disabled = !plan.key || pendingActivities.has(key) || unavailable();
  button.onclick = () => {
    if (button.disabled || unavailable()) return;
    const details = [];
    if (!claimOnly) {
      details.push(el('p', null, plan.items.map(item => item.name + ' ×' + item.count).join('、')));
      if (plan.gain > plan.gap) details.push(el('p', null, '超出目标 ' + (plan.gain - plan.gap) + ' 分。'));
    }
    const kinds = new Set(plan.actions?.map(step => step.kind === 'factoryRewards' ? 'factory' : step.kind));
    const rewards = ['weekly', 'gift', 'factory'].filter(kind => kinds.has(kind))
      .map(kind => ({ weekly: '本轮档位奖励', gift: '免费礼包', factory: '芯片厂可领积分奖励' })[kind]);
    if (rewards.length) details.push(el('p', null, '领取' + rewards.join('、')));
    openConfirm(claimOnly ? '领取第 ' + plan.round + ' 轮奖励' : '开启第 ' + plan.round + ' 轮硅晶', details, async () => {
      if (unavailable() || selectedActivity !== row.id || activitiesData?.status?.[row.id]?.chip?.key !== plan.key)
        throw Error('账号或开晶方案已变化，请重新查看');
      if (pendingActivities.has(key)) return;
      pendingActivities.add(key);
      weekChipMessages.delete(key);
      renderActivityDetail();
      try {
        const result = await call('/api/activities/week-chip/open?account=' + encodeURIComponent(account), {
          method: 'POST', body: JSON.stringify({ confirm: true, activityId: row.id, planKey: plan.key }),
        });
        weekChipMessages.set(key, { round: plan.round, complete: true, text: result.message });
      } catch (error) {
        weekChipMessages.set(key, { round: plan.round, text: error.message });
        throw error;
      } finally {
        pendingActivities.delete(key);
        if (account === current) await refreshActivities();
      }
    }, claimOnly ? '确认领取' : '确认开启');
  };
  footer.appendChild(button);
  section.appendChild(footer);
  const message = weekChipMessages.get(key);
  if (message && (message.round === plan.round || (message.complete && message.round + 1 === plan.round))) {
    const result = el('p', 'week-chip-result', message.text);
    result.setAttribute('role', 'status');
    section.appendChild(result);
  }
}

function renderActivityTask(box, row, task) {
  const account = activitiesAccount, key = account + ':' + row.id + ':' + task.key;
  const item = el('div', 'activity-task');
  item.appendChild(el('strong', null, task.label));
  const descriptions = {
    evilExpel: '清理当前可驱除的邪祟，并领取已达标的累计奖励。',
    edict: '完成当前解符对局；没有对局时，最多消耗 1 份贡品开局。',
    edictPass: '领取酆都法旨战令已达标的奖励，不消耗贡品。',
    compassReward: '领取已达标的积分奖励，不进行罗盘抽奖。',
    weekPass: '领取已完成任务的积分和已达标的战令奖励。',
    weekGift: '领取本期可用的免费礼包。',
    weekTimes: '领取已达标的累计抽奖次数奖励，不进行抽奖。',
    newbieLogin: '领取当前已解锁的登录奖励。',
    festivalSign: '只签当天，免费。错过的日子要花钻石补签，本工具不会补签。',
    festivalActive: '领取活跃积分已达标的档位。',
    festivalGifts: '领取今天的免费礼包，付费礼包不会购买。',
    snowballFree: '领取免费礼包和通行证已达标的免费奖励，不玩小游戏，也不买体力。',
    riverScore: '领取走江踏浪已达标的累计积分奖励。',
    riverPass: '领取走江踏浪通行证已达标的免费奖励。',
    riverHelp: '领取当前渠道允许的走江踏浪免费助力奖励。',
    compassSpin: '消耗抽奖券抽奖，不花钻石。单次执行和自动运行的每一轮都按设置的张数，不足时有多少用多少。',
    weekLotterySpin: '消耗周转盘币抽奖，每次执行最多 10 次，不花钻石。',
    weekCharge: '领取累充金额已达标的档位，不充值。',
    weekHeroStar: '领取两位英雄星级都已达标的档位。',
    weekChipFree: '领取本期免费礼包。',
    weekUniqueFree: '领取本期免费礼包，翻牌需要手动选择目标，不自动进行。',
    weekOrderFinal: '全部档位完成后领取最终奖励。',
    weekOrderSubmit: '材料备齐后提交一次商人订单。',
    openRankRewards: '领取各个开服冲榜已达标的积分奖励。排名奖励由游戏在活动结束后发放。',
  };
  if (descriptions[task.key]) item.appendChild(el('p', 'dim', descriptions[task.key]));
  const bar = el('div', 'activity-controls');
  const button = smallButton(pendingActivities.has(key) ? '执行中…' : task.key === 'edict' ? '解符一次（最多 1 份贡品）' : task.key === 'weekOrderSubmit' ? '提交商人订单' : task.key === 'weekOrderFinal' ? '领取最终奖励' : '执行一次');
  button.dataset.activityRun = task.key;
  button.disabled = pendingActivities.has(key) || snapshot.connected !== true || snapshot.paused || disconnected.has(account)
    || activityLifecycle(row) !== 'active' || activitiesData.catalogOnly;
  const spinInput = task.key === 'compassSpin' ? spinCountInput(account) : null;
  button.onclick = async () => {
    if (button.disabled || account !== current || snapshot.paused || disconnected.has(account) || pendingActivities.has(key)) return;
    if (activityLifecycle(row) !== 'active' || activitiesData.catalogOnly) { refreshActivities(); return; }
    if (task.key === 'weekOrderSubmit') { confirmWeekOrderAction('submit'); return; }
    const spinCount = spinInput ? spinInput.valueAsNumber : undefined;
    if (spinInput && !spinInput.checkValidity()) { reportError(new Error('抽奖券张数必须是 1 到 ' + spinInput.max + ' 的整数'), '风水罗盘抽奖'); return; }
    pendingActivities.add(key);
    renderActivityDetail();
    try {
      await call('/api/activities/run?account=' + encodeURIComponent(account), { method: 'POST', body: JSON.stringify({ activityId: row.id, taskKey: task.key, spinCount, confirm: true }) });
    } catch (error) { reportError(error, '单次执行活动'); }
    finally {
      pendingActivities.delete(key);
      if (account === current) refreshActivities();
    }
  };
  if (spinInput) {
    const field = el('label', 'activity-auto');
    field.append(el('span', null, '每次使用'), spinInput, el('span', null, '张'));
    bar.append(field);
    if (activitiesData.compassSpinEditable === false) bar.appendChild(el('span', 'dim', '在挂机配置中修改'));
  }
  bar.appendChild(button);
  if (row.weekType !== 5) {
    const auto = el('label', 'activity-auto');
    const toggle = component('ui-event-switch');
    toggle.dataset.autoTask = task.key;
    toggle.dataset.eventTask = 'true';
    toggle.dataset.account = account;
    toggle.setAttribute('aria-label', task.label + ' · 自动运行');
    setTaskSwitch(toggle, task.enabled);
    toggle.disabled = savingTasks.has(account + ':' + task.key);
    toggle.onclick = () => { if (current === account) toggleAutoTask(toggle); };
    auto.append(toggle, el('span', null, '自动运行'));
    bar.appendChild(auto);
  }
  item.appendChild(bar);
  box.appendChild(item);
}

function spinCountInput(account) {
  const input = component('ui-number');
  input.min = 1;
  input.max = 999;
  input.step = 1;
  input.required = true;
  input.value = activitiesData.compassSpinCount;
  input.disabled = activitiesData.compassSpinEditable === false;
  input.setAttribute('aria-label', '风水罗盘每次使用的抽奖券张数');
  input.onchange = async () => {
    const saved = activitiesData.compassSpinCount;
    if (!input.checkValidity()) {
      input.value = saved;
      reportError(new Error('抽奖券张数必须是 1 到 ' + input.max + ' 的整数'), '设置罗盘抽奖券用量');
      return;
    }
    const count = input.valueAsNumber;
    if (count === saved) return;
    try {
      await call('/api/loop/compass-spin-count?account=' + encodeURIComponent(account), { method: 'POST', body: JSON.stringify({ compassSpinCount: count }) });
      if (activitiesAccount === account && activitiesData) mutateConsoleValue('activities', 'activitiesData', nextStateValue => (nextStateValue.compassSpinCount = count));
    } catch (error) {
      input.value = saved;
      reportError(error, '设置罗盘抽奖券用量');
    }
  };
  return input;
}

function syncActivityTask(key, enabled, account) {
  if (activitiesAccount !== account) return;
  const task = activitiesData?.eventTasks.find(task => task.key === key);
  if (task) task.enabled = enabled;
}

function renderActivityAutomation(box, row) {
  const account = current;
  if (activityAutomationOwner !== account || !activityAutomationData) {
    if (!row.automation && !row.taskKeys?.length) return;
    box.appendChild(el('p', 'dim', activityAutomationStatus || '正在读取活动自动挂机配置…'));
    if (activityAutomationStatus) {
      const retry = smallButton('重新读取');
      retry.onclick = refreshActivities;
      box.appendChild(retry);
    }
    return;
  }
  const controls = activityAutomationData.controls.filter(control => control.key === row.automation?.key
    || control.taskKeys.some(key => row.taskKeys?.includes(key)));
  if (!controls.length) return;
  const section = el('div', 'activity-settings');
  for (const control of controls) {
    const mainLabel = controls.length === 1 ? '开启自动挂机' : control.label + ' · 开启自动挂机';
    for (const setting of [{ ...control, label: mainLabel }, ...(control.fields ?? [])]) {
      const field = el('label', 'activity-auto');
      const toggle = component('ui-event-switch');
      const enabled = activityAutomationData.settings[setting.key];
      toggle.dataset.activityAutomation = setting.key;
      toggle.setAttribute('aria-label', setting.label);
      setTaskSwitch(toggle, enabled);
      toggle.disabled = savingActivityAutomation.has(account);
      toggle.onclick = () => {
        if (account === current && !toggle.disabled) return saveActivityAutomation(setting.key, !enabled);
      };
      field.append(toggle, el('span', null, setting.label));
      if (setting.help) field.appendChild(makeHelpTip(setting.label, setting.help));
      section.appendChild(field);
    }
  }
  const status = el('p', 'dim', savingActivityAutomation.has(account) ? '正在保存…' : activityAutomationStatus);
  status.setAttribute('role', 'status');
  section.appendChild(status);
  box.appendChild(section);
}

async function refreshActivityAutomation(account) {
  if (!account || savingActivityAutomation.has(account)) return;
  const version = ++activityAutomationVersion;
  try {
    const data = await call('/api/activities/settings?account=' + encodeURIComponent(account));
    if (account !== current || activityAutomationOwner !== account || version !== activityAutomationVersion) return;
    setConsoleValue('activities', 'activityAutomationData', data);
    setConsoleValue('activities', 'activityAutomationStatus', '');
  } catch {
    if (account !== current || activityAutomationOwner !== account || version !== activityAutomationVersion) return;
    setConsoleValue('activities', 'activityAutomationStatus', '活动自动挂机配置读取失败，请重试。');
  }
}

async function saveActivityAutomation(key, value) {
  const account = current;
  if (!account || activityAutomationOwner !== account || !activityAutomationData || savingActivityAutomation.has(account)) return;
  const version = ++activityAutomationVersion;
  savingActivityAutomation.add(account);
  setConsoleValue('activities', 'activityAutomationStatus', '');
  renderActivityDetail();
  let failure = null;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current || activityAutomationOwner !== account || version !== activityAutomationVersion) return;
    const latest = await call('/api/activities/settings?account=' + encodeURIComponent(account));
    if (account !== current || activityAutomationOwner !== account || version !== activityAutomationVersion) return;
    const saved = await call('/api/activities/settings?account=' + encodeURIComponent(account), {
      method: 'POST', body: JSON.stringify({ key, value, revision: latest.revision, baseRevision: latest.baseRevision, confirm: true }),
    });
    if (account === current && activityAutomationOwner === account && version === activityAutomationVersion) {
      setConsoleValue('activities', 'activityAutomationData', saved);
      loopSettingsRevision = saved.revision;
    }
  } catch (error) {
    failure = error;
    if (account === current && activityAutomationOwner === account) reportError(error, '保存活动自动挂机配置');
  } finally {
    savingActivityAutomation.delete(account);
    if (account === current && activityAutomationOwner === account) {
      await refreshActivityAutomation(account);
      if (account === current && activityAutomationOwner === account) {
        if (failure) setConsoleValue('activities', 'activityAutomationStatus', failure.message);
        renderActivityTabs();
      }
    }
  }
}

function renderMerchantSettings(box) {
  const account = current;
  if (merchantSettingsOwner !== account || !merchantSettingsData) {
    box.appendChild(el('p', 'dim', merchantSettingsStatus || '正在读取商人活动配置…'));
    return;
  }
  const settings = merchantSettingsData.settings;
  const section = el('div', 'activity-settings');
  for (const [key, label] of [
    ['enabled', '开启自动挂机'],
    ['autoSubmit', '自动完成商人订单'],
    ['allowDiamonds', '缺材料时允许消耗钻石'],
    ['autoFinal', '自动领取最终奖励'],
  ]) {
    const row = el('label', 'activity-auto');
    const toggle = component('ui-event-switch');
    toggle.dataset.merchantSetting = key;
    toggle.setAttribute('aria-label', label);
    setTaskSwitch(toggle, settings[key]);
    toggle.disabled = savingMerchantSettings.has(account) || (key === 'allowDiamonds' && !settings.autoSubmit);
    toggle.onclick = () => {
      if (current === account && !toggle.disabled) return saveMerchantSetting(key, !settings[key]);
    };
    row.append(toggle, el('span', null, label));
    section.appendChild(row);
  }
  section.appendChild(el('p', 'dim', '钻石补料受全局钻石开关、每日预算和保留量限制。'));
  const status = el('p', 'dim', savingMerchantSettings.has(account) ? '正在保存…' : merchantSettingsStatus);
  status.setAttribute('role', 'status');
  section.appendChild(status);
  box.appendChild(section);
}

async function refreshMerchantSettings(account) {
  if (!account || savingMerchantSettings.has(account)) return;
  const version = ++merchantSettingsVersion;
  try {
    const data = await call('/api/week-order/settings?account=' + encodeURIComponent(account));
    if (account !== current || merchantSettingsOwner !== account || version !== merchantSettingsVersion) return;
    setConsoleValue('activities', 'merchantSettingsData', data);
    setConsoleValue('activities', 'merchantSettingsStatus', '');
  } catch (error) {
    if (account !== current || merchantSettingsOwner !== account || version !== merchantSettingsVersion) return;
    setConsoleValue('activities', 'merchantSettingsStatus', '商人活动配置读取失败，请刷新重试。');
  }
}

async function saveMerchantSetting(key, enabled) {
  const account = current;
  if (!account || merchantSettingsOwner !== account || !merchantSettingsData || savingMerchantSettings.has(account)) return;
  const version = ++merchantSettingsVersion;
  savingMerchantSettings.add(account);
  setConsoleValue('activities', 'merchantSettingsStatus', '');
  renderActivityDetail();
  let failure = null;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current || merchantSettingsOwner !== account || version !== merchantSettingsVersion) return;
    const latest = await call('/api/week-order/settings?account=' + encodeURIComponent(account));
    if (account !== current || merchantSettingsOwner !== account || version !== merchantSettingsVersion) return;
    const saved = await call('/api/week-order/settings?account=' + encodeURIComponent(account), {
      method: 'POST', body: JSON.stringify({ key, enabled, revision: latest.revision, baseRevision: latest.baseRevision, confirm: true }),
    });
    if (account === current && merchantSettingsOwner === account && version === merchantSettingsVersion) {
      setConsoleValue('activities', 'merchantSettingsData', saved);
      loopSettingsRevision = saved.revision;
    }
  } catch (error) {
    failure = error;
    if (account === current && merchantSettingsOwner === account) reportError(error, '保存商人活动配置');
  } finally {
    savingMerchantSettings.delete(account);
    if (account === current && merchantSettingsOwner === account) {
      await refreshMerchantSettings(account);
      if (account === current && merchantSettingsOwner === account) {
        if (failure) setConsoleValue('activities', 'merchantSettingsStatus', failure.message);
        renderActivityTabs();
      }
    }
  }
}

function renderHeroRaidSettings(box) {
  const account = current;
  if (heroRaidSettingsOwner !== account || !heroRaidSettingsData) {
    box.appendChild(el('p', 'dim', heroRaidSettingsStatus || '正在读取超凡英雄活动配置…'));
    return;
  }
  const settings = heroRaidSettingsData.settings;
  const section = el('div', 'activity-settings');
  const fields = [
    ['enabled', '开启自动挂机'],
    ['challenge', '自动挑战', '每轮挑战一个已解锁关卡或重试一次，连续战败次数跨轮累计。'],
    ['retryTimes', '战败重试次数', '本期同一关卡首次战败后的重试上限，0 表示战败即停止。'],
    ['orders', '自动完成订单', '材料足够时提交当前已解锁订单，缺料由工厂生产配置处理。'],
    ['lottery', '自动转盘抽奖', '消耗已有英雄副本抽卡券，每轮按库存抽取 1 次或 10 次。'],
    ['rewards', '自动领取达标奖励', '领取已达成的累计订单奖励和累计抽奖奖励。'],
  ];
  for (const [key, label, help] of fields) {
    const row = el('label', 'activity-auto');
    const control = component(key === 'retryTimes' ? 'ui-number' : 'ui-event-switch');
    control.dataset.heroRaidSetting = key;
    control.setAttribute('aria-label', label);
    if (help) control.setAttribute('aria-describedby', 'hero-raid-help-' + key);
    control.disabled = savingHeroRaidSettings.has(account);
    if (key === 'retryTimes') {
      control.min = 0;
      control.max = 100;
      control.step = 1;
      control.required = true;
      control.value = settings[key];
      control.onchange = () => {
        if (account !== current || control.disabled) return;
        const value = control.valueAsNumber;
        if (!Number.isInteger(value) || value < 0 || value > 100) {
          control.value = settings[key];
          reportError(new Error('战败重试次数必须是 0 到 100 的整数'), '设置超凡英雄挑战');
          return;
        }
        if (value !== settings[key]) return saveHeroRaidSetting(key, value);
      };
      row.append(el('span', null, label), control);
    } else {
      setTaskSwitch(control, settings[key]);
      control.onclick = () => {
        if (account === current && !control.disabled) return saveHeroRaidSetting(key, !settings[key]);
      };
      row.append(control, el('span', null, label));
    }
    section.appendChild(row);
    if (help) {
      const description = el('p', 'dim', help);
      description.id = 'hero-raid-help-' + key;
      section.appendChild(description);
    }
  }
  const status = el('p', 'dim', savingHeroRaidSettings.has(account) ? '正在保存…' : heroRaidSettingsStatus);
  status.setAttribute('role', 'status');
  section.appendChild(status);
  box.appendChild(section);
}

async function refreshHeroRaidSettings(account) {
  if (!account || savingHeroRaidSettings.has(account)) return;
  const version = ++heroRaidSettingsVersion;
  try {
    const data = await call('/api/hero-raid/settings?account=' + encodeURIComponent(account));
    if (account !== current || heroRaidSettingsOwner !== account || version !== heroRaidSettingsVersion) return;
    setConsoleValue('activities', 'heroRaidSettingsData', data);
    setConsoleValue('activities', 'heroRaidSettingsStatus', '');
  } catch {
    if (account !== current || heroRaidSettingsOwner !== account || version !== heroRaidSettingsVersion) return;
    setConsoleValue('activities', 'heroRaidSettingsStatus', '超凡英雄活动配置读取失败，请刷新重试。');
  }
}

async function saveHeroRaidSetting(key, value) {
  const account = current;
  if (!account || heroRaidSettingsOwner !== account || !heroRaidSettingsData || savingHeroRaidSettings.has(account)) return;
  const version = ++heroRaidSettingsVersion;
  savingHeroRaidSettings.add(account);
  setConsoleValue('activities', 'heroRaidSettingsStatus', '');
  renderActivityDetail();
  let failure = null;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current || heroRaidSettingsOwner !== account || version !== heroRaidSettingsVersion) return;
    const latest = await call('/api/hero-raid/settings?account=' + encodeURIComponent(account));
    if (account !== current || heroRaidSettingsOwner !== account || version !== heroRaidSettingsVersion) return;
    const saved = await call('/api/hero-raid/settings?account=' + encodeURIComponent(account), {
      method: 'POST', body: JSON.stringify({ key: 'heroRaid.' + key, value, revision: latest.revision, baseRevision: latest.baseRevision, confirm: true }),
    });
    if (account === current && heroRaidSettingsOwner === account && version === heroRaidSettingsVersion) {
      setConsoleValue('activities', 'heroRaidSettingsData', saved);
      loopSettingsRevision = saved.revision;
    }
  } catch (error) {
    failure = error;
    if (account === current && heroRaidSettingsOwner === account) reportError(error, '保存超凡英雄活动配置');
  } finally {
    savingHeroRaidSettings.delete(account);
    if (account === current && heroRaidSettingsOwner === account) {
      await refreshHeroRaidSettings(account);
      if (account === current && heroRaidSettingsOwner === account) {
        if (failure) setConsoleValue('activities', 'heroRaidSettingsStatus', failure.message);
        renderActivityTabs();
      }
    }
  }
}

function renderSeaMerchantSettings(box) {
  const account = current;
  if (seaMerchantSettingsOwner !== account || !seaMerchantSettingsData) {
    box.appendChild(el('p', 'dim', seaMerchantSettingsStatus || '正在读取海商王配置…'));
    return;
  }
  const saving = savingSeaMerchantSettings.has(account);
  const displayed = seaMerchantSettingsData;
  const section = el('div', 'activity-settings');
  box.appendChild(section);
  const presets = el('fieldset', 'merchant-presets');
  presets.append(el('legend', '', '四天走商方案'),
    el('p', 'dim', '套用后将为当前账号开启走商、领奖和情报共享。钻石只用于升船。'));
  const choices = el('div', 'merchant-preset-choices');
  for (const preset of seaMerchantSettingsData.presets ?? []) {
    const card = el('div', 'merchant-preset');
    card.dataset.active = String(preset.active);
    card.append(el('h3', 'merchant-preset-title', preset.label),
      el('p', 'merchant-preset-description', preset.description));
    const footer = el('div', 'merchant-preset-footer');
    const budget = el('div', 'merchant-preset-budget');
    const budgetText = preset.totalPointers === null ? '按实领' : preset.totalPointers === -1 ? '按可用库存' : preset.totalPointers + ' 根';
    budget.append(el('span', '', '总针数上限'), el('strong', '', budgetText));
    const action = preset.active ? '使用中' : '套用方案';
    const button = el('button', 'merchant-preset-apply', action);
    button.type = 'button';
    button.dataset.merchantPreset = preset.id;
    button.setAttribute('aria-label', action + ' · ' + preset.label);
    button.setAttribute('aria-pressed', String(preset.active));
    button.disabled = saving || preset.active;
    button.onclick = () => {
      if (current === account && !button.disabled) return saveSeaMerchantSetting('preset', preset.id, displayed);
    };
    footer.append(budget, button);
    card.appendChild(footer);
    choices.appendChild(card);
  }
  presets.appendChild(choices);
  if (choices.children.length) section.appendChild(presets);
  const manual = el('details', 'merchant-manual-settings');
  manual.appendChild(el('summary', '', '手动调整活动设置'));
  manual.open = merchantManualOwner === account || !choices.children.length;
  manual.ontoggle = () => {
    if (current === account && manual.isConnected) merchantManualOwner = manual.open ? account : null;
  };
  section.appendChild(manual);
  renderActivitySettingsFields(manual, { data: seaMerchantSettingsData, fields: merchantActivityFields,
    statusBox: section, saving, statusText: seaMerchantSettingsStatus,
    prefix: 'sea-merchant', dataset: 'seaMerchantSetting', save: saveSeaMerchantSetting, title: '海商王',
    note: '自动升船以本期满级为目标，按实际钻石余额支付。指南针补购使用单独设置的每日预算。' });
}

function renderGuildShipSettings(box) {
  const account = current;
  if (guildShipSettingsOwner !== account || !guildShipSettingsData) {
    box.appendChild(el('p', 'dim', guildShipSettingsStatus || '正在读取联盟商船配置…'));
    return;
  }
  const section = component('ui-guild-ship-settings');
  const fieldContainers = new Map();
  for (const group of section.querySelectorAll('[data-ship-fields]')) {
    for (const key of group.dataset.shipFields.split(' ')) fieldContainers.set('guildShip.' + key, group);
  }
  renderActivitySettingsFields(box, { section, fieldContainers, data: guildShipSettingsData, fields: guildShipActivityFields,
    saving: savingGuildShipSettings.has(account), statusText: guildShipSettingsStatus,
    prefix: 'guild-ship', dataset: 'guildShipSetting', save: saveGuildShipSetting, title: '联盟商船' });
}

function renderActivitySettingsFields(box, { data, fields, saving, statusText, prefix, dataset, save, title, note, statusBox,
  section = el('div', statusBox ? 'merchant-field-list' : 'activity-settings'), fieldContainers }) {
  const account = current;
  const settings = data.settings;
  const activeFields = new Map();
  for (const field of fields) {
    const [group, key] = field.key.split('.');
    const value = settings[group][key];
    const visible = (!field.parent || activeFields.get(field.parent)) && (!field.when || field.when(settings));
    activeFields.set(field.key, visible && (field.kind !== 'switch' || value));
    if (!visible) continue;
    const row = el('div', 'config-row');
    row.dataset.kind = field.kind;
    const id = prefix + '-' + field.key.replaceAll('.', '-');
    const name = el('div', 'config-label-line');
    const label = el('label', 'config-label', field.label);
    label.htmlFor = id;
    name.appendChild(label);
    if (field.help) name.appendChild(makeHelpTip(field.label, field.help));
    const controlBox = el('div', 'config-control');
    let control, selectWrapper;
    if (field.kind === 'multi') {
      control = configMultiselect(field, id, {
        catalog: data.catalog, read: () => settings[group][key], disabled: saving,
        write: next => { if (current === account && !saving) return save(field.key, next); },
      });
    } else if (field.kind === 'choice') {
      selectWrapper = component('ui-select');
      control = selectWrapper.querySelector('select');
    } else {
      control = component(field.kind === 'switch' ? 'ui-event-switch' : 'ui-number');
    }
    control.id = id;
    control.dataset[dataset] = field.key;
    control.setAttribute('aria-label', field.label);
    control.disabled = saving;
    if (field.kind === 'switch') {
      setTaskSwitch(control, value);
      control.onclick = () => {
        if (current === account && !control.disabled) return save(field.key, !value);
      };
    } else if (field.kind !== 'multi') {
      if (field.kind === 'choice') {
        control.className = 'config-select';
        for (const [optionValue, text] of field.options) {
          const option = el('option', null, text);
          option.value = optionValue;
          control.appendChild(option);
        }
      } else {
        control.type = field.kind;
        control.required = true;
      }
      const rule = data.rules.numbers[field.key];
      if (field.kind === 'number') {
        control.min = rule.min;
        control.max = rule.max;
        control.step = 1;
      }
      control.value = value;
      control.onchange = () => {
        if (current !== account || control.disabled) return;
        const next = field.kind === 'number' ? control.valueAsNumber : control.value;
        let error = '';
        if (field.kind === 'number' && (!Number.isInteger(next) || next < rule.min || next > rule.max)) {
          error = field.label + '必须是 ' + rule.min + ' 到 ' + rule.max + ' 的整数';
        }
        if (field.kind === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(next)) error = field.label + '格式无效';
        if (field.kind === 'choice' && !field.options.some(([optionValue]) => optionValue === next)) error = field.label + '选项无效';
        if (error) {
          control.value = value;
          reportError(new Error(error), '设置' + title);
          return;
        }
        if (next !== value) return save(field.key, next);
      };
    }
    if (field.unit) {
      const numberLine = el('div', 'config-number');
      numberLine.append(control, el('span', null, field.unit));
      controlBox.appendChild(numberLine);
    } else controlBox.appendChild(selectWrapper ?? control);
    row.append(name, controlBox);
    (fieldContainers?.get(field.key) ?? section).appendChild(row);
  }
  if (note) section.appendChild(el('p', 'dim', note));
  const status = el('p', 'dim', saving ? '正在保存…' : statusText);
  status.setAttribute('role', 'status');
  box.appendChild(section);
  (statusBox ?? section).appendChild(status);
}

async function refreshSeaMerchantSettings(account) {
  if (!account || savingSeaMerchantSettings.has(account)) return;
  const version = ++seaMerchantSettingsVersion;
  try {
    const data = await call('/api/merchant/settings?account=' + encodeURIComponent(account));
    if (account !== current || seaMerchantSettingsOwner !== account || version !== seaMerchantSettingsVersion) return;
    setConsoleValue('activities', 'seaMerchantSettingsData', data);
    setConsoleValue('activities', 'seaMerchantSettingsStatus', '');
  } catch {
    if (account !== current || seaMerchantSettingsOwner !== account || version !== seaMerchantSettingsVersion) return;
    setConsoleValue('activities', 'seaMerchantSettingsStatus', '海商王配置读取失败，请刷新重试。');
  }
}

async function saveSeaMerchantSetting(key, value, displayed = seaMerchantSettingsData) {
  const account = current;
  if (!account || seaMerchantSettingsOwner !== account || !seaMerchantSettingsData || savingSeaMerchantSettings.has(account)) return;
  const version = ++seaMerchantSettingsVersion;
  savingSeaMerchantSettings.add(account);
  setConsoleValue('activities', 'seaMerchantSettingsStatus', '');
  renderActivityDetail();
  let failure = null;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current || seaMerchantSettingsOwner !== account || version !== seaMerchantSettingsVersion) return;
    const latest = key === 'preset' ? displayed : await call('/api/merchant/settings?account=' + encodeURIComponent(account));
    if (account !== current || seaMerchantSettingsOwner !== account || version !== seaMerchantSettingsVersion) return;
    const saved = await call('/api/merchant/settings?account=' + encodeURIComponent(account), {
      method: 'POST', body: JSON.stringify({ key, value, revision: latest.revision, baseRevision: latest.baseRevision, confirm: true }),
    });
    if (account === current && seaMerchantSettingsOwner === account && version === seaMerchantSettingsVersion) {
      setConsoleValue('activities', 'seaMerchantSettingsData', saved);
      loopSettingsRevision = saved.revision;
    }
  } catch (error) {
    failure = error;
    if (account === current && seaMerchantSettingsOwner === account) reportError(error, '保存海商王配置');
  } finally {
    savingSeaMerchantSettings.delete(account);
    if (account === current && seaMerchantSettingsOwner === account) {
      await refreshSeaMerchantSettings(account);
      if (account === current && seaMerchantSettingsOwner === account) {
        if (failure) setConsoleValue('activities', 'seaMerchantSettingsStatus', failure.message);
        renderActivityTabs();
      }
    }
  }
}

async function refreshGuildShipSettings(account) {
  if (!account || savingGuildShipSettings.has(account)) return;
  const version = ++guildShipSettingsVersion;
  try {
    const data = await call('/api/guild-ship/settings?account=' + encodeURIComponent(account));
    if (account !== current || guildShipSettingsOwner !== account || version !== guildShipSettingsVersion) return;
    setConsoleValue('activities', 'guildShipSettingsData', data);
    setConsoleValue('activities', 'guildShipSettingsStatus', '');
  } catch {
    if (account !== current || guildShipSettingsOwner !== account || version !== guildShipSettingsVersion) return;
    setConsoleValue('activities', 'guildShipSettingsStatus', '联盟商船配置读取失败，请刷新重试。');
  }
}

async function saveGuildShipSetting(key, value) {
  const account = current;
  if (!account || guildShipSettingsOwner !== account || !guildShipSettingsData || savingGuildShipSettings.has(account)) return;
  const version = ++guildShipSettingsVersion;
  savingGuildShipSettings.add(account);
  setConsoleValue('activities', 'guildShipSettingsStatus', '');
  renderActivityDetail();
  let failure = null;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current || guildShipSettingsOwner !== account || version !== guildShipSettingsVersion) return;
    const latest = await call('/api/guild-ship/settings?account=' + encodeURIComponent(account));
    if (account !== current || guildShipSettingsOwner !== account || version !== guildShipSettingsVersion) return;
    const saved = await call('/api/guild-ship/settings?account=' + encodeURIComponent(account), {
      method: 'POST', body: JSON.stringify({ key, value, revision: latest.revision, baseRevision: latest.baseRevision, confirm: true }),
    });
    if (account === current && guildShipSettingsOwner === account && version === guildShipSettingsVersion) {
      setConsoleValue('activities', 'guildShipSettingsData', saved);
      loopSettingsRevision = saved.revision;
    }
  } catch (error) {
    failure = error;
    if (account === current && guildShipSettingsOwner === account) reportError(error, '保存联盟商船配置');
  } finally {
    savingGuildShipSettings.delete(account);
    if (account === current && guildShipSettingsOwner === account) {
      await refreshGuildShipSettings(account);
      if (account === current && guildShipSettingsOwner === account) {
        if (failure) setConsoleValue('activities', 'guildShipSettingsStatus', failure.message);
        renderActivityTabs();
      }
    }
  }
}

function renderActivityOrder() {
  const materials = clear($('activities-order')), data = activitiesData;
  if (data.order?.materials.length && !data.order.finished) {
    materials.appendChild(el('p', 'dim', data.order.ready
      ? '商人订单材料已齐，已预留整单用量，可提交订单或开启自动运行。'
      : '商人订单尚缺材料，可按下方报价购买，也可由已开启的自动完成按配置补料。'));
    const submit = smallButton('提交整单');
    submit.disabled = !data.order.ready;
    submit.onclick = () => confirmWeekOrderAction('submit');
    materials.appendChild(submit);
    materials.appendChild(table(['材料', '需要', '库存', '还缺', '生产地点', '当前状态', '钻石购买'], data.order.materials.map(row => {
      const cost = row.price * row.missing, buy = smallButton(cost + ' 钻');
      buy.onclick = () => confirmWeekOrderAction('buy', { itemId: row.id, quantity: row.missing, cost });
      return [row.name, String(row.required), String(row.owned), row.missing ? String(row.missing) : '已齐',
        row.seed ? '农田' : row.factory ? row.factory.name + ' · ' + row.factory.required + ' 级' : '无工厂配方',
        row.seed ? row.farmStatus : !row.factory ? '—' : row.factory.level === null ? '等级未知' : row.factory.level ? row.factory.level + ' 级' + (row.factory.constructing ? ' · 升级中' : '') : row.factory.constructing ? '建造中' : '未建造',
        row.missing && row.price ? buy : row.missing ? '无售价' : '—'];
    })));
  } else materials.textContent = data.orderError ? '未能读取材料，详情见运行日志' : !data.order ? '不差钱商人活动未开放' : data.order.finalReady ? '本期商人订单已全部交付，可领取最终奖励。' : data.order.finished ? '本期商人订单已完成' : '当前没有材料需求';
}

function confirmWeekOrderAction(action, payload = {}) {
  const account = activitiesAccount, order = activitiesData?.order;
  if (!order || account !== current) return;
  const row = order.materials.find(item => item.id === payload.itemId);
  const detail = action === 'buy'
    ? row.name + ' ×' + payload.quantity + '，共 ' + payload.cost + ' 钻石'
    : order.materials.map(item => item.name + ' ×' + item.required).join('、');
  const key = account + ':week-order:' + action + ':' + (payload.itemId || '');
  openConfirm(action === 'buy' ? '钻石购买商人订单材料' : '提交整份商人订单', [el('p', '', detail)], async () => {
    if (account !== current || account !== activitiesAccount) throw Error('账号已切换，请刷新');
    if (snapshot.paused || disconnected.has(account)) throw Error('请先连接账号并恢复运行');
    if (pendingActivities.has(key)) return;
    pendingActivities.add(key);
    try {
      await call('/api/week-order/' + action + '?account=' + encodeURIComponent(account), {
        method: 'POST', body: JSON.stringify({ confirm: true, orderKey: order.orderKey, ...payload }),
      });
    } finally {
      pendingActivities.delete(key);
      if (account === current) await refreshActivities();
    }
  });
}

async function refreshActivities() {
  const version = ++activitiesVersion, account = current;
  clearTimeout(activityExpiryTimer);
  ++discoveryVersion;
  const changed = activitiesAccount !== account;
  if (changed) {
    setConsoleValue('activities', 'activitiesAccount', account);
    setConsoleValue('activities', 'activitiesData', null);
    setConsoleValue('activities', 'selectedActivity', activitySelections.get(account) || null);
    clear($('activity-tabs'));
    $('activity-panel').hidden = true;
    for (const id of ['activities-list', 'activities-order']) clear($(id));
    setConsoleValue('activities', 'merchantSettingsOwner', account);
    setConsoleValue('activities', 'merchantSettingsData', null);
    setConsoleValue('activities', 'merchantSettingsStatus', '');
    ++merchantSettingsVersion;
    setConsoleValue('activities', 'heroRaidSettingsOwner', account);
    setConsoleValue('activities', 'heroRaidSettingsData', null);
    setConsoleValue('activities', 'heroRaidSettingsStatus', '');
    ++heroRaidSettingsVersion;
    setConsoleValue('activities', 'seaMerchantSettingsOwner', account);
    setConsoleValue('activities', 'seaMerchantSettingsData', null);
    setConsoleValue('activities', 'seaMerchantSettingsStatus', '');
    ++seaMerchantSettingsVersion;
    setConsoleValue('activities', 'guildShipSettingsOwner', account);
    setConsoleValue('activities', 'guildShipSettingsData', null);
    setConsoleValue('activities', 'guildShipSettingsStatus', '');
    ++guildShipSettingsVersion;
    setConsoleValue('activities', 'activityAutomationOwner', account);
    setConsoleValue('activities', 'activityAutomationData', null);
    setConsoleValue('activities', 'activityAutomationStatus', '');
    ++activityAutomationVersion;
  }
  if ($('tab-activities').classList.contains('hidden')) return;
  const status = $('activities-status');
  const isCurrent = () => version === activitiesVersion && account === current;
  const selectionVersion = discoveryVersion;
  const preferredSelection = activitySelections.get(account) || selectedActivity;
  const render = provisional => {
    // A partial catalog may not contain the remembered tab yet. Restore it when
    // it becomes available, unless the user has selected another tab meanwhile.
    if (selectionVersion === discoveryVersion) setConsoleValue('activities', 'selectedActivity', preferredSelection);
    renderActivityTabs(provisional);
  };
  const isUnavailable = () => !account || snapshot.connected !== true || snapshot.paused || disconnected.has(account);
  const offlineStatus = () => !account ? '请先选择账号' : snapshot.paused ? '账号已暂停，可修改活动配置' : '账号未连接，可先配置活动';
  status.textContent = isUnavailable() ? offlineStatus() : '正在同步活动进度…';
  if (activitiesData) {
    // Keep the list visible while refreshing, but require live confirmation for
    // game actions; saved settings remain editable throughout the refresh.
    setConsoleValue('activities', 'activitiesData', { ...activitiesData, catalogOnly: true, status: {} });
  }
  if (account) render(true);

  const refreshSettings = (refresh, matches) => refresh(account).then(() => {
    if (!isCurrent() || $('tab-activities').classList.contains('hidden')) return;
    const row = activityRows().find(item => item.id === selectedActivity);
    if (row && matches(row)) renderActivityDetail();
  });
  // Configuration and live game reads are independent. A slow unrelated
  // settings endpoint must not hold the activity list or selected settings back.
  const settingsReady = Promise.all([
    refreshSettings(refreshMerchantSettings, row => row.weekType === 5),
    refreshSettings(refreshHeroRaidSettings, isHeroRaidActivity),
    refreshSettings(refreshSeaMerchantSettings, isSeaMerchantActivity),
    refreshSettings(refreshGuildShipSettings, isGuildShipActivity),
    refreshSettings(refreshActivityAutomation, row => row.weekType !== 5 && !isHeroRaidActivity(row) && !isSeaMerchantActivity(row) && !isGuildShipActivity(row)),
  ]);
  let liveSettled = false;
  let catalogRead;
  const readCatalog = () => catalogRead ??= call('/api/activities/catalog?account=' + encodeURIComponent(account)).catch(() => null);
  const unavailable = isUnavailable();
  if (account && (changed || !activitiesData || unavailable)) {
    void readCatalog().then(data => {
      if (!data || !isCurrent() || liveSettled) return;
      setConsoleValue('activities', 'activitiesData', data);
      setConsoleValue('activities', 'activitiesReceivedAt', Date.now());
      render(true);
    });
  }
  if (unavailable) {
    status.textContent = offlineStatus();
    await Promise.all([settingsReady, catalogRead]);
    return;
  }
  try {
    const data = await call('/api/activities?account=' + encodeURIComponent(account));
    liveSettled = true;
    if (!isCurrent()) return;
    if (isUnavailable()) {
      setConsoleValue('activities', 'activitiesData', { ...data, catalogOnly: true, status: {} });
      setConsoleValue('activities', 'activitiesReceivedAt', Date.now());
      status.textContent = offlineStatus();
      render(true);
      return;
    }
    // A settings save can overlap this read. Preserve the newer local value.
    for (const task of data.eventTasks) {
      const local = activityTaskEdits.get(account + ':' + task.key);
      if (local && (local.pending || local.version >= version)) task.enabled = local.enabled;
    }
    setConsoleValue('activities', 'activitiesData', data);
    setConsoleValue('activities', 'activitiesReceivedAt', Date.now());
    status.textContent = [data.catalogError, ...(data.notes || [])].filter(Boolean).join(' ')
      || (data.activities.length ? '' : '当前没有已下发的限时或周期活动');
    render(false);
    const boundaries = data.activities.flatMap(row => [row.startTime, row.endTime]).filter(time => time > activityNow());
    if (boundaries.length) activityExpiryTimer = setTimeout(() => {
      renderActivityTabs();
      refreshActivities();
    }, Math.min(2147483647, Math.max(1, Math.ceil((Math.min(...boundaries) - activityNow()) * 1000))));
  } catch {
    liveSettled = true;
    if (!isCurrent()) return;
    const data = await readCatalog();
    if (!isCurrent()) return;
    if (data) {
      setConsoleValue('activities', 'activitiesData', data);
      setConsoleValue('activities', 'activitiesReceivedAt', Date.now());
    }
    status.textContent = activitiesData?.activities.length ? '活动同步失败，当前展示已保存的活动时间。请刷新重试。' : '活动读取失败，请刷新重试。详情见运行日志';
    render(true);
  } finally {
    await settingsReady;
  }
}
$('activities-refresh').onclick = refreshActivities;
