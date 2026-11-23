import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { claimRewards } from '../src/claim-rewards.mjs';
import { nextOrderTier, surveyTasks } from '../src/tasks.mjs';
import { runLoop } from '../src/loop.mjs';
import { defaultSettings } from '../src/automation-settings.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';
import { runtimeSources } from '../src/runtime-progress.mjs';

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

const orderConfig = { tables: { OrderDailyRewardCfg: { data: [
  { season: 1, worldOpenDays: 1, reqNum: 40 },
  { season: 2, worldOpenDays: 1, reqNum: 40 },
  { season: 2, worldOpenDays: 5, reqNum: 40 }, { season: 2, worldOpenDays: 5, reqNum: 45 },
] } } };
const firstSeason = { worldId: 1000001, worldOpenTime: 1 };
const lateSeason2 = { worldId: 2000001, worldOpenTime: 1 };
assert.equal(nextOrderTier(orderConfig, { rewardedNum: 40, player: firstSeason }).tier, null);
assert.equal(nextOrderTier(orderConfig, { rewardedNum: 40, player: lateSeason2, now: 1000 }).tier, null);
assert.equal(nextOrderTier(orderConfig, { rewardedNum: 40, player: lateSeason2, now: 5 * 86400 }).tier, 45);

let order = { orderNum: 40, rewardedNum: 40 };
const reads = [];
const orderClient = {
  async request(name) {
    reads.push(name);
    if (name === 'MainTaskInfoRequest') return {};
    if (name === 'AchievementInfoRequest') return { task: [{ id: 17, progress: 2, targetProgress: 2, rewardClaimed: false }] };
    if (name === 'OnWaterRequest') return { orderOfTheDay: order };
    assert.fail(name);
  },
};
const options = { config: orderConfig, player: firstSeason };
await surveyTasks(orderClient, {}, { ...options, scheduler });
assert.equal(deadlines.get('orderDaily'), scheduler.nextDay());
reads.length = 0;
const skippedOrder = await surveyTasks(orderClient, {}, { ...options, scheduler });
assert.deepEqual(reads, ['MainTaskInfoRequest', 'AchievementInfoRequest']);
assert.equal(skippedOrder.plan[0].kind, 'achievement');
await surveyTasks(orderClient, {}, options);
assert(reads.includes('OnWaterRequest'), 'manual daily order lookup remains live');
deadlines.delete('orderDaily');
order = { orderNum: 3, rewardedNum: 0 };
await surveyTasks(orderClient, {}, { ...options, scheduler });
assert.equal(deadlines.get('orderDaily'), now + 180);
deadlines.delete('orderDaily');
order = { orderNum: 40, rewardedNum: 0 };
assert((await surveyTasks(orderClient, {}, { ...options, scheduler })).plan.some(step => step.kind === 'orderDaily'));
assert(scheduler.due('orderDaily'), 'order count is not proof the highest tier was claimed');
order.rewardedNum = 40;
await surveyTasks(orderClient, {}, { config: orderConfig, scheduler });
assert(scheduler.due('orderDaily'), 'unknown player season must not postpone claims until tomorrow');

// 居民奖励通过共享领奖入口执行，概览按居民奖励自己的键读取结果。
const settings = defaultSettings();
settings.loop.tasks = false;
settings.loop.world = settings.resident.rewards = true;
const clientForLoop = new EventEmitter();
clientForLoop.setMaxListeners(100);
clientForLoop.connected = true;
const requests = [], writes = [], reports = [];
let waterError, sendError;
clientForLoop.request = async name => {
  requests.push(name);
  if (name === 'MainTaskInfoRequest') throw Error('主线读取失败');
  assert.equal(name, 'OnWaterRequest');
  if (waterError) throw Error(waterError);
  return { orderOfTheDay: order };
};
clientForLoop.sendWatch = async name => {
  assert.equal(name, 'GetNextOrderOTDRewardRequest');
  writes.push(name);
  if (sendError) throw Error(sendError);
  return { sent: writes.length, name };
};
const schedule = rewardSchedule(clientForLoop);
const { key } = runtimeSources({ key: 'resident.rewards' }, settings);
const round = (config = orderConfig) => runLoop(clientForLoop, { GetNextOrderOTDRewardRequest: true }, {
  allowMutate: true, config, player: firstSeason, getSettings: () => settings,
  isEnabled: key => key === 'tasks', onStep: entry => reports.push(entry),
});
function checkStatus(state, text) {
  assert.equal(schedule.status(key)?.state, state);
  assert.match(schedule.status(key).text, text);
}

order = { orderNum: 3, rewardedNum: 0 };
await round();
checkStatus('waiting', /已交 3 单.*下一档需 40 单/);
assert.deepEqual(requests, ['OnWaterRequest']);
await round();
assert.equal(requests.length, 1, '冷却中沿用已检查结果');
assert.equal(writes.length, 0);

clientForLoop.emit('message', { name: 'SCOrderOfTheDay' });
order.orderNum = 70;
settings.loop.tasks = true;
sendError = '服务端拒绝领取';
await round();
checkStatus('error', /服务端拒绝领取/);
assert(reports.some(entry => entry.taskKey === 'tasks' && entry.error === '主线读取失败'));
assert.equal(writes.length, 1, '主线读取失败仍可独立核对订单');
settings.loop.tasks = false;
sendError = null;
await round();
checkStatus('sent', /40 单档位奖励/);
assert.equal(reports.at(-1).taskKey, key);
assert.equal(writes.length, 2);

order.rewardedNum = 40;
await round();
checkStatus('waiting', /已领完本日全部档位.*40 单档/);
assert.equal(schedule.nextCheck(key), schedule.nextDay());
assert.equal(writes.length, 2, '回读已领后不再发送');
clientForLoop.emit('message', { name: 'SCOrderOfTheDay' });
await round({ tables: {} });
checkStatus('unsynced', /赛季.*档位/);
order = null;
await round();
checkStatus('unsynced', /订单进度尚未同步/);
waterError = '订单读取超时';
await round();
checkStatus('error', /订单读取超时/);
assert.equal(reports.at(-1).taskKey, key);
assert.equal(writes.length, 2);
settings.resident.rewards = false;
const beforeDisabled = requests.length;
await round();
assert.equal(requests.length, beforeDisabled);
console.log('daily schedule ok: confirmed claims, server reset, partial progress, resident reward status, live mail and manual bypass');
