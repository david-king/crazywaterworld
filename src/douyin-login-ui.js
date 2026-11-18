// 抖音网页扫码登录，二维码和待保存凭证由本机服务维护。
let douyinState = null;
let douyinBusy = false;
let douyinGeneration = 0;
let douyinTimer = null;
let douyinPollFailures = 0;
let douyinPollSequence = 0;
let douyinChoiceId = '';
let douyinSelectedRole = null;
const douyinLoginPath = '/api/accounts/douyin-login';

function douyinLoginExpired(state = douyinState) {
  return !Number.isFinite(state?.expiresAt) || state.expiresAt <= Date.now();
}

function selectedDouyinRole() {
  return douyinState?.choices?.find(choice => choice.id === douyinChoiceId);
}

function douyinRoleWorld(role) {
  return role.roleWorldName || role.worldName || '区服 ' + role.worldId;
}

function receiveDouyinState(state) {
  if (state.id !== douyinState?.id) douyinSelectedRole = null;
  douyinState = state;
  if (state.phase !== 'captured') return;
  const choices = state.choices || [];
  if (!choices.length && state.roleError) {
    douyinChoiceId = '';
    return;
  }
  const previous = douyinSelectedRole;
  const selected = choices.find(choice => choice.accountId === previous?.accountId && choice.worldId === previous?.worldId)
    || (choices.length === 1 ? choices[0] : null);
  douyinSelectedRole = selected;
  douyinChoiceId = selected?.id || '';
}

function renderDouyinRoles() {
  const box = clear($('douyin-roles'));
  const captured = douyinState?.phase === 'captured';
  box.hidden = !captured;
  if (!captured) return;
  const choices = douyinState.choices || [];
  if (!choices.length) {
    if (!douyinState.roleError) box.appendChild(el('p', 'dim', '当前抖音账号暂无可选择的游戏角色，请核对账号和游戏渠道后重试。'));
    return;
  }
  const list = el('fieldset', 'phone-roles');
  list.appendChild(el('legend', null, '选择区服和游戏角色'));
  for (const choice of choices) {
    const row = el('label', 'phone-role');
    const input = el('input');
    input.type = 'radio';
    input.name = 'douyin-role';
    input.value = choice.id;
    input.checked = choice.id === douyinChoiceId;
    input.disabled = douyinBusy || Boolean(douyinState.roleError) || douyinLoginExpired();
    input.onchange = () => {
      if (!input.checked || input.disabled || douyinBusy || douyinState?.phase !== 'captured'
        || douyinState.roleError || douyinLoginExpired()) return;
      const selected = douyinState.choices.find(role => role.id === input.value);
      if (!selected) return;
      douyinChoiceId = selected.id;
      douyinSelectedRole = selected;
      $('douyin-save').disabled = false;
      $('douyin-result').textContent = '已选择 ' + (selected.nickname || '未命名角色') + ' · ' + douyinRoleWorld(selected);
    };
    const info = el('div', 'phone-role-info');
    const heading = el('div', 'phone-role-heading');
    heading.append(el('strong', null, choice.nickname || '未命名角色'), el('span', null, douyinRoleWorld(choice)));
    info.appendChild(heading);
    const stats = [];
    if (choice.level != null) stats.push('等级 ' + choice.level);
    if (choice.power != null) stats.push('战力 ' + Number(choice.power).toLocaleString('zh-CN'));
    if (stats.length) info.appendChild(el('p', 'dim', stats.join(' · ')));
    if (choice.roleWorldId && String(choice.roleWorldId) !== String(choice.worldId)) {
      info.appendChild(el('p', 'dim', '原区服 ' + (choice.worldName || choice.worldId) + '，合服后位于 ' + douyinRoleWorld(choice)));
    }
    if (choice.matched) info.appendChild(el('p', 'dim', '此账号已有保存记录，再次保存会更新所选角色和区服。'));
    row.append(input, info);
    list.appendChild(row);
  }
  box.appendChild(list);
}

