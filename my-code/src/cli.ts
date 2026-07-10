#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import chalk from "chalk";
import path from "node:path";
import { Command, Option } from "@commander-js/extra-typings";

import { QueryEngine } from "./agent/QueryEngine.js";
import type { ChatProvider } from "./agent/provider.js";
import { getProvider, isProviderName, providerFromAccount, type ProviderName } from "./agent/providers/index.js";
import { isProviderWired } from "./config/accounts.js";
import { ToolRegistry } from "./tools/registry.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { editTool } from "./tools/edit.js";
import { bashTool } from "./tools/bash.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { todoTool } from "./tools/todo.js";
import { webFetchTool } from "./tools/webFetch.js";
import { webSearchTool } from "./tools/webSearch.js";
import { notebookEditTool } from "./tools/notebookEdit.js";
import { enterPlanModeTool, exitPlanModeTool } from "./tools/planMode.js";
import { enterWorktreeTool, exitWorktreeTool } from "./tools/worktree.js";
import { sleepTool } from "./tools/sleep.js";
import { taskOutputTool } from "./tools/taskOutput.js";
import { taskListTool } from "./tools/taskList.js";
import { taskStopTool } from "./tools/taskStop.js";
import { taskCreateTool } from "./tools/taskCreate.js";
import { taskGetTool } from "./tools/taskGet.js";
import { taskUpdateTool } from "./tools/taskUpdate.js";
import { powerShellTool } from "./tools/powershell.js";
import { lspTool } from "./tools/lsp.js";
import { CronCreateTool } from "./tools/cron/CronCreateTool.js";
import { CronDeleteTool } from "./tools/cron/CronDeleteTool.js";
import { CronListTool } from "./tools/cron/CronListTool.js";
import { ToolSearchTool } from "./tools/toolSearch.js";
import { ConfigTool } from "./tools/config.js";
import { ListMcpResourcesTool } from "./tools/mcp/ListMcpResources.js";
import { ReadMcpResourceTool } from "./tools/mcp/ReadMcpResource.js";
import { initializeLspServerManager, shutdownLspServerManager } from "./services/lsp/manager.js";
import { App } from "./ui/App.js";
import { PermissionEngine } from "./config/permissions.js";
import type { PermissionChoice } from "./config/permissions.js";
import { SessionStats } from "./session/stats.js";
import { loadPricing } from "./session/pricing.js";
import { loadConfig, setConfigKey, listConfig } from "./config/globalConfig.js";
import {
  TranscriptWriter,
  listAllSessionMetas,
  listSessionMetas,
  formatSessionList,
  messagesFromTranscript,
} from "./session/transcript.js";
import { sessionDir } from "./session/projectStore.js";
import {
  switchSession,
  loadTranscriptForResume,
  setSession,
} from "./session/switchSession.js";
import { createInitialAppState, type AppState } from "./state/AppState.js";
import { closeAllMcp, loadMcpServers, registerMcpTools } from "./mcp/loader.js";
import { setupGracefulShutdown, registerCleanup } from "./utils/cleanup.js";
import { isDirectoryTrusted, trustDirectory, formatTrustMessage } from "./config/trust.js";
import { runSessionStartHooks, runSessionEndHooks } from "./hooks/index.js";
// Phase 3+4: Init memory systems at startup
import { initExtractMemories, drainPendingExtraction } from "./services/memory/extractMemories.js";
import { initAutoDream } from "./services/memory/autoDream/autoDream.js";
import { VERSION } from "./version.js";

// Initialize process signal handlers early.
setupGracefulShutdown();

// Register MCP and LSP cleanup as a shutdown handler.
registerCleanup(() => {
  closeAllMcp().catch(() => {});
  shutdownLspServerManager().catch(() => {});
});

// Phase 3+4: Initialize background memory systems once at process startup.
// These are no-ops until the first turn completes.
initExtractMemories();
initAutoDream();

// Drain pending extraction before exit so the background agent can finish.
registerCleanup(async () => {
  await drainPendingExtraction(30_000);
});

