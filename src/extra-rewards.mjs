import { displayMaterial } from './config.mjs';
import { toNumber } from './client.mjs';
import { normalize } from './worlds.mjs';
import { seasonRows, seasonOf } from './season-config.mjs';
export { seasonRows, seasonOf };

export const extraRewardKeys = ['tradeTasks', 'guildTitleReward', 'guildAidCollect', 'heroRecruitRewards',
  'seasonTasks', 'crossRankDaily', 'worldBossDamage', 'passStageRewards'];

const labels = {
  tradeTasks: '海商王联盟任务', guildTitleReward: '联盟职级奖励', guildAidCollect: '联盟互助收取',
  heroRecruitRewards: '英雄累计招募奖励', seasonTasks: '赛季任务奖励', crossRankDaily: '跨服排行每日奖励',
  worldBossDamage: '世界 Boss 伤害奖励', passStageRewards: '闯关基金奖励',
};
const CROSS_RANK_RED_POINT = 33;
const REWARD_REPLIES = ['GotRewardResponse', 'OkResponse'];
const DAY = 86400;
const BEIJING = 8 * 3600;
const WAR_START_HOUR = 20;
const WAR_END_HOUR = 21;
const MAX_PASS_CLAIMS = 10;

const rows = (config, table) => config?.tables?.[table]?.data ?? [];
const clock = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const startOfDay = time => Math.floor((time + BEIJING) / DAY) * DAY - BEIJING;
const replyAssets = (config, reward) => (normalize(reward)?.asset ?? []).map(item => displayMaterial(config, item.id) + ' ×' + item.num).join('、');
const withReward = (label, text) => (text ? label + ' · 获得 ' + text : label);
const moduleLevel = (config, id) => rows(config, 'ModuleOpenCfg').find(row => row.moduleId === id)?.playerLevel;

export function gameplayOpenDay(config, player, gameplay) {
  const days = rows(config, 'GameplayOpenCfg').find(row => row.gameplay === gameplay)?.openDays;
  if (!Array.isArray(days) || !days.length) return 0;
  const season = Math.max(seasonOf(player), 1);
  return days[Math.min(season, days.length) - 1] ?? 0;
}

export function worldOpenDays(player, now) {
  const opened = toNumber(player?.worldOpenTime);
  if (!(opened > 0)) return null;
  return Math.floor((now - startOfDay(opened)) / DAY) + 1;
}

export function worldOnlineWindow(config, player, now) {
  const today = startOfDay(now);
  const days = worldOpenDays(player, now);
  const waitDays = days === null ? 0 : Math.max(0, gameplayOpenDay(config, player, '国战') - days);
  const openDay = today + waitDays * DAY;
  return { startTime: openDay + WAR_START_HOUR * 3600, endTime: openDay + WAR_END_HOUR * 3600, resetTime: today + DAY };
}

async function claimTradeTasks({ client, config, player, scheduler, report, allowed }) {
  const key = 'tradeTasks';
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  const required = moduleLevel(config, '海商王');
  const currentActivity = () => client.tradeWindow === undefined ? client.tradeActivity : client.tradeWindow;
  const activity = { ...currentActivity() };
  const now = clock(client);
  if (!(player?.level >= required)) { later(3600); return report(skip(key, '海商王 ' + required + ' 级开放')); }
  if (!(activity?.startTime <= now && now < activity?.endTime)) { later(3600); return report(skip(key, '海商王活动未开放')); }
  const active = () => {
    const current = currentActivity(), time = clock(client);
    return allowed(key) && client.connected !== false && current?.period === activity.period
      && current?.startTime === activity.startTime && current?.endTime === activity.endTime
      && activity.startTime <= time && time < activity.endTime;
  };
  const task = (await client.request('TradeTaskRequest', {}, 'TradeTaskResponse'))?.guildTask;
  if (!task) throw new Error('未能读取海商王联盟任务');
  const got = new Set(task.gotTaskId ?? []);
  const activityDay = Math.floor((now - startOfDay(activity.startTime)) / DAY) + 1;
  const ready = rows(config, 'TradeGuildTaskCfg').filter(row => row.day <= activityDay && !got.has(row.id)
    && (row.taskType === 0 ? task.profit : task.tradeTimes) >= row.tragetCount);
  for (const day of [...new Set(ready.map(row => row.day))].sort((a, b) => a - b)) {
    if (!active()) return;
    const reply = await client.request('TradeGotTaskRequest', { day }, 'TradeGotTaskResponse');
    const confirmed = new Set(reply?.gotTaskId ?? []);
    if (!ready.filter(row => row.day === day).some(row => confirmed.has(row.id))) throw new Error('服务端未确认第 ' + day + ' 天任务奖励');
    report({ key, label: withReward('海商王联盟任务 · 第 ' + day + ' 天', replyAssets(config, reply.reward)), ok: true });
  }
  later(600);
  if (!ready.length) report(skip(key, '当前没有可领取的任务'));
}

