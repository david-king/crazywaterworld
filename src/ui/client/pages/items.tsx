import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Button } from "../../button";
import { Input } from "../../input";
import {
  type AutoStatus,
  type ItemAttr,
  type ItemRow,
  parseAutoStatus,
  parseItems,
  parseReroll,
  parseRerollDecision,
} from "../contracts/items";
import { ApiError, createAccountRequest } from "../lib/api";
import { getConsoleStore } from "../lib/console-store";
import styles from "./items.module.css";

const QUALITY_LABEL: Record<string, string> = {
  GREEN: "绿",
  BLUE: "蓝",
  PURPLE: "紫",
  ORANGE: "橙",
  RED: "红",
};
const QUALITY_COLOR: Record<string, string> = {
  GREEN: "#5b8c5a",
  BLUE: "#3f7fbf",
  PURPLE: "#8a5fbf",
  ORANGE: "#d98a2b",
  RED: "#c8483f",
};
const RATINGS = [
  [0, "不限"],
  [4, "S"],
  [3, "A"],
  [2, "B"],
  [1, "C"],
] as const;
const SORTS = [
  ["newest", "最新入库"],
  ["quality", "品质"],
  ["star", "星级"],
  ["rating", "评级"],
  ["level", "等级"],
  ["name", "名称"],
] as const;
const REROLL_MATERIALS = ["装备洗炼石", "红装备洗炼石", "锁定石"];
const PAGE_SIZE = 120;
const GRADE_CLASS: Record<string, string> = {
  S: styles.gradeS,
  A: styles.gradeA,
  B: styles.gradeB,
  C: styles.gradeC,
};

type Requirement = {
  id: number;
  attr: string;
  minRating: number;
  count: number;
};
let requirementSeq = 0;
const newRequirement = (): Requirement => ({
  id: ++requirementSeq,
  attr: "*",
  minRating: 1,
  count: 1,
});

function Grade({ letter }: { letter: string }) {
  if (!letter) return null;
  return (
    <span className={`${styles.grade} ${GRADE_CLASS[letter] ?? ""}`}>
      {letter}
    </span>
  );
}

function attrText(attr: ItemAttr) {
  return `${attr.name} ${attr.display}`;
}

// 两行摘要：随机属性优先（带评级），其次基础属性。
function summary(row: ItemRow) {
  const parts = [
    ...row.attrs.map(
      (attr) => `${attrText(attr)}${attr.letter ? ` ${attr.letter}` : ""}`,
    ),
    ...row.baseAttrs.map(attrText),
  ];
  return [parts.slice(0, 2).join(" · "), parts.slice(2, 5).join(" · ")];
}

function AttrList({ attrs }: { attrs: ItemAttr[] }) {
  if (!attrs.length) return <div className={styles.empty}>（无）</div>;
  return (
    <div className={styles.attrs}>
      {attrs.map((attr) => (
        <div key={attr.name + attr.display} className={styles.attrRow}>
          <span>{attr.name}</span>
          <span>
            {attr.display} <Grade letter={attr.letter} />
          </span>
        </div>
      ))}
    </div>
  );
}

