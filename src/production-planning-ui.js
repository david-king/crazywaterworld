let productionPlanOwner = null;
let productionPlanVersion = 0;
let productionPlanBusy = false;
let selectedForecastFactory = null;
let displayedProductionRevision = null;
let nextProductionRefresh = 0;
let recruitResetAt = Infinity;

bindConsoleSlice('productionPlan', { productionPlanOwner, productionPlanBusy }, state => {
  productionPlanOwner = state.productionPlanOwner;
  productionPlanBusy = state.productionPlanBusy;
});

function resetProductionPlan() {
  productionPlanVersion++;
  displayedProductionRevision = null;
  nextProductionRefresh = 0;
  recruitResetAt = Infinity;
  selectedForecastFactory = null;
  setConsoleValue('productionPlan', 'productionPlanOwner', null);
  setConsoleValue('productionPlan', 'productionPlanBusy', false);
  clear($('production-plan-result'));
  clearProductionDay();
  $('production-day-result').setAttribute('aria-busy', 'false');
  $('production-plan-status').textContent = '';
}

function productionPlanTime(value) {
  if (!Number.isFinite(value)) return '时间待定';
  return new Date(value * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function productionPlanDuration(value) {
  if (!Number.isFinite(value)) return '待确认';
  const seconds = Math.max(0, Math.ceil(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return (hours ? hours + '小时' : '') + (minutes ? minutes + '分' : '') + seconds % 60 + '秒';
}

function productionPlanSummary(data) {
  const orders = data.orders || [];
  const note = text => el('p', 'production-plan-summary', text);
  const waiting = data.waitingSupplyCount ?? data.waitingHarvestCount;
  if (waiting && !data.missingReads?.length) {
    const known = orders.filter(order => Number.isFinite(order.completionAt)).length;
    return note((known ? known + ' 笔需求已有备齐时间，' : '') + waiting + ' 笔需求等待原生来料。各笔缺少的产物和数量见下表。');
  }
  if (data.strategy === 'nativeSimulation') {
    const count = (data.timeline || []).filter(job => job.kind === 'nativeSimulation').length;
    if (count) return note('模拟原生 · 本轮预计开工 ' + count + ' 件，下一批随库存和生产位变化重算。');
    if (data.pending) return note('模拟原生 · 等待已有材料扣款确认。');
    return note('模拟原生 · ' + (data.missingReads?.length ? data.missingReads.join('；') : '本轮没有可立即开工的任务。'));
  }
  if (orders.length && orders.every(order => order.skipped)) return note('本次需求均已跳过，原因见下表。');
  if (data.status === 'optimal' && Array.isArray(data.orders) && !orders.length) {
    return note(data.timeline?.some(job => job.kind === 'restock')
      ? '当前按水位备货，每种加工品目标 ' + data.stockTarget + ' 件。' : '当前没有需要备料的需求。');
  }
  if (Number.isFinite(data.completionAt)) {
    const subject = ['feasible-orders', 'feasible-demands'].includes(data.scope) ? '参与排产的需求' : '全部需求';
    if (data.upperBound === 0) return note(subject + '现在即可备齐。');
    const summary = note('');
    summary.appendChild(el('span', null, subject + '预计备齐'));
    summary.appendChild(el('strong', null, productionPlanTime(data.completionAt)));
    if (Number.isFinite(data.upperBound)) summary.appendChild(el('span', 'dim', '约需 ' + productionPlanDuration(data.upperBound)));
    return summary;
  }
  if (data.missingReads?.length) {
    const reasons = data.missingReads.map(reason => reason.replace(/^[a-zA-Z]\w*(?: · |$)/, '')).filter(Boolean);
    const summary = note('生产数据还不完整，暂时无法预计备齐时间。');
    for (const reason of new Set(reasons)) summary.appendChild(el('span', null, reason));
    return summary;
  }
  if (data.status === 'infeasible') return note('按当前条件，无法备齐所有需求。');
  return note('暂时无法预计全部需求的备齐时间。');
}

function planMaterialText(item) {
  return (item.name || item.id) + (Number.isSafeInteger(item.num) ? ' ×' + item.num : ' 数量待定');
}

function planMaterialNode(item, recipes, ancestors, group) {
  const recipe = recipes.get(item.id);
  const branch = recipe?.inputs?.length && recipe.output > 0 && !ancestors.includes(item.id);
  const label = el(branch ? 'summary' : 'span', 'plan-material-label');
  if (item.icon) label.appendChild(iconEl(item.icon, 20, item.name || item.id));
  label.appendChild(el('span', null, planMaterialText(item)));
  const row = el('li');
  if (!branch) {
    row.appendChild(label);
    return row;
  }
  const details = el('details');
  if (group) details.name = group;
  details.appendChild(label);
  details.ontoggle = () => {
    if (!details.open || details.children.length > 1) return;
    const batches = Math.ceil(item.num / recipe.output);
    const children = el('ul', 'plan-material-branches');
    for (const input of recipe.inputs) {
      children.appendChild(planMaterialNode({ ...input, num: input.num * batches }, recipes, [...ancestors, item.id]));
    }
    details.appendChild(children);
  };
  row.appendChild(details);
  return row;
}

function planMaterialList(items, recipes, group) {
  const tree = el('ul', 'plan-material-roots');
  for (const item of items) tree.appendChild(planMaterialNode(item, recipes, [], group));
  return tree;
}

function planDemandRow(order, index, recipes, snapshotTime) {
  const materials = el('div', 'plan-demand-materials');
  materials.appendChild(planMaterialList(order.requirements || [], recipes, 'production-plan-products-' + index));
  const recruitBlock = order.metadata?.recruitBlock;
  if (order.reason && recruitBlock?.kind !== 'dailyLimit') materials.appendChild(el('p', 'plan-demand-reason', order.reason));
  let status;
  if (order.skipped) status = chip('waiting', recruitBlock?.label || '已跳过');
  else if (!Number.isFinite(order.completionAt) || order.reason) status = chip('unknown', order.waitingForSupply ? order.statusLabel : '时间待定');
  else if (order.completionAt === snapshotTime) status = chip('ready', '现在可备齐');
  else status = el('span', 'plan-demand-eta', productionPlanTime(order.completionAt));
  return [el('strong', null, order.label || order.id), materials, status];
}

const forecastClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});
const forecastTime = seconds => forecastClock.format(seconds * 1000);

const forecastStatusLabels = {
  running: '生产中',
  queued: '游戏内排队中',
  planned: '计划排队中',
  batch: '已加入计划',
  accepted: '已进游戏队列',
  ready: '待领取',
  elapsed: '已到时，待游戏确认',
  unconfirmed: '游戏内状态待确认',
};

function forecastRunStatus(run) {
  // Older forecasts merged in-progress and waiting entries of the same product.
  return run.status ?? (run.existing ? 'unconfirmed' : 'planned');
}

function forecastBatchLabel(run) {
  if (run.supplyFor) return '为' + run.supplyFor + '补料 · 已加入计划';
  return run.inserted ? '已加入计划 · 插单' : forecastStatusLabels[forecastRunStatus(run)];
}

function forecastDuration(seconds) {
  if (seconds < 60) return seconds + '秒';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return (hours ? hours + '小时' : '') + (minutes ? minutes + '分' : '') + (seconds % 60 ? seconds % 60 + '秒' : '');
}

function clearProductionDay() {
  $('production-day-card').hidden = true;
  $('production-day-picker').hidden = true;
  clear($('production-day-factory')).onchange = null;
  clear($('production-day-result'));
}

function showProductionDayNotice(message) {
  if (!$('production-day-card').hidden && $('production-day-result').textContent === message) return;
  clearProductionDay();
  $('production-day-card').hidden = false;
  $('production-day-result').appendChild(el('p', 'plan-day-note', message));
}

// Keep journal batches whole. Their position is known even when their time is not.
function facilityScheduleRows(day, facility, includeGaps) {
  const runs = facility.runs ?? [];
  const afterExisting = runs.findLastIndex(run => run.existing || ['running','queued'].includes(run.status)) + 1;
  const before = new Map();
  function place(index, row) {
    if (!before.has(index)) before.set(index, []);
    before.get(index).push(row);
  }
  for (const job of facility.untimedQueue ?? []) place(afterExisting, {...job, status:'accepted'});
  const pinned = facility.pendingInsertions ?? [];
  const remainder = facility.unscheduled ?? [];
  // In a snapshot without simulation the remaining journal already is the complete queue.
  const observed = day.unavailable || day.unsynced?.includes(facility);
  let saved;
  if (observed && remainder.length) saved = remainder;
  else {
    saved = [...pinned.map(job => ({...job, inserted:true})),
      ...remainder.filter(job => !job.inserted || !pinned.length)];
    saved.sort((a,b) => Number(!!b.staged) - Number(!!a.staged) || (a.planIndex ?? Infinity) - (b.planIndex ?? Infinity));
  }
  for (const [i, job] of saved.entries()) {
    const index = job.beforeRun ?? (observed || job.inserted ? afterExisting : runs.length);
    place(index, {...job, status:'batch', note:i === 0 ? facility.insertNote : undefined});
  }
  const rows = [];
  for (const job of facility.ready ?? []) rows.push({...job, status:'ready'});
  for (const job of facility.elapsed ?? []) rows.push({...job, status:'elapsed'});
  let covered = day.startAt, idle = 0;
  const gapLabel = facility.unknown ? '待定' : facility.disabled ? '停用' : '空闲';
  function gap(to) {
    if (!includeGaps || to <= covered) return;
    idle += to - covered;
    rows.push({status:'gap', gapLabel, from:covered, to});
    covered = to;
  }
  for (const [index, run] of runs.entries()) {
    for (const job of before.get(index) ?? []) {
      if (job.estimatedStart >= run.from) gap(run.from);
      rows.push(job);
    }
    gap(run.from);
    if (!run.inserted || !pinned.length) rows.push(run);
    covered = Math.max(covered, run.to);
  }
  for (const job of before.get(runs.length) ?? []) rows.push(job);
  gap(day.endAt);
  return {rows, idle, gapLabel, notes:[facility.unknown, saved.length ? null : facility.insertNote].filter(Boolean)};
}

// Use the next dated row as a sorting anchor only. Within each facility the
// journal order wins. At an equal anchor, upstream batches precede consumers.
function overviewScheduleRows(day, groups) {
  const depths = new Map();
  function depth(id, path = new Set()) {
    if (depths.has(id)) return depths.get(id);
    if (path.has(id)) return 0;
    path.add(id);
    const inputs = day.materials?.[id]?.inputs ?? [];
    const level = inputs.reduce((n, cost) => Math.max(n, 1 + depth(cost.id, path)), 0);
    path.delete(id);
    depths.set(id, level);
    return level;
  }
  // An undated supply and its undated consumer share the earliest known
  // queue anchor for that order, even if only the consumer has a dated neighbour.
  const anchors = new Map();
  const queues = groups.map(({rows, facility}) => {
    let nextTime = Infinity;
    const group = rows.map(run => ({run, facility}));
    for (let i = group.length - 1; i >= 0; i--) {
      const row = group[i], run = row.run;
      const time = ['ready','elapsed'].includes(run.status) ? -Infinity : run.from ?? run.estimatedStart ?? Infinity;
      nextTime = Math.min(nextTime, time);
      row.orderTime = nextTime;
      if (time === Infinity && run.inserted) {
        const target = run.supplyFor ? run.supplyTarget : facility.id;
        if (target != null) {
          row.order = JSON.stringify([target, run.supplyFor || run.name]);
          anchors.set(row.order, Math.min(anchors.get(row.order) ?? Infinity, nextTime));
        }
      }
    }
    return group;
  });
  for (const group of queues) {
    let nextTime = Infinity, nextPriority = Infinity;
    for (let i = group.length - 1; i >= 0; i--) {
      const row = group[i];
      row.orderTime = Math.min(nextTime, row.orderTime, anchors.get(row.order) ?? Infinity);
      const priority = row.run.supplyFor ? depth(row.run.id) : Infinity;
      row.priority = row.orderTime === nextTime ? Math.min(nextPriority, priority) : priority;
      nextTime = row.orderTime;
      nextPriority = row.priority;
    }
  }
  return queues.flat().sort((a,b) => a.orderTime - b.orderTime || a.priority - b.priority);
}

const forecastSeconds = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', hourCycle:'h23',
  hour:'2-digit', minute:'2-digit', second:'2-digit'});

