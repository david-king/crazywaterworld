import { readFileSync } from 'node:fs';
import { SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION } from './automation-settings.mjs';
import { operationLabels } from './operation-labels.mjs';
import { LOG_CATEGORIES, LOG_GROUPS, LOG_GROUP_TONES } from './log-categories.mjs';
import { createLogAccountLabels } from './log-accounts.mjs';
import { chrome, journal, dialogs, templates, giftCodesPage, overviewPage, manualPage, inventoryPage, heroesPage, lineupsPage, guildPage, activitiesPage, accountPage, stagePanel, settingsPage } from './ui/dist/console.mjs';
const componentCss = readFileSync(new URL('./ui/dist/theme.css', import.meta.url), 'utf8');
const settingsHistoryScript = readFileSync(new URL('./settings-history-ui.js', import.meta.url), 'utf8');
const consoleCss = readFileSync(new URL('./console.css', import.meta.url), 'utf8');
const progressionScript = readFileSync(new URL('./ui/progression.js', import.meta.url), 'utf8');
const lineupScript = readFileSync(new URL('./lineup-editor.js', import.meta.url), 'utf8');
const lineupCss = readFileSync(new URL('./lineup-editor.css', import.meta.url), 'utf8');
const settingsScript = readFileSync(new URL('./settings-ui.js', import.meta.url), 'utf8');
const runtimeOverviewScript = readFileSync(new URL('./runtime-overview-ui.js', import.meta.url), 'utf8');
const merchantIntelScript = readFileSync(new URL('./merchant-intel-ui.js', import.meta.url), 'utf8');
const activitiesScript = readFileSync(new URL('./ui/activities.js', import.meta.url), 'utf8');
const settingsCss = readFileSync(new URL('./settings.css', import.meta.url), 'utf8');
const giftCodeScript=readFileSync(new URL('./gift-codes-ui.js',import.meta.url),'utf8');
const inventoryScript=readFileSync(new URL('./inventory-ui.js',import.meta.url),'utf8');
const productionPlanningScript = readFileSync(new URL('./production-planning-ui.js', import.meta.url), 'utf8');
const worldMapScript=readFileSync(new URL('./world-map-ui.js',import.meta.url),'utf8');
const siliconOverviewScript = readFileSync(new URL('./silicon-overview-ui.js', import.meta.url), 'utf8');
const siliconOverviewCss = readFileSync(new URL('./silicon-overview.css', import.meta.url), 'utf8');
const resourceFieldsScript = readFileSync(new URL('./resource-fields-ui.js', import.meta.url), 'utf8');
const resourceFieldsCss = readFileSync(new URL('./resource-fields.css', import.meta.url), 'utf8');
import {mapMotionPosition} from './world-map-geometry.mjs';
const phoneLoginScript = readFileSync(new URL('./phone-login-ui.js', import.meta.url), 'utf8');
const alipayLoginScript = readFileSync(new URL('./alipay-login-ui.js', import.meta.url), 'utf8');
const wechatLoginScript = readFileSync(new URL('./wechat-login-ui.js', import.meta.url), 'utf8');
const accountAddScript = readFileSync(new URL('./account-add-ui.js', import.meta.url), 'utf8');
const accountBackupScript = readFileSync(new URL('./account-backup-ui.js', import.meta.url), 'utf8');
const accountPickerScript = readFileSync(new URL('./account-picker-ui.js', import.meta.url), 'utf8');
const helpTipsScript = readFileSync(new URL('./help-tips.js', import.meta.url), 'utf8');
const themeScript = readFileSync(new URL('./theme-ui.js', import.meta.url), 'utf8');
const consoleQuickScript = readFileSync(new URL('./console-quick-nav.js', import.meta.url), 'utf8');
const consoleStoreScript = readFileSync(new URL('./ui/dist/console-store.js', import.meta.url), 'utf8');

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect fill='%23102d39' width='40' height='40' rx='8'/%3E%3Cpath fill='%23ffbd77' d='m20 3 4 13 13 4-13 4-4 13-4-13-13-4 13-4z'/%3E%3C/svg%3E">
<title>疯狂水世界</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="format-detection" content="telephone=no">
<script id="theme-init">${themeScript}</script>
<style>@layer properties, theme, base, components, page, utilities; @layer page { ${consoleCss} ${settingsCss} ${lineupCss} ${siliconOverviewCss} ${resourceFieldsCss} } ${componentCss}</style>
</head>
<body>
${chrome()}
<div class="deck"><main>
  <nav id="resource-tabs" class="resource-tabs" aria-label="杂项分类" hidden>
    <button type="button" data-resource-tab="guild">联盟</button><button type="button" data-resource-tab="inventory">仓库</button><button type="button" data-resource-tab="heroes">英雄与装备</button>
    <button type="button" data-resource-tab="items">装备与徽章</button>
    <button type="button" data-resource-tab="giftcodes">礼包兑换</button>
    <button type="button" data-resource-tab="dailies">日常任务</button>
    <button type="button" data-resource-tab="shops">商店</button>
    <button type="button" data-resource-tab="season-preview">赛季预览</button>
    <button type="button" data-resource-tab="chat">聊天</button>
  </nav>
  <section id="tab-overview">
    ${overviewPage()}
  </section>

  <section id="tab-settings" class="hidden">
    ${settingsPage()}
  </section>

  <section id="tab-manual" class="hidden" tabindex="-1" aria-label="建筑一览">
    ${manualPage()}
  </section>

  <section id="tab-stages" class="hidden">
    ${stagePanel()}
  </section>

  <section id="tab-lineups" class="hidden" aria-label="阵容">
    ${lineupsPage()}
  </section>

  <section id="tab-inventory" class="hidden">
    ${inventoryPage()}
  </section>

  <section id="tab-heroes" class="hidden">
    ${heroesPage()}
  </section>

  <section id="tab-activities" class="hidden">
    ${activitiesPage()}
  </section>

  <section id="tab-guild" class="hidden">${guildPage()}</section>
  <section id="tab-dailies" class="hidden" aria-label="日常任务"><div id="daily-tasks-root"></div></section>
  <section id="tab-shops" class="hidden" aria-label="商店"><div id="shops-root"></div></section>
  <section id="tab-chat" class="hidden" aria-label="聊天"><div id="chat-root"></div></section>
  <section id="tab-items" class="hidden" aria-label="装备与徽章"><div id="items-root"></div></section>

  <section id="tab-giftcodes" class="hidden">
    ${giftCodesPage()}
  </section>
  <section id="tab-season-preview" class="hidden" aria-label="赛季预览"><div id="season-preview-root"></div></section>
  <section id="tab-account" class="hidden">
    ${accountPage()}
  </section>
</main></div>
${journal()}
${dialogs()}
${templates()}

<script>
${consoleStoreScript}
const { consoleStore, stateActions, bindConsoleSlice, patchConsoleSlice, setConsoleValue, mutateConsoleValue, bindConsoleObject } = CWConsoleState.createConsoleRuntime();
window.cwConsoleStore = consoleStore;
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const operationNames = ${JSON.stringify(operationLabels)};

// 游戏操作按顶部账号执行；运行日志独立订阅所有账号并筛选。
let current = null;
let accounts = [];
let stream = null;
let compactLogs = true;
const consoleDraftFormat = ${JSON.stringify({ format: SETTINGS_FORMAT, version: SETTINGS_SCHEMA_VERSION })};

function createConsoleVersionGuard() {
  const version = document.querySelector('meta[name="cw-console-version"]')?.content || '';
  const message = '控制台已更新或重启，当前页面已过期。未保存的草稿已保留；请先下载或复制未保存的修改，再刷新页面。';
  const stops = new Set(['/api/loop/stop','/api/disconnect','/api/stages/stop','/api/pirates/advance/stop',
    '/api/guild/mutual/stop','/api/trials/stop','/api/capture/stop','/api/accounts/alipay-login/cancel','/api/accounts/wechat-login/cancel','/api/accounts/phone-login/cancel']);
  let stale = false;
  const failure = () => Object.assign(new Error(message), { code: 'CLIENT_VERSION_MISMATCH', fields: { revision: message } });
  const allowed = (path, method = 'POST') => ['GET','HEAD','OPTIONS'].includes(String(method).toUpperCase())
    || String(method).toUpperCase() === 'POST' && stops.has(new URL(path || '/', location.href).pathname);
  const reject = () => {
    if (stale) return;
    stale = true;
    window.dispatchEvent(new Event('cw-console-version-stale'));
    showStalePageDialog();
  };
  const observe = value => { if (value && value !== version) reject(); };
  return Object.freeze({ version, message, isStale: () => stale, observe, reject,
    check(response, data) { observe(response?.headers?.get('X-CW-Console-Version')); if (data?.code === 'CLIENT_VERSION_MISMATCH') reject(); return !stale; },
    assertWritable(path, method = 'POST') { if (stale && !allowed(path, method)) throw failure(); },
  });
}

let stalePageReloadRequested = false;
function showStalePageDialog() {
  const dialog = $('console-version-warning'), opener = $('console-version-open');
  const download = $('console-version-download'), accountActions = $('console-version-account');
  const result = $('console-version-result');
  function open() {
    download.hidden = !configHasDraft();
    accountActions.hidden = !current;
    accountActions.open = false;
    result.textContent = '';
    dialog.showModal();
  }
  opener.hidden = false;
  opener.onclick = open;
  $('console-version-dismiss').onclick = () => dialog.close();
  download.onclick = () => configDownloadDraft();
  $('console-version-reload').onclick = () => {
    stalePageReloadRequested = true;
    location.reload();
  };
  for (const [id, route, success] of [
    ['console-version-stop', '/api/loop/stop', '当前账号已停止挂机。'],
    ['console-version-disconnect', '/api/disconnect', '当前账号已断开。'],
  ]) {
    const button = $(id);
    button.onclick = async () => {
      const account = current;
      if (!account || button.disabled) return;
      button.disabled = true;
      result.textContent = '';
      try {
        await call(route, { method: 'POST', body: JSON.stringify({ confirm: true }) });
        if (account === current) result.textContent = success;
        await refreshLoop();
      } catch (error) {
        if (account === current) result.textContent = error.message;
        reportError(error);
      } finally { button.disabled = false; }
    };
  }
  open();
}
window.cwConsoleVersion = createConsoleVersionGuard();

function num(v) {
  if (v == null || typeof v !== 'object') return v;
  return (v.low >>> 0) + (v.high >>> 0) * 4294967296;
}

function fmt(v) {
  const n = num(v);
  if (typeof n !== 'number') return String(n == null ? '-' : n);
  return n.toLocaleString('zh-CN');
}

function when(value) {
  if (!value) return '';
  const timestamp = typeof value === 'number' || /^[0-9]+$/.test(value) ? Number(value) : null;
  if (timestamp !== null && (!Number.isFinite(timestamp) || timestamp <= 0)) return '';
  const date = new Date(timestamp === null ? value : timestamp < 1e11 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

let callsInFlight = 0, callProgressTimer = 0;
function trackCall(delta) {
  callsInFlight += delta;
  if (callsInFlight > 0) {
    if (!callProgressTimer) callProgressTimer = setTimeout(() => { callProgressTimer = 0; if (callsInFlight > 0) document.body.setAttribute('data-loading', ''); }, 400);
    return;
  }
  clearTimeout(callProgressTimer);
  callProgressTimer = 0;
  document.body.removeAttribute('data-loading');
}

async function call(path, options) {
  const opts = { ...options }, method = String(opts.method || 'GET').toUpperCase();
  const versionGuard = window.cwConsoleVersion;
  versionGuard.assertWritable(path, method);
  const headers = new Headers(opts.headers); headers.set('X-CW-Console-Version', versionGuard.version); opts.headers = headers;
  let url = path;
  const params = new URL(path, location.href).searchParams;
  let account = params.get('account');
  if (current && path.startsWith('/api/') && account === null && params.get('scope') !== 'all') {
    account = current;
    url += (url.indexOf('?') < 0 ? '?' : '&') + 'account=' + encodeURIComponent(current);
  }
  trackCall(1);
  try {
    const res = await fetch(url, opts);
    versionGuard.check(res);
    versionGuard.assertWritable(path, method);
    const data = await res.json();
    versionGuard.check(res, data);
    versionGuard.assertWritable(path, method);
    if (!res.ok) {
      const error = new Error(data.error || res.statusText);
      if (data.code) error.code = data.code;
      if (data.fields) error.fields = data.fields;
      if (data.log) appendLog(data.log);
      error.logged = true;
      if (!data.log) reportError(new Error(data.error || ('控制台返回 HTTP ' + res.status)), path, account);
      throw error;
    }
    return data;
  } catch (error) {
    if (method === 'GET' && opts.signal?.aborted) throw error;
    if (!error.logged) reportError(error, path, account);
    error.logged = true;
    throw error;
  } finally {
    trackCall(-1);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  node.textContent = '';
  return node;
}

// ---- 图标 ------------------------------------------------------------------
// 每个图标单独下载缩略图；屏幕外的不加载，取不到时退回名字首字。

function iconEl(entry, size, name) {
  if (!entry?.thumb) {
    const box = el('span', 'ico');
    box.style.width = size + 'px';
    box.style.height = size + 'px';
    box.appendChild(el('span', 'fallback', (name || '?').slice(0, 1)));
    box.title = name || '';
    return box;
  }
  const k = size / Math.max(entry.w, entry.h);
  const img = el('img', 'ico');
  img.width = Math.max(1, Math.round(entry.w * k));
  img.height = Math.max(1, Math.round(entry.h * k));
  img.alt = '';
  img.title = name || '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => img.replaceWith(iconEl(null, size, name));
  img.src = entry.thumb;
  return img;
}

// 一项东西：图标 + 名字 + 数量
function cell(entry, size, name, qty, showPlaceholder = true) {
  const node = el('div', 'cell');
  if (entry || showPlaceholder) node.appendChild(iconEl(entry, size || 34, name));
  const txt = el('div', 'txt');
  txt.appendChild(el('span', 'nm', name || '?'));
  if (qty != null) txt.appendChild(el('span', 'qty', qty));
  node.appendChild(txt);
  return node;
}

function component(id) {
  return $(id).content.firstElementChild.cloneNode(true);
}
function smallButton(label, danger = false) {
  const button = component(danger ? 'ui-delete' : 'ui-button');
  button.textContent = label;
  return button;
}
function chip(status, text) {
  const badge = component('ui-badge');
  badge.classList.add('chip', status);
  badge.textContent = text;
  return badge;
}

// ---- 弹窗 ------------------------------------------------------------------
function closeModal() {
  $('modal').close();
  $('m-ok').onclick = null;
}
function openConfirm(title, bodyNodes, onOk, okLabel = '确认') {
  $('m-title').textContent = title;
  $('m-ok').textContent = okLabel;
  $('m-ok').disabled = false;
  const body = clear($('m-body'));
  for (const node of bodyNodes) body.appendChild(node);
  $('m-ok').onclick = async () => {
    const run = onOk;
    closeModal();
    try {
      await run();
    } catch (error) {
      reportError(error);
    }
  };
  $('modal').showModal();
  $('m-cancel').focus();
}
$('m-cancel').onclick = closeModal;
$('modal').oncancel = event => { event.preventDefault(); closeModal(); };

function accountDialog(title, message, value) {
  const dialog = $('account-dialog'), input = $('account-label-input');
  $('account-title').textContent = title;
  $('account-message').textContent = message;
  input.hidden = value === undefined;
  input.value = value ?? '';
  dialog.returnValue = '';
  dialog.showModal();
  if (!input.hidden) input.select();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value : null), { once: true });
  });
}

