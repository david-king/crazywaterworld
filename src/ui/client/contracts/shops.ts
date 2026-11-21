import { isRecord } from "./login-settings";

export const SHOP_CHOICES = [
  { id: "discount", title: "折扣商店" },
  { id: "ad", title: "广告商店" },
  { id: "arena", title: "竞技场商店" },
  { id: "guild", title: "联盟商店" },
  { id: "shuimu", title: "水姆商店" },
  { id: "league", title: "积分赛商店" },
  { id: "vip", title: "VIP商店" },
] as const;

export type ShopId = (typeof SHOP_CHOICES)[number]["id"];

export interface ShopSummary {
  id: ShopId;
  title: string;
  type: number | null;
  kind: string;
}

export interface ShopAmount {
  id: string;
  name: string;
  num: number;
  icon: string;
}

export interface ShopProduct {
  id: number;
  name: string;
  asset: ShopAmount;
  price: ShopAmount;
  discount: number;
  buyTimes: number;
  limitBuyTimes: number;
  remaining: number | null;
  maxQuantity: number;
  canBuy: boolean;
  blockedReason: string;
  vipLevel: number;
  dan: number;
  token: string;
}

export interface ShopGameRefresh {
  refreshCount: number;
  limit: number;
  remaining: number;
  price: ShopAmount;
  canRefresh: boolean;
  blockedReason: string;
  token: string;
}

export interface ShopView {
  catalog: ShopSummary[];
  shop: ShopSummary;
  products: ShopProduct[];
  balances: ShopAmount[];
  updatedAt: number;
  nextRefreshTime: number;
  hint: string;
  gameRefresh: ShopGameRefresh | null;
}

export interface ShopPurchaseRequest {
  shop: ShopId;
  id: number;
  quantity: number;
  token: string;
  confirm: true;
  paid: boolean;
}

export interface ShopPurchaseResult {
  status: "completed" | "unknown" | "rejected" | "cancelled";
  message: string;
  shopId: ShopId;
  productId: number;
  quantity: number;
  rewards: ShopAmount[];
  costs: ShopAmount[];
}

export interface ShopGameRefreshRequest {
  shop: "discount";
  token: string;
  confirm: true;
  paid: boolean;
}

export interface ShopGameRefreshResult {
  action: "game-refresh";
  status: "completed" | "unknown" | "rejected" | "cancelled";
  message: string;
  shopId: "discount";
  costs: ShopAmount[];
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function shopId(value: unknown): value is ShopId {
  return SHOP_CHOICES.some((shop) => shop.id === value);
}

function summary(value: unknown): ShopSummary {
  if (
    !isRecord(value) ||
    !shopId(value.id) ||
    typeof value.title !== "string" ||
    !value.title ||
    (value.type !== null && !count(value.type)) ||
    typeof value.kind !== "string"
  )
    throw new Error("商店分类格式无效");
  return {
    id: value.id,
    title: value.title,
    type: value.type,
    kind: value.kind,
  };
}

function amount(value: unknown): ShopAmount {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !count(value.num) ||
    (value.icon !== undefined && typeof value.icon !== "string")
  )
    throw new Error("商店资源或价格格式无效");
  return {
    id: value.id,
    name: value.name,
    num: value.num,
    icon:
      typeof value.icon === "string" && value.icon.startsWith("/api/art/icon/")
        ? value.icon
        : "",
  };
}

function product(value: unknown): ShopProduct {
  if (
    !isRecord(value) ||
    !count(value.id) ||
    typeof value.name !== "string" ||
    typeof value.discount !== "number" ||
    !Number.isFinite(value.discount) ||
    value.discount < 0 ||
    !count(value.buyTimes) ||
    !count(value.limitBuyTimes) ||
    (value.remaining !== null && !count(value.remaining)) ||
    !count(value.maxQuantity) ||
    typeof value.canBuy !== "boolean" ||
    typeof value.blockedReason !== "string" ||
    !count(value.vipLevel) ||
    !count(value.dan) ||
    typeof value.token !== "string" ||
    (value.canBuy && (!value.token || value.maxQuantity < 1))
  )
    throw new Error("商店商品或购买条件格式无效");
  return {
    id: value.id,
    name: value.name,
    asset: amount(value.asset),
    price: amount(value.price),
    discount: value.discount,
    buyTimes: value.buyTimes,
    limitBuyTimes: value.limitBuyTimes,
    remaining: value.remaining,
    maxQuantity: value.maxQuantity,
    canBuy: value.canBuy,
    blockedReason: value.blockedReason,
    vipLevel: value.vipLevel,
    dan: value.dan,
    token: value.token,
  };
}

