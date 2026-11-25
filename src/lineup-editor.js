// Saved formations and editor drafts belong to an account, including in-flight requests.
const savedLineupAccounts = new Map();
let lineupModal = null;
let lineupSource = 'game';
let gamePageConnection = '';

function savedLineupState(account) {
  if (!savedLineupAccounts.has(account)) savedLineupAccounts.set(account, {
    saved: null, editor: null, drafts: new Map(), activeDraft: null,
    readSerial: 0, editorSerial: 0, loading: false, saving: false, readError: '',
    message: '', error: false,
    bindingPending: new Map(), bindingSave: null, bindingError: '',
    selectedHeroId: null, query: '', faction: '', career: '', ui: null,
    gameTargets: null, gameLoading: false, gameSerial: 0, gameMessage: '',
  });
  return savedLineupAccounts.get(account);
}

function lineupRequest(path, account, body) {
  return call(path + (path.includes('?') ? '&' : '?') + 'account=' + encodeURIComponent(account), body === undefined ? undefined
    : { method: 'POST', body: JSON.stringify({ ...body, confirm: true }) });
}

function showLineupSource(source) {
  lineupSource = source;
  const game = source === 'game';
  $('game-lineup-pane').hidden = !game;
  $('saved-lineup-pane').hidden = game;
  $('game-lineup-refresh').hidden = !game;
  $('saved-lineup-actions').hidden = game;
  $('lineup-show-game').setAttribute('aria-pressed', String(game));
  $('lineup-show-presets').setAttribute('aria-pressed', String(!game));
  if (game) syncGameLineupPage(true);
}

if ($('game-lineup-view')) {
  $('lineup-show-game').onclick = () => showLineupSource('game');
  $('lineup-show-presets').onclick = () => showLineupSource('presets');
  $('game-lineup-refresh').onclick = () => refreshGameLineups(current);
  $('saved-lineup-create').onclick = () => { if (current) openSavedLineupEditor(current); };
  $('saved-lineup-capture').onclick = () => { if (current) captureSavedLineup(current); };
}

function syncGameLineupPage(force = false) {
  if (!$('game-lineup-view') || $('tab-lineups').classList.contains('hidden')) return;
  const ready = current && snapshot.connected && !snapshot.paused;
  const key = JSON.stringify([current, !!ready]);
  if (!force && gamePageConnection === key) return;
  gamePageConnection = key;
  lineupAccountChanged();
  if (!ready) {
    if (current) {
      const state = savedLineupState(current);
      state.gameSerial++; state.gameTargets = null; state.gameLoading = false; state.gameMessage = '';
      if (currentLineupDraft(state)?.target) redrawLineupEditor(state, current);
    }
    clear($('game-lineup-view')); $('game-lineup-refresh').disabled = true;
    $('game-lineup-status').textContent = current ? '连接游戏后可查看当前队伍。' : '请先选择账号';
    return;
  }
  if (lineupSource === 'game') void refreshGameLineups(current);
}

async function refreshGameLineups(account) {
  if (!account || account !== current || !snapshot.connected || snapshot.paused) return;
  const state = savedLineupState(account), serial = ++state.gameSerial;
  state.gameLoading = true; state.gameMessage = '';
  renderGameLineups(account);
  try {
    const { targets, catalog } = await lineupRequest('/api/lineups/game', account);
    if (serial === state.gameSerial) { state.gameTargets = targets; state.gameCatalog = catalog; }
  } catch (error) {
    if (serial === state.gameSerial) { state.gameTargets = null; state.gameMessage = error.message; }
  } finally {
    if (serial === state.gameSerial) {
      state.gameLoading = false; renderSavedLineups(account);
      if (currentLineupDraft(state)?.target) redrawLineupEditor(state, account);
    }
  }
}

function renderGameLineups(account) {
  const host = $('game-lineup-view');
  if (!host || account !== current || !snapshot.connected || snapshot.paused) return;
  const state = savedLineupState(account);
  const previousFocus = host.contains(document.activeElement) && document.activeElement.getAttribute('aria-label');
  clear(host);
  $('game-lineup-refresh').disabled = state.gameLoading || state.saving;
  const status = $('game-lineup-status');
  status.textContent = state.gameMessage || (state.gameLoading && !state.gameTargets ? '正在读取游戏阵容…' : '');
  const categories = new Map();
  for (const target of state.gameTargets || []) {
    if (!categories.has(target.mode)) categories.set(target.mode, []);
    categories.get(target.mode).push(target);
  }
  for (const [mode, teams] of categories) {
    const name = state.gameCatalog?.modeNames?.[mode];
    const category = el('section', 'game-lineup-category'), grid = el('div', 'game-lineup-grid');
    category.setAttribute('aria-label', name || teams[0].title);
    if (teams.length > 1 && name) category.append(el('h2', '', name));
    for (const team of teams) {
      const title = teams.length > 1 && name && team.title.startsWith(name) ? team.title.slice(name.length).trim() : '';
      grid.append(gameLineupCard(account, state, team, title || team.title));
    }
    category.append(grid); host.append(category);
  }
  if (previousFocus) [...host.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === previousFocus)?.focus({ preventScroll: true });
}

function lineupMembers(formation, display) {
  const strip = el('div', 'game-lineup-members');
  for (const slot of formation.heroPositions) {
    const hero = lineupHero(display, slot.heroId), member = el('div', 'game-lineup-member');
    const portrait = lineupPortrait(hero, 36);
    portrait.setAttribute('aria-hidden', 'true');
    member.append(portrait, el('span', '', hero.name)); strip.append(member);
  }
  if (!formation.heroPositions.length) strip.append(el('span', 'dim', '尚未编入英雄'));
  return strip;
}

function lineupFormationLabel(formation, catalog) {
  const type = catalog?.formations?.find(item => item.presetId === formation.presetId);
  return (type?.name || '阵型 ' + formation.presetId) + ' · ' + formation.heroPositions.length + ' 人上阵';
}

function gameLineupCard(account, state, target, title) {
  const card = el('article', 'game-lineup-card');
  card.dataset.gameTeam = target.key;
  const heading = el('div', 'game-lineup-heading');
  heading.append(el('h3', '', title)); card.append(heading);
  if (target.formation) {
    const formation = target.formation;
    const catalog = state.gameCatalog || state.editor || state.saved?.catalog;
    heading.append(el('p', 'dim', lineupFormationLabel(formation, catalog)));
    if (target.reason || target.hint) {
      heading.append(el('p', target.reason ? 'lineup-restriction' : 'dim', target.reason || target.hint));
    }
    card.append(lineupMembers(formation, { editor: catalog, saved: state.saved }));
    if (target.mode !== 'fleet' && formation.petUid !== '0') {
      const pet = catalog?.pets?.find(item => item.uid === formation.petUid);
      card.append(el('p', 'dim', '海兽 · ' + (pet?.name || formation.petUid)));
    }
    const footer = el('div', 'game-lineup-actions');
    const detail = smallButton('查看'), edit = smallButton('编辑');
    detail.setAttribute('aria-label', '查看' + target.title); edit.setAttribute('aria-label', '编辑' + target.title);
    detail.onclick = () => {
      const modal = openLineupDialog(account, 'viewer', target.key);
      renderLineupViewer(modal.body, state, { id: target.key, name: target.title, formation }, account,
        { showPet: target.mode !== 'fleet', capture: true, displayCatalog: catalog });
      modal.dialog.showModal();
    };
    edit.disabled = state.saving || state.gameLoading || !!target.reason;
    edit.onclick = () => openSavedLineupEditor(account, null, target);
    footer.append(detail, edit);
    card.append(footer);
  } else {
    card.classList.add('unavailable');
    card.append(el('p', 'dim', target.reason || '尚未开放'));
  }
  return card;
}

