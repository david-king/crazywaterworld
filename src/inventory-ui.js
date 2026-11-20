const inventoryNames = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true });
const inventoryFamilyByType = new Map();
for (const [family, types] of Object.entries({
  production: ['基础资源', '原料', '加工品', '农产品'],
  growth: ['阵型图纸', '专武经验', '装备材料', '宠物基因', '英雄万能碎片', '藏品万能碎片', '英雄碎片', '藏品碎片', '万能芯片', '万能核芯', '芯片', '核芯'],
  supplies: ['随机包', '自选包', '徽章随机包', '徽章自选包', '徽章定制包', '芯片宝箱', '补给随机包', '补给定制包', '补给材料'],
  appearance: ['限时头像框', '头像框', '限时聊天框', '聊天框', '限时称号', '称号', '英雄皮肤', '玩家头像', '舰队皮肤', '建筑皮肤', '行军特效', '连杀特效'],
})) {
  for (const type of types) inventoryFamilyByType.set(type, family);
}
const inventoryTabList = $('inventory-tabs');
const inventoryTabs = [...inventoryTabList.querySelectorAll('[role=tab]')];
const narrowInventory = window.matchMedia('(max-width:768px)');
let inventoryData = null, inventoryOwner = null, inventoryFamily = null;
bindConsoleSlice('inventory', { inventoryData, inventoryOwner, inventoryFamily }, state => {
  inventoryData = state.inventoryData;
  inventoryOwner = state.inventoryOwner;
  inventoryFamily = state.inventoryFamily;
});

function resetInventory() {
  patchConsoleSlice('inventory', { inventoryData: null, inventoryOwner: current, inventoryFamily: null });
  $('inventory-query').value = '';
  $('inventory-sort').value = 'scarcity';
  showInventoryFamily(null);
  clear($('world-stock'));
  clear($('inventory-match-count'));
}

