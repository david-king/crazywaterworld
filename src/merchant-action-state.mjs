import { natural, positive } from './activity-actions.mjs';

export const merchantFingerprint = state => ({ coins: state.player?.coins, profit: state.player?.profit,
  goods: state.player?.goods, cargo: state.cargo });
export const quantity = (state, id, city, price) => state.goods
  .filter(g => g.goodsId === id && g.cityId === city && (price == null || g.buyPrice === price))
  .reduce((sum, g) => sum + g.num, 0);

function validState(state) {
  return positive(state?.cargo?.cityId) && positive(state.cargo.cargoLv) && natural(state.cargo.moveEndTime) &&
    natural(state.cargo.moveToCityId ?? 0) && natural(state.cargo.moveStartTime ?? 0) &&
    natural(state.coins) && natural(state.profit) && Array.isArray(state.goods) &&
    state.goods.every(g => g && natural(g.pid) && positive(g.goodsId) && positive(g.cityId) && positive(g.buyPrice) && positive(g.num)) &&
    new Set(state.goods.map(g => g.pid)).size === state.goods.length;
}
const batchSignature = goods => JSON.stringify(goods.map(g => [g.pid, g.goodsId, g.cityId, g.buyPrice, g.num]).sort((a, b) => a[0] - b[0]));
const docked = (cargo, time) => cargo.moveEndTime <= time && (!cargo.moveToCityId || cargo.moveToCityId === cargo.cityId);
const voyageSynced = (cargo, time) => docked(cargo, time) ||
  positive(cargo.moveToCityId) && cargo.moveToCityId !== cargo.cityId && positive(cargo.moveStartTime) && cargo.moveEndTime >= cargo.moveStartTime;

// 自然到港只说明航程结束，不能证明指针使它提前。
export function merchantSpeedMatches(expected, snapshot, time) {
  const cargo = snapshot?.cargo;
  if (expected?.request !== 'TradeSpeedRequest' || !cargo || !positive(expected.beforeEndTime)
    || !natural(expected.afterEndTime) || expected.afterEndTime >= expected.beforeEndTime
    || !positive(expected.moveStartTime) || cargo.moveStartTime !== expected.moveStartTime) return false;
  if (cargo.cityId === expected.destination && time < expected.beforeEndTime
    && (!cargo.moveToCityId || cargo.moveToCityId === expected.destination)) return true;
  return cargo.cityId === expected.city && cargo.moveToCityId === expected.destination
    && positive(cargo.moveEndTime) && cargo.moveEndTime < expected.beforeEndTime && cargo.moveEndTime <= expected.afterEndTime;
}

export function merchantSpeedVoyageEnded(expected, state, time) {
  if (!validState(state) || !voyageSynced(state.cargo, time) || !positive(expected.moveStartTime)) return false;
  const cargo = state.cargo;
  return cargo.moveStartTime > expected.moveStartTime ||
    (docked(cargo, time) && cargo.cityId !== expected.city);
}

export function merchantActionMatches(expected, state, time, before) {
  if (!expected || !validState(state)) return false;
  if (expected.request === 'TradeSpeedRequest') return merchantSpeedMatches(expected, state, time);
  if (expected.request === 'TradeBuyRequest') {
    if (state.coins !== expected.coins || quantity(state, expected.goodsId, expected.city, expected.price) !== expected.owned) return false;
    const otherGoods = goods => goods.filter(g => g.goodsId !== expected.goodsId || g.cityId !== expected.city || g.buyPrice !== expected.price);
    return !before || validState(before) && before.profit === state.profit && batchSignature(otherGoods(before.goods)) === batchSignature(otherGoods(state.goods));
  }
  if (expected.request === 'TradeSellRequest') {
    if (state.goods.some(g => g.pid === expected.pid)) return false;
    if (before && (!validState(before) || batchSignature(before.goods.filter(g => g.pid !== expected.pid)) !== batchSignature(state.goods))) return false;
    if (expected.gain == null) return state.coins > expected.coins && state.profit > expected.profit;
    return state.coins === expected.coins + expected.proceeds && state.profit === expected.profit + Math.max(0, expected.gain);
  }
  return expected.request === 'TradeMoveRequest' && (state.cargo.cityId === expected.destination && docked(state.cargo, time) ||
    state.cargo.cityId === expected.city && state.cargo.moveToCityId === expected.destination && state.cargo.moveEndTime >= expected.start);
}

// 只有活动内完整的角色状态才能取代旧操作。报价刷新、货物排序和等待时长都不是手动操作的证据。
export function merchantActionState({ expected, before }, state, time) {
  if (!expected || !validState(state) || !voyageSynced(state.cargo, time)) return 'pending';
  if (merchantActionMatches(expected, state, time, before)) return 'confirmed';
  if (expected.request === 'TradeSpeedRequest') return merchantSpeedVoyageEnded(expected, state, time) ? 'superseded' : 'pending';
  if (!['TradeBuyRequest', 'TradeSellRequest', 'TradeMoveRequest'].includes(expected.request)) return 'pending';
  if (before) {
    if (!validState(before)) return 'pending';
    const cargo = state.cargo, prior = before.cargo;
    if (cargo.cityId !== prior.cityId || cargo.cargoLv !== prior.cargoLv || cargo.moveStartTime > (prior.moveStartTime ?? 0) ||
      (!docked(cargo, time) && cargo.moveToCityId !== prior.moveToCityId)) return 'superseded';
    const unchangedGoods = batchSignature(state.goods) === batchSignature(before.goods);
    if (unchangedGoods && state.coins === before.coins && state.profit === before.profit) return 'pending';
    // 余额和货舱可能分开同步。仅出现原动作的一部分预期变化时仍保护这笔请求。
    if (expected.request === 'TradeBuyRequest' || expected.request === 'TradeSellRequest') {
      const buy = expected.request === 'TradeBuyRequest';
      const coins = buy ? expected.coins : expected.coins + expected.proceeds;
      const profit = buy ? before.profit : expected.profit + Math.max(0, expected.gain);
      if ((state.coins === before.coins || state.coins === coins) && (state.profit === before.profit || state.profit === profit) &&
        (unchangedGoods || merchantActionMatches(expected, { ...state, coins, profit }, time, before))) return 'pending';
    }
    return 'superseded';
  }
  // 旧账本没有发送前快照。采购仍可由预期余款和同价持仓还原发送前的总值。
  if (positive(expected.city) && (expected.city !== state.cargo.cityId || !docked(state.cargo, time))) return 'superseded';
  if (expected.request === 'TradeBuyRequest' && positive(expected.price) && positive(expected.owned) && natural(expected.coins)) {
    const missing = expected.owned - quantity(state, expected.goodsId, expected.city, expected.price);
    if (missing <= 0 || state.coins !== expected.coins + missing * expected.price) return 'superseded';
  }
  if (expected.request === 'TradeSellRequest' && (!state.goods.some(g => g.pid === expected.pid) || state.coins !== expected.coins || state.profit !== expected.profit))
    return 'superseded';
  if (expected.request === 'TradeMoveRequest' && positive(expected.start) && state.cargo.moveStartTime >= expected.start) return 'superseded';
  return 'pending';
}
