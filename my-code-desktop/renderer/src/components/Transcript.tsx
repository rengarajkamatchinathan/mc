import React, { useEffect, useRef, useState } from "react";
import { Markdown } from "../Markdown";
import { ToolCard, fmtDur } from "./ToolCard";
import { Icon, type IconName } from "./Icon";
import { Logo, type MascotMood } from "./Logo";
import type { Activity, Item, TurnReceipt } from "../transcript";
import type { Mode } from "../../../electron/ipc";

export interface TranscriptProps {
  items: Item[];
  mode: Mode;
  busy: boolean;
  mood: string;
  /** What the agent is doing right now (drives the live status line). */
  activity: Activity | null;
  /** Wall-clock start of the current turn (drives the elapsed counter). */
  turnStart: number | null;
  /** End-of-turn receipt, shown once the turn completes. */
  receipt: TurnReceipt | null;
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

export function Transcript({ items, busy, activity, turnStart, receipt, onRetry, onRetryBackend, onEdit, onOpenSettings }: TranscriptProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const prevLen = useRef(0);

  // Auto-follow state machine: stick to the bottom while streaming, break the
  // instant the user scrolls up, re-engage when they come back down. `follow`
  // and `programmatic` are refs so per-token scrolls never trigger re-renders;
  // `detached`/`unread` are state because the jump button renders from them.
  const followRef = useRef(true);
  const programmaticRef = useRef(false);
  const lastTopRef = useRef(0);
  const [detached, setDetached] = useState(false);
  const [unread, setUnread] = useState(0);

  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    // Already at the bottom → scrollTo won't fire a scroll event, and the
    // programmatic flag would stick on and swallow the user's next scroll.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
    programmaticRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const setFollow = (on: boolean) => {
    followRef.current = on;
    if (on) setUnread(0);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastTopRef.current = el.scrollTop;
    // Wheel-up is unambiguous intent — break before the next token can snap
    // the viewport back. It also clears `programmatic`: a wheel mid-smooth-
    // scroll cancels the animation, so the flag would otherwise stick on.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) { programmaticRef.current = false; setFollow(false); }
    };
    const onTouch = () => { programmaticRef.current = false; setFollow(false); };
    // Direction-aware and deaf to our own scrolls: user moving up breaks
    // follow (covers scrollbar drags and keyboard); only a *downward* landing
    // near the bottom re-engages — never upward movement near the bottom,
    // which is the tug-of-war that makes scrolling up mid-stream feel stuck.
    const onScroll = () => {
      const goingDown = el.scrollTop > lastTopRef.current;
      lastTopRef.current = el.scrollTop;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (programmaticRef.current) {
        if (dist <= 1) { programmaticRef.current = false; setFollow(true); }
      } else if (!goingDown && dist > 4) {
        setFollow(false);
      } else if (goingDown && dist < 40) {
        setFollow(true);
      }
      setDetached(dist > 120);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouch, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouch);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Follow content growth that doesn't change the item count — streaming
  // markdown, tool cards expanding, images loading.
  useEffect(() => {
    const th = threadRef.current;
    if (!th || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom(false);
    });
    ro.observe(th);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const added = items.length - prevLen.current;
    prevLen.current = items.length;
    // Sending a message always means "show me the reply" — resume following.
    if (added > 0 && items[items.length - 1]?.kind === "user") setFollow(true);
    if (followRef.current) {
      // Smooth only for new items; token deltas jump instantly so rapid
      // streaming never fights an in-flight smooth animation.
      scrollToBottom(added > 0);
    } else if (added > 0) {
      setUnread((n) => n + added);
    }
  }, [items, activity, receipt]);