function configuredLineupId(account, key) {
  const state = savedLineupState(account);
  if (state.bindingPending.has(key)) return state.bindingPending.get(key).value;
  return key === 'mainline' ? state.saved?.mainlinePresetId || ''
    : state.saved?.trialPresets?.find(binding => 'trial:' + binding.raidId === key)?.presetId || '';
}

function selectedLineupId(mode, raidId) {
  return configuredLineupId(current, mode === 'trial' ? 'trial:' + raidId : 'mainline');
}

function paintLineupChoiceStatus(node, state) {
  node.textContent = state.bindingPending.size ? '正在保存阵容选择…' : state.bindingError;
  node.hidden = !node.textContent;
  node.className = state.bindingError && !state.bindingPending.size ? 'warn' : 'dim';
}

function createLineupChoiceStatus(account) {
  const node = el('span'); node.dataset.lineupChoiceStatus = account;
  node.setAttribute('role', 'status');
  paintLineupChoiceStatus(node, savedLineupState(account));
  return node;
}

function saveChallengeLineup(account, key, value) {
  if (!account || account !== current) return Promise.resolve();
  const state = savedLineupState(account);
  state.bindingPending.set(key, { value }); state.bindingError = '';
  updateManualLineupSelects(account);
  if (state.bindingSave) return state.bindingSave;
  const job = (async () => {
    while (state.bindingPending.size) {
      const changes = new Map(state.bindingPending);
      try {
        // Merge only the changed choices into the latest account configuration.
        // Serialize saves so changing another trial cannot overwrite an in-flight choice.
        for (let attempt = 0; attempt < 2; attempt++) {
          const latest = await lineupRequest('/api/lineup-presets', account);
          adoptSavedLineups(state, latest);
          let mainlinePresetId = latest.mainlinePresetId || '';
          const trials = new Map((latest.trialPresets || []).map(binding => [binding.raidId, binding.presetId]));
          for (const [mode, choice] of changes) {
            if (mode === 'mainline') mainlinePresetId = choice.value;
            else if (choice.value) trials.set(mode.slice(6), choice.value);
            else trials.delete(mode.slice(6));
          }
          try {
            const data = await lineupRequest('/api/lineup-presets/bind', account, {
              revision: latest.revision, mainlinePresetId,
              trialPresets: [...trials].map(([raidId, presetId]) => ({ raidId, presetId })),
            });
            adoptSavedLineups(state, data);
            state.bindingError = '';
            break;
          } catch (error) {
            if (!error.fields?.revision || attempt === 1) throw error;
          }
        }
      } catch (error) {
        // A lost response may still have saved successfully. Re-read before rolling back the UI.
        try { adoptSavedLineups(state, await lineupRequest('/api/lineup-presets', account)); } catch {}
        state.bindingError = '阵容选择保存失败：' + error.message + '。请重新选择后重试。';
      }
      for (const [mode, choice] of changes) {
        if (state.bindingPending.get(mode) === choice) state.bindingPending.delete(mode);
      }
      if (account === current) updateManualLineupSelects(account);
    }
  })();
  state.bindingSave = job.finally(() => { state.bindingSave = null; });
  return state.bindingSave;
}

function fillLineupSelect(select, presets, value) {
  select.replaceChildren();
  select.add(new Option('使用游戏当前阵容', ''));
  for (const preset of presets) select.add(new Option(preset.name, preset.id));
  if (value && !presets.some(preset => preset.id === value)) {
    select.add(new Option('已删除的阵容，请重新选择', value));
  }
  select.value = value;
  select.lineupPreviewUpdate?.();
}

function createLineupPreviewButton(account, select) {
  const button = smallButton('查看');
  button.setAttribute('aria-label', '查看所选阵容');
  const update = () => {
    const exists = savedLineupState(account).saved?.presets.some(preset => preset.id === select.value);
    button.disabled = account !== current || !select.value || !exists;
    button.title = select.value && !exists ? '该阵容已删除，请重新选择' : '';
  };
  select.addEventListener('change', update);
  select.lineupPreviewUpdate = update;
  button.onclick = () => { if (!button.disabled) void openSavedLineupViewer(account, select.value); };
  update();
  return button;
}

function createLineupSelect(account, mode, raidId) {
  const select = el('select', 'saved-lineup-select');
  const key = mode === 'trial' ? 'trial:' + raidId : 'mainline';
  select.dataset.lineupAccount = account;
  select.dataset.lineupMode = key;
  select.setAttribute('aria-label', mode === 'trial' ? '试炼挑战阵容' : '主线挑战阵容');
  fillLineupSelect(select, savedLineupState(account).saved?.presets || [], configuredLineupId(account, key));
  select.onchange = () => saveChallengeLineup(account, key, select.value);
  return select;
}

function updateManualLineupSelects(account) {
  const state = savedLineupState(account), presets = state.saved?.presets || [];
  for (const select of document.querySelectorAll('select[data-lineup-mode]')) {
    if (select.dataset.lineupAccount !== account) continue;
    fillLineupSelect(select, presets, configuredLineupId(account, select.dataset.lineupMode));
  }
  for (const node of document.querySelectorAll('[data-lineup-choice-status]')) {
    if (node.dataset.lineupChoiceStatus === account) paintLineupChoiceStatus(node, state);
  }
  if(account===current && $('pirate-manual-lineup') && typeof paintManualPirateButtons==='function')paintManualPirateButtons();
}

function adoptSavedLineups(state, data) {
  if (state.saved && data.revision < state.saved.revision) return;
  state.saved = data;
}

async function refreshSavedLineups(account = current) {
  lineupAccountChanged();
  const host = $('saved-lineup-view');
  if (!host) return;
  if (!account) {
    delete host.dataset.owner; host.textContent = '请先选择账号';
    $('saved-lineup-actions').disabled = true;
    if ($('lineup-page-recovery')) clear($('lineup-page-recovery'));
    return;
  }
  const state = savedLineupState(account), serial = ++state.readSerial;
  if (host.dataset.owner !== account) {
    host.dataset.owner = account;
    renderSavedLineups(account);
  }
  try {
    const data = await lineupRequest('/api/lineup-presets', account);
    if (serial !== state.readSerial) return;
    const clearedReadError = state.readError && state.message === state.readError;
    if (clearedReadError) { state.message = ''; state.error = false; }
    state.readError = '';
    const unchanged = JSON.stringify(state.saved) === JSON.stringify(data);
    const contentUnchanged = state.saved && ['presets', 'catalog', 'mainlinePresetId', 'trialPresets']
      .every(key => JSON.stringify(state.saved[key]) === JSON.stringify(data[key]));
    adoptSavedLineups(state, data);
    if (account !== current) return;
    if (!contentUnchanged) updateManualLineupSelects(account);
    if (!unchanged || clearedReadError) {
      if (contentUnchanged && !clearedReadError && state.recoveryHost?.isConnected) {
        clear(state.recoveryHost);
        renderLineupRecovery(state.recoveryHost, state, account);
      } else renderSavedLineups(account);
    }
  } catch (error) {
    if (serial !== state.readSerial || account !== current) return;
    state.message = state.readError = error.message; state.error = true;
    renderSavedLineups(account);
  }
}

