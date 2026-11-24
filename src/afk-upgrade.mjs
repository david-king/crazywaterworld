import { exactAutomationId } from './automation-policy.mjs';
import { farmInventory } from './farm-planting.mjs';
import { linkOperationResult } from './operation-log.mjs';
import { normalize } from './worlds.mjs';

const badge = '挂机徽章';
const request = 'UpgradeAfkLevelRequest', response = 'UpgradeAfkLevelResponse';
const wait = reason => ({ skipped: true, reason });

export async function readAfkUpgrade(client, config, player, ledger, { reconcile = false } = {}) {
  const role = exactAutomationId(player?.playerId), world = exactAutomationId(player?.worldId);
  const mainlineStage = player?.mainlineStage;
  if (!role || !world || !Number.isSafeInteger(mainlineStage) || mainlineStage < 1)
    return wait('等待角色和主线关卡同步');
  const { afkInfo } = await client.request('AfkInfoRequest', {}, 'AfkInfoResponse');
  const level = afkInfo?.level;
  if (!Number.isSafeInteger(level) || level < 1) return wait('等待挂机等级同步');
  const prefix = `afkUpgrade:${world}:${role}:`;
  const uniqueKey = prefix + level;
  for (const [key, record] of Object.entries(ledger.keyRecords())) {
    if (!key.startsWith(prefix)) continue;
    if (key === uniqueKey || (!record.confirmed && !(level >= record.details?.target))) {
      return { skipped: true, status: 'pending', reason: '上次挂机升级待确认，等待游戏同步等级' };
    }
    if (reconcile && !record.confirmed) ledger.resolveKey(key, true);
  }
  const rows = config?.tables?.OfflineCfg?.data;
  if (!Array.isArray(rows)) return wait('缺少当前挂机等级配置');
  const levels = new Map(rows.map(row => [row.level, row]));
  if (!levels.has(level)) return wait('缺少当前挂机等级配置');
  const next = levels.get(level + 1);
  if (!next) return wait(rows.some(row => row.level > level) ? '缺少下一级挂机配置' : '已达到最高挂机等级');
  if (!Number.isSafeInteger(next.stage) || next.stage < 0) return wait('缺少挂机升级的关卡条件');
  const maxLevel = config.afkMaxLevel?.(mainlineStage);
  if (!Number.isSafeInteger(maxLevel)) return wait('缺少挂机升级的关卡条件');
  if (level >= maxLevel) return wait(`升至 ${next.level} 级需要通关第 ${next.stage} 关`);
  const itemName = config.materialName?.(badge) ?? '定位芯片';
  const bag = await client.request('AllItemRequest', {}, 'AllItemResponse');
  const owned = farmInventory(normalize(bag)).get(badge) ?? 0;
  // OfflineRewardView 只提供 1、5、10 级三个档位，按每个目标等级的 consume 累加费用。
  let count = 0, cost = 0;
  for (const batch of [1, 5, 10]) {
    if (level + batch > maxLevel) break;
    let batchCost = cost;
    for (let step = count + 1; step <= batch; step++) {
      const consume = levels.get(level + step)?.consume;
      if (!Array.isArray(consume) || consume.length !== 2 || consume[0] !== badge || !Number.isSafeInteger(consume[1]) || consume[1] < 1)
        return wait(`无法确认 ${level + step} 级的${itemName}消耗`);
      batchCost += consume[1];
    }
    if (batchCost > owned) {
      if (count === 0) return wait(`升至 ${next.level} 级需要 ${batchCost} 枚${itemName}，当前有 ${owned} 枚`);
      break;
    }
    count = batch;
    cost = batchCost;
  }
  const action = { kind: 'afkUpgrade', setting: 'schedule.afkUpgrade', request, response,
    body: { level: count }, costs: [{ id: badge, num: cost }], verify: { level: level + count },
    label: `挂机等级 ${level} → ${level + count}，消耗 ${cost} 枚${itemName}` };
  return { action, level, uniqueKey };
}

export async function upgradeAfk(client, protocol, config, player, { ledger, guard, enabled }) {
  if (!protocol?.[request] || !protocol[response]) return wait('游戏协议缺少挂机升级请求或回执');
  if (!ledger) return wait('缺少当前账号的升级记录');
  const epoch = client.connectionEpoch;
  const plan = await readAfkUpgrade(client, config, player, ledger, { reconcile: true });
  if (!plan.action) return plan;
  if (!enabled() || client.connectionEpoch !== epoch) return wait('挂机升级已暂停或连接已更换');
  const { action, level, uniqueKey } = plan;
  const check = () => {
    if (!enabled() || client.connected === false || client.connectionEpoch !== epoch)
      throw Object.assign(Error('挂机升级已暂停或连接已更换'), { notSent: true });
  };
  const ticket = await guard.before(action);
  let hold, attempted = false;
  try {
    check();
    const { afkInfo } = await client.request('AfkInfoRequest', {}, 'AfkInfoResponse');
    if (afkInfo?.level !== level) throw Object.assign(Error('挂机等级已变化，下一轮重新检查'), { notSent: true });
    check();
    hold = ledger.reserve({}, {}, {}, { uniqueKey, details: { target: action.verify.level } });
    attempted = true;
    const reply = await client.request(request, action.body, response, 15000, check);
    if (reply?.level !== action.verify.level) throw Error('升级回执未确认目标等级');
  } catch (error) {
    const notSent = !attempted || error.notSent === true;
    const rejected = error.prompt && error.request === request;
    if (hold && (notSent || rejected)) ledger.cancel(hold);
    await guard.cancel(action, ticket, { notSent, error });
    if (attempted && !notSent && !rejected)
      return linkOperationResult({ status: 'pending', reason: action.label + '，结果待确认：' + error.message }, ticket);
    if (notSent) return linkOperationResult(wait(error.message), ticket);
    throw linkOperationResult(error, ticket);
  }
  ledger.confirm(hold);
  const result = { ok: true, status: 'confirmed', label: action.label };
  await guard.after(action, ticket, result);
  return linkOperationResult(result, ticket);
}