// ---- 运行记录 --------------------------------------------------------------
const seen = new Set();
const logTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const logCategories = ${JSON.stringify(LOG_CATEGORIES)};
const logGroups = ${JSON.stringify(LOG_GROUPS)};
const logGroupTones = ${JSON.stringify(LOG_GROUP_TONES)};
const groupByLogCategory = new Map(Object.entries(logGroups).flatMap(([group, keys]) => keys.map(key => [key, group])));
const createLogAccountLabels = ${createLogAccountLabels.toString()};
let logAccount = 'all';
let logGroup = 'all';
let logFeature = 'all';
let onlyIssues = false;
consoleStore.subscribe((state, previous) => {
  if (state.view === previous.view) return;
  logAccount = state.view.logAccount;
  logGroup = state.view.logGroup;
  logFeature = state.view.logFeature;
  onlyIssues = state.view.onlyIssues;
});
let logReturnFocus;
function openJournal() {
  if ($('journal-dialog').open) return;
  closeHelpTip(false); logReturnFocus = document.activeElement;
  updateLogSummary();
  document.body.classList.add('has-log-dialog'); $('journal-dialog').showModal();
  const selectedAccount = $('log-account-tabs').querySelector('[aria-pressed=true]');
  selectedAccount.focus({ preventScroll: true });
  revealLogTag(selectedAccount); revealLogTag($('log-tabs').querySelector('[aria-selected=true]'));
}
$('logs-open').onclick = openJournal;
$('logs-close').onclick = () => $('journal-dialog').close();
$('journal-dialog').addEventListener('close', () => { document.body.classList.remove('has-log-dialog'); (logReturnFocus?.isConnected ? logReturnFocus : $('logs-open')).focus(); });
const featureBar = $('log-tabs');
function revealHorizontalTab(button) {
  const container = button.parentElement, left = button.offsetLeft - 3, right = button.offsetLeft + button.offsetWidth + 3;
  if (left < container.scrollLeft) container.scrollLeft = left;
  else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth;
}
function revealLogTag(button) {
  const container = button.parentElement;
  const top = button.offsetTop - 3, bottom = button.offsetTop + button.offsetHeight + 3;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
}
function selectLogFeature(key) {
  stateActions.setView({ logFeature: key });
  const selected = featureBar.querySelector('[aria-selected=true]');
  if (selected) revealLogTag(selected);
}
$('log-group').onchange = event => {
  stateActions.setView({ logGroup: event.target.value, logFeature: 'all' });
  featureBar.scrollTop = 0;
};
function selectLogAccount(id) {
  stateActions.setView({ logAccount: id });
  updateLogSummary();
  revealLogTag($('log-account-tabs').querySelector('[aria-pressed=true]'));
}
$('log-account-tabs').onkeydown = event => {
  const buttons = [...$('log-account-tabs').querySelectorAll('[data-log-account]')];
  const index = buttons.indexOf(event.target.closest('[data-log-account]'));
  if (index < 0) return;
  const next = { ArrowRight: (index + 1) % buttons.length, ArrowLeft: (index + buttons.length - 1) % buttons.length, Home: 0, End: buttons.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault(); selectLogAccount(buttons[next].dataset.logAccount); buttons[next].focus({ preventScroll: true });
};
featureBar.onclick = event => {
  const tab = event.target.closest('[role=tab]');
  if (tab) selectLogFeature(tab.dataset.logFeature);
};
featureBar.onkeydown = event => {
  const tabs = [...featureBar.children];
  const index = tabs.indexOf(event.target.closest('[role=tab]'));
  if (index < 0) return;
  const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault(); selectLogFeature(tabs[next].dataset.logFeature); tabs[next].focus({ preventScroll: true });
};
const logClearWatermarks = new Map();
const logAccountNames = new Map();
let logClearing = false;
function logAccountLabel(id) {
  if (!id) return '系统';
  for (const [key, name] of createLogAccountLabels(accounts)) logAccountNames.set(key, name);
  return logAccountNames.get(id) || '已移除账号';
}
function paintLogAccount(badge, id) {
  const label = logAccountLabel(id);
  badge.querySelector('.log-account-name').textContent = label;
  badge.title = id ? label + ' · ' + id : '控制台系统日志';
  badge.setAttribute('aria-label', '筛选账号：' + label);
  badge.dataset.tone = 'neutral';
}
function updateLogAccounts() {
  const ids = new Set(accounts.map(account => account.id));
  for (const row of logEl.children) if (row.dataset.account) ids.add(row.dataset.account);
  if (logAccount !== 'all') ids.add(logAccount);
  const options = [['all', '全部'], ...[...ids].map(id => [id, logAccountLabel(id)])];
  const signature = JSON.stringify(options);
  const container = $('log-account-tabs');
  if (container.dataset.options === signature) return;
  const existing = new Map([...container.children].map(button => [button.dataset.logAccount, button]));
  for (const [index, [id, label]] of options.entries()) {
    const button = existing.get(id) || component('ui-log-account-filter');
    existing.delete(id);
    button.dataset.logAccount = id;
    button.querySelector('[data-log-account-name]').textContent = label;
    button.title = id === 'all' ? '查看全部账号与系统记录' : label;
    button.onclick = () => selectLogAccount(id);
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
  }
  for (const button of existing.values()) button.remove();
  container.dataset.options = signature;
  for (const row of logEl.children) {
    const badge = row.querySelector('.log-account');
    if (badge) paintLogAccount(badge, row.dataset.account);
  }
}
function clearedLog(entry) {
  return ['all', entry.account].some(key => {
    const watermark = logClearWatermarks.get(key);
    return watermark && (entry.id ? entry.id <= watermark.before : entry.t <= watermark.at);
  });
}
let guildRefreshTimer;
const featureOrder = new Intl.Collator('zh-CN', { numeric: true });
function updateFeatureTabs(features, counts) {
  const existing = new Map([...featureBar.children].map(tab => [tab.dataset.logFeature, tab]));
  if (logFeature !== 'all' && !features.has(logFeature) && existing.has(logFeature)) {
    const tab = existing.get(logFeature);
    features.set(logFeature, { key: logFeature, label: tab.firstElementChild.textContent, tone: tab.dataset.tone });
  }
  const sorted = [...features.values()].sort((a,b) => featureOrder.compare(a.label, b.label) || a.key.localeCompare(b.key));
  const options = [{ key: 'all', label: '全部', tone: 'neutral' }, ...sorted];
  for (const [index, { key, label, tone }] of options.entries()) {
    const tab = existing.get(key) || featureBar.firstElementChild.cloneNode(true);
    existing.delete(key);
    tab.id = 'log-tab-' + key;
    tab.dataset.logFeature = key;
    tab.dataset.tone = tone;
    if (tab.firstElementChild.textContent !== label) tab.firstElementChild.textContent = label;
    const value = String(counts.get(key) || 0);
    if (tab.lastElementChild.textContent !== value) tab.lastElementChild.textContent = value;
    const selected = key === logFeature;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (selected) $('log-panel').setAttribute('aria-labelledby', tab.id);
    if (featureBar.children[index] !== tab) featureBar.insertBefore(tab, featureBar.children[index] || null);
  }
  for (const tab of existing.values()) tab.remove();
}
function updateLogSummary() {
  updateLogAccounts();
  let count = 0;
  const groupCounts = { all: 0 };
  const featureCounts = new Map();
  const availableFeatures = new Map();
  const accountCounts = new Map([['all', 0]]);
  for (const row of logEl.children) {
    const accountMatches = logAccount === 'all' || row.dataset.account === logAccount;
    const levelMatches = !onlyIssues || row.classList.contains('error') || row.classList.contains('warn');
    const group = groupByLogCategory.get(row.dataset.category);
    const groupMatches = logGroup === 'all' || group === logGroup;
    const feature = row.dataset.feature;
    const featureMatches = logFeature === 'all' || logFeature === feature;
    if (groupMatches && (accountMatches || logFeature === feature)) {
      availableFeatures.set(feature, { key: feature, label: row.dataset.featureLabel, tone: logGroupTones[group] || 'neutral' });
    }
    if (accountMatches && levelMatches) { groupCounts.all++; if (group) groupCounts[group] = (groupCounts[group] || 0) + 1; }
    if (groupMatches && levelMatches && accountMatches) {
      featureCounts.set('all', (featureCounts.get('all') || 0) + 1);
      featureCounts.set(feature, (featureCounts.get(feature) || 0) + 1);
    }
    if (groupMatches && levelMatches && featureMatches) {
      accountCounts.set('all', accountCounts.get('all') + 1);
      if (row.dataset.account) accountCounts.set(row.dataset.account, (accountCounts.get(row.dataset.account) || 0) + 1);
    }
    row.hidden = !accountMatches || !levelMatches || !groupMatches || !featureMatches;
    if (!row.hidden) count++;
  }
  for (const button of $('log-account-tabs').children) {
    const selected = button.dataset.logAccount === logAccount;
    button.setAttribute('aria-pressed', String(selected)); button.tabIndex = selected ? 0 : -1;
    const counter = button.querySelector('[data-log-account-count]');
    const value = String(accountCounts.get(button.dataset.logAccount) || 0);
    if (counter.textContent !== value) counter.textContent = value;
  }
  updateFeatureTabs(availableFeatures, featureCounts);
  const groupSelect = $('log-group');
  if (groupSelect.value !== logGroup) groupSelect.value = logGroup;
  for (const option of groupSelect.options) {
    const label = (option.value === 'all' ? '全部分类' : option.value) + ' · ' + (groupCounts[option.value] || 0);
    if (option.textContent !== label) option.textContent = label;
  }
  const clearButton = $('log-clear');
  clearButton.disabled = logClearing || (logAccount !== 'all' && !accounts.some(item => item.id === logAccount));
  const clearLabel = logAccount === 'all' ? '清空全部账号和系统的运行日志' : '清空“' + logAccountLabel(logAccount) + '”的运行日志';
  clearButton.title = clearLabel + '（包含被筛选隐藏的记录）';
  clearButton.setAttribute('aria-label', clearLabel);
  $('log-top-count').textContent = logEl.children.length;
  $('log-count').textContent = String(count);
  $('log-empty').hidden = logEl.childElementCount > 0 || logAccount !== 'all' || logGroup !== 'all' || logFeature !== 'all' || onlyIssues;
}
function createLogRow(entry) {
  const row = el('div', 'row ' + entry.level);
  row.dataset.category = entry.category || 'system';
  row.dataset.feature = entry.feature ? 'task-' + entry.feature.key : row.dataset.category;
  row.dataset.featureLabel = entry.feature?.label || logCategories[row.dataset.category] || logCategories.system;
  row.dataset.account = entry.account || '';
  if (entry.rowId) row.dataset.rowId = String(entry.rowId);
  if (entry.extra?.batch) row.dataset.batch = entry.extra.batch;
  if (entry.extra?.waitKey) row.dataset.waitKey = entry.extra.waitKey;
  const body = el('div', 'log-body');
  const meta = el('div', 'log-meta');
  const accountBadge = component(entry.account ? 'ui-log-account' : 'ui-log-badge');
  if (entry.account) {
    paintLogAccount(accountBadge, entry.account);
    accountBadge.onclick = () => selectLogAccount(entry.account);
  } else {
    accountBadge.textContent = '系统'; accountBadge.dataset.tone = 'neutral'; accountBadge.classList.add('log-system-tag');
    accountBadge.title = '控制台系统日志';
  }
  const categoryBadge = el('button', 'log-tag log-category-tag', row.dataset.featureLabel);
  categoryBadge.type = 'button';
  categoryBadge.title = '筛选功能：' + row.dataset.featureLabel;
  categoryBadge.setAttribute('aria-label', categoryBadge.title);
  categoryBadge.onclick = () => selectLogFeature(row.dataset.feature);
  const group = groupByLogCategory.get(row.dataset.category);
  categoryBadge.dataset.tone = logGroupTones[group] || 'neutral';
  meta.append(el('time', 'ts'), accountBadge, categoryBadge);
  const levelName = { error: '错误', warn: '警告' }[entry.level];
  if (levelName) {
    const badge = component('ui-log-badge'); badge.classList.add('log-level-tag');
    badge.dataset.tone = entry.level === 'error' ? 'error' : 'warning'; badge.textContent = levelName;
    meta.appendChild(badge);
  }
  body.append(meta, el('span', 'log-message'));
  row.appendChild(body);
  return row;
}
function appendLog(entry) {
  if (clearedLog(entry) || entry.id && seen.has(entry.id)) return;
  const previous = entry.rowId && [...logEl.children].find(row => row.dataset.rowId === String(entry.rowId));
  if (previous && previous.logEntry.id >= entry.id) return;
  if (entry.reuseDetail) {
    if (!previous) {
      // A busy all-account view may have evicted this row. Replay the bounded snapshots once.
      compactLogs = false;
      stream?.close(); stream = null; subscribe(); return;
    }
    entry.detail = previous.logEntry.detail;
  }
  if (entry.id) seen.add(entry.id);
  if (entry.account && entry.accountName) logAccountNames.set(entry.account, entry.accountName);
  const atTop = logEl.scrollTop < 30;
  const anchor = [...logEl.children].find(row => !row.hidden && row.getBoundingClientRect().bottom > logEl.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const reuse = previous && previous.logEntry.level === entry.level && previous.logEntry.category === entry.category
    && previous.logEntry.feature?.key === entry.feature?.key;
  const row = reuse ? previous : createLogRow(entry);
  const wasOpen = previous && previous.querySelector('details')?.open;
  if (previous) {
    seen.delete(previous.logEntry.id);
    if (!reuse) previous.remove();
  }
  row.logEntry = entry;
  row.querySelector('time').textContent = logTime.format(entry.t);
  const repeats = entry.extra?.waitKey && entry.count > 1 ? '（累计 '+entry.count+' 次，时间为最后检查）' : '';
  row.querySelector('.log-message').textContent = entry.message + repeats;
  let details = row.querySelector('details');
  if (entry.detail) {
    if (!details) {
      details = el('details', 'log-details');
      details.open = !!wasOpen;
      details.append(el('summary'), el('div', 'log-detail-text'));
      row.querySelector('.log-body').appendChild(details);
    }
    details.querySelector('summary').textContent = entry.extra?.detailLabel || (entry.extra?.batch ? '查看逐次排产' : '查看详情');
    const detailText = details.querySelector('.log-detail-text');
    if (detailText.textContent !== entry.detail) detailText.textContent = entry.detail;
  } else details?.remove();
  const next = [...logEl.children].find(item => item !== row && (entry.t > item.logEntry.t ||
    entry.t === item.logEntry.t && (entry.id || Infinity) > (item.logEntry.id || 0)));
  if (!row.isConnected || row.nextElementSibling !== (next || null)) logEl.insertBefore(row, next || null);
  while (logEl.childElementCount > 400) {
    seen.delete(logEl.lastChild.logEntry.id);
    logEl.lastChild.remove();
  }
  updateLogSummary();
  if (atTop) logEl.scrollTop = 0;
  else if (anchor) {
    const visibleAnchor = anchor === previous ? row : anchor;
    if (visibleAnchor.isConnected) logEl.scrollTop += visibleAnchor.getBoundingClientRect().top - anchorTop;
  }
}
function clearLogBefore(data) {
  const key = data.scope === 'all' ? 'all' : data.account;
  if (!key) return;
  const previous = logClearWatermarks.get(key);
  logClearWatermarks.set(key, { before: Math.max(previous?.before || 0, data.before || 0), at: Math.max(previous?.at || 0, data.at || 0) });
  for (const row of [...logEl.children]) {
    if (clearedLog(row.logEntry)) {
      seen.delete(row.logEntry.id);
      row.remove();
    }
  }
  updateLogSummary();
}
$('log-clear').onclick = async () => {
  if ($('log-clear').disabled) return;
  const account = logAccount === 'all' ? null : logAccount;
  const query = account === null ? 'scope=all' : 'account=' + encodeURIComponent(account);
  logClearing = true; updateLogSummary();
  try {
    const data = await call('/api/logs/clear?' + query, { method: 'POST', body: JSON.stringify({ confirm: true }) });
    clearLogBefore(data);
  } catch (error) { reportError(error, undefined, account); }
  finally { logClearing = false; updateLogSummary(); }
};
function reportError(error, context, account = current) {
  if (error?.logged) return;
  const api = context?.startsWith('/api/');
  const action = api ? operationNames[context.split('?')[0]] || '控制台操作' : context;
  const raw = error?.message || String(error);
  const reason = raw === 'Failed to fetch' ? '无法连接本地控制台，请检查控制台是否仍在运行' : raw;
  appendLog({ t: Date.now(), account, level: 'error', message: (action ? action + '失败：' : '') + reason,
    detail: api ? context + ' · ' + raw : undefined });
  if (error instanceof Error) error.logged = true;
}
window.addEventListener('unhandledrejection', (event) => { reportError(event.reason); event.preventDefault(); });
for (const [id, filtered] of [['log-all', false], ['log-issues', true]]) {
  $(id).onclick = () => {
    stateActions.setView({ onlyIssues: filtered });
    $('journal').classList.toggle('issues', filtered);
    $('log-all').setAttribute('aria-pressed', String(!filtered));
    $('log-issues').setAttribute('aria-pressed', String(filtered));
    updateLogSummary();
  };
}
function subscribe() {
  updateLogSummary();
  if (stream) return;
  stream = new EventSource('/api/events?scope=all' + (compactLogs ? '&compact=1' : ''));
  stream.addEventListener('logs-cleared', event => clearLogBefore(JSON.parse(event.data)));
  stream.addEventListener('fleets-changed', event => {
    if (JSON.parse(event.data).account === current) worldMapRefreshRequested = true;
  });
  stream.addEventListener('player-names-changed', event => {
    const { account, playerNames } = JSON.parse(event.data);
    if (account !== current || account !== configEditor.owner || !configEditor.data) return;
    configEditor.data.playerNames = { ...configEditor.data.playerNames, ...playerNames };
    for (const widget of configEditor.widgets.values()) widget.nameHistory?.paint();
  });
  stream.addEventListener('chat-changed', event => {
    const detail = JSON.parse(event.data);
    if (detail.account === current) window.dispatchEvent(new CustomEvent('cw-chat-update', { detail }));
  });
  stream.addEventListener('open', () => window.dispatchEvent(new Event('cw-chat-update')));
  stream.addEventListener('lineup-changed', event => {
    const { account } = JSON.parse(event.data);
    if (account === current) void refreshSavedLineups();
  });
  stream.addEventListener('guild-aid-changed', event => {
    const account = JSON.parse(event.data).account;
    if (account !== current) return;
    clearTimeout(guildRefreshTimer);
    guildRefreshTimer = setTimeout(() => {
      if (account === current && !snapshot.paused && !$('tab-guild').classList.contains('hidden')) {
        void refreshProgression('guild');
      }
    }, 300);
  });
  stream.onmessage = (event) => {
    const entry = JSON.parse(event.data);
    appendLog(entry);
    if ((entry.extra?.pauseChanged || entry.extra?.loginBlocked) && entry.account === current) void loadAccounts(false);
    if (entry.extra?.worldUpdated && entry.account === current && Date.now() - entry.t < 10_000) refreshManualWorld();
    if (entry.extra?.lineupChanged && entry.account === current && Date.now() - entry.t < 10_000) void refreshSavedLineups();
  };
}

// ---- 账号 ------------------------------------------------------------------
let snapshot = { connected: false, state: 'IDLE', busy: null, looping: false };
let disconnected = new Set();
let connectingAccounts = new Set();
let hostingActions = new Set();
let accountStatusRevision = 0;
let accountStatusPending = null;
let accountsLoading = 0;
let accountLoadVersion = 0;
let accountSelectionVersion = 0;

function syncAccountState(state) {
  current = state.currentAccountId;
  accounts = CWConsoleState.selectAccounts(state);
  snapshot = CWConsoleState.selectCurrentStatus(state);
  disconnected = state.disconnected;
  connectingAccounts = state.connecting;
  hostingActions = state.hosting;
}
consoleStore.subscribe((state, previous) => {
  if (state.accountsById !== previous.accountsById || state.accountIds !== previous.accountIds
      || state.currentAccountId !== previous.currentAccountId || state.disconnected !== previous.disconnected
      || state.connecting !== previous.connecting || state.hosting !== previous.hosting) syncAccountState(state);
});
syncAccountState(consoleStore.getState());

function connectionStatus(status = {}) {
  status = status ?? {};
  if (status.syncingProduction) return '正在同步生产状态';
  if (status.paused) return '已暂停 · 可自行上号';
  if (status.reconnecting) {
    if (status.loginRecovery?.status === 'connecting') return '异地登录 · 正在自动重连';
    const nextAttemptAt = status.loginRecovery?.nextAttemptAt;
    if (!Number.isFinite(nextAttemptAt)) return '异地登录 · 等待重连';
    const seconds = Math.max(0, Math.ceil((nextAttemptAt - Date.now()) / 1000));
    return '异地登录 · ' + seconds + ' 秒后重试';
  }
  if (status.loginBlocked) return '异地登录 · 等待恢复托管';
  if (status.loopStopping) return '暂停中…';
  if (status.connected) return status.looping ? '挂机中' : '已连接 · 未挂机';
  if (status.state === 'CONNECTING') return '连接中…';
  return status.looping ? '挂机中 · 等待连接' : '未连接';
}

function connectionStatusKind(status = {}, connecting = false) {
  status = status ?? {};
  return status.paused || status.loginBlocked || status.reconnecting || status.syncingProduction
    || status.loopStopping || connecting || status.state === 'CONNECTING' || (status.looping && !status.connected)
    ? 'waiting' : status.connected ? 'done' : 'blocked';
}

function renderAccountOptions() {
  const box = $('account');
  const choices = accounts.length ? accounts.map(account => {
    const status = account.id === current ? snapshot : account.status;
    const text = connectingAccounts.has(account.id) ? '连接中…' : connectionStatus(status);
    return [account.id, '[' + text + '] ' + account.title];
  }) : [['', '没有账号']];
  if (box.options.length !== choices.length || choices.some(([id], index) => box.options[index]?.value !== id)) {
    box.replaceChildren(...choices.map(([id, text]) => new Option(text, id)));
  } else {
    choices.forEach(([, text], index) => {
      if (box.options[index].text !== text) box.options[index].text = text;
    });
  }
  box.disabled = !accounts.length;
  if (box.value !== (current || '')) box.value = current || '';
}

function setBusy(text) {
  const announcement = current ? text : '没有账号';
  if ($('busy').textContent !== announcement) $('busy').textContent = announcement;
  const account = accounts.find(row => row.id === current);
  const option = Array.from($('account').options).find(row => row.value === current);
  if (account && option) {
    const label = '[' + text + '] ' + account.title;
    if (option.text !== label) option.text = label;
  }
  $('account').title = option?.text || '选择账号并查看状态';
  if (typeof renderAccountPicker === 'function') renderAccountPicker(text);
}

function paintConnection() {
  renderAccountOptions();
  setBusy(connectingAccounts.has(current) ? '连接中…' : connectionStatus(snapshot));
}

function setAccountStatus(account, status) {
  accountStatusRevision++;
  stateActions.setStatus(account, status);
  paintConnection();
}

function refreshAccountStatuses() {
  if (document.hidden || !accounts.length || accountsLoading || accountStatusPending) return accountStatusPending;
  const revision = accountStatusRevision;
  accountStatusPending = (async () => {
    try {
      const data = await call('/api/accounts');
      if (revision !== accountStatusRevision) return;
      accountStatusRevision++;
      stateActions.mergeStatuses(data.accounts);
      renderAccountSelect();
      if (!$('tab-account').classList.contains('hidden')) refreshAccountCards();
    } catch {
      /* call 已记录错误，下次刷新继续读取。 */
    } finally {
      accountStatusPending = null;
    }
  })();
  return accountStatusPending;
}

let accountDetailsOwner=null;
function renderHostingControl() {
  const resume = snapshot.paused || (snapshot.loginBlocked && !snapshot.reconnecting);
  const running = snapshot.looping || snapshot.reconnecting;
  const hosting = running || snapshot.connected || snapshot.state === 'CONNECTING' || connectingAccounts.has(current);
  const pending = !current || hostingActions.has(current);
  $('loop-toggle').disabled = pending || !!snapshot.paused || !!snapshot.loopStopping || (!running && loopAccount !== current);
  $('loop-toggle').textContent = snapshot.loopStopping ? '暂停中…' : running ? '暂停挂机' : '开始挂机';
  $('loop-toggle').title = snapshot.paused ? '请先恢复托管' : running ? '停止自动循环，保留游戏连接和手动操作' : '按已保存的任务持续挂机，直到手动暂停';
  $('account-pause').disabled = pending || ((resume || !hosting) && (!!snapshot.loopStopping || loopAccount !== current));
  const switchRole = snapshot.paused && accounts.find(account => account.id === current)?.hasSiblingRoles;
  $('account-pause').textContent = switchRole ? '切换并托管' : resume ? '恢复托管' : hosting ? '暂停托管' : '开始托管';
  $('account-pause').title = resume ? '重新登录游戏并按已保存的任务开始持续托管' : hosting ? '停止任务并断开游戏连接，方便自行上号' : '按已保存的任务开始持续托管';
  if (switchRole) $('account-pause').title = '先暂停同一账号的其他角色，再按本角色的配置开始托管';
}
function renderAccountSelect() {
  if(accountDetailsOwner!==current){
    accountSelectionVersion++;
    accountDetailsOwner=current;
  }
  if(worldMapOwner!==null&&worldMapOwner!==current)resetWorldMap();
  siliconAccountChanged();
  resourceFieldsAccountChanged();
  const planReady = current && snapshot.connected && !snapshot.syncingProduction && !snapshot.paused && !disconnected.has(current);
  if (productionPlanOwner !== null && (productionPlanOwner !== current || !planReady)) resetProductionPlan();
  $('production-plan-refresh').disabled = productionPlanBusy || !planReady;
  if (productionPlanOwner === null) {
    $('production-plan-status').textContent = snapshot.syncingProduction ? '正在同步生产状态' : planReady ? '' : '连接账号后自动加载';
    if (consoleStore.getState().view.page === 'manual') void refreshProductionPlan();
  }
  renderHostingControl();
  paintConnection();
  $('connect').disabled = snapshot.paused || snapshot.reconnecting || snapshot.connected || connectingAccounts.has(current) || !accounts.length;
  $('connect').hidden = !current || snapshot.connected || snapshot.paused || snapshot.reconnecting || snapshot.loginBlocked;
  if (!$('tab-account').classList.contains('hidden')) renderAccounts();
}

async function loadAccounts(reload, readOverview = true) {
  const version = ++accountLoadVersion;
  const revision = ++accountStatusRevision;
  accountsLoading++;
  let data;
  try {
    data = await call('/api/accounts');
  } finally {
    accountsLoading--;
  }
  if (version !== accountLoadVersion) return;
  const preserveStatus = revision !== accountStatusRevision;
  accountStatusRevision++;
  const previous = current;
  stateActions.replaceAccounts(data.accounts, data.activeId, { preserveStatus });
  if ($('journal-dialog').open) updateLogSummary();
  renderAccountSelect();
  if (previous !== current || reload) refreshProgression();
  if (previous !== current || reload) void refreshSavedLineups();
  if (previous !== current) refreshManualWorld();
  if (previous !== current) {configAccountChanged();giftAccountChanged();}
  if (reload) {
    subscribe();
    if (readOverview) refreshOverview();
  }
}

function selectLoadedAccount(next) {
  accountSelectionVersion++;
  if (!stateActions.selectAccount(next)) return;
  giftAccountChanged();
  configAccountChanged();
  renderAccountSelect();
  refreshProgression();
  void refreshSavedLineups();
  refreshManualWorld();
  refreshActivities();
  refreshStages();
  refreshLoop();
  subscribe();
  refreshOverview();
}

$('account').onchange = async () => {
  const version = ++accountSelectionVersion;
  const next = $('account').value;
  const allowed = await configMayChangeAccount(next);
  if (version !== accountSelectionVersion) return;
  if (!allowed) { $('account').value = current || ''; return; }
  selectLoadedAccount(next);
  await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id: next }) });
};
$('account-pause').onclick = async () => {
  const account = current;
  if (!account || $('account-pause').disabled) return;
  const paused = !snapshot.paused && !(snapshot.loginBlocked && !snapshot.reconnecting)
    && !!(snapshot.looping || snapshot.reconnecting || snapshot.connected || snapshot.state === 'CONNECTING' || connectingAccounts.has(account));
  stateActions.setFlag('hosting', account, true);
  accountStatusRevision++;
  loopVersion++;
  renderHostingControl();
  try {
    if (!paused) {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (current !== account || !await saveLoopInterval()) return;
    }
    if (current !== account) return;
    const status = await call('/api/accounts/pause', { method: 'POST', body: JSON.stringify(paused ? { paused: true } : { paused: false, start: true, confirm: true }) });
    if (current === account) loopVersion++;
    setAccountStatus(account, status);
    if (!status.paused) stateActions.setFlag('disconnected', account, false);
    if (current !== account) return;
    renderAccountSelect();
    refreshProgression();
    refreshManualWorld();
    refreshOverview();
    refreshLoop();
    refreshActivities();
  } catch (error) {
    if (current === account) reportError(error);
  } finally {
    stateActions.setFlag('hosting', account, false);
    if (current === account) {
      renderAccountSelect();
      refreshAccountStatuses();
      refreshLoop();
    }
  }
};

