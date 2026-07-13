import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { PendingPermission } from "../transcript";
import type { PermissionChoice } from "../../../electron/ipc";

export interface ApprovalDockProps {
  req: PendingPermission;
  cwd: string | null;
  onAnswer: (choice: PermissionChoice) => void;
}

/** Best-effort one-line preview of what the tool is about to do. */
function preview(args: Record<string, unknown>): string {
  const a = args as Record<string, string>;
  const direct = (a.command ?? a.file_path ?? a.path ?? a.url ?? a.pattern ?? "").toString();
  if (direct) return direct;
  const entries = Object.entries(args).filter(([, v]) => v != null);
  if (entries.length === 0) return "";
  const line = entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ");
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}

/** Coarse risk class derived from the tool name — best-effort, err on no badge. */
function riskOf(name: string): { label: string; cls: "read" | "write" } | null {
  if (/^(Edit|Write|NotebookEdit)$/.test(name)) return { label: "writes file", cls: "write" };
  if (name === "Bash") return { label: "runs command", cls: "write" };
  if (/^(Read|Glob|Grep|WebFetch|WebSearch)$/.test(name)) return { label: "read-only", cls: "read" };
  if (/(^|_)(list|get|search|read|fetch|find)(_|$)/i.test(name)) return { label: "read-only", cls: "read" };
  return null;
}

interface Choice {
  key: PermissionChoice;
  label: string;
  why: string;
  title?: string;
  deny?: boolean;
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * Inline permission prompt docked above the composer — a numbered choice list
 * answered with ↑/↓ + Enter, digits 1–4, or Esc to deny. Replaces the old
 * centered PermissionModal: no backdrop, the transcript stays scrollable.
 */
export function ApprovalDock({ req, cwd, onAnswer }: ApprovalDockProps): React.ReactElement {
  const detail = preview(req.args);
  const risk = riskOf(req.name);
  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const choices: Choice[] = [
    { key: "once", label: "Allow once", why: "just this call" },
    { key: "session", label: "Allow for this session", why: "until this chat ends", title: req.suggestedRules.session },
    { key: "project", label: `Always allow ${req.name}`, why: "saved to project settings", title: req.suggestedRules.project },
    { key: "no", label: "Deny, and tell my-code what to do differently", why: "esc", deny: true },
  ];

  const answer = (choice: PermissionChoice) => {
    onAnswer(choice);
    if (choice === "no") {
      // Denying almost always means "do something else instead" — hand the
      // keyboard straight to the composer so the user can redirect the agent.
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
      });
    }
  };

  useEffect(() => {
    listRef.current?.querySelectorAll("button")[focused]?.focus({ preventScroll: true });
  }, [focused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        answer("no");
        e.preventDefault();
        return;
      }
      // Don't steal digits/arrows/Enter from the composer while the user types.
      if (isEditable(e.target)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setFocused((i) => (i + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
        e.preventDefault();
      } else if (e.key >= "1" && e.key <= "4") {
        answer(choices[Number(e.key) - 1].key);
        e.preventDefault();
      } else if (e.key === "Enter" && !isEditable(document.activeElement)) {
        answer(choices[focused].key);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, req.toolUseId]);

  return (
    <div className="approval-dock-wrap">
      <div className="approval-dock" role="alertdialog" aria-label="Permission request">
        <div className="ad-head">
          <span className="ad-glyph"><Icon name="dot" size={11} /></span>
          <span className="ad-title">
            my-code wants to run <code className="ad-tool">{req.name}</code>
          </span>
          {risk && <span className={`ad-risk ${risk.cls}`}>{risk.label}</span>}
        </div>
        {detail && <pre className="ad-preview">{detail}</pre>}
        {cwd && <div className="ad-cwd">in {cwd}</div>}
        <div className="ad-choices" ref={listRef}>
          {choices.map((c, i) => (
            <button
              key={c.key}
              className={`ad-choice${i === focused ? " focused" : ""}${c.deny ? " deny" : ""}`}
              title={c.title}
              onMouseEnter={() => setFocused(i)}
              onClick={() => answer(c.key)}
            >
              <span className="ad-num">{i + 1}</span>
              <span className="ad-label">{c.label}</span>
              <span className="ad-why">{c.why}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