function lineupSummary(formation, state) {
  if (!formation) return '尚未读取';
  const catalog = state.editor || state.saved?.catalog;
  const heroes = new Map((catalog?.heroes || []).map(hero => [hero.heroId, hero.name]));
  const type = catalog?.formations?.find(item => item.presetId === formation.presetId);
  const names = (formation.heroPositions || []).map(item => heroes.get(item.heroId) || item.heroId);
  const petUid = String(formation.petUid || '0');
  const pet = petUid !== '0' && state.editor?.pets?.find(item => String(item.uid) === petUid);
  return [type?.name || '阵型 ' + formation.presetId, names.join('、') || '空阵容',
    pet ? pet.name : petUid !== '0' ? '携带海兽' : ''].filter(Boolean).join(' · ');
}

async function mutateSavedLineups(account, path, body) {
  const state = savedLineupState(account);
  if (state.saving || account !== current) return null;
  const recovering = path.endsWith('/recover');
  state.saving = true; state.message = recovering ? '正在核对阵容恢复…' : '正在保存…'; state.error = false;
  ++state.readSerial;
  renderSavedLineups(account);
  redrawLineupEditor(state, account);
  try {
    const data = await lineupRequest(path, account, { revision: state.saved?.revision ?? 0, ...body });
    adoptSavedLineups(state, data);
    state.message = recovering ? '已完成阵容核对' : '';
    if (account === current) updateManualLineupSelects(account);
    return data;
  } catch (error) {
    state.message = error.message; state.error = true;
    return null;
  } finally {
    state.saving = false;
    if (account === current) { renderSavedLineups(account); redrawLineupEditor(state, account); }
  }
}

async function captureSavedLineup(account) {
  const state = savedLineupState(account);
  const name = await accountDialog('保存当前主线阵容', '预设名称', state.captureName || '主线阵容');
  if (name === null || account !== current) return;
  state.captureName = name;
  if (!name.trim()) { state.message = '请输入阵容名称'; state.error = true; renderSavedLineups(account); return; }
  await mutateSavedLineups(account, '/api/lineup-presets/capture', { name: name.trim() });
}

function renderLineupRecovery(host, state, account) {
  const recovery = state.saved?.recovery;
  if (!recovery || recovery.pending === false) return;
  const conflict = recovery.phase === 'conflict' || recovery.status === 'conflict' || recovery.conflict === true;
  if (!conflict && recovery.phase !== 'pending') return;
  const section = el('section', 'saved-lineup-recovery');
  section.setAttribute('aria-label', '阵容恢复');
  section.append(el('strong', '', conflict ? '阵容恢复需要处理' : '阵容待恢复'));
  const reason = recovery.reason || recovery.message;
  if (reason) section.append(el('p', '', reason));
  const original = recovery.original || recovery.before;
  const target = recovery.target;
  if (original) section.append(el('p', 'dim', '原阵容 · ' + lineupSummary(original, state)));
  if (target) section.append(el('p', 'dim', '挑战阵容 · ' + lineupSummary(target, state)));
  const actions = el('div', 'bar');
  const resolve = (label, resolution) => {
    const button = smallButton(label); button.disabled = state.saving;
    button.onclick = () => mutateSavedLineups(account, '/api/lineup-presets/recover', {
      resolution, expectedTransactionId: recovery.transactionId || recovery.id,
    });
    return button;
  };
  actions.append(resolve('重试恢复', 'auto'));
  if (conflict) {
    actions.append(resolve('恢复原始阵容', 'restore'), resolve('保留游戏当前阵容', 'keep'));
  }
  section.append(actions); host.append(section);
}

function renderSavedLineups(account) {
  if (account !== current) return;
  const host = $('saved-lineup-view');
  if (!host) return;
  const state = savedLineupState(account);
  renderGameLineups(account);
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  const focusLabel = active?.getAttribute('aria-label');
  const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  clear(host); host.dataset.owner = account;
  $('saved-lineup-actions').disabled = state.saving || !state.saved;
  const status = el('p', state.error ? 'warn' : 'dim', state.message || (state.saved ? '' : '正在读取已保存阵容…'));
  status.setAttribute('role', 'status');
  if (status.textContent) host.append(status);
  state.recoveryHost = el('div', 'saved-lineup-recovery-host');
  renderLineupRecovery(state.recoveryHost, state, account);
  const recoveryPanel = $('lineup-page-recovery');
  if (recoveryPanel) clear(recoveryPanel).append(state.recoveryHost);
  else host.append(state.recoveryHost);
  const list = el('div', 'saved-lineup-list');
  const catalog = state.editor || state.gameCatalog || state.saved?.catalog;
  for (const preset of state.saved?.presets || []) {
    const row = el('article', 'saved-lineup-row'), info = el('div', 'saved-lineup-info'), title = el('h3');
    row.dataset.lineupPreset = preset.id;
    const view = component('ui-saved-lineup-name');
    view.firstElementChild.textContent = preset.name;
    view.setAttribute('aria-label', '查看阵容 ' + preset.name);
    view.onclick = () => openSavedLineupViewer(account, preset.id);
    title.append(view);
    info.append(title, el('p', 'dim', lineupFormationLabel(preset.formation, catalog)));
    const petUid = String(preset.formation.petUid || '0');
    if (petUid !== '0') {
      const pet = catalog?.pets?.find(item => String(item.uid) === petUid);
      const petInfo = el('p', 'dim', pet ? '海兽 · ' + pet.name : '携带海兽');
      petInfo.title = '海兽 UID ' + petUid;
      info.append(petInfo);
    }
    const actions = el('div', 'saved-lineup-row-actions'), edit = smallButton('编辑'), remove = component('ui-saved-lineup-delete');
    edit.disabled = remove.disabled = state.saving;
    edit.setAttribute('aria-label', '编辑阵容 ' + preset.name);
    remove.setAttribute('aria-label', '删除阵容 ' + preset.name);
    remove.title = '删除预设';
    edit.onclick = () => openSavedLineupEditor(account, preset);
    remove.onclick = () => openConfirm('删除阵容', [el('p', '', '删除「' + preset.name + '」并清除它的自动挑战绑定。')], async () => {
      if (account !== current) return;
      const data = await mutateSavedLineups(account, '/api/lineup-presets/delete', { id: preset.id });
      if (!data) return;
      state.drafts.delete(preset.id);
      if (state.activeDraft === preset.id) state.activeDraft = null;
      adoptSavedLineups(state, data);
      if (account === current) renderSavedLineups(account);
    });
    actions.append(edit, remove);
    row.append(info, lineupMembers(preset.formation, { editor: catalog, saved: state.saved }), actions);
    list.append(row);
  }
  if (state.saved && !state.saved.presets.length) {
    const empty = el('div', 'saved-lineup-empty');
    empty.append(el('strong', '', '还没有预设'), el('p', 'dim', '保存后，可在游戏队伍、主线和试炼中使用。'));
    list.append(empty);
  }
  host.append(list);
  if (focusLabel) {
    const target = [...host.querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === focusLabel);
    target?.focus({ preventScroll: true });
    if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
  }
}