function renderInventory(stock) {
  if (inventoryOwner !== current) resetInventory();
  if (JSON.stringify(inventoryData) !== JSON.stringify(stock)) {
    setConsoleValue('inventory', 'inventoryData', stock);
    showInventoryFamily(inventoryFamily, true);
  }
  $('inventory-status').textContent = '共 ' + stock.length + ' 种 · 更新于 '
    + new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function familyOfStock(entry) {
  return inventoryFamilyByType.get(entry.category) || 'general';
}

function showInventoryFamily(requested, keepPosition = false) {
  const counts = new Map();
  for (const entry of inventoryData || []) {
    const family = familyOfStock(entry);
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  const active = requested || inventoryTabs.find(tab => counts.has(tab.dataset.family))?.dataset.family || 'production';
  const revealSelection = !keepPosition || active !== inventoryFamily;
  if ((requested || inventoryData?.length) && active !== inventoryFamily) setConsoleValue('inventory', 'inventoryFamily', active);
  for (const tab of inventoryTabs) {
    const family = tab.dataset.family, selected = family === active;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.querySelector('[data-stock-count]').textContent = inventoryData
      ? String(family === 'all' ? inventoryData.length : counts.get(family) || 0) : '';
    if (selected) {
      if (narrowInventory.matches && revealSelection) revealHorizontalTab(tab);
      $('inventory-panel').setAttribute('aria-labelledby', tab.id);
      const label = family === 'all' ? '搜索全部库存' : '搜索' + tab.querySelector('span').textContent;
      $('inventory-query').placeholder = label;
      $('inventory-query').setAttribute('aria-label', label);
    }
  }
  const select = $('inventory-category'), previous = keepPosition ? select.value : '';
  const entries = (inventoryData || []).filter(entry => active === 'all' || familyOfStock(entry) === active);
  const types = [...new Set(entries.map(entry => entry.category || '其他'))].sort(inventoryNames.compare);
  select.options.length = 1;
  for (const type of types) select.add(new Option(type, type));
  select.hidden = types.length <= 1;
  select.value = types.includes(previous) ? previous : '';
  paintInventory(keepPosition && previous === select.value);
}

function inventoryRatio(entry) {
  return Number.isSafeInteger(entry.cap) && entry.cap > 0 ? entry.num / entry.cap : Infinity;
}

function inventoryItem(entry, showCategory) {
  const item = el('li', 'inventory-item'), name = el('span', 'inventory-name', entry.name);
  const ratio = inventoryRatio(entry);
  const quantity = Number.isFinite(ratio) ? fmt(entry.num) + ' / ' + fmt(entry.cap) : fmt(entry.num);
  const values = el('div', 'inventory-values');
  if (showCategory) values.append(el('span', 'inventory-kind', entry.category || '其他'));
  values.append(el('span', 'inventory-amount', quantity));
  item.append(iconEl(entry.icon, 24, entry.name), name, values);
  if (!Number.isFinite(ratio)) return item;
  const low = ratio <= 0.2, mid = ratio <= 0.5;
  const level = low ? '紧缺' : mid ? '偏低' : ratio >= 1 ? '已满' : '充足';
  const label = entry.capKind === 'recovery' ? (ratio >= 1 ? '已达恢复上限' : '自然恢复上限') : level;
  item.dataset.level = low ? 'low' : mid ? 'mid' : 'high';
  const gauge = el('div', 'inventory-gauge'), track = el('div', 'inventory-track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-label', entry.name + '库存');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(entry.cap));
  track.setAttribute('aria-valuenow', String(Math.min(entry.cap, entry.num)));
  track.setAttribute('aria-valuetext', label + '，' + quantity);
  const fill = el('span');
  fill.style.width = Math.min(100, ratio * 100) + '%';
  track.append(fill);
  gauge.append(track, el('span', 'inventory-level', label));
  item.append(gauge);
  return item;
}

function paintInventory(keepPosition = false) {
  if (!inventoryData) return;
  const root = $('world-stock'), category = $('inventory-category').value, sort = $('inventory-sort').value;
  const query = $('inventory-query').value.trim().toLocaleLowerCase();
  const matches = inventoryData.filter(entry => (inventoryFamily === 'all' || familyOfStock(entry) === inventoryFamily)
    && (!category || (entry.category || '其他') === category)
    && entry.name.toLocaleLowerCase().includes(query));
  matches.sort((a, b) => {
    if (sort === 'scarcity') {
      const left = inventoryRatio(a), right = inventoryRatio(b);
      if (left !== right) return left - right;
    }
    if (sort !== 'name' && a.num !== b.num) return b.num - a.num;
    return inventoryNames.compare(a.name, b.name) || inventoryNames.compare(a.id, b.id);
  });

  const top = keepPosition ? root.scrollTop : 0;
  if (matches.length) {
    const grid = el('ul', 'inventory-grid');
    for (const entry of matches) grid.append(inventoryItem(entry, !category));
    root.replaceChildren(grid);
  } else {
    root.replaceChildren(el('p', 'dim inventory-empty', query ? '没有匹配的资源名称' : inventoryData.length ? '这类物品暂无库存' : '仓库空'));
  }
  root.scrollTop = top;
  $('inventory-match-count').textContent = query || category ? '匹配 ' + matches.length + ' 种' : '';
}

function orientInventoryTabs() {
  inventoryTabList.setAttribute('aria-orientation', narrowInventory.matches ? 'horizontal' : 'vertical');
  if (narrowInventory.matches) revealHorizontalTab(inventoryTabList.querySelector('[aria-selected=true]'));
}
orientInventoryTabs();
new ResizeObserver(orientInventoryTabs).observe(inventoryTabList);
inventoryTabs.forEach((tab, index) => {
  tab.onclick = () => showInventoryFamily(tab.dataset.family);
  tab.onkeydown = event => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: inventoryTabs.length - 1 - index };
    if (!narrowInventory.matches) Object.assign(offsets, { ArrowUp: -1, ArrowDown: 1 });
    if (!Object.hasOwn(offsets, event.key)) return;
    event.preventDefault();
    const next = inventoryTabs[(index + offsets[event.key] + inventoryTabs.length) % inventoryTabs.length];
    next.focus({ preventScroll: narrowInventory.matches });
    next.click();
  };
});
$('inventory-query').oninput = () => paintInventory();
$('inventory-category').onchange = () => paintInventory();
$('inventory-sort').onchange = () => paintInventory();
