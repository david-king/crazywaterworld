let productionPlanOwner = null;
let productionPlanVersion = 0;
let productionPlanBusy = false;
let selectedForecastFactory = null;

bindConsoleSlice('productionPlan', { productionPlanOwner, productionPlanBusy }, state => {
  productionPlanOwner = state.productionPlanOwner;
  productionPlanBusy = state.productionPlanBusy;
});

function resetProductionPlan() {
  productionPlanVersion++;
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
  if (orders.length && orders.every(order => order.skipped)) return note('本次需求均已跳过，请检查下方的工厂条件。');
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
  if (order.reason) materials.appendChild(el('p', 'plan-demand-reason', order.reason));
  let status;
  if (order.skipped) status = chip('waiting', '已跳过');
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
  unconfirmed: '游戏内状态待确认',
};

function forecastRunStatus(run) {
  // Older forecasts merged in-progress and waiting entries of the same product.
  return run.status ?? (run.existing ? 'unconfirmed' : 'planned');
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

// The rows are batches, so a one-second run has the same reading and click area as any other.
function renderFactorySchedule(container, day, factory) {
  const panel = el('div', 'plan-day-panel');
  clear(container).appendChild(panel);
  if (!Array.isArray(factory.runs)) {
    panel.appendChild(el('p', 'dim', '请重新生成计划以查看生产任务。'));
    return;
  }
  const rows = [];
  let covered = day.startAt, idle = 0;
  function gap(to) {
    if (to <= covered) return;
    idle += to - covered;
    rows.push({ from: covered, to });
  }
  for (const run of factory.runs) {
    gap(run.from);
    rows.push(run);
    covered = Math.max(covered, run.to);
  }
  gap(day.endAt);
  const gapLabel = factory.unknown ? '待定' : factory.disabled ? '停用' : '空闲';
  const totals = el('div', 'plan-day-totals');
  for (const [label, seconds] of [['运行', day.endAt - day.startAt - idle], [gapLabel, idle]]) {
    const stat = el('span', null, label + ' ');
    stat.appendChild(el('strong', null, forecastDuration(seconds)));
    totals.appendChild(stat);
  }
  panel.appendChild(totals);
  if (factory.pendingInsertions?.length) {
    panel.appendChild(el('h3', 'production-pending-title', '待入队插单'));
    const pending = el('ol', 'production-pending-list');
    for (const job of factory.pendingInsertions) {
      pending.appendChild(el('li', null, job.name + ' ×' + job.quantity + (job.supplyFor ? '（为' + job.supplyFor + '补料）' : '')));
    }
    panel.appendChild(pending);
  }
  if (factory.upstream?.length) {
    panel.appendChild(el('h3', 'production-pending-title', '上游补料插单'));
    const list = el('ol', 'production-pending-list');
    for (const job of factory.upstream) {
      list.appendChild(el('li', null, job.factory + ' · ' + job.name + ' ×' + job.quantity + (job.crop ? ' 茬' : '')));
    }
    panel.appendChild(list);
  }
  for (const note of [factory.unknown, factory.insertNote]) if (note) panel.appendChild(el('p', 'plan-day-note', note));
  const list = el('ol', 'production-batches');
  list.setAttribute('aria-label', factory.name + ' 排产顺序');
  panel.appendChild(list);
  const nav = el('div', 'production-batches-nav');
  panel.appendChild(nav);
  const pageSize = 24;
  const detailedClock = new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', hourCycle:'h23',
    hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const nextDay = (Math.floor((day.startAt + 28800) / 86400) + 1) * 86400 - 28800;
  function draw(page) {
    clear(list);
    clear(nav);
    for (const run of rows.slice(page * pageSize, (page + 1) * pageSize)) {
      const status = run.name ? forecastRunStatus(run) : 'gap';
      const row = el('li', 'production-batch ' + status);
      const heading = el('div', 'production-batch-name');
      heading.appendChild(el('strong', null, run.name || gapLabel));
      if (run.name) heading.appendChild(el('span', 'production-batch-quantity', '×' + run.quantity));
      row.appendChild(heading);
      const duration = run.to - run.from;
      const time = t => (t >= nextDay ? '次日 ' : '') + (duration < 60 ? detailedClock.format(t * 1000) : forecastTime(t));
      const times = el('span', 'production-batch-time', time(run.from) + ' – ' + time(run.to));
      row.appendChild(times);
      row.appendChild(el('span', 'production-batch-duration', forecastDuration(duration) + (run.continues ? '以上' : '')));
      row.appendChild(el('span', 'production-batch-state', forecastStatusLabels[status] || gapLabel));
      if (day.insertKey && !factory.unknown && !factory.editing && status !== 'unconfirmed') {
        const button = el('button', 'production-batch-insert', '插单');
        button.type = 'button';
        button.setAttribute('aria-label', (run.name || gapLabel) + ' · 插入排产');
        const open = () => openBatchInsertion(day, factory, run, status, panel).catch(reportError);
        button.onclick = open;
        row.oncontextmenu = event => { event.preventDefault(); return open(); };
        row.appendChild(button);
      }
      list.appendChild(row);
    }
    if (rows.length <= pageSize) return;
    const pages = Math.ceil(rows.length / pageSize);
    const turn = (label, target) => {
      const button = el('button', 'btn', label);
      button.type = 'button';
      button.disabled = target < 0 || target >= pages;
      button.onclick = () => { draw(target); list.scrollTop = 0; };
      return button;
    };
    nav.appendChild(turn('上一页', page - 1));
    nav.appendChild(el('span', null, (page + 1) + ' / ' + pages));
    nav.appendChild(turn('下一页', page + 1));
  }
  draw(0);
}

async function openBatchInsertion(day, factory, run, status, panel) {
  const account = current, version = productionPlanVersion;
  const valid = () => panel.isConnected && !productionPlanBusy && current === account && version === productionPlanVersion
    && productionAccountReady();
  if (!valid()) return;
  const target = { planKey: day.insertKey, buildingId: factory.id, from: run.from, lane: run.lane, status, id: run.id };
  const post = (path, body) => call('/api/world/production-insert' + path, { method: 'POST', body: JSON.stringify(body) });
  const form = el('div', 'production-insert-form');
  const notice = el('p', 'plan-day-note', '正在核对库存和可插入数量…');
  notice.setAttribute('role', 'status');
  form.appendChild(notice);
  openConfirm(factory.name + ' · 插入排产', [form], submitInsertion, '确认插入');
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
  if (reordersQueue) form.appendChild(el('p', 'plan-day-note', '插入位置之后的游戏待排任务会先撤下，再按原顺序补回。'));
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
      : product.max === null ? '（无需原料）' : '（最多 ' + product.max + ' 件）'));
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
      hint.textContent = '缺少的可生产原料会优先插到对应工厂或农田，已有库存、在产和已插单的数量会先抵扣。'
        + (max != null && Number(qty.value) > max ? '按当前原料和设施最多可插入 ' + max + ' 件。' : '');
    } else {
      hint.textContent = !chosen() || max === 0 ? '当前可用原料不足。' : '成品满仓时先做后面能做的任务，腾出仓容后优先补产。';
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
  if (day?.unavailable) {
    showProductionDayNotice(day.unavailable);
    return;
  }
  clearProductionDay();
  if (!day) return;
  const box = $('production-day-result');
  $('production-day-card').hidden = false;
  const factories = day.factories;
  const count = orders.filter(order => !order.skipped).length;
  const mode = day.strategy === 'nativeSimulation' ? '模拟游戏原生' : '智能排产';
  box.appendChild(el('p', 'plan-day-meta', mode + ' · 北京时间 ' + forecastTime(day.startAt) + ' 起'
    + (count ? ' · 预计备齐 ' + day.completions.length + ' / ' + count + ' 笔需求' : '')));
  if (day.partial) box.appendChild(el('p', 'plan-day-note', '部分快照数据或材料扣款待确认，仅按已知条件推演。'));
  if (!factories.length) {
    box.appendChild(el('p', 'plan-day-note', '当前快照中没有已建工厂。'));
    return;
  }
  const picker = $('production-day-factory');
  for (const factory of factories) {
    const option = el('option', null, factory.name);
    option.value = String(factory.id);
    picker.appendChild(option);
  }
  $('production-day-picker').hidden = false;
  const body = el('div');
  box.appendChild(body);
  function selectFactory(factory) {
    selectedForecastFactory = factory.id;
    picker.value = String(factory.id);
    renderFactorySchedule(body, day, factory);
  }
  picker.onchange = () => selectFactory(factories[picker.selectedIndex]);
  selectFactory(factories.find(factory => factory.id === selectedForecastFactory) ?? factories[0]);
}

