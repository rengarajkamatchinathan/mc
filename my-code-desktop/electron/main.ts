/**
 * Electron main process for my-code-desktop.
 *
 * Owns the BrowserWindow and a single `my-code serve` backend (see backend.ts).
 * Relays the backend's bridge events to the renderer over IPC, and forwards
 * renderer commands (submit / abort / permission answers / mode switch) back.
 *
 * There is no in-process engine — the agent is the external my-code CLI.
 */

import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile, mkdir, rm } from "node:fs/promises";
import { Backend, resolveCliPath } from "./backend.js";
import {
  beginMicrosoftLogin,
  microsoftStatus,
  microsoftLogout,
  listMcpServers,
  setMcpServer,
  removeMcpServer,
  microsoftServerCfg,
  discoverMcpTools,
  type McpServerCfg,
} from "./connectors.js";
import * as store from "./settings-store.js";
import {
  IPC,
  type AccountInput,
  type Bootstrap,
  type ConnectorEvent,
  type ConnectorInfo,
  type CustomMcpInput,
  type EngineEvent,
  type Mode,
  type ModelSettings,
  type ModelSettingsPatch,
  type PermEdit,
  type PermissionChoice,
  type SessionMeta,
} from "./ipc.js";

let win: BrowserWindow | null = null;
let backend: Backend | null = null;
let mode: Mode = "chat";
let projectCwd: string = homedir(); // chat mode default; code mode overrides via folder picker
let startToken = 0; // guards against overlapping starts (StrictMode double-mount, rapid clicks)
let yolo = false; // "skip all permissions" — loaded from prefs, passed to serve
let theme: import("./ipc.js").Theme = {};
let myCodeCli: string | undefined; // explicit path to the my-code CLI (prefs override)

function prefsFile(): string {
  return join(homedir(), ".my-code-desktop", "prefs.json");
}
/** Global agent instructions file that `my-code serve` reads into its system prompt. */
function instructionsFile(): string {
  return join(homedir(), ".my-code", "my-code.md");
}
async function loadPrefs(): Promise<void> {
  try {
    const p = JSON.parse(await readFile(prefsFile(), "utf8")) as {
      yolo?: boolean;
      myCodeCli?: string;
    } & import("./ipc.js").Theme;
    yolo = !!p.yolo;
    theme = {
      accent: p.accent,
      accentHover: p.accentHover,
      mode: p.mode,
      font: p.font,
      reduceMotion: p.reduceMotion,
      preferredName: p.preferredName,
    };
    myCodeCli = p.myCodeCli;
  } catch {
    yolo = false;
    theme = {};
    myCodeCli = undefined;
  }
}
async function savePrefs(): Promise<void> {
  await mkdir(join(homedir(), ".my-code-desktop"), { recursive: true });
  await writeFile(prefsFile(), JSON.stringify({ yolo, ...theme, myCodeCli }, null, 2), "utf8");
}

/**
 * Resolve the my-code CLI. A packaged app has no sibling `my-code` checkout, so
 * the path is supplied out-of-band: MY_CODE_CLI env wins, then prefs.json
 * (`myCodeCli`), then the dev-layout sibling. Kept as a function (not a const)
 * because prefs load after app-ready.
 */
function cliPath(): string {
  const env = process.env.MY_CODE_CLI;
  if (env && existsSync(env)) return env;
  if (myCodeCli && existsSync(myCodeCli)) return myCodeCli;
  return resolveCliPath();
}

/**
 * Default location of the synfra project's `.env` (used to pre-fill the Azure
 * Foundry add-account form). synfra sits next to the "Game Changers" folder
 * under Synergech; override with MC_SYNFRA_ENV if it lives elsewhere.
 */
function defaultSynfraEnvPath(): string {
  return process.env.MC_SYNFRA_ENV || join(__dirname, "..", "..", "..", "..", "synfra", ".env");
}

function send(ev: EngineEvent): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.engineEvent, ev);
}

// ─── my-code on-disk session store (read-only mirror) ───