async function resolveModel(
  provider: ChatProvider,
  explicit: string | undefined
): Promise<{ model: string; warning?: string }> {
  // Provider-specific preference list (Ollama for now; extend per provider).
  const preferenceByProvider: Record<string, string[]> = {
    ollama: [
      "qwen3-coder-next",
      "gpt-oss:120b-cloud",
      "gpt-oss:20b",
      "qwen2.5-coder:latest",
      "qwen3-coder:480b-cloud",
      "qwen3-coder:480b",
      "llama3.1:8b",
    ],
    openai: ["gpt-4o", "gpt-4o-mini"],
    gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  };
  const preference = preferenceByProvider[provider.info.name] ?? [];

  let installed: string[] = [];
  try {
    installed = await provider.listModels();
  } catch {
    return { model: explicit ?? preference[0]! };
  }
  if (explicit) {
    if (installed.length && !installed.includes(explicit)) {
      return {
        model: installed[0]!,
        warning: `model "${explicit}" not installed. Using "${installed[0]}".`,
      };
    }
    return { model: explicit };
  }
  const chosen =
    preference.find((m) => installed.includes(m)) ?? installed[0] ?? preference[0]!;
  return { model: chosen };
}

async function readStdinAll(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface SharedOptions {
  provider?: string;
  model?: string;
  host?: string;
  apiKey?: string;
  cloud?: boolean;
  print?: string;
  yolo?: boolean;
}

/** Pick the provider name from flags / env / config / defaults. */
function resolveProviderName(
  opts: SharedOptions,
  globalConfig: { provider?: string }
): ProviderName {
  const raw =
    opts.provider ??
    process.env.MY_CODE_PROVIDER ??
    globalConfig.provider ??
    "ollama";
  if (!isProviderName(raw)) {
    process.stderr.write(
      chalk.yellow(`  ⚠ unknown provider "${raw}", falling back to "ollama"\n`)
    );
    return "ollama";
  }
  return raw;
}

/** Build the provider instance for the chosen name. */
async function buildProvider(
  name: ProviderName,
  opts: SharedOptions,
  globalConfig: Awaited<ReturnType<typeof loadConfig>>
): Promise<ChatProvider> {
  if (name === "ollama") {
    const useCloud =
      opts.cloud ||
      !!opts.apiKey ||
      !!globalConfig.ollamaApiKey ||
      !!process.env.OLLAMA_API_KEY ||
      opts.host?.includes("ollama.com") ||
      false;
    const defaultHost = useCloud ? "https://ollama.com" : "http://localhost:11434";
    const host = opts.host ?? process.env.OLLAMA_HOST ?? globalConfig.ollamaHost ?? defaultHost;
    const apiKey = opts.apiKey ?? process.env.OLLAMA_API_KEY ?? globalConfig.ollamaApiKey;
    if (useCloud && !apiKey) {
      process.stderr.write(
        chalk.yellow(
          "  ⚠ cloud mode without API key — get one at https://ollama.com/settings/keys\n"
        )
      );
    }
    return getProvider("ollama", { host, apiKey });
  }
  // openai / gemini stubs throw with a helpful message.
  return getProvider(name);
}

/** Assemble the engine + dependencies shared by print mode and interactive mode. */
async function bootstrap(
  opts: SharedOptions,
  resumeSessionId?: string
): Promise<{
  engine: QueryEngine;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  stats: SessionStats;
  pricing: Awaited<ReturnType<typeof loadPricing>>;
  transcript: TranscriptWriter;
  provider: ChatProvider;
  model: string;
  modelOrigin: string;
  initialState: AppState;
  contextLength?: number;
  fileHistory: InstanceType<typeof import("./utils/fileHistory.js")["FileHistory"]>;
  loadedPlugins: Array<{ path: string; name: string; source: string; loaded: boolean; error?: string }>;
  /** The IDE bridge server, if it started. Used by `serve` mode. */
  bridge: import("./bridge/index.js").BridgeServer | null;
}> {
  const cwd = process.cwd();

  // ─── Trust check (Phase 3.4) ───
  const trusted = await isDirectoryTrusted(cwd);
  if (!trusted) {
    process.stdout.write(formatTrustMessage(cwd) + "\n");
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Trust this directory? [y/N] ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
    if (answer !== "y" && answer !== "yes") {
      process.stderr.write("Exiting — directory not trusted.\n");
      process.exit(1);
    }
    await trustDirectory(cwd);
    process.stdout.write("✔ Directory trusted.\n\n");
  }

  const globalConfig = await loadConfig();

  // Account-first provider selection. If the user has an active account for a
  // non-Ollama wired provider (e.g. Azure Foundry), its stored endpoint/key/
  // deployment decide the provider — this is what lets `serve`/`print` use it,
  // matching the interactive account switcher. Ollama keeps its existing path
  // (its active account is already merged into globalConfig by loadConfig), and
  // an explicit --provider flag always wins.
  const activeAccount = globalConfig.activeAccountId
    ? (globalConfig.accounts ?? []).find((a) => a.id === globalConfig.activeAccountId)
    : undefined;

  let providerName: ProviderName;
  let provider: ChatProvider;
  if (
    !opts.provider &&
    activeAccount &&
    activeAccount.provider !== "ollama" &&
    isProviderWired(activeAccount.provider)
  ) {
    provider = providerFromAccount(activeAccount);
    providerName = isProviderName(activeAccount.provider) ? activeAccount.provider : "ollama";
  } else {
    providerName = resolveProviderName(opts, globalConfig);
    provider = await buildProvider(providerName, opts, globalConfig);
  }

  const explicitModel = opts.model ?? process.env.MY_CODE_MODEL ?? globalConfig.defaultModel;
  const modelOrigin = opts.model
    ? "--model flag"
    : process.env.MY_CODE_MODEL
      ? "MY_CODE_MODEL env"
      : globalConfig.defaultModel
        ? "config.json"
        : "auto-detected";

  const { model, warning } = await resolveModel(provider, explicitModel);
  if (warning) process.stderr.write(chalk.yellow("  ⚠ " + warning + "\n"));

  const registry = new ToolRegistry();
  for (const t of [
    readTool,
    writeTool,
    editTool,
    bashTool,
    globTool,
    grepTool,
    todoTool,
    webFetchTool,
    webSearchTool,
    notebookEditTool,
    enterPlanModeTool,
    exitPlanModeTool,
    enterWorktreeTool,
    exitWorktreeTool,
    sleepTool,
    taskOutputTool,
    taskListTool,
    taskStopTool,
    taskCreateTool,
    taskGetTool,
    taskUpdateTool,
    powerShellTool,
    lspTool,
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
    ToolSearchTool,
    ConfigTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
  ]) {
    registry.register(t);
  }

  // Initialize LSP servers (non-blocking)
  initializeLspServerManager();

  // AgentTool — sub-agent spawning (Phase 3.5)
  try {
    const { AgentTool } = await import("./tools/agent/AgentTool.js");
    registry.register(AgentTool);
  } catch {
    // Non-fatal — AgentTool is optional
  }



  // MCP servers — connect & register their tools.
  try {
    const mcpServers = await loadMcpServers(cwd);
    if (mcpServers.length > 0) {
      const count = await registerMcpTools(registry, mcpServers);
      if (count > 0 && process.env.MY_CODE_DEBUG === "1") {     process.stderr.write(
          chalk.gray(`  ⎯ MCP: ${count} tool(s) loaded from ${mcpServers.length} server(s)\n`)
        );
      }
    }
  } catch (e: unknown) {
    process.stderr.write(
      chalk.yellow(`  ⚠ MCP init failed: ${e instanceof Error ? e.message : String(e)}\n`)
    );
  }

  // ─── Plugins (Phase 4.1) ───
  let loadedPlugins: Awaited<ReturnType<typeof import("./plugins/index.js")["loadPlugins"]>> = [];
  try {
    const { loadPlugins } = await import("./plugins/index.js");
    const { createCommandRegistry } = await import("./commands/index.js");
    const cmdRegistry = createCommandRegistry();
    loadedPlugins = await loadPlugins(cwd, registry, cmdRegistry);
    const loaded = loadedPlugins.filter((p) => p.loaded);
    if (loaded.length > 0) {
      process.stderr.write(
        chalk.gray(`  ⎯ Plugins: ${loaded.length} loaded\n`)
      );
    }
  } catch {
    // Non-fatal — plugins are optional
  }

  // ─── Skills (Phase 4.2) ───
  try {
    const { loadSkills, skillToCommand } = await import("./skills/index.js");
    const { buildSkillTool } = await import("./tools/skill/SkillToolBuilder.js");
    const skills = await loadSkills(cwd);
    
    // Register skills as AI tools if not disabled
    let registeredSkillTools = 0;
    for (const skill of skills) {
      if (!skill.disableModelInvocation) {
        registry.register(buildSkillTool(skill));
        registeredSkillTools++;
      }
    }

    if (skills.length > 0) {
      process.stderr.write(
        chalk.gray(`  ⎯ Skills: ${skills.length} loaded (${registeredSkillTools} exposed to AI)\n`)
      );
    }
    // Skills are also registered as slash commands in the registry for user autocomplete.
    // Wait, the cmdRegistry is not available here easily because it's only scoped to Plugins phase.
    // We'll leave slash command loading to the `/skills` command for now, as before.
  } catch (e: unknown) {
    // Non-fatal — skills are optional
    if (process.env.MY_CODE_DEBUG === "1") {
      process.stderr.write(
        chalk.yellow(`  ⚠ Skills init failed: ${e instanceof Error ? e.message : String(e)}\n`)
      );
    }
  }

  const permissions = new PermissionEngine(cwd);
  await permissions.load();
  if (opts.yolo) permissions.setSessionBypass(true);

  const stats = new SessionStats(model, cwd);
  const pricing = await loadPricing();

  // Context length — provider-dependent.
  let contextLength: number | undefined;
  if (provider.getModelInfo && !provider.info.isCloud) {
    try {
      const info = await provider.getModelInfo(model);
      contextLength = info.contextLength;
    } catch {
      // harmless; status line will show "?"
    }
  }

  // Phase 5: Resume from a previous session if requested.
  // Uses loadTranscriptForResume (supports UUID-chain, checkpoint, and raw events)
  // and switchSession to atomically redirect future writes to the old .jsonl file.
  let resumedMessages: import("./agent/types.js").ChatMessage[] | null = null;
  if (resumeSessionId !== undefined) {
    const cwd = process.cwd();

    // Resolve sessionId: if empty string → load most recent session
    let resolvedId = resumeSessionId;
    if (!resolvedId) {
      const metas = await listSessionMetas(cwd);
      if (metas.length === 0) {
        process.stderr.write(chalk.yellow("No sessions found for this project.\n"));
        process.exit(1);
      }
      resolvedId = metas[0]!.id;
    }

    const session = await loadTranscriptForResume(cwd, resolvedId);
    if (!session) {
      // Check if the file exists but is empty (0-byte ghost session)
      const { stat: fsStat } = await import("node:fs/promises").then(m => ({ stat: m.stat }));
      const sessionPath = path.join(sessionDir(cwd), `${resolvedId}.jsonl`);
      let isEmpty = false;
      try {
        const st = await fsStat(sessionPath);
        isEmpty = st.size === 0;
      } catch {
        // file doesn't exist
      }

      if (isEmpty) {
        process.stderr.write(
          chalk.yellow(`Session ${resolvedId} has no messages — it was opened but nothing was typed.\n`)
        );
      } else {
        process.stderr.write(
          chalk.yellow(`Could not load session ${resolvedId} — transcript may be corrupt.\n`)
        );
      }

      // Show sessions that actually have content
      const available = await listSessionMetas(cwd);
      if (available.length > 0) {
        process.stderr.write(chalk.cyan(`\nSessions with content:\n`));
        for (const m of available.slice(0, 5)) {
          const preview = m.summary ? ` "${m.summary.slice(0, 50)}"` : "";
          process.stderr.write(chalk.gray(`  my-code --resume ${m.id}${preview}\n`));
        }
      }
      process.exit(1);
    }

    // Atomic session swap: future writes go to the OLD .jsonl file
    switchSession(session.sessionId, session.cwd);
    resumedMessages = session.messages;
    process.stderr.write(
      chalk.green(`✔ Resumed session ${session.sessionId} (${session.messages.length} messages)\n`)
    );
  }


  // Initial AppState — QueryEngine reads it via getAppState.
  let appStateRef: AppState = createInitialAppState({
    model,
    bypassAll: permissions.bypassAll,
    editMode: permissions.mode,
  });
  if (contextLength) appStateRef = { ...appStateRef, contextLength };

  const engine = new QueryEngine({
    provider,
    model,
    registry,
    permissions,
    stats,
    cwd,
    contextLength,
    autoCompact: true,
    getAppState: () => appStateRef,
    setAppState: (updater) => {
      appStateRef = updater(appStateRef);
    },
    onEvent: (ev) => {
      if (bridge) bridge.forwardEvent(ev);
    },
  });

  if (resumedMessages) engine.setMessages(resumedMessages);

  const transcript = new TranscriptWriter(stats.id, cwd, model);
  await transcript.open().catch(() => {});

  // ─── FileHistory global instance (Phase 4.7) ───
  const { FileHistory } = await import("./utils/fileHistory.js");
  const fileHistory = new FileHistory();
  (globalThis as any).__myCodeFileHistory = fileHistory;
  (globalThis as any).__myCodeLoadedPlugins = loadedPlugins;

  // ─── IDE Bridge (Phase 4.3 + Phase 29) ───
  let bridge: any = null;
  try {
    const { BridgeServer, writeBridgeInfo, removeBridgeInfo } = await import("./bridge/index.js");
    const bridgeServer = new BridgeServer(stats.id);

    // ── agent/submit — Phase 29: full streaming via engine ─────────────────
    // The IDE sends { prompt, streaming? }. We run the engine and forward
    // all SessionEvents back as bridge notifications so the IDE can show
    // a live streaming response without having a readline loop.
    bridgeServer.handle("agent/submit", async (params) => {
      const prompt = params.prompt as string;
      if (!prompt?.trim()) return { error: "no prompt" };

      // Fire-and-forget: run the engine and forward events.
      // The IDE is already subscribed to agent/event notifications.
      void (async () => {
        try {
          for await (const ev of engine.submitMessage(prompt)) {
            bridgeServer.forwardEvent(ev);
            // Persist so bridge/GUI sessions are resumable — same checkpoint
            // mechanism the -p print path uses. Interactive mode does its own.
            if (ev.type === "checkpoint") {
              transcript
                .append({ type: "checkpoint", messages: ev.messages, at: Date.now() })
                .catch(() => {});
            }
          }
        } catch {
          // Engine errors are forwarded as error events by QueryEngine itself
        }
      })();

      return { queued: true };
    });

    // ── agent/cancel ────────────────────────────────────────────────────────
    bridgeServer.handle("agent/cancel", () => {
      engine.abort();
      return { cancelled: true };
    });

    // ── agent/compact ───────────────────────────────────────────────────────
    bridgeServer.handle("agent/compact", async () => {
      const result = await engine.runCompact();
      return { droppedCount: result.droppedCount };
    });

    // ── agent/status — Phase 29: let the IDE query engine state ────────────
    bridgeServer.handle("agent/status", () => {
      return {
        model,
        cwd,
        sessionId: stats.id,
        messageCount: engine.getMessages().length,
      };
    });

    // ── file/changed — Phase 29: IDE notifies CLI when a file is saved ──────
    // Triggers an LSP re-check so the LLM sees fresh diagnostics on the next turn.
    bridgeServer.handle("file/changed", async (params) => {
      const filePath = params.path as string | undefined;
      if (!filePath) return { error: "no path" };

      // Queue an LSP re-check so diagnostics are fresh on next turn
      try {
        const lsp = await import("./services/lsp/LSPDiagnosticRegistry.js") as Record<string, unknown>;
        const queueFn = lsp["queueLSPCheck"];
        if (typeof queueFn === "function") (queueFn as (p: string) => void)(filePath);
      } catch {}

      bridgeServer.notify("file/changed/ack", { path: filePath, at: Date.now() });
      return { ok: true };
    });

    await bridgeServer.start();
    await writeBridgeInfo({
      sessionId: stats.id,
      socketPath: bridgeServer.socketPath,
      pid: process.pid,
      cwd,
      startedAt: Date.now(),
    });

    // Clean up bridge on shutdown
    registerCleanup(async () => {
      await bridgeServer.stop();
      await removeBridgeInfo(stats.id);
    });

    bridge = bridgeServer as any;
    // Quiet by default — this is machine plumbing, not something the user needs
    // to see. Surfaced only when debugging.
    if (process.env.MY_CODE_DEBUG === "1") {
      process.stderr.write(
        chalk.gray(`  ⎯ IDE Bridge: listening on ${bridgeServer.socketPath}\n`)
      );
    }
  } catch {
    // Bridge is optional — fails silently on systems without net
  }

  // ─── Session start hooks (Phase 3.3) ───
  try {
    await runSessionStartHooks({ sessionId: stats.id, cwd });
  } catch {}

  // Register session end hooks for cleanup
  registerCleanup(async () => {
    try {
      await runSessionEndHooks({ sessionId: stats.id, cwd });
    } catch {}
  });

  return {
    engine,
    registry,
    permissions,
    stats,
    pricing,
    transcript,
    provider,
    model,
    modelOrigin,
    initialState: appStateRef,
    contextLength,
    fileHistory,
    loadedPlugins,
    bridge,
  };
}

/** Non-interactive print mode: single turn to stdout. */
async function runPrint(opts: SharedOptions, promptArg: string): Promise<void> {
  const {
    engine,
    stats,
    transcript,
  } = await bootstrap(opts);

  const prompt = promptArg || (await readStdinAll());
  if (!prompt.trim()) {
    process.stderr.write("no prompt provided\n");
    process.exit(1);
  }

  // In print mode we auto-approve anything that asks — matches old behavior.
  engine.setRequestPermission(async () => "once");

  try {
    for await (const ev of engine.submitMessage(prompt)) {
      switch (ev.type) {
        case "assistant_delta":
          process.stdout.write(ev.text);
          break;
        case "tool_start":
          process.stderr.write(chalk.cyan(`\n● ${ev.name}\n`));
          break;
        case "tool_result": {
          const line = ev.result.split("\n")[0] ?? "";
          process.stderr.write(
            (ev.isError ? chalk.red("  ✗ ") : chalk.gray("  ⎿ ")) + line + "\n"
          );
          break;
        }
        case "notice":
          process.stderr.write(chalk.yellow(`\n${ev.message}\n`));
          break;
        case "checkpoint":
          transcript
            .append({ type: "checkpoint", messages: ev.messages, at: Date.now() })
            .catch(() => {});
          break;
        case "turn_end":
          // complete — drop through
          break;
      }
    }
  } catch (e: unknown) {
    process.stderr.write(
      chalk.red("\nError: " + (e instanceof Error ? e.message : String(e)) + "\n")
    );
    process.exit(1);
  }
  process.stdout.write("\n");
  await transcript.close({ turns: stats.totals().turns });
  // MCP cleanup handled by shutdown registry.
}

/** Interactive TUI mode. */
async function runInteractive(
  opts: SharedOptions,
  resumeSessionId?: string
): Promise<void> {
  const {
    engine,
    registry,
    permissions,
    stats,
    pricing,
    transcript,
    provider,
    model,
    modelOrigin,
  } = await bootstrap(opts, resumeSessionId);

  const cwd = process.cwd();

  // Build initial display messages from the resumed engine state so the TUI
  // shows the old conversation on load instead of a blank screen.
  const resumedMessages = resumeSessionId !== undefined ? engine.getMessages() : [];

  const { waitUntilExit } = render(
    React.createElement(App, {
      engine,
      registry,
      permissions,
      stats,
      pricing,
      cwd,
      model,
      provider,
      yolo: !!opts.yolo,
      modelOrigin,
      transcript,
      initialMessages: resumedMessages,
    }),
    { exitOnCtrlC: false }
  );
  await waitUntilExit();

  const t = stats.totals();
  await transcript.close({
    turns: t.turns,
    promptTokens: t.promptTokens,
    completionTokens: t.completionTokens,
  });
  try {
    await stats.persist();
  } catch {
    // persist failure is non-fatal
  }
  // MCP cleanup handled by shutdown registry.
}

// ─── Commander tree ───

const program = new Command()
  .name("my-code")
  .description("terminal coding agent — multi-provider (Ollama today; OpenAI/Gemini soon)")
  .version(VERSION)
  .option("--provider <name>", "provider id: ollama | openai | gemini")
  .option("-m, --model <id>", "model id (overrides config + env)")
  .option("--host <url>", "provider host URL")
  .option("--api-key <key>", "provider API key")
  .option("--cloud", "Ollama-only: use Ollama Cloud (sets host to https://ollama.com)")
  .option("-p, --print [prompt]", "non-interactive: send one prompt and exit")
  .option("-c, --continue", "resume the most recent session for this project (Beta parity)")
  .option("--resume <session-id>", "resume a specific session by UUID")
  .addOption(
    new Option("--yolo", "skip permission prompts").conflicts("nothing")
  )
  .option("--dangerously-skip-permissions", "alias for --yolo", false)
  .action(async (rawOpts: Record<string, unknown>, cmd: Command) => {
    const opts = rawOpts as SharedOptions & {
      dangerouslySkipPermissions?: boolean;
      continue?: boolean;
      resume?: string;
    };
    if (opts.dangerouslySkipPermissions) opts.yolo = true;
    if (opts.print !== undefined) {
      const args = (cmd.args as string[]) ?? [];
      const prompt = typeof opts.print === "string" ? opts.print : args.join(" ");
      await runPrint(opts, prompt);
      return;
    }
    // --continue: resume the most recent session (Beta's default resume behavior)
    if (opts.continue) {
      await runInteractive(opts, ""); // empty string → pick most recent
      return;
    }
    // --resume <uuid>: resume a specific session
    if (opts.resume) {
      await runInteractive(opts, opts.resume);
      return;
    }
    await runInteractive(opts);
  });


program
  .command("sessions")
  .description("list recent sessions for this project")
  .option("--all", "list across all projects", false)
  .action(async (sub: { all?: boolean }) => {
    const cwd = process.cwd();
    const metas = sub.all ? await listAllSessionMetas(30) : await listSessionMetas(cwd);
    process.stdout.write(formatSessionList(metas) + "\n");
  });

program
  .command("resume [session-id]")
  .description("resume a previous session (most recent by default)")
  .option("--provider <name>", "provider id")
  .option("-m, --model <id>", "override model")
  .option("--host <url>", "provider host URL")
  .option("--api-key <key>", "provider API key")
  .option("--cloud", "Ollama-only: use Ollama Cloud")
  .option("--yolo", "skip permission prompts")
  .action(async (sessionId: string | undefined, sub: SharedOptions) => {
    await runInteractive(sub, sessionId);
  });

// ─── Headless serve mode (for the desktop GUI) ───
//
// Boots the engine + IDE bridge with NO Ink UI and NO interactive prompts,
// then stays alive so a GUI (my-code-desktop) can drive it over the named
// pipe. Additive: the interactive CLI is untouched. Everything a GUI needs —
// streaming, tool events, diffs, permission round-trips — flows over the
// bridge that bootstrap() already stands up.
//
// Handshake: a single JSON line is written to stdout once ready:
//   {"ready":true,"socketPath":"...","sessionId":"...","model":"...","cwd":"..."}
// The parent reads that line to discover the pipe, then talks JSON-RPC.

/** Tools a `chat` profile keeps — read-only / no filesystem mutation. */
const CHAT_PROFILE_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch", "ToolSearch",
  "TodoWrite", "ListMcpResources", "ReadMcpResource",
]);