function AutoPanel({
  row,
  api,
  attrOptions,
  onFinished,
}: {
  row: ItemRow;
  api: ReturnType<typeof createAccountRequest>;
  attrOptions: string[];
  onFinished: () => void;
}) {
  const [requirements, setRequirements] = useState<Requirement[]>([
    newRequirement(),
  ]);
  const [maxRolls, setMaxRolls] = useState(10);
  const [materialFloor, setMaterialFloor] = useState(0);
  const [lockedSlots, setLockedSlots] = useState<number[]>([]);
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [note, setNote] = useState("");
  const previous = useRef(false);

  const poll = async () => {
    try {
      const data = await api("/api/items/auto", {});
      const next = parseAutoStatus(data);
      setStatus(next);
      if (previous.current && !next.running) onFinished();
      previous.current = next.running;
    } catch {
      /* 轮询失败不影响手动操作 */
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 打开时轮询一次即可，后续由定时器驱动
  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => clearInterval(timer);
  }, []);

  const running = status?.running === true && status.uid === row.uid;
  const change = (index: number, patch: Partial<Requirement>) =>
    setRequirements((list) =>
      list.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    );

  const start = async () => {
    setNote("");
    try {
      const data = await api("/api/items/auto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: row.uid,
          requirements,
          maxRolls,
          materialFloor,
          lockedSlots,
          confirm: true,
        }),
      });
      const next = parseAutoStatus(data);
      setStatus(next);
      previous.current = next.running;
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : "启动失败");
    }
  };

  const stop = async () => {
    setNote("");
    try {
      const data = await api("/api/items/auto/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      setStatus(parseAutoStatus(data));
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : "停止失败");
    }
  };

  return (
    <section className={styles.auto}>
      <h4>自动洗炼</h4>
      <p className={styles.status}>
        条件按「≥评级」判定，且不区分第几条：设 C 时出 A/S
        也算满足；多余词条随意。
      </p>
      {requirements.map((requirement, index) => (
        <div key={requirement.id} className={styles.requirement}>
          <select
            value={requirement.attr}
            onChange={(event) => change(index, { attr: event.target.value })}
          >
            <option value="*">任意</option>
            {attrOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={String(requirement.minRating)}
            onChange={(event) =>
              change(index, { minRating: Number(event.target.value) })
            }
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={String(value)}>
                ≥{["C", "B", "A", "S"][value - 1]}
              </option>
            ))}
          </select>
          <Input
            className="w-14"
            type="number"
            min={1}
            max={4}
            value={requirement.count}
            onChange={(event) =>
              change(index, { count: Number(event.target.value) })
            }
          />
          <Button
            size="sm"
            variant="outline"
            disabled={running || requirements.length <= 1}
            onClick={() =>
              setRequirements((list) => list.filter((_, at) => at !== index))
            }
          >
            删除
          </Button>
        </div>
      ))}
      <div className={styles.row}>
        <Button
          size="sm"
          variant="outline"
          disabled={running}
          onClick={() => setRequirements((list) => [...list, newRequirement()])}
        >
          加一条需求
        </Button>
        <span className={styles.status}>
          最多洗{" "}
          <Input
            className="w-16"
            type="number"
            min={1}
            max={500}
            value={maxRolls}
            onChange={(event) => setMaxRolls(Number(event.target.value))}
          />{" "}
          次
        </span>
        <span className={styles.status}>
          材料留{" "}
          <Input
            className="w-20"
            type="number"
            min={0}
            value={materialFloor}
            onChange={(event) => setMaterialFloor(Number(event.target.value))}
          />{" "}
          个
        </span>
      </div>
      {row.quality === "RED" && row.slots > 0 && (
        <div className={styles.row}>
          <span className={styles.status}>锁定词条</span>
          {Array.from({ length: row.slots }, (_, slot) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 词条位是固定顺序的位置编号
            <label key={slot} className={styles.status}>
              <input
                type="checkbox"
                checked={lockedSlots.includes(slot)}
                disabled={running}
                onChange={(event) =>
                  setLockedSlots((list) =>
                    event.target.checked
                      ? [...list, slot].sort()
                      : list.filter((value) => value !== slot),
                  )
                }
              />{" "}
              第 {slot + 1} 条
            </label>
          ))}
        </div>
      )}
      <div className={styles.row}>
        <Button disabled={running} onClick={() => void start()}>
          开始自动洗炼
        </Button>
        <Button
          variant="outline"
          disabled={!running}
          onClick={() => void stop()}
        >
          停止
        </Button>
        <span className={styles.status}>{note}</span>
      </div>
      {status && (
        <div className={styles.autoLog} aria-live="polite">
          <p className={styles.status}>
            {status.running
              ? `运行中：第 ${status.roll}/${status.maxRolls} 次`
              : status.stopReason || "未在运行"}
          </p>
          {status.log.map((row) => (
            <div
              key={row.at + row.message}
              className={styles.autoLogLine}
              data-level={row.level}
            >
              {row.message}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RerollDialog({
  row,
  materials,
  api,
  attrOptions,
  onClose,
  onChanged,
  onMaterials,
  onRefresh,
}: {
  row: ItemRow;
  materials: Record<string, number>;
  api: ReturnType<typeof createAccountRequest>;
  attrOptions: string[];
  onClose: () => void;
  onChanged: (next: ItemRow) => void;
  onMaterials: (next: Record<string, number>) => void;
  onRefresh: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState(row);
  const [counts, setCounts] = useState(materials);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const act = async (
    path: string,
    payload: Record<string, unknown>,
    label: string,
  ) => {
    setBusy(label);
    setNote("");
    try {
      const data = await api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, confirm: true }),
      });
      const parsed = path.endsWith("reroll")
        ? parseReroll(data)
        : { equip: parseRerollDecision(data).equip, materials: null };
      setCurrent(parsed.equip);
      onChanged(parsed.equip);
      // 洗炼会扣材料：用响应里的余额直接更新，不需要手动刷新
      if (parsed.materials) {
        setCounts(parsed.materials.after);
        onMaterials(parsed.materials.after);
      }
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  const pending = current.pending.length > 0;
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="items-reroll-title"
      onClose={onClose}
    >
      <h3 id="items-reroll-title">洗炼 · {current.name}</h3>
      <p className={styles.status}>
        {[
          current.kind === "badge" ? "徽章" : current.type,
          current.career,
          QUALITY_LABEL[current.quality] ?? current.quality,
          `★${current.star}`,
          `Lv ${current.level}`,
          current.wornBy ? `已装备：${current.wornBy}` : "未装备",
          `词条位 ${current.slots}`,
          REROLL_MATERIALS.map((name) => `${name} ${counts[name] ?? 0}`).join(
            " · ",
          ),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className={styles.columns}>
        <div>
          <h4>当前属性</h4>
          <AttrList attrs={current.attrs} />
        </div>
        <div>
          <h4>洗炼结果</h4>
          <AttrList attrs={current.pending} />
        </div>
      </div>
      {current.rerollable ? (
        <>
          <div className={styles.row}>
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() =>
                void act("/api/items/reroll", { uid: current.uid }, "洗炼")
              }
            >
              洗炼一次
            </Button>
            <Button
              disabled={!pending || Boolean(busy)}
              onClick={() =>
                void act(
                  "/api/items/decide",
                  { uid: current.uid, save: true },
                  "保存",
                )
              }
            >
              保存
            </Button>
            <Button
              variant="outline"
              disabled={!pending || Boolean(busy)}
              onClick={() =>
                void act(
                  "/api/items/decide",
                  { uid: current.uid, save: false },
                  "放弃",
                )
              }
            >
              放弃
            </Button>
            <span className={styles.status}>{busy ? `${busy}中…` : note}</span>
          </div>
          <p className={styles.status}>
            洗炼每次消耗 10
            个洗炼石，放弃会保留原属性但材料不退；保存只在结果满足需求时使用。
          </p>
          <AutoPanel
            row={current}
            api={api}
            attrOptions={attrOptions}
            onFinished={onRefresh}
          />
        </>
      ) : (
        <p className={styles.status}>
          这件装备没有洗炼功能（只有橙装和红装能洗炼）。
        </p>
      )}
      <form method="dialog">
        <Button type="submit">关闭</Button>
      </form>
    </dialog>
  );
}

function ItemsPanel({ account }: { account: string }) {
  const api = useMemo(() => createAccountRequest(account), [account]);
  const [rows, setRows] = useState<ItemRow[]>([]);
  const [materials, setMaterials] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<"all" | "equip" | "badge">("all");
  const [quality, setQuality] = useState("");
  const [star, setStar] = useState("");
  const [minRating, setMinRating] = useState(0);
  const [type, setType] = useState("");
  const [career, setCareer] = useState("");
  const [attr, setAttr] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>("newest");
  const [openFilters, setOpenFilters] = useState(false);
  const [detail, setDetail] = useState<string>("");
  const [rendered, setRendered] = useState(PAGE_SIZE);
  const [reload, setReload] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 账号变化由外层 key 重挂载，这里只跟随手动刷新
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const data = await api("/api/items", { signal: controller.signal });
        if (controller.signal.aborted) return;
        const parsed = parseItems(data);
        setRows(parsed.rows);
        setMaterials(parsed.materials);
        setRendered(PAGE_SIZE);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof ApiError ? caught.message : "读取装备失败");
        setRows([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api, reload]);

  const facets = useMemo(() => {
    const collect = (pick: (row: ItemRow) => string) =>
      [...new Set(rows.map(pick).filter(Boolean))].sort();
    const attrs = new Map<string, number>();
    for (const row of rows) {
      for (const item of [...row.attrs, ...row.baseAttrs])
        attrs.set(item.name, (attrs.get(item.name) ?? 0) + 1);
    }
    return {
      qualities: collect((row) => row.quality),
      types: collect((row) => (row.kind === "badge" ? "" : row.type)),
      careers: collect((row) => row.career),
      stars: [...new Set(rows.map((row) => row.star))].sort((a, b) => b - a),
      attrs: [...attrs.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name),
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (kind !== "all" && row.kind !== kind) return false;
      if (quality && row.quality !== quality) return false;
      if (star !== "" && String(row.star) !== star) return false;
      if (minRating && row.rating < minRating) return false;
      if (type && row.type !== type) return false;
      if (career && row.career !== career) return false;
      if (
        attr &&
        ![...row.attrs, ...row.baseAttrs].some((item) => item.name === attr)
      )
        return false;
      if (
        needle &&
        !(row.name + row.id + row.uid + row.wornBy)
          .toLowerCase()
          .includes(needle)
      )
        return false;
      return true;
    });
    const compare: Record<string, (a: ItemRow, b: ItemRow) => number> = {
      newest: (a, b) => b.firstSeen - a.firstSeen || b.star - a.star,
      quality: (a, b) => b.qualityIndex - a.qualityIndex || b.star - a.star,
      star: (a, b) => b.star - a.star || b.qualityIndex - a.qualityIndex,
      rating: (a, b) => b.rating - a.rating || b.star - a.star,
      level: (a, b) => b.level - a.level || b.star - a.star,
      name: (a, b) => a.name.localeCompare(b.name, "zh-CN"),
    };
    return [...filtered].sort(compare[sort]);
  }, [rows, kind, quality, star, minRating, type, career, attr, query, sort]);

  const target = rows.find((row) => row.uid === detail) ?? null;
  const filterCount = [
    quality,
    star,
    minRating ? String(minRating) : "",
    type,
    career,
    attr,
  ].filter(Boolean).length;

  const onScroll = () => {
    const node = listRef.current;
    if (!node) return;
    if (node.scrollTop + node.clientHeight < node.scrollHeight - 240) return;
    if (rendered >= shown.length) return;
    setRendered((count) => count + PAGE_SIZE);
  };

  const visible = shown.slice(0, rendered);
  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <div className={styles.kinds}>
          {(
            [
              ["all", "全部"],
              ["equip", "装备"],
              ["badge", "徽章"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={kind === value ? "default" : "outline"}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Input
          className="max-w-40"
          placeholder="搜索名称 / ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className={styles.status}>
          排序{" "}
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          aria-expanded={openFilters}
          onClick={() => setOpenFilters(!openFilters)}
        >
          筛选{filterCount ? `（${filterCount}）` : ""}
        </Button>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setReload((n) => n + 1)}
        >
          刷新
        </Button>
      </div>

      {openFilters && (
        <div className={styles.filters}>
          <div className={styles.row}>
            <label>
              品质{" "}
              <select
                value={quality}
                onChange={(event) => setQuality(event.target.value)}
              >
                <option value="">全部</option>
                {facets.qualities.map((value) => (
                  <option key={value} value={value}>
                    {QUALITY_LABEL[value] ?? value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              星级{" "}
              <select
                value={star}
                onChange={(event) => setStar(event.target.value)}
              >
                <option value="">全部</option>
                {facets.stars.map((value) => (
                  <option key={value} value={String(value)}>
                    ★{value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              评级{" "}
              <select
                value={String(minRating)}
                onChange={(event) => setMinRating(Number(event.target.value))}
              >
                {RATINGS.map(([value, label]) => (
                  <option key={label} value={String(value)}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.row}>
            {facets.types.length > 0 && (
              <label>
                部位{" "}
                <select
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                >
                  <option value="">全部</option>
                  {facets.types.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {facets.careers.length > 0 && (
              <label>
                职业{" "}
                <select
                  value={career}
                  onChange={(event) => setCareer(event.target.value)}
                >
                  <option value="">全部</option>
                  {facets.careers.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setQuality("");
                setStar("");
                setMinRating(0);
                setType("");
                setCareer("");
                setAttr("");
              }}
            >
              清空
            </Button>
          </div>
          <div className={styles.chips}>
            <Button
              size="sm"
              variant={attr === "" ? "default" : "outline"}
              onClick={() => setAttr("")}
            >
              全部属性
            </Button>
            {facets.attrs.map((name) => (
              <Button
                key={name}
                size="sm"
                variant={attr === name ? "default" : "outline"}
                onClick={() => setAttr(attr === name ? "" : name)}
              >
                {name}
              </Button>
            ))}
          </div>
        </div>
      )}

      <p className={styles.status}>
        {error ||
          `共 ${rows.length} 件 · 显示 ${shown.length}${loading ? " · 读取中…" : ""}`}
      </p>

      <div className={styles.list} ref={listRef} onScroll={onScroll}>
        {visible.map((row) => {
          const [first, second] = summary(row);
          return (
            <button
              key={row.kind + row.uid}
              type="button"
              className={styles.item}
              onClick={() => setDetail(row.uid)}
            >
              <span
                className={styles.tile}
                style={{ background: QUALITY_COLOR[row.quality] ?? "#7a7a7a" }}
              >
                {row.icon ? (
                  <img alt="" src={row.icon} />
                ) : row.kind === "badge" ? (
                  (row.career || "徽").slice(0, 1)
                ) : (
                  row.type.slice(0, 1)
                )}
              </span>
              <span className={styles.main}>
                <span
                  className={styles.title}
                  style={{ color: QUALITY_COLOR[row.quality] }}
                >
                  {row.name}
                </span>
                <span className={styles.sub}>
                  {[
                    row.kind === "badge" ? "徽章" : row.type,
                    row.career,
                    QUALITY_LABEL[row.quality] ?? row.quality,
                    `Lv${row.level}`,
                    row.wornBy ? `已装备：${row.wornBy}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {first && <span className={styles.line}>{first}</span>}
                {second && <span className={styles.line}>{second}</span>}
              </span>
              <span className={styles.side}>
                <span className={styles.stars}>
                  {row.star > 0 ? "★".repeat(row.star) : ""}
                </span>
                <Grade letter={row.ratingLetter} />
              </span>
            </button>
          );
        })}
        {rendered < shown.length && (
          <Button
            variant="outline"
            onClick={() => setRendered((n) => n + PAGE_SIZE * 2)}
          >
            显示更多（还有 {shown.length - rendered} 件）
          </Button>
        )}
        {!shown.length && !loading && (
          <p className={styles.empty}>
            {rows.length
              ? "没有符合筛选条件的装备。"
              : "连接当前账号后可读取装备。"}
          </p>
        )}
      </div>

      {target && (
        <RerollDialog
          key={target.uid + target.pending.length}
          row={target}
          materials={materials}
          api={api}
          attrOptions={facets.attrs}
          onClose={() => setDetail("")}
          onChanged={(next) =>
            setRows((list) =>
              list.map((row) => (row.uid === next.uid ? next : row)),
            )
          }
          onMaterials={setMaterials}
          onRefresh={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}

function ItemsPage() {
  const store = getConsoleStore();
  const active = useStore(store, (state) => state.view.page === "items");
  const account = useStore(store, (state) => state.currentAccountId);
  const hint = useStore(store, (state) => {
    const id = state.currentAccountId;
    if (!id) return "请先选择账号。";
    const status = state.accountsById[id]?.status;
    if (status?.paused) return "账号已暂停，恢复托管后可查看装备。";
    if (status?.reconnecting) return "账号正在重连…";
    return status?.connected && !state.disconnected.has(id)
      ? ""
      : "连接当前账号后可查看装备。";
  });
  if (!active) return null;
  if (!account || hint)
    return <p className={styles.empty}>{hint || "请先选择账号。"}</p>;
  return <ItemsPanel key={account} account={account} />;
}

export function mountItems(host: HTMLElement) {
  createRoot(host).render(<ItemsPage />);
}
