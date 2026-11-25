import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { claimRewards } from '../src/claim-rewards.mjs';
import { planChests, surveyDailies } from '../src/dailies.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';
import { nextOrderTier, runTasks, surveyTasks } from '../src/tasks.mjs';
import { runLoop } from '../src/loop.mjs';
import { defaultSettings, nativeTaskValues } from '../src/automation-settings.mjs';

let now = 1000;
const deadlines = new Map();
const observations = new Map();
const scheduler = {
  now: () => now,
  nextDay: () => 10000,
  due: key => now >= (deadlines.get(key) ?? 0),
  defer: (key, time) => deadlines.set(key, time),
  observe: (key, text) => observations.set(key, text),
};
const protocol = {
  DailyTaskInfoRequest: true, DailyTaskInfoResponse: true, DrawDailyTaskRewardResponse: true,
  DailyGiftPackRequest: true, DailyGiftPackResponse: true,
};
const config = { tables: {
  DailyActivityRewardCfg: { data: [{ id: 1, activity: 20 }] },
  WeeklyActivityRewardCfg: { data: [{ id: 1, activity: 120 }] },
} };
const daily = { dailyResetTime: 2000, dailyTask: [{ id: 1001, rewardClaimed: true }],
  dailyActivity: 20, dailyRewardClaimed: [1], weeklyRewardClaimed: [1] };
const gift = { resetTime: 1800, drawnPack: ['赠礼'] };
const calls = [];
const client = {
  async request(name) {
    calls.push(name);
    if (name === 'DailyTaskInfoRequest') return daily;
    if (name === 'DailyGiftPackRequest') return gift;
    if (name === 'EmailBoxRequest') return { email: [] };
    if (name === 'DrawDailyTaskRewardRequest') return { activity: 5 };
    assert.fail('unexpected read: ' + name);
  },
  async sendWatch(name) { calls.push(name); },
};
const enabled = key => ['dailyRewards', 'chests', 'gift', 'mail'].includes(key);
{
  const realNow = Date.now;
  let clockMs = 36_000_000;
  Date.now = () => clockMs;
  try {
    // 一小时已积累。运行中把四小时改为两小时，随后跨两个新时段。
    const prefs = defaultSettings();
    prefs.schedule.afk = true;
    prefs.afk.claimIntervalHours = 4;
    const timedClient = new EventEmitter().setMaxListeners(32);
    timedClient.serverClockOffsetMs = 2000;
    const serverTime = () => (clockMs + timedClient.serverClockOffsetMs) / 1000;
    const period = { afkStartTime: serverTime() - 3600, afkFinishTime: serverTime() + 9 * 3600, level: 105, rewardedLevel: 104 };
    const timedDraws = [];
    timedClient.request = async (name, body) => {
      if (name === 'AfkInfoRequest') return { afkInfo: { ...period } };
      if (name === 'DrawAfkLevelRewardRequest') {
        assert.equal(body.level, 105);
        period.rewardedLevel = body.level;
        return {};
      }
      assert.equal(name, 'DrawAfkRewardRequest');
      timedDraws.push(clockMs);
      period.afkStartTime = serverTime();
      period.afkFinishTime = serverTime() + 10 * 3600;
      return { ...period };
    };
    await runLoop(timedClient, { DrawAfkRewardRequest: true, DrawAfkRewardResponse: true,
      DrawAfkLevelRewardRequest: true, DrawAfkLevelRewardResponse: true }, {
      config: { nextAfkRewardLevel: level => level === 104 ? 105 : null },
      getSettings: () => prefs, isEnabled: key => prefs.schedule[key], allowMutate: true,
      rounds: 2, everyMs: 4 * 3600_000,
      onRound: ({ round }) => {
        if (round !== 1) return;
        assert.equal(period.rewardedLevel, 105, '等级奖励可先于本段收益领取');
        assert.deepEqual(timedDraws, []);
        prefs.afk.claimIntervalHours = 2;
        timedClient.emit('automationSettingsChanged');
      },
      sleep: async ms => { clockMs += ms; },
    });
    assert.deepEqual(timedDraws, [11 * 3600_000, 13 * 3600_000]);

    prefs.afk.claimIntervalHours = 24;
    const dailyClient = { async request(name) {
      if (name === 'DailyTaskInfoRequest') return { dailyTask: [{ id: 1004, progress: 0, targetProgress: 1 }] };
      if (name === 'AfkInfoRequest') return { afkInfo: period };
      assert.equal(name, 'AllResourceRequest');
      return {};
    }, serverClockOffsetMs: 2000 };
    const dailyStatus = async () => (await surveyDailies(dailyClient, {}, { settings: prefs })).tasks[0].status;
    clockMs = (period.afkFinishTime - 3) * 1000;
    assert.equal(await dailyStatus(), 'waiting');
    clockMs += 1000;
    assert.equal(await dailyStatus(), 'ready', '设置超过实际容量时在封顶时领取');
    prefs.afk.claimIntervalHours = 1;
    clockMs = (period.afkStartTime + 3600 - 2) * 1000;
    assert.equal(await dailyStatus(), 'ready', '日常任务也按设定小时判断');
    prefs.afk.claimIntervalHours = 0;
    assert.equal(await dailyStatus(), 'waiting', '旧设置仍等到收益存满');
    prefs.afk.claimIntervalHours = 1;
    delete period.afkStartTime;
    assert.equal(await dailyStatus(), 'waiting', '缺少起点时按服务端封顶时间判断');
  } finally { Date.now = realNow; }
}
const run = schedule => claimRewards(client, protocol, config, undefined, enabled, undefined, schedule);
await run(scheduler);
assert.deepEqual(Object.fromEntries(deadlines), { dailyRewards: 2000, chests: 2000, gift: 1800, mail: 1180 });
calls.length = 0;
await run(scheduler);
assert.deepEqual(calls, [], 'confirmed rewards should not be checked every round');
await run();  // Manual calls must see changes even during a scheduled cooldown.
assert.deepEqual(calls, ['DailyTaskInfoRequest', 'DailyGiftPackRequest', 'EmailBoxRequest']);
calls.length = 0;
now = 1180;
await run(scheduler);
assert.deepEqual(calls, ['EmailBoxRequest']);