$('loop-toggle').onclick = async () => {
  const account = current;
  if (!account || $('loop-toggle').disabled) return;
  const stop = !!(snapshot.looping || snapshot.reconnecting);
  stateActions.setFlag('hosting', account, true);
  accountStatusRevision++;
  loopVersion++;
  renderHostingControl();
  try {
    if (!stop) {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (current !== account || !await saveLoopInterval()) return;
    }
    if (current !== account) return;
    const data = await call('/api/loop/' + (stop ? 'stop' : 'start'), {
      method: 'POST', body: JSON.stringify({ confirm: true }),
    });
    if (current === account) loopVersion++;
    setAccountStatus(account, data.status);
    if (!stop) stateActions.setFlag('disconnected', account, false);
    if (current !== account) return;
    renderAccountSelect();
    refreshStages();
    refreshProgression();
  } catch (error) {
    if (current === account) reportError(error);
  } finally {
    stateActions.setFlag('hosting', account, false);
    if (current === account) {
      renderAccountSelect();
      refreshAccountStatuses();
      refreshLoop();
    }
  }
};

$('connect').onclick = () => connectAccount(current);
async function connectAccount(account) {
  if (!account || connectingAccounts.has(account)) return;
  accountStatusRevision++;
  stateActions.setFlag('connecting', account, true);
  renderAccountSelect();
  try {
    await call(account === current ? '/api/connect' : '/api/connect?account=' + encodeURIComponent(account), { method: 'POST' });
    stateActions.setFlag('disconnected', account, false);
    const status = accounts.find(row => row.id === account)?.status ?? {};
    setAccountStatus(account, { ...status, connected: true, state: 'READY', loginBlocked: false, reconnecting: false });
    if (account !== current) return;
    refreshManualWorld();
    refreshProgression();
    refreshOverview();
  } catch (error) {
    reportError(error);
  } finally {
    accountStatusRevision++;
    stateActions.setFlag('connecting', account, false);
    renderAccountSelect();
    void refreshAccountStatuses();
  }
}
// ---- 总览 ------------------------------------------------------------------
let overviewPending = null;
async function refreshOverview() {
  if (!$('tab-account').classList.contains('hidden')) return refreshAccountCards();
  if (!current || overviewPending?.account === current || snapshot.paused || snapshot.loginBlocked || disconnected.has(current) || document.hidden) return;
  if ($('tab-overview').classList.contains('hidden') && $('tab-heroes').classList.contains('hidden')) return;
  const account = current;
  const statusRevision = accountStatusRevision;
  const request = { account };
  overviewPending = request;
  if (!snapshot.connected) setBusy('连接中…');
  try {
    const data = await call('/api/overview');
    if (overviewPending !== request || account !== current || snapshot.paused || disconnected.has(account)) return;
    if (statusRevision === accountStatusRevision) setAccountStatus(account, data.status);
    else data.status = snapshot;
    stateActions.setGameData(account, 'overview', data);
    renderAccountSelect();
    if(!$('tab-overview').classList.contains('hidden'))maybeRefreshWorldMap();
    maybeRefreshSilicon();
    paintConnection();
  } catch (error) {
    reportError(error, '刷新总览');
    paintConnection();
  } finally { if (overviewPending === request) overviewPending = null; }
}


// ---- 挂机 ------------------------------------------------------------------
const HERO_STATUS = { ready: '可做', done: '已完成', blocked: '不可做' };

let stageVersion = 0;
let stageAccount = null;
function stagePreferences() {
  return { maxFailures: Number($('stage-failures').value), lineupId: selectedLineupId('mainline') };
}
function renderStages(data) {
  stateActions.setGameData(current, 'stages', data);
  $('stage-start').disabled = data.running || !current;
  $('stage-stop').disabled = !data.running || data.stopping;
  $('stage-failures').disabled = data.running;
  const lineupControl = $('stage-lineup-control');
  let lineupSelect = lineupControl.querySelector('select');
  if (!lineupSelect || lineupSelect.dataset.lineupAccount !== current) {
    lineupSelect?.remove();
    lineupControl.querySelector('button')?.remove();
    lineupControl.querySelector('[data-lineup-choice-status]')?.remove();
    lineupSelect = createLineupSelect(current, 'mainline');
    lineupControl.appendChild(lineupSelect);
    lineupControl.appendChild(createLineupPreviewButton(current, lineupSelect));
    lineupControl.appendChild(createLineupChoiceStatus(current));
  }
  lineupSelect.disabled = data.running || !current;
  if (data.running) $('stage-failures').value = data.maxFailures;
  const details = data.stage ? '第 ' + data.stage + ' 关 · 已过 ' + data.wins + ' 关 · 连续失败 ' + data.failures + ' 次' : '';
  const lineupPhase = { switching: '正在切换阵容', restoring: '正在恢复原阵容', pending: '阵容待恢复', conflict: '阵容变化待确认' }[data.lineupPhase];
  $('stage-view').textContent = [data.stopping ? '正在停止，等待战报和阵容恢复' : data.running ? '自动挑战中' : data.stage ? '已停止' : '未开启', details, lineupPhase, data.reason==='尚未开启'?'':data.reason].filter(Boolean).join('　');
}
async function refreshStages() {
  if(document.hidden)return;
  if ($('tab-stages').classList.contains('hidden')) return;
  const version = ++stageVersion;
  const account = current;
  if (stageAccount !== account) {
    stageAccount = account;
    const lineupControl = $('stage-lineup-control');
    lineupControl.querySelector('select')?.remove();
    lineupControl.querySelector('button')?.remove();
    lineupControl.querySelector('[data-lineup-choice-status]')?.remove();
    const lineupSelect = createLineupSelect(account, 'mainline');
    lineupSelect.disabled = true;
    lineupControl.appendChild(lineupSelect);
    lineupControl.appendChild(createLineupPreviewButton(account, lineupSelect));
    lineupControl.appendChild(createLineupChoiceStatus(account));
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('stages:' + account)) || {}; } catch {}
    $('stage-failures').value = saved.maxFailures || 3;
    $('stage-start').disabled = $('stage-stop').disabled = true;
    $('stage-view').textContent = '正在读取状态';
  }
  if (!account) { $('stage-view').textContent = '请先选择账号'; return; }
  try {
    const data = await call('/api/stages');
    if (current === account && stageVersion === version) renderStages(data);
  } catch (error) {
    if (current === account && stageVersion === version) { reportError(error); }
  }
}
async function stageCommand(start) {
  const account = current;
  const prefs = stagePreferences();
  if (start && (!Number.isSafeInteger(prefs.maxFailures) || prefs.maxFailures < 1)) {
    reportError(new Error('失败停止次数需要填写正整数'), '主线推关');
    return;
  }
  ++stageVersion;
  $('stage-start').disabled = $('stage-stop').disabled = true;
  try {
    const data = await call('/api/stages/' + (start ? 'start' : 'stop'), {
      method: 'POST', body: JSON.stringify({ confirm: true, ...prefs }),
    });
    if (start) { try { localStorage.setItem('stages:' + account, JSON.stringify({ maxFailures: prefs.maxFailures })); } catch {} }
    if (account === current) renderStages(data);
  } catch (error) {
    if (account === current) { reportError(error); }
  } finally { refreshStages(); }
}
$('stage-start').onclick = () => stageCommand(true);
$('stage-stop').onclick = () => stageCommand(false);