function renderDouyinLogin() {
  const state = douyinState || { phase: 'idle' };
  const captured = state.phase === 'captured';
  const messages = {
    idle: '点击「生成二维码」，然后使用抖音扫一扫。',
    starting: '正在打开临时抖音官网窗口并生成二维码，请稍候…',
    waiting: '请使用抖音扫码，并在手机上确认登录。',
    verifying: '请在手机抖音完成二次验证，然后等待登录结果。',
    authorizing: '扫码已确认，正在进入游戏并读取登录信息…',
    'reading-roles': '正在读取该账号的区服和游戏角色…',
    captured: '已读取游戏角色，请确认区服和角色后保存。',
    expired: '本次登录已过期，请刷新二维码重新扫码。',
    error: '登录失败，请刷新二维码重试。',
    cancelled: '已取消本次登录。',
    saved: '账号已保存并切换，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。',
  };
  if (state.account?.status?.paused || state.account?.status?.loginBlocked) {
    messages.saved = '账号已保存并切换。点击页面顶部的「恢复托管」，连接后核对角色和区服。';
  } else if (state.account?.status?.looping) {
    messages.saved = '账号已保存并切换，已按保存配置启动自动挂机。可前往「挂机配置」调整任务。';
  } else if (state.account?.status?.connected) {
    messages.saved = '账号已保存并切换，游戏已连接，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。';
  }
  const hint = $('douyin-hint');
  hint.textContent = state.error || state.roleError || (state.phase === 'verifying' && state.verification) || messages[state.phase] || '正在读取登录状态…';
  hint.className = 'phone-feedback ' + (state.error || state.roleError || ['expired', 'error'].includes(state.phase) ? 'bad' : 'dim');
  const image = $('douyin-qr');
  const showQr = ['waiting', 'verifying'].includes(state.phase) && !douyinLoginExpired(state)
    && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(state.qrImage || '');
  image.hidden = !showQr;
  if (showQr) image.src = state.qrImage;
  else image.removeAttribute('src');
  $('douyin-start').textContent = state.id || ['expired', 'error'].includes(state.phase) ? '刷新二维码' : '生成二维码';
  $('douyin-start').disabled = douyinBusy;
  $('douyin-cancel').hidden = !state.id || ['cancelled', 'saved'].includes(state.phase);
  $('douyin-cancel').disabled = douyinBusy;
  $('douyin-save').hidden = !captured;
  const selected = selectedDouyinRole();
  $('douyin-save').disabled = douyinBusy || !captured || !selected?.accountId || Boolean(state.roleError) || douyinLoginExpired(state);
  $('douyin-roles-retry').hidden = !captured || (!state.roleError && Boolean(state.choices?.length));
  $('douyin-roles-retry').disabled = douyinBusy || douyinLoginExpired(state);
  $('douyin-result').hidden = !captured && state.phase !== 'saved';
  $('douyin-result').textContent = selected
    ? '已选择 ' + (selected.nickname || '未命名角色') + ' · ' + douyinRoleWorld(selected)
    : captured && state.choices?.length ? '请选择要保存的角色。' : '';
  if (state.phase === 'saved' && state.selectedRole) {
    $('douyin-result').textContent = (state.selectedRole.nickname || '未命名角色') + ' · ' + douyinRoleWorld(state.selectedRole);
  }
  $('douyin-expiry').textContent = captured ? '请在本次登录结果过期前保存。' : '';
  $('douyin-flow').setAttribute('aria-busy', String(douyinBusy || ['starting', 'authorizing', 'reading-roles'].includes(state.phase)));
  renderDouyinRoles();
  if (typeof accountAddChanged === 'function') {
    accountAddChanged('douyin-qr', state.phase, { busy: douyinBusy, account: state.account });
  }
}

