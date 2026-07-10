/**
 * IPC contract shared between the Electron main process and the renderer.
 *
 * The renderer never touches Node or the my-code backend directly. It goes
 * through `window.mycode` (defined by the preload), which forwards to the
 * handlers in main.ts. Main, in turn, drives a `my-code serve` child process
 * over its named-pipe bridge.
 *
 * Keep this file dependency-free so both processes can import it.
 */

export type Mode = "chat" | "code";

export type AgentMood = "idle" | "thinking" | "streaming" | "tool";

/** The my-code SessionEvent shape, mirrored here (see my-code/src/agent/events.ts). */
export interface DiffPayload {
  filePath: string;
  before: string;
  after: string;
  startLine: number;
}

export interface ToolChild {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface SuggestedRules {
  session: string;
  project: string;
}

/** Rich engine events relayed from the backend to the renderer. */
export type EngineEvent =
  | { type: "state"; state: AgentMood }
  | { type: "turn_start"; turnId: number }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_done"; text: string; durationMs: number }
  | { type: "tool_start"; toolUseId: string; name: string; args: Record<string, unknown> }
  | { type: "tool_progress"; toolUseId: string; message: string }
  | {
      type: "tool_result";
      toolUseId: string;
      name: string;
      result: string;
      isError: boolean;
      args?: Record<string, unknown>;
      diff?: DiffPayload;
      children?: ToolChild[];
    }
  | {
      type: "permission_request";
      toolUseId: string;
      name: string;
      args: Record<string, unknown>;
      suggestedRules: SuggestedRules;
    }
  | { type: "permission_decision"; toolUseId: string; choice: PermissionChoice }
  | { type: "token_stats"; promptTokens?: number; completionTokens?: number }
  | { type: "auto_compact"; droppedCount: number; freedTokens: number }
  | { type: "notice"; message: string; tone: "info" | "warn" | "error" }
  | { type: "turn_end"; turnId: number; reason: "complete" | "aborted" | "max_iterations" }
  | { type: "backend_error"; message: string };

export type PermissionChoice = "once" | "session" | "project" | "no";

/** A stored conversation message, used to replay history on resume. */
export interface HistoryMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id?: string; function: { name: string; arguments: string | Record<string, unknown> } }[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface SessionMeta {
  id: string;
  firstPrompt?: string;
  updatedAt?: number;
  turns?: number;
}

export interface ConnectorInfo {
  id: string;
  label: string;
  type: string; // "Desktop" | "Web" | "Custom"
  custom: boolean;
  connected: boolean;
  enabled: boolean;
  account?: string;
}

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  message: string;
}

export type ConnectorEvent =
  | { type: "device_code"; id: string; prompt: DeviceCodePrompt }
  | { type: "connected"; id: string; account?: string }
  | { type: "error"; id: string; message: string };

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface CustomMcpInput {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  token?: string;
}

// ── Settings panels ──
export interface ModelSettings {
  provider: string;
  defaultModel?: string;
  host?: string;
  cloud: boolean;
  apiKeyMask?: string;
  hasKey: boolean;
  models: string[];
  currentModel?: string;
}
export interface ModelSettingsPatch {
  provider?: string;
  defaultModel?: string;
  host?: string;
  apiKey?: string;
  cloud?: boolean;
}
/** Provider-specific extras (Azure Foundry deployment / apiVersion / model). */
export interface AccountMeta {
  deployment?: string;
  apiVersion?: string;
  model?: string;
}
export interface AccountView {
  id: string;
  provider: string;
  name: string;
  host?: string;
  hasKey: boolean;
  meta?: AccountMeta;
}
export interface AccountList {
  accounts: AccountView[];
  activeId?: string;
}
export interface AccountInput {
  provider: string;
  name: string;
  apiKey?: string;
  host?: string;
  meta?: AccountMeta;
}
/** Azure Foundry fields parsed from a .env file, used to pre-fill the add form. */
export interface AzureEnvDefaults {
  host?: string;
  apiKey?: string;
  apiVersion?: string;
  deployment?: string;
  model?: string;
}
export interface PermScope {
  allow: string[];
  deny: string[];
}
export interface Permissions {
  global: PermScope;
  project: PermScope;
  yolo: boolean;
}
export interface PermEdit {
  scope: "global" | "project";
  kind: "allow" | "deny";
  rule: string;
  op: "add" | "remove";
}
export interface SkillInfo {
  name: string;
  description: string;
  whenToUse?: string;
  source: "bundled" | "user" | "project";
  path?: string;
  body: string;
}
export interface ModelUsage {
  model: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
}
export interface UsageSummary {
  today: ModelUsage[];
  week: ModelUsage[];
  all: ModelUsage[];
  sessionCount: number;
}
/** Appearance colour mode. "system" follows the OS `prefers-color-scheme`. */
export type ThemeMode = "system" | "light" | "dark";
/** Font family applied to chat message text (code always stays monospace). */
export type ChatFont = "sans" | "serif" | "mono";

/**
 * Appearance + identity preferences, persisted in ~/.my-code-desktop/prefs.json.
 * (Historically just the accent colour — now the whole "General/Theme" bag.)
 */
export interface Theme {
  accent?: string;
  accentHover?: string;
  mode?: ThemeMode;
  font?: ChatFont;
  reduceMotion?: boolean;
  preferredName?: string;
}

