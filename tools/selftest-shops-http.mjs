// 路由、账号队列和消费边界验收：只运行隔离 HTTP + 独立假游戏服务端。
import assert from "node:assert/strict";
import {
  ARENA_PRODUCT,
  BLUEPRINT,
  createShopConsole,
  deferred,
  SHOP_FIXTURE_CATALOG,
  VIP_PRODUCT,
} from "./fixtures/shop-console.mjs";

const h = await createShopConsole("cw-shops-http-");
const { createUsageLedger } = await import("../src/usage-ledger.mjs");
const a = h.fixtures.get("a"),
  b = h.fixtures.get("b");
const session = h.app.sessions.get("a");
let passed = 0;
const ok = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
};
const read = async (shop = "vip", account = "a") =>
  ok(await h.api("shops", undefined, account, { shop }));
const find = (view, id) => {
  const row = view.products.find((item) => item.id === id);
  assert(row, `缺少商品${id}`);
  return row;
};
function body(shop, row, quantity = 1, extra = {}) {
  return {
    shop,
    id: row.id,
    quantity,
    token: row.token,
    confirm: true,
    paid: row.price.id === "RUBY",
    ...extra,
  };
}
const buy = (payload, account = "a") =>
  h.api("shops/purchase", payload, account);
const updateGameShop = (payload, account = "a") =>
  h.api("shops/game-refresh", payload, account);
const refreshPayload = (gameRefresh, paid = false) => ({
  shop: "discount",
  token: gameRefresh.token,
  confirm: true,
  paid,
});
const denied = (result) => {
  assert(
    result.status >= 400 ||
      ["rejected", "cancelled"].includes(result.data.status),
    JSON.stringify(result),
  );
  return result.data;
};
const writeCount = () => a.state.writes.length + b.state.writes.length;
async function test(name, work) {
  await work();
  passed++;
  console.log(`通过：${name}`);
}
async function until(condition, label) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function resources(change, account = "a") {
  const current = ok(await h.api("settings", undefined, account));
  Object.assign(current.settings.resources, change);
  ok(
    await h.api(
      "settings",
      {
        settings: current.settings,
        revision: current.revision,
        baseRevision: current.baseRevision,
      },
      account,
    ),
  );
}

