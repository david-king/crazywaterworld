// Selection keys survive a fresh preview with new choice IDs.
function createRoleSelection() {
  let previewId, initialized = false;
  const keys = new Set();
  const key = role => JSON.stringify([role.accountId, role.worldId]);
  return {
    reset() { previewId = undefined; initialized = false; keys.clear(); },
    receive(id, choices, autoSelectSingle = false) {
      if (id !== previewId) { this.reset(); previewId = id; }
      if (!choices.length) return;
      const available = new Set(choices.map(key));
      for (const value of keys) if (!available.has(value)) keys.delete(value);
      if (!initialized && autoSelectSingle && choices.length === 1) keys.add(key(choices[0]));
      initialized = true;
    },
    has(role) { return keys.has(key(role)); },
    set(role, checked) { if (checked) keys.add(key(role)); else keys.delete(key(role)); },
    selected(choices = []) { return choices.filter(role => keys.has(key(role))); },
  };
}

function roleSavePayload(roles) {
  return roles.length === 1 ? { choiceId: roles[0].id } : { choiceIds: roles.map(role => role.id) };
}

function selectedRoleNames(roles) {
  return roles.map(role => (role.nickname || '未命名角色') + ' · ' + (role.roleWorldName || role.worldName || '区服 ' + role.worldId)).join('、');
}

function showSavedRoleAccounts(data) {
  for (const account of data.accounts || [data.account]) {
    const saved = { ...accounts.find(row => row.id === account.id), ...account };
    stateActions.upsertAccount(saved);
    if (!saved.status?.connected) stateActions.setFlag('disconnected', account.id, true);
  }
}
