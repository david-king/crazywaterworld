import { useEffect, useState } from "react";
import { Button } from "../../button";
import { Card } from "../../card";
import { Switch } from "../../switch";
import { isRecord } from "../contracts/login-settings";
import { createAccountRequest } from "../lib/api";
import styles from "./season-preview.module.css";

type Preference = {
  enabled: boolean;
  targetRank: number;
  leadMinutes: number;
  revision: number;
  baseRevision: string;
};
const endpoint = "/api/season/merit-settings";
function parse(v: unknown): Preference {
  if (
    !isRecord(v) ||
    typeof v.enabled !== "boolean" ||
    typeof v.baseRevision !== "string" ||
    typeof v.targetRank !== "number" ||
    !Number.isSafeInteger(v.targetRank) ||
    typeof v.leadMinutes !== "number" ||
    !Number.isSafeInteger(v.leadMinutes) ||
    typeof v.revision !== "number" ||
    !Number.isSafeInteger(v.revision)
  )
    throw Error("偷榜设置未完整返回");
  return {
    enabled: v.enabled,
    targetRank: v.targetRank,
    leadMinutes: v.leadMinutes,
    revision: v.revision,
    baseRevision: v.baseRevision,
  };
}

export function SeasonMeritSettings({ account }: { account: string }) {
  const [saved, setSaved] = useState<Preference | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [rank, setRank] = useState("");
  const [minutes, setMinutes] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (reload) setNotice("");
    const controller = new AbortController();
    const { signal } = controller;
    createAccountRequest(account)(endpoint, { signal })
      .then(parse)
      .then((value) => {
        if (signal.aborted) return;
        setSaved(value);
        setEnabled(value.enabled);
        setRank(String(value.targetRank || ""));
        setMinutes(String(value.leadMinutes || ""));
        setError("");
      })
      .catch((e) => {
        if (!signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [account, reload]);
  const dirty =
    saved &&
    (enabled !== saved.enabled ||
      Number(rank) !== saved.targetRank ||
      Number(minutes) !== saved.leadMinutes);
  async function save() {
    if (!saved || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = parse(
        await createAccountRequest(account)(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seasonMerit: {
              enabled,
              targetRank: Number(rank),
              leadMinutes: Number(minutes),
            },
            revision: saved.revision,
            baseRevision: saved.baseRevision,
            confirm: true,
          }),
        }),
      );
      setSaved(value);
      setNotice(
        value.enabled ? "已保存，随本账号挂机运行" : "已保存，自动偷榜已关闭",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className={styles.summary}>
      <form
        className={styles.meritForm}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={styles.meritHeading}>
          <h3>
            <label htmlFor="season-merit-enabled">自动偷榜</label>
          </h3>
          <Switch
            id="season-merit-enabled"
            checked={enabled}
            disabled={!saved || busy}
            onCheckedChange={(v) => {
              setEnabled(v);
              setNotice("");
            }}
          />
        </div>
        <p>
          进入检查时段后，若当前积分加未领功勋能超过目标名次，挂机将全领邮件和战报奖励。
        </p>
        <div className={styles.meritFields}>
          <label>
            目标名次
            <input
              type="number"
              min="1"
              step="1"
              placeholder="第几名"
              required={enabled}
              disabled={!saved || busy}
              value={rank}
              onChange={(e) => {
                setRank(e.target.value);
                setNotice("");
              }}
            />
          </label>
          <label>
            结算前（分钟）
            <input
              type="number"
              min="1"
              step="1"
              placeholder="提前多久"
              required={enabled}
              disabled={!saved || busy}
              value={minutes}
              onChange={(e) => {
                setMinutes(e.target.value);
                setNotice("");
              }}
            />
          </label>
        </div>
        <p className={styles.meritWarning}>
          请手动关闭挂机配置中的「邮件附件」和「战报自动领奖总开关」，否则功勋可能提前领走，无法用于偷榜。
        </p>
        <div>
          <Button type="submit" size="sm" disabled={!dirty || busy}>
            {busy ? "保存中…" : "保存设置"}
          </Button>
          {error && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSaved(null);
                setReload((n) => n + 1);
              }}
            >
              重新读取
            </Button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
    </Card>
  );
}
