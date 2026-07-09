import type { SlashCommandDef } from "./registry.js";
import { saveMcpConfig, loadMcpConfig } from "../mcp/config.js";
import type { NamedMcpServer } from "../mcp/types.js";

export const mcpCommand: SlashCommandDef = {
  name: "mcp",
  description: "Manage MCP servers (list, add, remove)",
  argsHint: "<action> [args...]",
  async execute(args, ctx) {
    const [action, serverName, command, ...commandArgs] = args;

    if (action === "list") {
      const servers = await loadMcpConfig(ctx.engine.cwd);
      if (servers.length === 0) {
        ctx.push("No MCP servers configured.");
        return;
      }
      ctx.push(`Configured MCP Servers:\n${servers.map(s => `  - ${s.name} (${s.config.type === 'stdio' ? s.config.command : s.config.url})`).join('\n')}`);
      return;
    }

    if (action === "remove") {
      if (!serverName) {
        ctx.push("Usage: /mcp remove <serverName>", "warn");
        return;
      }
      await saveMcpConfig(ctx.engine.cwd, serverName, null);
      ctx.push(`Removed MCP server: ${serverName}. Please restart the CLI to apply changes.`);
      return;
    }

    if (action === "add") {
      if (!serverName || !command) {
        ctx.push("Usage: /mcp add <serverName> <command> [args...]\nExample: /mcp add sqlite npx -y @modelcontextprotocol/server-sqlite -- db.sqlite", "warn");
        return;
      }
      const config: NamedMcpServer["config"] = {
        type: "stdio",
        command: command,
        args: commandArgs,
      };
      await saveMcpConfig(ctx.engine.cwd, serverName, config);
      ctx.push(`Added stdio MCP server: ${serverName}. Please restart the CLI to apply changes and load the tools/prompts.`);
      return;
    }

    ctx.push("Unknown action. Usage: /mcp <list|add|remove> ...", "warn");
  },
};
