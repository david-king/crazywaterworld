import { Award, RefreshCw, ShieldHalf, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Badge } from "../../badge";
import { Button } from "../../button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../card";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../dialog";
import { Input } from "../../input";
import { NativeSelect } from "../../native-select";
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
const QUALITY_DOT: Record<string, string> = {
  GREEN: "bg-green-500",
  BLUE: "bg-blue-500",
  PURPLE: "bg-purple-500",
  ORANGE: "bg-orange-500",
  RED: "bg-red-500",
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
    <Badge variant="secondary" aria-label={`评级 ${letter}`}>
      {letter}
    </Badge>
  );
}

function ItemStars({ count }: { count: number }) {
  const label = `${count} 星`;
  if (count <= 0) return <span>{label}</span>;

  return (
    <span
      className="whitespace-nowrap text-(--warning)"
      role="img"
      aria-label={label}
      title={label}
    >
      {Number.isInteger(count) && count <= 5
        ? "★".repeat(count)
        : `★ × ${count}`}
    </span>
  );
}

function InventoryHeading({
  status,
  action,
}: {
  status: string;
  action?: ReactNode;
}) {
  return (
    <CardHeader>
      <CardTitle role="heading" aria-level={2}>
        装备与徽章仓库
      </CardTitle>
      <CardDescription role="status">{status}</CardDescription>
      {action && <CardAction>{action}</CardAction>}
    </CardHeader>
  );
}

function qualityLabel(quality: string) {
  return QUALITY_LABEL[quality] ? `${QUALITY_LABEL[quality]}色` : quality;
}

