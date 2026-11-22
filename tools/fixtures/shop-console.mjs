// 商店 HTTP/UI 共用的独立离线服务端模型；不导入 shops.mjs 或业务单测夹具。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeclaredProtocol } from "./declared-protocol.mjs";

export const SHOP_FIXTURE_CATALOG = Object.freeze([
  { id: "discount", title: "折扣商店", type: null },
  { id: "ad", title: "广告商店", type: null },
  { id: "arena", title: "竞技场商店", type: 1 },
  { id: "guild", title: "联盟商店", type: 2 },
  { id: "shuimu", title: "水姆商店", type: 13 },
  { id: "league", title: "积分赛商店", type: 4 },
  { id: "vip", title: "VIP商店", type: 3 },
]);
export const BLUEPRINT = "建筑蓝图";
export const VIP_PRODUCT = 3101;
export const ARENA_PRODUCT = 1101;
const RESOURCE_IDS = {
  EXP: 1,
  GOLD: 3,
  RUBY: 4,
  ARENA_POINT: 5,
  LEAGUE_POINT: 6,
};
const clone = (value) => structuredClone(value);
const asset = (id, num) => ({ type: id in RESOURCE_IDS ? 1 : 0, id, num });

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function shopConfigPack() {
  const tables = {
    ResourceCfg: [
      ["EXP", "经验"],
      ["GOLD", "金币"],
      ["RUBY", "钻石"],
      ["ARENA_POINT", "竞技场挑战券"],
      ["LEAGUE_POINT", "积分赛挑战券"],
    ].map(([id, show_name]) => ({ id, show_name })),
    ItemCfg: [BLUEPRINT, "竞技币", "公会科技点", "水姆币", "积分赛货币"].map(
      (id) => ({ id, show_name: id }),
    ),
    VipLevelCfg: [{ level: 3, effects: [["免广告", 1]] }],
    ShopRefreshCfg: [
      { times: 1, cost: [] },
      { times: 2, cost: [] },
      { times: 3, cost: ["RUBY", 50] },
    ],
    MonthCardCfg: [
      { id: "普通月卡", effectList: [] },
      { id: "高级月卡", effectList: [] },
    ],
    AdvChannelCfg: [{ key: "1400", isOpen: true, minAppVersion: "" }],
    ModuleOpenCfg: [
      { moduleId: "广告", playerLevel: 9 },
      { moduleId: "联盟", playerLevel: 16 },
      { moduleId: "跨服积分赛", playerLevel: 25 },
    ],
    BuildingUnlockCfg: [
      { buildingId: "1商店", buildingType: "商店", playerLevel: 13 },
      { buildingId: "1竞技场", buildingType: "竞技场", playerLevel: 13 },
    ],
    GameplayOpenCfg: ["水姆商店", "跨服积分赛"].map((gameplay) => ({
      gameplay,
      openDays: [8, 1, 1, 1],
    })),
    CargoUnlockCfg: [{ index: 1, playerLevel: 10 }],
    ArenaShopItemCfg: [{ shopId: 1101, sortId: 1 }],
    GuildShopItemCfg: [{ shopId: 2101, sortId: 1 }],
    GuildShipShopItemCfg: [{ shopId: 13101, sortId: 1 }],
    LeagueShopItemCfg: [{ shopId: 4101, sortId: 1 }],
    VipShopItemCfg: [
      { shopId: 3101, discount: 0.5, sortId: 1 },
      { shopId: 3102, discount: 1, sortId: 2 },
    ],
  };
  return Object.entries(tables).map(([name, data], index) => [
    index + 1,
    name,
    { data },
  ]);
}

