/**
 * my-code-desktop — top-level shell.
 *
 * Claude-Desktop-style layout: frameless title bar with Chat/Code mode tabs,
 * a left sidebar (new chat / recents / account), and a main pane holding the
 * transcript + composer. Backend events (relayed from `my-code serve`) are
 * reduced into a flat transcript of typed items and rendered by <Transcript/>.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import { Transcript } from "./components/Transcript";
import { ApprovalDock } from "./components/ApprovalDock";
import { Settings, type SettingsSection } from "./components/Settings";
import { Logo, type MascotMood } from "./components/Logo";
import { Icon, type IconName } from "./components/Icon";
import { TurnHud } from "./components/TurnHud";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { applyAccent, applyAppearance } from "./theme";
import type {
  Bootstrap,
  EngineEvent,
  HistoryMessage,
  Mode,
  PermissionChoice,
  SessionMeta,
} from "../../electron/ipc";
import type { Activity, Item, PendingPermission, ToolItem, TurnReceipt } from "./transcript";

let _seq = 0;
const newId = () => `i${(_seq++).toString(36)}`;

export function App(): React.ReactElement {
  const [mode, setMode] = useState<Mode>("chat");
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [mood, setMood] = useState("idle");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [perm, setPerm] = useState<PendingPermission | null>(null);
  const [tokens, setTokens] = useState<{ prompt?: number; completion?: number }>({});
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [receipt, setReceipt] = useState<TurnReceipt | null>(null);
  const turnStartRef = useRef<number | null>(null);
  const tokensRef = useRef<number | undefined>(undefined);
  const [convTitle, setConvTitle] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [preferredName, setPreferredName] = useState<string>("");
  const [seed, setSeed] = useState<string>("");
  const seenPerm = useRef<Set<string>>(new Set());
  const booted = useRef(false);

  const refreshSessions = useCallback(() => {
    void window.mycode.listSessions().then(setSessions).catch(() => {});
  }, []);

  // Pull appearance + identity prefs and apply them to <html>. Re-run when the
  // settings modal closes so changes reflect without a restart.
  const syncAppearance = useCallback(() => {
    void window.mycode.getTheme().then((t) => {
      applyAccent(t.accent, t.accentHover);
      applyAppearance(t);
      setPreferredName(t.preferredName ?? "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (booted.current) return; // fire once even under StrictMode double-mount
    booted.current = true;
    syncAppearance();
    void (async () => {
      const b = await window.mycode.bootstrap();
      setBoot(b);
      setMode(b.mode);
      refreshSessions();
    })();
  }, [refreshSessions, syncAppearance]);

  // Reduce backend events into the transcript.
  useEffect(() => {
    return window.mycode.onEngineEvent((ev: EngineEvent) => {
      switch (ev.type) {
        case "state":
          setMood(ev.state);
          setBusy(ev.state !== "idle");
          return;
        case "turn_start":
          setTurnStart(Date.now());
          turnStartRef.current = Date.now();
          setReceipt(null);
          setActivity({ verb: "Thinking" });
          return;
        case "assistant_delta":
          setActivity(null); // visible streaming text IS the status
          setItems((xs) => appendAssistant(xs, ev.text));
          return;
        case "assistant_done":
          setItems((xs) => finalizeAssistant(xs, ev.text));
          return;
        case "reasoning_delta":
          setActivity((a) => (a?.verb === "Thinking" ? a : { verb: "Thinking" }));
          setItems((xs) => appendThinking(xs, ev.text));
          return;
        case "reasoning_done":
          setItems((xs) => finalizeThinking(xs, ev.durationMs));
          return;
        case "tool_start":
          setActivity(activityFor(ev.name, ev.args));
          setItems((xs) => [
            ...xs,
            {
              kind: "tool",
              id: newId(),
              toolUseId: ev.toolUseId,
              name: ev.name,
              args: ev.args,
              running: true,
              startedAt: Date.now(),
            },
          ]);
          return;
        case "tool_result":
          setItems((xs) => resolveTool(xs, ev));
          return;
        case "permission_request":
          if (seenPerm.current.has(ev.toolUseId)) return; // dedupe the engine's late re-yield
          seenPerm.current.add(ev.toolUseId);
          setPerm({
            toolUseId: ev.toolUseId,
            name: ev.name,
            args: ev.args,
            suggestedRules: ev.suggestedRules,
          });
          return;
        case "token_stats":
          setTokens({ prompt: ev.promptTokens, completion: ev.completionTokens });
          tokensRef.current = ev.completionTokens;
          return;
        case "notice":
          setItems((xs) => [...xs, { kind: "notice", id: newId(), tone: ev.tone, text: ev.message }]);
          return;
        case "backend_error":
          // A backend error ends the turn — stop the "thinking" indicator so the
          // mascot/shimmer don't hang forever waiting for a state:idle that a
          // failed request never sends.
          setItems((xs) => [...xs, { kind: "notice", id: newId(), tone: "error", text: ev.message }]);
          setBusy(false);
          setMood("idle");
          setActivity(null);
          return;
        case "turn_end": {
          // Receipt before folding: count this turn's tool calls (incl. already-run tools).
          const turnItems = itemsSinceLastUser(itemsRef.current);
          const steps = turnItems.reduce(
            (n, it) => n + (it.kind === "tool" ? 1 : it.kind === "steps" ? it.tools.length : 0),
            0
          );
          if (turnStartRef.current) {
            setReceipt({ durationMs: Date.now() - turnStartRef.current, steps, tokens: tokensRef.current });
          }
          setItems((xs) => foldToolRuns(clearStreaming(xs)));
          setBusy(false);
          setMood("idle");
          setActivity(null);
          refreshSessions();
          return;
        }
      }
    });
  }, [refreshSessions]);

  // Backend restarts (account/model/permission changes) push fresh state so the
  // model badge and session id never go stale while the settings modal is open.
  useEffect(() => {
    return window.mycode.onBootstrapChanged((b) => setBoot(b));
  }, []);

  useEffect(() => {
    return window.mycode.onClearTranscript(() => {
      setItems([]);
      setConvTitle(null);
      seenPerm.current.clear();
      setTokens({});
      setSeed("");
      setTurnStart(null);
      setActivity(null);
      setReceipt(null);
    });
  }, []);

  // Replay a resumed session's stored messages into the transcript.
  useEffect(() => {
    return window.mycode.onLoadTranscript((messages) => {
      setItems(foldToolRuns(historyToItems(messages)));
      setTurnStart(null);
      setActivity(null);
      setReceipt(null);
    });
  }, []);

  const submit = (text: string) => {
    if (!text.trim()) return;
    setConvTitle((t) => t ?? text.slice(0, 48));
    setItems((xs) => [...xs, { kind: "user", id: newId(), text }]);
    void window.mycode.sendPrompt(text);
  };

  // Stable message/error-card actions (kept stable so memoized rows don't churn).
  const itemsRef = useRef<Item[]>(items);
  itemsRef.current = items;
  const onRetry = useCallback(() => {
    const xs = itemsRef.current;
    for (let i = xs.length - 1; i >= 0; i--) {
      const it = xs[i];
      if (it.kind === "user") {
        setItems((p) => [...p, { kind: "user", id: newId(), text: it.text }]);
        void window.mycode.sendPrompt(it.text);
        return;
      }
    }
  }, []);
  const onEditMsg = useCallback((text: string) => setSeed(text + " "), []);
  const onOpenSettingsCb = useCallback(() => setSettingsSection("general"), []);

  // Error-card Retry. A "Something went wrong" card usually means the serve
  // process is dead — resending a prompt into a dead bridge vanishes silently.
  // Restart the backend first (with visible progress), then resend the last
  // user prompt only if it never got an answer.
  const onRetryBackend = useCallback(async () => {
    setItems((p) => [...p, { kind: "notice", id: newId(), tone: "info", text: "Restarting backend…" }]);
    setBusy(true);
    setMood("thinking");
    try {
      const b = await window.mycode.restartBackend();
      setBoot(b);
      if (b.model === "—") return; // failed again — a backend_error card explains why
      setItems((p) => [...p, { kind: "notice", id: newId(), tone: "info", text: `Backend ready (${b.model}).` }]);
      const xs = itemsRef.current;
      for (let i = xs.length - 1; i >= 0; i--) {
        const it = xs[i];
        if (it.kind === "assistant" && !it.streaming) return; // last prompt was answered
        if (it.kind === "user") {
          void window.mycode.sendPrompt(it.text);
          return;
        }
      }
    } finally {
      setBusy(false);
      setMood("idle");
    }
  }, []);

  // Ctrl/⌘+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const answer = (choice: PermissionChoice) => {
    if (!perm) return;
    void window.mycode.answerPermission(perm.toolUseId, choice);
    setPerm(null);
  };

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    let cwd: string | undefined;
    if (next === "code") {
      const picked = await window.mycode.pickFolder();
      if (!picked) return; // cancelled — stay in current mode
      cwd = picked;
    }
    const b = await window.mycode.setMode(next, cwd);
    setMode(next);
    setBoot(b);
    setConvTitle(null);
    refreshSessions();
  };

  const newChat = async () => {
    const b = await window.mycode.newSession();
    setBoot(b);
    setConvTitle(null);
  };

  const resume = async (id: string) => {
    if (loadingId) return;
    setLoadingId(id);
    try {
      const b = await window.mycode.resumeSession(id);
      setBoot(b);
      const s = sessions.find((x) => x.id === id);
      setConvTitle(s?.firstPrompt ?? "Resumed session");
    } finally {
      setLoadingId(null);
    }
  };

  const renameSession = async (id: string, title: string) => {
    await window.mycode.renameSession(id, title);
    refreshSessions();
  };

  const deleteSession = async (id: string) => {
    await window.mycode.deleteSession(id);
    refreshSessions();
  };

  const commands: Command[] = [
    { id: "new", label: `New ${mode === "code" ? "task" : "chat"}`, run: () => void newChat() },
    { id: "mode", label: mode === "code" ? "Switch to Chat mode" : "Switch to Code mode", run: () => void switchMode(mode === "code" ? "chat" : "code") },
    { id: "settings", label: "Open settings", run: () => setSettingsSection("general") },
    ...sessions.slice(0, 6).map((s) => ({
      id: s.id,
      label: `Open: ${s.firstPrompt ?? s.id}`,
      group: "Recent chats",
      run: () => void resume(s.id),
    })),
  ];

  return (
    <div className="app">
      {/* ambient premium layer — living mesh gradient + grain + vignette */}
      <div className="app-bg" aria-hidden="true"><b /><b /><b /><b /></div>
      <div className="app-grain" aria-hidden="true" />
      <div className="app-vignette" aria-hidden="true" />
      <TitleBar
        mode={mode}
        onMode={switchMode}
        onOpenSettings={() => setSettingsSection("general")}
        onOpenCommand={() => setCmdkOpen(true)}
        mood={busy ? (mood as MascotMood) : undefined}
      />
      <div className="app-body">
        <Sidebar
          boot={boot}
          mode={mode}
          sessions={sessions}
          activeTitle={convTitle}
          loadingId={loadingId}
          onNewChat={newChat}
          onResume={resume}
          onRename={renameSession}
          onDelete={deleteSession}
          onOpenSettings={(section) => setSettingsSection(section ?? "general")}
        />
        <main className="main">
          <div className="main-head">
            <span className="main-title">{convTitle ?? (mode === "code" ? "New task" : "New chat")}</span>
            {boot?.cwd && <span className="cwd-chip" title={boot.cwd}>{shorten(boot.cwd)}</span>}
            <TurnHud busy={busy} tokens={tokens} turnStart={turnStart} />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {items.length === 0 ? (
              <motion.div
                key="hero"
                className="hero"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -18, scale: 0.985 }}
                transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.7 }}
              >
                <div className="hero-inner">
                  <Logo size={60} tile className="hero-logo" mood={busy ? (mood as MascotMood) : "idle"} />
                  <h1 className="hero-greeting">{greeting(mode, preferredName)}</h1>
                  <Composer
                    mode={mode}
                    model={boot?.model ?? "…"}
                    busy={busy}
                    tokens={tokens}
                    contextLength={boot?.contextLength}
                    variant="hero"
                    seed={seed}
                    onSubmit={submit}
                    onAbort={() => void window.mycode.abort()}
                  />
                  <div className="starter-chips">
                    {starterChips(mode).map((c, i) => (
                      <button
                        key={c.label}
                        className="starter-chip"
                        style={{ animationDelay: `${0.12 + i * 0.07}s` }}
                        onClick={() => setSeed(c.prompt + " ")}
                      >
                        <Icon name={c.icon} size={15} /> {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="chat"
                className="chat-view"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 30, mass: 0.7, delay: 0.04 }}
              >
                <Transcript
                  items={items}
                  mode={mode}
                  busy={busy}
                  mood={mood}
                  activity={activity}
                  turnStart={turnStart}
                  receipt={receipt}
                  greeting={preferredName}
                  onRetry={onRetry}
                  onRetryBackend={onRetryBackend}
                  onEdit={onEditMsg}
                  onOpenSettings={onOpenSettingsCb}
                />
                {perm && <ApprovalDock req={perm} cwd={boot?.cwd ?? null} onAnswer={answer} />}
                <Composer
                  mode={mode}
                  model={boot?.model ?? "…"}
                  busy={busy}
                  tokens={tokens}
                  contextLength={boot?.contextLength}
                  variant="docked"
                  seed={seed}
                  onSubmit={submit}
                  onAbort={() => void window.mycode.abort()}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
      {settingsSection && <Settings initialSection={settingsSection} onClose={() => { setSettingsSection(null); syncAppearance(); }} />}
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} commands={commands} />
    </div>
  );
}