now = 2000;
calls.length = 0;
gift.drawnPack = []; gift.resetTime = 2800;
daily.dailyTask = []; daily.dailyResetTime = 3000;
daily.weeklyActivity = 20; daily.weeklyRewardClaimed = [];
const failedGift = await run(scheduler);
assert.equal(observations.get('dailies.claimDailyChest'), '已领取 1/1 档');
assert.equal(observations.get('dailies.claimWeeklyChest'), '已领取 0/1 档');
assert.match(failedGift.find(item => !item.ok).error, /尚未确认/);
assert(['gift', 'dailyRewards'].every(key => scheduler.due(key)), 'unconfirmed gifts or empty task lists must not defer');
assert.equal(deadlines.get('chests'), 2180, 'unfinished weekly tiers must be checked again before tomorrow');
calls.length = 0;
now = 2180;
daily.dailyTask = [{ id: 1001, progress: 1, targetProgress: 1, rewardClaimed: false }];
daily.weeklyRewardClaimed = [1]; daily.dailyRewardClaimed = [];
client.sendWatch = async name => { calls.push(name); if (name === 'GotFreeDailyPackRequest') gift.drawnPack = ['赠礼']; };
await run(scheduler);
assert(calls.includes('DrawDailyTaskRewardRequest') && calls.includes('DrawDailyRewardRequest'));
assert.match(observations.get('dailies.claimDailyChest'), /等待同步/);
assert.equal(observations.get('dailies.claimWeeklyChest'), '已领取 1/1 档');
assert.equal(deadlines.get('gift'), 2800);
assert(scheduler.due('dailyRewards') && scheduler.due('chests'), 'requests without a confirmed claim flag do not postpone future checks');
daily.dailyResetTime = 0; daily.dailyRewardClaimed = [1]; daily.dailyTask[0].rewardClaimed = true;
await run(scheduler);
assert(scheduler.due('dailyRewards') && scheduler.due('chests'), 'missing reset time must not defer');
daily.dailyResetTime = 2250; daily.dailyTask[0] = { id: 1002, progress: 0, targetProgress: 2, rewardClaimed: false };
await run(scheduler);
assert.equal(deadlines.get('dailyRewards'), 2250, 'recheck for incomplete tasks cannot cross the next server reset');
now = 3000;
const failedDaily = await claimRewards({
  request(name) {
    if (name === 'DailyTaskInfoRequest') throw new Error('读取任务超时');
    assert.equal(name, 'DailyGiftPackRequest');
    return { resetTime: 4000, drawnPack: ['赠礼'] };
  },
}, protocol, config, null, key => ['dailyRewards', 'gift'].includes(key), undefined, scheduler);
assert(failedDaily.some(row => !row.ok && row.error === '读取任务超时'));
assert.equal(deadlines.get('gift'), 4000, 'unrelated reward probe failure does not block the independent gift');
assert(scheduler.due('dailyRewards'));

