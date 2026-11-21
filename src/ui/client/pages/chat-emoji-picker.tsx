import { Smile, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../button";
import { parseChatEmojis } from "../contracts/chat";
import { createAccountRequest } from "../lib/api";
import styles from "./chat.module.css";

type Catalog = ReturnType<typeof parseChatEmojis>;
function EmojiArt({ src, fallback }: { src: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    <img alt="" src={src} onError={() => setFailed(true)} />
  ) : (
    <span>{fallback}</span>
  );
}

function seenKey(account: string, owner: string, id: number) {
  return JSON.stringify(["cw-chat-emoji", account, owner, id]);
}

export function ChatEmojiPicker({
  account,
  disabled,
  send,
}: {
  account: string;
  disabled: boolean;
  send: (emoji: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(new Set<number>());
  const [group, setGroup] = useState<number | null>(null);
  const [revision, refresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry or inventory change refreshes the catalog.
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const data = parseChatEmojis(
          await createAccountRequest(account)("/api/chat/emojis", {
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return;
        const fresh = data.items
          .filter((item) => item.special)
          .map((item) => item.id);
        let unseen = fresh;
        try {
          unseen = fresh.filter(
            (id) => !localStorage.getItem(seenKey(account, data.owner, id)),
          );
        } catch {
          /* Storage is optional. */
        }
        setUnread(new Set(unseen));
        setCatalog(data);
        setError(data.hint);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setCatalog(null);
        setError(failure instanceof Error ? failure.message : "读取表情失败");
      }
    }
    function changed(event: Event) {
      if (
        !(event instanceof CustomEvent) ||
        (event.detail.account === account &&
          event.detail.channels.includes("emojis"))
      )
        refresh((value) => value + 1);
    }
    void load();
    window.addEventListener("cw-chat-update", changed);
    return () => {
      controller.abort();
      window.removeEventListener("cw-chat-update", changed);
    };
  }, [account, revision]);

  const groups = catalog?.groups ?? [];
  const activeGroup =
    groups.find((entry) => entry.id === group)?.id ?? groups[0]?.id;
  const visible =
    catalog?.items.filter((item) => item.group === activeGroup) ?? [];
  function markViewed() {
    if (!catalog) return;
    const next = new Set(unread);
    for (const item of visible) {
      if (!next.delete(item.id)) continue;
      try {
        localStorage.setItem(seenKey(account, catalog.owner, item.id), "1");
      } catch {
        /* Storage is optional. */
      }
    }
    setUnread(next);
  }
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={disabled}
        title="表情"
        aria-label="选择表情"
        aria-description={unread.size ? "有新解锁的活动表情" : undefined}
        aria-haspopup="dialog"
        data-unread={unread.size > 0 || undefined}
        onClick={() => {
          setGroup(null);
          setOpen(true);
          refresh((value) => value + 1);
          dialog.current?.showModal();
        }}
      >
        <Smile aria-hidden="true" />
      </Button>
      <dialog
        ref={dialog}
        closedby="any"
        aria-label="选择表情"
        className={styles.emojiDialog}
        onClose={() => {
          markViewed();
          setOpen(false);
        }}
      >
        <div className={styles.emojiHeader}>
          <strong>表情</strong>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="关闭表情"
            onClick={() => dialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        {open && (
          <>
            {groups.length > 0 && (
              <fieldset className={styles.emojiGroups} aria-label="表情分组">
                {groups.map(({ id, icon }) => (
                  <Button
                    key={id}
                    type="button"
                    variant={id === activeGroup ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={id === activeGroup}
                    aria-label={`第 ${id} 组`}
                    title={`第 ${id} 组`}
                    data-unread={
                      catalog?.items.some(
                        (item) => item.group === id && unread.has(item.id),
                      ) || undefined
                    }
                    onClick={() => {
                      if (id !== activeGroup) {
                        markViewed();
                        setGroup(id);
                      }
                    }}
                  >
                    <EmojiArt key={icon} src={icon} fallback={`第 ${id} 组`} />
                  </Button>
                ))}
              </fieldset>
            )}
            {error && (
              <p role="alert">
                {error}{" "}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => refresh((n) => n + 1)}
                >
                  重试
                </Button>
              </p>
            )}
            {catalog ? (
              <div className={styles.emojiGrid} key={activeGroup}>
                {visible.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    className="h-16 min-w-0 whitespace-normal wrap-anywhere p-1 text-xs pointer-coarse:h-16"
                    title={item.name}
                    aria-label={`发送表情：${item.name}`}
                    data-unread={unread.has(item.id) || undefined}
                    onClick={() => {
                      dialog.current?.close();
                      send(item.id);
                    }}
                  >
                    <EmojiArt
                      key={item.sticker}
                      src={item.sticker}
                      fallback={item.name}
                    />
                  </Button>
                ))}
              </div>
            ) : (
              !error && <p role="status">正在读取表情…</p>
            )}
            {groups.length > 0 && visible.length === 0 && (
              <p role="status">本组暂无已解锁的表情</p>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
