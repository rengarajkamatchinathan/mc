import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { RichInput } from "./RichInput.js";
import { MessageBlock } from "./MessageBlock.js";
import { StatusLine } from "./StatusLine.js";
import { StatusScreen } from "./StatusScreen.js";
import { UsageScreen } from "./UsageScreen.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { ModelPicker } from "./ModelPicker.js";
import { AccountsOverlay } from "./AccountsOverlay.js";
import { providerFromAccount, ProviderNotWiredError } from "../agent/providers/index.js";
import { setActiveAccount, getActiveAccount, isProviderWired, type ProviderAccount } from "../config/accounts.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { VirtualMessageList } from "./VirtualMessageList.js";
import { pickVerb } from "./verbs.js";
import { VERSION } from "../version.js";
import type { TranscriptItem } from "./types.js";
import type { PermissionChoice } from "./types-perms.js";
import type { QueryEngine } from "../agent/QueryEngine.js";
import type { ChatProvider } from "../agent/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionEngine } from "../config/permissions.js";
import type { SessionStats as SessionStatsClass } from "../session/stats.js";
import { costFor, formatCost } from "../session/pricing.js";
import type { PricingTable } from "../session/pricing.js";
import { TranscriptWriter } from "../session/transcript.js";
import type { TranscriptEvent } from "../session/transcript.js";
import type { ChatMessage } from "../agent/types.js";
import {
  AppStateProvider,
  useAppSelector,
  useAppStore,
} from "../state/AppStateContext.js";
import type { AppState } from "../state/AppState.js";
import { createInitialAppState } from "../state/AppState.js";
import type { SessionEvent } from "../agent/events.js";
import { createCommandRegistry, type CommandContext } from "../commands/index.js";
import { pollTasks } from "../utils/task/framework.js";
import { dequeue, getCommandQueueLength } from "../utils/messageQueueManager.js";
import { backgroundAll } from "../tasks/LocalShellTask/LocalShellTask.js";
import { getBranchSync, getBranch } from "../utils/git.js";
import { formatTokens } from "../session/stats.js";
import { CORNER } from "./figures.js";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

interface Props {
  engine: QueryEngine;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  stats: SessionStatsClass;
  pricing: PricingTable;
  cwd: string;
  model: string;
  provider: ChatProvider;
  yolo: boolean;
  modelOrigin?: string;
  transcript?: TranscriptWriter;
  /** Restored messages from a resumed session — pre-populates the display. */
  initialMessages?: import("../agent/types.js").ChatMessage[];
}


interface PendingPerm {
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
  suggestedRules: { session: string; project: string };
  resolve: (d: PermissionChoice) => void;
}

/**
 * Convert a ChatMessage array (from resumed session) into TranscriptItems
 * so the TUI can render the full conversation history on load.
 *
 * - user / assistant messages → shown as-is
 * - system message (index 0, the system prompt) → skipped
 * - tool messages → collapsed into a single "history" notice
 */
function chatMessagesToTranscriptItems(
  messages: import("../agent/types.js").ChatMessage[]
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let toolCount = 0;

  for (const msg of messages) {
    if (msg.role === "system") continue; // skip system prompt
    if (msg.role === "user") {
      // Skip synthetic [system] injections (task notifications, LSP, max-iter)
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.startsWith("[system]") || content.startsWith("<lsp_") || content.startsWith("<task_notification")) continue;
      items.push({ kind: "user", content, id: nextId() });
    } else if (msg.role === "assistant") {
      // Count tool_calls but don't render them individually
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolCount += msg.tool_calls.length;
      }
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.trim()) {
        items.push({ kind: "assistant", content, id: nextId() });
      }
    } else if (msg.role === "tool") {
      toolCount++;
    }
  }

  // Prepend a resume notice so the user knows history was loaded
  const userCount = items.filter((i) => i.kind === "user").length;
  if (userCount > 0 || toolCount > 0) {
    items.unshift({
      kind: "system",
      content: `─── resumed session · ${userCount} exchange${userCount !== 1 ? "s" : ""} · ${toolCount} tool call${toolCount !== 1 ? "s" : ""} ───`,
      id: nextId(),
      tone: "info",
    });
  }

  return items;
}