async function runServe(
  opts: SharedOptions & { profile?: string; sessionId?: string }
): Promise<void> {
  const cwd = process.cwd();

  // Pre-trust the cwd so bootstrap()'s interactive trust prompt is skipped —
  // a headless process must never block on readline.
  await trustDirectory(cwd);

  // Resume is best-effort in serve mode: bootstrap() exits the process when a
  // session can't be loaded (fine interactively, fatal for a GUI backend — the
  // desktop restarts with `--session <id>` even for brand-new empty sessions,
  // e.g. after an account switch). Pre-check and fall back to a fresh session.
  let resumeId = opts.sessionId;
  if (resumeId) {
    const resumable = await loadTranscriptForResume(cwd, resumeId).catch(() => null);
    if (!resumable) {
      process.stderr.write(`session ${resumeId} has no resumable transcript — starting fresh\n`);
      resumeId = undefined;
    }
  }
  const { engine, registry, stats, model, bridge } = await bootstrap(opts, resumeId);

  if (!bridge) {
    process.stderr.write("fatal: bridge failed to start (net unavailable?)\n");
    process.exit(1);
  }

  // The bridge's agent/submit loop forwards every yielded event. Clear the
  // engine's onEvent (set by bootstrap for interactive+IDE) so events aren't
  // forwarded twice in serve mode.
  engine.setOnEvent(undefined);

  // ── Profile: chat mode strips mutating/code tools from the registry ──
  const profile = opts.profile === "chat" ? "chat" : "code";
  if (profile === "chat") {
    for (const t of registry.list()) {
      // Keep the read-only core plus any connector (MCP) tools — connectors are
      // exactly what chat mode is for.
      if (!CHAT_PROFILE_TOOLS.has(t.name) && !t.name.startsWith("mcp__")) {
        registry.unregister(t.name);
      }
    }
  }

  // ── Permission round-trip over the bridge ──
  // QueryEngine emits a `permission_request` event (forwarded to the GUI by
  // onEvent) and then awaits requestPermission(). We park a resolver keyed by
  // toolUseId; the GUI answers with `agent/permission-response`.
  const pending = new Map<string, (choice: PermissionChoice) => void>();

  // Let the GUI fetch the loaded conversation (e.g. after --session resume) so
  // it can render history that predates the live event stream.
  bridge.handle("agent/history", () => {
    return { messages: engine.getMessages() };
  });

  // Live model switch from the GUI's model picker (no restart).
  bridge.handle("agent/set-model", (params) => {
    const m = params.model as string | undefined;
    if (m) engine.setModel(m);
    return { ok: Boolean(m), model: m };
  });

  bridge.handle("agent/permission-response", (params) => {
    const toolUseId = params.toolUseId as string;
    const choice = (params.choice as PermissionChoice) ?? "no";
    const resolve = pending.get(toolUseId);
    if (resolve) {
      pending.delete(toolUseId);
      resolve(choice);
      return { ok: true };
    }
    return { ok: false, error: "no pending request for that toolUseId" };
  });

  engine.setRequestPermission(({ toolUseId, name, args, suggestedRules, signal }) => {
    return new Promise<PermissionChoice>((resolve) => {
      pending.set(toolUseId, resolve);
      // The engine only yields its own permission_request AFTER this promise
      // resolves (it's collected in a return array), so we must push the
      // request to the GUI ourselves — otherwise the GUI never knows to answer
      // and we deadlock. Forwarding it here reaches the client immediately.
      bridge.forwardEvent({
        type: "permission_request",
        toolUseId,
        name,
        args,
        suggestedRules,
      });
      // If the turn is aborted while waiting, treat as denial.
      const onAbort = () => {
        if (pending.delete(toolUseId)) resolve("no");
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });

  // ── Handshake: tell the parent where to connect ──
  process.stdout.write(
    JSON.stringify({
      ready: true,
      socketPath: bridge.socketPath,
      sessionId: stats.id,
      model,
      cwd,
      profile,
    }) + "\n"
  );

  if (process.env.MY_CODE_DEBUG === "1") {
    process.stderr.write(
      chalk.gray(`  ⎯ serve: ${profile} profile on ${bridge.socketPath}\n`)
    );
  }

  // Stay alive until killed. The bridge server owns all further I/O.
  await new Promise<void>(() => {});
}

program
  .command("serve")
  .description("headless backend for the desktop GUI (no TUI; drive over the bridge)")
  .option("--profile <mode>", "tool profile: code | chat", "code")
  .option("--session <id>", "resume a specific session by id")
  .option("--yolo", "skip permission prompts (auto-approve)")
  .option("--provider <name>", "provider id")
  .option("-m, --model <id>", "override model")
  .option("--host <url>", "provider host URL")
  .option("--api-key <key>", "provider API key")
  .option("--cloud", "Ollama-only: use Ollama Cloud")
  .action(async (sub: SharedOptions & { profile?: string; session?: string }) => {
    await runServe({ ...sub, sessionId: sub.session });
  });

const configCmd = program
  .command("config")
  .description("get/set global config (provider, model, host, apiKey)");

configCmd
  .command("get <key>")
  .description("read a config value")
  .action(async (key: string) => {
    const val = await listConfig();
    const out = (val as Record<string, string>)[key] ?? "(not set)";
    process.stdout.write(`${key} = ${out}\n`);
  });

configCmd
  .command("set <key> <value>")
  .description("write a config value (apiKey/secrets go to settings.local.json)")
  .action(async (key: string, value: string) => {
    const { file, key: nk } = await setConfigKey(key, value);
    process.stdout.write(chalk.green(`✔ ${nk} saved to ${file}\n`));
  });

configCmd
  .command("list", { isDefault: true })
  .description("list all config values")
  .action(async () => {
    const cfg = await listConfig();
    if (Object.keys(cfg).length === 0) {
      process.stdout.write(
        "(no config set — use ig config set <key> <value>)\n"
      );
    } else {
      for (const [k, v] of Object.entries(cfg)) {
        process.stdout.write(`  ${k.padEnd(18)} ${v}\n`);
      }
    }
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(
    chalk.red("fatal: " + (e instanceof Error ? e.stack : String(e))) + "\n"
  );
  process.exit(1);
});
