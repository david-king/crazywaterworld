const merchantIntelDialog = $('merchant-intel-dialog');
const merchantIntelList = $('merchant-intel-list');
const merchantIntelForm = $('merchant-intel-form');
const merchantIntelNotice = $('merchant-intel-notice');
let merchantIntelView = null, merchantIntelEditing = null, merchantIntelListStamp = '';
let merchantIntelSave = null, merchantLegacyAttempt = '', merchantLegacyRetryAt = 0;

function readMerchantEdits(view) {
  try {
    const saved = JSON.parse(localStorage.getItem(view.storageKey));
    if (saved?.scope === view.scope && saved.ports && typeof saved.ports === 'object') return saved.ports;
  } catch { /* 私密浏览仍可查看游戏情报。 */ }
  return {};
}

function writeLegacyEdits(view, edits) {
  if (Object.keys(edits).length) localStorage.setItem(view.storageKey, JSON.stringify({ scope: view.scope, ports: edits }));
  else localStorage.removeItem(view.storageKey);
}

function legacyGoodId(name, catalog, originalId) {
  if (!name) return 0;
  const matches = catalog.filter(item => item.name === name);
  if (matches.some(item => item.id === originalId)) return originalId;
  return matches.length === 1 ? matches[0].id : null;
}

function postMerchantChanges(view, changes) {
  return call('/api/merchant/intel?account=' + encodeURIComponent(view.account), {
    method: 'POST', body: JSON.stringify({ scope: view.scope, changes }),
  });
}

async function importMerchantEdits(view, changes) {
  const stamp = JSON.stringify([view.storageKey, view.scope, changes]);
  if (merchantLegacyAttempt === stamp && Date.now() < merchantLegacyRetryAt) return;
  merchantLegacyAttempt = stamp;
  merchantLegacyRetryAt = Infinity;
  try {
    await postMerchantChanges(view, changes);
    if (current === view.account) await refreshOverview();
  } catch {
    if (merchantLegacyAttempt === stamp) merchantLegacyRetryAt = Date.now() + 30000;
  }
}

function syncMerchantIntel(merchant, freshGameRead = true) {
  const trade = merchant?.trade, intel = trade?.intel;
  const storageKey = 'cw.merchant-intel.' + current;
  if (!intel || !merchantIntelView || merchantIntelView.scope !== intel.scope || merchantIntelView.storageKey !== storageKey) {
    if (merchantIntelDialog.open) merchantIntelDialog.close();
    merchantIntelEditing = null;
    merchantIntelListStamp = '';
  }
  if (!intel) { merchantIntelView = null; return; }
  const view = { scope: intel.scope, account: current, storageKey, intel, trade };
  const previous = merchantIntelView;
  const legacy = readMerchantEdits(view), edits = {}, changes = [];
  if (Array.isArray(intel.ports)) {
    for (const port of intel.ports) {
      const id = port.cityId, saved = intel.edits?.[id], old = legacy[id];
      if (saved && saved.revision === port.revision) {
        const name = id => intel.catalog.find(item => item.id === id)?.name;
        edits[id] = { ...saved, specialty: name(saved.specialtyId), shortage: name(saved.shortageId) };
      } else if (old && old.revision === port.revision) {
        const specialtyId = legacyGoodId(old.specialty, intel.catalog ?? [], port.specialtyId);
        const shortageId = legacyGoodId(old.shortage, intel.catalog ?? [], port.shortageId);
        edits[id] = { ...old, specialtyId, shortageId, legacy: true };
        if (specialtyId != null && shortageId != null) changes.push({ cityId: id, revision: port.revision,
          editVersion: null, specialtyId, shortageId, reporter: old.reporter || null });
      }
    }
    const remaining = Object.fromEntries(Object.entries(legacy).filter(([id]) => edits[id]?.legacy));
    if (Object.keys(remaining).length < Object.keys(legacy).length) {
      try { writeLegacyEdits(view, remaining); } catch { /* 过期旧值仍不会用于策略。 */ }
    }
    if (previous?.scope === intel.scope && previous.intel.ports?.some(port => previous.edits[port.cityId] &&
      intel.ports.find(row => row.cityId === port.cityId)?.revision !== port.revision))
      merchantIntelNotice.textContent = '港口情报已更新，已采用游戏记录。';
  }
  view.edits = edits;
  merchantIntelView = view;
  if (merchantIntelEditing && Array.isArray(intel.ports) && (!intel.ports.some(port =>
    port.cityId === merchantIntelEditing.cityId && port.revision === merchantIntelEditing.revision) ||
    (merchantIntelSave !== merchantIntelEditing && merchantIntelEditing.editVersion !== (edits[merchantIntelEditing.cityId]?.version ?? null)))) {
    merchantIntelEditing = null;
    merchantIntelNotice.textContent = intel.message || '正在编辑的港口情报已更新，已显示最新记录。';
    $('merchant-intel-close').focus();
  }
  if (merchantIntelDialog.open) paintMerchantIntel();
  if (freshGameRead && changes.length) void importMerchantEdits(view, changes);
}

