import { runAction } from './actions.mjs';
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
      if (action === 'afkDraw') setDeadline(reply.body?.afkFinishTime);
    });
  }
  function setDeadline(finishTime) {
    const deadline = finishTime * 1000 - (client.serverClockOffsetMs || 0);
    if (finishTime > 0) onAfkDeadline?.(deadline > Date.now() ? deadline : Date.now() + 60_000);
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
    setDeadline(afkInfo.afkFinishTime);
    scheduler?.observe?.('afk','当前闯关等级 '+afkInfo.level+' · 收益'+(afkInfo.afkFinishTime*1000>Date.now()+(client.serverClockOffsetMs||0)?'积累中':'等待领取'));
    if (afkInfo.afkFinishTime > 0 && afkInfo.afkFinishTime * 1000 <= Date.now() + (client.serverClockOffsetMs || 0)) {
      await draw('afk', '闯关挂机收益已满，领取本段收益', 'afkDraw');
    }
    const level = config?.nextAfkRewardLevel(afkInfo.rewardedLevel ?? 0);
    if (level != null && level <= afkInfo.level) await draw('afk', `挂机等级 ${level} 奖励`, 'afkLevelDraw', { level });
  });
  return results;
}
