import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { createMcpServer } from './server';

function mcpMessage(json: unknown): string {
  const body = JSON.stringify(json);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function parseMcpMessages(raw: string): Array<{ id?: unknown; result?: unknown; error?: unknown }> {
  const messages: Array<{ id?: unknown; result?: unknown; error?: unknown }> = [];
  let buffer = raw;
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const headers = buffer.slice(0, headerEnd);
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headers);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const bodyLength = parseInt(lengthMatch[1], 10);
    const messageStart = headerEnd + 4;
    if (buffer.length < messageStart + bodyLength) break;
    const rawMessage = buffer.slice(messageStart, messageStart + bodyLength);
    buffer = buffer.slice(messageStart + bodyLength);
    try {
      messages.push(JSON.parse(rawMessage) as { id?: unknown; result?: unknown; error?: unknown });
    } catch {
      /* ignore */
    }
  }
  return messages;
}

describe('createMcpServer', () => {
  it('responds to initialize and exposes read-only tools', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const server = createMcpServer({
      config: { baseUrl: 'http://localhost:9999', apiToken: 'test-token' },
      stdin,
      stdout,
    });

    stdin.write(
      mcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      'utf8',
    );
    stdin.write(
      mcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();

    const messages = parseMcpMessages(chunks.join(''));
    assert.equal(messages.length, 2);
    assert.equal((messages[0].result as { serverInfo?: { name: string } } | undefined)?.serverInfo?.name, 'localagent-box-mcp-server');
    const tools = (messages[1].result as { tools: Array<{ name: string }> } | undefined)?.tools ?? [];
    const toolNames = tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'health_check',
      'list_repos',
      'get_repo',
      'list_agents',
      'get_agent',
      'get_agent_logs',
      'get_config',
    ]);
  });

  it('calls the HTTP API with the bearer token', async () => {
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    const mockApi = http.createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agents: [] }));
    });

    const port = await new Promise<number>((resolve) => {
      mockApi.listen(0, '127.0.0.1', () => {
        resolve((mockApi.address() as { port: number }).port);
      });
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const server = createMcpServer({
      config: { baseUrl: `http://127.0.0.1:${port}`, apiToken: 'mcp-secret' },
      stdin,
      stdout,
    });

    stdin.write(
      mcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      'utf8',
    );
    stdin.write(
      mcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_agents' } }),
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    server.close();
    await new Promise((resolve) => mockApi.close(resolve));

    const messages = parseMcpMessages(chunks.join(''));
    assert.equal(receivedAuth, 'Bearer mcp-secret');
    assert.equal(receivedPath, '/api/v1/agents');
    const content = (messages[1].result as { content: Array<{ text: string }> } | undefined)?.content ?? [];
    assert.equal(content[0]?.text, JSON.stringify({ status: 'ok', agents: [] }, null, 2));
  });
});

describe('localagent-box-mcp-server spawn', () => {
  it('starts and answers tools/list', async () => {
    const proc = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
      env: { ...process.env, LOCALAGENT_BOX_URL: 'http://localhost:9999', MCP_API_TOKEN: 'spawn-test' },
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const stdout = proc.stdout!;
    const chunks: string[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    const stdin = proc.stdin!;
    stdin.write(
      mcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      'utf8',
    );
    stdin.write(mcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 'utf8');
    stdin.end();

    await new Promise((resolve) => proc.on('close', resolve));

    const messages = parseMcpMessages(chunks.join(''));
    assert.equal(messages.length, 2);
    assert.equal((messages[0].result as { serverInfo?: { name: string } } | undefined)?.serverInfo?.name, 'localagent-box-mcp-server');
    const tools = (messages[1].result as { tools: Array<{ name: string }> } | undefined)?.tools ?? [];
    assert.ok(tools.some((t) => t.name === 'health_check'));
    assert.ok(tools.some((t) => t.name === 'list_agents'));
  });
});