function isMember(player) {
  return toNumber(player?.guildId) > 0;
}

async function claimGuildTitle({ client, config, player, scheduler, report }) {
  const key = 'guildTitleReward';
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!isMember(player)) { later(1800); return report(skip(key, '当前账号未加入联盟')); }
  const info = await client.request('GuildInfoRequest', {}, 'GuildInfoResponse');
  const now = clock(client);
  const nextDay = startOfDay(now) + DAY;
  if (!info?.gotTitle) { scheduler?.defer(key, nextDay); return report(skip(key, '今天没有可领取的职级奖励')); }
  if (info.gotTitleTime >= startOfDay(now)) { scheduler?.defer(key, nextDay); return report(skip(key, '今天已领取')); }
  const reply = await client.request('GotGuildTitleRewardRequest', {}, REWARD_REPLIES);
  scheduler?.defer(key, nextDay);
  report({ key, label: withReward('联盟职级奖励', replyAssets(config, reply?.reward)), ok: true });
}

async function collectGuildAid({ client, config, player, scheduler, report }) {
  const key = 'guildAidCollect';
  const later = seconds => scheduler?.defer(key, scheduler.now() + seconds);
  if (!isMember(player)) { later(1800); return report(skip(key, '当前账号未加入联盟')); }
  const aids = normalize(await client.request('MyGuildAidRequest', {}, 'MyGuildAidResponse'))?.aids;
  if (!Array.isArray(aids)) throw new Error('未能读取我的求助');
  later(900);
  if (!aids.some(aid => aid.helper?.playerId > 0)) return report(skip(key, '暂时没有成员响应求助'));
  const reply = await client.request('GotMyGuildAidRequest', {}, REWARD_REPLIES);
  report({ key, label: withReward('已收取联盟互助', replyAssets(config, reply?.reward)), ok: true });
}

async function claimHeroRecruit({ client, config, player, scheduler, report, allowed }) {
  const key = 'heroRecruitRewards';
  const tiers = [...seasonRows(config, 'HeroRecruitTaskCfg', player)].sort((a, b) => a.id - b.id);
  scheduler?.defer(key, scheduler.now() + 1800);
  if (!tiers.length) return report(skip(key, '未找到当前赛季的招募奖励配置'));
  let task = (await client.request('RecruitInfoRequest', {}, 'RecruitInfoResponse'))?.hero?.task;
  while (allowed(key)) {
    if (!Number.isSafeInteger(task?.times) || !Number.isSafeInteger(task?.gotId)) return report(skip(key, '无法确认累计招募次数'));
    const tier = tiers.find(row => row.id > task.gotId);
    if (!tier) return report(skip(key, '本赛季奖励已领完'));
    if (task.times < tier.times) return report(skip(key, '累计招募 ' + task.times + '/' + tier.times + ' 次'));
    const reply = await client.request('GotHeroRecruitTaskRequest', {}, 'GotRecruitTaskResponse');
    if (reply?.gotId !== tier.id) throw new Error('服务端未确认第 ' + tier.id + ' 档招募奖励');
    report({ key, label: withReward('英雄累计招募 · 第 ' + tier.id + ' 档', replyAssets(config, reply.reward)), ok: true });
    task = { ...task, gotId: reply.gotId };
  }
}

export function seasonTaskReady(tasks, got, tiers) {
  return tiers.filter(tier => {
    const task = tasks.find(row => row.stage === tier.stage);
    const claimed = got.find(row => row.stage === tier.stage);
    if (!task) return false;
    return (task.personProgress >= tier.personTarget && !claimed?.gotPerson)
      || (task.teamProgress >= tier.teamTarget && !claimed?.gotTeam);
  });
}