function ItemIcon({ row }: { row: ItemRow }) {
  if (row.icon)
    return (
      <img
        className="size-8 shrink-0 object-contain"
        alt=""
        src={row.icon}
        loading="lazy"
      />
    );
  const Icon = row.kind === "badge" ? Award : ShieldHalf;
  return (
    <Icon
      className="size-8 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}

function ItemMeta({ row }: { row: ItemRow }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {row.quality && (
        <Badge variant="outline">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${QUALITY_DOT[row.quality] ?? "bg-muted-foreground"}`}
          />
          {qualityLabel(row.quality)}
        </Badge>
      )}
      <ItemStars count={row.star} />
      <span>Lv.{row.level}</span>
      {row.wornBy && <span>已装备 · {row.wornBy}</span>}
    </div>
  );
}

function InventoryItem({
  row,
  attributeName,
  onOpen,
}: {
  row: ItemRow;
  attributeName: string;
  onOpen: () => void;
}) {
  const preview =
    (attributeName
      ? (row.attrs.find((attr) => attr.name === attributeName) ??
        row.baseAttrs.find((attr) => attr.name === attributeName))
      : row.attrs.find((attr) => attr.rating === row.rating)) ??
    row.attrs[0] ??
    row.baseAttrs[0];
  const itemId = `inventory-${row.kind}-${row.uid}`;
  return (
    <Card className="relative gap-2 p-3 max-md:gap-2">
      <div className={styles.identity}>
        <ItemIcon row={row} />
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="link"
            aria-haspopup="dialog"
            aria-describedby={
              preview ? `${itemId}-meta ${itemId}-attr` : `${itemId}-meta`
            }
            className="h-auto min-w-0 shrink whitespace-normal break-all p-0 text-left after:absolute after:inset-0"
            onClick={onOpen}
          >
            {row.name}
          </Button>
          <Grade letter={row.ratingLetter} />
        </div>
        <div id={`${itemId}-meta`} className={styles.meta}>
          <ItemMeta row={row} />
        </div>
      </div>
      {preview && (
        <div
          id={`${itemId}-attr`}
          className="mt-auto flex items-baseline justify-between gap-2 text-xs"
        >
          <span className="text-muted-foreground">{preview.name}</span>
          <span className="font-medium tabular-nums">{preview.display}</span>
        </div>
      )}
    </Card>
  );
}

function AttrList({ attrs }: { attrs: ItemAttr[] }) {
  if (!attrs.length)
    return <p className="text-sm text-muted-foreground">（无）</p>;
  return (
    <dl className="grid gap-1 text-sm">
      {attrs.map((attr) => (
        <div
          key={attr.name + attr.display}
          className="flex flex-wrap items-baseline justify-between gap-x-2"
        >
          <dt className="text-muted-foreground">{attr.name}</dt>
          <dd className="tabular-nums">
            {attr.display} <Grade letter={attr.letter} />
          </dd>
        </div>
      ))}
    </dl>
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
    <section className="grid gap-3 border-t pt-4">
      <h4 className="font-medium">自动洗炼</h4>
      <p className="text-sm text-muted-foreground">
        条件按「≥评级」判定，且不区分第几条：设 C 时出 A/S
        也算满足；多余词条随意。
      </p>
      {requirements.map((requirement, index) => (
        <div key={requirement.id} className={styles.row}>
          <NativeSelect
            aria-label={`条件 ${index + 1} 的属性`}
            value={requirement.attr}
            onChange={(event) => change(index, { attr: event.target.value })}
          >
            <option value="*">任意</option>
            {attrOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={`条件 ${index + 1} 的最低评级`}
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
          </NativeSelect>
          <Input
            aria-label={`条件 ${index + 1} 的词条数`}
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
        <label htmlFor="items-max-rolls">
          最多洗
          <Input
            id="items-max-rolls"
            className="w-16"
            type="number"
            min={1}
            max={500}
            value={maxRolls}
            onChange={(event) => setMaxRolls(Number(event.target.value))}
          />{" "}
          次
        </label>
        <label htmlFor="items-material-floor">
          材料留
          <Input
            id="items-material-floor"
            className="w-20"
            type="number"
            min={0}
            value={materialFloor}
            onChange={(event) => setMaterialFloor(Number(event.target.value))}
          />{" "}
          个
        </label>
      </div>
      {row.quality === "RED" && row.slots > 0 && (
        <div className={styles.row}>
          <span>锁定词条</span>
          {Array.from({ length: row.slots }, (_, slot) => (
            <label
              // biome-ignore lint/suspicious/noArrayIndexKey: 词条位是固定顺序的位置编号
              key={slot}
              htmlFor={`items-lock-${slot}`}
              className="inline-flex items-center gap-1.5"
            >
              <Input
                id={`items-lock-${slot}`}
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
        <span className="text-sm text-muted-foreground" role="status">
          {note}
        </span>
      </div>
      {status && (
        <div
          className="grid max-h-48 gap-1 overflow-auto text-sm"
          aria-live="polite"
        >
          <p className="text-muted-foreground">
            {status.running
              ? `运行中：第 ${status.roll}/${status.maxRolls} 次`
              : status.stopReason || "未在运行"}
          </p>
          {status.log.map((row) => (
            <div
              key={row.at + row.message}
              className="data-[level=error]:text-destructive data-[level=warn]:text-(--warning)"
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
    <dialog ref={dialog} aria-labelledby="items-reroll-title" onClose={onClose}>
      <DialogHeader>
        <DialogTitle id="items-reroll-title">
          {current.rerollable
            ? "装备洗炼"
            : current.kind === "badge"
              ? "徽章详情"
              : "装备详情"}
        </DialogTitle>
        <DialogDescription>
          {[
            current.name,
            current.kind === "badge" ? "徽章" : current.type,
            current.career,
          ]
            .filter(Boolean)
            .join(" · ")}
        </DialogDescription>
      </DialogHeader>
      <div className={styles.row}>
        <ItemIcon row={current} />
        <ItemMeta row={current} />
        <Grade letter={current.ratingLetter} />
      </div>
      <p className="text-sm text-muted-foreground">
        {[
          current.wornBy ? "" : "未装备",
          `词条位 ${current.slots}`,
          current.rerollable &&
            REROLL_MATERIALS.map((name) => `${name} ${counts[name] ?? 0}`).join(
              " · ",
            ),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-2 font-medium">
            {current.rerollable ? "当前属性" : "随机属性"}
          </h4>
          <AttrList attrs={current.attrs} />
        </div>
        <div>
          <h4 className="mb-2 font-medium">
            {current.rerollable ? "洗炼结果" : "基础属性"}
          </h4>
          <AttrList
            attrs={current.rerollable ? current.pending : current.baseAttrs}
          />
        </div>
      </div>
      {current.rerollable ? (
        <>
          {current.baseAttrs.length > 0 && (
            <details>
              <summary className="mb-2">基础属性</summary>
              <AttrList attrs={current.baseAttrs} />
            </details>
          )}
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
            <span className="text-sm text-muted-foreground" role="status">
              {busy ? `${busy}中…` : note}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
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
      ) : null}
      <DialogFooter>
        <form method="dialog">
          <Button type="submit" variant="outline">
            关闭
          </Button>
        </form>
      </DialogFooter>
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

  const target = rows.find((row) => row.kind + row.uid === detail) ?? null;
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
  const clearFilters = () => {
    setQuality("");
    setStar("");
    setMinRating(0);
    setType("");
    setCareer("");
    setAttr("");
  };
  const filtered = filterCount > 0 || kind !== "all" || Boolean(query.trim());
  return (
    <Card className="gap-3 py-4">
      <InventoryHeading
        status={
          error ||
          (loading
            ? "正在读取仓库…"
            : filtered
              ? `显示 ${shown.length} 件，共 ${rows.length} 件物品`
              : `共 ${rows.length} 件物品`)
        }
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => setReload((n) => n + 1)}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </Button>
        }
      />
      <CardContent className={styles.content}>
        <div className={styles.toolbar}>
          <fieldset className={styles.kinds} aria-label="物品分类">
            {(
              [
                ["all", "全部"],
                ["equip", "装备"],
                ["badge", "徽章"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={kind === value ? "default" : "outline"}
                size="sm"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {label}
              </Button>
            ))}
          </fieldset>
          <Input
            className={styles.search}
            type="search"
            aria-label="搜索名称或 ID"
            placeholder="名称或 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <NativeSelect
            aria-label="排序"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="button"
            variant={openFilters || filterCount ? "secondary" : "outline"}
            aria-expanded={openFilters}
            aria-controls="items-filters"
            onClick={() => setOpenFilters(!openFilters)}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            筛选
            {filterCount > 0 && <Badge variant="outline">{filterCount}</Badge>}
          </Button>
        </div>

        {openFilters && (
          <div className="grid gap-3" id="items-filters">
            <div className={styles.facets}>
              <label htmlFor="items-quality">
                品质
                <NativeSelect
                  id="items-quality"
                  aria-label="品质"
                  value={quality}
                  onChange={(event) => setQuality(event.target.value)}
                >
                  <option value="">全部</option>
                  {facets.qualities.map((value) => (
                    <option key={value} value={value}>
                      {QUALITY_LABEL[value] ?? value}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label htmlFor="items-star">
                星级
                <NativeSelect
                  id="items-star"
                  aria-label="星级"
                  value={star}
                  onChange={(event) => setStar(event.target.value)}
                >
                  <option value="">全部</option>
                  {facets.stars.map((value) => (
                    <option key={value} value={String(value)}>
                      ★{value}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label htmlFor="items-rating">
                评级
                <NativeSelect
                  id="items-rating"
                  aria-label="评级"
                  value={String(minRating)}
                  onChange={(event) => setMinRating(Number(event.target.value))}
                >
                  {RATINGS.map(([value, label]) => (
                    <option key={label} value={String(value)}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {facets.types.length > 0 && (
                <label htmlFor="items-type">
                  部位
                  <NativeSelect
                    id="items-type"
                    aria-label="部位"
                    value={type}
                    onChange={(event) => setType(event.target.value)}
                  >
                    <option value="">全部</option>
                    {facets.types.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              )}
              {facets.careers.length > 0 && (
                <label htmlFor="items-career">
                  职业
                  <NativeSelect
                    id="items-career"
                    aria-label="职业"
                    value={career}
                    onChange={(event) => setCareer(event.target.value)}
                  >
                    <option value="">全部</option>
                    {facets.careers.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!filterCount}
                onClick={clearFilters}
              >
                清空筛选
              </Button>
            </div>
            <div className={styles.row}>
              <Button
                size="sm"
                aria-pressed={attr === ""}
                variant={attr === "" ? "default" : "outline"}
                onClick={() => setAttr("")}
              >
                全部属性
              </Button>
              {facets.attrs.map((name) => (
                <Button
                  key={name}
                  size="sm"
                  aria-pressed={attr === name}
                  variant={attr === name ? "default" : "outline"}
                  onClick={() => setAttr(attr === name ? "" : name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div
          className={styles.list}
          ref={listRef}
          onScroll={onScroll}
          aria-busy={loading}
        >
          {visible.map((row) => (
            <InventoryItem
              key={row.kind + row.uid}
              row={row}
              attributeName={attr}
              onOpen={() => setDetail(row.kind + row.uid)}
            />
          ))}
          {rendered < shown.length && (
            <Button
              className="col-span-full"
              variant="outline"
              onClick={() => setRendered((n) => n + PAGE_SIZE * 2)}
            >
              显示更多（还有 {shown.length - rendered} 件）
            </Button>
          )}
          {!shown.length && !loading && !error && (
            <div className="col-span-full grid justify-items-center gap-2 py-5 text-sm text-muted-foreground">
              {rows.length ? "没有符合条件的物品" : "仓库里还没有装备或徽章"}
              {rows.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    clearFilters();
                    setQuery("");
                    setKind("all");
                  }}
                >
                  显示全部物品
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>

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
              list.map((row) =>
                row.kind === next.kind && row.uid === next.uid ? next : row,
              ),
            )
          }
          onMaterials={setMaterials}
          onRefresh={() => setReload((n) => n + 1)}
        />
      )}
    </Card>
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
    return (
      <Card className="gap-3 py-4">
        <InventoryHeading status={hint || "请先选择账号。"} />
      </Card>
    );
  return <ItemsPanel key={account} account={account} />;
}

export function mountItems(host: HTMLElement) {
  createRoot(host).render(<ItemsPage />);
}
