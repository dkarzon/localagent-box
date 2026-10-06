import { DEFAULT_API_TOKEN } from '../lib/auth-constants';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2024-10-07'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ServerConfig {
  baseUrl: string;
  apiToken: string;
}

function resolveServerConfig(): ServerConfig {
  const baseUrl = (process.env.LOCALAGENT_BOX_URL || 'http://localhost:8080').trim().replace(/\/+$/, '');
  const apiToken = process.env.MCP_API_TOKEN || process.env.API_TOKEN || DEFAULT_API_TOKEN;
  return { baseUrl, apiToken };
}

const READ_ONLY_TOOLS: McpTool[] = [
  {
    name: 'health_check',
    description: 'Check localagent-box HTTP API liveness and provider reachability.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_repos',
    description: 'List all registered repositories.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_repo',
    description: 'Get metadata for a registered repository.',
    inputSchema: {
      type: 'object',
      properties: { repoId: { type: 'string', description: 'Registered repository id' } },
      required: ['repoId'],
    },
  },
  {
    name: 'list_agents',
    description: 'List agent sessions with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'string', description: 'Filter by registered repository id' },
        status: { type: 'string', description: 'Filter by agent status' },
      },
    },
  },
  {
    name: 'get_agent',
    description: 'Get status and metadata for an agent session.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'Agent session id' } },
      required: ['agentId'],
    },
  },
  {
    name: 'get_agent_logs',
    description: 'Read the log tail for an agent session.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent session id' },
        tail: { type: 'number', description: 'Number of log lines to return (default 200)' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'get_config',
    description: 'Get public server configuration (secrets redacted).',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callLocalagentBox(config: ServerConfig, method: 'GET', path: string, query?: URLSearchParams): Promise<unknown> {
  const queryString = query?.toString() ? `?${query.toString()}` : '';
  const url = `${config.baseUrl}${path}${queryString}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* ignore parse failure */
    }
    throw new McpError(-32000, message, { status: res.status });
  }
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return text;
  }
}

class McpError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

async function handleToolCall(config: ServerConfig, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case 'health_check':
      return callLocalagentBox(config, 'GET', '/health');
    case 'list_repos':
      return callLocalagentBox(config, 'GET', '/api/v1/repos');
    case 'get_repo': {
      const repoId = String(args.repoId || '');
      if (!repoId) throw new McpError(-32602, 'repoId is required');
      return callLocalagentBox(config, 'GET', `/api/v1/repos/${encodeURIComponent(repoId)}`);
    }
    case 'list_agents': {
      const query = new URLSearchParams();
      if (args.repoId) query.set('repoId', String(args.repoId));
      if (args.status) query.set('status', String(args.status));
      return callLocalagentBox(config, 'GET', '/api/v1/agents', query);
    }
    case 'get_agent': {
      const agentId = String(args.agentId || '');
      if (!agentId) throw new McpError(-32602, 'agentId is required');
      return callLocalagentBox(config, 'GET', `/api/v1/agents/${encodeURIComponent(agentId)}`);
    }
    case 'get_agent_logs': {
      const agentId = String(args.agentId || '');
      if (!agentId) throw new McpError(-32602, 'agentId is required');
      const query = new URLSearchParams();
      const tail = typeof args.tail === 'number' ? args.tail : 200;
      query.set('tail', String(tail));
      return callLocalagentBox(config, 'GET', `/api/v1/agents/${encodeURIComponent(agentId)}/logs`, query);
    }
    case 'get_config':
      return callLocalagentBox(config, 'GET', '/api/v1/config');
    default:
      throw new McpError(-32601, `Unknown tool: ${name}`);
  }
}

function buildResponse(id: number | string | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function buildErrorResponse(
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

export function createMcpServer(options: { config?: ServerConfig; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {}): { close: () => void } {
  const config = options.config || resolveServerConfig();
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;

  let initialized = false;
  let buffer = '';

  function send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  }

  async function handleMessage(message: JsonRpcRequest): Promise<void> {
    if (!message.method) {
      send(buildErrorResponse(message.id, -32600, 'Invalid Request'));
      return;
    }

    if (message.method === 'initialize') {
      const params = (message.params || {}) as { protocolVersion?: string };
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion || '')
        ? params.protocolVersion!
        : MCP_PROTOCOL_VERSION;
      initialized = true;
      send(
        buildResponse(message.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'localagent-box-mcp-server', version: '0.1.0' },
        }),
      );
      return;
    }

    if (message.method === 'notifications/initialized') {
      return;
    }

    if (!initialized && message.method !== 'initialize') {
      send(buildErrorResponse(message.id, -32001, 'Server not initialized'));
      return;
    }

    if (message.method === 'tools/list') {
      send(buildResponse(message.id, { tools: READ_ONLY_TOOLS }));
      return;
    }

    if (message.method === 'tools/call') {
      const params = (message.params || {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = String(params.name || '');
      const args = params.arguments || {};
      try {
        const result = await handleToolCall(config, name, args);
        send(buildResponse(message.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }));
      } catch (err) {
        if (err instanceof McpError) {
          send(buildErrorResponse(message.id, err.code, err.message, err.data));
        } else {
          send(buildErrorResponse(message.id, -32603, err instanceof Error ? err.message : String(err)));
        }
      }
      return;
    }

    send(buildErrorResponse(message.id, -32601, `Method not found: ${message.method}`));
  }

  function onData(chunk: Buffer | string): void {
    buffer += chunk.toString('utf8');
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headers = buffer.slice(0, headerEnd);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headers);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const bodyLength = parseInt(lengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      if (buffer.length < messageStart + bodyLength) return;
      const raw = buffer.slice(messageStart, messageStart + bodyLength);
      buffer = buffer.slice(messageStart + bodyLength);
      try {
        const message = JSON.parse(raw) as JsonRpcRequest;
        void handleMessage(message);
      } catch {
        send(buildErrorResponse(undefined, -32700, 'Parse error'));
      }
    }
  }

  stdin.on('data', onData);

  function close(): void {
    stdin.off('data', onData);
  }

  return { close };
}

if (require.main === module) {
  createMcpServer();
}
