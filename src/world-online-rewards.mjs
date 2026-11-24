// 城战在线奖励：只读取实际档位与服务器时段，领取结果以计数变化确认。
import { exactAutomationId } from './automation-policy.mjs';
import { worldOnlineWindow, worldOpenDays } from './extra-rewards.mjs';
const active = new WeakSet();
const nowOf = client => Math.floor((Date.now() + (client.serverClockOffsetMs || 0)) / 1000);
const valid = n => Number.isSafeInteger(n) && n >= 0;
const retrySeconds = 15;
const taskKey = 'worldOnlineRewards';
export function worldOnlineRewardKey(player, state) {
  const world = exactAutomationId(player?.worldId), owner = exactAutomationId(player?.playerId);
  return world && owner && valid(state.startTime) && valid(state.stage) ? `worldOnline:${world}:${owner}:${state.startTime}:${state.stage}` : null;
}
function count(value) {
  if (valid(value)) return value;
  const text = typeof value === 'object' && value ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text); return valid(n) ? n : null;
}

export async function readWorldOnlineReward(client, config, player) {
  const state = { ready: false, claimed: null, stage: null, nextAt: null, startTime: null, endTime: null, updatedAt: null, resetTime: null, reason: '' };
  const rows = config?.tables?.WorldOnlineRwdCfg?.data;
  const level = config?.tables?.ModuleOpenCfg?.data?.find(r => r.moduleId === '世界')?.playerLevel;
  if (!Number.isInteger(level) || !(player?.level >= level)) return { ...state, reason: '尚未满足世界玩法开放等级' };
  if (!Array.isArray(rows) || !rows.length || rows.some(r => !valid(r.stage) || r.stage < 1 || !valid(r.seconds))) return { ...state, reason: '在线奖励档位配置未确认' };
  try {
    const [war, counters] = await Promise.all([
      client.request('WarDeclarationRequest', {}, 'WarDeclarationResponse'), client.request('CounterInfoRequest', {}, 'CounterInfoResponse'),
    ]);
    state.startTime = war.startTime; state.endTime = war.endTime;
    if (!valid(war.startTime) || !valid(war.endTime) || !(war.endTime > war.startTime) || !Array.isArray(counters.counters)) throw new Error('服务器时段或在线计数不完整');
    const matches = counters.counters.filter(r => r.type === 'DAILY_WORLD_ONLINE_RWD');
    if (matches.length > 1) throw new Error('在线奖励计数重复');
    const item = matches[0], claimed = item ? count(item.num) : 0, updated = item?.updateTime ?? 0;
    if (claimed == null || !valid(updated)) throw new Error('在线奖励计数无效');
    const now = nowOf(client);
    const daily = worldOnlineWindow(config, player, now);
    state.resetTime = daily.resetTime;
    // 战报可能已经切到明日，但今日奖励面板仍开放。用开服日或今日已领计数核实所属场次。
    const claimedToday = claimed > 0 && updated >= daily.startTime && updated <= now;
    if (war.startTime >= daily.resetTime && now > daily.startTime &&
        (claimedToday || (now >= daily.endTime && worldOpenDays(player, now) !== null))) {
      state.startTime = daily.startTime;
      state.endTime = daily.endTime;
    }
    if (state.startTime < daily.resetTime - 86400) return { ...state, reason: '等待服务器刷新今日城战时段' };
    if (now <= state.startTime) {
      const nextAt = Math.min(state.startTime + 1, daily.resetTime, daily.endTime > now ? daily.endTime : Infinity);
      return { ...state, nextAt, reason: '尚未到城战在线奖励开放时间' };
    }
    if (updated > now || (claimed > 0 && updated < state.startTime)) return { ...state, reason: '在线奖励计时状态尚未刷新，等待下次核对' };
    const max = Math.max(...rows.map(r => r.stage));
    if (claimed > max) throw new Error('在线奖励计数超出档位配置');
    state.claimed = claimed;
    state.updatedAt = updated;
    if (claimed === max) return { ...state, nextAt: daily.resetTime, reason: '本次城战在线奖励已全部领取' };
    if (updated >= state.endTime) return { ...state, nextAt: daily.resetTime, reason: '城战结束后已领取一档，今日在线奖励已结束' };
    const next = rows.filter(r => r.stage === claimed + 1);
    if (next.length !== 1) throw new Error('下一档在线奖励未确认');
    state.stage = next[0].stage;
    state.nextAt = Math.max(state.startTime + 1, updated + next[0].seconds);
    state.ready = now >= state.nextAt;
    state.reason = state.ready ? '' : `第 ${state.stage} 档在线奖励还需等待 ${state.nextAt - now} 秒`;
    return state;
  } catch (error) { return { ...state, ready: false, reason: '在线奖励状态未确认：' + error.message }; }
}