function renderScheduleTable(panel, day, entries, factory, selectFactory) {
  const wrap = panel.appendChild(el('div','production-schedule-scroll'));
  const grid = wrap.appendChild(el('table','production-schedule-table'));
  grid.setAttribute('aria-label', (factory?.name ?? '全部设施') + '排产顺序');
  const header = grid.appendChild(el('thead')).appendChild(el('tr'));
  const actions = !!day.insertKey && !day.unavailable;
  const columns = ['顺序', ...(!factory ? ['生产设施'] : []), '生产物品', '排产时间', '时长', '状态', ...(actions ? ['操作'] : [])];
  for (const label of columns) header.appendChild(el('th', null, label)).setAttribute('scope','col');
  const body = grid.appendChild(el('tbody','production-batches'));
  const nav = panel.appendChild(el('div','production-batches-nav'));
  const pageSize = 24, pages = Math.ceil(entries.length / pageSize);
  const nextDay = (Math.floor((day.startAt + 28800) / 86400) + 1) * 86400 - 28800;
  function draw(page) {
    clear(body);
    clear(nav);
    const start = page * pageSize;
    for (let i = start; i < Math.min(start + pageSize, entries.length); i++) {
      const {run, facility} = entries[i];
      const status = forecastRunStatus(run);
      const row = body.appendChild(el('tr','production-batch ' + status));
      row.appendChild(el('td','production-batch-position', i + 1));
      if (!factory) {
        const cell = row.appendChild(el('td'));
        if (selectFactory && day.factories?.includes(facility)) {
          const link = cell.appendChild(el('button','production-sequence-facility',facility.name));
          link.type = 'button';
          link.onclick = () => selectFactory(facility);
        } else cell.textContent = facility.name;
      }
      const name = row.appendChild(el('td','production-batch-name'));
      name.appendChild(el('strong', null, run.name || run.gapLabel));
      if (run.name) name.appendChild(el('span','production-batch-quantity','×' + run.quantity + (facility.crop ? ' 茬' : '')));
      let time = '', duration = '';
      if (run.from != null && run.to != null) {
        const seconds = run.to - run.from;
        const clock = t => (t >= nextDay ? '次日 ' : '') + (seconds < 60 ? forecastSeconds.format(t * 1000) : forecastTime(t));
        time = clock(run.from) + ' – ' + clock(run.to);
        duration = forecastDuration(seconds) + (run.continues ? '以上' : '');
      } else if (run.estimatedStart != null) {
        time = '预计 ' + productionPlanTime(run.estimatedStart) + (run.estimatedFinish != null ? ' – ' + productionPlanTime(run.estimatedFinish) : ' 开始');
      } else if (status === 'accepted' || status === 'batch') {
        time = run.at > day.startAt ? '最早 ' + productionPlanTime(run.at) : '开工时间待定';
      }
      row.appendChild(el('td','production-batch-time',time));
      row.appendChild(el('td','production-batch-duration',duration));
      const state = row.appendChild(el('td','production-batch-state', run.gapLabel ||
        (facility.crop && status === 'running' ? '生长中' : forecastBatchLabel(run))));
      if (run.total > run.quantity) state.appendChild(el('div',null,'整批共 ' + run.total + (facility.crop ? ' 茬' : ' 件')));
      if (run.note) state.appendChild(el('div','plan-day-note',run.note));
      if (actions) {
        const cell = row.appendChild(el('td'));
        if (!facility.crop && !facility.unknown && !facility.editing && status !== 'unconfirmed'
          && (Number.isFinite(run.from) || (run.inserted && Number.isSafeInteger(run.planIndex)))) {
          const button = cell.appendChild(el('button','production-batch-insert','插单'));
          button.type = 'button';
          button.setAttribute('aria-label',(run.name || run.gapLabel) + ' · 插入排产');
          const open = () => openBatchInsertion(day, facility, run, status, panel).catch(reportError);
          button.onclick = open;
          row.oncontextmenu = event => { event.preventDefault(); return open(); };
        }
      }
    }
    if (pages < 2) return;
    function turn(label, target) {
      const button = el('button','btn',label);
      button.type = 'button';
      button.disabled = target < 0 || target >= pages;
      button.onclick = () => { draw(target); wrap.scrollTop = 0; };
      return button;
    }
    nav.appendChild(turn('上一页',page - 1));
    nav.appendChild(el('span',null,(page + 1) + ' / ' + pages));
    nav.appendChild(turn('下一页',page + 1));
  }
  draw(0);
}

