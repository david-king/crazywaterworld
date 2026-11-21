import { toNumber } from './client.mjs';

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