export function createShopClient(
  account = "a",
  {
    refreshCount = 0,
    refreshLimit = 3,
    refreshTiers = [
      { times: 1, cost: [] },
      { times: 2, cost: [] },
      { times: 3, cost: ["RUBY", 50] },
    ],
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const product = (id, currency, price, amount, limit, extra = {}) => ({
    id,
    asset: asset(BLUEPRINT, amount),
    price: asset(currency, price),
    discount: 1,
    buyTimes: 0,
    limitBuyTimes: limit,
    vipLevel: 0,
    dan: 0,
    ...extra,
  });
  const state = {
    account,
    now,
    nextRefreshTime: now + 86400,
    balances: {
      EXP: 1000,
      GOLD: 10000,
      RUBY: account === "b" ? 2000 : 1000,
      ARENA_POINT: 1000,
      LEAGUE_POINT: 1000,
    },
    items: {
      [BLUEPRINT]: 0,
      竞技币: 1000,
      公会科技点: 1000,
      水姆币: 1000,
      积分赛货币: 1000,
    },
    shops: {
      1: [product(1101, "竞技币", 120, 5, 4)],
      2: [product(2101, "公会科技点", 30, 3, 4)],
      3: [
        product(3101, "RUBY", 25, 2, 8, { vipLevel: 3 }),
        product(3102, "RUBY", 80, 5, 2, { vipLevel: 9 }),
      ],
      4: [product(4101, "积分赛货币", 50, 4, 4, { dan: 2 })],
      13: [product(13101, "水姆币", 20, 2, 4)],
    },
    discount: [
      {
        id: 9101,
        reward: { asset: [asset(BLUEPRINT, 2)] },
        price: 16,
        discount: 0.8,
        isBuy: false,
      },
    ],
    refreshCount,
    nextDiscountItem: null,
    refreshLimit,
    refreshTiers: clone(refreshTiers),
    ads: [{ id: 9201, max: 2, gotTimes: 0, asset: asset("GOLD", 500) }],
    dan: 3,
    reads: [],
    writes: [],
    unexpected: [],
    pending: [],
    mode: "success",
    omitDefaults: false,
    inventoryLag: null,
    beforeRead: null,
    beforeWrite: null,
    activeWrites: 0,
    maxActiveWrites: 0,
  };
  const player = {
    playerId: account === "b" ? 10002 : 10001,
    worldId: 1001001,
    guildId: 9002,
    worldOpenTime: now - 30 * 86400,
    level: 50,
    nickname: `商店验收 ${account}`,
    vip: { vipLevel: 3 },
  };
  const client = new EventEmitter();
  client.setMaxListeners(50);
  client.connected = true;
  client.serverClockOffsetMs = 0;
  client.snapshot = () => ({ state: "READY", connected: client.connected });
  client.stop = () => {
    client.connected = false;
  };
  const fail = (name) => {
    state.unexpected.push(name);
    throw new Error(`商店离线夹具禁止未声明游戏请求：${name}`);
  };
  const inventory = (id) =>
    id in state.balances ? state.balances : state.items;
  function commit(transaction) {
    assert.equal(transaction.committed, false, "同一夹具事务不能提交两次");
    const { name, body } = transaction;
    let reward;
    if (name === "BuyShopProductRequest") {
      assert(
        Number.isSafeInteger(body.num) && body.num > 0,
        "协议购买份数必须为正整数",
      );
      const item = state.shops[body.type]?.find((row) => row.id === body.id);
      assert(item, "购买必须使用正确协议商店 type 和商品 id");
      if (item.limitBuyTimes > 0) {
        assert(
          item.buyTimes + body.num <= item.limitBuyTimes,
          "不能超过服务端限购",
        );
      } else {
        assert.equal(body.num, 1, "未设累计限购的商品每次只能购买1份");
      }
      assert(
        player.vip.vipLevel >= item.vipLevel && state.dan >= item.dan,
        "必须满足服务端资格",
      );
      const purse = inventory(item.price.id),
        cost = item.price.num * body.num;
      assert(purse[item.price.id] >= cost, "服务端也拒绝余额不足");
      purse[item.price.id] -= cost;
      inventory(item.asset.id)[item.asset.id] =
        (inventory(item.asset.id)[item.asset.id] ?? 0) +
        item.asset.num * body.num;
      item.buyTimes += body.num;
      reward = { asset: [asset(item.asset.id, item.asset.num * body.num)] };
    } else if (name === "DiscountShopRefreshRequest") {
      assert.equal(
        body && Object.keys(body).length,
        0,
        "折扣商店更新请求不携带商品参数",
      );
      assert(
        state.refreshCount < state.refreshLimit,
        "不能超过折扣商店更新上限",
      );
      const nextCount = state.refreshCount + 1;
      const tier =
        state.refreshTiers.find((row) => row.times >= nextCount) ??
        state.refreshTiers.at(-1);
      const cost = tier?.cost ?? [];
      if (cost.length) {
        assert.equal(cost[0], "RUBY", "本夹具仅允许声明钻石费用");
        assert(
          Number.isSafeInteger(cost[1]) && cost[1] >= 0,
          "更新费用必须为非负整数",
        );
        assert(state.balances.RUBY >= cost[1], "服务端也拒绝更新余额不足");
        state.balances.RUBY -= cost[1];
      }
      state.refreshCount = nextCount;
      state.discount = [
        {
          id: 9101 + nextCount,
          reward: { asset: [asset(BLUEPRINT, 2 + nextCount)] },
          price: 16 + nextCount,
          discount: 0.8,
          isBuy: false,
        },
      ];
      reward = { shopItem: clone(state.discount) };
    } else if (name === "DiscountShopBuyRequest") {
      const item = state.discount.find((row) => row.id === body.id);
      assert(item && !item.isBuy, "不能重复购买折扣商品");
      const cost = Math.floor(item.price * item.discount);
      assert(state.balances.RUBY >= cost, "折扣商品余额不足");
      state.balances.RUBY -= cost;
      item.isBuy = true;
      for (const row of item.reward.asset) inventory(row.id)[row.id] += row.num;
      reward = clone(item.reward);
      if (state.nextDiscountItem) {
        Object.assign(item, state.nextDiscountItem);
        state.nextDiscountItem = null;
      }
    } else if (name === "GotAdvRewardRequest") {
      const item = state.ads.find((row) => row.id === body.id);
      assert(item && item.gotTimes < item.max, "不能超过广告限次");
      item.gotTimes++;
      inventory(item.asset.id)[item.asset.id] += item.asset.num;
      reward = { asset: [clone(item.asset)] };
    } else {
      fail(name);
    }
    transaction.committed = true;
    return reward;
  }
  async function write(name, body, beforeSend) {
    const transaction = {
      name,
      body: clone(body),
      committed: false,
      readIndex: state.reads.length,
    };
    state.writes.push(transaction);
    state.activeWrites++;
    state.maxActiveWrites = Math.max(state.maxActiveWrites, state.activeWrites);
    try {
      if (state.beforeWrite) await state.beforeWrite(name, body);
      beforeSend?.();
      const mode = state.mode;
      state.mode = "success";
      if (mode === "unknown") {
        state.pending.push(transaction);
        return undefined;
      }
      if (mode === "notSent") {
        const error = new Error("离线夹具：原购买请求未发送");
        error.notSent = true;
        throw error;
      }
      if (mode === "rejected") {
        const error = new Error("server prompt: 商店服务端明确拒绝");
        Object.assign(error, {
          request: name,
          prompt: { prompt: 5, args: ["商店服务端明确拒绝"] },
        });
        throw error;
      }
      const oldInventory =
        mode === "stockLag"
          ? { balances: clone(state.balances), items: clone(state.items) }
          : null;
      const reward = commit(transaction);
      if (oldInventory) state.inventoryLag = oldInventory;
      if (name === "DiscountShopRefreshRequest")
        return {
          shopItem: clone(state.discount),
          refreshTime: state.nextRefreshTime,
          refreshCount: state.refreshCount,
        };
      if (name === "DiscountShopBuyRequest")
        return {
          shopItem: clone(state.discount.find((row) => row.id === body.id)),
          reward,
        };
      return undefined;
    } finally {
      state.activeWrites--;
    }
  }
  client.sendWatch = async (name, body, options = {}) => {
    assert(
      ["BuyShopProductRequest", "GotAdvRewardRequest"].includes(name),
      `不能通过sendWatch发送未声明写入：${name}`,
    );
    return write(name, body, options.beforeSend);
  };
  function optionalRows(value, fields) {
    const result = clone(value);
    if (state.omitDefaults) {
      for (const row of result) {
        for (const key of fields)
          if (row[key] === 0 || row[key] === false) delete row[key];
      }
    }
    return result;
  }
  client.request = async (
    name,
    body = {},
    responseName = name.replace(/Request$/, "Response"),
    _timeoutMs,
    beforeSend,
  ) => {
    if (name === "DiscountShopRefreshRequest")
      assert.equal(
        responseName,
        "DiscountShopResponse",
        "更新请求复用DiscountShopResponse",
      );
    assert.notEqual(
      responseName,
      "BuyShopProductResponse",
      "真实协议不存在通用购买同名响应",
    );
    if (["DiscountShopBuyRequest", "DiscountShopRefreshRequest"].includes(name))
      return write(name, body, beforeSend);
    state.reads.push({ name, body: clone(body) });
    if (state.beforeRead) await state.beforeRead(name, body);
    switch (name) {
      case "ShopInfoRequest":
        assert(
          Object.hasOwn(state.shops, body.type),
          `未知商店type：${body.type}`,
        );
        return {
          product: optionalRows(state.shops[body.type], [
            "buyTimes",
            "limitBuyTimes",
            "vipLevel",
            "dan",
          ]),
          nextRefreshTime: state.nextRefreshTime,
          refreshTimes: 0,
          halfEndTime: 0,
          preRefund: 0,
        };
      case "DiscountShopRequest": {
        const response = {
          shopItem: optionalRows(state.discount, ["isBuy"]),
          refreshTime: state.nextRefreshTime,
          refreshCount: state.refreshCount,
        };
        if (state.omitDefaults && state.refreshCount === 0)
          delete response.refreshCount;
        return response;
      }
      case "AdvShopInfoRequest":
        return { product: clone(state.ads) };
      case "AllResourceRequest":
        return {
          list: Object.entries(RESOURCE_IDS).map(([id, res]) => ({
            res,
            amount: (state.inventoryLag?.balances ?? state.balances)[id],
          })),
        };
      case "AllItemRequest":
        return {
          items: Object.entries(state.inventoryLag?.items ?? state.items).map(
            ([itemId, num]) => ({
              itemId,
              num,
            }),
          ),
        };
      case "LeagueInfoRequest":
        return { dan: state.dan, score: 1000, dailyChallengeTimes: 0 };
      case "FirstChargeRequest":
        return { firstCharge: { record: [] } };
      case "WatchAdvRequest":
        assert.equal(body.type, 2);
        assert(state.ads.some((row) => row.id === body.id));
        assert.equal(responseName, "OkResponse");
        return {};
      case "OnWaterRequest":
        return {
          building: [
            { buildingId: "1商店", level: 1 },
            { buildingId: "1竞技场", level: 1 },
          ],
          workerOrder: [],
        };
      case "WeekInfoRequest":
        return { activityTime: [] };
      case "CargoShipsRequest":
        return { ship: [] };
      case "AfkInfoRequest":
        return {
          afkInfo: {
            level: 1,
            afkStartTime: now,
            afkFinishTime: now + 3600,
            rewardedLevel: 0,
          },
        };
      case "AllHeroRequest":
        return { heroes: [] };
      case "MyFleetsRequest":
        return { fleets: [] };
      case "MainTaskInfoRequest":
        return { task: [] };
      case "DailyTaskInfoRequest":
        return { dailyTask: [], dailyResetTime: state.nextRefreshTime };
      case "EmailBoxRequest":
        return { email: [] };
      // The real console reads these panels before the shops page is opened.
      // Keep this list explicit: arbitrary reads and every undeclared write fail.
      case "OtherPlayerInfoRequest": {
        const requested =
          typeof body.playerId === "object"
            ? body.playerId.low
            : Number(body.playerId);
        assert.equal(
          requested,
          player.playerId,
          "总览战力读取必须属于当前隔离账号",
        );
        return { power: 500000 };
      }
      case "RecruitInfoRequest":
        return {
          hero: { freeEndTimeSeconds: now + 3600, recruitTimes: 0 },
          antique: { freeEndTimeSeconds: now + 3600, recruitTimes: 0 },
        };
      case "WorldInfoRequest":
        return { cities: [], fleets: [] };
      case "TreasureLootListRequest":
        return { treasure: [] };
      case "AllPirateRequest":
        return { pirates: [], sweepTimes: 0 };
      case "RadarInfoRequest":
        return { radarInfo: { events: [] } };
      case "WorldBossInfoRequest":
        return {
          info: { bossId: 0, gridIdx: 0, bestDamage: 0, gotRewardLevel: 0 },
        };
      case "AllGuildAbstractionRequest":
        return { guilds: [] };
      case "WarDeclarationRequest":
        return {
          declarations: [],
          startTime: now + 86400,
          endTime: now + 90000,
          assembleCityId: 0,
        };
      case "GuildInfoRequest":
        return {
          guild: {
            guildId: player.guildId,
            name: "商店验收联盟",
            level: 1,
            memberCount: 1,
            welfarePack: [],
            gotWelfareTime: now,
          },
        };
      case "GuildTechInfoRequest":
        return { tech: [] };
      case "SeasonTaskStageRequest":
        return { stage: 0 };
      case "GuildAidListRequest":
        assert.equal(body.type, 0);
        return { askItems: [], lastReadAskTime: now };
      case "MyGuildAidRequest":
        assert.equal(body.type, 0);
        return { aids: [] };
      case "MyResFieldsRequest":
        return { info: { fields: [], maxNum: 0 } };
      case "AchievementInfoRequest":
      case "MonthCardRequest":
        return {};
      default:
        return fail(name);
    }
  };
  return {
    client,
    player,
    state,
    commitPending() {
      const transactions = state.pending.splice(0);
      for (const transaction of transactions) commit(transaction);
    },
  };
}

export async function createShopConsole(prefix = "cw-shops-") {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, prefix));
  process.env.CW_DATA_DIR = directory;
  process.env.CW_CONFIG_PACK = path.join(directory, "config.json");
  process.env.CW_RESOURCE_DIR = path.join(directory, "resources");
  process.env.CW_RESOURCE_AUTO_UPDATE = "0";
  process.env.CW_PROTO_BUNDLE = path.join(
    directory,
    "never-use-real-protocol.js",
  );
  fs.writeFileSync(
    process.env.CW_CONFIG_PACK,
    JSON.stringify(shopConfigPack()),
  );
  const { saveStore } = await import("../../src/accounts.mjs");
  const { defaultSettings, saveAutomationSettings } = await import(
    "../../src/automation-settings.mjs"
  );
  const { GameClient } = await import("../../src/client.mjs");
  const { createConsole } = await import("../../src/server.mjs");
  let connections = 0;
  const originalConnect = GameClient.prototype.connect;
  GameClient.prototype.connect = async () => {
    connections++;
    throw new Error("商店验收禁止建立游戏连接");
  };
  const accounts = ["a", "b", "offline"].map((id) => ({
    id,
    label: `商店验收账号 ${id}`,
    url: "wss://shop-fixture.invalid",
    login: {},
    automation: { enabled: false, autoStart: false, paused: false },
  }));
  saveStore({ version: 1, activeId: "a", accounts });
  for (const { id } of accounts) {
    const settings = defaultSettings();
    function disable(value) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "boolean") value[key] = false;
        else if (item && typeof item === "object") disable(item);
      }
    }
    disable(settings);
    Object.assign(settings.resources, {
      allowDiamonds: true,
      diamondDailyLimit: 10000,
      diamondThreshold: 0,
    });
    saveAutomationSettings(id, settings, { revision: 0 });
  }
  const messagePairs = [
    "ShopInfo",
    "DiscountShop",
    "DiscountShopBuy",
    "AdvShopInfo",
    "AllResource",
    "AllItem",
    "LeagueInfo",
    "FirstCharge",
    "OnWater",
    "AfkInfo",
    "AllHero",
    "MyFleets",
    "MainTaskInfo",
    "DailyTaskInfo",
    "EmailBox",
    "AchievementInfo",
    "MonthCard",
    "MyResFields",
    "WeekInfo",
    "CargoShips",
    "OtherPlayerInfo",
    "RecruitInfo",
    "WorldInfo",
    "TreasureLootList",
    "AllPirate",
    "RadarInfo",
    "WorldBossInfo",
    "AllGuildAbstraction",
    "WarDeclaration",
    "GuildInfo",
    "GuildTechInfo",
    "SeasonTaskStage",
    "GuildAidList",
    "MyGuildAid",
  ];
  const protocol = createDeclaredProtocol([
    ...messagePairs.flatMap((name) => [`${name}Request`, `${name}Response`]),
    "BuyShopProductRequest",
    "DiscountShopRefreshRequest",
    "WatchAdvRequest",
    "GotAdvRewardRequest",
    "OkResponse",
  ]);
  const app = createConsole({ port: 0, protocol, resourceUpdates: false });
  const root = await app.listen();
  async function api(route, body, account = "a", query = {}) {
    const url = new URL(`/api/${route}`, root);
    if (account !== null) url.searchParams.set("account", account);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, data: await response.json() };
  }
  const fixtures = new Map();
  for (const account of ["a", "b"]) {
    const response = await api("settings", undefined, account);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const fixture = createShopClient(account);
    fixtures.set(account, fixture);
    Object.assign(app.sessions.get(account), {
      client: fixture.client,
      player: fixture.player,
      paused: false,
    });
  }
  return {
    app,
    root,
    directory,
    api,
    fixtures,
    connections: () => connections,
    async close() {
      try {
        app.server.closeAllConnections();
        await app.close();
      } finally {
        GameClient.prototype.connect = originalConnect;
        assert.equal(
          path.dirname(directory),
          temporaryRoot,
          "只允许删除本测试的临时目录",
        );
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
