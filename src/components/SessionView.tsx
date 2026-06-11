import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw } from "lucide-react";
import type { SessionMessage, SessionMessagesPage } from "../types";
import { useI18n } from "../i18n";
import { MessageBlock } from "./session-view/MessageBlock";

const PAGE_LIMIT = 500;
const LIVE_REFRESH_MS = 1500;

export function SessionView({ sessionPath }: { sessionPath: string }) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadPage = async (nextCursor: number | null, append: boolean) => {
    const page = await invoke<SessionMessagesPage>("read_session_messages_page", {
      sessionPath,
      cursor: nextCursor,
      limit: PAGE_LIMIT,
    });
    setCursor(page.nextCursor);
    setHasMore(page.hasMore);
    setMessages((prev) => (append ? [...prev, ...page.messages] : page.messages));
  };

  const reload = () => {
    setLoading(true);
    setError(null);
    loadPage(null, false)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  };

  const loadMore = () => {
    if (loadingMore || cursor === null) return;
    setLoadingMore(true);
    loadPage(cursor, true)
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPath]);

  useEffect(() => {
    if (loading || hasMore || cursor === null) return;
    const timer = window.setInterval(() => {
      invoke<SessionMessagesPage>("read_session_messages_page", {
        sessionPath,
        cursor,
        limit: PAGE_LIMIT,
      })
        .then((page) => {
          if (page.messages.length === 0) {
            setCursor(page.nextCursor);
            setHasMore(page.hasMore);
            return;
          }
          setCursor(page.nextCursor);
          setHasMore(page.hasMore);
          setMessages((prev) => [...prev, ...page.messages]);
        })
        .catch(() => {});
    }, LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [cursor, hasMore, loading, sessionPath]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "20px 28px 32px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--text-hint)", fontFamily: "var(--font-mono)" }}>
          {messages.length} messages
        </div>
        <button
          type="button"
          onClick={reload}
          title={t("common.refresh")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 9px",
            borderRadius: 6,
            border: "1px solid var(--border-dim)",
            background: "var(--bg-card)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <RotateCcw size={12} className={loading ? "spin" : undefined} />
          {t("common.refresh")}
        </button>
      </div>
      {loading && (
        <div style={{ color: "var(--text-hint)", fontSize: 13, padding: "12px 0" }}>
          {t("session.loading")}
        </div>
      )}
      {error && (
        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "12px 0" }}>
          {t("session.unableToLoad", { error })}
        </div>
      )}
      {!loading && !error && messages.length === 0 && (
        <div style={{ color: "var(--text-hint)", fontSize: 13, padding: "12px 0" }}>
          {t("session.noMessages")}
        </div>
      )}
      {messages.map((msg) => (
        <MessageBlock key={msg.id} message={msg} />
      ))}
      {hasMore && !loading && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={loadMore}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 7,
            border: "1px solid var(--border-dim)",
            background: "var(--bg-card)",
            color: "var(--text-muted)",
            cursor: loadingMore ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {loadingMore ? t("common.loading") : t("session.loadMore")}
        </button>
      )}
    </div>
  );
}