function renderProductionOverview(container, day, selectFactory) {
  const panel = clear(container).appendChild(el('div','plan-day-panel'));
  const facilities = [...(day.factories ?? []), ...(day.farms ?? []), ...(day.unsynced ?? [])];
  const groups = facilities.map(facility => ({facility, ...facilityScheduleRows(day, facility, false)}));
  for (const {facility, notes} of groups) {
    for (const note of notes) panel.appendChild(el('p','plan-day-note',facility.name + ' · ' + note));
  }
  const rows = overviewScheduleRows(day, groups);
  if (rows.length) renderScheduleTable(panel, day, rows, null, selectFactory);
  else panel.appendChild(el('p','plan-day-note','当前没有生产批次。选择工厂可在空闲时段插单。'));
}

function renderFactorySchedule(container, day, factory) {
  const panel = clear(container).appendChild(el('div','plan-day-panel'));
  if (!Array.isArray(factory.runs)) {
    panel.appendChild(el('p','dim','请重新生成计划以查看生产任务。'));
    return;
  }
  const timedFactory = !day.unavailable && day.factories?.includes(factory);
  const {rows, idle, gapLabel, notes} = facilityScheduleRows(day, factory, timedFactory);
  if (timedFactory) {
    const totals = panel.appendChild(el('div','plan-day-totals'));
    for (const [label, seconds] of [['运行', day.endAt - day.startAt - idle], [gapLabel, idle]]) {
      const stat = totals.appendChild(el('span',null,label + ' '));
      stat.appendChild(el('strong',null,forecastDuration(seconds)));
    }
  }
  for (const note of notes) panel.appendChild(el('p','plan-day-note',note));
  if (rows.length) renderScheduleTable(panel, day, rows.map(run => ({run, facility:factory})), factory);
  else panel.appendChild(el('p','plan-day-note','当前没有生产批次。'));
}