  return (
    <div className="transcript-shell">
      <div className="transcript" ref={scrollRef}>
        <div className="thread" ref={threadRef}>
          {items.map((it) => (
            <Row key={it.id} it={it} onRetry={onRetry} onRetryBackend={onRetryBackend} onEdit={onEdit} onOpenSettings={onOpenSettings} />
          ))}
          {busy && activity && <StatusLine activity={activity} turnStart={turnStart} />}
          {!busy && receipt && (
            <div className="done-chip">
              <span className="dc-tick"><Icon name="check" size={12} /></span>
              Done
              {receipt.steps > 0 && <> · {receipt.steps} step{receipt.steps === 1 ? "" : "s"}</>}
              {" · "}{fmtDur(receipt.durationMs)}
              {receipt.tokens ? <> · {fmtTokens(receipt.tokens)} tokens</> : null}
            </div>
          )}
        </div>
      </div>
      <button
        className={`jump-bottom${detached ? " show" : ""}`}
        aria-label="Scroll to bottom"
        tabIndex={detached ? 0 : -1}
        onClick={() => scrollToBottom(true)}
      >
        <Icon name="chevronDown" size={16} />
        {unread > 0 && <span className="jump-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
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
          <div className={`bubble assistant-bubble ${it.streaming ? "streaming" : ""}`}>
            <Markdown content={it.text} streaming={it.streaming} />
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
      return <ThinkingBlock text={it.text} streaming={it.streaming} startedAt={it.startedAt} durationMs={it.durationMs} />;
    case "tool":
      return (
        <div className="row assistant">
          <ToolCard it={it} />
        </div>
      );
    case "steps":
      return <StepsDrawer tools={it.tools} durationMs={it.durationMs} />;
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
  startedAt,
  durationMs,
}: {
  text: string;
  streaming: boolean;
  startedAt?: number;
  durationMs?: number;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(streaming ? startedAt ?? null : null);
  const label = streaming
    ? "Thinking…"
    : durationMs
      ? `Thought for ${fmtDur(durationMs)}`
      : "Thought";
  // Live preview: the last non-empty reasoning line, ghosting under the label.
  const preview = streaming ? lastLine(text) : "";
  return (
    <div className="row assistant">
      <div className={`thinking ${open ? "open" : ""}`}>
        <button className={`thinking-head ${streaming ? "live" : ""}`} onClick={() => setOpen((o) => !o)}>
          <span className="spark"><Icon name="sparkle" size={13} /></span>
          <span className="lab">{label}</span>
          {streaming && elapsed !== null && <span className="think-elapsed">{fmtDur(elapsed)}</span>}
          <span className="chev"><Icon name="chevronDown" size={13} /></span>
        </button>
        {preview && !open && <div className="think-preview">…{preview}</div>}
        <div className="thinking-wrap"><div className="thinking-body">{text}</div></div>
      </div>
    </div>
  );
}

function lastLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l.length > 140 ? l.slice(-140) : l;
  }
  return "";
}

/** Ticks ~4×/s while `since` is set; returns elapsed ms or null when idle. */
function useElapsed(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const iv = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(iv);
  }, [since]);
  return since === null ? null : Math.max(0, now - since);
}

/** Live status line: breathing orb + shimmering activity verb + elapsed. */
/** Pick the mark's animation from the activity verb: smooth flow while writing
 *  the reply, fast tick while running a tool, plain tick while reasoning. */
function moodForVerb(verb: string): MascotMood {
  if (/respond|writ|generat|stream|draft/i.test(verb)) return "streaming";
  if (/run|read|search|edit|creat|fetch|call|tool|execut/i.test(verb)) return "tool";
  return "thinking";
}

function StatusLine({ activity, turnStart }: { activity: Activity; turnStart: number | null }): React.ReactElement {
  const elapsed = useElapsed(turnStart);
  return (
    <div className="status-line">
      <Logo size={24} mood={moodForVerb(activity.verb)} className="status-mark" />
      <span className="status-shimmer">
        {activity.verb}
        {activity.target && <span className="status-target"> {activity.target}</span>}…
      </span>
      {elapsed !== null && elapsed > 900 && <span className="status-elapsed">{fmtDur(elapsed)}</span>}
    </div>
  );
}

/** Folded post-turn drawer: "Worked for 14s · 4 steps" → full tool cards. */
function StepsDrawer({ tools, durationMs }: { tools: Extract<Item, { kind: "tool" }>[]; durationMs: number }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="row assistant">
      <div className={`steps ${open ? "open" : ""}`}>
        <button className="steps-head" onClick={() => setOpen((o) => !o)}>
          <span className="steps-tick"><Icon name="check" size={13} /></span>
          {durationMs > 0 ? `Worked for ${fmtDur(durationMs)}` : `Ran ${tools.length} steps`}
          {durationMs > 0 && <span className="steps-n">· {tools.length} steps</span>}
          <span className="chev"><Icon name="chevronDown" size={13} /></span>
        </button>
        {open && (
          <div className="steps-body">
            {tools.map((t) => <ToolCard key={t.id} it={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}