const orderRows = (season, worldOpenDays, ...counts) => counts.map(reqNum => ({ season, worldOpenDays, reqNum }));
const orderConfig = { tables: { OrderDailyRewardCfg: { data: [
  ...orderRows(1, 1, 6, 12, 40),
  ...orderRows(2, 1, 6, 12, 40), ...orderRows(2, 5, 6, 12, 40, 45),
  ...orderRows(4, 1, 6, 12, 40, 45),
  ...orderRows(10, 1, 6, 12, 40), ...orderRows(10, 5, 6, 12, 40, 45),
] } } };
const opened = Date.parse('2026-11-01T18:00:00+08:00') / 1000;
const fifthDay = Date.parse('2026-11-05T00:00:00+08:00') / 1000;
const after40 = (worldId, time, worldOpenTime = opened) => nextOrderTier(orderConfig, {
  orderNum: 45, rewardedNum: 40, player: { worldId, worldOpenTime }, now: time,
});
assert.equal(after40(1000001, fifthDay).maxTier, 40);
assert.equal(after40(1000001, fifthDay).claimable, false);
assert.equal(after40(2000001, fifthDay - 1).maxTier, 40);
assert.equal(after40(2000001, fifthDay).tier, 45);
assert.equal(after40(2000001, fifthDay).maxTier, 45);
assert.equal(after40(2000001, fifthDay, null).maxTier, null);
assert.equal(after40(11000001, opened).maxTier, 45);
assert.equal(after40(3000001, fifthDay - 1).maxTier, 40);
assert.equal(after40(3000001, fifthDay).maxTier, 45);
for (let season = 5; season <= 9; season++) {
  assert.equal(after40(season * 1e6 + 1, opened, null).maxTier, 45);
}
assert.deepEqual(nextOrderTier(orderConfig, { orderNum: 12, rewardedNum: 6 }), {
  tier: 12, reqNums: [6, 12, 40, 45], maxTier: null, claimable: true,
});

let order = { orderNum: 45, rewardedNum: 40 };
const reads = [];
const orderClient = Object.assign(new EventEmitter(), {
  serverClockOffsetMs: now * 1000 - Date.now(),
  async request(name) {
    reads.push(name);
    if (name === 'MainTaskInfoRequest') return {};
    if (name === 'AchievementInfoRequest') return { task: [{ id: 17, progress: 2, targetProgress: 2, rewardClaimed: false }] };
    if (name === 'OnWaterRequest') return { orderOfTheDay: order };
    assert.fail(name);
  },
});
const options = { config: orderConfig, player: { worldId: 1000001 } };
const fifthSeason = { worldId: 5000001 };
const orderSchedule = rewardSchedule(orderClient);
const surveyOrder = () => surveyTasks(orderClient, {}, { ...options, scheduler: orderSchedule });
const orderStatus = () => orderSchedule.status('orderDaily');
const orderUpdate = () => orderClient.emit('message', { name: 'SCOrderOfTheDay', body: {} });
await surveyOrder();
assert.equal(orderSchedule.nextCheck('orderDaily'), orderSchedule.nextDay());
assert.equal(orderStatus().state, 'completed');
assert.equal(orderStatus().text, '今日 3 档奖励已全部领取，最高 40 单档');
orderClient.emit('message', { name: 'SCOrderOfTheDay', body: { orderOfTheDay: { orderNum: 55, rewardedNum: 40 } } });
assert.equal(orderSchedule.nextCheck('orderDaily'), orderSchedule.nextDay());
reads.length = 0;
const skippedOrder = await surveyOrder();
assert.deepEqual(reads, ['MainTaskInfoRequest', 'AchievementInfoRequest']);
assert.equal(skippedOrder.plan[0].kind, 'achievement');
assert.equal(orderStatus().state, 'completed');
await surveyTasks(orderClient, {}, options);
assert(reads.includes('OnWaterRequest'), 'manual daily order lookup remains live');
orderClient.emit('message', { name: 'SCDailyTaskReset', body: {} });
assert.equal(orderStatus(), null);
order = { orderNum: 3, rewardedNum: 0 };
const before = orderSchedule.now();
await surveyOrder();
const check = orderSchedule.nextCheck('orderDaily');
assert(check >= Math.min(before + 180, orderSchedule.nextDay()) && check <= orderSchedule.now() + 180);
assert.equal(orderStatus().state, 'inProgress');
assert.equal(orderStatus().text, '今日已交 3 单，下一档 6 单，最高 40 单档');
orderUpdate();
order = { orderNum: 12, rewardedNum: 6 };
for (const player of [options.player, fifthSeason, undefined]) {
  const survey = await surveyTasks(orderClient, {}, { config: orderConfig, player, scheduler: orderSchedule });
  const steps = survey.plan.filter(step => step.kind === 'orderDaily');
  assert.deepEqual(steps.map(step => [step.id, step.request, step.body]), [[12, 'GetNextOrderOTDRewardRequest', {}]]);
}
assert.equal(orderStatus().state, 'claimable');
assert(orderSchedule.due('orderDaily'), 'order count is not proof the highest tier was claimed');
const claimOrder = () => claimRewards(orderClient, { GetNextOrderOTDRewardRequest: true }, orderConfig,
  undefined, key => key === 'tasks', undefined, orderSchedule, fifthSeason);
