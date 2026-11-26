import { Gift, House, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Badge } from "../../badge";
import { Button } from "../../button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../card";
import {
  type HomelandAction,
  type HomelandView,
  parseHomeland,
  parseHomelandOutcome,
} from "../contracts/homeland";
import { createAccountRequest } from "../lib/api";
import { type ConsoleState, getConsoleStore } from "../lib/console-store";
import styles from "./homeland.module.css";

const pending = new Map<string, Promise<string>>();
function synthesisText(plan: HomelandView["orders"][number]["synthesis"]) {
  if (!plan) return "";
  if (plan.reason) return plan.reason;
  if (!plan.steps) return "";
  const parts = [
    plan.merges ? `合成 ${plan.merges} 次` : "",
    plan.takes ? `取出 ${plan.takes} 次` : "",
    plan.stores ? `暂存 ${plan.stores} 次` : "",
  ].filter(Boolean);
  return `${plan.status === "optimal" ? "备料最少" : "可行方案"} ${plan.steps} 步：${parts.join("、")}。${plan.status === "feasible" ? "尚未证明步数最少。" : ""}`;
}
function connectionHint(state: ConsoleState) {
  const id = state.currentAccountId;
  if (!id) return "请先选择账号";
  const status = state.accountsById[id]?.status;
  if (status?.paused) return "账号已暂停，请先恢复托管";
  if (status?.reconnecting) return "账号正在重连";
  if (!status?.connected || status.loginBlocked || state.disconnected.has(id))
    return "请先连接当前账号";
  return "";
}