async function resetDouyinLogin() {
  if (douyinBusy) return false;
  const previous = douyinState;
  ++douyinGeneration;
  clearTimeout(douyinTimer);
  douyinBusy = true;
  douyinState = { ...previous, phase: 'cancelled', qrImage: null, error: null };
  renderDouyinLogin();
  try {
    let id = previous?.id;
    // 生成响应丢失时仍可能已经打开浏览器，先找回本次临时会话再结束。
    if (!id && previous && !['idle', 'cancelled', 'saved'].includes(previous.phase)) {
      const state = await call(douyinLoginPath + '/status');
      id = state.id;
    }
    if (id) await call(douyinLoginPath + '/cancel', { method: 'POST', body: JSON.stringify({ id }) });
    douyinState = null;
    douyinChoiceId = '';
    douyinSelectedRole = null;
    douyinPollFailures = 0;
    return true;
  } catch {
    douyinState = { ...previous, phase: 'error', qrImage: null, error: '临时扫码会话尚未结束，请重试关闭或返回。' };
    throw new Error(douyinState.error);
  } finally {
    douyinBusy = false;
    renderDouyinLogin();
  }
}

function scheduleDouyinPoll(generation) {
  clearTimeout(douyinTimer);
  if (generation !== douyinGeneration || !douyinState?.id) return;
  if (douyinState.phase === 'captured') {
    douyinTimer = setTimeout(() => {
      if (generation !== douyinGeneration || douyinState?.phase !== 'captured') return;
      ++douyinGeneration;
      douyinState = { ...douyinState, phase: 'expired', qrImage: null, error: null };
      renderDouyinLogin();
    }, douyinLoginExpired() ? 0 : douyinState.expiresAt - Date.now());
  } else if (['starting', 'waiting', 'verifying', 'authorizing', 'reading-roles'].includes(douyinState.phase)) {
    const expiry = ['waiting', 'verifying'].includes(douyinState.phase) ? douyinState.expiresAt : null;
    douyinTimer = setTimeout(() => {
      if (generation !== douyinGeneration) return;
      if (expiry != null && douyinLoginExpired()) {
        ++douyinGeneration;
        douyinState = { ...douyinState, phase: 'expired', qrImage: null, error: null };
        renderDouyinLogin();
      } else void pollDouyinLogin(generation);
    }, Number.isFinite(expiry) ? Math.max(0, Math.min(1500, expiry - Date.now())) : 1500);
  }
}

async function pollDouyinLogin(generation) {
  if (generation !== douyinGeneration || !douyinState?.id || douyinBusy) return;
  const id = douyinState.id;
  const sequence = ++douyinPollSequence;
  try {
    const state = await call(douyinLoginPath + '/status?id=' + encodeURIComponent(id));
    if (generation !== douyinGeneration || douyinState?.id !== id || sequence !== douyinPollSequence) return;
    douyinPollFailures = 0;
    receiveDouyinState(state);
  } catch (error) {
    if (generation !== douyinGeneration || douyinState?.id !== id || sequence !== douyinPollSequence) return;
    douyinPollFailures++;
    douyinState = { ...douyinState, error: douyinPollFailures < 3
      ? '登录状态读取失败，正在重试…'
      : '登录状态连续读取失败，请刷新二维码重试。' };
    if (douyinPollFailures >= 3) douyinState.phase = 'error';
  }
  renderDouyinLogin();
  scheduleDouyinPoll(generation);
}