try {
  await test("GET和POST必须明确账号且已有连接，离线读取绝不登录", async () => {
    const payload = {
      shop: "vip",
      id: 3101,
      quantity: 1,
      token: "fixture",
      confirm: true,
      paid: true,
    };
    const update = {
      shop: "discount",
      token: "fixture",
      confirm: true,
      paid: false,
    };
    denied(await h.api("shops", undefined, null));
    denied(await buy(payload, null));
    denied(await updateGameShop(update, null));
    denied(await h.api("shops", undefined, "offline", { shop: "vip" }));
    denied(await buy(payload, "offline"));
    denied(await updateGameShop(update, "offline"));
    assert.equal(h.connections(), 0);
    assert.equal(writeCount(), 0);
  });

  await test("七店GET保留真实type映射且只读，VIP蓝图价格和限购来自服务端", async () => {
    for (const expected of SHOP_FIXTURE_CATALOG) {
      const view = await read(expected.id);
      assert.equal(view.shop.id, expected.id);
      assert.equal(view.shop.type, expected.type);
      if (expected.id === "discount") {
        assert.equal(view.gameRefresh.refreshCount, 0);
        assert.equal(view.gameRefresh.limit, 3);
        assert.equal(view.gameRefresh.remaining, 3);
        assert.deepEqual(
          {
            id: view.gameRefresh.price.id,
            name: view.gameRefresh.price.name,
            num: view.gameRefresh.price.num,
          },
          { id: "RUBY", name: "钻石", num: 0 },
        );
        assert.equal(view.gameRefresh.canRefresh, true);
        assert.equal(view.gameRefresh.blockedReason, "");
        assert(view.gameRefresh.token);
        assert.equal(view.products[0].id, 9101, "GET只读，不改变游戏折扣商品");
      } else assert.equal(view.gameRefresh, null);
      assert.deepEqual(
        view.catalog
          .map(({ id, type }) => ({ id, type }))
          .sort((x, y) => x.id.localeCompare(y.id)),
        SHOP_FIXTURE_CATALOG.map(({ id, type }) => ({ id, type })).sort(
          (x, y) => x.id.localeCompare(y.id),
        ),
      );
      assert(view.updatedAt > 1_000_000_000_000, "updatedAt使用毫秒");
      assert.doesNotMatch(
        JSON.stringify(view),
        /shop-fixture\.invalid|eworldParams|"login"/,
      );
    }
    const view = ok(await h.api("shops")),
      item = find(view, VIP_PRODUCT);
    assert.equal(view.shop.id, "vip", "缺省商店为VIP");
    assert.equal(item.asset.id, BLUEPRINT);
    assert.equal(item.asset.name, BLUEPRINT);
    assert.equal(item.asset.num, 2);
    assert.equal(item.price.id, "RUBY");
    assert.equal(item.price.num, 25, "VIP配置0.5不应再次乘当前价格");
    assert.equal(item.remaining, 8);
    assert.equal(item.maxQuantity, 8);
    assert(item.canBuy && item.token);
    assert.equal(
      view.nextRefreshTime,
      a.state.nextRefreshTime,
      "刷新时间使用秒",
    );
    assert.equal(find(view, 3102).canBuy, false);
    assert.match(find(view, 3102).blockedReason, /VIP/i);
    assert.equal(writeCount(), 0);
  });

  await test("后台账号队列占用时GET经只读插队通道返回，不等待整轮挂机", async () => {
    const release = deferred();
    const writesBefore = writeCount();
    let interleaved = 0;
    session.queueTail = release.promise;
    a.client.interleaveRead = async (work) => {
      interleaved++;
      return work();
    };
    try {
      const view = await read();
      assert.equal(view.shop.id, "vip");
      assert.equal(interleaved, 1, "GET必须使用readJob而不是挂在整轮队列后");
      assert.equal(writeCount(), writesBefore);
    } finally {
      release.resolve();
      session.queueTail = null;
      delete a.client.interleaveRead;
    }
  });

  await test("HTTP严格校验确认、类型、数量与报价token，客户端价格不能授权消费", async () => {
    const item = find(await read(), VIP_PRODUCT),
      payload = body("vip", item);
    for (const extra of [
      { confirm: false },
      { confirm: "true" },
      { quantity: 0 },
      { quantity: 1.5 },
      { quantity: "1" },
      { id: String(item.id) },
      { paid: "true" },
      { token: "" },
      { shop: "unknown" },
      { token: "forged", price: { id: "RUBY", num: 0 } },
    ])
      denied(await buy({ ...payload, ...extra }));
    assert.equal(writeCount(), 0);
    denied(await buy(payload, "b"));
    assert.equal(b.state.writes.length, 0, "A的token不能购买B账号商品");
    denied(await buy(body("arena", item)));
    assert.equal(writeCount(), 0, "VIP的token不能用于竞技场");
  });

  await test("VIP蓝图购买2份：实际扣50钻、到账4个、限购减少2且返回明确结果", async () => {
    const item = find(await read(), VIP_PRODUCT);
    const result = ok(await buy(body("vip", item, 2)));
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.shopId, "vip");
    assert.equal(result.productId, item.id);
    assert.equal(result.quantity, 2);
    assert(result.message);
    assert.deepEqual(
      result.costs.map(({ id, num }) => ({ id, num })),
      [{ id: "RUBY", num: 50 }],
    );
    assert.deepEqual(
      result.rewards.map(({ id, num }) => ({ id, num })),
      [{ id: BLUEPRINT, num: 4 }],
    );
    assert.equal(a.state.balances.RUBY, 950);
    assert.equal(a.state.items[BLUEPRINT], 4);
    const after = await read(),
      row = find(after, VIP_PRODUCT);
    assert.equal(row.buyTimes, 2);
    assert.equal(row.remaining, 6);
    assert.equal(after.balances.find((entry) => entry.id === "RUBY").num, 950);
    assert.deepEqual(a.state.writes.at(-1).body, { type: 3, id: 3101, num: 2 });
    assert.equal(
      createUsageLedger("a").confirmedCounters().manualShopDiamonds,
      50,
    );
    assert.equal(createUsageLedger("a").snapshot().counters.diamonds ?? 0, 0);
  });

  await test("竞技场蓝图购买3份：实际扣360币、到账15个且使用type1", async () => {
    const item = find(await read("arena"), ARENA_PRODUCT);
    const result = ok(await buy(body("arena", item, 3)));
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(a.state.items.竞技币, 640);
    assert.equal(a.state.balances.ARENA_POINT, 1000, "挑战券不是商店兑换币");
    assert.equal(a.state.items[BLUEPRINT], 19);
    assert.deepEqual(
      result.costs.map(({ id, num }) => ({ id, num })),
      [{ id: "竞技币", num: 360 }],
    );
    assert.deepEqual(
      result.rewards.map(({ id, num }) => ({ id, num })),
      [{ id: BLUEPRINT, num: 15 }],
    );
    assert.equal(find(await read("arena"), ARENA_PRODUCT).remaining, 1);
    assert.deepEqual(a.state.writes.at(-1).body, { type: 1, id: 1101, num: 3 });
  });

  await test("同一报价并发双击和重复POST只发生一次游戏购买", async () => {
    const item = find(await read(), VIP_PRODUCT),
      payload = body("vip", item);
    const before = a.state.writes.length,
      ruby = a.state.balances.RUBY,
      blueprints = a.state.items[BLUEPRINT];
    const results = await Promise.all([buy(payload), buy(payload)]);
    assert(
      results.some(
        (result) => result.status === 200 && result.data.status === "completed",
      ),
    );
    await buy(payload);
    assert.equal(a.state.writes.length, before + 1);
    assert.equal(a.state.balances.RUBY, ruby - 25);
    assert.equal(a.state.items[BLUEPRINT], blueprints + 2);
    assert.equal(b.state.balances.RUBY, 2000);
  });

  await test("手动VIP和折扣购买可使用挂机保留的钻石，独立记录用量", async () => {
    const ledger = createUsageLedger("a");
    for (const policy of [
      { allowDiamonds: false, diamondDailyLimit: 10000, spent: 0 },
      { allowDiamonds: true, diamondDailyLimit: 0, spent: 0 },
      { allowDiamonds: true, diamondDailyLimit: 25, spent: 25 },
    ]) {
      const { spent, ...settings } = policy;
      await resources({ ...settings, diamondThreshold: a.state.balances.RUBY });
      if (spent)
        ledger.confirm(
          ledger.reserve({ diamonds: spent }, { diamonds: spent }),
        );
      for (const shop of policy.allowDiamonds ? ["vip"] : ["vip", "discount"]) {
        const view = await read(shop),
          item = shop === "vip" ? find(view, VIP_PRODUCT) : view.products[0];
        const before = a.state.writes.length,
          ruby = a.state.balances.RUBY,
          blueprints = a.state.items[BLUEPRINT],
          manual = ledger.confirmedCounters().manualShopDiamonds ?? 0;
        const result = ok(await buy(body(shop, item)));
        assert.equal(
          result.status,
          "completed",
          JSON.stringify({ shop, policy, result }),
        );
        assert.equal(a.state.writes.length, before + 1);
        assert.equal(a.state.balances.RUBY, ruby - item.price.num);
        assert.equal(a.state.items[BLUEPRINT], blueprints + item.asset.num);
        assert.equal(
          ledger.confirmedCounters().manualShopDiamonds,
          manual + item.price.num,
        );
        assert.equal(ledger.pendingCounters().manualShopDiamonds ?? 0, 0);
        assert.equal(ledger.snapshot().counters.diamonds ?? 0, spent);
        assert.equal(ledger.confirmedCounters().diamonds ?? 0, spent);
      }
    }
  });

  await test("手动钻石购买必须明确确认", async () => {
    const before = a.state.writes.length,
      ledger = createUsageLedger("a"),
      manual = ledger.confirmedCounters().manualShopDiamonds;
    await resources({
      allowDiamonds: false,
      diamondDailyLimit: 0,
      diamondThreshold: a.state.balances.RUBY,
    });
    for (const extra of [
      { confirm: false },
      { confirm: undefined },
      { paid: false },
      { paid: undefined },
      { paid: "true" },
    ])
      denied(await buy(body("vip", find(await read(), VIP_PRODUCT), 1, extra)));
    assert.equal(a.state.writes.length, before);
    assert.equal(ledger.pendingCounters().manualShopDiamonds ?? 0, 0);
    assert.equal(ledger.confirmedCounters().manualShopDiamonds, manual);
    assert.equal(ledger.snapshot().counters.diamonds, 25);
  });

  await test("展示后余额不足和超过剩余限购均由HTTP重新校验且不发送", async () => {
    let item = find(await read(), VIP_PRODUCT);
    const ruby = a.state.balances.RUBY,
      before = a.state.writes.length;
    a.state.balances.RUBY = 0;
    denied(await buy(body("vip", item)));
    assert.equal(a.state.writes.length, before);
    a.state.balances.RUBY = ruby;
    item = find(await read("arena"), ARENA_PRODUCT);
    assert.equal(item.remaining, 1);
    denied(await buy(body("arena", item, 2)));
    assert.equal(a.state.writes.length, before);
  });

  await test("不同商品POST通过同账号队列串行，游戏写请求不会并行", async () => {
    const first = body("vip", find(await read(), VIP_PRODUCT));
    const second = body("arena", find(await read("arena"), ARENA_PRODUCT));
    const started = deferred(),
      release = deferred();
    let blocked = false;
    a.state.beforeWrite = async () => {
      if (!blocked) {
        blocked = true;
        started.resolve();
        await release.promise;
      }
    };
    const request1 = buy(first);
    try {
      await Promise.race([
        started.promise,
        request1.then((result) => {
          assert.fail(`首笔购买未进入写请求：${JSON.stringify(result)}`);
        }),
      ]);
      const firstTail = session.queueTail;
      const request2 = buy(second);
      await until(
        () => session.queueTail !== firstTail,
        "第二笔商店购买必须进入同一账号队列",
      );
      release.resolve();
      const results = await Promise.all([request1, request2]);
      results.forEach((result) => {
        assert.equal(ok(result).status, "completed", JSON.stringify(result));
      });
    } finally {
      release.resolve();
      a.state.beforeWrite = null;
    }
    assert.equal(a.state.maxActiveWrites, 1);
    assert.equal(find(await read("arena"), ARENA_PRODUCT).remaining, 0);
  });

  await test("排队后暂停或账号代际变化会取消购买，不连接也不扣款", async () => {
    for (const change of [
      () => {
        session.paused = true;
      },
      () => {
        session.generation++;
      },
    ]) {
      const item = find(await read(), VIP_PRODUCT),
        before = a.state.writes.length;
      const release = deferred();
      session.queueTail = release.promise;
      const queued = buy(body("vip", item));
      try {
        await until(
          () => session.queueTail !== release.promise,
          "购买必须等待已占用的账号队列",
        );
        change();
      } finally {
        release.resolve();
      }
      denied(await queued);
      session.paused = false;
      assert.equal(a.state.writes.length, before);
    }
    assert.equal(h.connections(), 0);
  });

  await test("未知手动消费不重发，重建状态后独立钻石票据持久存在且只核销一次", async () => {
    const item = find(await read(), VIP_PRODUCT),
      payload = body("vip", item);
    const before = a.state.writes.length,
      ruby = a.state.balances.RUBY,
      ledger = createUsageLedger("a"),
      manual = ledger.confirmedCounters().manualShopDiamonds,
      automatic = ledger.snapshot().counters.diamonds;
    a.state.mode = "unknown";
    const result = ok(await buy(payload));
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.match(result.message, /核对|确认|未知|重试/);
    assert.equal(a.state.writes.length, before + 1);
    assert.equal(a.state.balances.RUBY, ruby);
    assert.equal(
      createUsageLedger("a").pendingCounters().manualShopDiamonds,
      25,
      "未知购买保留独立手动钻石票据",
    );
    await buy(payload);
    const pending = find(await read(), VIP_PRODUCT);
    if (pending.token) await buy(body("vip", pending));
    assert.equal(a.state.writes.length, before + 1);
    session.shops = undefined; // 模拟重连丢失进程内报价，持久账本必须继续防重。
    const reconnected = find(await read(), VIP_PRODUCT);
    if (reconnected.token) await buy(body("vip", reconnected));
    assert.equal(a.state.writes.length, before + 1);
    const restoredLedger = createUsageLedger("a");
    assert.equal(restoredLedger.pendingCounters().manualShopDiamonds, 25);
    assert.equal(restoredLedger.confirmedCounters().manualShopDiamonds, manual);
    assert.equal(restoredLedger.snapshot().counters.diamonds, automatic);
    a.commitPending();
    await read();
    assert.equal(a.state.writes.length, before + 1);
    assert.equal(a.state.balances.RUBY, ruby - 25);
    assert.equal(a.state.pending.length, 0);
    assert.equal(
      createUsageLedger("a").pendingCounters().manualShopDiamonds ?? 0,
      0,
      "核销后业务票据与guard手动钻石票据一起结算",
    );
    assert.equal(
      restoredLedger.confirmedCounters().manualShopDiamonds,
      manual + 25,
    );
    assert.equal(restoredLedger.snapshot().counters.diamonds, automatic);
    assert.equal(restoredLedger.confirmedCounters().diamonds, automatic);
    assert.equal(restoredLedger.snapshot().uncertain, 0);
    await read();
    assert.equal(
      restoredLedger.confirmedCounters().manualShopDiamonds,
      manual + 25,
    );
    assert.equal(
      a.state.writes.length,
      before + 1,
      "再次刷新不得重新购买或重复核销",
    );
  });

  await test("真实协议省略optional默认字段时仍可购买，未设限购仅允许每次1份", async () => {
    b.state.omitDefaults = true;
    b.state.shops[3][0].limitBuyTimes = 0;
    b.state.shops[3][0].vipLevel = 0;
    const wire = await b.client.request("ShopInfoRequest", { type: 3 });
    for (const key of ["buyTimes", "limitBuyTimes", "vipLevel", "dan"])
      assert.equal(Object.hasOwn(wire.product[0], key), false);
    let item = find(await read("vip", "b"), VIP_PRODUCT);
    assert.equal(item.buyTimes, 0);
    assert.equal(item.limitBuyTimes, 0);
    assert.equal(item.remaining, null);
    assert.equal(item.maxQuantity, 1);
    assert.equal(item.canBuy, true);
    const before = b.state.writes.length;
    denied(await buy(body("vip", item, 2), "b"));
    assert.equal(b.state.writes.length, before);
    item = find(await read("vip", "b"), VIP_PRODUCT);
    assert.equal(ok(await buy(body("vip", item), "b")).status, "completed");
    assert.equal(b.state.balances.RUBY, 1975);
    assert.equal(b.state.items[BLUEPRINT], 2);
    const discountWire = await b.client.request("DiscountShopRequest");
    assert.equal(Object.hasOwn(discountWire.shopItem[0], "isBuy"), false);
    const discount = (await read("discount", "b")).products[0];
    assert.equal(discount.canBuy, true);
    assert.equal(discount.buyTimes, 0);
    assert.equal(discount.price.num, 12, "折扣店单价向下取整");
    assert.equal(
      ok(await buy(body("discount", discount), "b")).status,
      "completed",
    );
    assert.equal(b.state.balances.RUBY, 1963);
    assert.equal(b.state.items[BLUEPRINT], 4);
  });

  await test("次数先增长而库存延迟时必须回读两类库存，不提前宣称奖励到账", async () => {
    const item = find(await read("vip", "b"), VIP_PRODUCT);
    const before = b.state.writes.length,
      ruby = b.state.balances.RUBY,
      blueprints = b.state.items[BLUEPRINT];
    b.state.mode = "stockLag";
    const result = ok(await buy(body("vip", item), "b"));
    assert.equal(result.status, "unknown", JSON.stringify(result));
    assert.equal(result.rewards.length, 0, "库存未同步不能声称已经获得奖励");
    const transaction = b.state.writes.at(-1);
    const afterWriteReads = b.state.reads
      .slice(transaction.readIndex)
      .map((entry) => entry.name);
    assert(
      afterWriteReads.includes("AllResourceRequest"),
      "写后必须回读资源余额",
    );
    assert(afterWriteReads.includes("AllItemRequest"), "写后必须回读道具库存");
    assert.equal(b.state.shops[3][0].buyTimes, 2);
    assert.equal(b.state.balances.RUBY, ruby - 25);
    assert.equal(b.state.items[BLUEPRINT], blueprints + 2);
    assert.equal(
      createUsageLedger("b").pendingCounters().manualShopDiamonds,
      25,
    );
    assert.equal(find(await read("vip", "b"), VIP_PRODUCT).canBuy, false);
    assert.equal(b.state.writes.length, before + 1);
    b.state.inventoryLag = null;
    const settled = find(await read("vip", "b"), VIP_PRODUCT);
    assert.equal(settled.buyTimes, 2);
    assert.equal(
      createUsageLedger("b").pendingCounters().manualShopDiamonds ?? 0,
      0,
      "库存恢复后核销待确认手动钻石票据",
    );
    assert.equal(settled.canBuy, true);
    assert.equal(b.state.writes.length, before + 1, "库存同步仅核销不重发");
  });

  await test("HTTP严格验证游戏商店更新参数", async () => {
    const view = await read("discount");
    const payload = refreshPayload(view.gameRefresh);
    const before = a.state.writes.length;
    for (const extra of [
      { confirm: false },
      { confirm: "true" },
      { paid: "false" },
      { token: "forged" },
      { shop: "vip" },
    ]) {
      const result = await updateGameShop({ ...payload, ...extra });
      assert(result.status >= 400 || result.data.status === "rejected");
    }
    const crossAccount = await updateGameShop(payload, "b");
    assert(
      crossAccount.status >= 400 || crossAccount.data.status === "rejected",
    );
    assert.equal(a.state.writes.length, before);
  });

  await test("手动付费更新可使用挂机保留的钻石，按游戏次数上限执行", async () => {
    let view = await read("discount");
    const oldProduct = view.products[0];
    const beforeWrites = a.state.writes.length;
    const freeRuby = a.state.balances.RUBY;
    const free = ok(await updateGameShop(refreshPayload(view.gameRefresh)));
    assert.deepEqual(
      { action: free.action, status: free.status, shopId: free.shopId },
      { action: "game-refresh", status: "completed", shopId: "discount" },
    );
    assert.deepEqual(free.costs, []);
    assert.equal(a.state.writes.length, beforeWrites + 1);
    assert.equal(a.state.writes.at(-1).name, "DiscountShopRefreshRequest");
    assert.deepEqual(a.state.writes.at(-1).body, {});
    assert.equal(a.state.refreshCount, 1);
    assert.equal(a.state.balances.RUBY, freeRuby);
    assert.equal(a.state.discount[0].id, oldProduct.id + 1);
    view = await read("discount");
    assert.equal(view.gameRefresh.refreshCount, 1);
    assert.equal(view.gameRefresh.remaining, 2);
    assert.equal(view.gameRefresh.price.num, 0);
    const oldPurchase = await buy(body("discount", oldProduct));
    assert(oldPurchase.status >= 400 || oldPurchase.data.status === "rejected");
    assert.equal(
      a.state.writes.length,
      beforeWrites + 1,
      "更新后旧商品购买凭据失效",
    );

    a.state.refreshCount = 2;
    await resources({
      allowDiamonds: false,
      diamondDailyLimit: 0,
      diamondThreshold: 0,
    });
    view = await read("discount");
    assert.equal(view.gameRefresh.refreshCount, 2);
    assert.equal(view.gameRefresh.limit, 3);
    assert.equal(view.gameRefresh.remaining, 1);
    assert.equal(view.gameRefresh.price.num, 50);
    const paidWrites = a.state.writes.length;
    const notConfirmed = await updateGameShop(
      refreshPayload(view.gameRefresh, false),
    );
    assert(
      notConfirmed.status >= 400 || notConfirmed.data.status === "rejected",
    );
    assert.equal(a.state.writes.length, paidWrites, "付费更新必须显式确认");
    await resources({ diamondThreshold: a.state.balances.RUBY });
    view = await read("discount");
    const ruby = a.state.balances.RUBY;
    const paid = ok(
      await updateGameShop(refreshPayload(view.gameRefresh, true)),
    );
    assert.equal(paid.status, "completed");
    assert.deepEqual(
      paid.costs.map(({ id, name, num }) => ({ id, name, num })),
      [{ id: "RUBY", name: "钻石", num: 50 }],
    );
    assert.equal(a.state.balances.RUBY, ruby - 50);
    assert.equal(a.state.refreshCount, 3);
    const capped = await read("discount");
    assert.equal(capped.gameRefresh.remaining, 0);
    assert.equal(capped.gameRefresh.canRefresh, false);
    assert.match(capped.gameRefresh.blockedReason, /次数/);
    assert.equal(a.state.writes.length, paidWrites + 1);
  });

  await test("同token双POST仅更新一次；未知结果核对后不重发", async () => {
    a.state.refreshCount = 0;
    let view = await read("discount");
    let before = a.state.writes.length;
    const duplicate = await Promise.all([
      updateGameShop(refreshPayload(view.gameRefresh)),
      updateGameShop(refreshPayload(view.gameRefresh)),
    ]);
    assert.equal(
      duplicate.filter(
        (row) => row.status === 200 && row.data.status === "completed",
      ).length,
      1,
    );
    assert.equal(a.state.writes.length, before + 1);

    a.state.refreshCount = 2;
    view = await read("discount");
    before = a.state.writes.length;
    const ruby = a.state.balances.RUBY;
    a.state.mode = "unknown";
    const result = ok(
      await updateGameShop(refreshPayload(view.gameRefresh, true)),
    );
    assert.equal(result.action, "game-refresh");
    assert.equal(result.status, "unknown");
    assert.match(result.message, /核对|勿重复/);
    assert.equal(a.state.writes.length, before + 1);
    assert.equal(a.state.refreshCount, 2);
    assert.equal(a.state.balances.RUBY, ruby);
    view = await read("discount");
    assert.equal(view.gameRefresh.canRefresh, false);
    assert.match(view.gameRefresh.blockedReason, /待确认/);
    const retry = await updateGameShop(refreshPayload(view.gameRefresh, true));
    assert(retry.status >= 400 || retry.data.status === "rejected");
    assert.equal(a.state.writes.length, before + 1, "unknown不得自动重发");
    a.commitPending();
    view = await read("discount");
    assert.equal(a.state.refreshCount, 3);
    assert.equal(a.state.balances.RUBY, ruby - 50);
    assert.equal(view.gameRefresh.canRefresh, false, "核对后仍受次数上限限制");
    assert.equal(a.state.writes.length, before + 1);
  });

  await test("暂停后不更新，且VIP购买与更新共用串行写队列", async () => {
    a.state.refreshCount = 0;
    let view = await read("discount");
    const pauseRelease = deferred();
    session.queueTail = pauseRelease.promise;
    const pausedUpdate = updateGameShop(refreshPayload(view.gameRefresh));
    try {
      await until(
        () => session.queueTail !== pauseRelease.promise,
        "更新应进入账号队列",
      );
      session.paused = true;
    } finally {
      pauseRelease.resolve();
    }
    const pausedResult = await pausedUpdate;
    assert(
      pausedResult.status >= 400 ||
        pausedResult.data.status === "cancelled" ||
        pausedResult.data.status === "rejected",
    );
    session.paused = false;
    session.queueTail = null;
    assert.equal(a.state.refreshCount, 0);

    view = await read("discount");
    a.state.shops[3][0].limitBuyTimes = 20;
    const vip = find(await read("vip"), VIP_PRODUCT);
    const started = deferred();
    const release = deferred();
    let held = false;
    a.state.beforeWrite = async () => {
      if (!held) {
        held = true;
        started.resolve();
        await release.promise;
      }
    };
    a.state.maxActiveWrites = 0;
    const update = updateGameShop(refreshPayload(view.gameRefresh));
    try {
      await started.promise;
      const tail = session.queueTail;
      const purchase = buy(body("vip", vip));
      await until(
        () => session.queueTail !== tail,
        "VIP购买应加入与商店更新相同的账号队列",
      );
      release.resolve();
      const [updated, bought] = await Promise.all([update, purchase]);
      assert.equal(ok(updated).status, "completed");
      assert.equal(ok(bought).status, "completed");
    } finally {
      release.resolve();
      a.state.beforeWrite = null;
    }
    assert.equal(a.state.maxActiveWrites, 1, "同账号两种商店写请求不并发");
  });

  assert.equal(h.connections(), 0, "整套HTTP验收不得建立真实游戏连接");
  assert.deepEqual(a.state.unexpected, []);
  assert.deepEqual(b.state.unexpected, []);
  console.log(
    `商店 HTTP 验收 ${passed}/${passed} 通过；真实游戏连接0，VIP/竞技场蓝图余额与到账已核对`,
  );
} finally {
  await h.close();
}
