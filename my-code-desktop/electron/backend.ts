/**
 * Backend manager — owns a single `my-code serve` child process and the
 * JSON-RPC connection to its bridge (a Windows named pipe / Unix socket).
 *
 * Lifecycle:
 *   spawn `node <cli.js> serve --profile <mode>` (cwd = project folder)
 *   → read the one-line JSON handshake from stdout → connect to the pipe
 *   → relay every `agent/event` notification to the onEvent callback.
 *
 * One backend at a time. Switching mode or project tears the old one down
 * and starts a new one (single-serve design).
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, Mode, PermissionChoice } from "./ipc.js";

export interface Handshake {
  ready: true;
  socketPath: string;
  sessionId: string;
  model: string;
  cwd: string;
  profile: Mode;
}

export interface BackendOptions {
  /** Absolute path to the my-code CLI entry (dist/cli.js). */
  cliPath: string;
  /** Working directory for the agent (a project folder in code mode). */
  cwd: string;
  mode: Mode;
  /** Resume a specific session id, if any. */
  sessionId?: string;
  /** Skip permission prompts (auto-approve). */
  yolo?: boolean;
  onEvent: (ev: EngineEvent) => void;
}

/** Resolve where the my-code CLI lives. Env override wins; else sibling repo. */
export function resolveCliPath(): string {
  const fromEnv = process.env.MY_CODE_CLI;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Default: sibling `my-code` checkout next to this app.
  const sibling = join(__dirname, "..", "..", "..", "my-code", "dist", "cli.js");
  return sibling;
}

export class Backend {
  private child: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private opts: BackendOptions;
  private rpcId = 0;
  private handshake: Handshake | null = null;
  private ready: Promise<Handshake> | null = null;
  private rxBuf = "";
  private stdoutBuf = "";
  /** Set when stop() is called so an intentional kill isn't reported as a crash. */
  private disposed = false;
  /** Rejects a still-pending start() the moment stop() is called (no 30s hang). */
  private rejectStart: ((e: Error) => void) | null = null;

  constructor(opts: BackendOptions) {
    this.opts = opts;
  }

  info(): Handshake | null {
    return this.handshake;
  }

  /** Spawn the serve process and connect to its bridge. Idempotent per instance. */
  start(): Promise<Handshake> {
    if (this.ready) return this.ready;
    this.ready = new Promise<Handshake>((resolve, reject) => {
      this.rejectStart = reject;
      const args = ["serve", "--profile", this.opts.mode];
      if (this.opts.sessionId) args.push("--session", this.opts.sessionId);
      if (this.opts.yolo) args.push("--yolo");

      // In the Electron main process `process.execPath` is the Electron binary,
      // not Node. ELECTRON_RUN_AS_NODE=1 makes it behave as plain Node so it runs
      // the my-code CLI script instead of launching another Electron app.
      const child = spawn(process.execPath, [this.opts.cliPath, ...args], {
        cwd: this.opts.cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      const onFail = (msg: string) => reject(new Error(msg));

      child.on("error", (e) => {
        if (!this.disposed) onFail(`failed to start the backend: ${e.message}`);
      });
      child.on("exit", (code) => {
        if (this.disposed) return; // intentional stop() — not a crash
        if (!this.handshake) onFail(`the backend exited early (code ${code})`);
        else this.opts.onEvent({ type: "backend_error", message: `backend exited (code ${code})` });
      });

      child.stderr?.on("data", (d: Buffer) => {
        if (process.env.MC_DESKTOP_DEBUG) process.stderr.write("[serve] " + d);
      });

      child.stdout?.on("data", (d: Buffer) => {
        if (this.handshake) return; // handshake already consumed
        this.stdoutBuf += d.toString();
        let nl: number;
        while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
          const line = this.stdoutBuf.slice(0, nl);
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (!line.trim()) continue;
          let hs: Handshake;
          try {
            hs = JSON.parse(line) as Handshake;
          } catch {
            continue;
          }
          if (hs.ready) {
            this.handshake = hs;
            this.connect(hs.socketPath).then(() => resolve(hs)).catch(reject);
            return;
          }
        }
      });

      setTimeout(() => {
        if (!this.handshake && !this.disposed) onFail("timed out waiting for my-code serve handshake");
      }, 30_000);
    });
    return this.ready;
  }

  private connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(socketPath);
      this.sock = sock;
      sock.on("connect", () => resolve());
      sock.on("error", (e) => reject(e));
      sock.on("data", (d: Buffer) => this.onData(d));
      sock.on("close", () => {
        this.sock = null;
      });
    });
  }

  private onData(d: Buffer): void {
    this.rxBuf += d.toString();
    let nl: number;
    while ((nl = this.rxBuf.indexOf("\n")) >= 0) {
      const line = this.rxBuf.slice(0, nl);
      this.rxBuf = this.rxBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: { method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const m = msg as { method?: string; params?: unknown; id?: string; result?: unknown };
      if (m.method === "agent/event" && m.params) {
        this.opts.onEvent(m.params as EngineEvent);
      } else if (m.id && this.pending.has(m.id)) {
        const resolve = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        resolve(m.result);
      }
    }
  }

  private pending = new Map<string, (result: unknown) => void>();

  private rpc(method: string, params?: Record<string, unknown>): void {
    if (!this.sock) return;
    const line = JSON.stringify({ id: `d${this.rpcId++}`, method, params }) + "\n";
    try {
      this.sock.write(line);
    } catch {
      /* socket gone */
    }
  }

  /** Send an RPC and await its response (correlated by id). */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.sock) return reject(new Error("backend not connected"));
      const id = `d${this.rpcId++}`;
      this.pending.set(id, (r) => resolve(r as T));
      try {
        this.sock.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`rpc ${method} timed out`));
      }, 10_000);
    });
  }

  submit(prompt: string): void {
    this.rpc("agent/submit", { prompt });
  }

  cancel(): void {
    this.rpc("agent/cancel");
  }

  compact(): void {
    this.rpc("agent/compact");
  }

  answerPermission(toolUseId: string, choice: PermissionChoice): void {
    this.rpc("agent/permission-response", { toolUseId, choice });
  }

  setModel(model: string): void {
    this.rpc("agent/set-model", { model });
  }

  async history(): Promise<import("./ipc.js").HistoryMessage[]> {
    try {
      const res = await this.request<{ messages: import("./ipc.js").HistoryMessage[] }>("agent/history");
      return res?.messages ?? [];
    } catch {
      return [];
    }
  }

  async stop(): Promise<void> {
    this.disposed = true;
    // Settle any in-flight start() immediately so its caller doesn't hang.
    if (this.rejectStart) {
      this.rejectStart(new Error("backend superseded"));
      this.rejectStart = null;
    }
    try {
      this.sock?.end();
    } catch {
      /* noop */
    }
    this.sock = null;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.handshake = null;
    this.ready = null;
  }
}