let loopVersion = 0;
let loopAccount = null,loopFieldDefaults=null;
const savingTasks = new Set();
const loopIntervalSaves = new Map();
let loopSettingsRevision = null;
function setTaskSwitch(input, enabled) {
  input.setAttribute('aria-checked', String(enabled));
  input.dataset.state = enabled ? 'checked' : 'unchecked';
  input.querySelector('[data-slot=switch-thumb]').dataset.state = input.dataset.state;
}
const pirateManualMessage=new Map();
const pirateManualPending=new Set();
let pirateManualStatus=null;
const pirateFailureOptions=new Map();
let pirateManualChoices=null;
function setManualPirateChoices(data) {
  pirateManualChoices=data;
  function fill(id, label, rows, key, describe) {
    const select=$(id), previous=select.value;
    select.replaceChildren(new Option('请选择'+label,''));
    for(const row of rows){
      const option=new Option(describe(row)+(row.reason?' · '+row.reason:''),row[key]);
      option.disabled=Boolean(row.reason);
      select.add(option);
      if(!option.disabled && option.value===previous)select.value=previous;
    }
  }
  fill('pirate-manual-target','海盗目标',data?.targets??[],'targetKey',t=>t.name+' '+t.level+' 级 · '+t.location);
  fill('pirate-manual-fleet','出征舰队',data?.fleets??[],'key',f=>f.name+' · 耐久 '+fmt(f.durability)+(f.needsPreset?' · 需选择阵容':' · 战力 '+fmt(f.power)));
  paintManualPirateButtons();
}
function manualPirateSelection() {
  const target=pirateManualChoices?.targets.find(t=>!t.reason && t.targetKey===$('pirate-manual-target').value);
  const fleet=pirateManualChoices?.fleets.find(f=>!f.reason && f.key===$('pirate-manual-fleet').value);
  return {target,fleet};
}
function paintManualPirateButtons() {
  const status=pirateManualStatus?.account===current ? pirateManualStatus.data : null;
  const pending=pirateManualPending.has(current);
  const choices=$('pirate-manual-view');
  const data=pirateManualChoices;
  const ready=current && !snapshot.paused && !disconnected.has(current) && choices.dataset.owner===current && data;
  const locked=!ready || choices.hasAttribute('aria-busy') || pending || status?.running;
  $('pirate-manual-target').disabled=locked || !data.targets.some(t=>!t.reason);
  $('pirate-manual-fleet').disabled=locked || !data.fleets.some(f=>!f.reason);
  const {target,fleet}=manualPirateSelection();
  const lineup=$('pirate-manual-lineup');
  if(lineup.dataset.owner!==current || lineup.lineups!==savedLineupState(current).saved) {
    const previous=lineup.dataset.owner===current ? lineup.value : '';
    lineup.dataset.owner=current || '';
    lineup.lineups=savedLineupState(current).saved;
    fillLineupSelect(lineup,lineup.lineups?.presets || [],previous);
    lineup.options[0].textContent='使用舰队当前阵容';
  }
  const preset=lineup.lineups?.presets?.find(p=>p.id===lineup.value);
  lineup.disabled=locked;
  $('pirate-manual-lineup-view').disabled=!ready || !(lineup.value?preset:fleet);
  $('pirate-manual-once').disabled=$('pirate-advance-start').disabled=locked || !status || !!data.reason || !target || !fleet || ((lineup.value || fleet.needsPreset) && !preset);
  $('pirate-advance-stop').disabled=!status?.running || status.stopping || pending;
}
$('pirate-manual-target').onchange=$('pirate-manual-fleet').onchange=$('pirate-manual-lineup').onchange=paintManualPirateButtons;
$('pirate-manual-lineup-view').onclick=()=>{
  const presetId=$('pirate-manual-lineup').value, {fleet}=manualPirateSelection();
  if(presetId || fleet)void openLineupViewer(current,presetId?{presetId,fleetPreview:true}:{buildingId:fleet.buildingId,fleetName:fleet.name});
};
function renderPirateAdvance(data) {
  if(!data)return;
  pirateManualStatus={account:current,data};
  paintManualPirateButtons();
  $('pirate-manual-failures').disabled=!!data.running;
  $('pirate-manual-interval').disabled=!!data.running;
  if(data.running)$('pirate-manual-failures').value=data.maxFailures;
  if(data.running && data.checkEverySeconds)$('pirate-manual-interval').value=data.checkEverySeconds;
  const state=$('pirate-advance-state');
  state.textContent=pirateManualMessage.get(current) || [data.stopping?'正在停止':data.running?'连续挑战中':'', data.target, data.spent?'首杀 '+data.wins+' 次 · 已用汽油 '+data.spent:'', data.reason].filter(Boolean).join(' · ');
  state.hidden=!state.textContent;
}
async function pirateAdvanceCommand(action) {
  const account=current;
  if(!account || pirateManualPending.has(account))return;
  const payload={confirm:true};
  if(action!=='stop'){
    const {target,fleet}=manualPirateSelection();
    if(!fleet || !target || $('pirate-manual-once').disabled || $('pirate-manual-view').dataset.owner!==account)return;
    payload.targetKey=target.targetKey;
    payload.fleetKey=fleet.key;
    payload.lineupId=$('pirate-manual-lineup').value;
    if(action==='start'){
      if(!$('pirate-manual-failures').reportValidity() || !$('pirate-manual-interval').reportValidity())return;
      payload.type=target.type;
      payload.fleetId=fleet.buildingId;
      payload.maxFailures=Number($('pirate-manual-failures').value);
      payload.checkEverySeconds=Number($('pirate-manual-interval').value);
      pirateFailureOptions.set(account,{failures:payload.maxFailures,interval:payload.checkEverySeconds});
    }
  }
  pirateManualMessage.delete(account);
  pirateManualPending.add(account);
  paintManualPirateButtons();
  try{
    const path=action==='once'?'/api/pirates/hunt':'/api/pirates/advance/'+action;
    const data=await call(path,{method:'POST',body:JSON.stringify(payload)});
    if(action==='once')pirateManualMessage.set(account,data.label);
    else if(account===current)renderPirateAdvance(data);
  } catch(error){
    pirateManualMessage.set(account,error.message);
    if(account===current)reportError(error);
  } finally{
    try {
      if(account===current)await Promise.all([refreshLoop(),refreshProgression('pirate-manual')]);
    } finally {
      pirateManualPending.delete(account);
      paintManualPirateButtons();
    }
  }
}
$('pirate-manual-once').onclick=()=>pirateAdvanceCommand('once');
$('pirate-advance-start').onclick=()=>pirateAdvanceCommand('start');
$('pirate-advance-stop').onclick=()=>pirateAdvanceCommand('stop');
${merchantIntelScript}
${runtimeOverviewScript}
function renderLoop(data) {
  renderAutomationOverview(data);
  if (configEditor.owner === current && configVisible()) {
    configEditor.runtime = data;
    configRenderUsage();
  }
  renderPirateAdvance(data.pirateAdvance);
  loopSettingsRevision = data.settingsRevision;
  if (snapshot.looping !== data.running || snapshot.loopStopping !== data.stopping) accountStatusRevision++;
  stateActions.patchStatus(current, { looping: data.running, loopStopping: data.stopping });
  stateActions.setGameData(current, 'loop', data);
  if (loopAccount !== current || !loopIntervalSaves.has(current) && $('loop-every').value === String(loopFieldDefaults?.seconds)) {
    $('loop-every').value = data.everyMs / 1000;
  }
  loopFieldDefaults={seconds:data.everyMs/1000};
  loopAccount = current;
  renderHostingControl();
  paintConnection();
  if (!$('tab-account').classList.contains('hidden')) renderAccounts();
  $('loop-every').disabled = !current || loopIntervalSaves.has(current);
  $('loop-hint').textContent = (data.recovery ? '网络恢复中（第 ' + data.recovery.attempt + ' 次），已完成 ' : data.running ? '后台挂机中，已完成 ' : '未在挂机，累计 ') + data.completed + ' 轮' + (data.error ? '，已中止' : '');
  if (data.stopping) $('loop-hint').textContent = '正在暂停，等待在途请求结束';
  if (data.settingsRecovery?.required) $('loop-hint').textContent = configRecoveryMessage(data.settingsRecovery, true);
  configSyncRecovery(data);
}

function configLoopPath() {
  return configVisible() && configEditor.owner === current && configEditor.selectedGroups[configEditor.category] === 'progression'
    ? '/api/loop?trials=1' : '/api/loop';
}

let loopReads = 0;
async function refreshLoop() {
  if(document.hidden)return;
  const account = current, version = ++loopVersion;
  if (overviewLoopOwner !== account || !account) resetAutomationOverview(account ? '正在读取运行状态' : '请先选择账号');
  if (loopAccount !== account || !account) {
    $('loop-hint').textContent = account ? '正在读取设置' : '请选择账号';
    loopSettingsRevision = null;
    $('loop-every').disabled = true;
    $('loop-every').value = '';
    $('loop-every').removeAttribute('aria-invalid');
    $('loop-interval-status').textContent = '';
    $('pirate-manual-once').disabled=$('pirate-advance-start').disabled=$('pirate-advance-stop').disabled=true;
    $('pirate-advance-state').textContent=account?'正在读取首杀状态':'请选择账号';
    $('pirate-manual-failures').value=pirateFailureOptions.get(account)?.failures??1;
    $('pirate-manual-interval').value=pirateFailureOptions.get(account)?.interval??15;
  }
  if (!account) return;
  loopReads++;
  try {
    const data = await call(configLoopPath());
    if (account === current && version === loopVersion) renderLoop(data);
  } catch {
    if (account === current && version === loopVersion) {
      resetAutomationOverview('运行状态读取失败，正在等待刷新', false);
      if (configEditor.owner === account && configVisible()) { configEditor.runtime = null; configRenderUsage(); }
    }
  } finally {
    loopReads--;
  }
}

async function toggleAutoTask(input) {
  const account = current, key = input.dataset.autoTask, saving = account + ':' + key;
  if (savingTasks.has(saving)) return;
  const enabled = input.getAttribute('aria-checked') !== 'true';
  savingTasks.add(saving);
  input.disabled = true;
  ++loopVersion;
  try {
    if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
    if (account !== current) return;
    setTaskSwitch(input, enabled);
    const eventTask = Boolean(input.dataset.eventTask);
    if (eventTask) activityTaskEdits.set(saving, { enabled, pending: true, version: ++activitiesVersion });
    const updated = await call(eventTask ? '/api/loop/task' : '/api/loop/control', { method: 'POST', body: JSON.stringify({ confirm: true, key, enabled, ...(eventTask ? {} : { revision: loopSettingsRevision }) }) });
    if (eventTask) { syncActivityTask(key, enabled, account); activityTaskEdits.set(saving, { enabled, pending: false, version: ++activitiesVersion }); }
    // 草稿仍属于当前账号；configLoad 按版本刷新，不能清空 owner 后绕过未保存保护。
    if (account === current) { loopSettingsRevision = updated.settingsRevision; }
  } catch (error) { if (input.dataset.eventTask) activityTaskEdits.delete(saving); if(account===current){setTaskSwitch(input, !enabled); reportError(error);} }
  finally {
    savingTasks.delete(saving);
    if (account === current) {
      if (input.dataset.eventTask) {
        for (const toggle of document.querySelectorAll('[data-event-task]')) {
          if (toggle.dataset.autoTask !== key) continue;
          setTaskSwitch(toggle, input.getAttribute('aria-checked') === 'true');
          toggle.disabled = false;
        }
      }
      else refreshLoop();
    }
  }
}

async function saveLoopInterval() {
  const account = current, input = $('loop-every');
  if (!account || loopAccount !== account) return false;
  if (loopIntervalSaves.has(account)) return loopIntervalSaves.get(account).promise;
  const everySeconds = Number(input.value);
  if (!input.reportValidity() || !Number.isSafeInteger(everySeconds) || everySeconds < 1 || everySeconds > 86400) {
    input.setAttribute('aria-invalid', 'true');
    $('loop-interval-status').textContent = '请输入 1–86400 的整数秒数';
    return false;
  }
  input.removeAttribute('aria-invalid');
  if (everySeconds === loopFieldDefaults?.seconds) return true;
  input.disabled = true;
  $('loop-interval-status').textContent = '正在保存间隔';
  ++loopVersion;
  const pending = { writing: false, promise: null };
  loopIntervalSaves.set(account, pending);
  pending.promise = (async () => {
    try {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (account !== current) return false;
      const revision = loopSettingsRevision;
      pending.writing = true;
      const updated = await call('/api/loop/interval', {
        method: 'POST', body: JSON.stringify({ confirm: true, everySeconds, revision }),
      });
      if (account === current) {
        ++loopVersion;
        input.value = String(updated.everyMs / 1000);
        configIntervalSaved(account, everySeconds, revision, updated.settingsRevision);
        renderLoop(updated);
        $('loop-interval-status').textContent = '间隔已保存，下一轮生效';
      }
      return true;
    } catch (error) {
      if (account === current) {
        input.setAttribute('aria-invalid', 'true');
        $('loop-interval-status').textContent = '间隔保存失败，请重试';
        reportError(error);
      }
      return false;
    } finally {
      loopIntervalSaves.delete(account);
      if (account === current) {
        input.disabled = false;
        refreshLoop();
      }
    }
  })();
  return pending.promise;
}
$('loop-every').onchange = saveLoopInterval;
$('loop-every').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); saveLoopInterval(); }
};

