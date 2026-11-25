import { isRecord } from "./login-settings";

export type Board = "merit" | "tech";
export type Section = Board | "mail";
export type RankRow = {
  rank: number;
  playerId: string | null;
  name: string;
  score: string | null;
};
type Source = {
  kind: "system" | "report";
  id: string;
  subject: string;
  sendTime: number | null;
  claimed: boolean;
  count: string;
};
type MailItem = {
  key: string;
  id: string;
  name: string;
  pending: string;
  claimed: string;
  sources: Source[];
};
export type Ranking = {
  kind: Board;
  season: number | null;
  rows: RankRow[];
  mine: RankRow | null;
  midEndTime: number | null;
  endTime: number | null;
};
export type Mail = {
  kind: "mail";
  merit: { pending: string; claimed: string };
  season: number | null;
  scanned: number;
  reportsScanned: number;
  items: MailItem[];
};
export type GuildRank = {
  kind: "guild";
  season: number | null;
  state: "ranked" | "unranked" | "notJoined";
  rank: number | null;
  score: string | null;
};

const decimal = (v: unknown): v is string =>
  typeof v === "string" && /^\d+$/.test(v);
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const optionalNumber = (v: unknown): v is number | null =>
  v === null || positive(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function rankRow(v: unknown): v is RankRow {
  return (
    isRecord(v) &&
    positive(v.rank) &&
    typeof v.name === "string" &&
    (v.playerId === null || decimal(v.playerId)) &&
    (v.score === null || decimal(v.score))
  );
}
function source(v: unknown): v is Source {
  return (
    isRecord(v) &&
    (v.kind === "system" || v.kind === "report") &&
    decimal(v.id) &&
    typeof v.subject === "string" &&
    optionalNumber(v.sendTime) &&
    typeof v.claimed === "boolean" &&
    decimal(v.count)
  );
}
function item(v: unknown): v is MailItem {
  return (
    isRecord(v) &&
    typeof v.key === "string" &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    decimal(v.pending) &&
    decimal(v.claimed) &&
    Array.isArray(v.sources) &&
    v.sources.every(source)
  );
}
export function parseSeasonPreview(
  v: unknown,
  expected: Section | "guild",
): Ranking | Mail | GuildRank {
  if (!isRecord(v) || v.kind !== expected || !optionalNumber(v.season))
    throw Error("赛季预览数据无效");
  const season = v.season;
  if (v.kind === "guild") {
    if (
      (v.state !== "ranked" &&
        v.state !== "notJoined" &&
        v.state !== "unranked") ||
      !(v.state === "ranked" ? positive(v.rank) : v.rank === null) ||
      !optionalNumber(v.rank) ||
      !(v.score === null || decimal(v.score))
    )
      throw Error("联盟赛季名次无效");
    return {
      kind: "guild",
      season,
      state: v.state,
      rank: v.rank,
      score: v.score,
    };
  }
  if (v.kind === "mail") {
    if (
      !count(v.scanned) ||
      !count(v.reportsScanned) ||
      !isRecord(v.merit) ||
      !decimal(v.merit.pending) ||
      !decimal(v.merit.claimed) ||
      !Array.isArray(v.items) ||
      !v.items.every(item)
    )
      throw Error("邮件物品数据不完整");
    return {
      kind: "mail",
      season,
      scanned: v.scanned,
      reportsScanned: v.reportsScanned,
      items: v.items,
      merit: { pending: v.merit.pending, claimed: v.merit.claimed },
    };
  }
  if (
    (v.kind !== "merit" && v.kind !== "tech") ||
    !Array.isArray(v.rows) ||
    !v.rows.every(rankRow) ||
    !(v.mine === null || rankRow(v.mine)) ||
    !optionalNumber(v.midEndTime) ||
    !optionalNumber(v.endTime)
  )
    throw Error("赛季榜单数据不完整");
  return {
    kind: v.kind,
    season,
    rows: v.rows,
    mine: v.mine,
    midEndTime: v.midEndTime,
    endTime: v.endTime,
  };
}