export function App(props: Props): React.ReactElement {
  const initial = useMemo<AppState>(
    () => {
      const base = createInitialAppState({
        model: props.model,
        bypassAll: props.permissions.bypassAll,
        editMode: props.permissions.mode,
      });
      // Pre-populate finalized with restored conversation history
      if (props.initialMessages && props.initialMessages.length > 0) {
        const items = chatMessagesToTranscriptItems(props.initialMessages);
        return { ...base, finalized: items };
      }
      return base;
    },
    // intentionally only props.model for the init — mode/bypass sync via yolo effect
    [props.model]
  );
  return (
    <AppStateProvider initialState={initial}>
      <AppInner {...props} />
    </AppStateProvider>
  );
}

function AppInner({
  engine,
  registry,
  permissions,
  stats,
  pricing,
  cwd,
  provider: initialProvider,
  yolo,
  modelOrigin,
  transcript,
}: Props): React.ReactElement {
  const { exit } = useApp();
  const { getAppState, setAppState } = useAppStore();

  // Provider is mutable at runtime so the user can switch accounts mid-session.
  // Seeded from the prop; swapped via switchAccount() below.
  const [provider, setActiveProvider] = useState<ChatProvider>(initialProvider);
  // Active account name for the status bar (loaded once, updated on switch).
  const [accountName, setAccountName] = useState<string | undefined>(undefined);
  useEffect(() => {
    getActiveAccount().then((a) => setAccountName(a?.name)).catch(() => {});
  }, []);

  // While the assistant is streaming we render its text OUTSIDE <Static> in
  // Ink's live region — the full content, no cap. Earlier we capped to the
  // last N lines to avoid Ink "ghost lines" when content overflowed the
  // viewport, but that made long responses feel "cut off" mid-stream which
  // is far worse UX. Modern Ink handles overflow into scrollback fine.

  // Reactive slices so the UI re-renders when state changes.
  const finalized = useAppSelector((s) => s.finalized);
  const streamingAssistant = useAppSelector((s) => s.streamingAssistant);
  const streamingReasoning = useAppSelector((s) => s.streamingReasoning);
  const activeTool = useAppSelector((s) => s.activeTool);
  const busy = useAppSelector((s) => s.busy);
  const thinking = useAppSelector((s) => s.thinking);
  const currentModel = useAppSelector((s) => s.currentModel);
  const contextLength = useAppSelector((s) => s.contextLength);
  const promptTokens = useAppSelector((s) => s.promptTokens);
  const completionTokens = useAppSelector((s) => s.completionTokens);
  const lastPromptTokens = useAppSelector((s) => s.lastPromptTokens);
  const bypassAll = useAppSelector((s) => s.bypassAll);
  const editMode = useAppSelector((s) => s.editMode);
  const overlay = useAppSelector((s) => s.overlay);
  const accountsAddMode = useAppSelector((s) => s.accountsAddMode);
  const planMode = useAppSelector((s) => s.planMode);
  const worktreePath = useAppSelector((s) => s.worktreePath);

  // Switch the active provider account at runtime: swap the engine's provider,
  // update the mutable provider state, and persist the choice. Blocks providers
  // that have no chat implementation yet.
  const switchAccount = async (acc: ProviderAccount): Promise<void> => {
    const pushSys = (content: string, tone: "info" | "warn" | "error" = "info") =>
      setAppState((s) => ({
        ...s,
        finalized: [...s.finalized, { kind: "system", content, id: nextId(), tone }],
      }));
    if (!isProviderWired(acc.provider)) {
      pushSys(`cannot switch — provider "${acc.provider}" is not wired for chat yet`, "warn");
      setAppState((s) => ({ ...s, overlay: "none" }));
      return;
    }
    try {
      const p = providerFromAccount(acc);
      engine.setProvider(p);
      setActiveProvider(p);
      setAccountName(acc.name);
      await setActiveAccount(acc.id);
      setAppState((s) => ({
        ...s,
        overlay: "none",
        finalized: [
          ...s.finalized,
          {
            kind: "system",
            content: `account → ${acc.provider}:${acc.name}  (host: ${p.info.host ?? "default"})`,
            id: nextId(),
          },
        ],
      }));
    } catch (e) {
      const msg = e instanceof ProviderNotWiredError ? e.message : e instanceof Error ? e.message : String(e);
      pushSys(`switch failed: ${msg}`, "warn");
    }
  };
  const tasks = useAppSelector((s) => s.tasks);

  // Status-line activity indicators.
  const runningTasks = Object.values(tasks ?? {}).filter(
    (t) => (t as { status?: string } | null)?.status === "running"
  ).length;
  const queuedCount = getCommandQueueLength();

  const [pendingPerm, setPendingPerm] = useState<PendingPerm | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  // Git branch — read synchronously for the first banner paint, then refreshed
  // whenever the active worktree changes.
  const [branch, setBranch] = useState(() => getBranchSync(cwd));
  useEffect(() => {
    let cancelled = false;
    getBranch(worktreePath ?? cwd)
      .then((b) => !cancelled && b && setBranch(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [worktreePath, cwd]);

  // Memoize cost so it's not recomputed on every re-render
  const cost = useMemo(
    () => costFor(provider.info.name, currentModel, promptTokens, completionTokens, pricing),
    [provider, currentModel, promptTokens, completionTokens, pricing]
  );
  const costText = cost === null ? undefined : formatCost(cost);

  // Keyboard bindings (unchanged from the old version).
  useInput((input, key) => {
    if (key.ctrl && input === "d") exit();
    if (key.escape && busy && cancelRef.current) {
      cancelRef.current();
      return;
    }
    if (key.ctrl && input === "o") {
      // Expand whichever expandable block is most recent — a tool result or a
      // collapsed reasoning line. (Items committed to Ink's <Static> can't
      // re-render in place, so we append an expanded copy.)
      const lastExpandable = [...finalized]
        .reverse()
        .find((i) => i.kind === "tool" || i.kind === "reasoning") as
        | (TranscriptItem & { kind: "tool" | "reasoning" })
        | undefined;
      if (lastExpandable?.kind === "reasoning") {
        setAppState((s) => ({
          ...s,
          finalized: [...s.finalized, { ...lastExpandable, id: nextId(), expanded: true }],
        }));
      } else if (lastExpandable?.kind === "tool" && lastExpandable.result) {
        setAppState((s) => ({
          ...s,
          finalized: [...s.finalized, { ...lastExpandable, id: nextId(), expanded: true }],
        }));
      }
      return;
    }
    if (key.ctrl && input === "b" && busy) {
      backgroundAll(getAppState, setAppState);
      return;
    }
    if (key.shift && key.tab) {
      const next = permissions.cycleMode();
      setAppState((s) => ({
        ...s,
        editMode: next,
        bypassAll: permissions.bypassAll,
      }));
      return;
    }
  });

  // Yolo at startup: bypass permissions for the session.
  useEffect(() => {
    if (yolo && !permissions.bypassAll) {
      permissions.setSessionBypass(true);
      setAppState((s) => ({ ...s, bypassAll: true }));
    }
  }, [yolo, permissions, setAppState]);

  // Wire the permission prompt. The engine calls this whenever a tool needs
  // ask-to-run approval; we surface a PermissionPrompt and resolve on choice.
  useEffect(() => {
    engine.setRequestPermission(
      ({ toolUseId, name, args, suggestedRules, signal }) =>
        new Promise<PermissionChoice>((resolve) => {
          const onAbort = () => resolve("no");
          signal.addEventListener("abort", onAbort, { once: true });
          setPendingPerm({
            toolUseId,
            name,
            args,
            suggestedRules,
            resolve: (choice) => {
              signal.removeEventListener("abort", onAbort);
              resolve(choice);
            },
          });
        })
    );
    return () => {
      engine.setRequestPermission(undefined);
    };
  }, [engine]);

  // Fetch context length for the status line (local models only).
  useEffect(() => {
    if (provider.info.isCloud || !provider.getModelInfo) return;
    let cancelled = false;
    provider
      .getModelInfo(currentModel)
      .then((info) => {
        if (!cancelled && info.contextLength) {
          setAppState((s) => ({ ...s, contextLength: info.contextLength }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentModel, provider, setAppState]);

  // Drive the engine on user submit — consume the SessionEvent generator.
  const handleSubmit = async (input: string): Promise<void> => {
    if (busy) return;
    if (input.startsWith("/")) {
      await handleSlash(input);
      return;
    }

    transcript?.append({ type: "user", content: input, at: Date.now() }).catch(() => {});

    let displayItem: TranscriptItem;
    if (input.startsWith("<task_notification>")) {
      const summaryMatch = input.match(/<summary>([\s\S]*?)<\/summary>/);
      const summary = summaryMatch ? summaryMatch[1] : "Background task notification received";
      displayItem = { kind: "system", content: `⚙️ ${summary.trim()}`, id: nextId(), tone: "warn" };
    } else {
      displayItem = { kind: "user", content: input, id: nextId() };
    }

    setAppState((s) => ({
      ...s,
      finalized: [...s.finalized, displayItem],
      busy: true,
      thinking: { verb: pickVerb(), startedAt: Date.now() },
    }));

    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
      engine.abort();
      setAppState((s) => ({
        ...s,
        finalized: [
          ...s.finalized,
          { kind: "system", content: "⊘ Interrupted", id: nextId(), tone: "warn" },
        ],
      }));
    };

    // Coalesce rapid streaming deltas into batched setState calls.
    // Uses a double-buffer pattern: accumulate text, flush on a 50ms tick.
    // This prevents Ink re-rendering on every tiny chunk (the root cause of
    // flicker and ghost lines in the old 33ms setTimeout approach).
    let pendingFlush: ReturnType<typeof setTimeout> | null = null;
    let flushQueued = false;
    const scheduleFlush = (text: string) => {
      if (flushQueued) return; // coalesce: only one flush per tick
      flushQueued = true;
      pendingFlush = setTimeout(() => {
        flushQueued = false;
        pendingFlush = null;
        setAppState((s) => ({ ...s, streamingAssistant: text }));
      }, 50);
    };

    const turnStartedAt = Date.now();
    const beforeTotals = stats.totals();
    let streamText = "";

    try {
      for await (const ev of engine.submitMessage(input)) {
        if (cancelled) break;
        handleEvent(ev, {
          onStreamText: (text) => {
            streamText += text;
            scheduleFlush(streamText);
          },
          onStreamDone: (text) => {
            if (pendingFlush) {
              clearTimeout(pendingFlush);
              pendingFlush = null;
              flushQueued = false;
            }
            streamText = "";
            setAppState((s) => ({
              ...s,
              streamingAssistant: "",
              finalized: text.trim()
                ? [
                    ...s.finalized,
                    { kind: "assistant", content: text, id: nextId() },
                  ]
                : s.finalized,
            }));
          },
          transcript,
          setAppState,
          stats,
        });
      }
    } catch (e: unknown) {
      if (!cancelled) {
        const msg = e instanceof Error ? e.message : String(e);
        setAppState((s) => ({
          ...s,
          finalized: [
            ...s.finalized,
            { kind: "system", content: `error: ${msg}`, id: nextId(), tone: "error" },
          ],
        }));
      }
    } finally {
      cancelRef.current = null;
      const t = stats.totals();
      // Per-turn footer: tools used · output tokens · elapsed.
      const sumTools = (tc: Record<string, number>) =>
        Object.values(tc).reduce((a, b) => a + b, 0);
      const toolCount = sumTools(t.toolCounts) - sumTools(beforeTotals.toolCounts);
      const turnTok = Math.max(0, t.completionTokens - beforeTotals.completionTokens);
      const secs = Math.round((Date.now() - turnStartedAt) / 1000);
      const showFooter = !cancelled && (toolCount > 0 || turnTok > 0);
      const footer = `${CORNER} ${toolCount} tool${toolCount === 1 ? "" : "s"} · ${formatTokens(turnTok)} tok · ${secs}s`;
      setAppState((s) => ({
        ...s,
        busy: false,
        thinking: { verb: null, startedAt: 0 },
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
        finalized: showFooter
          ? [...s.finalized, { kind: "system", content: footer, id: nextId(), tone: "info" }]
          : s.finalized,
      }));
    }
  };

  const handleSubmitRef = useRef(handleSubmit);
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Background Task Polling & Queue Draining
  useEffect(() => {
    const timer = setInterval(() => {
      pollTasks(getAppState, setAppState).catch(() => {});
      
      if (!getAppState().busy && !getAppState().pendingPermission) {
        const cmd = dequeue();
        if (cmd) {
          void handleSubmitRef.current(cmd.value);
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [getAppState, setAppState]);

  // ─── Modular command dispatch (replaces the old 350-line switch/case) ───
  const commandRegistry = useMemo(() => {
    const reg = createCommandRegistry();
    // Load skills and MCP prompts asynchronously and register them (Phase 4.2)
    (async () => {
      try {
        const { loadSkills, skillToCommand } = await import("../skills/index.js");
        const skills = await loadSkills(cwd);
        for (const skill of skills) {
          reg.register(skillToCommand(skill));
        }
      } catch {}

      try {
        const { getConnections, buildMcpPromptCommand } = await import("../mcp/loader.js");
        const { listMcpPrompts } = await import("../mcp/client.js");
        const conns = getConnections();
        for (const conn of conns) {
          try {
            const prompts = await listMcpPrompts(conn);
            for (const p of prompts) {
              reg.register(buildMcpPromptCommand(conn, p));
            }
          } catch {}
        }
      } catch {}
    })();
    return reg;
  }, [cwd]);

  async function handleSlash(raw: string): Promise<void> {
    const tokens = raw.slice(1).split(/\s+/);
    const cmd = tokens[0];
    const rest = tokens.slice(1);
    const push = (content: string, tone: "info" | "warn" | "error" = "info") =>
      setAppState((s) => ({
        ...s,
        finalized: [
          ...s.finalized,
          { kind: "system", content, id: nextId(), tone },
        ],
      }));

    const def = commandRegistry.get(cmd ?? "");
    if (!def) {
      push(`unknown command: /${cmd}`, "warn");
      return;
    }

    const ctx: CommandContext = {
      engine,
      registry,
      permissions,
      provider,
      stats,
      pricing,
      cwd,
      getAppState: () => {
        // Read current state synchronously.
        // This is a snapshot — commands should not cache it.
        return {
          finalized, streamingAssistant, streamingReasoning, activeTool, busy,
          thinking, currentModel, contextLength,
          promptTokens, completionTokens, lastPromptTokens,
          bypassAll, editMode, pendingPermission: null,
          overlay, planMode, worktreePath,
        };
      },
      setAppState,
      push,
      submitPrompt: handleSubmit,
      switchAccount,
      exit,
    };
    // Attach the registry so /help can self-document.
    (ctx as any)._commandRegistry = commandRegistry;
    // Attach fileHistory, transcript, and plugins for /undo, /history, /export, /plugins
    (ctx as any)._fileHistory = (globalThis as any).__renoFileHistory;
    (ctx as any)._transcript = transcript;
    (ctx as any)._loadedPlugins = (globalThis as any).__renoLoadedPlugins;

    try {
      await def.execute(rest, ctx);
    } catch (e) {
      push(`command error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <Box flexDirection="column">
      <VirtualMessageList
        finalized={finalized}
        bannerProps={{ model: currentModel, cwd, provider, bypassAll, modelOrigin, branch, version: VERSION }}
      />

      {streamingAssistant && (
        <MessageBlock
          item={{
            kind: "assistant",
            content: streamingAssistant,
            id: "streaming",
          }}
          streaming
        />
      )}

      {activeTool && <MessageBlock item={activeTool} />}

      {busy && thinking.verb && !streamingAssistant && !activeTool && (
        <ThinkingIndicator
          verb={thinking.verb}
          startedAt={thinking.startedAt}
          completionTokens={0}
        />
      )}

      {pendingPerm && (
        <PermissionPrompt
          toolName={pendingPerm.name}
          args={pendingPerm.args}
          suggestedRules={pendingPerm.suggestedRules}
          alwaysPrompt={permissions.isAlwaysPrompt(pendingPerm.name)}
          onDecide={(choice) => {
            pendingPerm.resolve(choice);
            setPendingPerm(null);
          }}
        />
      )}

      {overlay === "model-picker" && (
        <ModelPicker
          provider={provider}
          currentModel={currentModel}
          onSelect={(m) => {
            engine.setModel?.(m);
            stats.currentModel = m;
            setAppState((s) => ({
              ...s,
              currentModel: m,
              overlay: "none",
              finalized: [
                ...s.finalized,
                { kind: "system", content: `model → ${m}`, id: nextId() },
              ],
            }));
          }}
          onCancel={() => setAppState((s) => ({ ...s, overlay: "none" }))}
        />
      )}

      {overlay === "status" && (
        <StatusScreen
          model={currentModel}
          provider={provider}
          contextLength={contextLength}
          stats={stats}
          permissions={permissions}
          bypassAll={bypassAll}
          costText={costText}
        />
      )}

      {overlay === "usage" && <UsageScreen stats={stats} pricing={pricing} />}

      {overlay === "accounts" && (
        <AccountsOverlay
          initialAddMode={accountsAddMode}
          onSwitch={switchAccount}
          onClose={() => setAppState((s) => ({ ...s, overlay: "none", accountsAddMode: false }))}
          notify={(msg, tone = "info") =>
            setAppState((s) => ({
              ...s,
              finalized: [...s.finalized, { kind: "system", content: msg, id: nextId(), tone }],
            }))
          }
        />
      )}

      {!pendingPerm && overlay !== "model-picker" && overlay !== "accounts" && (
        <RichInput
          onSubmit={handleSubmit}
          disabled={busy}
          editMode={editMode}
          bypassAll={bypassAll}
          cwd={cwd}
        />
      )}

      <StatusLine
        model={currentModel}
        account={accountName}
        providerName={provider.info.name}
        isCloud={provider.info.isCloud}
        lastPromptTokens={lastPromptTokens}
        contextLength={contextLength}
        busy={busy}
        busyVerb={thinking.verb}
        busyStartedAt={thinking.startedAt}
        bgTasks={runningTasks}
        queued={queuedCount}
      />
    </Box>
  );
}

// ─── Event handler — maps SessionEvent onto AppState + transcript writes ───

interface HandleCtx {
  onStreamText: (text: string) => void;
  onStreamDone: (fullText: string) => void;
  transcript?: TranscriptWriter;
  setAppState: (updater: (s: AppState) => AppState) => void;
  stats: SessionStatsClass;
}

function handleEvent(ev: SessionEvent, ctx: HandleCtx): void {
  const writeTranscript = (e: TranscriptEvent) =>
    ctx.transcript?.append(e).catch(() => {});

  switch (ev.type) {
    case "assistant_delta":
      ctx.onStreamText(ev.text);
      return;

    case "assistant_done":
      ctx.onStreamDone(ev.text);
      if (ev.text.trim()) {
        writeTranscript({ type: "assistant", content: ev.text, at: Date.now() });
      }
      return;

    case "reasoning_delta":
      // Accumulate the live reasoning buffer (kept hidden — the thinking
      // indicator already covers the "working" phase).
      ctx.setAppState((s) => ({
        ...s,
        streamingReasoning: s.streamingReasoning + ev.text,
      }));
      return;

    case "reasoning_done":
      // Fold reasoning into a collapsed transcript item placed before the answer.
      ctx.setAppState((s) => ({
        ...s,
        streamingReasoning: "",
        finalized: [
          ...s.finalized,
          {
            kind: "reasoning",
            id: nextId(),
            content: ev.text,
            durationMs: ev.durationMs,
          },
        ],
      }));
      return;

    case "tool_start":
      ctx.setAppState((s) => ({
        ...s,
        activeTool: {
          kind: "tool",
          id: ev.toolUseId,
          name: ev.name,
          args: ev.args,
        },
      }));
      writeTranscript({
        type: "tool_call",
        name: ev.name,
        args: ev.args,
        at: Date.now(),
      });
      return;

    case "tool_result":
      ctx.setAppState((s) => {
        // Carry the args captured at tool_start so result previews (diffs,
        // file content) have something to render — the event itself omits them.
        const priorArgs =
          s.activeTool && s.activeTool.kind === "tool" && s.activeTool.id === ev.toolUseId
            ? s.activeTool.args
            : {};
        return {
          ...s,
          activeTool: null,
          finalized: [
            ...s.finalized,
            {
              kind: "tool",
              id: ev.toolUseId,
              name: ev.name,
              // Prefer args carried on the event (reliable for parallel tools);
              // fall back to the args captured at tool_start.
              args: ev.args ?? priorArgs,
              result: ev.result,
              isError: ev.isError,
              diff: ev.diff,
              children: ev.children,
            },
          ],
        };
      });
      writeTranscript({
        type: "tool_result",
        name: ev.name,
        result: ev.result,
        isError: ev.isError,
        at: Date.now(),
      });
      return;

    case "permission_request":
      // The prompt is surfaced via engine.setRequestPermission (see AppInner
      // mount effect) — this event is informational only.
      return;

    case "permission_decision":
      // No UI change — the resolve was delivered to the engine.
      return;

    case "auto_decision":
      ctx.setAppState((s) => ({
        ...s,
        finalized: [
          ...s.finalized,
          ev.decision === "deny"
            ? {
                kind: "system",
                content: `blocked ${ev.name}: ${ev.reason}`,
                id: nextId(),
                tone: "error",
              }
            : {
                kind: "system",
                content: `✔ ${ev.name} auto-allowed`,
                id: nextId(),
                tone: "info",
              },
        ],
      }));
      return;

    case "token_stats": {
      const total = ctx.stats.totals();
      if (ev.promptTokens) ctx.stats.setLastPromptTokens(ev.promptTokens);
      ctx.setAppState((s) => ({
        ...s,
        promptTokens: total.promptTokens + (ev.promptTokens ?? 0),
        completionTokens: total.completionTokens + (ev.completionTokens ?? 0),
        lastPromptTokens: ev.promptTokens ?? s.lastPromptTokens,
      }));
      return;
    }

    case "notice":
      ctx.setAppState((s) => ({
        ...s,
        finalized: [
          ...s.finalized,
          { kind: "system", content: ev.message, id: nextId(), tone: ev.tone },
        ],
      }));
      return;

    case "auto_compact":
      ctx.setAppState((s) => ({
        ...s,
        finalized: [
          ...s.finalized,
          {
            kind: "system",
            content: `auto-compacted ${ev.droppedCount} message(s) to free context`,
            id: nextId(),
            tone: "warn",
          },
        ],
      }));
      return;

    case "checkpoint":
      writeTranscript({ type: "checkpoint", messages: ev.messages, at: Date.now() });
      return;

    case "turn_start":
    case "turn_end":
    case "tool_progress":
      // No-op in this UI — progress could be surfaced in ToolPreview later.
      return;
  }
}