function closeLineupDialog(restoreFocus = true) {
  const modal = lineupModal;
  if (!modal) return;
  lineupModal = null;
  if (modal.mode === 'editor') {
    const state = savedLineupState(modal.account);
    if (currentLineupDraft(state)?.target) state.drafts.delete(state.activeDraft);
    state.activeDraft = null; state.ui = null;
  }
  modal.dialog.close(); modal.dialog.remove();
  document.body.classList.remove('lineup-modal-open');
  if (!restoreFocus || modal.account !== current) return;
  const row = [...document.querySelectorAll('[data-lineup-preset]')].find(item => item.dataset.lineupPreset === modal.presetId);
  const gameRow = [...document.querySelectorAll('[data-game-team]')].find(item => item.dataset.gameTeam === modal.presetId);
  const fallback = gameRow?.querySelector(modal.mode === 'viewer' ? 'button' : 'button:last-child')
    || row?.querySelector(modal.mode === 'viewer' ? 'button[aria-label^="查看阵容"]' : 'button[aria-label^="编辑阵容"]') || $('saved-lineup-create');
  (modal.returnFocus?.isConnected ? modal.returnFocus : fallback)?.focus({ preventScroll: true });
}

function lineupAccountChanged() {
  if (lineupModal && lineupModal.account !== current) closeLineupDialog(false);
}

function openLineupDialog(account, mode, presetId) {
  const returnFocus = document.activeElement;
  closeLineupDialog(false);
  const dialog = el('dialog', 'lineup-dialog'); dialog.id = 'saved-lineup-dialog';
  dialog.dataset.lineupMode = mode;
  dialog.setAttribute('aria-labelledby', 'lineup-dialog-title');
  const body = el('div', 'lineup-dialog-body'); dialog.append(body);
  const modal = { dialog, body, account, mode, presetId, returnFocus };
  lineupModal = modal;
  dialog.oncancel = event => { event.preventDefault(); closeLineupDialog(); };
  dialog.onclose = () => { if (lineupModal === modal) closeLineupDialog(); };
  document.body.append(dialog); document.body.classList.add('lineup-modal-open');
  return modal;
}

function lineupDialogCloseButton(mode) {
  const close = smallButton('关闭');
  close.setAttribute('aria-label', mode === 'viewer' ? '关闭阵容查看' : '关闭阵容编辑器');
  close.onclick = () => closeLineupDialog();
  return close;
}

async function openSavedLineupEditor(account, preset, target = null) {
  if (account !== current) return;
  const state = savedLineupState(account), key = target ? Symbol(target.key) : preset?.id || 'new';
  if (target) state.drafts.set(key, { target, name: target.title, formation: structuredClone(target.formation), dirty: false });
  else if (!state.drafts.has(key)) state.drafts.set(key, {
    id: preset?.id, name: preset?.name || '',
    formation: structuredClone(preset?.formation || { presetId: 1, heroPositions: [], petUid: '0' }),
    dirty: false,
  });
  const modal = openLineupDialog(account, 'editor', target?.key || preset?.id);
  state.activeDraft = key; state.selectedHeroId = null; state.editorMessage = '';
  renderLineupEditor(modal.body, state, account); modal.dialog.showModal();
  if (target || state.loading || !state.editor || state.editorScope === 'fleet') await loadLineupEditorData(account);
}

async function loadLineupEditorData(account) {
  const state = savedLineupState(account), serial = ++state.editorSerial;
  state.loading = true; state.editorError = '';
  if (account === current) redrawLineupEditor(state, account);
  try {
    const target = currentLineupDraft(state)?.target;
    const scope = target?.mode === 'fleet' ? 'fleet' : target ? 'game' : '';
    const data = await lineupRequest('/api/lineup-editor' + (scope ? '?scope=' + scope : ''), account);
    if (serial !== state.editorSerial) return;
    state.editor = data; state.editorScope = scope;
    if (Array.isArray(data.presets)) {
      const { presets, mainlinePresetId, trialPresets, revision, recovery, trialRaids } = data;
      adoptSavedLineups(state, { ...state.saved, presets, revision, recovery,
        mainlinePresetId: mainlinePresetId ?? state.saved?.mainlinePresetId ?? '',
        trialPresets: trialPresets ?? state.saved?.trialPresets ?? [],
        trialRaids: trialRaids ?? state.saved?.trialRaids ?? [] });
    }
    if (account === current) updateManualLineupSelects(account);
  } catch (error) {
    if (serial === state.editorSerial) state.editorError = error.message;
  } finally {
    if (serial === state.editorSerial) {
      state.loading = false;
      if (account === current) { renderSavedLineups(account); redrawLineupEditor(state, account); }
    }
  }
}

function openSavedLineupViewer(account, presetId) {
  if (presetId) return openLineupViewer(account, { presetId });
}

async function openLineupViewer(account, { presetId, buildingId, fleetName, fleetPreview = false }) {
  if (account !== current) return;
  const modal = openLineupDialog(account, 'viewer', presetId);
  const loading = el('section', 'lineup-editor lineup-viewer');
  const titleText = buildingId ? fleetName + ' · 当前阵容' : '查看阵容';
  const heading = el('div', 'lineup-editor-heading'), title = el('h3', '', titleText);
  title.id = 'lineup-dialog-title';
  heading.append(title, lineupDialogCloseButton('viewer'));
  const message = el('p', 'lineup-viewer-message', buildingId ? '正在读取舰队当前阵容…' : '正在读取已保存阵容…');
  message.setAttribute('role', 'status');
  loading.append(heading, message);
  modal.body.append(loading); modal.dialog.showModal();
  try {
    const data = buildingId
      ? await call('/api/fleets/current-formation?' + new URLSearchParams({ account, buildingId }))
      : await lineupRequest('/api/lineup-presets', account);
    if (lineupModal !== modal || account !== current) return;
    const state = savedLineupState(account);
    if (buildingId) {
      if (!data.formation) { message.textContent = '这支舰队尚未编入英雄。'; return; }
      renderLineupViewer(clear(modal.body), { saved: { catalog: data.catalog }, editor: state.editor },
        { id: buildingId, name: titleText, formation: data.formation }, account, { showPet: false });
      return;
    }
    adoptSavedLineups(state, data);
    renderSavedLineups(account); updateManualLineupSelects(account);
    const preset = state.saved.presets.find(item => item.id === presetId);
    if (!preset) throw new Error('该阵容已删除，请重新选择');
    clear(modal.body); renderLineupViewer(modal.body, state, preset, account, {showPet:!fleetPreview});
  } catch (error) {
    if (lineupModal !== modal || account !== current) return;
    message.textContent = error.message;
  }
}

