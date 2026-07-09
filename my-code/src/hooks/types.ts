import { z } from "zod";
import type { HookPhase } from "./index.js";

export const BashCommandHookSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
  shell: z.enum(["bash", "powershell"]).optional(),
  if: z.string().optional(),
});

export const HookCommandSchema = z.discriminatedUnion("type", [
  BashCommandHookSchema,
  // Stubs for other hook types not implemented in my-code yet
  z.object({ type: z.literal("prompt"), prompt: z.string(), if: z.string().optional() }),
  z.object({ type: z.literal("agent"), prompt: z.string(), if: z.string().optional() }),
  z.object({ type: z.literal("http"), url: z.string().url(), if: z.string().optional() }),
]);

export const HookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema),
});

export const HooksSchema = () => z.record(z.array(HookMatcherSchema));

export type HookCommand = z.infer<typeof HookCommandSchema>;
export type BashCommandHook = z.infer<typeof BashCommandHookSchema>;
export type HookMatcher = z.infer<typeof HookMatcherSchema>;
export type HooksSettings = Partial<Record<HookPhase, HookMatcher[]>>;
