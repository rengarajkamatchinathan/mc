/** Flat transcript item model the renderer reduces backend events into. */
import type { DiffPayload, SuggestedRules, ToolChild } from "../../electron/ipc";

export interface ToolItem {
  kind: "tool";
  id: string;
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
  running: boolean;
  /** Wall-clock start (renderer time) — drives the live elapsed + final duration. */
  startedAt?: number;
  durationMs?: number;
  result?: string;
  isError?: boolean;
  diff?: DiffPayload;
  children?: ToolChild[];
}

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; text: string; streaming: boolean; startedAt?: number; durationMs?: number }
  | ToolItem
  /** Post-turn fold of consecutive tool calls into one "Worked for Xs · N steps" drawer. */
  | { kind: "steps"; id: string; tools: ToolItem[]; durationMs: number }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string };

/** The live status line under the transcript: verb + optional mono target. */
export interface Activity {
  verb: string;
  target?: string;
}

/** Ephemeral end-of-turn receipt ("✓ Done · 2 steps · 14s · 1.4k tokens"). */
export interface TurnReceipt {
  durationMs: number;
  steps: number;
  tokens?: number;
}

export interface PendingPermission {
  toolUseId: string;
  name: string;
  args: Record<string, unknown>;
  suggestedRules: SuggestedRules;
}
