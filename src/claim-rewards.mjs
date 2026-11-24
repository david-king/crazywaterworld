import { runAction } from './actions.mjs';
import { afkClaimTime } from './afk-rewards.mjs';
import { claimDailies } from './dailies.mjs';
import { surveyTaskRewards, surveyOrderDaily, runTasks } from './tasks.mjs';
import { claimMail } from './mail.mjs';

export async function claimRewards(client, protocol, config, onResult, enabled = () => true, onAfkDeadline, scheduler, player, { settings = null, getSettings = () => settings } = {}) {
  const results = [];
  const ready = key => enabled(key) && (!scheduler || scheduler.due(key));
  const report = entry => {
    results.push(entry);
    onResult?.(entry);
  };
  async function group(label, keys, work) {
    try { await work(); }
    catch (error) {
      for (const key of keys) if (enabled(key)) scheduler?.observe?.(key, error.message, 'error');
      report({ label, ok: false, error: error.message, taskKey: keys[0] });
    }
  }
  async function draw(key, label, action, params = {}) {
    if (!ready(key)) return;
    await group(label, [key], async () => {
      const reply = await runAction(client, protocol, action, params, { allowMutate: true });
      report({ label, ok: true, taskKey: key });
      if (action === 'afkDraw') {
        const hours = getSettings()?.afk?.claimIntervalHours;
        // 可提前领取时，缺少新起点的回包要复查，不能一直等到封顶。
        setDeadline(hours > 0 && !reply.body?.afkStartTime ? null : afkClaimTime(reply.body, hours));
      }
    });
  }
  function setDeadline(claimTime) {
    const now = Date.now();
    const deadline = claimTime * 1000 - (client.serverClockOffsetMs || 0);
    onAfkDeadline?.(claimTime != null && deadline > now ? deadline : now + 60_000);
  }

  if (ready('tasks')) {
    const options = { config, scheduler, player };
    if (!settings || settings.loop.tasks) await group('任务与成就', ['tasks'], async () => {
      const survey = await surveyTaskRewards(client, options);
      await runTasks(client, protocol, survey, { allowMutate: true, enabled: () => enabled('tasks'), settings,
        onStep: entry => report({ label: entry.step.label, ok: entry.ok, error: entry.error }) });
    });
    const orderEnabled = () => {
      const current = getSettings();
      return enabled('tasks') && (!current || (current.loop.world && current.resident.rewards));
    };
    if (orderEnabled()) await group('每日订单', ['orderDaily'], async () => {
      const survey = await surveyOrderDaily(client, options);
      if (survey.orderError) throw new Error(survey.orderError);
      await runTasks(client, protocol, survey, { allowMutate: true, enabled: orderEnabled,
        onStep: ({ step, ...result }) => report({ label: step.label, taskKey: 'orderDaily', ...result }) });
    });
  }
  if (['dailyRewards', 'chests', 'gift'].some(ready)) await group('日常与赠礼', ['dailyRewards', 'chests', 'gift'], () => claimDailies(client, protocol, { config, enabled, scheduler, settings, getSettings,
    onStep: (entry) => report({ label: entry.note || entry.title, ok: entry.ok, error: entry.error }) }));
  if (ready('mail')) await group('邮件', ['mail'], async () => {
    const entry = await claimMail(client, { enabled: () => enabled('mail') });
    if (entry.status === 'empty') {
      scheduler?.observe?.('mail', entry.reason);
      if (scheduler) scheduler.defer('mail', scheduler.now() + 180);
    } else report(entry);
  });
  if (ready('afk')) await group('挂机收益', ['afk'], async () => {
    const { afkInfo } = await client.request('AfkInfoRequest', {}, 'AfkInfoResponse');
    if (!afkInfo) throw Error('挂机收益状态未同步');
    const claimTime = afkClaimTime(afkInfo, getSettings()?.afk?.claimIntervalHours);
    const now = (Date.now() + (client.serverClockOffsetMs || 0)) / 1000;
    setDeadline(claimTime);
    const due = claimTime != null && claimTime <= now;
    scheduler?.observe?.('afk', '挂机等级 ' + afkInfo.level + ' · ' + (due ? '等待领取' : claimTime == null ? '等待挂机计时' : '收益积累中'));
    if (due) {
      const label = now >= afkInfo.afkFinishTime ? '闯关挂机收益已满，领取本段收益' : '闯关挂机达到领取间隔，领取本段收益';
      await draw('afk', label, 'afkDraw');
    }
    const level = config?.nextAfkRewardLevel(afkInfo.rewardedLevel ?? 0);
    if (level != null && level <= afkInfo.level) await draw('afk', `挂机等级 ${level} 奖励`, 'afkLevelDraw', { level });
  });
  return results;
}