function renderLineupViewer(host, state, preset, account, { showPet = true, capture = false, displayCatalog } = {}) {
  const catalog = displayCatalog || state.saved?.catalog || state.editor || { heroes: [], formations: [] };
  const display = { editor: displayCatalog || state.editor || catalog, saved: state.saved };
  const formation = preset.formation;
  const root = el('section', 'lineup-editor lineup-viewer'); root.id = 'saved-lineup-viewer';
  const heading = el('div', 'lineup-editor-heading'), title = el('h3', '', preset.name);
  title.id = 'lineup-dialog-title'; heading.append(title, lineupDialogCloseButton('viewer')); root.append(heading);
  const workspace = el('div', 'lineup-workspace'), battlefield = el('div', 'lineup-battlefield');
  const count = el('div', 'lineup-board-heading');
  count.append(el('span', '', '已上阵 ' + formation.heroPositions.length), el('span', '', '敌方 →'));
  const board = el('div', 'lineup-board'); board.setAttribute('aria-label', '英雄站位');
  battlefield.append(count, board);
  const details = el('div', 'lineup-viewer-details');
  const type = catalog.formations?.find(item => item.presetId === formation.presetId);
  const typeHeading = el('div', 'lineup-viewer-type');
  if (type?.icon) typeHeading.append(iconEl(type.icon, 48, type.name));
  typeHeading.append(el('h4', '', type?.name || '阵型 ' + formation.presetId)); details.append(typeHeading);
  if (type?.effect) details.append(el('p', 'lineup-effect', type.effect));
  if (type?.unlockEffect) details.append(el('p', 'lineup-muted', type.unlockEffect));
  const heroes = el('ul', 'lineup-viewer-heroes');
  for (const position of formation.heroPositions) {
    const hero = lineupHero(display, position.heroId);
    const item = el('li'); item.append(lineupPortrait(hero, 40), el('span', '', hero.name)); heroes.append(item);
  }
  details.append(heroes); workspace.append(battlefield, details); root.append(workspace);
  if (showPet) {
    const petField = el('div', 'lineup-pet-field'); petField.append(el('span', '', '出战海兽'));
    const petUid = String(formation.petUid || '0');
    const pet = (displayCatalog || state.editor)?.pets?.find(item => String(item.uid) === petUid);
    if (pet) petField.append(iconEl(pet.icon, 44, pet.name));
    petField.append(el('span', '', pet ? pet.name : petUid === '0' ? '不携带海兽' : '海兽 UID ' + petUid));
    root.append(petField);
  }
  const footer = el('div', 'lineup-viewer-footer'), close = smallButton('关闭');
  if (capture && formation.heroPositions.length) {
    const save = smallButton('存为预设'), modal = lineupModal;
    save.disabled = !state.saved || state.saving;
    save.onclick = async () => {
      const name = await accountDialog('存为预设', '预设名称', preset.name);
      if (name === null || account !== current || lineupModal !== modal || save.disabled) return;
      save.disabled = true;
      const result = await mutateSavedLineups(account, '/api/lineup-presets/save', { name: name.trim(), formation });
      if (lineupModal !== modal) return;
      if (result) closeLineupDialog();
      else { save.disabled = false; notice.textContent = state.message; }
    };
    const notice = el('span', 'lineup-muted'); notice.setAttribute('role', 'status');
    footer.append(notice, save);
  }
  close.onclick = () => closeLineupDialog(); footer.append(close); root.append(footer);
  const viewerState = { ...display,
    drafts: new Map([[preset.id, preset]]), activeDraft: preset.id, ui: { root, board } };
  drawLineupBoard(viewerState, account, true); host.append(root);
}

function currentLineupDraft(state) { return state.drafts.get(state.activeDraft); }
function lineupHeroRestriction(target, id) {
  return target?.blockedHeroes?.[id] || (target?.allowedHeroes && !target.allowedHeroes.includes(id) ? '本次远征不可用' : '');
}
function lineupPositionKey(position) { return position.x + ',' + position.y; }
function lineupHero(state, heroId) {
  return state.editor?.heroes?.find(hero => hero.heroId === heroId)
    || state.saved?.catalog?.heroes?.find(hero => hero.heroId === heroId)
    || { heroId, name: heroId, quality: '' };
}
function currentLineupPositions(state) {
  const draft = currentLineupDraft(state);
  const definition = state.editor?.formations?.find(item => item.presetId === draft.formation.presetId);
  return definition?.positions || draft.formation.heroPositions.map(item => item.pos);
}

// Both click placement and Pointer Events use this operation, so swaps and capacity agree.
function placeLineupHero(state, heroId, position) {
  const draft = currentLineupDraft(state), positions = currentLineupPositions(state);
  if (!positions.some(item => lineupPositionKey(item) === lineupPositionKey(position))) return false;
  if (!state.editor?.heroes?.some(hero => hero.heroId === heroId)) return false;
  if (lineupHeroRestriction(draft.target, heroId)) return false;
  const roster = draft.formation.heroPositions;
  const source = roster.find(item => item.heroId === heroId);
  const target = roster.find(item => lineupPositionKey(item.pos) === lineupPositionKey(position));
  if (target === source && source) return false;
  if (!source && !target && roster.length >= state.editor.capacity) {
    state.editorMessage = '已达到上阵人数上限，请选择场上英雄进行替换'; return false;
  }
  const next = roster.filter(item => item !== source && item !== target);
  if (source && target) next.push({ heroId: target.heroId, pos: { ...source.pos } });
  next.push({ heroId, pos: { ...position } });
  draft.formation.heroPositions = next; draft.dirty = true;
  state.selectedHeroId = null; state.editorMessage = '站位已更新';
  return true;
}

function removeLineupHero(state, heroId) {
  const draft = currentLineupDraft(state);
  if (!draft.formation.heroPositions.some(item => item.heroId === heroId)) return false;
  draft.formation.heroPositions = draft.formation.heroPositions.filter(item => item.heroId !== heroId);
  draft.dirty = true; state.selectedHeroId = null; state.editorMessage = '英雄已下阵';
  return true;
}

function changeLineupFormation(state, presetId) {
  const definition = state.editor?.formations?.find(item => item.presetId === presetId);
  const draft = currentLineupDraft(state);
  if (!definition?.unlocked || draft.formation.presetId === presetId) return;
  const targetPositions = [...definition.positions].sort((a, b) => b.x - a.x);
  draft.formation.heroPositions = draft.formation.heroPositions.slice(0, targetPositions.length).map((item, index) => ({
    heroId: item.heroId, pos: { ...targetPositions[index] },
  }));
  draft.formation.presetId = presetId; draft.dirty = true;
  state.selectedHeroId = null; state.editorMessage = '已按新阵型重新排列英雄，可继续调整站位';
}

function lineupPortrait(hero, size = 52) {
  const portrait = el('span', 'lineup-portrait');
  portrait.dataset.quality = String(hero.quality || '').toUpperCase();
  portrait.append(iconEl(hero.icon, size, hero.name));
  return portrait;
}

function redrawLineupEditor(state, account, focusPosition) {
  if (account !== current || lineupModal?.account !== account || lineupModal.mode !== 'editor' || !state.ui?.root?.isConnected) return;
  const active = state.ui.root.contains(document.activeElement) ? document.activeElement : null;
  const label = active?.getAttribute('aria-label');
  const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const rosterScroll = state.ui.roster?.scrollTop || 0;
  const old = state.ui.root, host = el('div');
  renderLineupEditor(host, state, account);
  old.replaceWith(host.firstElementChild);
  state.ui.roster.scrollTop = rosterScroll;
  if (focusPosition) {
    [...state.ui.root.querySelectorAll('[data-lineup-position]')]
      .find(item => item.dataset.lineupPosition === focusPosition)?.focus({ preventScroll: true });
  } else if (label) {
    const target = [...state.ui.root.querySelectorAll('[aria-label]')].find(item => item.getAttribute('aria-label') === label);
    target?.focus({ preventScroll: true });
    if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
  }
}

