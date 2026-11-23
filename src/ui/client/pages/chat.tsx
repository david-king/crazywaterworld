import {
  ChevronLeft,
  ChevronRight,
  Globe2,
  Megaphone,
  MessageCircle,
  Send,
  Shield,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Button } from "../../button";
import { Input } from "../../input";
import { parseChat, parseChatProfile } from "../contracts/chat";
import { ApiError, createAccountRequest } from "../lib/api";
import { getConsoleStore } from "../lib/console-store";
import { formatGameTime } from "../lib/time";
import styles from "./chat.module.css";
import { ChatEmojiPicker } from "./chat-emoji-picker";

const channels = [
  ["world", "世界", Globe2],
  ["system", "系统", Megaphone],
  ["private", "私聊", MessageCircle],
  ["guild", "联盟", Shield],
] as const;
type Channel = (typeof channels)[number][0];
type Peer = { id: string; name: string };
type ProfileTarget = Peer & { avatar: string; own: boolean };

function Avatar({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.avatar} aria-hidden="true">
      {src && !failed ? (
        <img alt="" src={src} onError={() => setFailed(true)} />
      ) : (
        Array.from(name)[0]
      )}
    </span>
  );
}

function MessageBody({ text, sticker }: { text: string; sticker: string }) {
  const [failed, setFailed] = useState(false);
  return sticker && !failed ? (
    <img
      className={styles.sticker}
      src={sticker}
      alt={text}
      onError={() => setFailed(true)}
    />
  ) : (
    <div className={styles.bubble}>{text}</div>
  );
}

function PlayerAvatar({
  target,
  inspect,
}: {
  target: ProfileTarget;
  inspect: (target: ProfileTarget) => void;
}) {
  const avatar = <Avatar src={target.avatar} name={target.name} />;
  if (!target.id) return avatar;
  const label = `查看${target.name}的资料`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      className={styles.avatarButton}
      onClick={() => inspect(target)}
    >
      {avatar}
    </button>
  );
}