// ─── transcript reducers ───

function appendAssistant(xs: Item[], text: string): Item[] {
  const last = xs[xs.length - 1];
  if (last?.kind === "assistant" && last.streaming) {
    return [...xs.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...xs, { kind: "assistant", id: newId(), text, streaming: true }];
}
function finalizeAssistant(xs: Item[], text: string): Item[] {
  const last = xs[xs.length - 1];
  if (last?.kind === "assistant" && last.streaming) {
    return [...xs.slice(0, -1), { ...last, text: text || last.text, streaming: false }];
  }
  return text ? [...xs, { kind: "assistant", id: newId(), text, streaming: false }] : xs;
}
function appendThinking(xs: Item[], text: string): Item[] {
  const last = xs[xs.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    return [...xs.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...xs, { kind: "thinking", id: newId(), text, streaming: true, startedAt: Date.now() }];
}
function finalizeThinking(xs: Item[], durationMs: number): Item[] {
  const last = xs[xs.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    return [...xs.slice(0, -1), { ...last, streaming: false, durationMs }];
  }
  return xs;
}
function resolveTool(xs: Item[], ev: Extract<EngineEvent, { type: "tool_result" }>): Item[] {
  return xs.map((it) =>
    it.kind === "tool" && it.toolUseId === ev.toolUseId
      ? {
          ...it,
          running: false,
          durationMs: it.startedAt ? Date.now() - it.startedAt : undefined,
          result: ev.result,
          isError: ev.isError,
          diff: ev.diff,
          children: ev.children,
        }
      : it
  );
}

/** Everything after (not including) the last user message — the current turn. */
function itemsSinceLastUser(xs: Item[]): Item[] {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i].kind === "user") return xs.slice(i + 1);
  }
  return xs;
}