$('douyin-start').onclick = async () => {
  if (douyinBusy) return;
  const previous = douyinState;
  const generation = ++douyinGeneration;
  clearTimeout(douyinTimer);
  douyinBusy = true;
  douyinPollFailures = 0;
  douyinChoiceId = '';
  douyinSelectedRole = null;
  douyinState = { phase: 'starting' };
  renderDouyinLogin();
  let cancelledPrevious = false;
  try {
    if (previous?.id) {
      await call(douyinLoginPath + '/cancel', { method: 'POST', body: JSON.stringify({ id: previous.id }) });
      cancelledPrevious = true;
    }
    const state = await call(douyinLoginPath + '/start', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    if (generation !== douyinGeneration) return;
    receiveDouyinState(state);
    scheduleDouyinPoll(generation);
  } catch (error) {
    if (generation !== douyinGeneration) return;
    douyinState = { id: cancelledPrevious ? undefined : previous?.id, phase: 'error', error: error.message || '二维码读取失败，请重试。' };
  } finally {
    if (generation === douyinGeneration) {
      douyinBusy = false;
      renderDouyinLogin();
    }
  }
};

$('douyin-cancel').onclick = async () => {
  if (douyinBusy || !douyinState?.id) return;
  const previous = douyinState;
  const generation = ++douyinGeneration;
  clearTimeout(douyinTimer);
  douyinBusy = true;
  douyinState = { ...previous, phase: 'cancelled', qrImage: null, error: null };
  renderDouyinLogin();
  try {
    await call(douyinLoginPath + '/cancel', { method: 'POST', body: JSON.stringify({ id: previous.id }) });
    if (generation === douyinGeneration) douyinState = { phase: 'cancelled' };
  } catch (error) {
    if (generation === douyinGeneration) {
      douyinState = { id: previous.id, phase: 'error', error: '取消登录失败，请重试取消。' };
    }
  } finally {
    if (generation === douyinGeneration) {
      douyinBusy = false;
      renderDouyinLogin();
    }
  }
};

$('douyin-roles-retry').onclick = async () => {
  if (douyinBusy || douyinState?.phase !== 'captured' || douyinLoginExpired()) return;
  const pending = douyinState;
  const generation = ++douyinGeneration;
  clearTimeout(douyinTimer);
  douyinState = { ...pending, phase: 'reading-roles', error: null, roleError: null };
  douyinBusy = true;
  renderDouyinLogin();
  try {
    const state = await call(douyinLoginPath + '/roles', { method: 'POST', body: JSON.stringify({ confirm: true, id: pending.id }) });
    if (generation !== douyinGeneration || douyinState?.id !== pending.id) return;
    receiveDouyinState(state);
  } catch (error) {
    if (generation !== douyinGeneration || douyinState?.id !== pending.id) return;
    douyinState = { ...pending, roleError: error.message || '角色读取失败，请重试。', error: null };
    if (douyinLoginExpired(pending)) douyinState.phase = 'expired';
  } finally {
    if (generation === douyinGeneration) douyinBusy = false;
  }
  renderDouyinLogin();
  scheduleDouyinPoll(generation);
};

$('douyin-save').onclick = async () => {
  if (douyinBusy || douyinState?.phase !== 'captured' || douyinState.roleError) return;
  const choice = selectedDouyinRole();
  if (!choice?.accountId) return;
  if (douyinLoginExpired()) {
    douyinState = { ...douyinState, phase: 'expired', error: null };
    renderDouyinLogin();
    return;
  }
  const pending = douyinState;
  ++douyinGeneration;
  clearTimeout(douyinTimer);
  douyinBusy = true;
  renderDouyinLogin();
  $('douyin-save').textContent = '正在保存…';
  try {
    if (!await configMayChangeAccount(choice.accountId)) {
      douyinState = { ...pending, error: '当前账号的配置尚未保存，请处理配置后再次保存此账号。' };
      return;
    }
    if (douyinLoginExpired(pending)) {
      douyinState = { ...pending, phase: 'expired', error: null };
      return;
    }
    const data = await call(douyinLoginPath + '/save', { method: 'POST', body: JSON.stringify({ confirm: true, id: pending.id, choiceId: choice.id }) });
    ++douyinGeneration;
    clearTimeout(douyinTimer);
    douyinState = { phase: 'saved', account: data.account, selectedRole: data.selectedRole || choice };
    stateActions.upsertAccount({ ...accounts.find(account => account.id === data.account.id), ...data.account });
    if (!data.account.status?.connected) stateActions.setFlag('disconnected', data.account.id, true);
    accountDetailsOwner = null;
    selectLoadedAccount(data.account.id);
    renderAccounts();
    try {
      await loadAccounts(false);
    } catch {
      douyinState.error = '账号已保存并切换，账号列表刷新失败，请刷新页面查看。';
    }
  } catch (error) {
    douyinState = { ...pending, error: error.message || '保存失败，请重试。' };
  } finally {
    douyinBusy = false;
    $('douyin-save').textContent = '保存所选角色';
    renderDouyinLogin();
    scheduleDouyinPoll(douyinGeneration);
  }
};

renderDouyinLogin();
