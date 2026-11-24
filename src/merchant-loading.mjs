// 在库存、本金、交易轮数约束下恰好装满。先尽量多装排名靠前的货，再用后面的货补齐。
export function fullMerchantLoad(offers, capacity, cash, maxTypes, specialtyId, needsSpecialty) {
  const empty = { purchases: [], profit: 0, cost: 0, capacity: 0, approximate: false };
  if (!capacity || !cash || maxTypes < 1) return empty;
  const items = offers.filter(o => o.price < o.basePrice && o.capacity <= capacity && o.price <= cash)
    .sort((a, b) => Number(b.goodsId === specialtyId) - Number(a.goodsId === specialtyId) ||
      a.price / a.basePrice - b.price / b.basePrice || b.unitProfit / b.capacity - a.unitProfit / a.capacity ||
      b.quality - a.quality || a.goodsId - b.goodsId);
  if (needsSpecialty && items[0]?.goodsId !== specialtyId) return empty;
  const purchases = fillRankedMerchantLoad(items, capacity, cash, maxTypes, needsSpecialty)
    .map(item => ({ ...item, gain: Math.ceil(item.profitBasis * item.count / 10000) }));
  if (!purchases.length) return empty;
  return { purchases, profit: purchases.reduce((s, p) => s + p.gain, 0),
    cost: purchases.reduce((s, p) => s + p.price * p.count, 0), capacity, approximate: false };
}

// 调用方决定货物的优先顺序。装舱只使用可购数量、舱位、资金和采购轮数。
export function fillRankedMerchantLoad(items, capacity, cash, maxTypes, needsFirst = false) {
  if (!capacity || !cash || maxTypes < 1 || !items.length ||
    items.reduce((sum, o) => sum + o.capacity * o.count, 0) < capacity ||
    items.every(o => o.price * capacity > cash * o.capacity)) return [];
  const counts = new Array(items.length).fill(0);
  const result = () => items.flatMap((item, i) => counts[i] ? [{ ...item, count: counts[i] }] : []);
  let space = capacity, coins = cash, types = maxTypes;
  for (let i = 0; i < items.length && types && space; i++) {
    const o = items[i], n = Math.min(o.count, Math.floor(space / o.capacity), Math.floor(coins / o.price));
    if (n) { counts[i] = n; space -= n * o.capacity; coins -= n * o.price; types--; }
  }
  if (!space) return result();
  // 后缀恰好填满每个格数的最低成本。按占舱余数使用有界滑动最小值，每货种只扫描一次容量。
  const costs = new Array(items.length + 1);
  costs[items.length] = new Float64Array(capacity + 1).fill(Infinity);
  costs[items.length][0] = 0;
  const queue = new Int32Array(capacity + 1);
  for (let i = items.length - 1; i >= 0; i--) {
    const o = items[i], next = costs[i + 1], row = new Float64Array(capacity + 1);
    for (let r = 0; r < o.capacity; r++) {
      let head = 0, tail = 0;
      const adjusted = j => next[r + j * o.capacity] - j * o.price;
      for (let j = 0, s = r; s <= capacity; j++, s += o.capacity) {
        if (head < tail && queue[head] < j - o.count) head++;
        while (head < tail && adjusted(queue[tail - 1]) >= adjusted(j)) tail--;
        queue[tail++] = j;
        row[s] = adjusted(queue[head]) + j * o.price;
      }
    }
    costs[i] = row;
  }
  counts.fill(0);
  const failed = new Map();
  const fill = (i, space, coins, types) => {
    if (!space) return true;
    if (!types || i === items.length || costs[i][space] > coins) return false;
    if (types === 1) {
      const end = i === 0 && needsFirst ? 1 : items.length;
      for (let j = i; j < end; j++) {
        const o = items[j], n = space / o.capacity;
        if (Number.isInteger(n) && n <= o.count && n * o.price <= coins) { counts[j] = n; return true; }
      }
      return false;
    }
    const key = i + ':' + space + ':' + types;
    if ((failed.get(key) ?? -1) >= coins) return false;
    const o = items[i], minimum = i === 0 && needsFirst ? 1 : 0;
    const max = Math.min(o.count, Math.floor(space / o.capacity), Math.floor(coins / o.price));
    for (let n = max; n >= minimum; n--) {
      const rest = space - n * o.capacity, balance = coins - n * o.price;
      if (costs[i + 1][rest] <= balance && fill(i + 1, rest, balance, types - Number(n > 0))) {
        counts[i] = n;
        return true;
      }
    }
    failed.set(key, coins);
    return false;
  };
  return fill(0, capacity, cash, maxTypes) ? result() : [];
}
