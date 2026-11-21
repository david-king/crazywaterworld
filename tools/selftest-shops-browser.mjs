// 真实控制台/React/HTTP，全链路使用独立假游戏服务端；不会登录或消费真实账号。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  ARENA_PRODUCT,
  BLUEPRINT,
  createShopConsole,
  deferred,
  SHOP_FIXTURE_CATALOG,
  VIP_PRODUCT,
} from "./fixtures/shop-console.mjs";

const h = await createShopConsole("cw-shops-browser-");
const a = h.fixtures.get("a"),
  b = h.fixtures.get("b");
const output = path.resolve("output/shops");
fs.mkdirSync(output, { recursive: true });
const errors = [],
  requests = [],
  external = [];
let browser,
  browserProcess,
  browserProfile,
  page,
  passed = 0;
async function test(name, work) {
  await work();
  passed++;
  console.log(`通过：${name}`);
}
const shopRequests = () => requests.filter((row) => row.path === "/api/shops");
const posts = () =>
  requests.filter(
    (row) => row.path === "/api/shops/purchase" && row.method === "POST",
  );
const panel = () => page.locator("#tab-shops");
const product = (id) => panel().locator(`tr[data-product-id='${id}']`);
const purchase = (id) =>
  product(id).getByRole("button", { name: `购买${BLUEPRINT}`, exact: true });
const quantity = (id) =>
  product(id).getByRole("spinbutton", {
    name: `${BLUEPRINT}购买份数`,
    exact: true,
  });
const confirmation = () =>
  page.getByRole("dialog", { name: "确认购买", exact: true });
const receipt = (status) =>
  panel().locator(`[data-purchase-status='${status}']`);
const shopResponse = (response, shop, account) => {
  const url = new URL(response.url());
  return (
    url.pathname === "/api/shops" &&
    (!shop || url.searchParams.get("shop") === shop) &&
    (!account || url.searchParams.get("account") === account)
  );
};
async function ready(id = VIP_PRODUCT) {
  await product(id).waitFor();
  await panel().locator('[aria-busy="false"]').waitFor();
}
function shopTab(shop) {
  const title = SHOP_FIXTURE_CATALOG.find((row) => row.id === shop).title;
  return panel()
    .getByRole("group", { name: "商店分类" })
    .getByRole("button", { name: title, exact: true });
}
async function choose(shop) {
  const button = shopTab(shop);
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    const response = page.waitForResponse((row) => shopResponse(row, shop));
    await button.click();
    assert.equal((await response).status(), 200);
  }
  await panel().locator("tr[data-product-id]").first().waitFor();
}
async function reenterShop(shop, id) {
  await choose("arena");
  await choose(shop);
  await ready(id);
}
async function select(account) {
  await page.evaluate(
    (id) => window.cwConsoleStore.getState().actions.selectAccount(id),
    account,
  );
  if (account) await panel().locator(`[data-account='${account}']`).waitFor();
}
async function confirmPurchase(id, count) {
  await quantity(id).fill(String(count));
  await purchase(id).click();
  await confirmation().waitFor();
  const completed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/shops/purchase",
  );
  const reread = page.waitForResponse((response) => shopResponse(response));
  await confirmation()
    .getByRole("button", { name: "确认购买", exact: true })
    .click();
  const response = await completed;
  assert.equal(response.status(), 200, await response.text());
  const result = await response.json();
  await reread;
  await receipt(result.status).waitFor();
  await ready(id);
  return result;
}
const gamePosts = () =>
  requests.filter(
    (row) => row.path === "/api/shops/game-refresh" && row.method === "POST",
  );
const updateButton = () =>
  panel().getByRole("button", { name: /^(刷新|今日刷新次数已耗尽)/ });
const updateDialog = () =>
  page.getByRole("dialog", { name: "确认刷新", exact: true });