function bindLineupPointer(button, state, account, heroId) {
  let drag = null, drop = null;
  const clearDrop = () => { if (drop) delete drop.dataset.lineupDrop; drop = null; };
  const end = () => {
    clearDrop(); delete button.dataset.lineupDragging;
    if (drag && button.hasPointerCapture?.(drag.id)) button.releasePointerCapture(drag.id);
    drag = null;
  };
  button.onpointerdown = event => {
    if (event.button !== 0 || event.isPrimary === false || state.saving || account !== current) return;
    if (event.pointerType === 'touch' && button.classList.contains('lineup-hero') && !event.target.closest('.lineup-portrait')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    button.setPointerCapture(event.pointerId);
  };
  button.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (account !== current) { end(); return; }
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.moved = true; button.dataset.lineupDragging = 'true'; event.preventDefault();
    clearDrop();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-lineup-position], [data-lineup-remove]');
    if (target && state.ui.root.contains(target)) { drop = target; drop.dataset.lineupDrop = 'true'; }
  };
  button.onpointerup = event => {
    if (!drag || drag.id !== event.pointerId) return;
    const moved = drag.moved, target = drop;
    end();
    if (!moved || account !== current || state.saving) return;
    state.suppressClickUntil = Date.now() + 400;
    if (target?.dataset.lineupPosition) {
      const [x, y] = target.dataset.lineupPosition.split(',').map(Number);
      placeLineupHero(state, heroId, { x, y });
    } else if (target?.dataset.lineupRemove) removeLineupHero(state, heroId);
    redrawLineupEditor(state, account, target?.dataset.lineupPosition);
  };
  button.onpointercancel = end;
  button.onlostpointercapture = end;
  button.ondragstart = event => event.preventDefault();
}

function drawLineupBoard(state, account, readonly = false) {
  const draft = currentLineupDraft(state), board = state.ui.board;
  clear(board);
  for (const position of currentLineupPositions(state)) {
    const entry = draft.formation.heroPositions.find(item => lineupPositionKey(item.pos) === lineupPositionKey(position));
    const hero = entry && lineupHero(state, entry.heroId);
    const button = el(readonly ? 'div' : 'button', 'lineup-slot');
    if (!readonly) button.type = 'button';
    button.style.left = ((56 + (position.x - 1) * 56) / 336 * 100) + '%';
    // Keep the outermost heroes inside the board as its height adapts to the viewport.
    const rowRatio = (6 - position.y) / 6;
    button.style.top = readonly ? ((42 + (6 - position.y) * 68) / 492 * 100) + '%'
      : 'calc(' + (rowRatio * 100) + '% + ' + (33 - rowRatio * 66) + 'px)';
    button.dataset.lineupPosition = lineupPositionKey(position);
    button.setAttribute('aria-label', '站位 ' + position.x + '，' + position.y + (hero ? '，' + hero.name : '，空位'));
    button.append(hero ? lineupPortrait(hero, 48) : el('span', 'lineup-empty-slot', '+'), el('span', 'lineup-slot-name', hero?.name || '空位'));
    board.append(button);
    if (readonly) { button.setAttribute('role', 'img'); continue; }
    button.setAttribute('aria-pressed', String(Boolean(hero && state.selectedHeroId === hero.heroId)));
    button.disabled = state.saving || !state.editor;
    button.onclick = () => {
      if (account !== current || state.saving || Date.now() < (state.suppressClickUntil || 0)) return;
      if (state.selectedHeroId) {
        if (state.selectedHeroId === hero?.heroId) state.selectedHeroId = null;
        else placeLineupHero(state, state.selectedHeroId, position);
      } else if (hero) state.selectedHeroId = hero.heroId;
      redrawLineupEditor(state, account, lineupPositionKey(position));
    };
    if (hero) {
      button.title = '拖动调整站位，右键下阵';
      button.oncontextmenu = event => {
        event.preventDefault();
        if (account !== current || state.saving) return;
        removeLineupHero(state, hero.heroId);
        redrawLineupEditor(state, account, lineupPositionKey(position));
      };
      bindLineupPointer(button, state, account, hero.heroId);
    }
  }
}

function drawLineupRoster(state, account) {
  const roster = clear(state.ui.roster), draft = currentLineupDraft(state);
  const heroes = (state.editor?.heroes || []).filter(hero => (!state.query || hero.name.includes(state.query))
    && (!state.faction || hero.faction === state.faction) && (!state.career || hero.career === state.career));
  for (const hero of heroes) {
    const button = el('button', 'lineup-hero'); button.type = 'button';
    button.dataset.lineupHero = hero.heroId;
    const reason = lineupHeroRestriction(draft.target, hero.heroId);
    button.disabled = state.saving || !!reason;
    button.setAttribute('aria-label', '选择英雄 ' + hero.name);
    button.setAttribute('aria-pressed', String(state.selectedHeroId === hero.heroId));
    const portrait = lineupPortrait(hero);
    if (draft.formation.heroPositions.some(item => item.heroId === hero.heroId)) portrait.append(el('span', 'lineup-on-field', '已上阵'));
    button.append(portrait, el('span', 'lineup-hero-name', hero.name), el('span', 'lineup-hero-detail', reason || [hero.career, hero.level && hero.level + '级'].filter(Boolean).join(' · ')));
    button.onclick = () => {
      if (account !== current || state.saving || Date.now() < (state.suppressClickUntil || 0)) return;
      state.selectedHeroId = state.selectedHeroId === hero.heroId ? null : hero.heroId;
      redrawLineupEditor(state, account);
      [...state.ui.roster.children].find(item => item.dataset.lineupHero === hero.heroId)?.focus({ preventScroll: true });
    };
    bindLineupPointer(button, state, account, hero.heroId); roster.append(button);
  }
  if (state.editor && !state.loading && !heroes.length) roster.append(el('p', 'lineup-muted', '没有符合筛选条件的英雄'));
}

async function saveLineupDraft(account, state) {
  const draft = currentLineupDraft(state);
  if (!draft || state.saving || account !== current) return;
  const modal = lineupModal;
  if (!draft.name.trim()) { state.editorMessage = '请输入阵容名称'; redrawLineupEditor(state, account); state.ui?.name?.focus(); return; }
  if (!draft.formation.heroPositions.length) { state.editorMessage = '请至少上阵一名英雄'; redrawLineupEditor(state, account); return; }
  const previousIds = new Set(state.saved.presets.map(item => item.id));
  const key = state.activeDraft;
  const data = await mutateSavedLineups(account, '/api/lineup-presets/save', {
    id: draft.id, name: draft.name.trim(), formation: structuredClone(draft.formation),
  });
  if (!data) {
    state.editorMessage = state.message;
    if (account === current) redrawLineupEditor(state, account);
    return;
  }
  const saved = data.presets.find(item => item.id === (draft.id || data.savedId))
    || data.presets.find(item => !previousIds.has(item.id));
  if (saved && !draft.target) {
    state.drafts.delete(key); draft.id = saved.id; draft.name = saved.name; draft.dirty = false;
    state.drafts.set(saved.id, draft);
    if (state.activeDraft === key) state.activeDraft = saved.id;
  }
  state.editorMessage = '';
  if (account === current) {
    renderSavedLineups(account);
    if (modal && lineupModal === modal && modal.mode === 'editor') {
      if (!draft.target) modal.presetId = saved?.id || draft.id;
      closeLineupDialog();
    }
  }
}