function renderProductionPlan(data) {
  const box = clear($('production-plan-result'));
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

async function refreshProductionPlan({ afterInsert = false } = {}) {
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
  setConsoleValue('productionPlan', 'productionPlanOwner', account);
  setConsoleValue('productionPlan', 'productionPlanBusy', true);
  if (!hasList) showProductionDayNotice('正在读取排产清单…');
  $('production-day-result').setAttribute('aria-busy', 'true');
  $('production-plan-refresh').disabled = true;
  $('production-plan-status').textContent = '正在生成计划…';
  try {
    const data = await call('/api/world/production-plan');
    if (version !== productionPlanVersion || account !== current || !productionAccountReady()) return;
    renderProductionPlan(data);
    if (!data.forecast) showProductionDayNotice('当前快照还没有排产清单，可点击「刷新计划」重试。');
    $('production-plan-status').textContent = Number.isFinite(data.snapshotTime)
      ? '数据更新于 ' + productionPlanTime(data.snapshotTime) + '（北京时间）' : '';
  } catch (error) {
    if (version !== productionPlanVersion || account !== current) return;
    showProductionDayNotice('排产清单读取失败，请点击「刷新计划」重试。');
    clear($('production-plan-result'));
    $('production-plan-status').textContent = '生成失败，请重试';
    reportError(error);
  } finally {
    if (version === productionPlanVersion) {
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
