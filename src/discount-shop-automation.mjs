import { budgetPreview } from './automation-policy.mjs';
import { buyShopProduct, createShopState, readShop, refreshDiscountShop } from './shops.mjs';

function matchesRule(product, rules) {
  return rules.some(rule => rule.id === product.asset.id && (
    (rule.maxPercent !== null && product.discount <= rule.maxPercent) ||
    (rule.maxDiamonds !== null && product.price.num <= rule.maxDiamonds)));
}

function fallbackProduct(view, settings, usage) {
  if (!settings.discountShop.fallbackCheapest || !view.gameRefresh?.lastFreeShelf ||
      usage?.counters?.[view.discountSatisfiedCounter] || view.products.some(item => matchesRule(item, settings.discountShop.rules))) return null;
  let cheapest = null;
  for (const item of view.products) {
    if (item.canBuy && (!cheapest || item.price.num < cheapest.price.num)) cheapest = item;
  }
  return cheapest;
}

export function planDiscountShop(view, settings, usage) {
  const skip = reason => ({ actions: [], notes: [reason] });
  if (!settings.schedule.shop) return skip('折扣商店总开关已关闭');
  const { rules } = settings.discountShop;
  if (!rules.length) return skip('请先添加物品和购买条件');
  const matches = view.products.filter(product => !product.buyTimes && matchesRule(product, rules));
  const fallback = matches.length ? null : fallbackProduct(view, settings, usage);
  const costs = num => num ? [{ id: 'RUBY', num }] : [];
  if (matches.length || fallback) {
    const available = fallback ? [fallback] : matches.filter(item => item.canBuy).sort((a, b) => a.price.num - b.price.num);
    const plan = budgetPreview(available.map(item => ({
      scope: 'discountShop', kind: 'shopPurchase', request: 'DiscountShopBuyRequest', id: item.id, token: item.token, costs: costs(item.price.num),
      fallback: !!fallback,
      label: (fallback ? '兜底购买 · ' : '') + item.name + ' ×' + item.asset.num + ' · ' + item.discount / 10 + ' 折 · ' + item.price.num + ' 钻石',
    })), view.stock, settings, usage);
    for (const item of matches.filter(item => !item.canBuy)) plan.notes.push(item.name + '：' + item.blockedReason);
    return plan;
  }
  const quote = view.gameRefresh;
  if (!quote?.canRefresh) return skip(quote?.blockedReason || '无法确认刷新次数和费用');
  if (quote.price?.num !== 0) return skip('当前没有免费刷新次数');
  return budgetPreview([{ scope: 'discountShop', kind: 'shopRefresh', request: 'DiscountShopRefreshRequest', token: quote.token, costs: [],
    label: '免费刷新折扣商店 · 今日第 ' + (quote.refreshCount + 1) + ' 次' }], view.stock, settings, usage);
}

export async function runDiscountShop(client, config, { player, protocol, getSettings, enabled, guard, ledger, report }) {
  const settings = getSettings();
  if (!enabled() || !settings?.schedule.shop) return;
  if (!settings.discountShop?.rules.length) {
    report({ skipped: true, reason: '请先添加物品和购买条件' });
    return;
  }
  // Recheck even inside the client's send callback if the account settings changed during a read.
  const current = () => enabled() && settings.schedule.shop && getSettings() === settings;
  const options = { state: createShopState(), scope: 'discountShop', shop: 'discount', player, protocol, getSettings,
    ledger, guard, enabled: current };
  function rememberMatch(view) {
    const key = view.discountSatisfiedCounter;
    if (!ledger.snapshot().counters[key] && view.products.some(item => matchesRule(item, settings.discountShop.rules))) {
      ledger.confirm(ledger.reserve({ [key]: 1 }, { [key]: 1 }));
    }
  }
  const readPlan = async () => {
    const view = await readShop(client, config, options);
    if (current()) rememberMatch(view);
    return planDiscountShop(view, settings, ledger.snapshot());
  };
  let plan = await readPlan();
  const refresh = plan.actions.find(step => step.kind === 'shopRefresh');
  function record(step, result) {
    const ok = result.status === 'completed';
    report({ label: step.label, ok, status: result.status, costs: result.costs, rewards: result.rewards,
      ...(ok ? {} : { error: result.message }) });
    return ok;
  }
  if (refresh && current()) {
    if (!record(refresh, await refreshDiscountShop(client, config, { ...options, token: refresh.token, paid: false })) || !current()) return;
    plan = await readPlan();
  }
  for (const step of plan.actions.filter(action => action.kind === 'shopPurchase')) {
    if (!current()) return;
    const checkFallback = step.fallback ? view => {
      rememberMatch(view);
      return fallbackProduct(view, settings, ledger.snapshot())?.id === step.id;
    } : undefined;
    const result = await buyShopProduct(client, config, { ...options, id: step.id, token: step.token, quantity: 1, paid: true, checkFallback });
    if (!record(step, result)) return;
  }
  for (const reason of plan.notes) report({ skipped: true, reason });
}