async function claimSeasonTasks({ client, config, player, scheduler, report }) {
  const key = 'seasonTasks';
  scheduler?.defer(key, scheduler.now() + 1800);
  const required = moduleLevel(config, '世界');
  if (!(player?.level >= required)) return report(skip(key, '世界玩法 ' + required + ' 级开放'));
  const info = await client.request('SeasonTaskRequest', {}, 'SeasonTaskResponse');
  const ready = seasonTaskReady(info?.task ?? [], info?.got ?? [], seasonRows(config, 'SeasonTaskCfg', player));
  if (!ready.length) return report(skip(key, '当前没有可领取的赛季任务'));
  const reply = await client.request('GotSeasonTaskRequest', {}, 'GotSeasonTaskResponse');
  if (!reply?.got?.length) throw new Error('服务端未确认赛季任务奖励');
  report({ key, label: withReward('赛季任务奖励', replyAssets(config, reply.reward)), ok: true });
}

async function claimCrossRank({ client, config, scheduler, report }) {
  const key = 'crossRankDaily';
  const pending = scheduler?.redPoint?.(CROSS_RANK_RED_POINT) > 0;
  scheduler?.defer(key, scheduler.now() + 3600);
  if (!pending) return report(skip(key, '当前没有可领取的奖励'));
  const reply = await client.request('GetDailyRewardRequest', {}, REWARD_REPLIES);
  scheduler.clearRedPoint?.(CROSS_RANK_RED_POINT);
  report({ key, label: withReward('跨服排行每日奖励', replyAssets(config, reply?.reward)), ok: true });
}

export function worldBossRewardLevel(info, tiers) {
  const done = info?.gotRewardLevel ?? 0;
  return tiers.filter(row => row.level > done && info?.bestDamage >= row.damage).reduce((max, row) => Math.max(max, row.level), 0);
}

async function claimWorldBoss({ client, config, player, scheduler, report }) {
  const key = 'worldBossDamage';
  scheduler?.defer(key, scheduler.now() + 1800);
  const info = normalize(await client.request('WorldBossInfoRequest', {}, 'WorldBossInfoResponse'))?.info;
  if (!(info?.bossId > 0)) return report(skip(key, '世界 Boss 未开放'));
  const tiers = seasonRows(config, 'WorldBossDamageRewardCfg', player).filter(row => row.bossId === info.bossId);
  const level = worldBossRewardLevel(info, tiers);
  if (!level) return report(skip(key, '伤害未达到下一档'));
  const reply = await client.request('WorldBossGetDamageRewardRequest', {}, REWARD_REPLIES);
  report({ key, label: withReward('世界 Boss 伤害奖励 · 第 ' + level + ' 档', replyAssets(config, reply?.reward)), ok: true });
}

async function claimPassStage({ client, config, scheduler, report, allowed }) {
  const key = 'passStageRewards';
  scheduler?.defer(key, scheduler.now() + 1800);
  const state = await client.request('PassStageStateRequest', {}, 'PassStageStateResponse');
  if (state?.isOver || !(state?.maxOpenStage > 0)) return report(skip(key, '闯关基金未开放'));
  const pending = (await client.request('PassStageRequest', { stage: state.maxOpenStage }, 'PassStageResponse'))?.rwdStage ?? [];
  if (!pending.length) return report(skip(key, '当前没有可领取的奖励'));
  for (const stage of pending.slice(0, MAX_PASS_CLAIMS)) {
    if (!allowed(key)) return;
    const reply = await client.request('PassStageGotRewardRequest', { stage }, 'PassStageGotRewardResponse');
    report({ key, label: withReward('闯关基金 · 第 ' + stage + ' 期', replyAssets(config, reply?.reward)), ok: true });
  }
}

const skip = (key, reason) => ({ key, label: labels[key], skipped: true, reason });

// 一项失败不影响其他项，失败后 30 分钟再试，避免反复请求已被拒绝的接口。
export async function claimExtraRewards(client, config, player, allowed, report, scheduler = null, active = allowed) {
  const ctx = { client, config, player, scheduler, report, allowed: active };
  const steps = [
    ['tradeTasks', claimTradeTasks],
    ['guildTitleReward', claimGuildTitle],
    ['guildAidCollect', collectGuildAid],
    ['heroRecruitRewards', claimHeroRecruit],
    ['seasonTasks', claimSeasonTasks],
    ['crossRankDaily', claimCrossRank],
    ['worldBossDamage', claimWorldBoss],
    ['passStageRewards', claimPassStage],
  ];
  const run = async (key, work) => {
    try { await work(); }
    catch (error) {
      scheduler?.defer(key, scheduler.now() + 1800);
      report({ key, label: labels[key], ok: false, error: error.message });
    }
  };
  for (const [key, claim] of steps) {
    if (allowed(key)) await run(key, () => claim(ctx));
  }
}
