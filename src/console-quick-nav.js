const quickDialog = $('console-quick-dialog');
const quickQuery = $('console-quick-query');
const quickResults = $('console-quick-results');
let quickEntries = [];
let quickIndex = 0;
let quickConfigAccount;

function quickNavigationEntries(includeContent) {
  const entries = [];
  const nav = id => document.querySelector('#tabs [data-tab="' + id + '"]');
  const aliases = { overview: '总览 资源田 城池 地图', settings: '挂机配置 历史配置 导入 导出',
    'season-preview': '世界 赛季目标 最强个人 科技霸主 功勋榜 科技榜 邮件物品 自动偷榜',
    manual: '工厂 生产 建筑 农田', lineups: '舰队 预设 编队', account: '登录 账号 微信 支付宝 手机号',
    activities: '活动 奖励', stages: '试炼 海盗 关卡', inventory: '仓库 背包 库存',
    heroes: '英雄与装备 洗炼 装备制造' };
  for (const button of document.querySelectorAll('#tabs [data-tab]')) {
    entries.push({ label: button.getAttribute('aria-label') || button.textContent.trim(), context: '页面',
      keywords: aliases[button.dataset.tab], icon: button.querySelector('svg'), open: () => {
        activateConsolePage(button);
        return () => document.querySelector('main > section:not(.hidden)');
      } });
  }
  for (const button of document.querySelectorAll('[data-resource-tab]')) {
    entries.push({ label: button.textContent.trim(), context: '杂项',
      keywords: button.dataset.resourceTab === 'giftcodes' ? '礼包码 兑换 兑换码 抓取 渠道' : aliases[button.dataset.resourceTab],
      icon: nav('resources').querySelector('svg'), open: () => {
        activateConsolePage(nav('resources'), button.dataset.resourceTab);
        return () => $('tab-' + button.dataset.resourceTab);
      } });
  }
  for (const button of document.querySelectorAll('[data-config-tab]')) {
    entries.push({ label: button.textContent.trim(), context: '挂机配置',
      keywords: button.dataset.configTab === 'base' ? '工厂 农田' : undefined,
      icon: nav('settings').querySelector('svg'), open: () => {
        activateConsolePage(nav('settings')); button.click();
        return () => $(button.getAttribute('aria-controls')) || button;
      } });
  }
  if (includeContent) entries.push(...quickContentEntries(nav));
  return entries;
}

function quickContentEntries(nav) {
  const entries = [];
  const targets = 'h2,h3,h4,[data-slot="card-title"],button,label,summary,legend,p,th';
  const skip = 'dialog,template,[aria-hidden="true"],.sr-only,.help-popover,[role="status"],[role="alert"]';
  const titleOf = node => {
    const label = node.getAttribute('aria-label') || [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE ||
      child.nodeType === Node.ELEMENT_NODE && !child.matches(skip + ',[hidden],svg,button')).map(child => child.textContent).join('');
    return label.replace(/\s+/gu, ' ').trim();
  };
  const seen = new Set();
  for (const page of document.querySelectorAll('main > section[id^="tab-"]')) {
    const key = page.id.slice(4);
    const resource = document.querySelector('[data-resource-tab="' + CSS.escape(key) + '"]');
    const main = nav(resource ? 'resources' : key);
    if (!main) continue;
    const pageTitle = main.getAttribute('aria-label');
    const icon = main.querySelector('svg');
    const openPage = () => activateConsolePage(main, resource?.dataset.resourceTab);
    if (key === 'inventory') {
      for (const tab of page.querySelectorAll('#inventory-tabs [data-family]')) {
        entries.push({ label: tab.querySelector('span').textContent, context: '杂项 › 仓库', icon, open: () => {
          openPage(); showInventoryFamily(tab.dataset.family);
          return () => $('inventory-panel');
        } });
      }
    }
    if (key === 'settings' && configEditor.owner === current) {
      for (const group of configEditor.groups.values()) {
        entries.push({ label: group.title, context: [pageTitle, configCategories[group.category]].join(' › '), icon, open: () => {
          openPage(); configActivate(group.category); configActivateGroup(group.id);
          return () => $('config-group-' + group.id);
        } });
      }
    }
    for (const node of page.querySelectorAll(targets)) {
      if (node.closest(skip) || node.matches('[role="tab"]')) continue;
      const group = key === 'settings' && node.closest('.config-section');
      if (group && configEditor.owner !== current) continue;
      const activityPanel = key === 'activities' && node.closest('#activity-panel');
      const activity = activityPanel ? page.querySelector('[data-activity][aria-selected="true"]') : null;
      if (activityPanel && !activity) continue;
      const config = group && group.closest('[data-config-panel]');
      let available = true;
      for (let parent = node; parent !== page; parent = parent.parentElement) {
        if (parent === group || parent === config || (group && parent.revealConfig)) continue;
        if (parent.hidden || parent.classList.contains('hidden')) { available = false; break; }
      }
      if (!available) continue;
      const groupId = group && group.id.slice('config-group-'.length);
      const paneNames = [resource?.textContent, config && configCategories[config.dataset.configPanel],
        groupId && configEditor.groups.get(groupId)?.title,
        activity?.querySelector('.activity-tab-name')?.textContent];
      const context = [pageTitle, ...paneNames.filter(Boolean)].map(value => value.trim()).join(' › ');
      const title = titleOf(node);
      const signature = context + '|' + title;
      if (title.length < 2 || seen.has(signature)) continue;
      seen.add(signature);
      entries.push({ label: title, context, icon, open: () => {
        openPage();
        if (groupId) {
          configActivate(config.dataset.configPanel);
          configActivateGroup(groupId);
        }
        if (activity && activity.dataset.activity !== selectedActivity) selectActivity(activity.dataset.activity);
        return () => {
          if (node.isConnected) return node;
          const container = (groupId && $('config-group-' + groupId)) || activityPanel || page;
          return (node.id && $(node.id)) || [...container.querySelectorAll(targets)].find(candidate =>
            candidate.getClientRects().length && titleOf(candidate) === title) || container;
        };
      } });
    }
    if (key === 'activities') {
      for (const tab of page.querySelectorAll('[data-activity]')) {
        entries.push({ label: tab.querySelector('.activity-tab-name').textContent, context: '活动',
          icon, open: () => {
            openPage();
            selectActivity(tab.dataset.activity);
            return () => $('activity-panel');
          } });
      }
    }
  }
  return entries;
}