export async function claimWorldOnlineReward(client, config, player, { ledger, enabled = () => true, scheduler } = {}) {
  const title = '城战在线奖励';
  if (!enabled() || active.has(client)) return { title, skipped: true, reason: '领取已暂停或正在检查' };
  if (!ledger?.reserve || !ledger?.keyRecords) throw new Error('缺少在线奖励确认记录，未发送领取');
  active.add(client);
  try {
    const world = exactAutomationId(player?.worldId), owner = exactAutomationId(player?.playerId);
    const sameRole = () => exactAutomationId(player?.worldId) === world && exactAutomationId(player?.playerId) === owner;
    if (!world || !owner) return { title, skipped: true, reason: '角色或区服身份未确认' };
    const state = await readWorldOnlineReward(client, config, player);
    if (!sameRole()) return { title, skipped: true, reason: '角色已切换，下次重新核对' };
    const prefix = `worldOnline:${world}:${owner}:${state.startTime}:`;
    if (valid(state.claimed)) for (const [key, record] of Object.entries(ledger.keyRecords())) {
      if (key.startsWith(prefix) && !record.confirmed && valid(record.details?.stage) && record.details.stage <= state.claimed) ledger.resolveKey(key, true);
    }
    if (!state.ready) {
      scheduler?.defer(taskKey, state.nextAt);
      return { title, skipped: true, reason: state.reason };
    }
    const key = worldOnlineRewardKey(player, state);
    const record = ledger.keyRecords()[key];
    if (record?.confirmed) return { title, skipped: true, reason: '本档已确认领取，等待服务器计数刷新' };
    if (record) {
      // 旧版记录只有本机毫秒时间戳。换算为服务器秒后同样可以恢复。
      const retryAt = record.details?.retryAt ??
        Math.ceil((ledger.reservationTime(key) + (client.serverClockOffsetMs || 0)) / 1000) + retrySeconds;
      if (retryAt > nowOf(client)) {
        scheduler?.defer(taskKey, retryAt);
        return { title, pending: true, skipped: true, reason: '本档领取结果待确认，到时重新核对服务器计数' };
      }
    }
    const fresh = await readWorldOnlineReward(client, config, player);
    if (sameRole() && fresh.startTime === state.startTime && fresh.claimed >= state.stage) {
      if (record) ledger.resolveKey(key, true);
      scheduler?.defer(taskKey, fresh.ready ? nowOf(client) + 1 : fresh.nextAt);
      return { title, skipped: true, reason: `服务器已确认第 ${state.stage} 档已领取` };
    }
    if (!enabled() || !client.connected || !sameRole() || !fresh.ready || fresh.stage !== state.stage ||
        fresh.startTime !== state.startTime || fresh.endTime !== state.endTime || fresh.updatedAt !== state.updatedAt) {
      return { title, skipped: true, reason: '领取前状态已变化，下次重新核对' };
    }
    // 两次独立回读均指向同一可领档后才替换旧票。每次发送使用不同票号，迟到的结果不能撤销新票。
    if (record) ledger.cancel({ id: record.id });
    const attempts = (record?.details?.attempts ?? (record ? 1 : 0)) + 1;
    const retryAt = nowOf(client) + Math.min(300, retrySeconds * 2 ** (attempts - 1));
    const details = { kind: 'worldOnlineReward', stage: fresh.stage, startTime: fresh.startTime, attempts, retryAt };
    let ticket;
    try {
      ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details });
    } catch (error) {
      if (ledger.keyRecords()[key]) return { title, skipped: true, reason: '本档已由另一轮处理，等待计数确认' };
      throw error;
    }
    const beforeSend = () => {
      const now = nowOf(client), current = ledger.keyRecords()[key];
      if (!enabled() || !client.connected || !sameRole() || now < fresh.nextAt || now >= Math.min(retryAt, fresh.resetTime) ||
          current?.id !== ticket.id || current.confirmed) throw new Error('领取前状态已变化，下次重新核对');
    };
    try {
      await client.sendWatch('GotWorldOnlineRwdRequest', {}, { window: 600, beforeSend });
      const after = await readWorldOnlineReward(client, config, player);
      if (sameRole() && after.startTime === fresh.startTime && after.claimed >= fresh.stage) {
        ledger.confirm(ticket);
        scheduler?.defer(taskKey, after.ready ? nowOf(client) + 1 : after.nextAt);
        return { title: `城战在线奖励第 ${fresh.stage} 档已领取`, ok: true };
      }
    } catch (error) {
      if (error.notSent || (error.prompt && error.request === 'GotWorldOnlineRwdRequest')) {
        ledger.cancel(ticket);
        return { title, ok: false, error: error.message };
      }
      scheduler?.defer(taskKey, retryAt);
      return { title, ok: false, pending: true, error: error.message };
    }
    scheduler?.defer(taskKey, retryAt);
    return { title, ok: false, pending: true, error: '领取结果待确认，将重新核对本档计数' };
  } finally { active.delete(client); }
}
