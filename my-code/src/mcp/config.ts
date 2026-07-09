import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { McpFile, NamedMcpServer } from "./types.js";

/**
 * MCP config search order (later overrides earlier on duplicate server names):
 *   1. ~/.my-code/mcp.json   — user-global servers
 *   2. <cwd>/.my-code/mcp.json — project-scoped servers
 */

function userMcpPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".my-code", "mcp.json"),
  ];
}

function projectMcpPaths(cwd: string): string[] {
  return [
    path.join(cwd, ".my-code", "mcp.json"),
  ];
}

async function readJsonSafe(p: string): Promise<McpFile | null> {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt) as McpFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Malformed JSON — surface the path so user can fix.
    throw new Error(`MCP config ${p} is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function loadMcpConfig(cwd: string): Promise<NamedMcpServer[]> {
  const merged: Record<string, NamedMcpServer["config"]> = {};
  const allPaths = [...userMcpPaths(), ...projectMcpPaths(cwd)];
  for (const p of allPaths) {
    const f = await readJsonSafe(p);
    if (!f?.servers) continue;
    for (const [name, cfg] of Object.entries(f.servers)) {
      // Project paths come last → override user-global with same name.
      merged[name] = cfg;
    }
  }
  return Object.entries(merged).map(([name, config]) => ({ name, config }));
}

/**
 * Save MCP servers to the project-scoped mcp.json file.
 */
export async function saveMcpConfig(cwd: string, serverName: string, config: NamedMcpServer["config"] | null): Promise<void> {
  const p = projectMcpPaths(cwd)[0];
  if (!p) throw new Error("Could not determine project MCP path.");
  
  let f: McpFile = { servers: {} };
  
  try {
    const txt = await fs.readFile(p, "utf8");
    f = JSON.parse(txt) as McpFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`MCP config ${p} is invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Handle differences in root key 'servers' vs 'mcpServers' which standard MCP uses.
  const rootObj = (f.servers || (f as any).mcpServers || {}) as Record<string, NamedMcpServer["config"]>;
  
  if (config === null) {
    delete rootObj[serverName];
  } else {
    rootObj[serverName] = config;
  }
  
  f.servers = rootObj;
  
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(f, null, 2), "utf8");
}