function gameRefresh(value: unknown, shop: ShopId): ShopGameRefresh | null {
  if (value === undefined || value === null) return null;
  if (
    shop !== "discount" ||
    !isRecord(value) ||
    !count(value.refreshCount) ||
    !count(value.limit) ||
    !count(value.remaining) ||
    typeof value.canRefresh !== "boolean" ||
    typeof value.blockedReason !== "string" ||
    typeof value.token !== "string" ||
    (value.canRefresh && (!value.token || value.remaining < 1))
  )
    throw new Error("刷新折扣商店的费用或次数格式无效，请重试读取");
  return {
    refreshCount: value.refreshCount,
    limit: value.limit,
    remaining: value.remaining,
    price: amount(value.price),
    canRefresh: value.canRefresh,
    blockedReason: value.blockedReason,
    token: value.token,
  };
}

export function parseShops(value: unknown, expectedShop: ShopId): ShopView {
  if (
    !isRecord(value) ||
    !Array.isArray(value.catalog) ||
    !Array.isArray(value.products) ||
    !Array.isArray(value.balances) ||
    !count(value.updatedAt) ||
    !count(value.nextRefreshTime) ||
    typeof value.hint !== "string"
  )
    throw new Error("商店列表格式无效");
  const catalog = value.catalog.map(summary);
  const shop = summary(value.shop);
  const products = value.products.map(product);
  if (
    shop.id !== expectedShop ||
    catalog.length !== SHOP_CHOICES.length ||
    new Set(catalog.map((entry) => entry.id)).size !== catalog.length ||
    new Set(products.map((entry) => entry.id)).size !== products.length ||
    (shop.id === "ad" &&
      products.some((entry) => entry.price.num !== 0 || entry.maxQuantity > 1))
  )
    throw new Error("商店数据与当前分类不一致，请重新读取");
  return {
    catalog,
    shop,
    products,
    balances: value.balances.map(amount),
    updatedAt: value.updatedAt,
    nextRefreshTime: value.nextRefreshTime,
    hint: value.hint,
    gameRefresh: gameRefresh(value.gameRefresh, shop.id),
  };
}

export function parseShopPurchase(
  value: unknown,
  expected: Pick<ShopPurchaseRequest, "shop" | "id" | "quantity">,
): ShopPurchaseResult {
  if (
    !isRecord(value) ||
    (value.status !== "completed" &&
      value.status !== "unknown" &&
      value.status !== "rejected" &&
      value.status !== "cancelled") ||
    typeof value.message !== "string" ||
    value.shopId !== expected.shop ||
    value.productId !== expected.id ||
    value.quantity !== expected.quantity ||
    !Array.isArray(value.rewards) ||
    !Array.isArray(value.costs)
  )
    throw new Error("购买回执无法确认，请核对商品与余额，勿重复购买");
  return {
    status: value.status,
    message: value.message,
    shopId: expected.shop,
    productId: expected.id,
    quantity: expected.quantity,
    rewards: value.rewards.map(amount),
    costs: value.costs.map(amount),
  };
}

export function parseShopGameRefresh(value: unknown): ShopGameRefreshResult {
  if (
    !isRecord(value) ||
    value.action !== "game-refresh" ||
    (value.status !== "completed" &&
      value.status !== "unknown" &&
      value.status !== "rejected" &&
      value.status !== "cancelled") ||
    typeof value.message !== "string" ||
    value.shopId !== "discount" ||
    !Array.isArray(value.costs)
  )
    throw new Error(
      "刷新折扣商店的回执无法确认，请核对商品、刷新次数与余额，勿重复刷新",
    );
  return {
    action: "game-refresh",
    status: value.status,
    message: value.message,
    shopId: "discount",
    costs: value.costs.map(amount),
  };
}
