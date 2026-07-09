import { registerHook, type HookPhase, type PreToolUseHookArgs, type PostToolUseHookArgs } from "../hooks/index.js";
import type { HooksSettings, HookCommand } from "../hooks/types.js";
import { exec } from "../utils/Shell.js";

/**
 * Parses and registers hooks from a skill's frontmatter into the global hook registry.
 * 
 * @param hooks The parsed hooks configuration from the skill's YAML frontmatter.
 */
export function registerSkillHooks(hooks: HooksSettings) {
  const phases: HookPhase[] = ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"];

  let registeredCount = 0;

  for (const phase of phases) {
    const matchers = hooks[phase];
    if (!matchers || matchers.length === 0) continue;

    for (const matcher of matchers) {
      if (!matcher.hooks || matcher.hooks.length === 0) continue;

      const register = registerHook as (phase: HookPhase, fn: any) => void;
      
      register(phase, async (args: any) => {
        // Simple matching logic
        const toolName = (args as PreToolUseHookArgs).toolName;
        
        // If matcher is provided and it doesn't match the tool name, skip.
        if (matcher.matcher && toolName && matcher.matcher !== toolName) {
          return;
        }

        for (const hook of matcher.hooks) {
          if (hook.type === "command") {
            try {
              const abortController = new AbortController();
              const taskId = `hook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
              
              if (process.env.MY_CODE_DEBUG === "1") {
                process.stderr.write(`  [Hook] Executing ${phase} command for tool '${toolName}': ${hook.command}\n`);
              }

              const shellCommand = await exec(hook.command, abortController.signal, {
                taskId,
                shouldAutoBackground: true,
              });

              // Wait for completion if needed, though usually hooks should be fast or fire-and-forget
              await shellCommand.result;
            } catch (error) {
              if (process.env.MY_CODE_DEBUG === "1") {
                process.stderr.write(`  [Hook] execution failed: ${error instanceof Error ? error.message : String(error)}\n`);
              }
            }
          }
        }
      });
      
      registeredCount += matcher.hooks.length;
    }
  }

  if (registeredCount > 0 && process.env.MY_CODE_DEBUG === "1") {
    process.stderr.write(`  [SkillHooks] Registered ${registeredCount} hooks from frontmatter.\n`);
  }
}