orderClient.sendWatch = async () => { throw Error('领取被拒'); };
await claimOrder();
assert.equal(orderStatus().state, 'error');
assert.equal(orderStatus().text, '领取被拒');
let pendingWrites = 0;
orderClient.sendWatch = async () => ({ sent: ++pendingWrites });
const pendingOrder = (await claimOrder()).filter(entry => entry.taskKey === 'orderDaily');
assert.equal(pendingWrites, 1);
assert.equal(pendingOrder.length, 1);
assert.equal(pendingOrder[0].pending, true);
assert.equal(orderStatus().state, 'pending');
order = { orderNum: 45, rewardedNum: 40 };
await surveyOrder();
assert.equal(orderStatus().state, 'completed');
orderUpdate();
order = { orderNum: 45, rewardedNum: 45 };
const inherited = await surveyTasks(orderClient, {}, { ...options, player: fifthSeason, scheduler: orderSchedule });
assert.equal(inherited.orderOfTheDay.maxTier, 45);
assert(!inherited.plan.some(step => step.kind === 'orderDaily'));
assert.equal(orderStatus().state, 'completed');
assert.equal(orderSchedule.nextCheck('orderDaily'), orderSchedule.nextDay());
orderUpdate();
await surveyTasks(orderClient, {}, { config: null, scheduler: orderSchedule });
assert.equal(orderStatus().state, 'unsynced');
assert(orderSchedule.due('orderDaily'), 'missing reward thresholds must not postpone claims until tomorrow');
order = undefined;
await surveyOrder();
assert.equal(orderStatus().text, '今日订单进度未同步');
orderSchedule.defer('otherReward', orderSchedule.nextDay());
assert.equal(orderSchedule.status('otherReward').state, 'waiting');

// 70/6：服务端从尚未领过的 6 单档开始，每次回读确认后才允许请求下一档。
const sixTiers = [6, 12, 18, 24, 30, 40];
const sevenTiers = [...sixTiers, 45];
const gameConfig = { tables: { OrderDailyRewardCfg: { data: [
  ...orderRows(10, 1, ...sevenTiers, 55), ...orderRows(1, 1, ...sixTiers), ...orderRows(4, 1, ...sevenTiers),
] } } };
for (let season = 5; season <= 9; season++) {
  const player = { worldId: String(season * 1e6 + 1) };
  assert.deepEqual(nextOrderTier(gameConfig, { player, orderNum: 70, rewardedNum: 40 }),
    { tier: 45, reqNums: sevenTiers, maxTier: 45, claimable: true });
}
assert.equal(nextOrderTier(gameConfig, { player: { worldId: 10_000_001 }, rewardedNum: 45 }).tier, 55);
const futureOnly = { tables: { OrderDailyRewardCfg: { data: orderRows(10, 1, 55) } } };
assert.deepEqual(nextOrderTier(futureOnly, { player: fifthSeason, orderNum: 70 }),
  { tier: null, reqNums: [], maxTier: null, claimable: false });