/**
 * Fold runs of ≥2 consecutive finished tool cards into one "steps" drawer so a
 * tool-heavy turn collapses to a single line once it's over. Existing drawers
 * and everything else pass through untouched.
 */
function foldToolRuns(xs: Item[]): Item[] {
  const out: Item[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= 2 && !run.some((t) => t.isError)) {
      out.push({
        kind: "steps",
        id: newId(),
        tools: run,
        durationMs: run.reduce((s, t) => s + (t.durationMs ?? 0), 0),
      });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const it of xs) {
    if (it.kind === "tool" && !it.running) run.push(it);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

/** Map a tool call to the live status verb ("Reading backend.ts…"). */
function activityFor(name: string, args: Record<string, unknown>): Activity {
  const n = name.toLowerCase();
  const a = args as Record<string, string>;
  const base = (p?: string) => (p ? p.toString().split(/[\\/]/).pop() : undefined);
  if (/(read|view|cat|open)/.test(n)) return { verb: "Reading", target: base(a.file_path ?? a.path) };
  if (/(edit|write|multiedit|patch|apply)/.test(n)) return { verb: "Editing", target: base(a.file_path ?? a.path) };
  if (/(bash|shell|powershell|pwsh|exec|command)/.test(n)) return { verb: "Running command" };
  if (/(grep|glob|search|find)/.test(n)) return { verb: "Searching", target: a.pattern ?? a.query };
  if (/(webfetch|websearch|web|fetch|http|browse)/.test(n)) return { verb: "Browsing", target: a.url ?? a.query };
  if (/^task|agent/.test(n)) return { verb: "Delegating" };
  return { verb: `Using ${name}` };
}
function clearStreaming(xs: Item[]): Item[] {
  return xs.map((it) => {
    if (it.kind === "assistant" && it.streaming) return { ...it, streaming: false };
    if (it.kind === "thinking" && it.streaming) return { ...it, streaming: false };
    if (it.kind === "tool" && it.running) return { ...it, running: false };
    return it;
  });
}

/** Map a resumed conversation (ChatMessage[]) into transcript items. */
function historyToItems(messages: HistoryMessage[]): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, number>(); // tool_call_id → items index
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (m.content?.trim()) items.push({ kind: "user", id: newId(), text: m.content });
    } else if (m.role === "assistant") {
      if (m.content?.trim()) {
        items.push({ kind: "assistant", id: newId(), text: m.content, streaming: false });
      }
      for (const tc of m.tool_calls ?? []) {
        // Stored arguments may be a JSON string OR an already-parsed object.
        let args: Record<string, unknown> = {};
        const raw = tc.function.arguments;
        if (typeof raw === "string") {
          try {
            args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            /* leave empty */
          }
        } else if (raw && typeof raw === "object") {
          args = raw;
        }
        const idx = items.length;
        items.push({
          kind: "tool",
          id: newId(),
          toolUseId: tc.id ?? `h${idx}`,
          name: tc.function.name,
          args,
          running: false,
        });
        if (tc.id) toolIndex.set(tc.id, idx);
      }
    } else if (m.role === "tool") {
      const idx = m.tool_call_id ? toolIndex.get(m.tool_call_id) : undefined;
      if (idx !== undefined) {
        const it = items[idx];
        if (it.kind === "tool") {
          it.result = m.content;
          it.isError = /^error/i.test(m.content ?? "");
        }
      } else {
        items.push({
          kind: "tool",
          id: newId(),
          toolUseId: m.tool_call_id ?? newId(),
          name: m.tool_name ?? "tool",
          args: {},
          running: false,
          result: m.content,
        });
      }
    }
  }
  return items;
}

