// Each delivered revision has a fresh SSE id. rowId identifies the visible record across revisions.
export function foldBusinessEntry(list, entry, limit) {
  const { extra, operationId, level, category } = entry;
  let previous;
  if (operationId) previous = list.findLast(row => row.operationId === operationId);
  else if (extra?.waitKey) {
    const sameWait = row => row.extra?.waitKey === extra.waitKey && row.level === level
      && row.category === category && row.feature?.key === entry.feature?.key;
    if (extra.waitScope) {
      const last = list.findLast(row => row.extra?.waitScope === extra.waitScope);
      if (last && sameWait(last)) previous = last;
    } else {
      previous = list.findLast(row => !row.extra?.waitScope && sameWait(row));
    }
  } else if (extra?.batch) {
    const last = list.at(-1);
    if (last?.extra?.batch === extra.batch && last.level === level && last.category === category
      && last.feature?.key === entry.feature?.key && last.count < 32) previous = last;
  }
  if (operationId || extra?.waitKey || extra?.batch) {
    entry.rowId = previous?.rowId ?? entry.id;
    entry.count = operationId ? 1 : (previous?.count ?? 0) + 1;
    if (extra?.batch && previous) {
      entry.detail = (previous.detail || previous.message) + '\n' + (entry.detail || entry.message);
      entry.message = extra.factory + '：连续安排生产' + extra.product + '，共 ' + entry.count + ' 次';
    }
  }
  if (previous) list.splice(list.indexOf(previous), 1);
  list.push(entry);
  if (list.length > limit) list.shift();
  return previous;
}

const phaseLabels = { reserved: '已预留', sent: '已发送', confirmed: '已确认', unknown: '结果待确认' };
const clock = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hour12: false });

function phaseLabel(data) {
  if (data.phase === 'cancelled') return data.result === 'rejected' ? '服务器已拒绝' : '已取消，未发送';
  return phaseLabels[data.phase] ?? data.phase;
}

// This account-local observer owns display timers only. The ledger owns confirmation and cancellation.
export function createOperationJournal(publish, limit, progressMs = 3000) {
  const operations = new Map();
  function stop(row) { clearTimeout(row.timer); clearImmediate(row.flush); }
  function render(row, progress = false) {
    const { data, steps } = row;
    if (!data) return;
    const pending = ['reserved', 'sent'].includes(data.phase);
    if (pending && !progress && !row.visible) return;
    const rejected = data.result === 'rejected';
    const level = rejected || (row.stepLevel === 'error' && data.phase !== 'unknown') ? 'error'
      : data.phase === 'unknown' || row.stepLevel === 'warn' ? 'warn' : 'info';
    const recovered = data.phase === 'confirmed' && row.sawUnknown;
    let status = pending ? '进行中' : recovered ? '复核已确认' : phaseLabel(data);
    if (data.phase === 'confirmed' && row.stepPending) status = '后续结果待确认';
    if (data.phase === 'confirmed' && row.stepLevel === 'error') status = '后续检查失败';
    const title = row.title || data.label || data.request || '操作';
    const reason = (rejected || data.phase === 'unknown') && data.reason || row.issue;
    const message = title + ' · ' + status + (reason ? '（' + reason + '）' : '');
    const detail = [...row.timeline, ...steps, '操作编号 ' + data.operationId].join('\n');
    if (row.lastMessage === message && row.lastDetail === detail && row.lastLevel === level && row.lastTask === row.taskKey) return;
    row.lastTask = row.taskKey;
    const quiet = pending || row.lastPhase === data.phase && row.lastLevel === level && row.lastReason === reason;
    row.lastReason = reason;
    row.visible = true; row.lastMessage = message; row.lastDetail = detail; row.lastLevel = level; row.lastPhase = data.phase;
    publish(level, message, { ...data, diagnostic: detail, category: row.category, waitScope: row.scope, taskKey: row.taskKey }, quiet);
  }
  return {
    has(id) { return operations.has(id); },
    phase(data) {
      let row = operations.get(data.operationId);
      if (!row) {
        if (operations.size >= limit) {
          const oldest = operations.keys().next().value;
          const evicted = operations.get(oldest);
          stop(evicted);
          if (evicted.flush) render(evicted);
          operations.delete(oldest);
        }
        row = { timeline: [], steps: [] };
      }
      operations.delete(data.operationId);
      operations.set(data.operationId, row);
      if (data.phase === 'confirmed' && row.data?.phase === 'unknown') {
        row.stepLevel = null;
        row.stepPending = false;
        row.issue = null;
      }
      row.data = data;
      row.timeline.push(clock.format(Date.now()) + ' ' + phaseLabel(data) + (data.reason ? ' · ' + data.reason : ''));
      if (data.phase === 'unknown' || data.recovered) row.sawUnknown = true;
      if (['reserved', 'sent'].includes(data.phase)) {
        row.timer ??= setTimeout(() => render(row, true), progressMs).unref();
        if (row.visible) render(row, true);
      } else {
        stop(row);
        // The business step normally follows settlement in the same turn.
        if (data.phase === 'confirmed' && !row.sawUnknown) row.flush = setImmediate(() => render(row));
        else render(row);
      }
    },
    step(id, level, message, options = {}) {
      const row = operations.get(id);
      if (!row) return false;
      if (!row.steps.includes(message)) row.steps.push(message);
      if (options.detail && !row.steps.includes(options.detail)) row.steps.push(options.detail);
      row.title = options.title || row.title;
      row.scope = options.scope || row.scope;
      row.taskKey = options.taskKey || row.taskKey;
      row.category = options.category || row.category;
      row.stepLevel = level;
      row.stepPending = options.pending;
      row.issue = level === 'error' || level === 'warn' ? options.reason : null;
      render(row);
      return true;
    },
    clear(flush = false) {
      for (const row of operations.values()) {
        stop(row);
        if (flush && row.flush) render(row);
      }
      operations.clear();
    },
  };
}