async function applyGameDraft(account, state) {
  const draft = currentLineupDraft(state), modal = lineupModal;
  if (account !== current || !draft?.target || state.saving || !state.editor || state.loading || state.gameLoading || !snapshot.connected || snapshot.paused) return;
  state.saving = true; state.editorMessage = '正在应用到' + draft.target.title + '…';
  redrawLineupEditor(state, account);
  try {
    await lineupRequest('/api/lineups/game/apply', account, {
      targetKey: draft.target.key, version: draft.target.version,
      formation: draft.target.mode === 'fleet' ? { ...draft.formation, petUid: '0' } : draft.formation,
    });
    if (account === current) {
      if (lineupModal === modal) closeLineupDialog();
      await refreshGameLineups(account);
    }
  } catch (error) {
    if (lineupModal === modal) state.editorMessage = error.message;
  } finally {
    state.saving = false;
    if (account === current) { renderSavedLineups(account); redrawLineupEditor(state, account); }
  }
}

async function reloadGameDraft(account, state) {
  const draft = currentLineupDraft(state);
  const reading = refreshGameLineups(account);
  redrawLineupEditor(state, account);
  await reading;
  if (account !== current || currentLineupDraft(state) !== draft) return;
  const target = state.gameTargets?.find(item => item.key === draft.target.key);
  if (target?.formation) {
    draft.target = target; draft.formation = structuredClone(target.formation); draft.dirty = false;
    state.selectedHeroId = null; state.editorMessage = target.reason || '已重新载入游戏阵容';
    await loadLineupEditorData(account);
  } else state.editorMessage = state.gameMessage || target?.reason || '游戏队伍已变化，请关闭后重新选择';
  redrawLineupEditor(state, account);
}

function openLineupRecommendations(state, account, trigger) {
  const choices = state.editor.recommendations;
  const dialog = el('dialog', 'lineup-guide-dialog');
  dialog.setAttribute('aria-labelledby', 'lineup-guide-title');
  const heading = el('div', 'lineup-guide-heading'), title = el('h3', '', '选择推荐阵容');
  title.id = 'lineup-guide-title';
  const close = smallButton('返回布阵');
  close.onclick = () => dialog.close();
  heading.append(title, close);
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索搭配、英雄或阵型';
  search.setAttribute('aria-label', search.placeholder);
  const count = el('p', 'lineup-muted'); count.setAttribute('role', 'status');
  const list = el('ul', 'lineup-guide-list');
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    const visible = choices.filter(choice => [choice.label, choice.presetName, ...choice.heroes].join(' ').toLowerCase().includes(query));
    count.textContent = visible.length ? visible.filter(choice => choice.formation).length + ' 套可用 · 共 ' + visible.length + ' 套' : '没有匹配的搭配';
    clear(list);
    for (const choice of visible) {
      const row = el('li', 'lineup-guide-row'), info = el('div');
      info.append(el('strong', '', choice.label), el('span', 'lineup-guide-type', choice.presetName),
        el('p', '', choice.heroes.join('、')));
      if (choice.note || choice.reason) info.append(el('p', 'lineup-muted', [choice.note, choice.reason].filter(Boolean).join('。')));
      const use = smallButton(choice.formation ? '使用这套' : '暂不可用');
      use.disabled = !choice.formation;
      use.onclick = () => {
        if (!choice.formation || account !== current || !dialog.open || !dialog.isConnected || state.saving) return;
        const draft = currentLineupDraft(state);
        draft.formation.presetId = choice.formation.presetId;
        draft.formation.heroPositions = structuredClone(choice.formation.heroPositions);
        if (!draft.name.trim() || (!draft.id && draft.suggestedName === draft.name)) {
          draft.name = draft.suggestedName = choice.label.slice(0, 60);
        }
        draft.dirty = true;
        state.selectedHeroId = null;
        state.editorMessage = '已填入「' + choice.label + '」，可调整后保存。';
        dialog.close();
        redrawLineupEditor(state, account);
        state.ui.root.querySelector('.lineup-recommend')?.focus({ preventScroll: true });
      };
      row.append(info, use); list.append(row);
    }
    list.scrollTop = 0;
  };
  search.oninput = filter;
  dialog.onkeydown = event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
  };
  dialog.onclose = () => { dialog.remove(); if (trigger.isConnected) trigger.focus({ preventScroll: true }); };
  dialog.append(heading, search, count, list); filter();
  state.ui.root.append(dialog); dialog.showModal();
}

