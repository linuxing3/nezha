import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench, TerminalSquare, Bug, Copy, Check } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { SessionContent, SessionMessage } from "../../types";
import { useI18n } from "../../i18n";

function CollapsibleBlock({
  icon,
  title,
  subtitle,
  children,
  tone = "default",
  defaultExpanded = false,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  tone?: "default" | "danger" | "muted";
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const borderColor = tone === "danger" ? "var(--danger-border)" : "var(--border-dim)";
  return (
    <div
      style={{
        margin: "7px 0",
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        overflow: "hidden",
        fontSize: 12,
        background: "var(--bg-card)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 10px",
          background: tone === "danger" ? "var(--danger-surface)" : "var(--bg-input)",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: tone === "danger" ? "var(--danger-fg)" : "var(--text-secondary)",
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 650 }}>{title}</span>
        {subtitle && (
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-hint)",
            }}
          >
            {subtitle}
          </span>
        )}
      </button>
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "9px 12px",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            color: tone === "danger" ? "var(--danger-fg)" : "var(--text-secondary)",
            background: "var(--bg-root)",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 340,
            overflowY: "auto",
          }}
        >
          {children}
        </pre>
      )}
    </div>
  );
}

export function ThinkingBlock({ thinking }: { thinking: string }) {
  const { t } = useI18n();
  return (
    <CollapsibleBlock
      icon={<ChevronRight size={0} style={{ display: "none" }} />}
      title={t("session.thinking")}
      subtitle={thinking.slice(0, 80)}
      tone="muted"
    >
      {thinking || t("session.emptyThinking")}
    </CollapsibleBlock>
  );
}

export function ToolUseCard({ name, input }: { name: string; input: string }) {
  return (
    <CollapsibleBlock
      icon={<Wrench size={12} style={{ color: "var(--text-hint)", flexShrink: 0 }} />}
      title={name || "tool"}
      subtitle={input.slice(0, 120)}
    >
      {input || "{}"}
    </CollapsibleBlock>
  );
}

export function ToolResultCard({ toolUseId, content, isError }: { toolUseId: string; content: string; isError: boolean }) {
  const { t } = useI18n();
  return (
    <CollapsibleBlock
      icon={<TerminalSquare size={12} style={{ flexShrink: 0 }} />}
      title={isError ? t("session.toolResultError") : t("session.toolResult")}
      subtitle={toolUseId || content.slice(0, 120)}
      tone={isError ? "danger" : "default"}
    >
      {content || "(empty)"}
    </CollapsibleBlock>
  );
}

export function RawEventBlock({ label, raw }: { label: string; raw: unknown }) {
  const pretty = useMemo(() => JSON.stringify(raw, null, 2), [raw]);
  return (
    <CollapsibleBlock
      icon={<Bug size={12} style={{ color: "var(--text-hint)", flexShrink: 0 }} />}
      title={label || "raw"}
      subtitle="raw event"
      tone="muted"
    >
      {pretty}
    </CollapsibleBlock>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <CollapsibleBlock icon={<Bug size={12} />} title="Error" tone="danger" defaultExpanded>
      {message}
    </CollapsibleBlock>
  );
}

function MarkdownBlock({ text }: { text: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered);
  }, [text]);
  return <div className="session-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function UserMessageBubble({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{ maxWidth: "72%", position: "relative" }}
        className="user-message-bubble"
        onMouseEnter={(event) => {
          const btn = event.currentTarget.querySelector(".copy-btn") as HTMLElement | null;
          if (btn) btn.style.opacity = "1";
        }}
        onMouseLeave={(event) => {
          const btn = event.currentTarget.querySelector(".copy-btn") as HTMLElement | null;
          if (btn) btn.style.opacity = "0";
        }}
      >
        <button
          type="button"
          className="copy-btn"
          onClick={handleCopy}
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            opacity: 0,
            transition: "opacity 0.15s",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 2,
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <div
          style={{
            padding: "10px 16px",
            background: "var(--bg-subtle)",
            color: "var(--text-primary)",
            borderRadius: 20,
            fontSize: 13.5,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

function renderContent(content: SessionContent, index: number) {
  switch (content.type) {
    case "text":
      return <MarkdownBlock key={index} text={content.text} />;
    case "thinking":
      return <ThinkingBlock key={index} thinking={content.thinking} />;
    case "tool_use":
      return <ToolUseCard key={index} name={content.name} input={content.input} />;
    case "tool_result":
      return (
        <ToolResultCard
          key={index}
          toolUseId={content.toolUseId}
          content={content.content}
          isError={content.isError}
        />
      );
    case "error":
      return <ErrorBlock key={index} message={content.message} />;
    case "raw_event":
      return <RawEventBlock key={index} label={content.label} raw={content.raw} />;
  }
}

export const MessageBlock = memo(function MessageBlock({ message }: { message: SessionMessage }) {
  const isUser = message.role === "user";

  if (isUser) {
    const text = message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    if (!text.trim()) return null;
    return <UserMessageBubble text={text} />;
  }

  const hasRenderableContent = message.content.length > 0;
  if (!hasRenderableContent) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
          fontSize: 11,
          color: "var(--text-hint)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{message.role}</span>
        <span>·</span>
        <span>{message.source}</span>
        <span>·</span>
        <span>line {message.line}</span>
      </div>
      {message.content.map(renderContent)}
    </div>
  );
});
