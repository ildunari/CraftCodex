import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AcpAgent, extractAcpText } from '../acp-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

async function createFixtureAcpServer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-acp-fixture-'));
  const scriptPath = join(dir, 'fixture-acp.mjs');
  await writeFile(scriptPath, `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (msg.params?.protocolVersion !== 1) return fail(msg.id, 'protocolVersion required');
    send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fixture' } } });
    return;
  }
  if (msg.method === 'session/new') {
    if (!Array.isArray(msg.params?.mcpServers)) return fail(msg.id, 'mcpServers must be an array');
    send({ id: msg.id, result: { sessionId: 'fixture-session' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (!Array.isArray(msg.params?.prompt)) return fail(msg.id, 'prompt must be content blocks');
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tool_fixture', title: 'Read', rawInput: { file_path: 'README.md' } } } });
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool_fixture', title: 'Read', status: 'completed', rawOutput: 'file contents' } } });
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'status', message: 'mulling...' } } });
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } } } });
    send({ id: msg.id, result: { content: [{ text: 'world' }] } });
    return;
  }
  if (msg.method === 'session/cancel') {
    send({ id: msg.id, result: { cancelled: true } });
  }
});
`, 'utf8');
  return scriptPath;
}

async function createFixtureAcpPermissionServer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-acp-permission-fixture-'));
  const scriptPath = join(dir, 'fixture-acp-permission.mjs');
  await writeFile(scriptPath, `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fixture' } } });
    return;
  }
  if (msg.method === 'session/new') {
    if (!Array.isArray(msg.params?.mcpServers)) return fail(msg.id, 'mcpServers must be an array');
    send({ id: msg.id, result: { sessionId: 'fixture-session' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (!Array.isArray(msg.params?.prompt)) return fail(msg.id, 'prompt must be content blocks');
    promptId = msg.id;
    send({ id: 'approval-1', method: 'permission/request', params: { toolName: 'Bash', command: 'echo ok', reason: 'needs shell' } });
    return;
  }
  if (msg.id === 'approval-1') {
    send({ id: promptId, result: { content: [{ text: msg.result?.allowed ? 'approved' : 'declined' }] } });
  }
});
`, 'utf8');
  return scriptPath;
}

function createConfig(scriptPath: string): BackendConfig {
  const rootPath = tmpdir();
  return {
    provider: 'acp',
    providerType: 'acp',
    authType: 'none',
    workspace: {
      id: 'workspace',
      name: 'Workspace',
      slug: 'workspace',
      rootPath,
      createdAt: Date.now(),
    },
    session: {
      id: 'session',
      workspaceRootPath: rootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
    runtime: {
      acpCommand: process.execPath,
      acpArgs: [scriptPath],
    },
  };
}

describe('extractAcpText', () => {
  it('extracts common ACP text payload shapes', () => {
    expect(extractAcpText({
      delta: { text: 'hello' },
      content: [{ text: ' world' }],
      ignored: 'nope',
    })).toEqual(['hello', ' world']);
  });
});

describe('AcpAgent', () => {
  it('streams ACP session updates and prompt results as AgentEvents', async () => {
    const scriptPath = await createFixtureAcpServer();
    const agent = new AcpAgent(createConfig(scriptPath));
    const events = [];

    try {
      for await (const event of agent.chat('Say hi')) {
        events.push(event);
      }
    } finally {
      agent.destroy();
    }

    expect(events).toContainEqual({ type: 'text_delta', text: 'hello ' });
    expect(events).toContainEqual({ type: 'status', message: 'mulling...' });
    expect(events).not.toContainEqual({ type: 'text_delta', text: 'mulling...' });
    expect(events).toContainEqual({
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'tool_fixture',
      input: { file_path: 'README.md' },
      parentToolUseId: undefined,
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      toolName: 'Read',
      toolUseId: 'tool_fixture',
      result: 'file contents',
      isError: false,
      parentToolUseId: undefined,
    });
    expect(events).toContainEqual({ type: 'text_complete', text: 'hello world' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('routes agent_thought_chunk content into thinking events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-thinking-'));
    const scriptPath = join(dir, 'fixture-acp-thinking.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering...' } } } });
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } } });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];
    try {
      for await (const event of agent.chat('Plan')) events.push(event);
    } finally {
      agent.destroy();
    }
    expect(events).toContainEqual({ type: 'thinking', text: 'pondering...' });
    expect(events).toContainEqual({ type: 'text_delta', text: 'answer' });
    // Thinking text must NOT leak into the assistant message stream.
    expect(events).not.toContainEqual({ type: 'text_delta', text: 'pondering...' });
  });

  it('forwards ACP permission requests through the backend permission callback', async () => {
    const scriptPath = await createFixtureAcpPermissionServer();
    const agent = new AcpAgent(createConfig(scriptPath));
    const events = [];
    let permissionRequest: Parameters<NonNullable<typeof agent.onPermissionRequest>>[0] | null = null;

    agent.onPermissionRequest = (request) => {
      permissionRequest = request;
      agent.respondToPermission(request.requestId, true);
    };

    try {
      for await (const event of agent.chat('Needs approval')) {
        events.push(event);
      }
    } finally {
      agent.destroy();
    }

    expect(permissionRequest).toMatchObject({
      toolName: 'Bash',
      command: 'echo ok',
      reason: 'needs shell',
      type: 'bash',
    });
    expect(events).toContainEqual({ type: 'text_complete', text: 'approved' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });
});