async function openBatchInsertion(day, factory, run, status, panel) {
  const account = current, version = productionPlanVersion;
  const valid = () => panel.isConnected && !productionPlanBusy && current === account && version === productionPlanVersion
    && productionAccountReady();
  if (!valid()) return;
  const target = { planKey: day.insertKey, buildingId: factory.id, from: run.from, lane: run.lane,
    planIndex:run.planIndex, status, id: run.id };
  const post = (path, body) => call('/api/world/production-insert' + path, { method: 'POST', body: JSON.stringify(body) });
  const form = el('div', 'production-insert-form');
  const notice = el('p', 'plan-day-note', '正在读取配方和补料计划…');
  notice.setAttribute('role', 'status');
  form.appendChild(notice);
  openConfirm(factory.name + ' · 插入排产', [form], submitInsertion, '加入计划队列');
  $('m-ok').disabled = true;
  const dialogCurrent = () => $('modal').open && $('m-body').firstElementChild === form;
  let options;
  try {
    options = await post('-options', target);
  } catch (error) {
    if (dialogCurrent()) notice.textContent = valid() ? error.message : '排产计划已变化，请重新选择。';
    return;
  }
  if (!dialogCurrent()) return;
  if (!valid()) {
    notice.textContent = '排产计划已变化，请重新选择。';
    return;
  }
  const { products, count, reordersQueue } = options;
  clear(form);
  if (reordersQueue) form.appendChild(el('p', 'plan-day-note', '执行计划时，此位置之后的游戏待排任务会先撤下，再按原顺序补回。'));
  function field(label, node) {
    const wrap = el('label', null, label);
    wrap.appendChild(node);
    form.appendChild(wrap);
    return node;
  }
  const ordinal = count > 1 && status !== 'running';
  let position;
  if (ordinal) {
    position = field('插在' + run.name + '第几件之前（1–' + count + '）', el('input'));
    position.type = 'number'; position.step = '1'; position.min = '1'; position.max = String(count); position.value = '1';
  } else {
    const where = status === 'running' ? '已开工任务之后' : status === 'gap' ? '空闲时段开始' : run.name + '之前';
    form.appendChild(el('p', 'dim', '插入位置 · ' + where));
  }
  const select = field('生产物品', el('select'));
  for (const product of products) {
    const option = el('option', null, product.name + (product.autoSupply ? '（自动补料）'
      : product.requiresMaterials ? '（到料后生产）' : product.max === null ? '（无需原料）' : '（最多 ' + product.max + ' 件）'));
    option.value = product.id;
    option.disabled = product.max === 0;
    select.appendChild(option);
  }
  const qty = field('数量', el('input'));
  qty.type = 'number'; qty.min = '1'; qty.step = '1'; qty.value = '1';
  const hint = el('p', 'plan-day-note');
  form.appendChild(hint);
  const chosen = () => products.find(p => p.id === select.value);
  const offset = () => position ? Number(position.value) - 1 : 0;
  const validPosition = () => Number.isSafeInteger(offset()) && offset() >= 0 && offset() < count;
  const validQuantity = (n, product = chosen()) => product && Number.isSafeInteger(n) && n >= 1 && (product.max === null || n <= product.max);
  function update() {
    const max = chosen()?.max;
    qty.max = max == null ? '' : String(max);
    $('m-ok').disabled = !validPosition() || !validQuantity(Number(qty.value));
    if (chosen()?.autoSupply) {
      hint.textContent = '整批成品和缺少的可生产原料会一次加入计划队列。执行时按库存和空位派单。'
        + (max != null && Number(qty.value) > max ? '按当前原料和设施最多可插入 ' + max + ' 件。' : '');
    } else {
      hint.textContent = !chosen() || max === 0 ? '当前可用原料不足。' : '整批加入计划队列，执行时按库存和空位派单。';
    }
  }
  select.onchange = qty.oninput = update;
  if (position) position.oninput = update;
  async function submitInsertion() {
    const quantity = Number(qty.value);
    if (!valid() || !validPosition() || !validQuantity(quantity)) throw Error('库存或计划已变化，请重新选择');
    try {
      await post('', { ...target, offset: offset(), productId: select.value, quantity, confirm: true });
    } finally {
      if (current === account && productionAccountReady()) await refreshProductionPlan({ afterInsert:true });
    }
  }
  select.value = products.find(p => p.max === null || p.max > 0)?.id ?? '';
  update();
}

