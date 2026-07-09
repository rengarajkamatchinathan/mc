/**
 * All built-in slash commands, extracted from App.tsx.
 * Each command is a self-contained module — easy to add, remove, or test.
 */

import type { SlashCommandDef, CommandContext } from "./registry.js";
import { costFor, formatCost } from "../session/pricing.js";
import { getTodos, renderTodos } from "../tools/todo.js";
import {
  listSessionMetas,
  listAllSessionMetas,
  messagesFromTranscript,
  formatSessionList,
} from "../session/transcript.js";
import { mcpCommand } from "./mcp.js";
import { listConfig, setConfigKey } from "../config/globalConfig.js";
import {
  listAccounts,
  getActiveAccountId,
  removeAccount,
  resolveAccount,
  maskKey,
  isProviderWired,
} from "../config/accounts.js";
import { sessionDir } from "../session/projectStore.js";
import type { LocalShellTaskState } from "../tasks/LocalShellTask/guards.js";
import { killTask } from "../tasks/LocalShellTask/killShellTasks.js";
import { listStructuredTasks } from "../tasks/taskStore.js";
import { isLocalAgentTask } from "../tasks/LocalAgentTask/LocalAgentTask.js";
import {
  scanMemoryFiles,
  formatMemoryManifest,
  readMemoryFile,
  deleteMemoryFile,
} from "../memdir/index.js";
import { getAutoMemPath } from "../memdir/paths.js";

// ─── Session ────────────────────────────────────────────────────────────────

const helpCommand: SlashCommandDef = {
  name: "help",
  description: "Show all available commands",
  passthrough: true,
  execute(_, ctx) {
    const lines: string[] = [];
    // Build help from the registry itself (self-documenting).
    const cmds = (ctx as any)._commandRegistry?.list?.() as SlashCommandDef[] | undefined;
    if (cmds) {
      for (const c of cmds) {
        const args = c.argsHint ? ` ${c.argsHint}` : "";
        lines.push(`/${c.name.padEnd(20)}${args.padEnd(20)} ${c.description}`);
      }
    } else {
      // Fallback: static help text
      lines.push(
        "/init                 scan project and create my-code.md",
        "/allow [scope] <rule> add allow rule  (session|project|global)",
        "/deny  [scope] <rule> add deny rule",
        "/bypass on|off        toggle session bypass (dangerous)",
        "/permissions          show all permission state",
        "/clear                reset conversation",
        "/compact              summarize conversation to free context",
        "/cost                 show token usage + cost",
        "/status               toggle session dashboard",
        "/usage                toggle today/week/all-time usage",
        "/model [id]           show picker or switch directly",
        "/models               list installed models",
        "/todos                show current task list",
        "/tools                list registered tools",
        "/sessions [--all]     list recent sessions",
        "/resume [id]          resume a previous session",
        "/config get|set       read/write global config",
        "/exit                 quit",
      );
    }
    ctx.push(lines.join("\n"));
  },
};

const clearCommand: SlashCommandDef = {
  name: "clear",
  description: "Reset conversation",
  passthrough: true,
  execute(_, ctx) {
    ctx.engine.resetConversation();
    ctx.setAppState((s) => ({ ...s, finalized: [] }));
    ctx.push("conversation cleared");
  },
};

const exitCommand: SlashCommandDef = {
  name: "quit",
  description: "Quit the CLI",
  aliases: ["exit"],
  passthrough: true,
  execute(_, ctx) {
    ctx.exit();
  },
};

const initCommand: SlashCommandDef = {
  name: "init",
  description: "Scan project and create my-code.md",
  async execute(_, ctx) {
    await ctx.submitPrompt(
      "Read the most important files in this project (package.json, README, top-level source dirs) and create a concise my-code.md at the project root. Include: project purpose, tech stack, key directories, build/test commands, any conventions. Keep it under 60 lines."
    );
  },
};

// ─── Permissions ────────────────────────────────────────────────────────────

const allowCommand: SlashCommandDef = {
  name: "allow",
  description: "Add an allow rule",
  argsHint: "[session|project|global] <rule>",
  async execute(args, ctx) {
    await handleAllowDeny("allow", args, ctx);
  },
};

