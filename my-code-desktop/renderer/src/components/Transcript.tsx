import React, { useEffect, useRef, useState } from "react";
import { Markdown } from "../Markdown";
import { ToolCard } from "./ToolCard";
import { Logo } from "./Logo";
import { Icon, type IconName } from "./Icon";
import type { Item } from "../transcript";
import type { Mode } from "../../../electron/ipc";

export interface TranscriptProps {
  items: Item[];
  mode: Mode;
  busy: boolean;
  mood: string;
  greeting: string;
  /** Resend the last user prompt. */
  onRetry: () => void;
  /** Restart the backend, then resend the last unanswered prompt (error card). */
  onRetryBackend: () => void;
  /** Load a message's text back into the composer. */
  onEdit: (text: string) => void;
  /** Open the settings modal (used by error-card actions). */
  onOpenSettings: () => void;
}

export function Transcript({ items, busy, mood, onRetry, onRetryBackend, onEdit, onOpenSettings }: TranscriptProps): React.ReactElement {
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevLen = useRef(0);

  // Auto-scroll only when the user is already near the bottom, so scrolling up
  // to read older messages during a stream doesn't yank the view back down.
  // Smooth-scroll only when a *new* item arrives; token deltas jump instantly so
  // rapid streaming never fights an in-flight smooth animation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      const isNewItem = items.length !== prevLen.current;
      endRef.current?.scrollIntoView({ block: "end", behavior: isNewItem ? "smooth" : "auto" });
    }
    prevLen.current = items.length;
  }, [items]);

  return (
    <div className="transcript" ref={scrollRef}>
      <div className="thread">
        {items.map((it) => (
          <Row key={it.id} it={it} onRetry={onRetry} onRetryBackend={onRetryBackend} onEdit={onEdit} onOpenSettings={onOpenSettings} />
        ))}
        {busy && mood === "thinking" && (
          <div className="status-line">
            <Logo size={22} mood="thinking" />
            <span className="status-shimmer">Thinking…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

interface RowProps {
  it: Item;
  onRetry: () => void;
  onRetryBackend: () => void;
  onEdit: (text: string) => void;
  onOpenSettings: () => void;
}

// Memoized so a streaming turn only re-renders the item that actually changed.
// App's reducers preserve object identity for untouched items, and the handler
// props are stable (useCallback in App), so shallow-equal props let every prior
// row skip re-render while the last one streams.
const Row = React.memo(function Row({ it, onRetry, onRetryBackend, onEdit, onOpenSettings }: RowProps): React.ReactElement | null {
  switch (it.kind) {
    case "user":
      return (
        <div className="row user">
          <div className="user-col">
            <div className="bubble user-bubble">{it.text}</div>
            <div className="msg-actions">
              <ActBtn icon="edit" label="Edit" onClick={() => onEdit(it.text)} />
              <CopyBtn text={it.text} />
            </div>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="row assistant">
          <div className="bubble assistant-bubble">
            <Markdown content={it.text} />
            {it.streaming && <span className="caret" />}
          </div>
          <div className="msg-actions">
            {!it.streaming && (
              <>
                <CopyBtn text={it.text} />
                <ActBtn icon="retry" label="Retry" onClick={onRetry} />
              </>
            )}
          </div>
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={it.text} streaming={it.streaming} durationMs={it.durationMs} />;
    case "tool":
      return (
        <div className="row assistant">
          <ToolCard it={it} />
        </div>
      );
    case "notice":
      return <NoticeCard it={it} onRetry={onRetryBackend} onOpenSettings={onOpenSettings} />;
    default:
      return null;
  }
});

function ActBtn({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }): React.ReactElement {
  return (
    <button className="msg-act" onClick={onClick} title={label}>
      <Icon name={icon} size={12} /> {label}
    </button>
  );
}

function CopyBtn({ text }: { text: string }): React.ReactElement {
  const [done, setDone] = useState(false);
  return (
    <button
      className="msg-act"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={12} /> {done ? "Copied" : "Copy"}
    </button>
  );
}

/** Friendly title/hint for common backend errors. */
function classifyError(text: string): { title: string; hint?: string } {
  const t = text.toLowerCase();
  if (t.includes("pwsh") || t.includes("powershell")) return { title: "Shell not found", hint: "PowerShell 7 (pwsh) isn't on your PATH — install it or switch shell in settings." };
  if (t.includes("invalid schema") || t.includes("http 400")) return { title: "Provider rejected the request", hint: "A tool schema or request was invalid for this model provider." };
  if (t.includes("timed out") || t.includes("timeout")) return { title: "The backend timed out" };
  if (t.includes("econnrefused") || t.includes("connect")) return { title: "Connection problem", hint: "Couldn't reach the backend or model provider." };
  if (t.includes("rate limit") || t.includes("429")) return { title: "Rate limited", hint: "The provider is throttling requests — retry in a moment." };
  if (t.includes("unauthor") || t.includes("api key") || t.includes("401")) return { title: "Authentication failed", hint: "Check the API key / account in settings." };
  return { title: "Something went wrong" };
}

function NoticeCard({
  it,
  onRetry,
  onOpenSettings,
}: {
  it: Extract<Item, { kind: "notice" }>;
  onRetry: () => void;
  onOpenSettings: () => void;
}): React.ReactElement {
  if (it.tone === "info") {
    return <div className="row notice info">{it.text}</div>;
  }
  const { title, hint } = classifyError(it.text);
  return (
    <div className="row assistant">
      <div className={`err-card ${it.tone}`}>
        <div className="err-top">
          <span className="err-ico"><Icon name={it.tone === "error" ? "close" : "sparkle"} size={13} /></span>
          <div className="err-title">
            {title}
            {hint && <small>{hint}</small>}
          </div>
        </div>
        <div className="err-detail">{it.text}</div>
        <div className="err-actions">
          <button className="err-btn primary" onClick={onRetry}><Icon name="retry" size={12} /> Retry</button>
          <button className="err-btn" onClick={onOpenSettings}>Open settings</button>
          <button className="err-btn" onClick={() => void navigator.clipboard?.writeText(it.text)}>Copy</button>
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({
  text,
  streaming,
  durationMs,
}: {
  text: string;
  streaming: boolean;
  durationMs?: number;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const label = streaming
    ? "Thinking…"
    : durationMs
      ? `Thought for ${(durationMs / 1000).toFixed(0)}s`
      : "Thought";
  return (
    <div className="row assistant">
      <div className={`thinking ${open ? "open" : ""}`}>
        <button className={`thinking-head ${streaming ? "live" : ""}`} onClick={() => setOpen((o) => !o)}>
          <span className="spark"><Icon name="sparkle" size={13} /></span>
          <span className="lab">{label}</span>
          <span className="chev"><Icon name="chevronDown" size={13} /></span>
        </button>
        <div className="thinking-wrap"><div className="thinking-body">{text}</div></div>
      </div>
    </div>
  );
}