function renderProductionDay(day, orders) {
  const facilities = [...(day?.factories ?? []), ...(day?.farms ?? []), ...(day?.unsynced ?? [])];
  if (day?.unavailable && !facilities.length) {
    showProductionDayNotice(day.unavailable);
    return;
  }
  clearProductionDay();
  if (!day) return;
  const box = $('production-day-result');
  $('production-day-card').hidden = false;
  const count = orders.filter(order => !order.skipped).length;
  const mode = day.strategy === 'nativeSimulation' ? '模拟游戏原生' : '智能排产';
  box.appendChild(el('p', 'plan-day-meta', mode + (day.startAt > 0 ? ' · 北京时间 ' + forecastTime(day.startAt) + ' 起' : '')
    + (count ? ' · 预计备齐 ' + day.completions.length + ' / ' + count + ' 笔需求' : '')));
  if (day.unavailable) {
    box.appendChild(el('p','plan-day-note',day.unavailable + '以下保留已保存的计划和已知游戏队列。'));
  } else if (day.partial) box.appendChild(el('p', 'plan-day-note', day.refillNote || '部分快照数据或材料扣款待确认，仅按已知条件推演。'));
  if (!facilities.length) {
    box.appendChild(el('p', 'plan-day-note', '当前快照中没有已建工厂。'));
    return;
  }
  const picker = $('production-day-factory');
  for (const factory of facilities) {
    const option = el('option', null, factory.name);
    option.value = String(factory.id);
    picker.appendChild(option);
  }
  if (day.materials) {
    const all = el('option',null,'全部设施');
    all.value = '';
    picker.appendChild(all);
  }
  $('production-day-picker').hidden = false;
  const body = el('div');
  box.appendChild(body);
  function selectFactory(factory) {
    selectedForecastFactory = factory.id;
    picker.value = String(factory.id);
    renderFactorySchedule(body, day, factory);
  }
  function selectOverview() {
    selectedForecastFactory = '';
    picker.value = '';
    renderProductionOverview(body,day,selectFactory);
  }
  picker.onchange = () => {
    if (picker.selectedIndex === facilities.length) selectOverview();
    else selectFactory(facilities[picker.selectedIndex]);
  };
  if (selectedForecastFactory === '' && day.materials) selectOverview();
  else selectFactory(facilities.find(factory => factory.id === selectedForecastFactory) ?? facilities[0]);
}

