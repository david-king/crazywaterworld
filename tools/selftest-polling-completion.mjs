import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { defaultSettings } from '../src/automation-settings.mjs';
import { runLoop } from '../src/loop.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';

// 同一连接连续挂机，只提供已经完成的服务端状态。任何意外读写均使测试失败。
const client = Object.assign(new EventEmitter().setMaxListeners(40), { connected: true });
const settings = defaultSettings();
const player = { worldId: '1001001', playerId: '77', guildId: '12345', level: 35,
  vip: { vipLevel: 1, dailyReward: [{ vipLevel: 1, isGot: true }] } };
const keys = ['guildTitleReward', 'heroAdRecruit', 'antiqueAdRecruit', 'limitedFreeGifts', 'beautyVotes', 'beautyGift', 'vipDaily'];
settings.worldBoss.enabled = true;
Object.assign(settings.activityAutomation, { beauty: true, vip: true });
for (const key of keys) settings.schedule[key] = true;
const config = { tables: Object.fromEntries(Object.entries({
  ModuleOpenCfg: ['世界', '广告', '海上风采大赛'].map(moduleId => ({ moduleId, playerLevel: 1 })),
  WorldParamCfg: [{ paramName: '进攻首领消耗汽油', paramValue: 5 }],
  GuildDailyRewardCfg: [{ title: 1, reward: [['RUBY', 1]] }],
  VipFreeCfg: [{ level: 1 }], VipLevelCfg: [{ level: 1, effects: [['免广告', 1]] }],
  AdvEffectCfg: [{ id: 2, dailyLimit: 1 }, { id: 7, dailyLimit: 1 }], AdvChannelCfg: [{ key: 'a', isOpen: true }],
  LimitedPackCfg: [{ id: 1, type: '日礼包', price: 0, limitedTimes: 1 }],
  WeekChipPackCfg: [{ packId: 10, price: 0, buyLimit: 1 }],
}).map(([key, data]) => [key, { data }])) };
const ledger = { keyRecords: () => ({}), hasKey: () => false, snapshot: () => ({ counters: {} }), pendingCounters: () => ({}) };
const realNow = Date.now;
let ms = Date.parse('2026-11-25T09:00:00+08:00');
Date.now = () => ms;
try {
  const schedule = rewardSchedule(client), now = schedule.now, reset = schedule.nextDay();
  client.beautyWindow = { period: 1, startTime: now() - 3600, endTime: reset + 86400 };
  const calls = [], unexpected = [];
  let guildFailure = false;
  const responses = {
    GuildInfoRequest: () => {
      if (guildFailure) throw Error('模拟暂时读取失败');
      return { guild: { guildId: player.guildId }, gotTitle: 1, gotTitleTime: now() };
    },
    LimitedShopRequest: () => ({ shopItem: [{ id: 1, gotTimes: 1 }], resetTime: schedule.nextDay() }),
    BeautyInfoRequest: () => ({ todayVote: 3, gotVote: true }),
    OnWaterRequest: () => ({ building: [], adv: [{ id: 2, gotTimes: 1 }, { id: 7, gotTimes: 1 }] }),
    WorldBossInfoRequest: () => ({ info: { bossId: 1, gridIdx: 5 } }),
    CounterInfoRequest: () => ({ counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: 1, updateTime: now() }] }),
    MyFleetsRequest: () => ({ fleets: [] }), AllItemRequest: () => ({ items: [] }),
    WeekInfoRequest: () => ({ activityTime: [{ type: 6, period: 2, startTime: reset - 86400, endTime: reset + 86400 }] }),
    WeekChipInfoRequest: () => ({ gifts: [{ giftId: 10, paidTimes: 1 }] }),
  };
  client.request = async (name, body) => {
    calls.push(name);
    if (!responses[name]) { unexpected.push(name); throw Error(name); }
    return responses[name](body);
  };
  const run = async (selected = keys, rounds = 1, protocol = {}) => {
    const reads = [];
    await runLoop(client, protocol, { config, player, usageLedger: ledger, adChannel: { clientInfo: { channelId: 'a' } },
      isEnabled: key => selected.includes(key), getSettings: () => settings, allowMutate: true, rounds, everyMs: 60_000,
      sleep: async delay => { ms += delay; }, onRound: () => reads.push(calls.splice(0)) });
    assert.deepEqual(unexpected, []);
    return reads;
  };
  const [first, second] = await run(keys, 2);
  assert.deepEqual(first.sort(), ['GuildInfoRequest', 'LimitedShopRequest', 'BeautyInfoRequest', 'BeautyInfoRequest',
    'OnWaterRequest', 'OnWaterRequest', 'WorldBossInfoRequest', 'CounterInfoRequest', 'MyFleetsRequest', 'OnWaterRequest', 'AllItemRequest'].sort());
  assert.deepEqual(second, []);
  for (const key of [...keys, 'worldBoss']) assert.equal(schedule.scheduledAt(key), reset, key);

  client.emit('message', { name: 'SCRedPoint', body: { redPoint: [{ type: 64, num: 1 }] } });
  guildFailure = true;
  assert.deepEqual(await run(), [['GuildInfoRequest']]);
  assert(schedule.due('guildTitleReward'));
  guildFailure = false;
  assert.deepEqual(await run(), [['GuildInfoRequest']]);
  client.emit('message', { name: 'SCVipUpdate', body: { vipLevel: 1 } });
  assert.deepEqual(await run(), [['LimitedShopRequest']]);

  // 旧芯片开关也走统一补给入口，并遵守同一个期限。
  settings.activityAutomation.weekChip = true;
  const alias = ['weekChipFree'];
  assert.deepEqual(await run(alias, 2), [['WeekInfoRequest', 'WeekChipInfoRequest'], []]);
  ms = reset * 1000;
  assert(schedule.due('guildTitleReward'));
  // 模拟新一天的登录快照，以已完成状态检查所有应恢复的入口。
  client.emit('message', { name: 'LoginResponse', body: {} });
  assert.deepEqual((await run())[0].sort(), first);
  assert.deepEqual(await run(alias), [['WeekInfoRequest', 'WeekChipInfoRequest']]);
  settings.worldBoss.enabled = settings.loop.world = false;
  settings.loop.dailies = settings.gold.enabled = true;
  settings.gold.times = 2;
  config.tables.OfflineParamCfg = { data: [{paramName:'免费点金次数',paramValue:1},{paramName:'点金价格',paramValue:10}] };
  responses.ClickGoldInfoRequest = () => ({ info: {freeTimes:1,paidTimes:2,maxPaidTimes:7,resetTime:schedule.nextDay()} });
  const goldProtocol = {OnWaterRequest:true,OnWaterResponse:true,ClickGoldInfoRequest:true,ClickGoldInfoResponse:true};
  const goldRound = () => run([],1,goldProtocol);
  assert.deepEqual(await goldRound(), [['OnWaterRequest','ClickGoldInfoRequest']]);
  assert.equal(schedule.scheduledAt('gold.enabled'),schedule.nextDay());
  assert.deepEqual(await goldRound(), [[]]);
  settings.gold.times = 3;
  assert.deepEqual(await goldRound(), [['OnWaterRequest','ClickGoldInfoRequest']]);
  assert(schedule.due('gold.enabled'));
  settings.gold.enabled = false;
  settings.activityAutomation.weekHeroStar = true;
  const end = now() + 3600;
  responses.WeekInfoRequest = () => ({ activityTime:[{type:3,period:1,startTime:end-7200,endTime:end}] });
  responses.WeekHeroStarInfoRequest = () => ({gotStage:2});
  config.tables.WeekHeroStarPeriodCfg = { data:[{periodId:1}] };
  config.tables.WeekHeroStarRwdCfg = { data:[{periodId:1,rwdId:1},{periodId:1,rwdId:2}] };
  assert.deepEqual(await run(['weekHeroStar'],2), [['WeekInfoRequest','WeekHeroStarInfoRequest'],[]]);
  assert.equal(schedule.scheduledAt('weekHeroStar'),end);
  client.emit('login', {});
  assert(schedule.due('weekHeroStar'));
  console.log('通过：已完成任务连续两轮读取 11 → 0，跨日、领取红点、VIP、暂时失败和周补给旧开关均按期复查');
} finally { Date.now = realNow; }