function chooseQuickEntry(index) {
  const entry = quickEntries[index];
  if (!entry) return;
  quickDialog.close();
  const resolve = entry.open();
  requestAnimationFrame(() => {
    const target = resolve();
    if (!target?.isConnected) return;
    let revealSettings = false;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent.hidden && parent.revealConfig) { parent.revealConfig(); revealSettings = true; }
      if (parent.matches('details:not([open])') && parent.querySelector(':scope > summary') !== target) parent.open = true;
    }
    if (revealSettings) configUpdateVisibility();
    const location = target.closest('.config-row') || (target.matches(':disabled') ? target.parentElement : target);
    const destination = location.getClientRects().length ? location : document.querySelector('main > section:not(.hidden)');
    if (!destination) return;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0;
    const toolbar = destination.closest('#config-form') && document.querySelector('.config-toolbar');
    const offset = header + (toolbar && getComputedStyle(toolbar).position === 'sticky' ? toolbar.offsetHeight : 0);
    window.scrollTo({ top: window.scrollY + destination.getBoundingClientRect().top - offset - 16,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
}

function paintQuickSelection(scroll = false) {
  const rows = [...quickResults.children];
  for (const [index, row] of rows.entries()) row.setAttribute('aria-selected', String(index === quickIndex));
  const active = rows[quickIndex];
  if (active) {
    quickQuery.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  } else quickQuery.removeAttribute('aria-activedescendant');
}

function renderQuickNavigation() {
  const normalize = value => value.normalize('NFKC').trim().toLocaleLowerCase();
  const query = normalize(quickQuery.value);
  if (query && current && configEditor.owner !== current && quickConfigAccount !== current && !configEditor.loading) {
    quickConfigAccount = current;
    void configLoad();
  }
  const words = query.split(/\s+/u).filter(Boolean);
  quickEntries = quickNavigationEntries(Boolean(query)).flatMap(entry => {
    const label = normalize(entry.label);
    const text = normalize([entry.label, entry.context, entry.keywords].join(' '));
    if (!words.every(word => text.includes(word))) return [];
    const score = label === query ? 0 : label.startsWith(query) ? 1 :
      label.includes(query) ? 2 : words.every(word => label.includes(word)) ? 3 : 4;
    return [{ ...entry, score }];
  }).sort((a, b) => a.score - b.score).slice(0, 40);
  quickIndex = 0;
  clear(quickResults);
  for (const [index, entry] of quickEntries.entries()) {
    const option = el('div', 'console-quick-option');
    option.id = 'console-quick-option-' + index;
    option.setAttribute('role', 'option');
    if (entry.icon) option.append(entry.icon.cloneNode(true));
    option.append(el('strong', '', entry.label), el('span', '', entry.context));
    option.onclick = () => chooseQuickEntry(index);
    quickResults.append(option);
  }
  $('console-quick-empty').hidden = quickEntries.length > 0;
  paintQuickSelection();
}

function openQuickNavigation() {
  if (document.querySelector('dialog[open]')) return;
  quickConfigAccount = null;
  quickQuery.value = '';
  renderQuickNavigation();
  quickDialog.showModal();
  quickQuery.focus();
  quickConfigChanges.observe($('config-fields'), { childList: true });
}

const quickConfigChanges = new MutationObserver(() => {
  if (quickDialog.open && quickQuery.value.trim()) renderQuickNavigation();
});
quickDialog.addEventListener('close', () => {
  if (quickDialog.open) return;
  quickConfigChanges.disconnect();
  quickEntries = [];
});
$('console-quick-open').onclick = openQuickNavigation;
$('console-quick-close').onclick = () => quickDialog.close();
quickQuery.oninput = renderQuickNavigation;
quickDialog.onkeydown = event => {
  if (event.isComposing || !quickEntries.length || event.target !== quickQuery) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    chooseQuickEntry(quickIndex);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    quickIndex = (quickIndex + (event.key === 'ArrowDown' ? 1 : -1) + quickEntries.length) % quickEntries.length;
    paintQuickSelection(true);
  }
};
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && !event.isComposing) {
    if (!quickDialog.open && document.querySelector('dialog[open]')) return;
    event.preventDefault();
    if (quickDialog.open) quickQuery.focus();
    else openQuickNavigation();
  }
});
