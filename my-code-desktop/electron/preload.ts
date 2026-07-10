/**
 * Preload — exposes a strictly-typed `window.mycode` surface via contextBridge
 * so the renderer can drive the backend without touching Node primitives.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type Bootstrap,
  type ConnectorEvent,
  type ConnectorInfo,
  type CustomMcpInput,
  type EngineEvent,
  type HistoryMessage,
  type McApi,
  type Mode,
  type PermissionChoice,
  type SessionMeta,
} from "./ipc.js";

const api: McApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap) as Promise<Bootstrap>,
  sendPrompt: (text) => ipcRenderer.invoke(IPC.sendPrompt, text) as Promise<void>,
  abort: () => ipcRenderer.invoke(IPC.abort) as Promise<void>,
  compact: () => ipcRenderer.invoke(IPC.compact) as Promise<void>,
  answerPermission: (toolUseId, choice: PermissionChoice) =>
    ipcRenderer.invoke(IPC.answerPermission, toolUseId, choice) as Promise<void>,
  setMode: (mode: Mode, cwd?: string) =>
    ipcRenderer.invoke(IPC.setMode, mode, cwd) as Promise<Bootstrap>,
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,
  listSessions: () => ipcRenderer.invoke(IPC.listSessions) as Promise<SessionMeta[]>,
  listProjectFiles: () => ipcRenderer.invoke(IPC.listProjectFiles) as Promise<string[]>,
  deleteSession: (id) => ipcRenderer.invoke(IPC.deleteSession, id) as Promise<void>,
  renameSession: (id, title) => ipcRenderer.invoke(IPC.renameSession, id, title) as Promise<void>,
  resumeSession: (id) => ipcRenderer.invoke(IPC.resumeSession, id) as Promise<Bootstrap>,
  newSession: () => ipcRenderer.invoke(IPC.newSession) as Promise<Bootstrap>,
  listModels: () => ipcRenderer.invoke(IPC.listModels) as Promise<string[]>,
  setModel: (model) => ipcRenderer.invoke(IPC.setModel, model) as Promise<void>,
  listConnectors: () => ipcRenderer.invoke(IPC.listConnectors) as Promise<ConnectorInfo[]>,
  connectorTools: (id) => ipcRenderer.invoke(IPC.connectorTools, id) as Promise<import("./ipc.js").McpToolInfo[]>,
  connectConnector: (id) => ipcRenderer.invoke(IPC.connectConnector, id) as Promise<void>,
  disconnectConnector: (id) => ipcRenderer.invoke(IPC.disconnectConnector, id) as Promise<void>,
  addMcpServer: (input: CustomMcpInput) =>
    ipcRenderer.invoke(IPC.addMcpServer, input) as Promise<{ ok: boolean; error?: string }>,
  removeMcpServer: (name) => ipcRenderer.invoke(IPC.removeMcpServer, name) as Promise<void>,
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  getModelSettings: () => ipcRenderer.invoke(IPC.getModelSettings) as Promise<import("./ipc.js").ModelSettings>,
  saveModelSettings: (patch) => ipcRenderer.invoke(IPC.saveModelSettings, patch) as Promise<Bootstrap>,
  getAccounts: () => ipcRenderer.invoke(IPC.getAccounts) as Promise<import("./ipc.js").AccountList>,
  addAccount: (input) => ipcRenderer.invoke(IPC.addAccount, input) as Promise<void>,
  removeAccount: (id) => ipcRenderer.invoke(IPC.removeAccount, id) as Promise<void>,
  setActiveAccount: (id) => ipcRenderer.invoke(IPC.setActiveAccount, id) as Promise<Bootstrap>,
  restartBackend: () => ipcRenderer.invoke(IPC.restartBackend) as Promise<Bootstrap>,
  readEnvDefaults: (path?: string) =>
    ipcRenderer.invoke(IPC.readEnvDefaults, path) as Promise<import("./ipc.js").AzureEnvDefaults | null>,
  getPermissions: () => ipcRenderer.invoke(IPC.getPermissions) as Promise<import("./ipc.js").Permissions>,
  editPermission: (edit) => ipcRenderer.invoke(IPC.editPermission, edit) as Promise<void>,
  setYolo: (on) => ipcRenderer.invoke(IPC.setYolo, on) as Promise<Bootstrap>,
  getSkills: () => ipcRenderer.invoke(IPC.getSkills) as Promise<import("./ipc.js").SkillInfo[]>,
  saveSkill: (fileName, content) => ipcRenderer.invoke(IPC.saveSkill, fileName, content) as Promise<void>,
  deleteSkill: (path) => ipcRenderer.invoke(IPC.deleteSkill, path) as Promise<void>,
  openSkillsFolder: () => ipcRenderer.send(IPC.openSkillsFolder),
  getUsage: () => ipcRenderer.invoke(IPC.getUsage) as Promise<import("./ipc.js").UsageSummary>,
  getTheme: () => ipcRenderer.invoke(IPC.getTheme) as Promise<import("./ipc.js").Theme>,
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme) as Promise<void>,
  getInstructions: () => ipcRenderer.invoke(IPC.getInstructions) as Promise<string>,
  setInstructions: (text) => ipcRenderer.invoke(IPC.setInstructions, text) as Promise<void>,
  windowMinimize: () => ipcRenderer.send(IPC.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
  windowClose: () => ipcRenderer.send(IPC.windowClose),
  onEngineEvent: (cb: (ev: EngineEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: EngineEvent) => cb(ev);
    ipcRenderer.on(IPC.engineEvent, handler);
    return () => ipcRenderer.removeListener(IPC.engineEvent, handler);
  },
  onBootstrapChanged: (cb: (b: Bootstrap) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, b: Bootstrap) => cb(b);
    ipcRenderer.on(IPC.bootstrapChanged, handler);
    return () => ipcRenderer.removeListener(IPC.bootstrapChanged, handler);
  },
  onClearTranscript: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.clearTranscript, handler);
    return () => ipcRenderer.removeListener(IPC.clearTranscript, handler);
  },
  onLoadTranscript: (cb: (messages: HistoryMessage[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, messages: HistoryMessage[]) => cb(messages);
    ipcRenderer.on(IPC.loadTranscript, handler);
    return () => ipcRenderer.removeListener(IPC.loadTranscript, handler);
  },
  onConnectorEvent: (cb: (ev: ConnectorEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: ConnectorEvent) => cb(ev);
    ipcRenderer.on(IPC.connectorEvent, handler);
    return () => ipcRenderer.removeListener(IPC.connectorEvent, handler);
  },
};

contextBridge.exposeInMainWorld("mycode", api);