function ProfileDialog({
  account,
  target,
  dismiss,
  chat,
}: {
  account: string;
  target: ProfileTarget;
  dismiss: () => void;
  chat: (peer: Peer) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<ReturnType<typeof parseChatProfile> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry starts a new profile request.
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ peer: target.id });
    setError("");
    const load = async () => {
      try {
        const result = await createAccountRequest(account)(
          `/api/chat/profile?${query}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted)
          setInfo(parseChatProfile(result, target.id));
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "读取玩家资料失败",
          );
      }
    };
    void load();
    return () => controller.abort();
  }, [account, target.id, attempt]);
  const name = info?.nickname || target.name;
  const members = info
    ? [
        ...info.heroes.map((hero) => ({ ...hero, kind: "英雄" })),
        ...(info.pet ? [{ ...info.pet, kind: "宠物" }] : []),
      ]
    : [];
  return (
    <dialog
      ref={dialog}
      className={styles.profile}
      aria-labelledby="chat-profile-name"
      onClose={dismiss}
    >
      <div className={styles.profileHeader}>
        <Avatar src={info?.avatar || target.avatar} name={name} />
        <div>
          <h3 id="chat-profile-name">{name}</h3>
          <small>ID {target.id}</small>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="关闭"
          aria-label="关闭玩家资料"
          onClick={() => dialog.current?.close()}
        >
          <X />
        </Button>
      </div>
      {info ? (
        <>
          <dl className={styles.facts}>
            <dt>等级</dt>
            <dd>{info.level}</dd>
            <dt>战力</dt>
            <dd>{info.power}</dd>
            {info.guild && (
              <>
                <dt>联盟</dt>
                <dd>{info.guild}</dd>
              </>
            )}
            {info.title && (
              <>
                <dt>称号</dt>
                <dd>{info.title}</dd>
              </>
            )}
          </dl>
          {members.length > 0 && (
            <ul className={styles.members}>
              {members.map((member) => (
                <li key={member.kind + member.id}>
                  <span>{member.kind}</span>
                  <strong>{member.name}</strong>
                  <span>
                    Lv.{member.level} · {member.star}星
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : error ? (
        <div role="alert">
          {error}{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry((n) => n + 1)}
          >
            重试
          </Button>
        </div>
      ) : (
        <p role="status">正在读取玩家资料…</p>
      )}
      {!(info?.own ?? target.own) && (
        <Button type="button" onClick={() => chat({ id: target.id, name })}>
          <MessageCircle aria-hidden="true" />
          私聊
        </Button>
      )}
    </dialog>
  );
}

function Feed({
  account,
  channel,
  peer,
  openPeer,
  inspect,
}: {
  account: string;
  channel: Channel;
  peer: Peer | null;
  openPeer: (peer: Peer) => void;
  inspect: (target: ProfileTarget) => void;
}) {
  const [data, setData] = useState<ReturnType<typeof parseChat> | null>(null);
  const [error, setError] = useState("");
  const list = channel === "private" && !peer;
  const peerId = peer?.id;
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ channel });
    if (peerId) query.set("peer", peerId);
    const request = createAccountRequest(account);
    let busy = false,
      dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (document.hidden || controller.signal.aborted) return;
      if (busy) {
        dirty = true;
        return;
      }
      busy = true;
      try {
        const result = parseChat(
          await request(`/api/chat?${query}`, { signal: controller.signal }),
        );
        if (!controller.signal.aborted) {
          setData(result);
          setError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(failure instanceof Error ? failure.message : "读取聊天失败");
        }
      } finally {
        busy = false;
        if (dirty && !controller.signal.aborted) {
          dirty = false;
          queueRead();
        }
      }
    }
    function queueRead() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, 100);
    }
    function changed(event: Event) {
      if (
        event instanceof CustomEvent &&
        (event.detail.account !== account ||
          !event.detail.channels.includes(channel))
      )
        return;
      queueRead();
    }
    window.addEventListener("cw-chat-update", changed);
    document.addEventListener("visibilitychange", queueRead);
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("cw-chat-update", changed);
      document.removeEventListener("visibilitychange", queueRead);
    };
  }, [account, channel, peerId]);

  return (
    <>
      <div className={styles.feed} data-transcript={!list}>
        <div className={styles.rows}>
          {error && (
            <div className={styles.empty} role="alert">
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.dispatchEvent(new Event("cw-chat-update"))
                }
              >
                重试
              </Button>
            </div>
          )}
          {!error && !data?.rows.length && (
            <p className={styles.empty} role="status">
              {!data
                ? "正在读取…"
                : data.hint || (list ? "暂无私聊会话" : "当前频道暂无消息")}
            </p>
          )}
          {data?.rows.map((row) => {
            const date = row.time ? formatGameTime(row.time * 1000) : "";
            const stamp = (
              <time
                dateTime={
                  row.time ? new Date(row.time * 1000).toISOString() : undefined
                }
                title={date}
              >
                {date.slice(5, row.system ? 19 : 16)}
              </time>
            );
            if (list)
              return (
                <div className={styles.peer} key={row.peerId}>
                  <PlayerAvatar
                    target={{
                      id: row.peerId,
                      name: row.sender,
                      own: false,
                      avatar: row.avatar,
                    }}
                    inspect={inspect}
                  />
                  <button
                    type="button"
                    className={styles.peerLink}
                    onClick={() =>
                      openPeer({ id: row.peerId, name: row.sender })
                    }
                  >
                    <span className={styles.peerText}>
                      <strong>{row.sender}</strong>
                      <span>
                        {row.own ? "我：" : ""}
                        {row.text}
                      </span>
                    </span>
                    {stamp}
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            if (row.system)
              return (
                <article
                  key={row.id}
                  className={styles.notice}
                  aria-label="系统公告"
                >
                  {row.time > 0 && stamp}
                  <p>
                    {row.parts.length
                      ? row.parts.map((part) => (
                          <span
                            key={part.index}
                            data-bold={part.bold || undefined}
                            style={
                              part.color
                                ? ({
                                    "--notice-color": part.color,
                                  } as CSSProperties)
                                : undefined
                            }
                          >
                            {part.text}
                          </span>
                        ))
                      : row.text}
                  </p>
                </article>
              );
            return (
              <article
                key={row.id}
                className={styles.message}
                data-own={row.own}
              >
                <PlayerAvatar
                  target={{
                    id: row.senderId,
                    name: row.sender,
                    own: row.own,
                    avatar: row.avatar,
                  }}
                  inspect={inspect}
                />
                <div className={styles.body}>
                  <div className={styles.byline}>
                    <strong>{row.own ? "我" : row.sender}</strong>
                    {stamp}
                  </div>
                  <MessageBody
                    key={row.sticker}
                    text={row.text}
                    sticker={row.sticker}
                  />
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {data && !data.hint && channel !== "system" && !list && (
        <Composer account={account} channel={channel} peer={peer} />
      )}
    </>
  );
}

function Composer({
  account,
  channel,
  peer,
}: {
  account: string;
  channel: Channel;
  peer: Peer | null;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const inFlight = useRef(false);
  const unknown = "发送结果尚未确认，请先查看聊天记录。";
  async function sendMessage(content: { text: string } | { emoji: number }) {
    const store = getConsoleStore().getState();
    if (
      inFlight.current ||
      ("text" in content && !content.text.trim()) ||
      store.currentAccountId !== account ||
      store.view.page !== "chat"
    )
      return;
    inFlight.current = true;
    setSending(true);
    setSendError("");
    try {
      const request = createAccountRequest(account);
      const result = await request("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          channel,
          peer: peer?.id ?? null,
          ...content,
        }),
      });
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "sent"
      ) {
        if ("text" in content) setDraft("");
      } else setSendError(unknown);
      window.dispatchEvent(
        new CustomEvent("cw-chat-update", {
          detail: { account, channels: [channel] },
        }),
      );
    } catch (error) {
      setSendError(error instanceof ApiError ? error.message : unknown);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }
  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        void sendMessage({ text: draft });
      }}
    >
      <Input
        type="text"
        className="w-full min-w-0"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSendError("");
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          )
            event.preventDefault();
        }}
        maxLength={150}
        placeholder={
          peer
            ? `发给 ${peer.name}`
            : channel === "guild"
              ? "在联盟频道发言"
              : "在世界频道发言"
        }
        aria-label="聊天消息"
        autoComplete="off"
        readOnly={sending}
      />
      <ChatEmojiPicker
        account={account}
        disabled={sending}
        send={(emoji) => void sendMessage({ emoji })}
      />
      <Button type="submit" disabled={sending || !draft.trim()}>
        <Send aria-hidden="true" />
        {sending ? "发送中…" : "发送"}
      </Button>
      {sendError && (
        <p className={styles.sendError} role="alert">
          {sendError}
        </p>
      )}
    </form>
  );
}

function ChatPanel({
  account,
  hint,
}: {
  account: string | null;
  hint: string;
}) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [peer, setPeer] = useState<Peer | null>(null);
  const [profile, setProfile] = useState<ProfileTarget | null>(null);
  function openPeer(target: Peer) {
    setProfile(null);
    setChannel("private");
    setPeer(target);
  }
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <fieldset className={styles.channels} aria-label="聊天频道">
          {channels.map(([id, title, Icon]) => (
            <Button
              key={id}
              variant={id === channel ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={id === channel}
              onClick={() => {
                setChannel(id);
                setPeer(null);
              }}
            >
              <Icon aria-hidden="true" />
              {title}
            </Button>
          ))}
        </fieldset>
      </div>
      {peer && !hint && (
        <div className={styles.thread}>
          <Button variant="ghost" size="sm" onClick={() => setPeer(null)}>
            <ChevronLeft aria-hidden="true" />
            会话列表
          </Button>
          <strong>{peer.name}</strong>
        </div>
      )}
      {hint || !account || !channel ? (
        <p className={styles.empty} role="status">
          {hint || "请选择频道查看聊天记录。"}
        </p>
      ) : (
        <Feed
          key={channel + (peer?.id || "")}
          account={account}
          channel={channel}
          peer={peer}
          openPeer={openPeer}
          inspect={setProfile}
        />
      )}
      {profile && account && !hint && (
        <ProfileDialog
          key={profile.id}
          account={account}
          target={profile}
          dismiss={() => setProfile(null)}
          chat={openPeer}
        />
      )}
    </div>
  );
}

function ChatPage() {
  const store = getConsoleStore();
  const active = useStore(store, (state) => state.view.page === "chat");
  const account = useStore(store, (state) => state.currentAccountId);
  const hint = useStore(store, (state) => {
    const id = state.currentAccountId;
    if (!id) return "请先选择账号。";
    const status = state.accountsById[id]?.status;
    if (status?.paused) return "账号已暂停，恢复托管后可查看聊天。";
    if (status?.reconnecting) return "账号正在重连…";
    return status?.connected && !state.disconnected.has(id)
      ? ""
      : "连接当前账号后可查看聊天。";
  });
  return active ? (
    <ChatPanel
      key={JSON.stringify([account, Boolean(hint)])}
      account={account}
      hint={hint}
    />
  ) : null;
}

export function mountChat(host: HTMLElement) {
  createRoot(host).render(<ChatPage />);
}