const denyCommand: SlashCommandDef = {
  name: "deny",
  description: "Add a deny rule",
  argsHint: "[session|project|global] <rule>",
  async execute(args, ctx) {
    await handleAllowDeny("deny", args, ctx);
  },
};

async function handleAllowDeny(kind: "allow" | "deny", rest: string[], ctx: CommandContext) {
  if (rest.length === 0) {
    const snap = ctx.permissions.snapshot();
    ctx.push(
      [
        `── ${kind} ──`,
        `session: ${snap.session[kind].join(", ") || "(none)"}`,
        `project: ${(snap.project.permissions?.[kind] ?? []).join(", ") || "(none)"}`,
        `global:  ${(snap.global.permissions?.[kind] ?? []).join(", ") || "(none)"}`,
      ].join("\n")
    );
    return;
  }
  let scope: "session" | "project" | "global" = "session";
  let rule: string;
  if (rest[0] === "project" || rest[0] === "global" || rest[0] === "session") {
    scope = rest[0];
    rule = rest.slice(1).join(" ");
  } else {
    rule = rest.join(" ");
  }
  if (!rule) {
    ctx.push(`usage: /${kind} [session|project|global] <rule>`, "warn");
    return;
  }
  if (scope === "session") {
    kind === "allow"
      ? ctx.permissions.addSessionAllow(rule)
      : ctx.permissions.addSessionDeny(rule);
    ctx.push(`session ${kind}: ${rule}`);
  } else {
    try {
      await ctx.permissions.addPersistedRule(scope, kind, rule);
      ctx.push(`${scope} ${kind}: ${rule} (saved)`);
    } catch (e) {
      ctx.push(
        `save failed: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    }
  }
}

const bypassCommand: SlashCommandDef = {
  name: "bypass",
  description: "Toggle session bypass mode",
  argsHint: "on|off",
  execute(args, ctx) {
    const v = args[0];
    if (v === "on" || v === "true") {
      ctx.permissions.setSessionBypass(true);
      ctx.setAppState((s) => ({ ...s, bypassAll: true }));
      ctx.push("⚠ bypass ON — all tool calls auto-approved", "warn");
    } else if (v === "off" || v === "false") {
      ctx.permissions.setSessionBypass(false);
      ctx.setAppState((s) => ({ ...s, bypassAll: ctx.permissions.bypassAll }));
      ctx.push("bypass OFF");
    } else {
      ctx.push(
        `bypass is ${ctx.permissions.bypassAll ? "ON" : "OFF"}. usage: /bypass on|off`
      );
    }
  },
};

const permissionsCommand: SlashCommandDef = {
  name: "permissions",
  description: "Show permission rules and state",
  execute(_, ctx) {
    const snap = ctx.permissions.snapshot();
    ctx.push(
      [
        `bypass: session=${snap.session.bypassAll} · project=${!!snap.project.bypassAll} · global=${!!snap.global.bypassAll}`,
        "── session ──",
        `  allow: ${snap.session.allow.join(", ") || "(none)"}`,
        `  deny:  ${snap.session.deny.join(", ") || "(none)"}`,
        "── project ──",
        `  allow: ${(snap.project.permissions?.allow ?? []).join(", ") || "(none)"}`,
        `  deny:  ${(snap.project.permissions?.deny ?? []).join(", ") || "(none)"}`,
        "── global ──",
        `  allow: ${(snap.global.permissions?.allow ?? []).join(", ") || "(none)"}`,
        `  deny:  ${(snap.global.permissions?.deny ?? []).join(", ") || "(none)"}`,
      ].join("\n")
    );
  },
};

// ─── Context ────────────────────────────────────────────────────────────────

const compactCommand: SlashCommandDef = {
  name: "compact",
  description: "Summarize conversation to free context",
  argsHint: "[focus]",
  async execute(args, ctx) {
    const state = ctx.getAppState();
    if (state.busy) {
      ctx.push("can't compact while a turn is running", "warn");
      return;
    }
    const focus = args.join(" ").trim() || undefined;
    ctx.push(focus ? `compacting (focus: ${focus})…` : "compacting…");
    try {
      const r = await ctx.engine.runCompact(focus);
      ctx.push(
        r.droppedCount === 0
          ? "nothing to compact"
          : `compacted ${r.droppedCount} messages into summary`
      );
    } catch (e) {
      ctx.push(
        `compact failed: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    }
  },
};

// ─── Model ──────────────────────────────────────────────────────────────────

const modelCommand: SlashCommandDef = {
  name: "model",
  description: "Show or switch model",
  argsHint: "[id]",
  execute(args, ctx) {
    if (args[0]) {
      const m = args[0];
      ctx.engine.setModel?.(m);
      ctx.setAppState((s) => ({ ...s, currentModel: m }));
      ctx.stats.currentModel = m;
      ctx.push(`model → ${m}`);
    } else {
      ctx.setAppState((s) => ({ ...s, overlay: "model-picker" }));
    }
  },
};

const modelsCommand: SlashCommandDef = {
  name: "models",
  description: "List models available from current provider",
  async execute(_, ctx) {
    try {
      const models = await ctx.provider.listModels();
      ctx.push(models.length ? models.join("\n") : "(no models installed)");
    } catch (e) {
      ctx.push(e instanceof Error ? e.message : String(e), "error");
    }
  },
};

// ─── Tools & Tasks ──────────────────────────────────────────────────────────

const toolsCommand: SlashCommandDef = {
  name: "tools",
  description: "List registered tools",
  execute(_, ctx) {
    ctx.push(ctx.registry.list().map((t) => `${t.name} — ${t.description}`).join("\n"));
  },
};

const todosCommand: SlashCommandDef = {
  name: "todos",
  description: "Show current task list",
  execute(_, ctx) {
    ctx.push(renderTodos(getTodos()));
  },
};

const planCommand: SlashCommandDef = {
  name: "plan",
  description: "Toggle plan mode (read-only; blocks writes)",
  argsHint: "[on|off]",
  execute(args, ctx) {
    const state = ctx.getAppState();
    let next: boolean;
    if (args[0] === "on") next = true;
    else if (args[0] === "off") next = false;
    else next = !state.planMode;
    ctx.setAppState((s) => ({ ...s, planMode: next }));
    ctx.push(`plan mode ${next ? "ON — writes/edits/bash blocked" : "OFF"}`);
  },
};

const worktreeCommand: SlashCommandDef = {
  name: "worktree",
  description: "Show / manage worktree state",
  execute(_, ctx) {
    const state = ctx.getAppState();
    ctx.push(
      state.worktreePath
        ? `active worktree: ${state.worktreePath}`
        : "no active worktree (use the EnterWorktree tool to create one)"
    );
  },
};



// ─── Stats & Cost ───────────────────────────────────────────────────────────

const costCommand: SlashCommandDef = {
  name: "cost",
  description: "Show token usage and cost estimate",
  passthrough: true,
  execute(_, ctx) {
    const state = ctx.getAppState();
    const t = ctx.stats.totals();
    const c = costFor(
      ctx.provider.info.name,
      state.currentModel,
      t.promptTokens,
      t.completionTokens,
      ctx.pricing
    );
    ctx.push(
      [
        `turns: ${t.turns} · requests: ${t.requests}`,
        `tokens: ${t.promptTokens.toLocaleString()} in / ${t.completionTokens.toLocaleString()} out`,
        `api time: ${(t.apiMs / 1000).toFixed(1)}s · wall: ${(t.wallMs / 1000).toFixed(1)}s`,
        c === null
          ? "cost: $— (add pricing to ~/.my-code/pricing.json)"
          : `cost: ${formatCost(c)}`,
      ].join("\n")
    );
  },
};

const statusCommand: SlashCommandDef = {
  name: "status",
  description: "Current session dashboard",
  execute(_, ctx) {
    ctx.setAppState((s) => ({
      ...s,
      overlay: s.overlay === "status" ? "none" : "status",
    }));
  },
};

const usageCommand: SlashCommandDef = {
  name: "usage",
  description: "Today / week / all-time usage across sessions",
  execute(_, ctx) {
    ctx.setAppState((s) => ({
      ...s,
      overlay: s.overlay === "usage" ? "none" : "usage",
    }));
  },
};

// ─── Sessions ───────────────────────────────────────────────────────────────

const sessionsCommand: SlashCommandDef = {
  name: "sessions",
  description: "List recent sessions for this project",
  argsHint: "[--all]",
  async execute(args, ctx) {
    try {
      const all = args.includes("--all");
      const metas = all
        ? await listAllSessionMetas(30)
        : await listSessionMetas(ctx.cwd);
      ctx.push(formatSessionList(metas));
    } catch (e) {
      ctx.push(
        `sessions failed: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    }
  },
};

const resumeCommand: SlashCommandDef = {
  name: "resume",
  description: "Resume a previous session",
  argsHint: "[session-id]",
  async execute(args, ctx) {
    const state = ctx.getAppState();
    if (state.busy) {
      ctx.push("can't resume while a turn is running", "warn");
      return;
    }
    const sessionId = args[0];
    try {
      const dir = sessionDir(ctx.cwd);
      let filePath: string;
      if (sessionId) {
        filePath = `${dir}/${sessionId}.jsonl`;
      } else {
        const metas = await listSessionMetas(ctx.cwd);
        if (metas.length === 0) {
          ctx.push("no sessions found for this project", "warn");
          return;
        }
        filePath = `${dir}/${metas[0].id}.jsonl`;
        ctx.push(`resuming session ${metas[0].id}…`);
      }
      const messages = await messagesFromTranscript(filePath);
      if (!messages) {
        ctx.push("could not load session (no checkpoint found)", "warn");
        return;
      }
      ctx.engine.setMessages(messages);
      ctx.push(`✔ loaded ${messages.length} messages from previous session`);
    } catch (e) {
      ctx.push(
        `resume failed: ${e instanceof Error ? e.message : String(e)}`,
        "error"
      );
    }
  },
};

// ─── Config ─────────────────────────────────────────────────────────────────

const configCommand: SlashCommandDef = {
  name: "config",
  description: "Get or set global config",
  argsHint: "get|set <key> [value]",
  async execute(args, ctx) {
    const sub = args[0];
    if (sub === "get") {
      const key = args[1];
      if (!key) {
        ctx.push("usage: /config get <key>", "warn");
        return;
      }
      const cfg = await listConfig();
      ctx.push(`${key} = ${(cfg as Record<string, string>)[key] ?? "(not set)"}`);
    } else if (sub === "set") {
      const key = args[1];
      const value = args.slice(2).join(" ");
      if (!key || !value) {
        ctx.push("usage: /config set <key> <value>", "warn");
        return;
      }
      try {
        const { file, key: nk } = await setConfigKey(key, value);
        ctx.push(`✔ ${nk} saved to ${file}`);
      } catch (e) {
        ctx.push(
          `config set failed: ${e instanceof Error ? e.message : String(e)}`,
          "error"
        );
      }
    } else {
      const cfg = await listConfig();
      const entries = Object.entries(cfg);
      ctx.push(
        entries.length === 0
          ? "(no config set — use /config set <key> <value>)"
          : entries.map(([k, v]) => `  ${k.padEnd(18)} ${v}`).join("\n")
      );
    }
  },
};

// ─── Export all built-in commands ────────────────────────────────────────────

// ─── Plugins (Phase 4.1) ────────────────────────────────────────────────────

const pluginsCommand: SlashCommandDef = {
  name: "plugins",
  description: "List loaded plugins",
  async execute(_, ctx) {
    try {
      const { formatPluginList } = await import("../plugins/index.js");
      // Access plugin list from the context if available
      const plugins = (ctx as any)._loadedPlugins ?? [];
      ctx.push(formatPluginList(plugins));
    } catch (e) {
      ctx.push(`plugins error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  },
};

// ─── Skills (Phase 4.2) ─────────────────────────────────────────────────────

const skillsCommand: SlashCommandDef = {
  name: "skills",
  description: "List custom slash commands from .md files",
  async execute(_, ctx) {
    try {
      const { loadSkills, formatSkillList } = await import("../skills/index.js");
      const skills = await loadSkills(ctx.cwd);
      ctx.push(formatSkillList(skills));
    } catch (e) {
      ctx.push(`skills error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  },
};

// ─── Background Tasks (Phase 4.4) ───────────────────────────────────────────

const tasksCommand: SlashCommandDef = {
  name: "tasks",
  description: "List / manage background tasks",
  aliases: ["bg"],
  argsHint: "[stop <id>]",
  execute(args, ctx) {
    const tasks = Object.values(ctx.getAppState().tasks ?? {}) as LocalShellTaskState[];

    if (args[0] === "stop" && args[1]) {
      const id = args[1];
      const task = ctx.getAppState().tasks?.[id] as LocalShellTaskState | undefined;
      if (!task) {
        ctx.push(`task ${id} not found`, "warn");
        return;
      }
      if (task.status !== "running") {
        ctx.push(`task ${id} is not running (${task.status})`, "warn");
        return;
      }
      killTask(id, ctx.setAppState);
      ctx.push(`stopped task ${id}`);
      return;
    }

    if (tasks.length === 0) {
      ctx.push("no background tasks");
      return;
    }

    const lines = tasks.map(t => {
      const age = t.startTime
        ? `${Math.floor((Date.now() - t.startTime) / 1000)}s ago`
        : "?";
      const cmd = t.type === "local_bash"
        ? (t.command?.split("\n")[0]?.slice(0, 60) ?? t.description)
        : t.description;
      return `[${t.status.padEnd(9)}] ${t.id}  ${cmd}  (${age})`;
    });

    // ─── Structured tasks (TaskCreate/TaskUpdate system) ───
    const structured = listStructuredTasks();
    if (structured.length > 0) {
      lines.push("", "── Structured Tasks ──");
      for (const t of structured) {
        const mark =
          t.status === "completed" ? "[x]" :
          t.status === "in_progress" ? "[~]" : "[ ]";
        const blocked =
          t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
        lines.push(`${mark} [${t.id}] ${t.subject}${blocked}`);
      }
    }

    // ─── Background agent tasks (LocalAgentTask) ───
    const agentTasks = Object.values(ctx.getAppState().tasks ?? {})
      .filter(isLocalAgentTask);
    if (agentTasks.length > 0) {
      lines.push("", "── Agent Tasks ──");
      for (const t of agentTasks) {
        const age = t.startTime
          ? `${Math.floor((Date.now() - t.startTime) / 1000)}s ago`
          : "?";
        const tools = t.toolUseCount > 0 ? ` [${t.toolUseCount} tool calls]` : "";
        // Phase 22: show live progress phrase from Agent Summary Service
        const summaryPhrase = t.summary ? ` — "${t.summary}"` : "";
        lines.push(`[${t.status.padEnd(9)}] ${t.id}  ${t.description.slice(0, 60)}${tools}${summaryPhrase}  (${age})`);
      }
    }

    if (lines.length === 0 && agentTasks.length === 0 && structured.length === 0) {
      ctx.push("no background tasks");
      return;
    }

    ctx.push(lines.join("\n"));
  },
};

// ─── File History & Undo (Phase 4.7) ────────────────────────────────────────

const undoCommand: SlashCommandDef = {
  name: "undo",
  description: "Undo file changes",
  argsHint: "[<file> | turn <n> | all]",
  async execute(args, ctx) {
    try {
      const history = (ctx as any)._fileHistory;
      if (!history) {
        ctx.push("file history not available", "warn");
        return;
      }

      if (args[0] === "all") {
        const { undone, errors } = await history.undoAll();
        ctx.push(`undid ${undone} change(s)${errors.length ? `\n  errors: ${errors.join(", ")}` : ""}`);
      } else if (args[0] === "turn" && args[1]) {
        const turnId = parseInt(args[1], 10);
        const { undone, errors } = await history.undoTurn(turnId);
        ctx.push(`undid ${undone} change(s) from turn #${turnId}${errors.length ? `\n  errors: ${errors.join(", ")}` : ""}`);
      } else if (args[0]) {
        const { success, message } = await history.undoFile(args[0]);
        ctx.push(message, success ? "info" : "warn");
      } else {
        ctx.push("usage: /undo <file> | /undo turn <n> | /undo all", "warn");
      }
    } catch (e) {
      ctx.push(`undo error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  },
};

const historyCommand: SlashCommandDef = {
  name: "history",
  description: "Show file modification history",
  argsHint: "[<file>] [--limit N]",
  execute(args, ctx) {
    try {
      const history = (ctx as any)._fileHistory;
      if (!history) {
        ctx.push("file history not available", "warn");
        return;
      }

      let file: string | undefined;
      let limit: number | undefined;

      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) {
          limit = parseInt(args[i + 1]!, 10);
          i++;
        } else {
          file = args[i];
        }
      }

      ctx.push(history.format({ file, limit: limit ?? 20 }));
    } catch (e) {
      ctx.push(`history error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  },
};

// ─── Session Export (Phase 4) ───────────────────────────────────────────────

const exportCommand: SlashCommandDef = {
  name: "export",
  description: "Export current session as markdown",
  argsHint: "[<file>]",
  async execute(args, ctx) {
    try {
      const { exportSessionAsMarkdown } = await import("../session/transcript.js");
      const transcript = (ctx as any)._transcript;
      if (!transcript?.filePath) {
        ctx.push("no active transcript to export", "warn");
        return;
      }

      const md = await exportSessionAsMarkdown(transcript.filePath);
      const outFile = args[0] ?? "session-export.md";

      const fsModule = await import("node:fs/promises");
      await fsModule.writeFile(outFile, md, "utf8");
      ctx.push(`✔ exported to ${outFile} (${md.length} chars)`);
    } catch (e) {
      ctx.push(`export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  },
};

// ─── Phase 25 Commands ────────────────────────────────────────────

const commitCommand: SlashCommandDef = {
  name: "commit",
  description: "Stage all changes and commit (auto-generates message if none given)",
  argsHint: "[message]",
  async execute(args, ctx) {
    const msg = args.join(" ").trim();
    if (msg) {
      await ctx.submitPrompt(
        `Stage all changes and commit with this message: "${msg}". ` +
        `Run: git add -A && git commit -m "${msg}". Show the result.`
      );
    } else {
      await ctx.submitPrompt(
        "Look at the current git diff (git diff and git diff --cached), write a concise " +
        "commit message following conventional commits format (type: short summary), then " +
        "run: git add -A && git commit -m \"<message>\". Show the final commit hash and message."
      );
    }
  },
};

const reviewCommand: SlashCommandDef = {
  name: "review",
  description: "Code-review the current git diff",
  argsHint: "[file]",
  async execute(args, ctx) {
    const file = args[0] ? ` for ${args[0]}` : "";
    await ctx.submitPrompt(
      `Please do a thorough code review of the current git diff${file}. ` +
      `Run git diff${args[0] ? ` -- ${args[0]}` : ""} to see what changed. ` +
      `Check for: correctness, edge cases, security issues, performance problems, and style consistency. ` +
      `Be specific — cite file paths and line numbers where relevant.`
    );
  },
};

const doctorCommand: SlashCommandDef = {
  name: "doctor",
  description: "Diagnose CLI setup: git, tools, MCP, permissions",
  async execute(_, ctx) {
    const lines: string[] = ["── CLI Doctor ──"];
    // Git
    try {
      const { execSync } = await import("node:child_process");
      const branch = execSync("git branch --show-current", {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      lines.push(`✔ git: ok (branch: ${branch || "detached"})`);
    } catch {
      lines.push("✗ git: not a git repo or git not installed");
    }
    // Tools
    const toolCount = ctx.registry.list().length;
    lines.push(`✔ tools: ${toolCount} registered`);
    // MCP
    const mcpCount = ctx.registry.list().filter(t => t.name.startsWith("mcp__")).length;
    lines.push(
      mcpCount > 0
        ? `✔ MCP: ${mcpCount} tool(s) loaded`
        : "⚠ MCP: no tools loaded (check .my-code/mcp.json)"
    );
    // Permissions
    const snap = ctx.permissions.snapshot();
    const bypassOn = snap.session.bypassAll || !!snap.project.bypassAll || !!snap.global.bypassAll;
    lines.push(`${bypassOn ? "⚠" : "✔"} permissions: bypass=${bypassOn ? "ON" : "off"}`);
    // cwd
    lines.push(`✔ cwd: ${ctx.cwd}`);
    ctx.push(lines.join("\n"));
  },
};

// ─── Memory Management (Phase 23) ────────────────────────────────────────────

const memoryCommand: SlashCommandDef = {
  name: "memory",
  description: "Manage persistent memory files",
  argsHint: "list | show <file> | delete <file> | scan",
  async execute(args, ctx) {
    const sub = args[0];
    const memDir = getAutoMemPath(ctx.cwd);

    if (!sub || sub === "list") {
      // ── list: scan directory and print manifest ──────────────────────────
      const headers = await scanMemoryFiles(memDir);
      if (headers.length === 0) {
        ctx.push("No memory files found in .my-code/memory/\n" +
          "Ask me to remember something, or use /memory add <text>");
        return;
      }
      ctx.push(
        `Memory files (${headers.length}):\n\n` + formatMemoryManifest(headers)
      );

    } else if (sub === "show") {
      // ── show: read a specific memory file ───────────────────────────────
      const rel = args.slice(1).join(" ").trim();
      if (!rel) { ctx.push("usage: /memory show <filename>", "warn"); return; }
      const headers = await scanMemoryFiles(memDir);
      const match = headers.find(
        (h) => h.filename === rel || h.filename.includes(rel)
      );
      if (!match) {
        ctx.push(`Memory file not found: "${rel}"\nUse /memory list to see all files.`, "warn");
        return;
      }
      const content = await readMemoryFile(match.filePath);
      if (!content) {
        ctx.push(`Could not read: ${match.filename}`, "error");
        return;
      }
      ctx.push(`── ${match.filename} ──\n\n${content.trim()}`);

    } else if (sub === "delete") {
      // ── delete: remove a memory file ────────────────────────────────────
      const rel = args.slice(1).join(" ").trim();
      if (!rel) { ctx.push("usage: /memory delete <filename>", "warn"); return; }
      const headers = await scanMemoryFiles(memDir);
      const match = headers.find(
        (h) => h.filename === rel || h.filename.includes(rel)
      );
      if (!match) {
        ctx.push(`Memory file not found: "${rel}"\nUse /memory list to see all files.`, "warn");
        return;
      }
      const ok = await deleteMemoryFile(match.filePath);
      ctx.push(
        ok
          ? `Deleted: ${match.filename}`
          : `Failed to delete: ${match.filename}`,
        ok ? "info" : "error"
      );

    } else if (sub === "scan") {
      // ── scan: quick stats about the memory directory ─────────────────────
      const headers = await scanMemoryFiles(memDir);
      const byType = new Map<string, number>();
      for (const h of headers) {
        const k = h.type ?? "untyped";
        byType.set(k, (byType.get(k) ?? 0) + 1);
      }
      const breakdown = Array.from(byType.entries())
        .map(([t, n]) => `  ${t}: ${n}`)
        .join("\n");
      ctx.push(
        `Memory scan:\n  Total files: ${headers.length}\n${breakdown}\n  Directory: ${memDir}`
      );

    } else if (sub === "add") {
      // ── add: ask the LLM to save a fact ─────────────────────────────────
      const text = args.slice(1).join(" ").trim();
      if (!text) { ctx.push("usage: /memory add <text>", "warn"); return; }
      await ctx.submitPrompt(
        `Save this fact to memory: "${text}". ` +
        `Write it to an appropriate file in .my-code/memory/ with proper frontmatter. ` +
        `Choose the right type (user/feedback/project/reference) and add a description.`
      );

    } else {
      ctx.push(
        "usage: /memory [list | show <file> | delete <file> | scan | add <text>]",
        "warn"
      );
    }
  },
};

const branchCommand: SlashCommandDef = {
  name: "branch",
  description: "Show current branch or create and switch to a new one",
  argsHint: "[name]",
  async execute(args, ctx) {
    const name = args[0];
    if (name) {
      await ctx.submitPrompt(
        `Create and switch to git branch "${name}". Run: git checkout -b ${name}. Show the result.`
      );
    } else {
      await ctx.submitPrompt(
        "Show the current git branch and list all local branches with their latest commit. Run: git branch -v"
      );
    }
  },
};

const diffCommand: SlashCommandDef = {
  name: "diff",
  description: "Show git diff for the whole repo or a specific file",
  argsHint: "[file]",
  async execute(args, ctx) {
    const file = args[0] ?? "";
    await ctx.submitPrompt(
      `Show the current git diff${file ? ` for ${file}` : ""}. ` +
      `Run: git diff${file ? ` -- ${file}` : ""}. ` +
      `After showing the diff, summarise the changes in plain English (what was added, removed, or changed and why).`
    );
  },
};

const releaseNotesCommand: SlashCommandDef = {
  name: "release-notes",
  description: "Show what's new in this version of my-code",
  aliases: ["changelog"],
  passthrough: true,
  execute(_, ctx) {
    const notes = [
      "## my-code v0.3.0-dev",
      "",
      "### Phases completed",
      "- **Phase 10**: Full system prompt parity with beta",
      "- **Phase 13**: TaskCreate, TaskGet, TaskUpdate — structured task management with stable IDs",
      "- **Phase 19**: Background sub-agents via Agent { background: true }",
      "- **Phase 24**: 8 bundled skills — debug, simplify, verify, remember, batch, loop, skillify, keybindings",
      "- **Phase 25**: New slash commands — /commit, /review, /doctor, /memory, /branch, /diff",
      "- **LSP**: Language server diagnostics injected between turns",
      "- **Bridge**: IDE integration via local Unix/TCP socket",
      "- **Worktrees**: EnterWorktree/ExitWorktree for parallel branch work",
      "- **Plugins**: Load custom tools from .my-code/plugins/",
      "",
      "### Quick reference",
      "  /help       — all commands",
      "  /skills     — all skills",
      "  /tasks      — background tasks + agent tasks",
      "  /doctor     — diagnose your setup",
    ];
    ctx.push(notes.join("\n"));
  },
};

const accountsCommand: SlashCommandDef = {
  name: "accounts",
  description: "Manage provider accounts (add / switch / quota)",
  argsHint: "[list|add|use <name>|remove <name>]",
  aliases: ["account"],
  async execute(args, ctx) {
    const sub = args[0];

    // Bare /accounts → open the interactive overlay.
    if (!sub) {
      ctx.setAppState((s) => ({ ...s, overlay: "accounts", accountsAddMode: false }));
      return;
    }

    if (sub === "add") {
      // Always launches the guided add flow (provider chooser → name → hidden
      // key). Keys are never passed on the command line.
      ctx.setAppState((s) => ({ ...s, overlay: "accounts", accountsAddMode: true }));
      return;
    }

    if (sub === "list") {
      const [accts, activeId] = await Promise.all([listAccounts(), getActiveAccountId()]);
      if (accts.length === 0) {
        ctx.push("no accounts configured — use /accounts add");
        return;
      }
      const lines = accts.map((a) => {
        const mark = a.id === activeId ? "●" : " ";
        const wired = isProviderWired(a.provider) ? "" : "  (not wired)";
        return `${mark} ${a.name}  [${a.provider}]  ${maskKey(a.apiKey)}${wired}`;
      });
      ctx.push(lines.join("\n"));
      return;
    }

    if (sub === "use") {
      const token = args.slice(1).join(" ").trim();
      if (!token) {
        ctx.push("usage: /accounts use <name>", "warn");
        return;
      }
      const acc = resolveAccount(await listAccounts(), token);
      if (!acc) {
        ctx.push(`no account matching "${token}"`, "warn");
        return;
      }
      await ctx.switchAccount(acc);
      return;
    }

    if (sub === "remove") {
      const token = args.slice(1).join(" ").trim();
      const acc = resolveAccount(await listAccounts(), token);
      if (!acc) {
        ctx.push(`no account matching "${token}"`, "warn");
        return;
      }
      await removeAccount(acc.id);
      ctx.push(`✔ removed ${acc.provider} account "${acc.name}"`);
      return;
    }

    ctx.push("usage: /accounts [list | add | use <name> | remove <name>]");
  },
};

export const builtinCommands: SlashCommandDef[] = [
  accountsCommand,
  helpCommand,
  initCommand,
  clearCommand,
  exitCommand,
  allowCommand,
  denyCommand,
  bypassCommand,
  permissionsCommand,
  compactCommand,
  modelCommand,
  modelsCommand,
  toolsCommand,
  todosCommand,
  planCommand,
  worktreeCommand,
  mcpCommand,
  costCommand,
  statusCommand,
  usageCommand,
  sessionsCommand,
  resumeCommand,
  configCommand,
  // Phase 4 commands
  pluginsCommand,
  skillsCommand,
  tasksCommand,
  undoCommand,
  historyCommand,
  exportCommand,
  // Phase 25 commands
  commitCommand,
  reviewCommand,
  doctorCommand,
  memoryCommand,
  branchCommand,
  diffCommand,
  releaseNotesCommand,
];

