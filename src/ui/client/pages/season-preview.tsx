import {
  Activity,
  Flag,
  Inbox,
  Medal,
  RefreshCw,
  Shield,
  Trophy,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Badge } from "../../badge";
import { Button } from "../../button";
import { Card } from "../../card";
import { Switch } from "../../switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../table";
import {
  type GuildRank,
  type Mail,
  parseSeasonPreview,
  type Ranking,
  type Section,
} from "../contracts/season-preview";
import { createAccountRequest } from "../lib/api";
import { getConsoleStore } from "../lib/console-store";
import { formatGameTime } from "../lib/time";
import { SeasonMeritSettings } from "./season-merit-settings";
import styles from "./season-preview.module.css";

const labels = { merit: "功勋榜", tech: "科技榜", mail: "邮件物品" } as const;
const boardNames = { merit: "最强个人", tech: "科技霸主" } as const;
const sections: Section[] = ["merit", "tech", "mail"];
const numberText = (n: string | null) =>
  n === null ? "未返回" : BigInt(n).toLocaleString("zh-CN");
const timeText = (seconds: number) => formatGameTime(seconds * 1000);

function BoardView({ board }: { board: Ranking }) {
  return (
    <>
      <div className={styles.heading}>
        <h3>{boardNames[board.kind]}</h3>
        <span>
          {board.rows.length ? `前 ${board.rows.length} 名` : "暂无名次"}
        </span>
      </div>
      {board.rows.length ? (
        <Table
          aria-label={`${boardNames[board.kind]} · ${labels[board.kind]}`}
          className={styles.board}
        >
          <TableHeader>
            <TableRow>
              <TableHead>名次</TableHead>
              <TableHead>玩家</TableHead>
              <TableHead>
                {board.kind === "merit" ? "功勋积分" : "科技积分"}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.rows.map((row) => {
              const own =
                !!row.playerId && row.playerId === board.mine?.playerId;
              return (
                <TableRow key={row.rank} data-own={own || undefined}>
                  <TableCell>
                    <span
                      className={styles.place}
                      data-top={row.rank <= 3 || undefined}
                    >
                      {row.rank}
                    </span>
                  </TableCell>
                  <TableCell>
                    {row.name}
                    {own && (
                      <Badge className="ml-2" variant="outline">
                        我
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{numberText(row.score)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className={styles.notice}>当前赛季榜单暂无玩家记录</p>
      )}
    </>
  );
}

function MailView({ mail }: { mail: Mail }) {
  const [all, setAll] = useState(false);
  const items = mail.items.filter((item) => all || item.pending !== "0");
  return (
    <>
      <div className={styles.heading}>
        <div>
          <h3>邮件物品</h3>
          <p>未领取功勋 {numberText(mail.merit.pending)}</p>
        </div>
        <label className={styles.filter} htmlFor="season-show-claimed">
          包含已领取附件
          <Switch
            id="season-show-claimed"
            checked={all}
            onCheckedChange={setAll}
          />
        </label>
      </div>
      {items.length ? (
        <div className={styles.attachments}>
          {items.map((item) => (
            <details key={item.key}>
              <summary>
                <strong>{item.name}</strong>
                <span className={styles.totals}>
                  未领 {numberText(item.pending)}
                  {all && <small>已领 {numberText(item.claimed)}</small>}
                </span>
              </summary>
              <ul>
                {item.sources
                  .filter((s) => all || !s.claimed)
                  .map((s) => (
                    <li key={`${s.kind}:${s.id}`}>
                      <div>
                        <span>{s.subject}</span>
                        <small>
                          {s.kind === "report" ? "战报" : "系统邮件"}
                          {s.sendTime ? ` · ${timeText(s.sendTime)}` : ""}
                        </small>
                      </div>
                      <span>
                        {s.claimed ? "已领" : "未领"} {numberText(s.count)}
                      </span>
                    </li>
                  ))}
              </ul>
            </details>
          ))}
        </div>
      ) : (
        <p className={styles.notice}>
          {all ? "邮箱中没有留存的附件" : "当前没有未领取的邮件物品"}
        </p>
      )}
    </>
  );
}

type Snapshot = {
  merit?: Ranking;
  tech?: Ranking;
  guild?: GuildRank;
  mail?: Mail;
};
type Errors = Partial<Record<keyof Snapshot, string>>;
const paths = {
  merit: "/api/season/rank?kind=merit",
  tech: "/api/season/rank?kind=tech",
  guild: "/api/season/guild",
  mail: "/api/season/mail",
};

function Stat({
  label,
  icon: Icon,
  value,
  detail,
}: {
  label: string;
  icon: typeof Trophy;
  value: string;
  detail?: string;
}) {
  return (
    <div className={styles.stat}>
      <dt>
        <Icon size={15} aria-hidden="true" />
        {label}
      </dt>
      <dd>{value}</dd>
      {detail && <dd className={styles.statDetail}>{detail}</dd>}
    </div>
  );
}

function MySeason({ data, errors }: { data: Snapshot; errors: Errors }) {
  const unavailable = (key: keyof Snapshot) =>
    errors[key] ? "读取失败" : "读取中…";
  const { guild, mail } = data;
  const dates = data.merit ?? data.tech;
  return (
    <section aria-label="我的赛季">
      <Card className={styles.summary}>
        <h3>我的赛季</h3>
        <dl className={styles.stats}>
          {(["merit", "tech"] as const).map((key) => {
            const row = data[key]?.mine;
            return (
              <Stat
                key={key}
                icon={key === "merit" ? Medal : Activity}
                label={key === "merit" ? "功勋排名" : "科技排名"}
                value={
                  row
                    ? `第 ${row.rank} 名`
                    : data[key]
                      ? "暂无名次"
                      : unavailable(key)
                }
                detail={
                  row?.score != null
                    ? `${numberText(row.score)} 积分`
                    : errors[key]
                }
              />
            );
          })}
          <Stat
            icon={Shield}
            label="联盟排名"
            value={
              guild?.rank
                ? `第 ${guild.rank} 名`
                : guild?.state === "notJoined"
                  ? "未加入联盟"
                  : guild
                    ? "暂无名次"
                    : unavailable("guild")
            }
            detail={
              guild?.score != null
                ? `${numberText(guild.score)} 积分`
                : errors.guild
            }
          />
          <Stat
            icon={Inbox}
            label="邮件功勋"
            value={
              mail
                ? `未领 ${numberText(mail.merit.pending)}`
                : unavailable("mail")
            }
            detail={errors.mail}
          />
        </dl>
        {dates?.midEndTime || dates?.endTime ? (
          <dl className={styles.dates}>
            {(
              [
                ["中期结算", dates.midEndTime],
                ["赛季结束", dates.endTime],
              ] as const
            ).map(
              ([name, t]) =>
                t && (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>
                      <time
                        dateTime={new Date(t * 1000).toISOString()}
                        title={timeText(t)}
                      >
                        {timeText(t).slice(0, 16)}
                      </time>
                    </dd>
                  </div>
                ),
            )}
          </dl>
        ) : null}
      </Card>
    </section>
  );
}

function Preview({ account }: { account: string }) {
  const [section, setSection] = useState<Section>("merit");
  const [batch, setBatch] = useState<{ first: Section }>({ first: "merit" });
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const request = createAccountRequest(account);
    async function read() {
      const keys = new Set<keyof Snapshot>([
        batch.first,
        "merit",
        "tech",
        "guild",
        "mail",
      ]);
      for (const key of keys) {
        if (signal.aborted) return;
        try {
          const value = parseSeasonPreview(
            await request(paths[key], { signal }),
            key,
          );
          if (!signal.aborted)
            setSnapshot((prev) => ({ ...prev, [value.kind]: value }));
        } catch (e) {
          if (!signal.aborted) {
            setSnapshot((prev) => ({ ...prev, [key]: undefined }));
            setErrors((prev) => ({
              ...prev,
              [key]: e instanceof Error ? e.message : "读取失败",
            }));
          }
        }
      }
      if (!signal.aborted) setLoading(false);
    }
    void read();
    return () => controller.abort();
  }, [account, batch]);
  function refresh() {
    setLoading(true);
    setErrors({});
    setBatch({ first: section });
  }
  const data = snapshot[section];
  const season =
    data?.season ?? Object.values(snapshot).find((v) => v?.season)?.season;
  return (
    <div className={styles.page}>
      <div className={styles.titlebar}>
        <div>
          <h2>赛季预览</h2>
          {season ? (
            <Badge variant="secondary">
              <Flag size={12} aria-hidden="true" /> S{season} 赛季
            </Badge>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {loading ? "读取中…" : "刷新"}
        </Button>
      </div>
      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <MySeason data={snapshot} errors={errors} />
          <SeasonMeritSettings account={account} />
        </div>
        <Card className={styles.content}>
          <fieldset aria-label="赛季预览内容" className={styles.segments}>
            {sections.map((key) => (
              <Button
                key={key}
                size="sm"
                variant="ghost"
                aria-pressed={section === key}
                onClick={() => setSection(key)}
              >
                {labels[key]}
              </Button>
            ))}
          </fieldset>
          {!data && !errors[section] && (
            <p role="status" className={styles.notice}>
              正在读取{labels[section]}…
            </p>
          )}
          {errors[section] && (
            <p role="alert" className={styles.notice}>
              {errors[section]}
            </p>
          )}
          {data?.season === null && (
            <p className={styles.notice}>当前世界的赛季编号未同步</p>
          )}
          {data &&
            (data.kind === "mail" ? (
              <MailView mail={data} />
            ) : (
              <BoardView board={data} />
            ))}
        </Card>
      </div>
    </div>
  );
}

function SeasonPage() {
  const store = getConsoleStore();
  const active = useStore(store, (s) => s.view.page === "season-preview");
  const account = useStore(store, (s) => s.currentAccountId);
  const connected = useStore(store, (s) => {
    const id = s.currentAccountId;
    const status = id ? s.accountsById[id]?.status : undefined;
    return !!(
      id &&
      status?.connected &&
      !status.paused &&
      !s.disconnected.has(id)
    );
  });
  if (!active) return null;
  if (!account || !connected)
    return (
      <div className={styles.page}>
        <div className={styles.titlebar}>
          <h2>赛季预览</h2>
        </div>
        <Card className={styles.disconnected}>
          <Trophy size={26} aria-hidden="true" />
          <p>请先连接当前账号</p>
        </Card>
        {account && <SeasonMeritSettings key={account} account={account} />}
      </div>
    );
  return <Preview key={account} account={account} />;
}
export function mountSeasonPreview(host: HTMLElement) {
  createRoot(host).render(<SeasonPage />);
}