let orderClockOffset=0;
function orderRefreshLabel(at){
 const left=Math.max(0,Math.ceil(at-(Date.now()+orderClockOffset)/1000));
 const time=new Date(at*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 return time+' 刷新 · '+(left?('剩余 '+Math.floor(left/60)+'分'+left%60+'秒'):'已到时，等待同步');
}
setInterval(() => {
  if (document.hidden || $('tab-manual').classList.contains('hidden')) return;
  for (const node of document.querySelectorAll('[data-order-refresh-at]')) {
    node.textContent = orderRefreshLabel(Number(node.dataset.orderRefreshAt));
  }
  updateWorldProductionTimers();
}, 1000);
function orderState(order, data) {
  const box = el('div', 'order-state');
  const decision = order.decision;
  const labels = { ready: data.idleRunning ? '等待自动交付' : '等待开启挂机', disabled: '自动交付已关闭', refreshing: '订单刷新中',
    unknown: '等待核对', filtered: '已过滤', missing: '材料不足', reserved: '材料已预留', reroll: '等待换单', productionSkipped: '已跳过排产' };
  const state = decision?.status ?? 'unknown';
  const label = !data.autoDeliverOrders && !['reroll','refreshing'].includes(state) ? labels.disabled : labels[state] || labels.unknown;
  const shortages = decision?.shortages || [];
  const tags = el('div', 'order-state-tags');
  const materialLabel = state === 'reserved' ? labels.reserved : labels.missing;
  if (shortages.length && materialLabel !== label) tags.appendChild(chip('waiting', materialLabel));
  const status = chip(state === 'ready' && data.idleRunning && data.autoDeliverOrders ? 'ready' : 'waiting', label);
  if (decision?.reason) status.title = decision.reason;
  tags.appendChild(status);
  box.appendChild(tags);
  if(order.refreshTime>0){const time=el('span','order-refresh-time',orderRefreshLabel(order.refreshTime));time.dataset.orderRefreshAt=String(order.refreshTime);box.append(time);}
  if (shortages.length) {
    const list = el('ul', 'order-material-list');
    for (const item of shortages) {
      const row = el('li');
      const held = Number.isFinite(item.owned) && Number.isFinite(item.available)
        ? Math.max(0, item.owned - item.available) : null;
      row.append(el('span', 'order-material-name', item.name || item.id),
        el('span', null, '需：' + fmt(item.required)), el('span', 'order-material-missing', '缺：' + fmt(item.missing)),
        el('span', null, '留：' + fmt(held)));
      list.appendChild(row);
    }
    box.appendChild(list);
  } else if (decision?.reason && state !== 'refreshing') {
    box.appendChild(el('span', 'dim', decision.reason));
  }
  return box;
}

const pendingResidentOrders = new Set();
function residentOrderButton(order) {
  const account = current, key = account + ':' + order.index;
  const pending = pendingResidentOrders.has(key);
  const button = smallButton(pending ? '提交中…' : '强制提交');
  button.dataset.residentOrder = String(order.index);
  const ready = Boolean(order.orderKey) && order.manualDecision?.status === 'ready';
  button.disabled = pending || !ready || !account || snapshot.paused || disconnected.has(account);
  button.title = pending ? '账号忙时自动排队，结果见运行日志' : order.manualDecision?.reason || '请先刷新订单状态';
  button.setAttribute('aria-label', '强制提交' + (order.workerName || '居民') + '的订单 #' + order.index);
  const submit = async (acceptStockWarning = false) => {
    if (pendingResidentOrders.has(key) || current !== account || snapshot.paused || disconnected.has(account)) return;
    pendingResidentOrders.add(key);
    button.disabled = true;
    button.textContent = acceptStockWarning ? '提交中…' : '正在核对…';
    let stockWarning;
    try {
      const result = await call('/api/world/order/submit', { method: 'POST', body: JSON.stringify({
        confirm: true, index: order.index, orderKey: order.orderKey, acceptStockWarning,
      }) });
      stockWarning = result.stockWarning;
    } catch (error) {
      if (current === account) reportError(error, '提交居民订单');
    } finally {
      pendingResidentOrders.delete(key);
      if (current === account) {
        const displayed = $('world-orders').querySelector('[data-resident-order="' + order.index + '"]');
        if (stockWarning && displayed === button) {
          button.disabled = snapshot.paused || disconnected.has(account);
          button.textContent = '强制提交';
        } else {
          if (displayed) {
            displayed.disabled = true;
            displayed.textContent = '待刷新';
          }
          refreshManualWorld(true);
        }
      }
    }
    if (stockWarning && current === account && !snapshot.paused && !disconnected.has(account)) {
      openConfirm((order.workerName || '居民') + '的订单 #' + order.index, [el('p', '', stockWarning)], () => submit(true), '继续提交');
    }
  };
  button.onclick = () => { if (!button.disabled) return submit(); };
  return button;
}

function residentOrderActions(order){
 const root=el('div','order-manual-actions');root.append(residentOrderButton(order));
 const account=current,key=account+':'+order.index,button=smallButton('换单');button.setAttribute('aria-label','刷新'+(order.workerName||'居民')+'的订单 #'+order.index);
 button.disabled=pendingResidentOrders.has(key)||!order.manualRefresh?.allowed||!account||snapshot.paused||disconnected.has(account);button.title=order.manualRefresh?.reason||'放弃当前需求，等待新订单';
 button.onclick=()=>{if(button.disabled||current!==account||pendingResidentOrders.has(key))return;
  openConfirm('刷新居民订单',[el('p','','确认放弃'+(order.workerName||'居民')+'的订单 #'+order.index+'并换一单？'),el('p','dim','新需求按游戏刷新时间到达，不使用付费加速。')],async()=>{
   if(current!==account||snapshot.paused||disconnected.has(account)||pendingResidentOrders.has(key))throw Error('账号或订单状态已变化，请刷新后再试');
   pendingResidentOrders.add(key);button.disabled=true;button.textContent='换单中…';
   try{await call('/api/world/order/reroll',{method:'POST',body:JSON.stringify({confirm:true,index:order.index,orderKey:order.orderKey})});}
   finally{pendingResidentOrders.delete(key);if(current===account)await refreshManualWorld(true);}
  });
 };root.append(button);return root;
}

function worldProductionTime(finishTime, readyText, activeText = '剩余 ') {
  if (!Number.isFinite(finishTime) || finishTime <= 0) return '时间未同步';
  const remaining = Math.ceil(finishTime - (Date.now() + orderClockOffset) / 1000);
  return remaining > 0 ? '（' + activeText + productionPlanDuration(remaining) + '）' : readyText;
}

function worldProductionTimer(finishTime, readyText, activeText = '剩余 ') {
  const timer = el('span', 'production-time', worldProductionTime(finishTime, readyText, activeText));
  if (Number.isFinite(finishTime) && finishTime > 0) {
    timer.dataset.productionFinishAt = String(finishTime);
    timer.dataset.productionReadyText = readyText;
    timer.dataset.productionActiveText = activeText;
  }
  return timer;
}

const pendingProductionSpeeds = new Set();
function updateProductionSpeedButton(button, now) {
  const { productionSpeedUntil, speedStock, speedKey } = button.dataset;
  const minutes = Math.max(0, Math.ceil((Number(productionSpeedUntil) - now) / 60));
  const cost = Math.min(minutes, Number(speedStock));
  const pending = pendingProductionSpeeds.has(speedKey);
  button.hidden = !minutes;
  button.disabled = !cost || pending || snapshot.paused || disconnected.has(current);
  button.textContent = pending ? '加速中…' : cost > 0 ? '加速 ×' + cost
    : speedStock === '' ? '库存未同步' : '加速器不足';
  button.setAttribute('aria-label', button.title + '，' + button.textContent);
  button.dataset.speedCost = String(cost);
}

function productionSpeedButton(target, stock, label) {
  const button = component('ui-button');
  const account = current, key = JSON.stringify([account, target.kind, target.buildingId, target.index]);
  button.type = 'button';
  button.title = '使用加速器加速' + label + '，每个缩短 1 分钟';
  button.dataset.productionSpeedUntil = String(target.finishTime);
  button.dataset.speedStock = Number.isSafeInteger(stock) && stock >= 0 ? String(stock) : '';
  button.dataset.speedKey = key;
  const now = () => (Date.now() + orderClockOffset) / 1000;
  updateProductionSpeedButton(button, now());
  button.onclick = async () => {
    if (current !== account || !account) return;
    updateProductionSpeedButton(button, now());
    if (button.disabled) return;
    const maxUse = Number(button.dataset.speedCost);
    pendingProductionSpeeds.add(key);
    updateProductionSpeedButton(button, now());
    try {
      await call('/api/world/production-speed', { method: 'POST',
        body: JSON.stringify({ ...target, maxUse, confirm: true }) });
    } catch (error) {
      if (current === account) reportError(error, '手动生产加速');
    } finally {
      try { if (current === account) await refreshManualWorld(true); }
      finally { pendingProductionSpeeds.delete(key); updateWorldProductionTimers(); }
    }
  };
  return button;
}

function updateWorldProductionTimers() {
  for (const node of document.querySelectorAll('[data-production-finish-at]')) {
    node.textContent = worldProductionTime(Number(node.dataset.productionFinishAt),
      node.dataset.productionReadyText, node.dataset.productionActiveText);
  }
  const now = (Date.now() + orderClockOffset) / 1000;
  for (const button of document.querySelectorAll('[data-production-speed-until]')) updateProductionSpeedButton(button, now);
  for (const badge of document.querySelectorAll('[data-factory-active-until]')) {
    if (Number(badge.dataset.factoryActiveUntil) <= now) {
      badge.textContent = '待收取';
      delete badge.dataset.factoryActiveUntil;
    }
  }
}

const factoryFinishClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function factoryProduct(job, recipes) {
  if (!job.productId) return el('span', 'dim', job.name || '产物未同步');
  return planMaterialList([{ id: job.productId, name: job.name, icon: job.icon, num: 1 }], recipes);
}

const pendingFactoryStarts = new Set();
const pendingFactoryAuto = new Set();
let lastWorldData = null;

function showFactoryStartState(key, message) {
  for (const button of document.querySelectorAll('[data-factory-start]')) {
    if (button.dataset.factoryStart === key) button.disabled = pendingFactoryStarts.has(key);
  }
  for (const status of document.querySelectorAll('[data-factory-start-status]')) {
    if (status.dataset.factoryStartStatus === key) status.textContent = message;
  }
}

function chooseFactoryProduct(factory, account, key) {
  const available = () => current === account && account && !snapshot.paused && !disconnected.has(account) && !pendingFactoryStarts.has(key);
  if (!available()) return;
  const choices = el('div', 'factory-product-choices');
  choices.setAttribute('role', 'radiogroup');
  choices.setAttribute('aria-label', '选择产物');
  const detail = el('div', 'factory-recipe-detail');
  detail.setAttribute('aria-live', 'polite');
  let selected = factory.manualProducts.find(product => !product.reason) || factory.manualProducts[0];
  const select = product => {
    selected = product;
    clear(detail);
    detail.appendChild(el('strong', null, product.name + ' ×1'));
    detail.appendChild(el('span', 'dim', '基础耗时 ' + productionPlanDuration(product.seconds)));
    if (product.inputs.length) {
      const list = el('ul', 'factory-recipe-costs');
      for (const input of product.inputs) {
        const row = el('li');
        row.append(el('span', null, input.name + ' ×' + input.num),
          el('span', 'dim', input.owned == null ? '库存未同步' : '持有 ' + input.owned));
        list.appendChild(row);
      }
      detail.appendChild(list);
    } else detail.appendChild(el('span', 'dim', '无需原料'));
    if (product.reason) detail.appendChild(el('strong', null, product.reason));
    $('m-ok').disabled = !!product.reason;
  };
  let initialInput;
  for (const product of factory.manualProducts) {
    const label = el('label', 'factory-product-choice');
    const input = el('input');
    input.type = 'radio';
    input.name = 'manual-factory-product';
    input.value = product.productId;
    input.checked = product === selected;
    if (input.checked) initialInput = input;
    input.onchange = () => { if (input.checked) select(product); };
    label.append(input, iconEl(product.icon, 24, product.name), el('span', null, product.name));
    choices.appendChild(label);
  }
  openConfirm((factory.displayName || factory.buildingId) + ' · 手动排产',
    [choices, detail], async () => {
      if (!available() || selected.reason) throw Error('账号或工厂状态已变化，请重新选择产物');
      pendingFactoryStarts.add(key);
      showFactoryStartState(key, '正在提交排产…');
      let message;
      try {
        const result = await call('/api/world/production-start', { method: 'POST', body: JSON.stringify({
          buildingId: factory.buildingId, productId: selected.productId, productionKey: selected.productionKey, confirm: true,
        }) });
        message = result.label;
      } catch (error) {
        message = error.message;
        throw error;
      } finally {
        try { if (current === account) await refreshManualWorld(true); }
        finally {
          pendingFactoryStarts.delete(key);
          if (current === account) showFactoryStartState(key, message);
        }
      }
    }, '加入队列 ×1');
  select(selected);
  initialInput.focus();
}

function factoryProductionQueue(factory, recipes, accelerators) {
  const section = el('section', 'factory-game-section');
  section.appendChild(el('h3', null, '游戏生产格'));
  const known = Array.isArray(factory.jobs) && factory.queueKnown !== false;
  const jobs = known ? factory.jobs : [];
  const queue = el('div', 'factory-queue');
  queue.setAttribute('aria-label', (factory.displayName || factory.buildingId) + '游戏生产格');
  const capacity = Number.isInteger(factory.capacity) && factory.capacity > 0 ? factory.capacity : 6;
  const account = current, key = JSON.stringify([account, factory.buildingId]);
  const canChoose = known && factory.capacity > 0 && factory.autoEnabled === false && factory.manualProducts?.length > 0;
  let waiting = 0;
  for (let index = 0; index < capacity; index++) {
    const job = jobs[index];
    const actionable = !job && canChoose;
    const slot = el(actionable ? 'button' : 'div', 'factory-slot');
    const header = el('span', 'factory-slot-header');
    header.appendChild(el('span', 'dim', '格子 ' + (index + 1)));
    slot.appendChild(header);
    if (job) {
      const timed = job.finishTime > 0;
      let badge;
      if (timed) {
        const running = job.finishTime > (Date.now() + orderClockOffset) / 1000;
        badge = chip('ready', running ? '生产中' : '待收取');
        if (running) badge.dataset.factoryActiveUntil = String(job.finishTime);
      } else {
        badge = chip('waiting', '排队 #' + (++waiting));
      }
      header.appendChild(badge);
      const product = el('div', 'factory-product');
      product.appendChild(factoryProduct(job, recipes));
      slot.appendChild(product);
      if (timed) {
        const time = el('div', 'factory-finish');
        time.append(el('span', 'dim', '完成时间'), el('span', null, factoryFinishClock.format(job.finishTime * 1000)));
        slot.appendChild(time);
        if (badge.dataset.factoryActiveUntil && job.productId && Number.isSafeInteger(job.index)) {
          slot.appendChild(productionSpeedButton({ kind: 'factory', buildingId: factory.buildingId, index: job.index,
            productId: job.productId, finishTime: job.finishTime }, accelerators, job.name || job.productId));
        }
      }
    } else {
      slot.classList.add('factory-empty');
      if (actionable) {
        slot.type = 'button';
        slot.dataset.factoryStart = key;
        slot.setAttribute('aria-haspopup', 'dialog');
        slot.setAttribute('aria-label', (factory.displayName || factory.buildingId) + '空闲格 ' + (index + 1) + '，选择产物加入队尾');
        slot.disabled = pendingFactoryStarts.has(key) || !account || snapshot.paused || disconnected.has(account);
        slot.onclick = () => chooseFactoryProduct(factory, account, key);
      }
      slot.appendChild(el('span', 'factory-product' + (actionable ? '' : ' dim'), actionable ? '＋ 排产' : known ? '空闲' : '未同步'));
    }
    queue.appendChild(slot);
  }
  section.appendChild(queue);
  const status = el('p', 'factory-start-status dim');
  status.dataset.factoryStartStatus = key;
  status.setAttribute('role', 'status');
  if (pendingFactoryStarts.has(key)) status.textContent = '正在提交排产…';
  else if (!canChoose && known && jobs.length < capacity && factory.manualProducts) {
    status.textContent = factory.autoEnabled ? '游戏自动生产中'
      : !factory.capacity ? '生产格容量未同步' : '当前没有可手动排产的配方';
  }
  section.appendChild(status);
  if (jobs.length > capacity) {
    const overflow = jobs.slice(capacity).map(job => job.name || job.productId || '产物未同步');
    section.appendChild(el('p', 'dim', '游戏队列另外返回 ' + overflow.length + ' 项：' + overflow.join('、')));
  }
  return section;
}

function factoryCurrentProduction(factory, recipes) {
  if (!Array.isArray(factory.jobs) || factory.queueKnown === false) {
    return el('span', 'dim', '生产队列未同步');
  }
  const current = el('div', 'factory-current');
  const now = (Date.now() + orderClockOffset) / 1000;
  const active = factory.jobs.filter(job => job.finishTime > now);
  for (const job of active) {
    const product = el('div', 'factory-current-product');
    product.append(factoryProduct(job, recipes),
      worldProductionTimer(job.finishTime, '已完成 · 待收取'));
    current.appendChild(product);
  }
  if (!active.length) {
    const completed = factory.jobs.find(job => job.finishTime > 0 && job.finishTime <= now);
    if (completed) current.appendChild(factoryProduct(completed, recipes));
    const status = completed ? '已完成 · 待收取' : factory.jobs.length ? '等待开工' : '空闲';
    current.appendChild(el('span', 'dim', status));
  }
  return current;
}

function applyFactoryAutoResult(result, account) {
  if (!result?.confirmed || !lastWorldData || current !== account) return false;
  const data = lastWorldData;
  const factory = (data.factories || []).find(item => item.buildingId === result.buildingId);
  if (!factory) return false;
  const product = (factory.autoProducts || []).find(item => item.productId === result.autoProductId);
  factory.autoProductId = result.autoProductId || null;
  factory.auto = result.autoProductName || product?.name || null;
  factory.autoIcon = product?.icon || null;
  factory.autoEnabled = !!factory.autoProductId && result.active === true;
  factory.autoPending = !!factory.autoProductId && result.active !== true;
  data.autoProduce = {
    ...(data.autoProduce || {}),
    active: result.active === true,
    forever: result.forever === true,
    endTime: result.endTime ?? 0,
    remainingSeconds: result.remainingSeconds ?? null,
    costRuby: result.costRuby,
    durationSeconds: result.durationSeconds,
    ruby: Number.isFinite(result.ruby) ? result.ruby : (data.autoProduce?.ruby ?? null),
  };
  renderWorld(data);
  return true;
}

function showFactoryAutoState(key, message) {
  let buildingId = key;
  try {
    const parts = JSON.parse(key);
    if (Array.isArray(parts) && typeof parts[1] === 'string') buildingId = parts[1];
  } catch { /* 保持原值，兼容直接传入工厂标识。 */ }
  for (const button of document.querySelectorAll('[data-factory-auto]')) {
    if (button.dataset.factoryAuto === buildingId) {
      button.disabled = pendingFactoryAuto.has(key);
      button.toggleAttribute('aria-busy', pendingFactoryAuto.has(key));
      if (message) button.title = message;
    }
  }
}

function autoTimeText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? hours + ' 小时 ' + minutes + ' 分钟' : minutes + ' 分钟';
}

function factoryAutoButton(factory, autoProduce) {
  const active = factory.autoEnabled === true;
  const pending = factory.autoPending === true;
  const button = el('button', 'factory-auto-button');
  button.type = 'button';
  button.dataset.factoryAuto = factory.buildingId;
  const badge = chip(factory.autoEnabled == null ? 'unknown' : active ? 'ready' : pending ? 'waiting' : 'unknown',
    factory.autoEnabled == null ? '未同步' : active ? '已开启' : '未开启');
  badge.classList.add('factory-auto-badge');
  button.appendChild(badge);
  if (factory.auto) {
    const material = el('span', 'factory-auto-material');
    material.append(iconEl(factory.autoIcon, 16, factory.auto), el('span', null, factory.auto));
    button.appendChild(material);
  }
  const cost = Number(autoProduce?.costRuby) || 500;
  const hours = Math.max(1, Math.round((Number(autoProduce?.durationSeconds) || 28800) / 3600 * 10) / 10);
  const globallyActive = autoProduce?.active === true;
  button.title = active
    ? (factory.autoProductId ? '已设置自动生产，点击更换物料或关闭该工厂自动生产' : '点击选择该工厂的自动物料')
    : globallyActive
      ? '点击选择该工厂的自动物料'
      : pending
        ? '自动物料已设置，但自动生产时长未开通；点击开通'
        : '点击开通自动生产（' + cost + ' 钻石 / ' + hours + ' 小时）';
  button.disabled = !current || snapshot.paused || disconnected.has(current) || pendingFactoryAuto.has(JSON.stringify([current, factory.buildingId]));
  button.onclick = () => openFactoryAutoDialog(factory, current, autoProduce);
  return button;
}