function myCodeDir(): string {
  return join(homedir(), ".my-code");
}
function sessionDirFor(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(myCodeDir(), "projects", hash, "sessions");
}

// ── User-assigned session titles (rename), kept by the desktop app ──
function titlesFile(): string {
  return join(homedir(), ".my-code-desktop", "titles.json");
}
async function loadTitles(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(titlesFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}
async function saveTitle(id: string, title: string | null): Promise<void> {
  const titles = await loadTitles();
  if (title) titles[id] = title;
  else delete titles[id];
  await mkdir(join(homedir(), ".my-code-desktop"), { recursive: true });
  await writeFile(titlesFile(), JSON.stringify(titles, null, 2), "utf8");
}

/** Pull the first user message from a session file (handles user-line and checkpoint formats). */
function previewFrom(raw: string): string | undefined {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        content?: string;
        messages?: { role?: string; content?: string }[];
      };
      if (rec.type === "user" && rec.content) return rec.content.slice(0, 80);
      if (rec.type === "checkpoint" && rec.messages) {
        const u = rec.messages.find((m) => m.role === "user" && m.content?.trim());
        if (u?.content) return u.content.slice(0, 80);
      }
    } catch {
      /* skip malformed */
    }
  }
  return undefined;
}

async function listSessionMetas(cwd: string): Promise<SessionMeta[]> {
  const dir = sessionDirFor(cwd);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const titles = await loadTitles();
  const metas: SessionMeta[] = [];
  for (const f of files) {
    const full = join(dir, f);
    const id = f.replace(/\.jsonl$/, "");
    try {
      const st = await stat(full);
      if (st.size === 0) continue;
      // Prefer the meta.json summary (cheap); fall back to parsing the jsonl.
      let preview: string | undefined;
      try {
        const meta = JSON.parse(await readFile(join(dir, `${id}.meta.json`), "utf8")) as {
          summary?: string;
        };
        if (meta.summary) preview = meta.summary.slice(0, 80);
      } catch {
        /* no meta */
      }
      if (!preview) preview = previewFrom(await readFile(full, "utf8"));
      metas.push({ id, firstPrompt: titles[id] ?? preview, updatedAt: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  metas.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return metas.slice(0, 40);
}

async function deleteSession(cwd: string, id: string): Promise<void> {
  const dir = sessionDirFor(cwd);
  await rm(join(dir, `${id}.jsonl`), { force: true });
  await rm(join(dir, `${id}.meta.json`), { force: true });
  await saveTitle(id, null);
}

// Directories never worth surfacing in the @-file picker.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "release",
  ".vite", "coverage", ".turbo", "__pycache__", ".cache",
]);

/** Recursive, capped list of project files (POSIX-relative) for @-mentions. */
async function listProjectFiles(cwd: string | null): Promise<string[]> {
  if (!cwd) return [];
  const results: string[] = [];
  const CAP = 2000;
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (results.length >= CAP || depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= CAP) return;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name), relPath, depth + 1);
      } else if (e.isFile()) {
        results.push(relPath);
      }
    }
  }
  await walk(cwd, "", 0);
  return results.sort();
}

// ─── backend lifecycle ───

async function startBackend(opts: { sessionId?: string } = {}): Promise<Bootstrap> {
  const myToken = ++startToken;
  if (backend) await backend.stop();
  await syncBuiltinMcpPaths(); // keep built-in connector paths valid across app moves
  const b = new Backend({
    cliPath: cliPath(),
    cwd: projectCwd,
    mode,
    sessionId: opts.sessionId,
    yolo,
    onEvent: (ev) => {
      if (myToken === startToken) relay(ev);
    },
  });
  backend = b;
  let hs;
  try {
    hs = await b.start();
  } catch (e) {
    // Superseded by a newer start (e.g. StrictMode remount) — stay quiet.
    if (myToken !== startToken) {
      return { mode, model: "—", cwd: mode === "code" ? projectCwd : null, sessionId: null, cloud: false };
    }
    const message = e instanceof Error ? e.message : String(e);
    send({ type: "backend_error", message });
    return { mode, model: "—", cwd: mode === "code" ? projectCwd : null, sessionId: null, cloud: false };
  }
  if (myToken !== startToken) {
    // A newer start won the race; discard this one.
    void b.stop();
    return { mode, model: "—", cwd: mode === "code" ? projectCwd : null, sessionId: null, cloud: false };
  }
  return {
    mode,
    model: hs.model,
    cwd: mode === "code" ? hs.cwd : null,
    sessionId: hs.sessionId,
    cloud: false,
  };
}

