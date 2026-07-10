import React, { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import type { Item } from "../transcript";
import type { DiffPayload } from "../../../electron/ipc";

type ToolItem = Extract<Item, { kind: "tool" }>;

/** Map a tool name to a colored icon tile + whether its output is shell-like. */
function toolVisual(name: string): { icon: IconName; cls: string } {
  const n = name.toLowerCase();
  if (/(bash|shell|powershell|pwsh|exec|command|run)/.test(n)) return { icon: "terminal", cls: "t-bash" };
  if (/(read|view|cat|open)/.test(n)) return { icon: "eye", cls: "t-read" };
  if (/(edit|write|multiedit|create|apply|patch)/.test(n)) return { icon: "edit", cls: "t-edit" };
  if (/(grep|glob|search|find|ripgrep)/.test(n)) return { icon: "search", cls: "t-search" };
  if (/(web|fetch|http|url|browse)/.test(n)) return { icon: "globe", cls: "t-web" };
  if (/^task/.test(n)) return { icon: "check", cls: "t-task" };
  if (/(skill|mcp)/.test(n)) return { icon: "puzzle", cls: "t-mcp" };
  return { icon: "dot", cls: "t-default" };
}
function isShellTool(name: string): boolean {
  return /(bash|shell|powershell|pwsh|exec|command)/i.test(name);
}

/** One-line summary of a tool's target (path / pattern / command). */
function summarize(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>;
  return (
    a.file_path ?? a.path ?? a.pattern ?? a.command ?? a.query ?? a.url ?? a.prompt ?? ""
  ).toString();
}

/** "0.3s" / "2.1s" / "1m 12s" — used by tool metrics, thinking, and the receipt. */
export function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1).replace(/\.0$/, "") + "s";
  if (s < 60) return Math.round(s) + "s";
  return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
}

/** Result metric for a finished tool ("58 lines", "+9 −1", "3 matches"). */
function metric(it: ToolItem): string {
  if (it.diff) {
    const add = it.diff.after.split("\n").length;
    const del = it.diff.before.split("\n").length;
    return `+${add} −${del}`;
  }
  if (!it.result) return "";
  const lines = it.result.split("\n").filter((l) => l.trim()).length;
  const n = it.name.toLowerCase();
  if (/(grep|glob|search|find)/.test(n)) return `${lines} match${lines === 1 ? "" : "es"}`;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

/** Live elapsed while running (ticks 4×/s). */
function useElapsed(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const iv = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(iv);
  }, [since]);
  return since === null ? null : Math.max(0, now - since);
}

export const ToolCard = React.memo(ToolCardImpl);

/**
 * Lifecycle: expanded while running (args visible, pulsing border) →
 * auto-collapses to a one-line receipt with a result metric + duration →
 * errors stay expanded. The user can always re-toggle; a manual toggle
 * overrides the automatic state from then on.
 */
function ToolCardImpl({ it }: { it: ToolItem }): React.ReactElement {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (it.running || !!it.isError);
  const visual = toolVisual(it.name);
  const shell = isShellTool(it.name);
  const summary = summarize(it.name, it.args);
  const status = it.running ? "running" : it.isError ? "error" : "done";
  const elapsed = useElapsed(it.running ? it.startedAt ?? null : null);
  const hasBody = it.running || !!it.result || !!it.diff;
  const m = !it.running ? metric(it) : "";

  return (
    <div className={`tool-card ${status} ${open ? "open" : ""}`}>
      <button
        className={`tool-head ${hasBody ? "" : "static"}`}
        onClick={hasBody ? () => setManual(!open) : undefined}
      >
        <span className={`tool-tile ${visual.cls} ${it.isError ? "err" : ""}`}>
          {it.running ? (
            <Icon name="spinner" size={13} className="icon-spin" />
          ) : it.isError ? (
            <Icon name="close" size={12} />
          ) : (
            <Icon name={visual.icon} size={13} />
          )}
        </span>
        <span className="tool-name">{it.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-metric">
          {it.running ? (
            elapsed !== null && elapsed > 900 ? fmtDur(elapsed) : ""
          ) : (
            <>
              {it.isError
                ? <span className="tm-err">error</span>
                : <span className="tm-ok"><Icon name="check" size={12} /></span>}
              {m && <> {m}</>}
              {it.durationMs !== undefined && <> · {fmtDur(it.durationMs)}</>}
            </>
          )}
        </span>
        {hasBody && <span className="chev"><Icon name="chevronDown" size={14} /></span>}
      </button>

      {/* Args strip — visible whenever the card is open (always while running). */}
      {open && summary && (
        <div className={`tool-args ${shell ? "term" : ""}`}>
          {shell ? <span className="ta-prompt">$ </span> : null}
          {summary}
        </div>
      )}

      {it.diff && open && <DiffView diff={it.diff} />}

      {it.children && it.children.length > 0 && (
        <div className="subagent">
          {it.children.map((c, i) => (
            <div key={i} className={`sub-tool ${c.isError ? "error" : ""}`}>
              <span className="tool-glyph"><Icon name={c.isError ? "close" : "dot"} size={10} /></span>
              <span className="tool-name">{c.name}</span>
              <span className="tool-summary">{summarize(c.name, c.args)}</span>
            </div>
          ))}
        </div>
      )}

      {!it.diff && it.result && (
        <div className="tool-wrap">
          <div className="tool-inner">
            <pre className={`tool-result ${shell ? "term" : ""}`}>{it.result.slice(0, 4000)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: DiffPayload }): React.ReactElement {
  const before = diff.before.split("\n");
  const after = diff.after.split("\n");
  // Stagger the reveal, but cap the delay so a large diff doesn't crawl in.
  const delay = (n: number): React.CSSProperties => ({ animationDelay: `${Math.min(n, 24) * 0.018}s` });
  return (
    <div className="diff">
      <div className="diff-file">{diff.filePath}</div>
      <pre className="diff-body">
        {before.map((l, i) => (
          <div key={`b${i}`} className="diff-line del" style={delay(i)}>
            <span className="ln">{diff.startLine + i}</span>- {l}
          </div>
        ))}
        {after.map((l, i) => (
          <div key={`a${i}`} className="diff-line add" style={delay(before.length + i)}>
            <span className="ln">{diff.startLine + i}</span>+ {l}
          </div>
        ))}
      </pre>
    </div>
  );
}