function openFactoryAutoDialog(factory, account, autoProduce) {
  const key = JSON.stringify([account, factory.buildingId]);
  const available = () => current === account && account && !snapshot.paused && !disconnected.has(account) && !pendingFactoryAuto.has(key);
  if (!available()) return;
  const active = autoProduce?.active === true;
  const forever = autoProduce?.forever === true;
  const cost = Number(autoProduce?.costRuby) || 500;
  const hours = Math.max(1, Math.round((Number(autoProduce?.durationSeconds) || 28800) / 3600 * 10) / 10);
  const ruby = Number.isFinite(autoProduce?.ruby) ? autoProduce.ruby : null;
  const products = Array.isArray(factory.autoProducts) ? factory.autoProducts
    : Array.isArray(factory.manualProducts) ? factory.manualProducts : [];
  const currentProduct = products.find(product => product.productId === factory.autoProductId)
    || products.find(product => factory.auto && product.name === factory.auto);
  let selected = currentProduct || products.find(product => !product.reason) || products[0] || null;
  const body = [];
  const intro = el('div', 'factory-auto-summary');
  if (!active) {
    intro.appendChild(el('strong', 'factory-auto-cost', '消耗 ' + cost + ' 钻石，获得 ' + hours + ' 小时自动生产'));
    intro.appendChild(el('span', 'dim', '开通后本工厂按所选物料自动生产；已购时长不退。'));
    if (ruby != null) intro.appendChild(el('strong', ruby < cost ? 'bad' : 'dim', '当前持有 ' + ruby + ' 钻石'));
  } else {
    intro.appendChild(el('strong', null, forever ? '自动生产：永久已开通' : '自动生产：已开通，剩余 ' + autoTimeText(Number(autoProduce?.remainingSeconds) || 0)));
    if (factory.auto) intro.appendChild(el('span', 'dim', '当前自动物料：' + factory.auto));
  }
  body.push(intro);
  let applySelection = null;
  if (!products.length) {
    body.push(el('p', 'bad', '这个工厂当前没有可自动生产的物料，请先确认工厂产物列表。'));
  } else {
    const choices = el('div', 'factory-product-choices');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', '选择自动生产物料');
    const detail = el('div', 'factory-recipe-detail');
    detail.setAttribute('aria-live', 'polite');
    let initialInput;
    const select = product => {
      selected = product;
      clear(detail);
      if (!product) {
        detail.appendChild(el('span', 'dim', '没有可选物料'));
        $('m-ok').disabled = true;
        return;
      }
      detail.appendChild(el('strong', null, product.name + ' ×1'));
      detail.appendChild(el('span', 'dim', '基础耗时 ' + productionPlanDuration(product.seconds)));
      if (product.inputs?.length) {
        const list = el('ul', 'factory-recipe-costs');
        for (const input of product.inputs) {
          const row = el('li');
          row.append(el('span', null, input.name + ' ×' + input.num),
            el('span', 'dim', input.owned == null ? '库存未同步' : '持有 ' + input.owned));
          list.appendChild(row);
        }
        detail.appendChild(list);
      } else detail.appendChild(el('span', 'dim', '无需原料'));
      if (product.reason) detail.appendChild(el('span', 'dim', product.reason + '（仍可设置自动生产）'));
      $('m-ok').disabled = !active && ruby != null && ruby < cost;
    };
    for (const product of products) {
      const label = el('label', 'factory-product-choice');
      const input = el('input');
      input.type = 'radio';
      input.name = 'factory-auto-product';
      input.value = product.productId;
      input.checked = product === selected;
      if (input.checked) initialInput = input;
      input.onchange = () => { if (input.checked) select(product); };
      label.append(input, iconEl(product.icon, 24, product.name), el('span', null, product.name));
      choices.appendChild(label);
    }
    body.push(choices, detail);
    applySelection = () => { select(selected); initialInput?.focus(); };
  }
  const hasTarget = !!factory.autoProductId;
  if (active && hasTarget) {
    const close = smallButton('关闭该工厂自动生产', true);
    close.type = 'button';
    close.classList.add('factory-auto-close');
    close.onclick = async () => {
      if (!available()) return;
      close.disabled = true;
      pendingFactoryAuto.add(key);
      showFactoryAutoState(key, '正在关闭自动生产…');
      try {
        const result = await call('/api/world/factory-auto-produce', { method: 'POST', body: JSON.stringify({
          action: 'cancel', buildingId: factory.buildingId, confirm: true, fast: true,
          active,
          forever,
          endTime: Number(autoProduce?.endTime) || 0,
          ruby,
          currentProductId: factory.autoProductId || null,
        }) });
        closeModal();
        if (applyFactoryAutoResult(result, account)) return;
        if (current === account) await refreshManualWorld(true);
      } catch (error) {
        close.disabled = false;
        if (!error.logged) reportError(error);
      } finally {
        pendingFactoryAuto.delete(key);
        if (current === account) showFactoryAutoState(key, '');
      }
    };
    body.push(close);
  }
  openConfirm((factory.displayName || factory.buildingId) + ' · 自动生产', body, async () => {
    if (!available() || !selected) throw Error('账号或工厂状态已变化，请重新选择自动物料');
    pendingFactoryAuto.add(key);
    showFactoryAutoState(key, '正在提交自动生产…');
    let message;
    let applied = false;
    try {
      const result = await call('/api/world/factory-auto-produce', { method: 'POST', body: JSON.stringify({
        action: active ? 'set' : 'enable',
        buildingId: factory.buildingId,
        productId: selected.productId,
        productName: selected.name || null,
        confirm: true,
        fast: true,
        active,
        forever,
        endTime: Number(autoProduce?.endTime) || 0,
        ruby,
        currentProductId: factory.autoProductId || null,
      }) });
      message = result.label;
      applied = applyFactoryAutoResult(result, account);
    } catch (error) {
      message = error.message;
      throw error;
    } finally {
      try { if (current === account && !applied) await refreshManualWorld(true); }
      finally {
        pendingFactoryAuto.delete(key);
        if (current === account) {
          showFactoryAutoState(key, message || '');
        }
      }
    }
  }, !active ? '消耗 ' + cost + ' 钻石并开启' : hasTarget ? '保存自动物料' : '开启自动生产');
  applySelection?.();
}

function factoryProductionSection(factories, expanded, recipes, accelerators, autoProduce) {
  const headers = ['建筑', '类型', '等级', '当前产物', '自动生产', '游戏排队'];
  const result = table(headers, factories.map(b => {
    const button = component('ui-factory-toggle');
    button.dataset.factoryProduction = b.buildingId;
    const name = b.displayName || b.buildingId;
    if (b.icon) button.appendChild(iconEl(b.icon, 26, name));
    button.appendChild(el('span', null, name));
    const queued = b.queueKnown !== false && Array.isArray(b.jobs) ? b.jobs.filter(job => !(job.finishTime > 0)) : null;
    const first = queued?.[0];
    const preview = el('div', 'factory-queue-preview', first ? '' : queued ? '—' : '未同步');
    if (first) preview.appendChild(factoryProduct(first, recipes));
    if (queued?.length > 1) preview.appendChild(el('small', 'dim', '共 ' + queued.length + ' 件'));
    return [button, b.typeName || b.type, 'lv' + b.level, factoryCurrentProduction(b, recipes),
      factoryAutoButton(b, autoProduce), preview];
  }), 'sea-records');
  const toggleAll = component('ui-button');
  toggleAll.type = 'button';
  const entries = Array.from(result.querySelectorAll('tbody tr'), (row, index) => {
    const factory = factories[index];
    const button = row.querySelector('[data-factory-production]');
    const detail = el('tr', 'factory-detail');
    detail.id = 'factory-slots-' + index;
    const cell = el('td');
    cell.colSpan = headers.length;
    detail.appendChild(cell);
    row.after(detail);
    button.setAttribute('aria-controls', detail.id);
    const setExpanded = open => {
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', (open ? '收起' : '展开') + (factory.displayName || factory.buildingId) + '的生产格');
      detail.hidden = !open;
      clear(cell);
      if (open) cell.appendChild(factoryProductionQueue(factory, recipes, accelerators));
    };
    setExpanded(expanded.has(factory.buildingId));
    button.onclick = () => {
      setExpanded(detail.hidden);
      updateToggleAll();
    };
    return { detail, setExpanded };
  });
  function updateToggleAll() {
    const allOpen = entries.every(({ detail }) => !detail.hidden);
    toggleAll.textContent = allOpen ? '全部收起' : '全部展开';
    toggleAll.setAttribute('aria-label', toggleAll.textContent + '工厂明细');
    toggleAll.setAttribute('aria-expanded', String(allOpen));
  }
  toggleAll.setAttribute('aria-controls', entries.map(({ detail }) => detail.id).join(' '));
  toggleAll.onclick = () => {
    const open = entries.some(({ detail }) => detail.hidden);
    for (const { detail, setExpanded } of entries) {
      if (detail.hidden === open) setExpanded(open);
    }
    updateToggleAll();
  };
  updateToggleAll();
  return buildingSection('工厂', 'world-factory-section', result, toggleAll);
}

function buildingSection(title, className, content, button) {
  const section = component('ui-building-card');
  section.classList.add(className);
  section.setAttribute('role', 'region');
  section.setAttribute('aria-label', title);
  section.querySelector('h2').textContent = title;
  button.dataset.buildingToggle = className;
  section.querySelector('[data-slot="card-header"]').appendChild(button);
  section.querySelector('[data-slot="card-content"]').appendChild(content);
  return section;
}

function buildingListSection(title, className, content, collapsed) {
  const button = component('ui-button');
  button.type = 'button';
  content.id = className + '-list';
  content.dataset.buildingList = className;
  button.setAttribute('aria-controls', content.id);
  const setOpen = open => {
    content.hidden = !open;
    button.textContent = open ? '收起' : '展开';
    button.setAttribute('aria-label', button.textContent + title + '列表');
    button.setAttribute('aria-expanded', String(open));
  };
  setOpen(!collapsed.has(className));
  button.onclick = () => setOpen(content.hidden);
  return buildingSection(title, className, content, button);
}

function orderRewardNode(required, progress) {
  let status = '未达标';
  if (required <= progress.rewardedNum) status = '已领取';
  else if (required <= progress.orderNum) status = required === progress.tier ? '可领取' : '已达标';
  else if (progress.cap != null && required > progress.cap) status = '超出账号上限';
  else if (progress.configuredCap != null && required > progress.configuredCap) status = '超挂机上限';
  else if (required === progress.tier) status = '下一档';

  const node = el('li', 'resident-reward-node', required);
  node.dataset.status = status;
  node.title = required + ' 单档 · ' + status;
  node.setAttribute('aria-label', node.title);
  return node;
}

function renderOrderProgress(progress) {
  const box = $('resident-order-progress');
  clear(box);
  box.hidden = !progress;
  if (box.hidden) return;
  const head = el('div', 'resident-order-progress-head');
  const maximum = progress.configuredCap || progress.cap;
  const count = el('strong', '', maximum > 0 ? progress.orderNum : '已交 ' + progress.orderNum + ' 单');
  if (maximum > 0) {
    const source = progress.configuredCap ? '设定上限' : '账号上限';
    count.append(el('span', 'resident-order-limit-label', ' / ' + source + ' '), el('span', '', maximum));
  }
  head.append(el('span', 'dim', '今日居民订单'), count);
  box.append(head);
  const tiers = progress.reqNums;
  if (progress.total > 0 || tiers.length) {
    const timeline = el('div', 'resident-order-timeline');
    const scale = el('div', 'resident-order-scale');
    const track = el('div', 'resident-order-progress-track');
    const fill = el('i');
    const end = tiers.length ? Math.max(progress.total ?? 0, tiers.at(-1), progress.orderNum) : progress.total;
    const position = value => Math.min(100, value / end * 100) + '%';
    track.style.setProperty('--goal', position(progress.total ?? end));
    fill.style.width = position(progress.orderNum);
    track.append(fill);
    scale.append(track);
    if (tiers.length) {
      const rewards = el('ol', 'resident-reward-steps');
      rewards.setAttribute('aria-label', '奖励档位（单）');
      const gaps = tiers.map((required, index) => required - (tiers[index - 1] ?? 0));
      // Leave room for adjacent numbers when a high daily cap compresses the reward tiers.
      scale.style.setProperty('--scale-intervals', String(end / Math.min(...gaps)));
      tiers.forEach((required, index) => {
        const node = orderRewardNode(required, progress);
        node.style.left = position(required);
        node.style.width = position(Math.min(gaps[index], gaps[index + 1] ?? gaps[index]));
        rewards.append(node);
      });
      scale.append(rewards);
    }
    timeline.append(scale);
    box.append(timeline);
  }
  const limits = [];
  if (progress.cap == null) limits.push('账号上限待同步');
  else if (progress.configuredCap) limits.push('账号上限 ' + progress.cap + ' 单');
  if (progress.bonus > 0) limits.push('基础 ' + progress.baseMax + ' + 加成 ' + progress.bonus);
  if (tiers.includes(progress.tier)) {
    const tier = progress.tier;
    limits.push(progress.orderNum >= tier ? tier + ' 单档可领取' : '下一档 ' + tier + ' 单');
  }
  if (limits.length) box.append(el('div', 'dim resident-order-progress-note', limits.join(' · ')));

  if (!tiers.length) box.append(el('div', 'dim resident-order-progress-note', '奖励档位待同步'));
}

function renderWorld(data) {
  stateActions.setGameData(current, 'world', data);
  lastWorldData = data;
  orderClockOffset=Number.isFinite(data.serverNow)?data.serverNow*1000-Date.now():0;
  $('world-view').textContent = '';
  const recipes = new Map((data.recipes || []).map(recipe => [recipe.productId, recipe]));
  const fbox = $('world-factories');
  const expanded = new Set([...fbox.querySelectorAll('[aria-expanded="true"]')].map(node => node.dataset.factoryProduction).filter(Boolean));
  const collapsed = new Set([...fbox.querySelectorAll('[data-building-list]')].filter(node => node.hidden).map(node => node.dataset.buildingList));
  const focusedFactory = document.activeElement?.dataset.factoryProduction;
  const focusedGroup = document.activeElement?.dataset.buildingToggle;
  clear(fbox);
  if (data.factories?.length) {
    const factories = [...data.factories].sort((a, b) => a.buildingId.localeCompare(b.buildingId, 'zh-CN', { numeric: true }));
    fbox.appendChild(factoryProductionSection(factories, expanded, recipes, data.accelerators, data.autoProduce));
  }
  if (data.farms?.length) {
    const plots = [...data.farms].sort((a, b) => a.plot.localeCompare(b.plot, 'zh-CN', { numeric: true }));
    const farmTable = table(['农田', '等级', '当前作物', '状态与计时'], plots.map((plot) => {
      let status = plot.status || '未同步';
      if (plot.productId && plot.ripeTime > 0) {
        status = worldProductionTimer(plot.ripeTime, '已成熟', '生长中 · 剩余 ');
        if (plot.state === 'growing' && plot.ripeTime > (Date.now() + orderClockOffset) / 1000) {
          const controls = el('div', 'production-speed-controls');
          controls.append(status, productionSpeedButton({ kind: 'farm', buildingId: plot.plot,
            productId: plot.productId, finishTime: plot.ripeTime }, data.accelerators, plot.productName || plot.productId));
          status = controls;
        }
      } else if (plot.state === 'building' && plot.finishTime > 0) {
        status = worldProductionTimer(plot.finishTime, '待竣工', '建造中 · 剩余 ');
      } else if (plot.productId) {
        status = '成熟时间未同步';
      }
      const recipe = recipes.get(plot.productId);
      const crop = recipe ? planMaterialList([{ id: plot.productId, name: plot.productName, num: recipe.output }], recipes)
        : plot.productName || plot.productId || '—';
      return [plot.displayName || plot.plot, plot.level == null ? '未同步' : 'lv' + plot.level, crop, status];
    }), 'sea-records');
    fbox.appendChild(buildingListSection('农田', 'world-farm-section', farmTable, collapsed));
  }
  // 空位：没盖的（待建）与正在盖的（施工中）。计划器只会建「待建」那些，
  // 施工中的只能等它盖完由竣工步骤收尾，所以两种状态要分开说，不然看不出差在哪。
  const slots = (data.buildings || []).filter((b) => b.level === 0);
  if (slots.length) {
    const slotTable = table(['空位', '类型', '状态'], slots.map((b) => [
      { cell: b.icon, text: b.displayName || b.buildingId },
      b.typeName || b.type || '未知类型',
      b.building ? chip('waiting', '施工中') : b.awaitingFinish ? chip('ready', '待竣工') : chip('ready', '待建'),
    ]), 'sea-records');
    fbox.appendChild(buildingListSection('空位', 'world-slot-section', slotTable, collapsed));
  }
  if (focusedFactory || focusedGroup) {
    const button = focusedFactory
      ? [...fbox.querySelectorAll('[data-factory-production]')].find(node => node.dataset.factoryProduction === focusedFactory)
      : fbox.querySelector('[data-building-toggle="' + focusedGroup + '"]');
    (button || $('tab-manual')).focus({ preventScroll: true });
  }
  const obox = clear($('world-orders'));
  renderOrderProgress(data.orderProgress);
  if (data.orders?.length) {
    const headers = ['订单', '居民', '需求', { label: '经验', num: true }, { label: '金币', num: true }, '挂机交付', '手动操作'];
    const ordersTable = table(headers, data.orders.map((o) => {
      const refreshing = o.refreshPending || o.refreshTime || o.decision?.status === 'refreshing';
      const rewardCell = value => ({ num: true, text: !refreshing && Number.isFinite(value) ? fmt(value) : '—' });
      return [
        '#' + o.index,
        { cell: o.workerIcon, text: (o.workerName || '未知居民') + (o.isSpecial ? '（特殊）' : '') },
        o.requirements.length && !refreshing ? planMaterialList(o.requirements, recipes, 'resident-order-products-' + o.index) : '—',
        rewardCell(o.rewardExp),
        rewardCell(o.rewardGold),
        orderState(o, data),
        residentOrderActions(o),
      ];
    }), 'sea-records');
    obox.appendChild(ordersTable);
  } else {
    obox.appendChild(el('p', 'resident-order-empty', Array.isArray(data.orders)
      ? '当前没有待处理的居民订单。' : '居民订单列表尚未同步。'));
  }
  renderInventory(data.stock);
}

