import type { SlashCommandDef, CommandContext } from '../commands/registry.js';
import type { PromptCommand } from '../types/command.js';
import { loadSkillsFromDir } from './loadSkillsDir.js';
import { getBundledSkills } from './bundledSkills.js';
import { substituteArguments } from '../utils/argumentSubstitution.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { parseFrontmatter, type FrontmatterShell } from '../utils/frontmatterParser.js';
import { registerSkillHooks } from './registerSkillHooks.js';

/**
 * Load all skills from user and project directories and bundled skills.
 */
export async function loadSkills(cwd: string): Promise<PromptCommand[]> {
  const dirSkills = await loadSkillsFromDir(cwd);
  
  // Also load from the bundled skills directory (built-in markdown files)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.join(__dirname, 'bundled');
  const bundledMdSkills: PromptCommand[] = [];
  try {
    const entries = await fs.readdir(bundledDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const filePath = path.join(bundledDir, entry.name);
        const rawContent = await fs.readFile(filePath, 'utf-8');
        const { frontmatter, content } = parseFrontmatter(rawContent, filePath);
        const name = (frontmatter.name as string) ?? entry.name.replace(/\.md$/, '');
        if (frontmatter.hooks) {
          registerSkillHooks(frontmatter.hooks);
        }

        bundledMdSkills.push({
          type: 'prompt',
          name: (frontmatter.name as string) ?? name,
          description: (frontmatter.description as string) ?? `Skill: ${name}`,
          prompt: content,
          argumentNames: Array.isArray(frontmatter.args) ? frontmatter.args.map(String) : [],
          allowedTools: Array.isArray(frontmatter['allowed-tools']) 
            ? frontmatter['allowed-tools'].map(String) 
            : typeof frontmatter['allowed-tools'] === 'string'
            ? [frontmatter['allowed-tools']]
            : [],
          disableModelInvocation: String(frontmatter.disableModelInvocation) === 'true',
          userInvocable: String(frontmatter['user-invocable']) !== 'false',
          source: 'bundled',
          loadedFrom: 'bundled',
          shell: frontmatter.shell as FrontmatterShell | undefined,
        });
      }
    }
  } catch (e: unknown) {
    if (process.env.MY_CODE_DEBUG === "1") {
      process.stderr.write(`  ⚠ Bundled skills dir error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  const bundled = [...getBundledSkills(), ...bundledMdSkills];

  // Simple deduplication by name (dir overrides bundled)
  const allSkills = [...bundled, ...dirSkills];
  const unique = new Map<string, PromptCommand>();
  for (const skill of allSkills) {
    unique.set(skill.name, skill);
  }
  return Array.from(unique.values());
}

/**
 * Convert a PromptCommand into a SlashCommandDef for the command registry.
 */
export function skillToCommand(skill: PromptCommand): SlashCommandDef {
  return {
    name: skill.name,
    description: `${skill.description} (skill: ${skill.source})`,
    argsHint: skill.argumentNames?.length > 0
      ? skill.argumentNames.map((a) => `<${a}>`).join(" ")
      : undefined,
    async execute(args: string[], ctx: CommandContext) {
      // In the new architecture, the SkillTool will actually execute skills when the AI calls it.
      // But when the user types /skill-name, it just expands the prompt into the chat window
      // (or runs the tool logic if context=fork, but let's just submit the expanded prompt here).

      const argsString = args.join(' ');
      const prompt = substituteArguments(skill.prompt, argsString, true, skill.argumentNames || []);

      if (!prompt.trim()) {
        ctx.push(`usage: /${skill.name} ${skill.argumentNames?.map((a) => `<${a}>`).join(" ")}`, "warn");
        return;
      }

      await ctx.submitPrompt(prompt);
    },
  };
}

/**
 * Format skills list for display.
 */
export function formatSkillList(skills: PromptCommand[]): string {
  if (skills.length === 0) return "(no skills found)";
  return skills
    .map((s) => {
      const args = s.argumentNames?.length > 0 ? ` ${s.argumentNames.map((a) => `<${a}>`).join(" ")}` : "";
      return `  /${s.name}${args.padEnd(25)} ${s.description} (${s.source})`;
    })
    .join("\n");
}