/** Time-aware, mode-aware greeting for the home hero, personalised if a name is set. */
function greeting(mode: Mode, name?: string): string {
  const h = new Date().getHours();
  const time =
    h >= 5 && h < 12 ? "Good morning" :
    h >= 12 && h < 17 ? "Good afternoon" :
    h >= 17 && h < 21 ? "Good evening" :
    "Burning the midnight oil";
  const who = name?.trim() ? `, ${name.trim().split(/\s+/)[0]}` : "";
  return mode === "code" ? `${time}${who} — what are we building?` : `${time}${who}. How can I help?`;
}

interface Starter { label: string; prompt: string; icon: IconName }
function starterChips(mode: Mode): Starter[] {
  return mode === "code"
    ? [
        { label: "Explain this repo", prompt: "Explain how this project is structured and what it does.", icon: "book" },
        { label: "Fix a bug", prompt: "There's a bug: ", icon: "puzzle" },
        { label: "Write tests", prompt: "Write tests for ", icon: "check" },
        { label: "Review changes", prompt: "Review my current git diff for issues.", icon: "search" },
      ]
    : [
        { label: "Draft an email", prompt: "Draft an email to ", icon: "edit" },
        { label: "Summarize", prompt: "Summarize this: ", icon: "book" },
        { label: "Brainstorm", prompt: "Help me brainstorm ideas for ", icon: "sparkle" },
        { label: "Explain", prompt: "Explain ", icon: "search" },
      ];
}
function shorten(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}