let worldVersion = 0, worldRead = null, displayedWorldAccount;
function refreshManualWorld(force = false) {
  if (force) { worldVersion++; worldRead = null; }
  if ($('tab-manual').classList.contains('hidden')&&$('tab-inventory').classList.contains('hidden')) return;
  const account = current;
  const available = account && !snapshot.paused && !disconnected.has(account);
  if (displayedWorldAccount !== account || !available) {
    $('inventory-status').textContent = available ? '正在读取库存' : !account ? '请先选择账号'
      : snapshot.paused ? '账号已暂停' : '账号已断开连接';
    displayedWorldAccount = account;
    resetInventory();
    worldVersion++;
    worldRead = null;
    for (const id of ['world-factories', 'world-orders', 'world-stock', 'resident-order-progress']) clear($(id));
    if (!available) $('world-view').textContent = account ? '账号已断开连接' : '请先选择账号';
  }
  if (!available || worldRead?.account === account) return;
  const version = ++worldVersion;
  worldRead = { account, version };
  $('world-view').textContent = '正在读取海面数据…';
  return call('/api/world').then(data => {
    if (version === worldVersion && current === account) renderWorld(data);
  }).catch(error => {
    if (version === worldVersion && current === account) {
      $('inventory-status').textContent='库存读取失败，请重试';
      $('world-view').textContent = '海面数据读取失败，请重新打开「建筑一览」重试。';
      reportError(error);
    }
  }).finally(() => {
    if (worldRead?.version === version) worldRead = null;
  });
}
$('inventory-refresh').onclick=()=>refreshManualWorld(true);

// ---- 表格 ------------------------------------------------------------------
// 单元格可以是字符串、{num}、{chip}、{cell: 图标项}、{cells: [图标项]}
function putCell(td, spec) {
  if (spec == null) return;
  if (spec instanceof Node) {
    td.appendChild(spec);
    return;
  }
  if (typeof spec !== 'object') {
    td.textContent = spec;
    return;
  }
  if (spec.num) {
    td.classList.add('num');
    td.textContent = spec.text;
    return;
  }
  if (spec.chip) {
    td.appendChild(chip(spec.chip, spec.text));
    return;
  }
  if ('cell' in spec || spec.cells) {
    const list = spec.cells ?? [{ name: spec.text, icon: spec.cell }];
    const value = el('div');
    if (spec.prefix) value.appendChild(el('span', 'dim', spec.prefix));
    for (const entry of list) {
      const who = el('span', 'who-cell');
      if (entry?.icon) who.appendChild(iconEl(entry.icon, 26, entry.name));
      who.appendChild(el('span', null, entry ? entry.name + (entry.num != null ? ' x' + fmt(entry.num) : '') : spec.text));
      value.append(who, ' ');
    }
    if (!list.length) value.appendChild(el('span', 'dim', '齐'));
    td.appendChild(value);
    return;
  }
  td.textContent = spec.text || '';
}

${activitiesScript}

function table(headers, rows, mobileLayout = headers.length >= 4 ? 'table-stack' : '') {
  const box = component('ui-table');
  const head = box.querySelector('thead tr');
  const headCell = head.firstElementChild;
  headCell.remove();
  for (const h of headers) {
    const th = headCell.cloneNode(false);
    th.textContent = typeof h === 'string' ? h : h.label;
    if (h.num) th.classList.add('num');
    head.appendChild(th);
  }
  const body = box.querySelector('tbody');
  const rowTemplate = body.firstElementChild;
  const cellTemplate = rowTemplate.firstElementChild;
  rowTemplate.remove();
  const labels = headers.map(h => typeof h === 'string' ? h : h.label);
  if (mobileLayout) box.classList.add(mobileLayout);
  for (const row of rows) {
    const tr = rowTemplate.cloneNode(false);
    row.forEach((spec, index) => {
      const td = cellTemplate.cloneNode(false);
      td.dataset.label = labels[index] ?? '';
      putCell(td, spec);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  return box;
}

// ---- 账号页 ----------------------------------------------------------------
${accountBackupScript}
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.account-card-menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
}, true);
$('accounts').addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = event.target.closest('.account-card-menu[open]');
  if (!menu) return;
  event.preventDefault();
  menu.open = false;
  menu.querySelector('summary').focus();
});

function accountChannel(source) {
  return { alipay: '支付宝', phone: '益世界 APP', douyin: '抖音小游戏', 'douyin-mitm': '抖音小游戏', mitm: '微信小游戏', wechat: '微信小游戏' }[source] || '已导入账号';
}

async function useAccountCard(id) {
  const version = ++accountSelectionVersion;
  if (id === current) return true;
  if (!await configMayChangeAccount(id) || version !== accountSelectionVersion) return false;
  await call('/api/accounts/active', { method: 'POST', body: JSON.stringify({ confirm: true, id }) });
  if (version !== accountSelectionVersion) return false;
  selectLoadedAccount(id);
  renderAccounts();
  return true;
}

async function toggleAccountCardLoop(id) {
  const account = accounts.find(row => row.id === id);
  if (!account || hostingActions.has(id)) return;
  const status = id === current ? snapshot : account.status ?? {};
  const stop = !!(status.looping || status.reconnecting);
  if (status.loopStopping || (!stop && id === current && loopAccount !== id)) return;
  stateActions.setFlag('hosting', id, true);
  accountStatusRevision++;
  if (id === current) loopVersion++;
  renderAccountSelect();
  try {
    if (!stop && id === current) {
      if (!await configFlush()) throw new Error('配置尚未保存，请先处理配置页的提示');
      if (current !== id || !await saveLoopInterval() || current !== id) return;
    }
    if (!accounts.some(row => row.id === id)) return;
    const data = await call((stop ? '/api/loop/stop' : '/api/accounts/pause') + '?account=' + encodeURIComponent(id), {
      method: 'POST', body: JSON.stringify(stop ? { confirm: true } : { confirm: true, paused: false, start: true }),
    });
    if (id === current) loopVersion++;
    setAccountStatus(id, stop ? data.status : data);
    if (!stop) stateActions.setFlag('disconnected', id, false);
    if (id === current) {
      refreshStages();
      refreshProgression();
    }
  } catch (error) {
    reportError(error);
  } finally {
    stateActions.setFlag('hosting', id, false);
    renderAccountSelect();
    refreshAccountStatuses();
    if (id === current) refreshLoop();
  }
}

function createAccountCard(id) {
  const card = component('ui-account-card');
  card.accountId = id;
  const action = name => card.querySelector('[data-account-action="' + name + '"]');
  action('select').onclick = async () => {
    if (await useAccountCard(id)) card.querySelector('[data-account-field="title"]').focus();
  };
  action('loop').onclick = () => toggleAccountCardLoop(id);
  action('worlds').onclick = () => openWorldManager(card);
  action('refresh').onclick = () => {
    if (action('refresh').disabled) return;
    const status = accounts.find(row => row.id === id)?.status;
    return status?.connected ? readAccountCard(card) : connectAccount(id);
  };
  action('login-settings').onclick = () => {
    if (accounts.some(account => account.id === id)) stateActions.setView({ loginSettingsAccountId: id });
  };
  action('rename').onclick = async () => {
    card.querySelector('details').open = false;
    const account = accounts.find(row => row.id === id);
    if (!account) return;
    const label = await accountDialog('修改账号备注', account.lastSeen?.nickname || account.title, account.label ?? '');
    if (label == null) return;
    await call('/api/accounts/label', { method: 'POST', body: JSON.stringify({ confirm: true, id, label }) });
    await loadAccounts(false);
    renderAccounts();
  };
  action('export').onclick = () => {
    card.querySelector('details').open = false;
    return exportAccounts(id);
  };
  action('remove').onclick = async () => {
    card.querySelector('details').open = false;
    const account = accounts.find(row => row.id === id);
    if (!account || await accountDialog('删除本机账号', '删除「' + account.title + '」保存在本机的账号？') === null) return;
    await call('/api/accounts/remove', { method: 'POST', body: JSON.stringify({ confirm: true, id }) });
    await loadAccounts(true);
    renderAccounts();
  };
  return card;
}

function formatAccountAfk(afk) {
  if (!afk) return '';
  const finish = afk.capped ? '收益已满' : afk.finishTime > 0 ? new Date(afk.finishTime * 1000).toLocaleTimeString() + ' 满额' : '暂无计时';
  return '等级 ' + (afk.level ?? '—') + ' · ' + finish;
}

async function readAccountCard(card) {
  if (card.readingProfile) return;
  const request = {};
  card.readingProfile = request;
  card.nextProfileRead = Date.now() + 20000;
  card.querySelector('[data-account-action="refresh"]').disabled = true;
  try {
    const data = await call('/api/accounts/card?account=' + encodeURIComponent(card.accountId));
    if (card.isConnected && card.readingProfile === request && data) stateActions.setGameData(card.accountId, 'card', data);
  } catch (error) {
    reportError(error, '读取账号资料');
  } finally {
    if (card.readingProfile === request) {
      card.readingProfile = null;
      const account = consoleStore.getState().accountsById[card.accountId];
      if (account && card.isConnected && !$('tab-account').classList.contains('hidden')) renderAccountCard(card, account);
    }
  }
}

function refreshAccountCards() {
  if (document.hidden) return;
  for (const card of $('accounts').children) {
    const status = consoleStore.getState().accountsById[card.accountId]?.status;
    if (!status || card.readingProfile) continue;
    const online = !!status.connected && !status.paused && !status.loginBlocked;
    if (card.profileOnline === online && (!online || Date.now() < card.nextProfileRead)) continue;
    card.profileOnline = online;
    void readAccountCard(card);
  }
}

function renderAccountResources(card, view, status) {
  const res = card.querySelector('[data-account-field="resources"]');
  const online = !!status.connected && !status.paused && !status.loginBlocked;
  const refresh = card.querySelector('[data-account-action="refresh"]');
  refresh.disabled = !!(card.readingProfile || status.paused || status.reconnecting || connectingAccounts.has(card.accountId));
  refresh.textContent = status.connected ? '刷新资料' : '连接并读取';
  const entries = view?.resources?.length ? view.resources
    : !online ? '连接后读取资源' : view ? '暂无数据' : card.readingProfile ? '正在读取资源…' : '暂未读取资源';
  if (res.renderedResources === entries) return;
  res.renderedResources = entries;
  if (typeof entries === 'string') {
    res.replaceChildren(el('span', 'dim', entries));
    return;
  }
  res.replaceChildren(...entries.map(entry => cell(entry.icon, 15, entry.name, entry.amount == null ? '未取得' : fmt(entry.amount), false)));
}

function renderAccountCard(card, account) {
  const selected = account.id === current;
  const status = selected ? snapshot : account.status ?? {};
  const { card: profile, overview } = consoleStore.getState().gameByAccount[account.id] ?? {};
  const view = profile && (!overview || profile.readAt >= overview.readAt) ? profile : overview;
  const seen = { ...account.lastSeen, ...view?.player };
  const updated = when(view?.readAt || seen.at);
  const world = account.hasSiblingRoles && account.loginWorldName && seen.worldName && seen.worldName !== account.loginWorldName
    ? account.loginWorldName + '（现 ' + seen.worldName + '）' : seen.worldName || account.loginWorldName;
  const fields = {
    title: account.label || seen.nickname || account.title,
    channel: accountChannel(account.source),
    status: connectingAccounts.has(account.id) ? '连接中…' : connectionStatus(status),
    role: seen.nickname || '待连接读取',
    world: world || '待连接读取',
    level: seen.level == null ? '—' : String(seen.level),
    power: seen.power == null ? '—' : fmt(seen.power),
    afk: formatAccountAfk(view?.afk) || (view ? '暂无数据' : '待连接读取'),
    seen: updated ? (view && !status.connected ? '上次读取 ' : '更新于 ') + updated : '连接后更新角色资料',
  };
  for (const [name, value] of Object.entries(fields)) {
    const field = card.querySelector('[data-account-field="' + name + '"]');
    if (field.textContent !== value) field.textContent = value;
  }
  card.querySelector('[data-account-field="role"]').parentNode.hidden = fields.title === fields.role;
  card.classList.toggle('on', selected);
  card.querySelector('[data-account-field="current"]').hidden = !selected;
  const badge = card.querySelector('[data-account-field="status"]');
  badge.classList.remove('done', 'waiting', 'blocked');
  badge.classList.add(connectionStatusKind(status, connectingAccounts.has(account.id)));
  const select = card.querySelector('[data-account-action="select"]');
  select.hidden = selected;
  const loop = card.querySelector('[data-account-action="loop"]');
  const running = status.looping || status.reconnecting;
  loop.disabled = hostingActions.has(account.id) || !!status.loopStopping || (!running && account.id === current && loopAccount !== current);
  loop.textContent = status.loopStopping ? '暂停中…' : hostingActions.has(account.id) ? '处理中…' : running ? '暂停挂机' : '开始挂机';
  loop.title = running ? '停止此账号自动循环，保留游戏连接和手动操作' : '按此账号已保存的任务持续挂机，直到手动暂停';
  if (account.hasSiblingRoles && status.paused && !loop.disabled) {
    loop.textContent = '切换并托管';
    loop.title = '先暂停同一账号的其他角色，再按本角色的配置开始托管';
  }
  renderAccountResources(card, view, status);
}

function renderAccounts() {
  $('export-accounts').disabled = !accounts.length;
  $('account-count').textContent = accounts.length + ' 个账号';
  const box = $('accounts');
  if ($('account-worlds-dialog').open && !accounts.some(row => row.id === worldManager?.id)) $('account-worlds-dialog').close();
  if (!accounts.length) {
    if (!box.querySelector('.account-empty')) {
      clear(box);
      const empty = el('div', 'account-empty');
      empty.append(el('h3', null, '添加第一个游戏账号'), el('p', 'dim', '点击「添加账号」登录，或通过「导入账号」恢复备份。'));
      box.appendChild(empty);
    }
    return;
  }
  const cards = new Map(Array.from(box.children).map(card => [card.accountId, card]));
  accounts.forEach((account, index) => {
    const card = cards.get(account.id) || createAccountCard(account.id);
    renderAccountCard(card, account);
    if (box.children[index] !== card) box.insertBefore(card, box.children[index] || null);
    cards.delete(account.id);
  });
  for (const card of cards.values()) card.remove();
}

let worldManager = null;
function openWorldManager(card) {
  worldManager = { id: card.accountId };
  $('account-worlds-title').textContent = card.querySelector('[data-account-field="title"]').textContent + ' · 区服管理';
  clear($('worlds'));
  $('worlds-hint').textContent = '';
  $('world-input').value = '';
  $('worlds-controls').disabled = false;
  $('account-worlds-dialog').showModal();
  $('load-worlds').focus();
}

function worldManagerOpen(context) {
  return context === worldManager && $('account-worlds-dialog').open;
}

async function runWorldAction(context, message, work) {
  const controls = $('worlds-controls');
  if (!worldManagerOpen(context) || controls.disabled) return;
  controls.disabled = true;
  $('worlds-hint').textContent = message;
  try {
    const result = await work(context);
    if (worldManagerOpen(context)) $('worlds-hint').textContent = result || '';
  } catch (error) {
    if (worldManagerOpen(context)) $('worlds-hint').textContent = error.message;
    reportError(error, '区服管理', context.id);
  } finally {
    if (worldManagerOpen(context)) controls.disabled = false;
  }
}

async function renderWorlds(context) {
  const data = await call('/api/worlds?account=' + encodeURIComponent(context.id));
  if (!worldManagerOpen(context)) return;
  const box = clear($('worlds'));
  for (const world of data.recentWorlds) {
    const role = world.role || {};
    const row = el('div', 'acct');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', world.worldName ? world.worldName + '（' + world.worldId + '）' : String(world.worldId)));
    if (role.worldId && role.worldId !== world.worldId) top.appendChild(el('span', 'id', '合服后 -> ' + (role.worldName ? role.worldName + '（' + role.worldId + '）' : role.worldId)));
    top.appendChild(el('span', 'id', (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power) + ' 上次登录 ' + (when(role.lastLoginTime) || '未知')));
    const enter = smallButton('进入');
    enter.onclick = () => enterWorld(context, world.worldId);
    top.appendChild(enter);
    if (role.id) {
      const save = smallButton(world.saved ? '已添加' : '添加角色');
      save.disabled = world.saved;
      save.onclick = () => runWorldAction(context, '正在添加角色…', async () => {
        await call('/api/worlds/save-role?account=' + encodeURIComponent(context.id), {
          method: 'POST', body: JSON.stringify({ confirm: true, worldId: world.worldId }),
        });
        if (worldManagerOpen(context)) {
          save.textContent = '已添加';
          save.disabled = true;
        }
        await loadAccounts(false);
      });
      top.appendChild(save);
    }
    row.appendChild(top);
    box.appendChild(row);
  }
  if (!data.recentWorlds.length) box.appendChild(el('div', 'dim', '这个账号下没有区服'));
  else box.appendChild(el('div', 'dim', '共 ' + data.recentWorlds.length + ' 个区服，分组 ' + data.latestGroupId));
}

function enterWorld(context, worldId) {
  return runWorldAction(context, '正在进入 ' + worldId + '…', async ({ id: owner }) => {
    const data = await call('/api/worlds/enter?account=' + encodeURIComponent(owner), { method: 'POST', body: JSON.stringify({ confirm: true, worldId, fromWorldId: 0 }) });
    if (overviewPending?.account === owner) overviewPending = null;
    stateActions.setGameData(owner, 'card', null);
    stateActions.setGameData(owner, 'overview', null);
    const card = Array.from($('accounts').children).find(row => row.accountId === owner);
    if (card) { card.readingProfile = null; card.nextProfileRead = 0; }
    const role = data.player || {};
    await loadAccounts(false);
    if (!$('tab-account').classList.contains('hidden')) refreshAccountCards();
    return '已在 ' + (role.worldName || worldId) + '：' + (role.nickname || '') + ' lv' + (role.level ?? '') + ' 战力' + fmt(role.power);
  });
}

$('account-worlds-close').onclick = () => $('account-worlds-dialog').close();
$('load-worlds').onclick = () => runWorldAction(worldManager, '正在加载区服…', renderWorlds);
$('enter-world').onclick = () => {
  const worldId = Number($('world-input').value.trim());
  if (!Number.isSafeInteger(worldId) || worldId <= 0) {
    $('worlds-hint').textContent = '请输入有效的区服 ID';
    return;
  }
  return enterWorld(worldManager, worldId);
};