/** Restart the backend in place (e.g. after connectors change), keeping the session. */
async function restartBackend(): Promise<void> {
  const sessionId = backend?.info()?.sessionId;
  await startBackend(sessionId ? { sessionId } : {});
  // Keep the renderer's model/session badge in sync with the new backend.
  if (win && !win.isDestroyed()) win.webContents.send(IPC.bootstrapChanged, bootstrapView());
}

/** Current backend state as a Bootstrap (for settings handlers that restart). */
function bootstrapView(): Bootstrap {
  const hs = backend?.info();
  return {
    mode,
    model: hs?.model ?? "—",
    cwd: mode === "code" ? hs?.cwd ?? projectCwd : null,
    sessionId: hs?.sessionId ?? null,
    cloud: false,
  };
}

/** Bundled skills live in the my-code source tree next to the CLI build. */
function bundledSkillsPath(): string {
  return join(dirname(cliPath()), "..", "src", "skills", "bundled");
}

function sendConnector(ev: ConnectorEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC.connectorEvent, ev);
}

/**
 * Paths to the bundled MCP assets. In a packaged app `mcp/` ships as an
 * extraResource under process.resourcesPath (it can't live inside app.asar —
 * these files are spawned as separate processes). In dev it sits next to out/.
 */
function mcpAssetDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "mcp") : join(__dirname, "..", "..", "mcp");
}
function microsoftServerPath(): string {
  return join(mcpAssetDir(), "microsoft", "server.mjs");
}
function listToolsHelperPath(): string {
  return join(mcpAssetDir(), "list-tools.mjs");
}

/** Resolve the MCP config for a connector id (built-in or custom). */
async function cfgForConnector(id: string): Promise<McpServerCfg | null> {
  if (id === "microsoft") return microsoftServerCfg(microsoftServerPath());
  const servers = await listMcpServers();
  return servers[id] ?? null;
}

/**
 * Keep the built-in Microsoft connector's mcp.json entry pointing at THIS app's
 * paths. The entry stores absolute paths (electron binary + server.mjs), which
 * break if the app is moved or renamed (e.g. `sunday` → `my-code-desktop`) — a
 * stale path makes `serve` fail to spawn the server and silently load 0 tools.
 * Runs before every backend start so the agent always gets a server that exists.
 */
async function syncBuiltinMcpPaths(): Promise<void> {
  try {
    const servers = await listMcpServers();
    if (!servers[BUILTIN.id]) return; // connector not enabled — nothing to sync
    const fresh = microsoftServerCfg(microsoftServerPath());
    const cur = servers[BUILTIN.id];
    if (cur.command !== fresh.command || JSON.stringify(cur.args) !== JSON.stringify(fresh.args)) {
      await setMcpServer(BUILTIN.id, fresh);
    }
  } catch {
    /* best-effort — never block backend startup */
  }
}

const BUILTIN = { id: "microsoft", label: "Microsoft 365", type: "Desktop" };

async function buildConnectorList(): Promise<ConnectorInfo[]> {
  const servers = await listMcpServers();
  const ms = await microsoftStatus();
  const list: ConnectorInfo[] = [
    {
      id: BUILTIN.id,
      label: BUILTIN.label,
      type: BUILTIN.type,
      custom: false,
      connected: ms.connected,
      enabled: Boolean(servers[BUILTIN.id]),
      account: ms.account,
    },
  ];
  for (const [name, cfg] of Object.entries(servers)) {
    if (name === BUILTIN.id) continue;
    list.push({
      id: name,
      label: name,
      type: cfg.type === "http" ? "Web" : "Custom",
      custom: true,
      connected: true,
      enabled: true,
    });
  }
  return list;
}

