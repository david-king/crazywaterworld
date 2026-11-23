// 自动洗炼：循环「洗炼 → 判定 → 保存/放弃」，直到满足条件、次数用完、材料不足或手动停止。
// 判定是「无序计数」：每条需求只要求满足条数，落在哪个词条位不算数，多余词条随意；
// 评级按「≥ 门槛」判定（设 C 时出 A/S 也算满足）。
import { REROLL_MATERIALS } from './items.mjs';

const REROLL_STONE = { ORANGE: '装备洗炼石', RED: '红装备洗炼石' };
const MAX_ROLLS = 500;
const runs = new Map(); // accountId -> run

export function normalizeRequirements(input, slots) {
  if (!Array.isArray(input) || !input.length) throw Error('至少设置一条词条需求');
  const requirements = input.map(raw => {
    const attr = String(raw?.attr ?? '').trim();
    if (!attr) throw Error('需求里缺少属性名');
    const count = Number(raw?.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 4) throw Error('需求条数只能是 1~4');
    const minRating = Number(raw?.minRating ?? 1);
    if (!Number.isInteger(minRating) || minRating < 1 || minRating > 4) throw Error('最低评级只能是 C/B/A/S');
    return { attr, count, minRating, letter: ['', 'C', 'B', 'A', 'S'][minRating] };
  });
  const total = requirements.reduce((sum, item) => sum + item.count, 0);
  if (Number.isInteger(slots) && slots > 0 && total > slots) {
    throw Error(`这件装备只有 ${slots} 条词条位，需求却要 ${total} 条`);
  }
  return requirements;
}

export function evaluateRoll(attrs, requirements) {
  const list = Array.isArray(attrs) ? attrs : [];
  const hit = requirements.map(req => list.filter(attr =>
    (req.attr === '*' || attr.name === req.attr) && Number(attr.rating ?? 0) >= req.minRating).length);
  return { satisfied: hit.every((count, index) => count >= requirements[index].count), hit };
}

export const describeRequirements = requirements =>
  requirements.map(req => `${req.attr === '*' ? '任意' : req.attr}≥${req.letter}×${req.count}`).join('，');

const attrsText = attrs => (attrs?.length
  ? attrs.map(attr => `${attr.name} ${attr.display}${attr.letter ? ' ' + attr.letter : ''}`).join(' · ')
  : '（无）');

export function autoRerollStatus(accountId) {
  const run = runs.get(accountId);
  if (!run) return { running: false, roll: 0, maxRolls: 0, requirements: [], log: [], stopReason: '', saved: false };
  return {
    running: run.running, uid: run.uid, name: run.name, roll: run.roll, maxRolls: run.maxRolls,
    requirements: run.requirements, lockedSlots: run.lockedSlots, materialFloor: run.materialFloor,
    startedAt: run.startedAt, stopReason: run.stopReason, saved: run.saved, log: run.log.slice(-40),
  };
}

export function stopAutoReroll(accountId, reason = '已手动停止') {
  const run = runs.get(accountId);
  if (!run?.running) return false;
  run.stopped = true;
  run.stopReason = reason;
  return true;
}

/**
 * 启动自动洗炼。只在满足条件时保存；次数用完、材料不足、异常都放弃当前这轮，不保存。
 * run/current 由调用方注入：写操作走账号写队列，current() 保证账号仍在当前连接上。
 */
export function startAutoReroll(accountId, items, {
  uid, name = '', quality = '', requirements, maxRolls, materialFloor = 0, lockedSlots = [], run, current,
}) {
  if (runs.get(accountId)?.running) throw Error('这个账号已经有自动洗炼在跑了');
  const limit = Number(maxRolls);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROLLS) throw Error(`次数上限只能是 1~${MAX_ROLLS}`);
  const floor = Number.isInteger(materialFloor) ? Math.max(0, materialFloor) : 0;
  const stone = REROLL_STONE[quality] ?? '装备洗炼石';
  const record = {
    running: true, stopped: false, uid: String(uid), name, roll: 0, maxRolls: limit,
    requirements, lockedSlots, materialFloor: floor, startedAt: Date.now(),
    log: [], stopReason: '', saved: false,
  };
  runs.set(accountId, record);
  const write = (level, message) => {
    record.log.push({ at: Date.now(), level, message });
    if (record.log.length > 200) record.log.splice(0, record.log.length - 200);
  };
  write('info', `开始自动洗炼「${name}」：${describeRequirements(requirements)}，最多 ${limit} 次，每轮消耗 10 ${stone}`);

  void (async () => {
    try {
      for (let index = 1; index <= limit; index += 1) {
        if (record.stopped) { record.stopReason = record.stopReason || '已手动停止'; break; }
        const counts = await items.materials(current);
        if ((counts[stone] ?? 0) <= floor) {
          record.stopReason = `${stone} 不足（剩 ${counts[stone] ?? 0}，下限 ${floor}）`;
          write('warn', record.stopReason);
          break;
        }
        record.roll = index;
        const rolled = await items.reroll({ uid: record.uid, lockedSlots: record.lockedSlots }, run, current);
        const verdict = evaluateRoll(rolled.equip.pending, requirements);
        write('info', `第 ${index} 次：${attrsText(rolled.equip.pending)} → ${verdict.satisfied ? '满足条件' : '不满足'}`);
        if (verdict.satisfied) {
          const saved = await items.decide({ uid: record.uid, save: true }, run, current);
          record.saved = true;
          record.stopReason = `已满足条件并保存：${attrsText(saved.equip.attrs)}`;
          write('info', record.stopReason);
          break;
        }
        await items.decide({ uid: record.uid, save: false }, run, current);
        if (index === limit) {
          record.stopReason = `洗满 ${limit} 次仍未满足条件，属性保持原样`;
          write('warn', record.stopReason);
        }
      }
    } catch (error) {
      record.stopReason = '自动洗炼中断：' + (error?.message ?? String(error));
      record.log.push({ at: Date.now(), level: 'error', message: record.stopReason });
    } finally {
      record.running = false;
    }
  })();

  return autoRerollStatus(accountId);
}

export { REROLL_MATERIALS, REROLL_STONE };