// ---- 添加账号：从电脑微信采集登录 -----------------------------------------
let capturePoll = null;
let captureView = null;
let captureOwner = null;
let captureFlowVersion = 0;
let captureActionBusy = false;
let captureConfirmation = false;

function renderCapture(state) {
  captureView = state;
  const hint = $('cap-hint');
  const previousQr = $('cap-box').querySelector('img');
  const box = clear($('cap-box'));
  const recovery = state.recovery;
  const cleanupPending = state.phase === 'error' || recovery?.pending;
  const selectedChannel = accountAddChannel();
  const otherChannelRunning = state.running && ['wechat', 'douyin'].includes(selectedChannel) && state.platform !== selectedChannel;
  $('cap-start').disabled = captureActionBusy || state.running || cleanupPending;
  $('cap-douyin').disabled = captureActionBusy || state.running || cleanupPending;
  $('cap-stop').hidden = otherChannelRunning || (!state.running && state.phase !== 'error');
  $('cap-stop').disabled = captureActionBusy || $('cap-stop').hidden;
  $('cap-recover').hidden = !recovery?.pending;
  $('cap-recover').disabled = captureActionBusy || state.running || !recovery?.recoverable;
  const ownResult = captureOwner?.startedAt && captureOwner.startedAt === state.startedAt;
  const phase = cleanupPending || state.error ? 'error' : state.running ? state.phase : ownResult && state.accountId ? 'saved' : 'entry';
  const messages = { starting: '正在准备登录采集…', ca: '请完成 Windows 证书安装提示。', listening: '正在准备本机登录通道…', proxy: '正在准备本机登录通道…', waiting: '采集已就绪，请在电脑客户端中重新打开游戏。', captured: '已读取账号，正在完成验证和清理…', stopping: '正在恢复本机代理和证书设置…', saved: '账号已添加。可关闭此窗口，在账号卡片中查看角色和运行状态。', entry: '' };
  hint.textContent = state.error ? cleanupPending ? '采集清理未完成，请点击「停止读取」重试。' : state.failureHint || '本次读取失败，请重新开始或查看运行日志。' : messages[phase] || '';
  hint.className = state.error ? 'bad' : 'warn';
  if (otherChannelRunning) {
    const channelName = state.platform === 'douyin' ? '电脑抖音采集' : '微信小游戏';
    hint.textContent = '「' + channelName + '」正在采集，请返回该渠道查看进度。';
  } else if (recovery?.pending) {
    hint.textContent = !recovery.recoverable ? '无法自动恢复上次采集。请在控制台所在电脑运行 start-console.cmd status 查看原因。' : '请点击「恢复上次采集残留」还原本机设置。';
    hint.className = recovery.error ? 'bad' : 'warn';
  }
  const notice = $('account-add-notice');
  notice.hidden = !state.running && !cleanupPending;
  notice.textContent = notice.hidden ? '' : state.platform === 'douyin'
    ? '电脑抖音账号添加尚未完成，请点击「添加账号」并选择「电脑抖音采集」继续处理。'
    : '微信账号添加尚未完成，请点击「添加账号」并选择对应渠道继续处理。';

  if (!state.running && !cleanupPending && phase !== 'saved') {
    const clientName = accountAddChannel() === 'douyin' ? '抖音' : '微信';
    const steps = el('ol', 'steps');
    for (const text of ['先登录电脑版' + clientName + '。', '点击「开始读取」可再次查看并确认本次采集。', '等页面显示「采集已就绪」后，再按提示操作。']) {
      steps.appendChild(el('li', null, text));
    }
    box.appendChild(steps);
  }

  if (state.running && state.phase === 'waiting' && !otherChannelRunning) {
    const steps = el('ol', 'steps');
    const lines = [
      '先登录电脑版' + (state.platform === 'douyin' ? '抖音' : '微信') + '，再从该客户端打开《疯狂水世界》',
      '如果游戏已经打开，请完全退出后重新进入，让它重新发送登录请求',
      '捕获后保存凭证，并尝试读取角色验证登录；验证失败会显示在日志中',
      '完成、失败或等待超时后会自动恢复代理，只移除本次新安装的证书',
    ];
    for (const text of lines) steps.appendChild(el('li', null, text));
    const qr = el('div', 'qr');
    const side = el('div', null, '');
    if (state.platform !== 'douyin' && state.qr && state.qr.kind === 'image') {
      const img=previousQr?.dataset.url===state.qr.url?previousQr:el('img');
      if(!img.dataset.url){img.dataset.url=state.qr.url;img.src=state.qr.url+'?t='+Date.now();}
      img.alt = '游戏入口码（非扫码登录授权）';
      qr.appendChild(img);
    }
    if (state.platform !== 'douyin') side.appendChild(el('div', 'dim', state.qr?.note || '请在电脑微信中打开游戏。'));
    side.appendChild(steps);
    qr.appendChild(side);
    box.appendChild(qr);

  }
  if (typeof accountAddChanged === 'function') {
    const channel = ['wechat', 'douyin'].includes(selectedChannel) ? selectedChannel : state.platform === 'douyin' ? 'douyin' : 'wechat';
    accountAddChanged(channel, phase, { busy: captureActionBusy });
  }
}

async function pollCapture() {
  const version = captureFlowVersion;
  try {
    const state = await call('/api/capture');
    if (version !== captureFlowVersion) return;
    renderCapture(state);
    if (state.running && !capturePoll && ['wechat', 'douyin'].includes(accountAddChannel())) {
      capturePoll = setInterval(pollCapture, 1500);
    }
    if (!state.running && capturePoll) {
      clearInterval(capturePoll);
      capturePoll = null;
      await loadAccounts(false);
      renderAccounts();
    }
    return state;
  } catch (error) {
    if (version !== captureFlowVersion) return;
    $('cap-hint').textContent = '';
    reportError(error);
  }
}


$('cap-start').onclick = () => beginCapture('wechat');
$('cap-douyin').onclick = () => beginCapture('douyin');
$('cap-recover').onclick = async () => {
  if (captureActionBusy) return;
  captureActionBusy = true;
  if (captureView) renderCapture(captureView);
  try {
    renderCapture(await call('/api/capture/recover', { method: 'POST', body: JSON.stringify({ confirm: true }) }));
  } catch (error) {
    reportError(error);
    await pollCapture();
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
  }
};
async function beginCapture(platform) {
  if (captureActionBusy || accountAddChannel() !== platform) return;
  const version = ++captureFlowVersion;
  captureActionBusy = true;
  accountAddChanged(platform, 'checking', { busy: true });
  $('cap-hint').className = 'dim';
  $('cap-hint').textContent = '正在检查本机采集状态…';
  let state;
  try {
    state = await pollCapture();
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
    else accountAddChanged(platform, 'entry', { busy: false });
  }
  if (version !== captureFlowVersion || accountAddChannel() !== platform) return;
  if (!state) {
    $('cap-hint').className = 'bad';
    $('cap-hint').textContent = '暂时无法读取本机采集状态。请检查控制台连接后重新选择渠道。';
    return;
  }
  if (state.running || state.phase === 'error' || state.recovery?.pending) return;
  const body = [
    el('p', null, '控制台会读取并保存《疯狂水世界》的游戏登录凭据。验证角色时，正在玩的账号可能会下线。'),
    el('p', null, '采集期间会临时更改当前 Windows 用户的系统代理。使用系统代理的其他程序也会经过本机代理，工具仅解密本游戏网关的连接。'),
    el('p', null, '如需安装临时根证书，请在 Windows 安装提示中核对 CrazyWaterWorld Local Test CA。启动失败或采集结束时，工具会还原代理，并移除本次安装的证书。'),
  ];
  captureConfirmation = true;
  openConfirm(platform === 'douyin' ? '确认开始电脑抖音采集' : '确认开始电脑微信采集', body, async () => {
    captureConfirmation = false;
    if (version !== captureFlowVersion || accountAddChannel() !== platform || captureActionBusy) return;
    captureActionBusy = true;
    captureOwner = { platform, startedAt: null, previousStartedAt: state.startedAt };
    accountAddChanged(platform, 'starting', { busy: true });
    clear($('cap-box'));
    $('cap-hint').className = 'warn';
    $('cap-hint').textContent = '正在准备采集。若 Windows 弹出证书窗口，请核对是安装还是删除，以及证书名称。';
    try {
      const next = await call('/api/capture/start', { method: 'POST', body: JSON.stringify({ confirm: true, platform }) });
      captureOwner.startedAt = next.startedAt;
      renderCapture(next);
      if (capturePoll) clearInterval(capturePoll);
      if (next.running) capturePoll = setInterval(pollCapture, 1500);
      else { await loadAccounts(false); renderAccounts(); }
    } catch (error) {
      if (/已经在抓包/.test(error.message)) captureOwner = null;
      await pollCapture();
      throw error;
    } finally {
      captureActionBusy = false;
      if (captureView) renderCapture(captureView);
      else accountAddChanged(platform, 'error', { busy: false });
    }
  }, '同意并开始采集');
}

async function stopAccountCapture() {
  if (captureActionBusy) return false;
  captureActionBusy = true;
  if (captureView) renderCapture(captureView);
  try {
    const state = await call('/api/capture/stop', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    renderCapture(state);
    if (state.running || state.phase === 'error' || state.recovery?.pending) throw new Error(state.error || '采集清理未完成，请重试停止。');
    clearInterval(capturePoll);
    capturePoll = null;
    await loadAccounts(false);
    renderAccounts();
    return true;
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
  }
}
$('cap-stop').onclick = stopAccountCapture;

async function resetAccountAddCapture() {
  if (captureActionBusy) return false;
  captureActionBusy = true;
  captureFlowVersion++;
  clearInterval(capturePoll);
  capturePoll = null;
  if (captureConfirmation && $('modal').open) closeModal();
  captureConfirmation = false;
  try {
    if (captureView) renderCapture(captureView);
    if (captureOwner) {
      const state = await call('/api/capture');
      const ownRun = captureOwner.startedAt ? state.startedAt === captureOwner.startedAt
        : state.platform === captureOwner.platform && state.startedAt !== captureOwner.previousStartedAt;
      captureActionBusy = false;
      if (ownRun && (state.running || state.phase === 'error')) await stopAccountCapture();
    }
    captureOwner = null;
    clear($('cap-box'));
    $('cap-hint').textContent = '';
    return true;
  } finally {
    captureActionBusy = false;
    if (captureView) renderCapture(captureView);
  }
}

// ---- APP 账号登录 ---------------------------------------------------------
${phoneLoginScript}

// ---- 支付宝扫码登录 --------------------------------------------------------
${alipayLoginScript}
${wechatLoginScript}

// ---- 添加账号引导 ----------------------------------------------------------
${accountAddScript}

// ---- 页头账号选择 ----------------------------------------------------------
${accountPickerScript}

// ---- 启动 ------------------------------------------------------------------
${lineupScript}
${progressionScript}
${helpTipsScript}
${mapMotionPosition.toString()}
${worldMapScript}
${siliconOverviewScript}
${resourceFieldsScript}
${inventoryScript}
${productionPlanningScript}
${settingsScript}
${settingsHistoryScript}
${giftCodeScript}
window.addEventListener('beforeunload', event => {
  if (stalePageReloadRequested) {
    stalePageReloadRequested = false;
    return;
  }
  if (configIsDirty() || configEditor.saving) {
    event.preventDefault();
    event.returnValue = '';
  }
});
let selectedResource = 'guild';
consoleStore.subscribe((state, previous) => {
  if (state.view.resource !== previous.view.resource) selectedResource = state.view.resource;
});
function activateConsolePage(button, resource = selectedResource) {
    const isResource = button.dataset.tab === 'resources';
    const target = isResource ? resource : button.dataset.tab;
    // 当前历史记录随刷新保留；离开锚点对应的页面时移除旧地址。
    const staleAnchor = (target !== 'settings' && location.hash.startsWith('#config-group-'))
      || (target !== 'stages' && location.hash === '#pirate-first-kill')
      || (target !== 'overview' && location.hash === '#journal');
    const url = staleAnchor ? location.pathname + location.search : location.href;
    history.replaceState({ ...history.state, consoleView: { tab: button.dataset.tab, resource } }, '', url);
    stateActions.setView({ page: target, ...(isResource ? { resource } : {}) });
    $('resource-tabs').hidden = !isResource;
    for (const tab of document.querySelectorAll('[data-resource-tab]')) {
      const selected = tab.dataset.resourceTab === target;
      tab.setAttribute('aria-current', selected ? 'page' : 'false');
      if (selected && isResource) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    closeHelpTip(false);
    for (const other of document.querySelectorAll('#tabs button')) other.removeAttribute('aria-current');
    button.setAttribute('aria-current', 'page');
    for (const section of document.querySelectorAll('main > section')) {
      section.classList.toggle('hidden', section.id !== 'tab-' + target);
    }
    refreshProgression();
    if (button.dataset.tab === 'overview') {refreshOverview();refreshLoop();}
    if(isResource&&resource==='inventory')refreshManualWorld();
    if (target === 'lineups') void refreshSavedLineups();
    if (button.dataset.tab === 'account') {
      renderAccounts();
      refreshAccountCards();
      pollCapture();
    }
    if (target === 'manual') {
      refreshManualWorld();
      void refreshProductionPlan();
    }
    if (button.dataset.tab === 'settings') {
      if (!location.hash.startsWith('#config-group-')) configActivate(configEditor.category);
      void configLoad(); void refreshLoop();
    }
    if(target==='giftcodes')void refreshGiftCodes();
    if (target === 'activities') refreshActivities();
    if (button.dataset.tab === 'stages') {refreshStages();void refreshSavedLineups();}
}
document.querySelectorAll('#tabs button').forEach(button => { button.onclick = () => activateConsolePage(button); });
for(const link of document.querySelectorAll('a[href^="#config-group-"]'))link.onclick=event=>{if(location.hash===link.getAttribute('href')){event.preventDefault();activateConsolePage(document.querySelector('#tabs [data-tab="settings"]'));configApplyHash();}};
document.querySelectorAll('[data-resource-tab]').forEach(button => { button.onclick = () => activateConsolePage(document.querySelector('#tabs [data-tab="resources"]'), button.dataset.resourceTab); });
${consoleQuickScript}

// 配置页工具栏吸在页头下方；页头高度随触屏尺寸和提示文字变化，手机上页头不吸顶。
new ResizeObserver(() => {
  const header = document.querySelector('header');
  document.documentElement.style.setProperty('--header-h', (getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0) + 'px');
}).observe(document.querySelector('header'));

async function boot() {
  // 显式链接优先，否则恢复当前历史记录的页面；配置分组由 configApplyHash 恢复。
  const previousView = history.state?.consoleView;
  const savedView = ['chat', 'items', 'season-preview'].includes(previousView?.tab)
    ? { tab: 'resources', resource: previousView.tab } : previousView;
  const initialTab = location.hash.startsWith('#config-group-') ? 'settings'
    : location.hash === '#pirate-first-kill' ? 'stages' : location.hash === '#journal' ? 'overview'
    : savedView?.tab === 'login-settings' ? 'account'
    : savedView?.tab === 'resources' && savedView.resource === 'activities' ? 'activities' : savedView?.tab;
  try {
    // 恢复账号页时先显示保存的角色资料，由该页按连接状态决定是否读取资源。
    await loadAccounts(true, initialTab !== 'account'
      && !(initialTab === 'resources' && ['shops', 'season-preview', 'chat', 'items'].includes(savedView?.resource)));
  } catch (error) {
    reportError(error);
    return;
  }
  const button = [...document.querySelectorAll('#tabs button')].find(tab => tab.dataset.tab === initialTab)
    || document.querySelector('#tabs [data-tab="overview"]');
  const resource = [...document.querySelectorAll('[data-resource-tab]')].some(tab => tab.dataset.resourceTab === savedView?.resource)
    ? savedView.resource : selectedResource;
  activateConsolePage(button, resource);
  if (location.hash === '#journal') openJournal();
  pollCapture();
}
// Coalesce related mutations before painting every account surface. The store
// subscription also covers writes made by React or another subscribed view.
let accountPaintPending = false;
consoleStore.subscribe((state, previous) => {
  if (state.accountsById !== previous.accountsById || state.currentAccountId !== previous.currentAccountId
      || state.connecting !== previous.connecting || state.disconnected !== previous.disconnected || state.hosting !== previous.hosting) {
    if (!accountPaintPending) {
      accountPaintPending = true;
      queueMicrotask(() => { accountPaintPending = false; renderAccountSelect(); });
    }
  }
  if (state.view !== previous.view) {
    if (state.view.logAccount !== previous.view.logAccount || state.view.logGroup !== previous.view.logGroup
        || state.view.logFeature !== previous.view.logFeature || state.view.onlyIssues !== previous.view.onlyIssues) {
      $('journal').classList.toggle('issues', state.view.onlyIssues);
      $('log-all').setAttribute('aria-pressed', String(!state.view.onlyIssues));
      $('log-issues').setAttribute('aria-pressed', String(state.view.onlyIssues));
      updateLogSummary();
    }
  }
});
boot();
setInterval(refreshOverview, 20000);
setInterval(() => { if (!document.hidden && accounts.some(account => account.status?.reconnecting)) paintConnection(); }, 1000);
document.addEventListener('visibilitychange',()=>{
  if (document.hidden) return;
  void refreshAccountStatuses(); refreshLoop(); refreshStages();
  if (consoleStore.getState().view.page === 'manual') void refreshProductionPlan();
});
setInterval(() => { void refreshAccountStatuses(); if (!loopReads) refreshLoop(); }, 3000);
setInterval(refreshStages, 3000);
</script>
<script type="module" src="/ui/console-client.js"></script>
</body>
</html>`;