function Homeland({ account }: { account: string }) {
  const [view, setView] = useState<ReturnType<typeof parseHomeland> | null>(
    null,
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and completed writes need a new survey.
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const previous = pending.get(account);
        if (previous) {
          const message = await previous.catch(() => "前次操作结果待核对");
          if (!controller.signal.aborted) setNotice(message);
        }
        controller.signal.throwIfAborted();
        const response = await createAccountRequest(account)("/api/homeland", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setView(parseHomeland(response));
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setView(null);
          setError(error instanceof Error ? error.message : "读取家园失败");
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [account, revision]);
  const refresh = () => {
    setBusy(true);
    setRevision((value) => value + 1);
  };
  async function execute(action: HomelandAction) {
    const state = getConsoleStore().getState();
    if (
      busy ||
      pending.has(account) ||
      action.reason ||
      state.currentAccountId !== account ||
      state.view.page !== "homeland" ||
      connectionHint(state)
    )
      return;
    if (
      action.coinCost &&
      !window.confirm(
        `${action.detail}\n消耗 ${action.coinCost} 家园币，计入今日家园币预算。确认执行？`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice(`正在执行：${action.detail}`);
    const job = createAccountRequest(account)("/api/homeland/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: action.id,
        token: action.token,
        confirm: true,
      }),
    }).then(parseHomelandOutcome);
    pending.set(account, job);
    try {
      const message = await job;
      if (alive.current) setNotice(message);
    } catch (error) {
      if (alive.current)
        setNotice(
          error instanceof Error ? error.message : "操作结果待确认，请刷新核对",
        );
    } finally {
      pending.delete(account);
      if (alive.current) refresh();
    }
  }
  const actionButton = (action: HomelandAction | undefined, label?: string) =>
    action && (
      <div className={styles.action} key={action.id}>
        <Button
          size="sm"
          variant={
            action.kind === "upgrade" || action.kind === "tech"
              ? "default"
              : "outline"
          }
          disabled={busy || !!action.reason}
          onClick={() => void execute(action)}
        >
          {label || action.title}
          {action.coinCost ? ` · ${action.coinCost} 币` : ""}
        </Button>
        {action.reason && <small>{action.reason}</small>}
      </div>
    );
  const data = view?.available ? view : null;
  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <div>
          <h2>家园</h2>
          <p>照料家园，安排工坊日常。</p>
        </div>
        <Button variant="outline" disabled={busy} onClick={refresh}>
          <RefreshCw aria-hidden="true" />
          {busy ? "正在读取…" : "刷新家园"}
        </Button>
      </div>
      <div className={styles.notice} role="status" aria-live="polite">
        {notice}
      </div>
      {error && <p role="alert">{error}</p>}
      {view && !view.available && (
        <Card>
          <CardContent>{view.reason}</CardContent>
        </Card>
      )}
      {data && (
        <>
          {data.pending.length > 0 && (
            <p role="alert">
              前次操作待确认：{data.pending.join("、")}
              。刷新后会重新核对，确认前暂停后续家园操作。
            </p>
          )}
          <Card className="gap-0 py-0 max-md:py-0">
            <CardContent className={styles.overview}>
              <div className={styles.homeIdentity}>
                <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                  <House
                    className="size-7"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </span>
                <div>
                  <div className={styles.homeName}>
                    <h3>{data.name}</h3>
                    <Badge variant="secondary">家园 {data.level} 级</Badge>
                  </div>
                  <p className={styles.help}>
                    已开放 {data.floor} 层<span aria-hidden="true"> · </span>
                    家具 {data.placed} / {data.capacity}
                  </p>
                </div>
              </div>
            </CardContent>
            <CardContent>
              <dl className={styles.metrics}>
                <div>
                  <dt>家园币余额</dt>
                  <dd>{data.coins.toLocaleString()}</dd>
                  <small>保留 {data.budget.keep.toLocaleString()}</small>
                </div>
                <div>
                  <dt>累计消费</dt>
                  <dd>{data.spent.toLocaleString()}</dd>
                  <small>家具购买与科技</small>
                </div>
                <div>
                  <dt>今日家园币用量</dt>
                  <dd>
                    {data.budget.used.toLocaleString()}{" "}
                    <span>/ {data.budget.limit.toLocaleString()}</span>
                  </dd>
                  <small>包含打扫与科技</small>
                </div>
                <div>
                  <dt>工坊体力</dt>
                  <dd>{data.stamina.toLocaleString()}</dd>
                  <small>用于游戏内生产</small>
                </div>
              </dl>
            </CardContent>
          </Card>

          <section
            className={styles.section}
            aria-labelledby="homeland-growth-title"
          >
            <div className={styles.sectionHeading}>
              <div>
                <h3 id="homeland-growth-title">家园成长</h3>
                <p>查看下一步的升级条件。</p>
              </div>
            </div>
            <div className={styles.columns}>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h4>
                      {data.nextLevel
                        ? `升至 ${data.nextLevel} 级`
                        : "家园已满级"}
                    </h4>
                  </CardTitle>
                  <CardDescription>
                    {data.nextLevel
                      ? `${data.conditions.filter((row) => row.met).length} / ${data.conditions.length} 项条件已达标`
                      : "当前家园等级已达到上限。"}
                  </CardDescription>
                </CardHeader>
                <CardContent className={styles.stack}>
                  <div className={styles.conditions}>
                    {data.conditions.map((row) => (
                      <div key={row.label} className={styles.condition}>
                        <span>{row.label}</span>
                        <div className={styles.conditionValue}>
                          <span>
                            {row.have.toLocaleString()}{" "}
                            <span className={styles.secondary}>
                              / {row.need.toLocaleString()}
                            </span>
                          </span>
                          <Badge variant={row.met ? "secondary" : "outline"}>
                            {row.met ? "已达标" : "未达标"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  {data.level === 1 && data.spent < 100 && (
                    <p className={styles.help}>
                      科技从家园 2 级开放。请先在游戏购买家具，累计消费达到 100
                      家园币。
                    </p>
                  )}
                  {actionButton(
                    data.actions.find((row) => row.kind === "upgrade"),
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h4>家园科技 · {data.techLevel} 级</h4>
                  </CardTitle>
                  <CardDescription>按顺序解锁，属性永久保留。</CardDescription>
                </CardHeader>
                <CardContent className={styles.stack}>
                  {data.tech ? (
                    <>
                      <div className={styles.techSummary}>
                        <span className={styles.help}>下一项科技</span>
                        <strong>{data.tech.name}</strong>
                        <p>{data.tech.attribute}</p>
                      </div>
                      <p className={styles.help}>
                        需要家园 {data.tech.requirement} 级，消耗{" "}
                        {data.tech.cost} 家园币。
                      </p>
                      {actionButton(
                        data.actions.find((row) => row.kind === "tech"),
                      )}
                    </>
                  ) : (
                    <p>当前科技已全部完成。</p>
                  )}
                </CardContent>
              </Card>
            </div>
            <p className={styles.footnote}>
              累计消费在升级后保留，打扫费用不计入升级条件。
            </p>
          </section>

          <section
            className={styles.section}
            aria-labelledby="homeland-workshop-title"
          >
            <div className={styles.sectionHeading}>
              <div>
                <h3 id="homeland-workshop-title">工坊</h3>
                <p>领取每日补给，按订单合成与交单。</p>
              </div>
              <Badge variant="outline">
                {data.orders.filter((row) => row.ready).length} /{" "}
                {data.orders.length} 单可提交
              </Badge>
            </div>
            <Card>
              <CardContent className={styles.daily}>
                <div className={styles.dailyLabel}>
                  <Gift
                    className="size-5 shrink-0 text-muted-foreground"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <div>
                    <h4>每日补给</h4>
                    <p className={styles.help}>
                      每日免费体力：
                      {data.freeStaminaClaimed ? "已领取" : "可领取"}
                    </p>
                  </div>
                </div>
                <div className={styles.inlineActions}>
                  {data.actions
                    .filter(
                      (row) =>
                        row.kind === "freeStamina" || row.kind === "freeBox",
                    )
                    .map((row) => actionButton(row))}
                </div>
              </CardContent>
            </Card>
            <Card className="gap-0 py-0 max-md:py-0">
              <CardContent className={styles.orders}>
                {!data.orders.length && (
                  <p className={styles.empty}>
                    当前没有工坊订单，稍后刷新查看。
                  </p>
                )}
                {data.orders.map((order) => {
                  const action = data.actions.find(
                    (row) =>
                      row.kind === "submitOrders" &&
                      row.orderSlot === order.slot,
                  );
                  return (
                    <div key={order.slot} className={styles.order}>
                      <div className={styles.orderInfo}>
                        <div className={styles.orderHeading}>
                          <h4>订单 {order.slot + 1}</h4>
                          <Badge
                            variant={order.ready ? "secondary" : "outline"}
                          >
                            {order.limited
                              ? "限时订单"
                              : order.ready
                                ? "物品齐备"
                                : "等待物品"}
                          </Badge>
                        </div>
                        <ul>
                          {order.requirements.map((item) => (
                            <li key={item.id}>
                              <span>
                                {item.name} ×{item.num}
                              </span>
                              <small>
                                棋盘 {item.board} · 仓库 {item.warehouse}
                              </small>
                            </li>
                          ))}
                        </ul>
                        {synthesisText(order.synthesis) && (
                          <p className={styles.help}>
                            {synthesisText(order.synthesis)}
                          </p>
                        )}
                      </div>
                      <div className={styles.orderActions}>
                        {actionButton(action, "提交订单")}
                        {data.actions
                          .filter(
                            (row) =>
                              [
                                "takeWarehouse",
                                "mergeOrders",
                                "warehouseBuffer",
                              ].includes(row.kind) &&
                              row.orderSlot === order.slot,
                          )
                          .map((row) => actionButton(row, row.detail))}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
            <p className={styles.footnote}>
              工坊仓库 {data.warehouse.used} /{" "}
              {data.warehouse.capacity ?? "容量待同步"}。
              宝箱领取后进入游戏工坊奖励区。暂存物品按后续订单需要取回。
              备料步数按当前订单、仓库权限与成品保留规则计算。
            </p>
          </section>

          <section
            className={styles.section}
            aria-labelledby="homeland-floors-title"
          >
            <div className={styles.sectionHeading}>
              <div>
                <h3 id="homeland-floors-title">楼层与打扫</h3>
                <p>查看各层的开放条件与打扫进度。</p>
              </div>
            </div>
            <Card className="gap-0 py-0 max-md:py-0">
              <CardContent className={styles.floors}>
                {[...data.floors].reverse().map((floor) => (
                  <details
                    key={floor.floor}
                    className={styles.floor}
                    open={floor.unlocked}
                  >
                    <summary className={styles.floorSummary}>
                      <span className={styles.floorNumber}>{floor.floor}F</span>
                      <span className={styles.floorLabel}>
                        <span>
                          {floor.unlocked
                            ? "已开放"
                            : `家园 ${floor.unlockLevel} 级开放`}
                        </span>
                        <small>
                          已打扫{" "}
                          {floor.tasks.filter((task) => task.done).length} /{" "}
                          {floor.tasks.length}
                        </small>
                      </span>
                    </summary>
                    <div className={styles.floorContent}>
                      {actionButton(
                        data.actions.find(
                          (row) => row.id === `unlockFloors:${floor.floor}`,
                        ),
                        "开放楼层",
                      )}
                      <div className={styles.cleanTasks}>
                        {floor.tasks.map((task) => (
                          <div key={task.id} className={styles.cleanTask}>
                            <div className={styles.taskInfo}>
                              <span>打扫任务 {task.id}</span>
                              <small>
                                奖励：
                                {task.rewards
                                  .map((item) => `${item.name} ×${item.num}`)
                                  .join("、") || "无"}
                              </small>
                            </div>
                            {task.done ? (
                              <Badge variant="secondary">已完成</Badge>
                            ) : (
                              actionButton(
                                data.actions.find(
                                  (row) => row.id === `clean:${task.id}`,
                                ),
                                "打扫",
                              )
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                ))}
              </CardContent>
            </Card>
            <p className={styles.footnote}>
              打扫消耗家园币，每次操作前会确认费用。
            </p>
          </section>
          <footer className={styles.footer}>
            自动执行在「挂机配置 → 基地 →
            家园」设置。手动与自动操作共用家园币预算。
          </footer>
        </>
      )}
    </div>
  );
}
function HomelandPage() {
  const store = getConsoleStore();
  const active = useStore(store, (state) => state.view.page === "homeland");
  const account = useStore(store, (state) => state.currentAccountId);
  const hint = useStore(store, connectionHint);
  if (!active) return null;
  if (!account || hint)
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>家园</h2>
          </CardTitle>
          <CardDescription>{hint}</CardDescription>
        </CardHeader>
      </Card>
    );
  return <Homeland key={account} account={account} />;
}
export function mountHomeland(host: HTMLElement) {
  createRoot(host).render(<HomelandPage />);
}
