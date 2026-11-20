import assert from 'node:assert/strict';
import { defaultSettings, hasExtraWork } from '../src/automation-settings.mjs';
import { createWeeklyActivityContext, weeklyExecutionSettings, nextWeeklyActivityBoundary } from '../src/weekly-activity.mjs';

const config = { tables: { ModuleOpenCfg: { data: [{ moduleId: '每日跨服比拼', playerLevel: 20 }] } } };
const player = { playerId: '9007199254740993', worldId: '2000001', level: 30 };
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
function fixture(kind = 'pet', subjectId = 3, time = '2026-11-18T12:00:00+08:00') {
  let settings = defaultSettings();
  Object.assign(settings.weeklyActivity, { enabled: true, [kind + 'Enabled']: true, [kind + 'Stop']: 'score', [kind + 'Score']: 100 });
  let reads = 0;
  const state = { subjectId, settleTime: Date.parse(time) / 1000 + 3600, roomLevel: 1, grouping: false,
    rankList: [{ playerId: player.playerId, score: 90 }] };
  const client = { connected: true, serverClockOffsetMs: Date.parse(time) - Date.now(),
    async request(name) { assert.equal(name, 'CrossRankInfoRequest'); reads++; return structuredClone(state); } };
  const reports = [];
  return { state, client, reports, get reads() { return reads; }, get settings() { return settings; },
    change() { settings = structuredClone(settings); },
    setTime(value) { client.serverClockOffsetMs = Date.parse(value) - Date.now(); },
    context: () => createWeeklyActivityContext(client, config, player, { getSettings: () => settings, report: row => reports.push(row) }) };
}

