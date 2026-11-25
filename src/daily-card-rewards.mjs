import { clock, dayOf } from './activity-actions.mjs';

const cards = {
  monthCardDaily: { label: '月卡', query: 'MonthCard', request: 'MonthCardDailyRewardRequest' },
  seasonCardDaily: { label: '赛季卡', query: 'SeasonCard', request: 'SeasonCardGotDailyRequest' },
};
export const dailyCardKeys = Object.keys(cards);
const monthNames = { 1: '普通月卡', 2: '高级月卡' };
const sessionClaims = new WeakMap();

export function monthCardBody(type = 1) {
  if (![1, 2, '1', '2'].includes(type)) throw Error('月卡类型须为 1（普通月卡）或 2（高级月卡）');
  return { type: Number(type) };
}

export function cardRewardEnabled(key, settings, protocol) {
  return settings ? settings.dailies.enabled && settings.schedule?.[key] === true : !!protocol[cards[key].request];
}

async function readCards(client, protocol, key, timeout) {
  const { query, request } = cards[key];
  if (!protocol[query+'Request'] || !protocol[query+'Response'] || !protocol[request]) {
    throw Error('当前协议缺少' + cards[key].label + '每日领奖接口');
  }
  const reply = await client.request(query+'Request', {}, query+'Response', timeout);
  if (key === 'seasonCardDaily') {
    if (typeof reply?.isPaid !== 'boolean' || typeof reply.gotDaily !== 'boolean') throw Error('赛季卡状态未同步');
    const row = { label: '赛季卡', body: {} };
    if (!reply.isPaid) return [{ ...row, state: 'waiting', text: '未开通赛季卡' }];
    if (reply.gotDaily) return [{ ...row, state: 'completed', text: '赛季卡今日奖励已领取' }];
    // 游戏的赛季卡面板要求正好选定三个奖励后才开放每日领取。
    if (!Array.isArray(reply.customId)) throw Error('赛季卡自选奖励未同步');
    if (reply.customId.length !== 3) return [{ ...row, state: 'setup', text: '赛季卡自选奖励已选 ' + reply.customId.length + '/3，请在游戏内选满三项' }];
    return [{ ...row, state: 'claimable', text: '赛季卡今日奖励可领取' }];
  }
  if (!Array.isArray(reply?.cardItem)) throw Error('月卡状态未同步');
  const result = [], types = new Set();
  for (const item of reply.cardItem) {
    const type = item?.type;
    if (!Number.isInteger(type) || !Object.hasOwn(monthNames, type) || types.has(type) || !Number.isSafeInteger(item.endTime) ||
        item.endTime < -1 || typeof item.gotDailyReward !== 'boolean') throw Error('月卡类型、有效期或领取状态未同步');
    types.add(type);
    if (item.endTime !== -1 && item.endTime <= clock(client)) continue;
    const label = monthNames[type];
    result.push({ label, body: monthCardBody(type), endTime: item.endTime, state: item.gotDailyReward ? 'completed' : 'claimable',
      text: label + (item.gotDailyReward ? '今日奖励已领取' : '今日奖励可领取') });
  }
  return result;
}

// 预览和执行读取同一份领取标记。只有执行入口才写入账号的当日领取记录。
export async function dailyCardRewards(client, protocol, key, {
  claim = false, type, ledger, enabled = () => true, timeout = 8000,
} = {}) {
  const { label, request } = cards[key];
  const today = dayOf(clock(client));
  let rows;
  try { rows = await readCards(client, protocol, key, timeout); }
  catch (error) { return [{ label, state: 'error', text: label + '状态读取失败：' + error.message }]; }
  if (type !== undefined) rows = rows.filter(row => row.body.type === type);
  if (!rows.length) return [{ label, state: 'waiting', text: type ? monthNames[type] + '未生效' : '当前没有有效月卡' }];
  let session = ledger ? null : sessionClaims.get(client);
  if (!ledger && session?.day !== today) {
    session = { day: today, keys: new Set() };
    sessionClaims.set(client, session);
  }
  const result = [];
  const targets = rows.map(card => card.body.type);
  for (const target of targets) {
    const row = rows.find(card => card.body.type === target);
    if (!row) continue;
    const uniqueKey = [key, today, row.body.type ?? 0].join(':');
    const record = ledger?.keyRecords()[uniqueKey];
    if (row.state === 'completed' && claim && record && !record.confirmed && dayOf(clock(client)) === today) {
      ledger.resolveKey(uniqueKey, true);
    }
    if (row.state !== 'claimable') { result.push(row); continue; }
    if (record || session?.keys.has(uniqueKey)) {
      result.push({ ...row, state: 'pending', text: row.label + '领取记录待同步' });
      continue;
    }
    if (!claim) { result.push(row); continue; }
    const beforeSend = () => {
      const now = clock(client);
      if (!enabled() || client.connected === false || dayOf(now) !== today ||
          (row.endTime > 0 && row.endTime <= now)) throw Object.assign(Error('领取条件已变化'), { notSent: true });
    };
    let ticket;
    try {
      beforeSend();
      if (ledger) ticket = ledger.reserve({}, {}, {}, { uniqueKey });
      else session.keys.add(uniqueKey);
    } catch (error) {
      result.push({ ...row, state: error.notSent ? 'waiting' : 'error', text: error.message });
      continue;
    }
    try {
      await client.sendWatch(request, row.body, { window: 400, beforeSend });
    } catch (error) {
      if (error.notSent || (error.prompt && error.request === request)) {
        if (ledger) ledger.cancel(ticket);
        else session.keys.delete(uniqueKey);
        result.push({ ...row, state: error.notSent ? 'waiting' : 'error', text: row.label + '：' + error.message });
        continue;
      }
      // 断线也可能发生在服务器收下请求之后，继续回读核对。
    }
    try {
      rows = await readCards(client, protocol, key, timeout);
    } catch (error) {
      result.push({ ...row, state: 'pending', text: row.label + '领取待确认：' + error.message });
      break;
    }
    try {
      const confirmed = rows.some(card => card.body.type === target && card.state === 'completed');
      if (!confirmed || dayOf(clock(client)) !== today) throw Error('今日领取标记尚未确认');
      if (ledger) ledger.confirm(ticket);
      result.push({ ...row, state: 'completed', claimedNow: true, text: row.label + '今日奖励已领取' });
    } catch (error) {
      result.push({ ...row, state: 'pending', text: row.label + '领取待确认：' + error.message });
    }
  }
  return result;
}
