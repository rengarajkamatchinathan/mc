import type { McpServerConfig, NamedMcpServer } from "./types.js";

// The official SDK is loaded lazily so the rest of the CLI keeps starting
// even if @modelcontextprotocol/sdk isn't installed (e.g. fresh clone before
// `bun install`).

/**
 * Minimal MCP tool descriptor surfaced to our registry. We map server tools
 * onto these and re-pack into our Tool interface in loader.ts.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** MCP resource entry as returned by resources/list. */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export interface McpClientConnection {
  serverName: string;
  /** Connected SDK client (typed `unknown` to avoid coupling to SDK types here). */
  client: unknown;
  /** Pre-fetched tool list from this server. */
  tools: McpToolDescriptor[];
  /** Disconnect / cleanup. */
  close(): Promise<void>;
}

/**
 * Connect to an MCP server using the SDK and prefetch its tool list.
 * Throws on transport failure; caller decides whether to skip or abort.
 */
export async function connectMcpServer(
  server: NamedMcpServer
): Promise<McpClientConnection> {
  // Dynamic imports — only loaded if the user actually configures MCP.
  const sdkClient = (await import("@modelcontextprotocol/sdk/client/index.js")) as {
    Client: new (info: { name: string; version: string }, capabilities: unknown) => unknown;
  };
  const ClientCtor = sdkClient.Client;

  const transport = await buildTransport(server.config);
  const client = new ClientCtor(
    { name: "my-code", version: "0.3.0-dev" },
    { capabilities: {} }
  );

  // SDK methods are not statically typed here; cast at call sites.
  const c = client as {
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
    listTools: () => Promise<{ tools: McpToolDescriptor[] }>;
    callTool: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
  };
  await c.connect(transport);

  let tools: McpToolDescriptor[] = [];
  try {
    const resp = await c.listTools();
    tools = resp.tools ?? [];
  } catch {
    // Server may not implement tools/list — that's fine, just no tools to surface.
    tools = [];
  }

  return {
    serverName: server.name,
    client,
    tools,
    close: () => c.close(),
  };
}

async function buildTransport(config: McpServerConfig): Promise<unknown> {
  if (config.type === "stdio") {
    const stdio = (await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    )) as {
      StdioClientTransport: new (opts: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
      }) => unknown;
    };
    return new stdio.StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      cwd: config.cwd,
    });
  }
  // http
  const http = (await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  )) as {
    StreamableHTTPClientTransport: new (
      url: URL,
      opts?: { requestInit?: { headers?: Record<string, string> } }
    ) => unknown;
  };
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return new http.StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
  });
}

export async function callMcpTool(
  connection: McpClientConnection,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const c = connection.client as {
    callTool: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
  };
  const resp = await c.callTool({ name: toolName, arguments: args });
  const parts: string[] = [];
  for (const item of resp.content ?? []) {
    if (item.type === "text" && item.text) parts.push(item.text);
    else parts.push(`[non-text content: ${item.type}]`);
  }
  const out = parts.join("\n");
  if (resp.isError) throw new Error(out || "MCP tool returned isError without text");
  return out;
}

/** Fetch all resources from a connected MCP server. Returns [] if unsupported. */
export async function listMcpResources(
  connection: McpClientConnection,
): Promise<McpResourceDescriptor[]> {
  const c = connection.client as {
    listResources?: () => Promise<{ resources?: McpResourceDescriptor[] }>;
    request?: (req: { method: string }, schema: unknown) => Promise<{ resources?: McpResourceDescriptor[] }>;
  };
  try {
    // Try SDK listResources method first
    if (typeof c.listResources === 'function') {
      const resp = await c.listResources();
      return resp.resources ?? [];
    }
    // Fallback: raw request
    if (typeof c.request === 'function') {
      const resp = await c.request({ method: 'resources/list' }, {});
      return (resp.resources ?? []) as McpResourceDescriptor[];
    }
  } catch {
    // Server doesn't support resources — that's fine
  }
  return [];
}

/** Read a specific MCP resource by URI. Returns text content. */
export async function readMcpResource(
  connection: McpClientConnection,
  uri: string,
): Promise<Array<{ uri: string; mimeType?: string; text?: string }>> {
  const c = connection.client as {
    readResource?: (params: { uri: string }) => Promise<{ contents?: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>;
    request?: (req: { method: string; params: unknown }, schema: unknown) => Promise<{ contents?: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>;
  };
  let contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> = [];
  try {
    if (typeof c.readResource === 'function') {
      const resp = await c.readResource({ uri });
      contents = resp.contents ?? [];
    } else if (typeof c.request === 'function') {
      const resp = await c.request({ method: 'resources/read', params: { uri } }, {});
      contents = (resp.contents ?? []) as typeof contents;
    }
  } catch (e) {
    throw new Error(`Failed to read resource '${uri}': ${e instanceof Error ? e.message : String(e)}`);
  }
  return contents.map(c => ({
    uri: c.uri,
    mimeType: c.mimeType,
    text: 'text' in c ? c.text : c.blob ? '[binary blob — use file path to read]' : undefined,
  }));
}

/** Fetch all prompts from a connected MCP server. Returns [] if unsupported. */
export async function listMcpPrompts(
  connection: McpClientConnection,
): Promise<Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>> {
  const c = connection.client as {
    listPrompts?: () => Promise<{ prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> }>;
    request?: (req: { method: string }, schema: unknown) => Promise<{ prompts?: Array<any> }>;
  };
  try {
    if (typeof c.listPrompts === 'function') {
      const resp = await c.listPrompts();
      return resp.prompts ?? [];
    }
    if (typeof c.request === 'function') {
      const resp = await c.request({ method: 'prompts/list' }, {});
      return resp.prompts ?? [];
    }
  } catch {
    // Unsupported
  }
  return [];
}

/** Execute an MCP prompt template. Returns formatted prompt text. */
export async function getMcpPrompt(
  connection: McpClientConnection,
  name: string,
  args?: Record<string, string>,
): Promise<string> {
  const c = connection.client as {
    getPrompt?: (params: { name: string; arguments?: Record<string, string> }) => Promise<{ description?: string; messages: Array<{ role: string; content: { type: string; text?: string } }> }>;
    request?: (req: { method: string; params: unknown }, schema: unknown) => Promise<{ messages: Array<{ role: string; content: { type: string; text?: string } }> }>;
  };
  try {
    let messages: Array<{ role: string; content: { type: string; text?: string } }> = [];
    if (typeof c.getPrompt === 'function') {
      const resp = await c.getPrompt({ name, arguments: args });
      messages = resp.messages;
    } else if (typeof c.request === 'function') {
      const resp = await c.request({ method: 'prompts/get', params: { name, arguments: args } }, {});
      messages = resp.messages;
    }
    
    return messages.map(m => m.content.text ?? '').join('\n\n');
  } catch (e) {
    throw new Error(`Failed to get MCP prompt '${name}': ${e instanceof Error ? e.message : String(e)}`);
  }
}
