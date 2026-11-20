import { toNumber } from './client.mjs';

export function goodsRubyPrice(config, itemId) {
  const price = config?.tables?.ItemPriceCfg?.data?.find(row => row.itemId === itemId)?.rubyPrice;
  return Number.isSafeInteger(price) && price > 0 ? price : null;
}

export async function readDiamondBalance(client) {
  const resources = await client.request('AllResourceRequest', {}, 'AllResourceResponse');
  if (!Array.isArray(resources?.list)) throw Error('完整资源尚未确认');
  const amounts = new Map();
  for (const row of resources.list) {
    const count = row?.amount == null ? NaN : toNumber(row.amount);
    if (!Number.isSafeInteger(row?.res) || amounts.has(row.res) || !Number.isSafeInteger(count) || count < 0) {
      throw Error('完整资源尚未确认');
    }
    amounts.set(row.res, count);
  }
  if (!amounts.has(4)) throw Error('钻石余额尚未确认');
  return amounts.get(4);
}

export async function readGoodsPurchaseBalances(client, check) {
  check();
  const bag = await client.request('AllItemRequest', {}, 'AllItemResponse');
  check();
  if (!Array.isArray(bag?.items)) throw Error('购买后完整库存尚未确认');
  const items = new Map();
  for (const row of bag.items) {
    const count = row?.num == null ? NaN : toNumber(row.num);
    if (typeof row?.itemId !== 'string' || !row.itemId || items.has(row.itemId) || !Number.isSafeInteger(count) || count < 0) {
      throw Error('购买后完整库存尚未确认');
    }
    items.set(row.itemId, count);
  }
  await readDiamondBalance(client);
  check();
  return items;
}