function renderLineupEditor(host, state, account) {
  const draft = currentLineupDraft(state);
  if (!draft) return;
  const root = el('section', 'lineup-editor'); root.id = 'saved-lineup-editor';
  root.setAttribute('aria-label', '编辑阵容');
  const heading = el('div', 'lineup-editor-heading');
  const title = el('h3', '', draft.target?.title || (draft.id ? '编辑阵容' : '新建阵容'));
  title.id = 'lineup-dialog-title';
  const refresh = smallButton(state.loading ? '正在读取…' : draft.target ? '重新载入游戏阵容' : '刷新英雄与海兽');
  const disconnectedGame = draft.target && (!snapshot.connected || snapshot.paused);
  refresh.disabled = state.loading || state.saving || (draft.target && state.gameLoading) || !!disconnectedGame;
  refresh.onclick = () => draft.target ? reloadGameDraft(account, state) : loadLineupEditorData(account);
  const headingActions = el('div', 'bar'); headingActions.append(refresh, lineupDialogCloseButton('editor'));
  heading.append(title, headingActions); root.append(heading);
  if (draft.target && state.saved?.presets?.length) {
    const field = el('label', 'lineup-load-preset'), select = el('select');
    select.add(new Option('选择我的预设…', ''));
    for (const preset of state.saved.presets) select.add(new Option(preset.name, preset.id));
    select.disabled = state.saving || state.loading;
    select.onchange = () => {
      const preset = state.saved.presets.find(item => item.id === select.value);
      if (!preset || account !== current || state.saving) return;
      draft.formation = structuredClone(preset.formation);
      if (draft.target.mode === 'fleet') draft.formation.petUid = '0';
      draft.dirty = true; state.selectedHeroId = null; state.editorMessage = '已载入「' + preset.name + '」';
      redrawLineupEditor(state, account);
    };
    field.append(el('span', '', '载入预设'), select); root.append(field);
  }
  if (state.editorError) root.append(el('p', 'lineup-editor-notice', state.editorError));
  const workspace = el('div', 'lineup-workspace lineup-editor-workspace'), battlefield = el('div', 'lineup-battlefield');
  workspace.setAttribute('aria-busy', String(state.loading));
  const formationPanel = el('section', 'lineup-formation-panel');
  const count = el('div', 'lineup-board-heading');
  count.append(el('span', '', '已上阵 ' + draft.formation.heroPositions.length + ' / ' + (state.editor?.capacity ?? '—')), el('span', '', '敌方 →'));
  const board = el('div', 'lineup-board'); board.setAttribute('aria-label', '英雄站位');
  battlefield.append(count, board);
  const options = el('div', 'lineup-formation-options'), typeField = el('label', 'lineup-formation-field');
  const typeSelect = el('select', 'lineup-formation-select'); typeSelect.setAttribute('aria-label', '阵型');
  for (const definition of state.editor?.formations || []) {
    const option = new Option(definition.name + (definition.unlocked ? ' · ' + definition.positions.length + ' 个站位' : ' · 未解锁'), String(definition.presetId));
    option.disabled = !definition.unlocked;
    typeSelect.add(option);
  }
  const selectedType = state.editor?.formations?.find(item => item.presetId === draft.formation.presetId);
  if (!selectedType) {
    const cachedType = state.saved?.catalog?.formations?.find(type => type.presetId === draft.formation.presetId);
    typeSelect.add(new Option(cachedType?.name || '阵型 ' + draft.formation.presetId, String(draft.formation.presetId)));
  }
  typeSelect.value = String(draft.formation.presetId); typeSelect.disabled = state.saving || !state.editor;
  typeSelect.onchange = () => {
    if (account !== current || state.saving) return;
    changeLineupFormation(state, Number(typeSelect.value));
    redrawLineupEditor(state, account);
  };
  typeField.append(el('span', '', '阵型'), typeSelect);
  const choose = el('button', 'lineup-recommend', '选择推荐阵容');
  choose.type = 'button';
  choose.setAttribute('aria-haspopup', 'dialog');
  choose.disabled = state.saving || state.loading || !!state.editorError || !state.editor?.recommendations?.length;
  choose.onclick = () => openLineupRecommendations(state, account, choose);
  options.append(typeField, choose);
  if (state.editor && !state.editor.recommendations?.length && !state.loading && !state.editorError) {
    options.append(el('p', 'lineup-muted', '当前游戏配置没有推荐阵容。'));
  }
  formationPanel.append(options, battlefield);
  const selection = el('div', 'lineup-selection'), remove = smallButton('下阵');
  remove.dataset.lineupRemove = 'true';
  remove.disabled = state.saving || !draft.formation.heroPositions.some(item => item.heroId === state.selectedHeroId);
  remove.onclick = () => {
    if (account !== current || state.saving) return;
    removeLineupHero(state, state.selectedHeroId); redrawLineupEditor(state, account);
  };
  const hint = state.selectedHeroId ? '已选择 ' + lineupHero(state, state.selectedHeroId).name + '，点选站位放置或交换'
    : '拖动或点选英雄入阵，右键场上英雄下阵。';
  selection.append(el('p', 'lineup-muted', hint), remove); formationPanel.append(selection);
  const petField = el('label', 'lineup-pet-field'); petField.append(el('span', '', '出战海兽'));
  const petSelect = el('select'); petSelect.setAttribute('aria-label', '出战海兽'); petSelect.add(new Option('不携带海兽', '0'));
  for (const pet of state.editor?.pets || []) {
    const reason = draft.target?.blockedPets?.[pet.uid];
    const option = new Option(pet.name + (reason ? ' · ' + reason : ''), String(pet.uid));
    option.disabled = !!reason; petSelect.add(option);
  }
  const petUid = String(draft.formation.petUid || '0');
  if (petUid !== '0' && !(state.editor?.pets || []).some(pet => String(pet.uid) === petUid)) petSelect.add(new Option('待确认的海兽 ' + petUid, petUid));
  petSelect.value = petUid; petSelect.disabled = state.saving || !state.editor;
  petSelect.onchange = () => {
    if (account !== current || state.saving) return;
    draft.formation.petUid = petSelect.value; draft.dirty = true; redrawLineupEditor(state, account);
  };
  const selectedPet = state.editor?.pets?.find(pet => String(pet.uid) === petUid);
  if (selectedPet) petField.append(iconEl(selectedPet.icon, 44, selectedPet.name));
  petField.append(petSelect);
  const rosterSection = el('section', 'lineup-roster-section'), filters = el('div', 'lineup-roster-filters');
  const rosterTools = el('div', 'lineup-roster-tools');
  rosterTools.append(el('h4', '', '选择英雄'));
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索英雄'; search.value = state.query;
  search.setAttribute('aria-label', '搜索英雄'); search.disabled = state.saving;
  search.oninput = () => { state.query = search.value.trim(); drawLineupRoster(state, account); };
  filters.append(search);
  for (const [key, label] of [['faction', '全部阵营'], ['career', '全部职业']]) {
    const select = el('select'); select.setAttribute('aria-label', label); select.add(new Option(label, ''));
    for (const value of [...new Set((state.editor?.heroes || []).map(hero => hero[key]).filter(Boolean))]) select.add(new Option(value, value));
    select.value = state[key]; select.disabled = state.saving;
    select.onchange = () => { state[key] = select.value; drawLineupRoster(state, account); }; filters.append(select);
  }
  const roster = el('div', 'lineup-roster');
  rosterTools.append(filters);
  const rosterPool = el('div', 'lineup-roster-pool');
  rosterPool.append(roster, el('p', 'lineup-muted for-touch', '滑动英雄名称可滚动列表，拖动头像可布阵。'));
  rosterSection.append(rosterTools, rosterPool);
  if (draft.target?.mode !== 'fleet') rosterSection.append(petField);
  workspace.append(rosterSection, formationPanel); root.append(workspace);
  const footer = el('div', 'lineup-editor-footer'), nameField = el('label', 'lineup-name-field'), name = el('input');
  name.type = 'text'; name.value = draft.name; name.autocomplete = 'off'; name.maxLength = 60;
  name.disabled = state.saving; name.setAttribute('aria-label', draft.target ? '预设名称' : '阵容名称');
  name.oninput = () => { draft.name = name.value; delete draft.suggestedName; draft.dirty = true; };
  nameField.append(el('span', '', draft.target ? '预设名称' : '阵容名称'), name);
  const save = smallButton(draft.target ? '另存为预设' : state.saving ? '正在保存…' : '保存阵容', false, !draft.target); save.disabled = state.saving || !state.saved;
  save.onclick = () => saveLineupDraft(account, state);
  const close = smallButton('关闭');
  close.onclick = () => closeLineupDialog();
  footer.append(nameField, save);
  let restriction = '';
  if (draft.target) {
    const blocked = draft.formation.heroPositions.find(slot => lineupHeroRestriction(draft.target, slot.heroId));
    restriction = (disconnectedGame && '重新连接游戏后可应用阵容') || draft.target.reason || (blocked && lineupHero(state, blocked.heroId).name + '：' + lineupHeroRestriction(draft.target, blocked.heroId))
      || (draft.target.blockedPets?.[petUid] && '所选海兽' + draft.target.blockedPets[petUid]) || '';
    const apply = smallButton('应用到游戏', false, true);
    apply.disabled = state.saving || state.loading || state.gameLoading || !state.editor || !!state.editorError || !draft.dirty || !draft.formation.heroPositions.length || !!restriction;
    apply.onclick = () => applyGameDraft(account, state); footer.append(apply);
  } else footer.append(close);
  const message = el('p', 'lineup-muted', restriction || state.editorMessage || (draft.target
    ? '应用目标 · ' + draft.target.title : '保存后可用于临时切换挑战，草稿按账号保留。'));
  message.setAttribute('role', 'status'); footer.append(message); root.append(footer);
  root.onkeydown = event => {
    if (state.saving || account !== current) return;
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
    if (event.key === 'Delete' && state.selectedHeroId) { event.preventDefault(); removeLineupHero(state, state.selectedHeroId); redrawLineupEditor(state, account); }
  };
  state.ui = { root, board, roster, name };
  drawLineupBoard(state, account); drawLineupRoster(state, account);
  host.append(root);
}