const chestConfig = { tables: { DailyActivityRewardCfg: { data: [
  { season: 10, id: 7, activity: 5 }, { season: 4, id: 1, activity: 20 }, { season: 4, id: 2, activity: 40 },
] } } };
const chestPlan = planChests({ dailyActivity: 25 }, chestConfig, fifthSeason);
assert.deepEqual(chestPlan.actions[0].body.index, [1]);
assert.equal(chestPlan.daily.nextAt, 40);
const settings = defaultSettings();
settings.loop.tasks = settings.resident.enabled = false;
settings.loop.world = settings.resident.rewards = true;
const probe = Object.assign(new EventEmitter(), { connected: true });
probe.setMaxListeners(100);
const schedule = rewardSchedule(probe);
const orderProtocol = { GetNextOrderOTDRewardRequest: true };
const calls70 = [], events = [];
let claimed = 0, delivered = 70, readError = false, afterWrite;
probe.request = async name => {
  calls70.push(name);
  if (name === 'MainTaskInfoRequest') throw Error('主线读取超时');
  assert.equal(name, 'OnWaterRequest');
  if (readError) throw Error('订单读取超时');
  return { orderOfTheDay: { orderNum: delivered, rewardedNum: claimed } };
};
probe.sendWatch = async (name, body, { beforeSend }) => {
  beforeSend();
  assert.equal(name, 'GetNextOrderOTDRewardRequest');
  assert.deepEqual(body, {});
  claimed = sevenTiers.find(tier => tier > claimed);
  assert(claimed <= delivered, '只能按已交单数领取已解锁奖励');
  calls70.push(claimed);
  afterWrite?.();
};
const round = (player = fifthSeason) => runLoop(probe, orderProtocol, {
  allowMutate: true, config: gameConfig, getSettings: () => settings, player,
  isEnabled: key => key === 'tasks' && nativeTaskValues(settings, {}).tasks, onStep: entry => events.push(entry),
});
const writes = () => calls70.filter(value => typeof value === 'number');
schedule.defer('tasks', schedule.nextDay());
await round();
assert.deepEqual(calls70, ['OnWaterRequest', ...sevenTiers.flatMap(tier => [tier, 'OnWaterRequest'])]);
assert.deepEqual(events.filter(e => e.status === 'confirmed').map(e => e.note),
  sevenTiers.map(tier => '已领至 ' + tier + ' 单档'));
assert.equal(schedule.status('orderDaily').state, 'completed', 'S5 领至 S4 最高档后当天结束');
await round();
assert.deepEqual(writes(), sevenTiers, '已领的奖励不会重发');

schedule.clear('tasks');
schedule.clear('orderDaily');
settings.loop.tasks = true;
claimed = 0;
calls70.length = 0;
await round(options.player);
assert.deepEqual(writes(), sixTiers, '同样 70 单，S1 以 40 单档收尾');
assert(events.some(e => e.taskKey === 'tasks' && e.error === '主线读取超时'));
assert.equal(schedule.status('orderDaily').state, 'completed');

schedule.clear('orderDaily');
settings.loop.tasks = false;
settings.resident.rewards = false;
calls70.length = 0;
await round();
assert.deepEqual(calls70, []);
settings.resident.rewards = true;
claimed = 0;
delivered = 18;
afterWrite = () => { settings.resident.rewards = false; };
await round();
assert.deepEqual(writes(), [6], '中途暂停后不继续领下一档');
settings.resident.rewards = true;
afterWrite = () => { readError = true; };
await round();
assert.deepEqual(writes(), [6, 12]);
assert.equal(schedule.status('orderDaily').state, 'pending');
readError = false;
afterWrite = undefined;
const manual = await surveyTasks(probe, orderProtocol, { config: gameConfig, player: fifthSeason });
assert.equal(manual.taskError, '主线读取超时');
await Promise.all([
  runTasks(probe, orderProtocol, manual, { allowMutate: true, settings }),
  round(),
]);
assert.deepEqual(writes(), [6, 12, 18], '手动与挂机同时恢复时只领服务端剩余的一档');
console.log('daily schedule ok: confirmed claims, server reset, partial progress, live mail and manual bypass');
