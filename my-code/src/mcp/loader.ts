import { z } from "zod";
import type { CommandRegistry, SlashCommandDef } from "../commands/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import { buildTool } from "../tools/Tool.js";
import { loadMcpConfig } from "./config.js";
import {
  callMcpTool,
  connectMcpServer,
  listMcpPrompts,
  getMcpPrompt,
  type McpClientConnection,
  type McpToolDescriptor,
} from "./client.js";
import type { NamedMcpServer } from "./types.js";

/**
 * Live MCP connections, kept module-scoped so they survive across hot reloads
 * inside the same process (and so we can close them cleanly on shutdown).
 */
const connections: McpClientConnection[] = [];

/**
 * Read all configured MCP servers from user + project mcp.json files.
 * Returns the parsed list — does not connect yet.
 */
export async function loadMcpServers(cwd: string): Promise<NamedMcpServer[]> {
  return loadMcpConfig(cwd);
}

/**
 * Connect to each server and register its tools in the given registry.
 * Tools are exposed under `mcp__<server>__<tool>` to avoid collisions.
 *
 * Returns the number of tools registered. Servers that fail to connect emit a
 * warning to stderr and are skipped — they don't kill the whole CLI.
 */
export async function registerMcpTools(
  registry: ToolRegistry,
  servers: NamedMcpServer[]
): Promise<number> {
  let count = 0;
  for (const server of servers) {
    try {
      const conn = await connectMcpServer(server);
      connections.push(conn);
      for (const desc of conn.tools) {
        registry.register(buildMcpToolWrapper(conn, desc));
        count++;
      }
    } catch (e: unknown) {
      process.stderr.write(
        `  ⚠ MCP server "${server.name}" failed to connect: ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
  }
  return count;
}

export function buildMcpPromptCommand(
  conn: McpClientConnection,
  promptDef: { name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
): SlashCommandDef {
  const cmdName = `mcp__${conn.serverName}__${promptDef.name}`;
  
  return {
    name: cmdName,
    description: promptDef.description ?? `MCP Prompt from ${conn.serverName}`,
    argsHint: promptDef.arguments?.map(a => `<${a.name}>`).join(" "),
    async execute(args: string[], ctx) {
      const parsedArgs: Record<string, string> = {};
      if (promptDef.arguments) {
        promptDef.arguments.forEach((argDef, i) => {
          if (args[i]) parsedArgs[argDef.name] = args[i];
        });
      }
      try {
        const promptText = await getMcpPrompt(conn, promptDef.name, parsedArgs);
        await ctx.submitPrompt(promptText);
      } catch (e) {
        ctx.push(`Failed to get MCP prompt: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
  };
}

/**
 * Adapter — wraps an MCP tool descriptor into our Tool interface so it slots
 * into the existing registry / function-calling flow with no special-casing.
 *
 * MCP tools always go through the permission system as ask-by-default since
 * we can't statically reason about whether they mutate state.
 */
function buildMcpToolWrapper(
  conn: McpClientConnection,
  desc: McpToolDescriptor
) {
  const toolName = `mcp__${conn.serverName}__${desc.name}`;
  return buildTool({
    name: toolName,
    description: desc.description ?? `(MCP) ${desc.name} on ${conn.serverName}`,
    // Permissive zod schema for the runtime parser — the model receives the
    // server's real JSON schema via jsonSchemaOverride below.
    inputSchema: z.record(z.unknown()) as unknown as z.ZodType<Record<string, unknown>>,
    jsonSchemaOverride: desc.inputSchema ?? { type: "object", additionalProperties: true },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    getActivityDescription: () => `Calling ${conn.serverName}/${desc.name}`,
    renderToolUse: () => `${toolName}`,
    async call(input) {
      return callMcpTool(conn, desc.name, input);
    },
  });
}

/**
 * Override the JSON schema we hand to the model for MCP tools. Use this if you
 * later want to feed the server's actual schema instead of the permissive
 * record. For now the loader registers tools with z.record() — the LLM will
 * see "additional properties allowed" but the server enforces validation.
 */
export function getMcpToolSchema(toolName: string): unknown | null {
  for (const conn of connections) {
    for (const t of conn.tools) {
      if (`mcp__${conn.serverName}__${t.name}` === toolName) return t.inputSchema;
    }
  }
  return null;
}

export async function closeAllMcp(): Promise<void> {
  await Promise.allSettled(connections.map((c) => c.close()));
  connections.length = 0;
}

/** Return all currently connected MCP clients (for resource tools). */
export function getConnections(): McpClientConnection[] {
  return connections;
}