await test('全天参与忽略旧窄窗口，午夜、白天和深夜均可核对后执行', async () => {
  for (const time of ['00:00', '12:00', '23:59']) {
    const f = fixture('pet', 3, '2026-11-18T' + time + ':00+08:00');
    Object.assign(f.settings.weeklyActivity, { petStart: '13:00', petEnd: '13:01', petStop: 'allDay' });
    f.state.rankList = [];
    const ctx = await f.context();
    assert(ctx, time + ' 不应受旧参与窗口限制');
    await ctx.beforeAction();
    assert.equal(f.reads, 2);
    assert(ctx.enabled());
  }
});
await test('北京时间跨午夜后旧计划停止，即使服务器仍返回原主题和未来结算时间', async () => {
  const f = fixture('pet', 3, '2026-11-18T23:59:59+08:00');
  const ctx = await f.context();
  assert(ctx);
  f.setTime('2026-11-19T00:00:00+08:00');
  assert.equal(ctx.enabled(), false);
  await assert.rejects(ctx.beforeAction(), error => error.notSent && error.code === 'AUTOMATION_SKIP');
  assert.equal(f.reads, 1, '换日后无需继续读取或发送旧计划');
});
await test('全天参与仍受服务器结算时间限制，结算到点后不再执行', async () => {
  const f = fixture();
  f.settings.weeklyActivity.petStop = 'allDay';
  f.state.settleTime = Date.parse('2026-11-18T12:00:01+08:00') / 1000;
  const ctx = await f.context();
  assert(ctx);
  f.setTime('2026-11-18T12:00:02+08:00');
  await assert.rejects(ctx.beforeAction(), error => error.notSent && /结算/.test(error.message));
  assert.equal(f.reads, 2);
  assert.equal(ctx.enabled(), false);
});
await test('使用服务端主题而非本地星期；每次写入前重新读取积分', async () => {
  const f = fixture(), ctx = await f.context();
  assert.equal(ctx.kind, 'pet');
  assert.equal(ctx.settings.pet.enabled, true);
  await ctx.beforeAction(); assert.equal(f.reads, 2);
  f.state.rankList[0].score = { low: 100, high: 0 };
  await assert.rejects(ctx.beforeAction(), error => error.notSent && error.code === 'AUTOMATION_SKIP' && /已达/.test(error.message));
  assert.equal(ctx.enabled(), false);
});
await test('本人积分缺失、重复或不精确时不消费；不能取排行榜首位', async () => {
  for (const rankList of [[], [{ playerId: '1', score: 0 }], [
    { playerId: player.playerId, score: 0 }, { playerId: player.playerId, score: 0 },
  ], [{ playerId: player.playerId, score: '9007199254740993' }]]) {
    const f = fixture(); f.state.rankList = rankList;
    assert.equal(await f.context(), null);
    assert.match(f.reports.at(-1).reason, /积分/);
  }
});
await test('活动结算、主题改变、配置修改和断线均在写入前停止', async () => {
  for (const change of [f => f.state.settleTime++, f => f.state.subjectId = 6, f => f.state.grouping = true,
    f => f.change(), f => f.client.connected = false]) {
    const f = fixture(), ctx = await f.context(); change(f);
    await assert.rejects(ctx.beforeAction(), error => error.notSent === true);
    assert(!ctx.enabled());
  }
});
await test('读取失败停止，已达目标和关闭开关不执行；全天模式无需猜测积分', async () => {
  const f = fixture(), ctx = await f.context(); f.client.request = async () => { throw Error('断网'); };
  await assert.rejects(ctx.beforeAction(), error => error.notSent === true);
  const done = fixture(); done.state.rankList[0].score = 100; assert.equal(await done.context(), null);
  const off = fixture(); off.settings.weeklyActivity.enabled = false; assert.equal(await off.context(), null); assert.equal(off.reads, 0);
  const allDay = fixture(); allDay.settings.weeklyActivity.petStop = 'allDay'; allDay.state.rankList = [];
  assert(await allDay.context());
});
await test('六类活动独立授权计分动作，不依赖普通总开关或收种升星细项', async () => {
  const paths = {
    farm: ['farm.enabled', 'farm.harvest', 'farm.autoPlant'],
    pet: ['pet.enabled', 'pet.claim', 'pet.breed'],
    antique: ['antique.enabled', 'antique.star', 'antique.suit'],
    order: ['resident.enabled'], forge: ['forge.enabled', 'forge.collect', 'forge.craft'],
    hero: ['loop.heroes', 'heroes.enabled', 'heroes.star'],
  };
  const ids = { farm: 6, pet: 3, antique: 4, order: 1, forge: 2, hero: 5 };
  for (const [kind, fields] of Object.entries(paths)) {
    const f = fixture(kind, ids[kind]);
    f.settings.forge.collect = f.settings.forge.craft = false;
    const before = structuredClone(f.settings), context = await f.context();
    assert(context, kind);
    for (const field of fields) {
      const [group, key] = field.split('.');
      assert.equal(before[group][key], false, field + ' 普通开关关闭');
      assert.equal(context.settings[group][key], true, field + ' 活动独立授权');
    }
    assert.deepEqual(f.settings, before, '活动不能改写普通开关');
    assert.deepEqual(context.settings.resources, before.resources, '钻石与加速资源权限保持原值');
    for (const group of ['forge', 'pet', 'heroes', 'antique']) {
      for (const key of Object.keys(before[group]).filter(key => /Ids$|Qualities$|species|Reserve|Limit|target|universal/.test(key))) {
        assert.deepEqual(context.settings[group][key], before[group][key], group + '.' + key + ' 对象与预算不扩大');
      }
    }
  }
});
await test('活动种田保留自定义作物范围和目标，智能种植只在非自定义模式启用', () => {
  const s = defaultSettings();
  Object.assign(s.farm, { customPlant: true, crops: [{ id: '小麦', target: 10 }] });
  const custom = weeklyExecutionSettings(s, 'farm');
  assert.equal(custom.farm.customPlant, true); assert.equal(custom.farm.autoPlant, false);
  assert.deepEqual(custom.farm.crops, [{ id: '小麦', target: 10 }]);
  s.farm.customPlant = false;
  const intelligent = weeklyExecutionSettings(s, 'farm');
  assert.equal(intelligent.farm.autoPlant, true);
  assert.deepEqual(intelligent.farm.crops, s.farm.crops);
  assert.equal(s.farm.autoPlant, false);
});
await test('未到本分项主题或积分达标只暂停活动，不改普通自动化配置', async () => {
  for (const scenario of ['other', 'completed']) {
    const f = fixture('forge', scenario === 'other' ? 4 : 2);
    Object.assign(f.settings.forge, { enabled: true, collect: true, craft: true });
    f.settings.schedule.freeRecruit = true;
    if (scenario === 'completed') f.state.rankList[0].score = 100;
    const before = structuredClone(f.settings);
    assert.equal(await f.context(), null);
    assert.deepEqual(f.settings, before);
  }
});
await test('只开启周活动也能启动挂机，空选择不视作自动任务', () => {
  const s = defaultSettings();
  assert.equal(hasExtraWork(s), false);
  s.weeklyActivity.enabled = true; assert.equal(hasExtraWork(s), false);
  s.weeklyActivity.petEnabled = true; assert.equal(hasExtraWork(s), true);
});
await test('长轮询只在北京时间午夜唤醒，忽略旧窗口并计入服务器时钟偏移', () => {
  const settings = defaultSettings(); Object.assign(settings.weeklyActivity, { enabled: true, petEnabled: true, petStart: '10:00', petEnd: '20:00' });
  const at = time => Date.parse('2026-11-18T' + time + ':00+08:00');
  const midnight = Date.parse('2026-11-19T00:00:00+08:00');
  assert.equal(nextWeeklyActivityBoundary({}, settings, at('09:00')), midnight);
  assert.equal(nextWeeklyActivityBoundary({}, settings, at('10:00')), midnight);
  assert.equal(nextWeeklyActivityBoundary({ serverClockOffsetMs: 60000 }, settings, at('09:00')), midnight - 60000);
  assert.equal(nextWeeklyActivityBoundary({ serverClockOffsetMs: 60000 }, settings, at('23:59')), midnight + 86400000 - 60000);
  assert.equal(nextWeeklyActivityBoundary({}, defaultSettings(), at('09:00')), Infinity);
});
console.log('周活动全天与积分调度测试通过，共 ' + passed + ' 项');