function renderProductionPlan(data) {
  const box = clear($('production-plan-result'));
  if (data.forecast?.initialQueueChanges?.length) box.appendChild(el('p', 'plan-day-note',
    '预计备齐时间已计入本轮等待队列的优先级调整，挂机确认后更新实际队列。'));
  if (data.refillNote) box.appendChild(el('p', 'plan-day-note', data.refillNote + '。实际入库达标后恢复常规策略，下方为常规排产估算。'));
  box.appendChild(productionPlanSummary(data));
  const timeline = data.timeline || [];
  const recipes = new Map((data.recipes || []).map(recipe => [recipe.productId, recipe]));
  for (const job of timeline) {
    if (!recipes.has(job.itemId) && job.inputs?.length && job.quantity > 0) {
      recipes.set(job.itemId, { output: job.quantity, inputs: job.inputs.map(input => ({
        id: input.itemId, name: input.name, num: input.quantity,
      })) });
    }
  }
  if (data.orders?.length) {
    const rows = data.orders.map((order, index) => planDemandRow(order, index, recipes, data.snapshotTime));
    box.appendChild(table(['需求来源', '所需物品', '预计备齐'], rows, 'plan-demand-table'));
  }
  for (const [title, jobs] of [
    ['建议生产顺序', timeline.filter(job => job.kind !== 'existing' && (job.kind !== 'restock' || job.priority != null))],
    ['补至库存水位 · 每种 ' + data.stockTarget + ' 件', timeline.filter(job => job.kind === 'restock' && job.priority == null)],
    ['游戏内生产队列', timeline.filter(job => job.kind === 'existing')],
  ]) {
    if (!jobs.length) continue;
    const details = el('details');
    details.appendChild(el('summary', null, title + '（' + jobs.length + ' 批）'));
    details.appendChild(table(['生产设施', '生产物品', '开始时间', '预计完成'], jobs.map(job => [
      job.machineName || job.machineId,
      planMaterialList([{ id: job.itemId, name: job.kind === 'restock' && job.priority != null
        ? (job.productName || job.itemId) + '（工厂补料）' : job.productName, num: job.quantity }], recipes),
      productionPlanTime(job.startAt),
      productionPlanTime(job.finishAt),
    ])));
    box.appendChild(details);
  }
  renderProductionDay(data.forecast, data.orders || []);
}