async function connectMicrosoft(): Promise<void> {
  try {
    const { prompt, completion } = await beginMicrosoftLogin();
    sendConnector({ type: "device_code", id: "microsoft", prompt });
    const account = await completion;
    await setMcpServer("microsoft", microsoftServerCfg(microsoftServerPath()));
    await restartBackend();
    sendConnector({ type: "connected", id: "microsoft", account });
  } catch (e) {
    sendConnector({ type: "error", id: "microsoft", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Translate backend events → renderer, adding derived mood state. */
function relay(ev: EngineEvent): void {
  switch (ev.type) {
    case "turn_start":
      send({ type: "state", state: "thinking" });
      break;
    case "assistant_delta":
      send({ type: "state", state: "streaming" });
      break;
    case "tool_start":
      send({ type: "state", state: "tool" });
      break;
    case "turn_end":
      send({ type: "state", state: "idle" });
      break;
  }
  send(ev);
}

// ─── IPC ───

function wireIpc(): void {
  ipcMain.handle(IPC.bootstrap, () => startBackend());

  ipcMain.handle(IPC.sendPrompt, (_e, text: string) => {
    backend?.submit(text);
  });
  ipcMain.handle(IPC.abort, () => backend?.cancel());
  ipcMain.handle(IPC.compact, () => backend?.compact());
  ipcMain.handle(
    IPC.answerPermission,
    (_e, toolUseId: string, choice: PermissionChoice) =>
      backend?.answerPermission(toolUseId, choice)
  );

  ipcMain.handle(IPC.setMode, async (_e, next: Mode, cwd?: string) => {
    mode = next;
    if (next === "code" && cwd) projectCwd = cwd;
    if (next === "chat") projectCwd = homedir();
    win?.webContents.send(IPC.clearTranscript);
    return startBackend();
  });

  ipcMain.handle(IPC.pickFolder, async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(IPC.listSessions, () => listSessionMetas(projectCwd));
  ipcMain.handle(IPC.listProjectFiles, () => listProjectFiles(projectCwd));
  ipcMain.handle(IPC.deleteSession, (_e, id: string) => deleteSession(projectCwd, id));
  ipcMain.handle(IPC.renameSession, (_e, id: string, title: string) => saveTitle(id, title));

  ipcMain.handle(IPC.resumeSession, async (_e, id: string) => {
    win?.webContents.send(IPC.clearTranscript);
    const boot = await startBackend({ sessionId: id });
    // Replay the resumed conversation into the transcript — it predates the
    // live event stream, so the GUI would otherwise show a blank thread.
    if (backend) {
      const messages = await backend.history();
      if (messages.length && win && !win.isDestroyed()) {
        win.webContents.send(IPC.loadTranscript, messages);
      }
    }
    return boot;
  });

  ipcMain.handle(IPC.newSession, async () => {
    win?.webContents.send(IPC.clearTranscript);
    return startBackend();
  });

  ipcMain.handle(IPC.listModels, () => (backend?.info() ? [backend.info()!.model] : []));
  ipcMain.handle(IPC.setModel, (_e, model: string) => {
    if (model) backend?.setModel(model);
  });

  // ── Connectors ──
  ipcMain.handle(IPC.listConnectors, () => buildConnectorList());
  ipcMain.handle(IPC.connectorTools, async (_e, id: string) => {
    const cfg = await cfgForConnector(id);
    if (!cfg) return [];
    return discoverMcpTools(cfg, listToolsHelperPath());
  });
  ipcMain.handle(IPC.connectConnector, async (_e, id: string) => {
    if (id === "microsoft") void connectMicrosoft();
    // custom connectors are added via addMcpServer, not connect
  });
  ipcMain.handle(IPC.disconnectConnector, async (_e, id: string) => {
    if (id === "microsoft") {
      await microsoftLogout();
      await removeMcpServer("microsoft");
    } else {
      await removeMcpServer(id);
    }
    await restartBackend();
  });
  ipcMain.handle(IPC.addMcpServer, async (_e, input: CustomMcpInput) => {
    if (!input.name?.trim()) return { ok: false, error: "name required" };
    const cfg: McpServerCfg =
      input.transport === "http"
        ? { type: "http", url: input.url, token: input.token }
        : { type: "stdio", command: input.command, args: input.args };
    if (input.transport === "http" && !input.url) return { ok: false, error: "url required" };
    if (input.transport === "stdio" && !input.command) return { ok: false, error: "command required" };
    await setMcpServer(input.name.trim(), cfg);
    await restartBackend();
    return { ok: true };
  });
  ipcMain.handle(IPC.removeMcpServer, async (_e, name: string) => {
    await removeMcpServer(name);
    await restartBackend();
  });
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    void shell.openExternal(url);
  });

  // ── Settings: Models & Providers ──
  ipcMain.handle(IPC.getModelSettings, async (): Promise<ModelSettings> => {
    const cfg = await store.readGlobalConfig();
    const local = await store.readLocalConfig();
    // Prefer the active provider account — that's the host + key `serve` actually
    // uses to resolve models. Falling back to ollamaHost would query a local
    // Ollama that may not be running, yielding an empty (misleading) model list.
    const { accounts, activeId } = await store.listAccounts();
    const active = accounts.find((a) => a.id === activeId);

    // Azure Foundry has no /api/tags — the callable model IS the deployment.
    if (active?.provider === "azure-foundry") {
      // Legacy accounts may lack meta; fall back to the name (= deployment).
      const model = active.meta?.model || active.meta?.deployment || active.name;
      return {
        provider: "azure-foundry",
        defaultModel: cfg.defaultModel,
        host: active.host,
        cloud: true,
        apiKeyMask: active.apiKey ? "****" + active.apiKey.slice(-4) : undefined,
        hasKey: !!active.apiKey,
        models: model ? [model] : [],
        currentModel: backend?.info()?.model,
      };
    }

    const host = active?.host || local.ollamaHost || cfg.ollamaHost || "http://localhost:11434";
    const apiKey = active?.apiKey || local.ollamaApiKey;
    const models = await store.fetchModels(host, apiKey);
    return {
      provider: active?.provider || cfg.provider || "ollama",
      defaultModel: cfg.defaultModel,
      host,
      cloud: host.includes("ollama.com"),
      apiKeyMask: apiKey ? "****" + apiKey.slice(-4) : undefined,
      hasKey: !!apiKey,
      models,
      currentModel: backend?.info()?.model,
    };
  });
  ipcMain.handle(IPC.saveModelSettings, async (_e, patch: ModelSettingsPatch) => {
    const cfgPatch: Parameters<typeof store.patchGlobalConfig>[0] = {};
    if (patch.provider !== undefined) cfgPatch.provider = patch.provider;
    if (patch.defaultModel !== undefined) cfgPatch.defaultModel = patch.defaultModel;
    if (patch.host !== undefined || patch.cloud !== undefined) {
      const host = patch.cloud ? "https://ollama.com" : patch.host || "http://localhost:11434";
      cfgPatch.ollamaHost = host;
      await store.patchLocalConfig({ ollamaHost: host });
    }
    if (Object.keys(cfgPatch).length) await store.patchGlobalConfig(cfgPatch);
    if (patch.apiKey) await store.patchLocalConfig({ ollamaApiKey: patch.apiKey });
    return restartBackend().then(() => bootstrapView());
  });

  // ── Settings: Accounts ──
  ipcMain.handle(IPC.getAccounts, async () => {
    const { accounts, activeId } = await store.listAccounts();
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        name: a.name,
        host: a.host,
        hasKey: !!a.apiKey,
        meta: a.meta,
      })),
      activeId,
    };
  });
  ipcMain.handle(IPC.addAccount, async (_e, input: AccountInput) => {
    await store.addAccount(input);
    // If we just edited/re-added the active account, restart so the new
    // endpoint/key/deployment takes effect immediately (no stale backend).
    const { activeId } = await store.listAccounts();
    if (activeId && activeId === `${input.provider}:${input.name}`) await restartBackend();
  });
  ipcMain.handle(IPC.readEnvDefaults, (_e, p?: string) =>
    store.readAzureEnvDefaults(p || defaultSynfraEnvPath())
  );
  ipcMain.handle(IPC.removeAccount, async (_e, id: string) => {
    const { activeId } = await store.listAccounts();
    await store.removeAccount(id);
    // Removing the account the backend is running on must not leave a stale
    // backend using deleted credentials.
    if (activeId === id) await restartBackend();
  });
  ipcMain.handle(IPC.setActiveAccount, async (_e, id: string) => {
    await store.setActiveAccount(id);
    await restartBackend();
    return bootstrapView();
  });
  ipcMain.handle(IPC.restartBackend, async () => {
    await restartBackend();
    return bootstrapView();
  });

  // ── Settings: Permissions ──
  ipcMain.handle(IPC.getPermissions, async () => {
    const cwd = mode === "code" ? projectCwd : null;
    const { global, project } = await store.readPermissions(cwd);
    return { global, project, yolo };
  });
  ipcMain.handle(IPC.editPermission, (_e, edit: PermEdit) =>
    store.editPermissionRule({ ...edit, cwd: mode === "code" ? projectCwd : null })
  );
  ipcMain.handle(IPC.setYolo, async (_e, on: boolean) => {
    yolo = on;
    await savePrefs();
    await restartBackend();
    return bootstrapView();
  });

  // ── Settings: Skills ──
  ipcMain.handle(IPC.getSkills, () =>
    store.listSkills(mode === "code" ? projectCwd : null, bundledSkillsPath())
  );
  ipcMain.handle(IPC.saveSkill, (_e, fileName: string, content: string) =>
    store.saveSkill(fileName, content)
  );
  ipcMain.handle(IPC.deleteSkill, (_e, path: string) => store.deleteSkillFile(path));
  ipcMain.on(IPC.openSkillsFolder, () => void shell.openPath(store.userSkillsFolder()));

  // ── Settings: Usage ──
  ipcMain.handle(IPC.getUsage, () => store.aggregateUsage(Date.now()));

  // ── Settings: Theme / appearance ──
  ipcMain.handle(IPC.getTheme, () => theme);
  ipcMain.handle(IPC.setTheme, async (_e, t: import("./ipc.js").Theme) => {
    theme = { ...theme, ...t }; // merge: panels send partial patches (accent vs mode/font/…)
    await savePrefs();
  });

  // ── Settings: global agent instructions (~/.my-code/my-code.md) ──
  ipcMain.handle(IPC.getInstructions, async () => {
    try {
      return await readFile(instructionsFile(), "utf8");
    } catch {
      return "";
    }
  });
  ipcMain.handle(IPC.setInstructions, async (_e, text: string) => {
    await mkdir(join(homedir(), ".my-code"), { recursive: true });
    await writeFile(instructionsFile(), text ?? "", "utf8");
  });

  ipcMain.on(IPC.windowMinimize, () => win?.minimize());
  ipcMain.on(IPC.windowToggleMaximize, () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(IPC.windowClose, () => win?.close());
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 780,
    minHeight: 600,
    // Opaque fallback — the window is never see-through if Mica is unsupported.
    backgroundColor: "#100f0e",
    // Win11: tints the window background from the desktop wallpaper (Mica). No-op
    // on other platforms; the renderer's translucent glass surfaces show it through.
    backgroundMaterial: "mica",
    title: "my-code",
    icon: join(__dirname, "..", "..", "build", "icon.ico"),
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (devServer) await win.loadURL(devServer);
  else await win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  await loadPrefs();
  wireIpc();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  void backend?.stop();
});

app.on("window-all-closed", () => {
  void backend?.stop();
  if (process.platform !== "darwin") app.quit();
});