async function confirmGameRefresh(double = false) {
  const written = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/shops/game-refresh",
  );
  const read = page.waitForResponse((response) =>
    shopResponse(response, "discount", "a"),
  );
  if (double) {
    await updateDialog().evaluate((dialog) => {
      const button = [...dialog.querySelectorAll("button")].find(
        (item) => item.textContent.trim() === "确认刷新",
      );
      button.click();
      button.click();
    });
  } else
    await updateDialog()
      .getByRole("button", { name: "确认刷新", exact: true })
      .click();
  const response = await written;
  assert.equal(response.status(), 200, await response.text());
  const result = await response.json();
  await read;
  await ready(a.state.discount[0].id);
  await panel()
    .locator(`[data-game-refresh-status='${result.status}']`)
    .waitFor();
  return result;
}

async function screenshot(name) {
  await page.screenshot({
    path: path.join(output, name),
    fullPage: true,
    animations: "disabled",
  });
}
async function noOverflow() {
  assert.equal(
    await panel().evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
    true,
    "商店面板不能横向溢出",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "页面不能横向溢出",
  );
}

// Some confined Windows runners forbid child stdio pipes. CDP uses only a
// loopback socket, a fresh workspace profile and inherited stderr (no pipes).
async function launchBrowser(executablePath) {
  if (process.env.CW_BROWSER_TEST_CDP !== "1")
    return chromium.launch({ executablePath, headless: true });
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let launchError;
  browserProfile = fs.mkdtempSync(path.join(output, ".browser-profile-"));
  browserProcess = spawn(
    executablePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-sync",
      `--user-data-dir=${browserProfile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
      env: { ...process.env, TEMP: browserProfile, TMP: browserProfile },
    },
  );
  browserProcess.once("error", (error) => {
    launchError = error;
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    assert.equal(
      browserProcess.exitCode,
      null,
      "隔离浏览器在CDP连接前意外退出",
    );
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return chromium.connectOverCDP(endpoint);
    } catch {
      /* Wait for this child browser to open its loopback endpoint. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("隔离浏览器未能在15秒内开放CDP端点");
}

try {
  // Prove the real UI purchase flow works with automatic diamond spending disabled.
  for (const account of ["a", "b"]) {
    const current = await h.api("settings", undefined, account);
    assert.equal(current.status, 200);
    current.data.settings.resources.allowDiamonds = false;
    current.data.settings.resources.diamondDailyLimit = 0;
    current.data.settings.resources.diamondThreshold = 10000;
    const saved = await h.api(
      "settings",
      {
        settings: current.data.settings,
        revision: current.data.revision,
        baseRevision: current.data.baseRevision,
      },
      account,
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
  }
  const executablePath = [
    process.env.CW_BROWSER_TEST_EXECUTABLE,
    chromium.executablePath(),
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((file) => file && fs.existsSync(file));
  assert(
    executablePath,
    "未找到本机验收浏览器，可设置CW_BROWSER_TEST_EXECUTABLE",
  );
  browser = await launchBrowser(executablePath);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(h.root).origin) return route.continue();
    external.push(url.origin);
    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push({
      path: url.pathname,
      account: url.searchParams.get("account"),
      shop: url.searchParams.get("shop"),
      method: request.method(),
      body: request.method() === "POST" ? request.postData() : null,
    });
  });

  await test("商店按需加载；选中已连接账号才发只读请求", async () => {
    await page.goto(h.root);
    await page
      .locator("#account-picker-title")
      .filter({ hasText: "商店验收账号 a" })
      .waitFor();
    assert.equal(shopRequests().length, 0);
    assert.equal(posts().length, 0);
    assert.equal(h.connections(), 0);
    await page.locator('#tabs [data-tab="resources"]').click();
    await page.locator('[data-resource-tab="shops"]').click();
    await panel().getByRole("heading", { name: "商店", exact: true }).waitFor();
    await ready();
    assert.equal(
      await page.evaluate(
        () => window.cwConsoleStore.getState().accountsById.a.status.connected,
      ),
      true,
    );
    assert.equal(shopRequests().at(-1).account, "a");
    assert.match(
      await product(VIP_PRODUCT).textContent(),
      /每份\s*2\s*建筑蓝图/,
    );
    assert.match(await product(VIP_PRODUCT).textContent(), /25\s*钻石/);
    assert.match(await product(VIP_PRODUCT).textContent(), /8 份/);
    assert.equal(
      (await product(VIP_PRODUCT).locator("svg, img").count()) > 0,
      true,
      "商品有图标或缺图占位",
    );
    assert.equal(await purchase(3102).isDisabled(), true);
    assert.match(await product(3102).textContent(), /VIP\s*9/);
  });

  await test("七类商店均能切换且GET无购买副作用", async () => {
    assert.equal(
      await panel()
        .getByRole("group", { name: "商店分类" })
        .getByRole("button")
        .count(),
      7,
    );
    for (const shop of SHOP_FIXTURE_CATALOG) {
      await choose(shop.id);
      const active = panel()
        .getByRole("group", { name: "商店分类" })
        .getByRole("button", { name: shop.title, exact: true });
      assert.equal(await active.getAttribute("aria-pressed"), "true");
      if (shop.id === "ad")
        assert.equal(
          await panel()
            .getByRole("spinbutton")
            .first()
            .getAttribute("readonly"),
          "",
        );
    }
    await choose("vip");
    assert.equal(a.state.writes.length + b.state.writes.length, 0);
    assert.equal(posts().length, 0);
  });

  await test("非法数量在客户端阻止；二次确认展示账号、总价、总奖励且可取消", async () => {
    for (const value of ["0", "1.5", "9"]) {
      await quantity(VIP_PRODUCT).fill(value);
      assert.equal(
        await quantity(VIP_PRODUCT).getAttribute("aria-invalid"),
        "true",
      );
      assert.equal(await purchase(VIP_PRODUCT).isDisabled(), true);
    }
    await quantity(VIP_PRODUCT).fill("2");
    await purchase(VIP_PRODUCT).click();
    const dialog = confirmation();
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /商店验收账号 a/);
    assert.match(await dialog.textContent(), /2 份/);
    assert.match(await dialog.textContent(), /50\s*钻石/);
    assert.match(await dialog.textContent(), /4\s*建筑蓝图/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
      true,
    );
    await screenshot("vip-confirm-390.png");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(posts().length, 0);
    assert.equal(a.state.writes.length, 0);
    await page.setViewportSize({ width: 1280, height: 1000 });
  });

  await test("过期购买报价明确显示未购买，并允许重新读取报价", async () => {
    await purchase(VIP_PRODUCT).click();
    await confirmation().waitFor();
    for (const record of h.app.sessions.get("a").shops.tokens.values())
      record.expiresAt = Date.now() - 1;
    await confirmation()
      .getByRole("button", { name: "确认购买", exact: true })
      .click();
    await receipt("rejected").waitFor();
    assert.match(
      await receipt("rejected").textContent(),
      /未购买[\s\S]*报价已失效/,
    );
    assert.equal(a.state.writes.length, 0);
    await ready(VIP_PRODUCT);
  });
  await test("UI购买VIP蓝图2份后展示结果并更新钻石、到账与限购", async () => {
    const result = await confirmPurchase(VIP_PRODUCT, 2);
    assert.equal(result.status, "completed");
    assert.match(await receipt("completed").textContent(), /50\s*钻石/);
    assert.match(await receipt("completed").textContent(), /4\s*建筑蓝图/);
    assert.match(
      await panel().getByRole("group", { name: "当前货币" }).textContent(),
      /950\s*钻石/,
    );
    assert.match(await product(VIP_PRODUCT).textContent(), /6 份/);
    assert.equal(a.state.balances.RUBY, 950);
    assert.equal(a.state.items[BLUEPRINT], 4);
    assert.deepEqual(a.state.writes.at(-1).body, {
      type: 3,
      id: VIP_PRODUCT,
      num: 2,
    });
    await noOverflow();
    await screenshot("vip-1280.png");
  });

  await test("UI购买竞技场蓝图3份扣竞技币并到账15个，桌面及390px不溢出", async () => {
    await choose("arena");
    const result = await confirmPurchase(ARENA_PRODUCT, 3);
    assert.equal(result.status, "completed");
    assert.equal(a.state.items.竞技币, 640);
    assert.equal(a.state.balances.ARENA_POINT, 1000);
    assert.equal(a.state.items[BLUEPRINT], 19);
    assert.match(await receipt("completed").textContent(), /360\s*竞技币/);
    assert.match(await receipt("completed").textContent(), /15\s*建筑蓝图/);
    assert.match(await product(ARENA_PRODUCT).textContent(), /1 份/);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow();
      await screenshot(`arena-${width}.png`);
    }
    await choose("vip");
    await screenshot("vip-390.png");
    await page.setViewportSize({ width: 1280, height: 1000 });
  });

  await test("确认按钮同步双击只发一次POST；切到B后迟到结果只归A", async () => {
    const started = deferred(),
      release = deferred(),
      finished = deferred();
    await page.route(
      "**/api/shops/purchase?*",
      async (route) => {
        const response = await route.fetch();
        started.resolve();
        await release.promise;
        await route.fulfill({ response });
        finished.resolve();
      },
      { times: 1 },
    );
    const count = posts().length,
      writes = a.state.writes.length;
    await quantity(VIP_PRODUCT).fill("1");
    await purchase(VIP_PRODUCT).click();
    await confirmation()
      .getByRole("button", { name: "确认购买", exact: true })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    try {
      await started.promise;
      assert.equal(posts().length, count + 1);
      assert.equal(a.state.writes.length, writes + 1);
      const payload = JSON.parse(posts().at(-1).body);
      assert.equal(posts().at(-1).account, "a");
      assert.equal(payload.quantity, 1);
      assert.equal(payload.confirm, true);
      await select("b");
      await ready();
      assert.match(
        await panel().getByRole("group", { name: "当前货币" }).textContent(),
        /2,000\s*钻石/,
      );
      assert.equal(
        await receipt("completed").count(),
        0,
        "A的结果不得出现在B页面",
      );
    } finally {
      release.resolve();
    }
    await finished.promise;
    assert.equal(b.state.writes.length, 0);
    assert.equal(b.state.balances.RUBY, 2000);
    assert.equal(await receipt("completed").count(), 0);
    await select("a");
    await ready();
    await receipt("completed").waitFor();
    assert.equal(posts().length, count + 1);
    assert.equal(a.state.balances.RUBY, 925);
  });

  await test("A读取延迟时切到B，迟到商品响应不会覆盖B余额", async () => {
    await choose("arena");
    const started = deferred(),
      release = deferred(),
      finished = deferred();
    await page.route(
      "**/api/shops?*",
      async (route) => {
        if (new URL(route.request().url()).searchParams.get("account") !== "a")
          return route.continue();
        const response = await route.fetch();
        started.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
        finished.resolve();
      },
      { times: 1 },
    );
    await shopTab("vip").click();
    try {
      await started.promise;
      await select("b");
      await ready();
      assert.match(
        await panel().getByRole("group", { name: "当前货币" }).textContent(),
        /2,000\s*钻石/,
      );
    } finally {
      release.resolve();
    }
    await finished.promise;
    assert.match(
      await panel().getByRole("group", { name: "当前货币" }).textContent(),
      /2,000\s*钻石/,
    );
    await select("a");
    await ready();
  });

  await test("未选账号、离线、暂停、重连和页面不可见时不发商店读取或购买", async () => {
    const count = shopRequests().length,
      writes = posts().length;
    await select(null);
    await panel().getByText("请先选择账号", { exact: true }).waitFor();
    assert.equal(shopRequests().length, count);
    await select("offline");
    await panel()
      .getByText("请先连接当前账号，再查看商店", { exact: true })
      .waitFor();
    assert.equal(shopRequests().length, count);
    await select("a");
    await ready();
    for (const flag of ["paused", "reconnecting", "loginBlocked"]) {
      const reads = shopRequests().length;
      await page.evaluate(
        (key) =>
          window.cwConsoleStore
            .getState()
            .actions.patchStatus("a", { [key]: true }),
        flag,
      );
      await product(VIP_PRODUCT).waitFor({ state: "hidden" });
      assert.equal(posts().length, writes);
      assert.equal(shopRequests().length, reads);
      await page.evaluate(
        (key) =>
          window.cwConsoleStore
            .getState()
            .actions.patchStatus("a", { [key]: false }),
        flag,
      );
      await ready();
    }
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await product(VIP_PRODUCT).waitFor({ state: "hidden" });
    const reads = shopRequests().length;
    assert.equal(posts().length, writes);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await ready();
    assert.equal(shopRequests().length, reads + 1);
    assert.equal(h.connections(), 0);
  });

  await test("HTTP写响应丢失显示待核对、自动回读且绝不自动重发", async () => {
    const count = posts().length,
      writes = a.state.writes.length,
      ruby = a.state.balances.RUBY;
    await page.route(
      "**/api/shops/purchase?*",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await quantity(VIP_PRODUCT).fill("1");
    await purchase(VIP_PRODUCT).click();
    await confirmation()
      .getByRole("button", { name: "确认购买", exact: true })
      .click();
    await receipt("unknown").waitFor();
    await ready();
    assert.match(await receipt("unknown").textContent(), /勿重复购买/);
    assert.equal(posts().length, count + 1);
    assert.equal(a.state.writes.length, writes + 1);
    assert.equal(a.state.balances.RUBY, ruby - 25);
    await reenterShop("vip", VIP_PRODUCT);
    assert.equal(posts().length, count + 1);
    await screenshot("unknown-response-1280.png");
  });

  await test("游戏结果未知的商品提示核对且刷新后禁购，不会自行重发", async () => {
    const count = posts().length,
      writes = a.state.writes.length,
      ruby = a.state.balances.RUBY;
    a.state.mode = "unknown";
    const result = await confirmPurchase(VIP_PRODUCT, 1);
    assert.equal(result.status, "unknown");
    assert.match(await receipt("unknown").textContent(), /结果待核对/);
    assert.match(await receipt("unknown").textContent(), /勿重复购买/);
    assert.equal(await purchase(VIP_PRODUCT).isDisabled(), true);
    await reenterShop("vip", VIP_PRODUCT);
    assert.equal(posts().length, count + 1);
    assert.equal(a.state.writes.length, writes + 1);
    assert.equal(a.state.balances.RUBY, ruby);
    await page.setViewportSize({ width: 390, height: 1000 });
    await noOverflow();
    await screenshot("unknown-pending-390.png");
    a.commitPending();
    await reenterShop("vip", VIP_PRODUCT);
    assert.equal(a.state.balances.RUBY, ruby - 25);
    assert.equal(a.state.writes.length, writes + 1);
  });

  await test("读取失败可以重试，只读重试不消耗刷新次数", async () => {
    const writes = gamePosts().length;
    await page.route("**/api/shops?*", (route) => route.abort("failed"), {
      times: 1,
    });
    await shopTab("discount").click();
    const retry = panel().getByRole("button", { name: "重试读取" });
    await retry.waitFor();
    assert.equal(await updateButton().isDisabled(), true);
    assert.equal(await updateButton().textContent(), "刷新");
    await retry.click();
    await ready(a.state.discount[0].id);
    assert.equal(await retry.count(), 0);
    assert.equal(gamePosts().length, writes);
  });

  await test("折扣商店仅显示含费用与剩余次数的刷新按钮，取消和重新进入均只读", async () => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await choose("discount");
    await ready(a.state.discount[0].id);
    assert.equal(
      await updateButton().textContent(),
      "刷新 · 免费 · 剩余次数：3",
    );
    assert.equal(
      await panel().getByRole("button", { name: "重新获取商店商品" }).count(),
      0,
    );
    const writes = a.state.writes.length,
      postsBefore = gamePosts().length,
      ruby = a.state.balances.RUBY,
      count = a.state.refreshCount;
    await updateButton().click();
    await updateDialog().waitFor();
    assert.match(await updateDialog().textContent(), /本次费用.*免费/s);
    await updateDialog()
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await updateDialog().waitFor({ state: "hidden" });
    await reenterShop("discount", a.state.discount[0].id);
    assert.equal(a.state.writes.length, writes);
    assert.equal(gamePosts().length, postsBefore);
    assert.equal(a.state.refreshCount, count);
    assert.equal(a.state.balances.RUBY, ruby);
    await screenshot("discount-actions-1280.png");
    await page.setViewportSize({ width: 390, height: 1000 });
    await noOverflow();
    await screenshot("discount-actions-390.png");
    await page.setViewportSize({ width: 1280, height: 1000 });
  });
  await test("免费刷新经独立确认且双击只发送一次，随后只读重新获取商品", async () => {
    const writes = a.state.writes.length,
      postsBefore = gamePosts().length,
      ruby = a.state.balances.RUBY,
      count = a.state.refreshCount;
    const oldId = a.state.discount[0].id;
    await updateButton().click();
    await updateDialog().waitFor();
    const result = await confirmGameRefresh(true);
    assert.equal(result.action, "game-refresh");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.costs, []);
    assert.equal(gamePosts().length, postsBefore + 1);
    assert.equal(a.state.writes.length, writes + 1);
    assert.equal(a.state.writes.at(-1).name, "DiscountShopRefreshRequest");
    assert.deepEqual(a.state.writes.at(-1).body, {});
    assert.equal(a.state.refreshCount, count + 1);
    assert.equal(a.state.balances.RUBY, ruby);
    assert.notEqual(a.state.discount[0].id, oldId);
  });
  await test("付费刷新显示50钻与剩余次数，确认后扣款且次数用完禁用刷新", async () => {
    a.state.refreshCount = 2;
    await reenterShop("discount", a.state.discount[0].id);
    const ruby = a.state.balances.RUBY,
      count = gamePosts().length;
    assert.equal(
      await updateButton().textContent(),
      "刷新 · 50 钻石 · 剩余次数：1",
    );
    await updateButton().click();
    await updateDialog().waitFor();
    assert.match(await updateDialog().textContent(), /50.*钻石/s);
    assert.match(await updateDialog().textContent(), /剩余次数.*1.*次/s);
    await screenshot("discount-paid-confirm-1280.png");
    const result = await confirmGameRefresh();
    assert.equal(result.status, "completed");
    assert.equal(a.state.balances.RUBY, ruby - 50);
    assert.equal(a.state.refreshCount, 3);
    assert.equal(gamePosts().length, count + 1);
    assert.equal(JSON.parse(gamePosts().at(-1).body).paid, true);
    assert.equal(await updateButton().isDisabled(), true);
    assert.equal(await updateButton().textContent(), "今日刷新次数已耗尽");
    await reenterShop("discount", a.state.discount[0].id);
    assert.equal(gamePosts().length, count + 1);
    await screenshot("discount-updated-1280.png");
  });
  await test("刷新按钮仅在折扣商店显示", async () => {
    await choose("arena");
    assert.equal(await updateButton().count(), 0);
    await choose("vip");
    assert.equal(await updateButton().count(), 0);
  });

  assert.equal(h.connections(), 0);
  assert.deepEqual(a.state.unexpected, []);
  assert.deepEqual(b.state.unexpected, []);
  assert.deepEqual(errors, []);
  assert.equal(
    requests.filter((row) =>
      /\/api\/(?:connect|loop\/start|login)(?:$|\/)/.test(row.path),
    ).length,
    0,
  );
  console.log(
    `商店浏览器验收 ${passed}/${passed} 通过；游戏连接0；外网请求已阻断${external.length}次；截图：${output}`,
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await screenshot("failure.png").catch(() => {});
    console.error(
      "失败页面：",
      (
        await panel()
          .textContent()
          .catch(() => "商店未挂载")
      ).slice(0, 6000),
    );
    console.error("浏览器异常：", errors);
  }
  throw error;
} finally {
  if (browserProcess && browser?.isConnected()) {
    const cdp = await browser.newBrowserCDPSession().catch(() => null);
    await cdp?.send("Browser.close").catch(() => {});
  }
  await browser?.close();
  if (browserProcess && browserProcess.exitCode === null) {
    const exited = new Promise((resolve) =>
      browserProcess.once("exit", resolve),
    );
    browserProcess.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => {
        setTimeout(resolve, 5000).unref();
      }),
    ]);
  }
  try {
    if (browserProfile) {
      assert.equal(
        path.dirname(browserProfile),
        output,
        "只清理本测试创建的独立浏览器目录",
      );
      fs.rmSync(browserProfile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  } finally {
    await h.close();
  }
}