function productionAccountReady() {
  return !!current && snapshot.connected && !snapshot.syncingProduction && !snapshot.paused && !disconnected.has(current);
}

function refreshChangedProductionPlan() {
  if (document.hidden || consoleStore.getState().view.page !== 'manual' || $('modal').open || productionPlanBusy
    || productionPlanOwner !== current || !productionAccountReady() || Date.now() < nextProductionRefresh) return;
  if (snapshot.productionRevision > displayedProductionRevision || Date.now() >= recruitResetAt) {
    return refreshProductionPlan({ background:true });
  }
}

async function refreshProductionPlan({ afterInsert = false, background = false } = {}) {
  const account = current;
  if (productionPlanOwner !== null && productionPlanOwner !== account) resetProductionPlan();
  if (!productionAccountReady()) {
    if (productionPlanOwner !== null) resetProductionPlan();
    showProductionDayNotice(snapshot.syncingProduction ? '生产状态同步后自动显示排产清单。' : '连接账号后自动显示排产清单。');
    return;
  }
  if (productionPlanBusy && !afterInsert) return;
  const hasList = productionPlanOwner === account && !$('production-day-picker').hidden;
  const version = ++productionPlanVersion;
  const requestedRevision = snapshot.productionRevision ?? 0;
  setConsoleValue('productionPlan', 'productionPlanOwner', account);
  setConsoleValue('productionPlan', 'productionPlanBusy', true);
  if (!hasList) showProductionDayNotice('正在读取排产清单…');
  $('production-day-result').setAttribute('aria-busy', 'true');
  $('production-plan-refresh').disabled = true;
  $('production-plan-status').textContent = '正在生成计划…';
  try {
    const data = await call('/api/world/production-plan');
    if (version !== productionPlanVersion || account !== current || !productionAccountReady()) return;
    displayedProductionRevision = data.productionRevision ?? requestedRevision;
    // Re-read a capped order after Beijing midnight even if no counter push arrives.
    const capped = data.orders?.some(order => order.metadata?.recruitBlock?.kind === 'dailyLimit');
    recruitResetAt = capped && Number.isFinite(data.snapshotTime)
      ? Date.now() + (86400 - (data.snapshotTime + 8 * 3600) % 86400) * 1000 : Infinity;
    renderProductionPlan(data);
    if (!data.forecast) showProductionDayNotice('当前快照还没有排产清单，可点击「刷新计划」重试。');
    $('production-plan-status').textContent = Number.isFinite(data.snapshotTime)
      ? '数据更新于 ' + productionPlanTime(data.snapshotTime) + '（北京时间）' : '';
  } catch (error) {
    if (version !== productionPlanVersion || account !== current) return;
    if (background) {
      $('production-plan-status').textContent = '库存或队列已变化，正在等待重新读取；下方为上次估算。';
      return;
    }
    showProductionDayNotice('排产清单读取失败，请点击「刷新计划」重试。');
    clear($('production-plan-result'));
    $('production-plan-status').textContent = '生成失败，请重试';
    reportError(error);
  } finally {
    if (version === productionPlanVersion) {
      nextProductionRefresh = Date.now() + 5000;
      setConsoleValue('productionPlan', 'productionPlanBusy', false);
      $('production-day-result').setAttribute('aria-busy', 'false');
      $('production-plan-refresh').disabled = !productionAccountReady();
    }
  }
}
$('production-plan-refresh').onclick = () => refreshProductionPlan();
$('production-day-jump').onclick = () => {
  $('production-day-card').scrollIntoView({ block:'start' });
  $('production-day-title').focus({ preventScroll:true });
};