export interface Bootstrap {
  mode: Mode;
  model: string;
  cwd: string | null;
  sessionId: string | null;
  cloud: boolean;
  contextLength?: number;
}

export const IPC = {
  /** renderer → main (invoke) */
  bootstrap: "mc:bootstrap",
  sendPrompt: "mc:send-prompt",
  abort: "mc:abort",
  compact: "mc:compact",
  answerPermission: "mc:answer-permission",
  setMode: "mc:set-mode",
  pickFolder: "mc:pick-folder",
  listSessions: "mc:list-sessions",
  listProjectFiles: "mc:list-project-files",
  deleteSession: "mc:delete-session",
  renameSession: "mc:rename-session",
  resumeSession: "mc:resume-session",
  newSession: "mc:new-session",
  listModels: "mc:list-models",
  setModel: "mc:set-model",
  listConnectors: "mc:list-connectors",
  connectorTools: "mc:connector-tools",
  connectConnector: "mc:connect-connector",
  disconnectConnector: "mc:disconnect-connector",
  addMcpServer: "mc:add-mcp-server",
  removeMcpServer: "mc:remove-mcp-server",
  openExternal: "mc:open-external",
  getModelSettings: "mc:get-model-settings",
  saveModelSettings: "mc:save-model-settings",
  getAccounts: "mc:get-accounts",
  addAccount: "mc:add-account",
  removeAccount: "mc:remove-account",
  setActiveAccount: "mc:set-active-account",
  restartBackend: "mc:restart-backend",
  readEnvDefaults: "mc:read-env-defaults",
  getPermissions: "mc:get-permissions",
  editPermission: "mc:edit-permission",
  setYolo: "mc:set-yolo",
  getSkills: "mc:get-skills",
  saveSkill: "mc:save-skill",
  deleteSkill: "mc:delete-skill",
  openSkillsFolder: "mc:open-skills-folder",
  getUsage: "mc:get-usage",
  getTheme: "mc:get-theme",
  setTheme: "mc:set-theme",
  getInstructions: "mc:get-instructions",
  setInstructions: "mc:set-instructions",
  windowMinimize: "mc:window-minimize",
  windowToggleMaximize: "mc:window-toggle-maximize",
  windowClose: "mc:window-close",
  /** main → renderer (one-way) */
  engineEvent: "mc:engine-event",
  bootstrapChanged: "mc:bootstrap-changed",
  clearTranscript: "mc:clear-transcript",
  loadTranscript: "mc:load-transcript",
  connectorEvent: "mc:connector-event",
} as const;

export interface McApi {
  bootstrap(): Promise<Bootstrap>;
  sendPrompt(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  answerPermission(toolUseId: string, choice: PermissionChoice): Promise<void>;
  setMode(mode: Mode, cwd?: string): Promise<Bootstrap>;
  pickFolder(): Promise<string | null>;
  listSessions(): Promise<SessionMeta[]>;
  listProjectFiles(): Promise<string[]>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  resumeSession(id: string): Promise<Bootstrap>;
  newSession(): Promise<Bootstrap>;
  listModels(): Promise<string[]>;
  setModel(model: string): Promise<void>;
  listConnectors(): Promise<ConnectorInfo[]>;
  connectorTools(id: string): Promise<McpToolInfo[]>;
  connectConnector(id: string): Promise<void>;
  disconnectConnector(id: string): Promise<void>;
  addMcpServer(input: CustomMcpInput): Promise<{ ok: boolean; error?: string }>;
  removeMcpServer(name: string): Promise<void>;
  openExternal(url: string): void;
  getModelSettings(): Promise<ModelSettings>;
  saveModelSettings(patch: ModelSettingsPatch): Promise<Bootstrap>;
  getAccounts(): Promise<AccountList>;
  addAccount(input: AccountInput): Promise<void>;
  removeAccount(id: string): Promise<void>;
  setActiveAccount(id: string): Promise<Bootstrap>;
  /** Restart the `my-code serve` child (used by the error card's Retry). */
  restartBackend(): Promise<Bootstrap>;
  /** Parse Azure Foundry fields from a .env file (default: the synfra project) to pre-fill the add form. */
  readEnvDefaults(path?: string): Promise<AzureEnvDefaults | null>;
  getPermissions(): Promise<Permissions>;
  editPermission(edit: PermEdit): Promise<void>;
  setYolo(on: boolean): Promise<Bootstrap>;
  getSkills(): Promise<SkillInfo[]>;
  saveSkill(fileName: string, content: string): Promise<void>;
  deleteSkill(path: string): Promise<void>;
  openSkillsFolder(): void;
  getUsage(): Promise<UsageSummary>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
  /** Global agent instructions — reads/writes ~/.my-code/my-code.md (applied on next new chat). */
  getInstructions(): Promise<string>;
  setInstructions(text: string): Promise<void>;
  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  onEngineEvent(cb: (ev: EngineEvent) => void): () => void;
  /** Fired after any backend restart (account/model/permission changes) with the fresh state. */
  onBootstrapChanged(cb: (b: Bootstrap) => void): () => void;
  onClearTranscript(cb: () => void): () => void;
  onLoadTranscript(cb: (messages: HistoryMessage[]) => void): () => void;
  onConnectorEvent(cb: (ev: ConnectorEvent) => void): () => void;
}

declare global {
  interface Window {
    mycode: McApi;
  }
}
