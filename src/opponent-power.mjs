import { toNumber } from './client.mjs';
import { uidText } from './hero-equipment.mjs';

// 未下发的 protobuf 数值也会从原型读到 0；仅展示实际返回的角色战力。
export function playerPowerText(row, key = 'power') {
  if (!row || !Object.hasOwn(row, key)) return undefined;
  const value = row[key];
  if (value === 0 || value === '0' || value?.low === 0 && value.high === 0) return '0';
  return uidText(value) ?? undefined;
}

export function filterOpponentsByPower(candidates, ownPower, maxPowerRatio = 0) {
  if (maxPowerRatio === 0) return { candidates, note: '' };
  const power = toNumber(ownPower);
  if (!Number.isSafeInteger(power) || power <= 0) {
    return { reason: '尚未取得有效的己方战力，无法核对对手战力上限' };
  }
  const limit = BigInt(power) * BigInt(maxPowerRatio) / 100n;
  const known = candidates.filter(row => {
    const power = toNumber(row.power);
    return Number.isSafeInteger(power) && power > 0;
  });
  const eligible = known.filter(row => BigInt(toNumber(row.power)) <= limit);
  const note = `己方 ${power} × ${maxPowerRatio}%，上限 ${limit}`;
  if (!eligible.length) return { candidates: [], overLimit: known, reason: `没有符合战力上限的对手（${note}）` };
  return { candidates: eligible, note: ' · ' + note };
}