function paintMerchantIntel() {
  const { intel, trade, edits } = merchantIntelView;
  const refresh = intel.nextRefreshAt && new Date(intel.nextRefreshAt * 1000)
    .toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  $('merchant-intel-context').textContent = ['第 ' + trade.period + ' 期', trade.coins != null && '商会币 ' + merchantNumber(trade.coins),
    refresh && '情报每日 ' + refresh + ' 刷新'].filter(Boolean).join(' · ');
  merchantIntelList.hidden = !!merchantIntelEditing;
  merchantIntelForm.hidden = !merchantIntelEditing;
  if (merchantIntelEditing) return;
  const stamp = JSON.stringify([intel.ports, intel.message, edits]);
  if (merchantIntelListStamp === stamp) return;
  merchantIntelListStamp = stamp;
  const focusedId = document.activeElement?.dataset.editPort;
  const scroll = merchantIntelList.scrollTop;
  if (intel.ports?.length) {
    const rows = intel.ports.map(port => {
      const edit = edits[port.cityId], values = edit ?? port;
      const city = el('span', null, port.city);
      if (port.position) city.append(' ', el('span', 'merchant-port-position', port.position));
      if (edit) city.append(' ', el('span', 'merchant-intel-manual', edit.legacy ? '待同步' : '手动'));
      const button = smallButton('编辑');
      button.dataset.editPort = port.cityId;
      button.setAttribute('aria-label', '编辑' + port.city + '情报');
      button.onclick = () => editMerchantPort(port, values);
      return [city, values.specialty || '未同步', values.shortage || '待共享', values.reporter || '—', button];
    });
    merchantIntelList.replaceChildren(table(['港口', '特产', '紧缺商品', '共享人', '操作'], rows));
  } else merchantIntelList.replaceChildren(el('p', 'merchant-caption', intel.message));
  merchantIntelList.scrollTop = scroll;
  if (focusedId) merchantIntelList.querySelector('[data-edit-port="' + focusedId + '"]')?.focus({ preventScroll: true });
}

function openMerchantIntel() {
  if (!merchantIntelView || merchantIntelDialog.open) return;
  merchantIntelEditing = null;
  merchantIntelNotice.textContent = '';
  paintMerchantIntel();
  merchantIntelDialog.showModal();
  void refreshOverview();
}

function editMerchantPort(port, values) {
  merchantIntelEditing = { ...port, editVersion: values.version ?? null };
  merchantIntelNotice.textContent = '';
  $('merchant-intel-city').textContent = '编辑' + port.city + '情报';
  for (const field of ['specialty', 'shortage']) {
    const select = $('merchant-intel-' + field);
    const catalog = merchantIntelView.intel.catalog;
    const options = catalog.map(item => new Option(catalog.some(other => other.id !== item.id && other.name === item.name)
      ? item.name + '（' + item.id + '）' : item.name, String(item.id)));
    select.replaceChildren(new Option('未知', '0'), ...options);
    const id = values[field + 'Id'];
    if (id == null && values[field]) select.add(new Option('请选择「' + values[field] + '」对应的商品', ''));
    select.value = id == null && values[field] ? '' : String(id ?? 0);
    select.required = true;
  }
  $('merchant-intel-reporter').value = values.reporter || '';
  $('merchant-intel-reset').hidden = !merchantIntelView.edits[port.cityId];
  paintMerchantIntel();
  $('merchant-intel-specialty').focus();
}

function finishMerchantEdit(message) {
  const id = merchantIntelEditing.cityId;
  merchantIntelEditing = null;
  paintMerchantIntel();
  merchantIntelList.querySelector('[data-edit-port="' + id + '"]')?.focus();
  merchantIntelNotice.textContent = message;
}

async function saveMerchantEdit(restore) {
  const port = merchantIntelEditing, view = merchantIntelView;
  if (!port || !view || merchantIntelSave === port) return;
  const change = { cityId: port.cityId, revision: port.revision, editVersion: port.editVersion, reset: restore,
    specialtyId: Number($('merchant-intel-specialty').value),
    shortageId: Number($('merchant-intel-shortage').value),
    reporter: $('merchant-intel-reporter').value.trim() || null,
  };
  merchantIntelSave = port;
  merchantIntelForm.inert = true;
  merchantIntelNotice.textContent = '正在核对游戏情报并保存…';
  try {
    const result = await postMerchantChanges(view, [change]);
    const live = merchantIntelView;
    if (live?.scope !== result.scope || live.account !== view.account) return;
    const legacy = readMerchantEdits(view);
    if (legacy[port.cityId]) {
      delete legacy[port.cityId];
      try { writeLegacyEdits(view, legacy); } catch { /* 以后台记录为准。 */ }
    }
    if (live.intel.ports?.some(row => row.cityId === port.cityId && row.revision === port.revision)) {
      const intel = { ...live.intel, edits: { ...live.intel.edits, [port.cityId]: result.edits[port.cityId] } };
      syncMerchantIntel({ trade: { ...live.trade, intel } }, false);
      if (merchantIntelEditing === port) finishMerchantEdit(restore ? '已恢复游戏情报。' : '情报已保存，走商会在下次规划时使用。');
    }
    await refreshOverview();
  } catch (error) {
    if (merchantIntelEditing === port) merchantIntelNotice.textContent = error.message;
    if (current === view.account) void refreshOverview();
  } finally {
    if (merchantIntelSave === port) { merchantIntelSave = null; merchantIntelForm.inert = false; }
  }
}

merchantIntelForm.onsubmit = event => { event.preventDefault(); saveMerchantEdit(false); };
$('merchant-intel-reset').onclick = () => saveMerchantEdit(true);
$('merchant-intel-cancel').onclick = () => finishMerchantEdit('');
$('merchant-intel-close').onclick = () => merchantIntelDialog.close();
merchantIntelDialog.onclose = () => {
  if (merchantIntelDialog.open) return;
  merchantIntelEditing = null;
  $('merchant-intel-toggle')?.focus({ preventScroll: true });
};
window.addEventListener('storage', event => {
  const view = merchantIntelView;
  if (view && (event.key === view.storageKey || event.key === null)) syncMerchantIntel({ trade: view.trade }, false);
});
