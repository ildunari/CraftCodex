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

async function createFixtureAcpSpecPermissionServer(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-acp-spec-permission-fixture-'));
  const scriptPath = join(dir, 'fixture-acp-spec-permission.mjs');
  await writeFile(scriptPath, `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
let approvalLog = null;
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fixture' } } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'spec-session' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({
      id: 'approval-spec',
      method: 'session/request_permission',
      params: {
        sessionId: 'spec-session',
        toolCall: { toolCallId: 't1', title: 'Bash', rawInput: { command: 'echo ok' }, kind: 'execute' },
        options: [
          { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'b', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'c', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    return;
  }
  if (msg.id === 'approval-spec') {
    approvalLog = msg.result;
    const picked = msg.result?.outcome?.optionId ?? msg.result?.outcome?.outcome ?? 'unknown';
    send({
      method: 'session/update',
      params: { sessionId: 'spec-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'picked:' + picked } } },
    });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
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

  it('does not treat tool/status metadata as assistant text', () => {
    expect(extractAcpText({
      title: 'General Greeting',
      summary: 'Steps Completed',
      rawOutput: 'tool output',
      status: 'completed',
    })).toEqual([]);
  });

  it('extracts nested assistant message content without metadata', () => {
    expect(extractAcpText({
      assistant_message: {
        title: 'General Greeting',
        content: [{ type: 'text', text: 'Hi Kosta.' }],
      },
    })).toEqual(['Hi Kosta.']);
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
    // Stream-authoritative: text_complete reflects only what was streamed.
    // The 'world' text from the session/prompt result block is NOT appended.
    expect(events).toContainEqual({ type: 'text_complete', text: 'hello ' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('falls back to result text when nothing streamed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-resultonly-'));
    const scriptPath = join(dir, 'fixture-acp-resultonly.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-r' } });
  if (msg.method === 'session/prompt') {
    // No session/update at all — agent only emits final result text.
    return send({ id: msg.id, result: { content: [{ text: 'final-only-text' }], stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];
    try {
      for await (const event of agent.chat('hi')) events.push(event);
    } finally {
      agent.destroy();
    }
    expect(events).toContainEqual({ type: 'text_complete', text: 'final-only-text' });
    expect(events).toContainEqual({ type: 'stop_reason', reason: 'end_turn' });
  });

  it('emits stop_reason event before complete when result includes stopReason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-stop-'));
    const scriptPath = join(dir, 'fixture-acp-stop.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-stop' } });
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's-stop', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunked' } } } });
    return send({ id: msg.id, result: { stopReason: 'max_tokens' } });
  }
});
`, 'utf8');
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];
    try {
      for await (const event of agent.chat('hi')) events.push(event);
    } finally {
      agent.destroy();
    }
    const stopIdx = events.findIndex(e => e.type === 'stop_reason');
    const completeIdx = events.findIndex(e => e.type === 'complete');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(stopIdx);
    expect(events[stopIdx]).toEqual({ type: 'stop_reason', reason: 'max_tokens' });
  });

  it('writes JSON-RPC frames to the configured NDJSON path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-ndjson-'));
    const scriptPath = join(dir, 'fixture-acp-ndjson.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-nd' } });
  if (msg.method === 'session/prompt') return send({ id: msg.id, result: { stopReason: 'end_turn' } });
});
`, 'utf8');
    const ndjsonPath = join(dir, 'mirror.ndjson');
    const config = createConfig(scriptPath);
    config.runtime = { ...(config.runtime ?? {}), acpNdjsonPath: ndjsonPath };
    const agent = new AcpAgent(config);
    try {
      for await (const _ of agent.chat('hi')) { /* drain */ }
    } finally {
      agent.destroy();
    }
    // Allow a tick for the write stream to flush.
    await new Promise(r => setTimeout(r, 50));
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(ndjsonPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const frames = lines.map(l => JSON.parse(l));
    expect(frames.some(f => f.dir === 'out' && f.frame?.method === 'initialize')).toBe(true);
    expect(frames.some(f => f.dir === 'in' && f.frame?.id != null)).toBe(true);
    expect(frames.some(f => f.dir === 'out' && f.frame?.method === 'session/prompt')).toBe(true);
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

  it('responds to spec-shaped session/request_permission with the matching optionId', async () => {
    const scriptPath = await createFixtureAcpSpecPermissionServer();
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];
    let captured: Parameters<NonNullable<typeof agent.onPermissionRequest>>[0] | null = null;

    agent.onPermissionRequest = (request) => {
      captured = request;
      agent.respondToPermission(request.requestId, true, false);
    };

    try {
      for await (const event of agent.chat('Run a tool')) events.push(event);
    } finally {
      agent.destroy();
    }

    // Forwarded with the agent-supplied options array intact.
    expect(captured).not.toBeNull();
    type CapturedRequest = Parameters<NonNullable<typeof agent.onPermissionRequest>>[0];
    const cap: CapturedRequest = captured!;
    expect(cap.options).toEqual([
      { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'b', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'c', name: 'Reject', kind: 'reject_once' },
    ]);
    expect(cap.toolName).toBe('Bash');
    expect(cap.command).toBe('echo ok');

    // Server echoed the chosen optionId into the assistant message.
    expect(events).toContainEqual({ type: 'text_delta', text: 'picked:a' });
  });

  it('uses allow_always when responder passes alwaysAllow=true', async () => {
    const scriptPath = await createFixtureAcpSpecPermissionServer();
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];

    agent.onPermissionRequest = (request) => {
      agent.respondToPermission(request.requestId, true, true);
    };

    try {
      for await (const event of agent.chat('Run a tool')) events.push(event);
    } finally {
      agent.destroy();
    }

    expect(events).toContainEqual({ type: 'text_delta', text: 'picked:b' });
  });

  it('uses reject_once when responder denies', async () => {
    const scriptPath = await createFixtureAcpSpecPermissionServer();
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];

    agent.onPermissionRequest = (request) => {
      agent.respondToPermission(request.requestId, false, false);
    };

    try {
      for await (const event of agent.chat('Run a tool')) events.push(event);
    } finally {
      agent.destroy();
    }

    expect(events).toContainEqual({ type: 'text_delta', text: 'picked:c' });
  });

  it('honors an explicit optionId passed by the responder', async () => {
    const scriptPath = await createFixtureAcpSpecPermissionServer();
    const agent = new AcpAgent(createConfig(scriptPath));
    const events: any[] = [];

    agent.onPermissionRequest = (request) => {
      // Even though allowed=true would normally pick allow_once, the explicit
      // optionId override wins.
      agent.respondToPermission(request.requestId, true, false, 'b');
    };

    try {
      for await (const event of agent.chat('Run a tool')) events.push(event);
    } finally {
      agent.destroy();
    }

    expect(events).toContainEqual({ type: 'text_delta', text: 'picked:b' });
  });

  it('serializes concurrent chat() calls so streams do not interleave', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-queue-'));
    const scriptPath = join(dir, 'fixture-acp-queue.mjs');
    // The fixture stamps each prompt response with a sequence number so we can
    // verify that the second chat() turn waits for the first to finish.
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let promptSeq = 0;
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-q' } });
  if (msg.method === 'session/prompt') {
    promptSeq += 1;
    const seq = promptSeq;
    // Emit two chunks separated by a tiny delay so interleaving would be visible.
    send({ method: 'session/update', params: { sessionId: 's-q', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn' + seq + '-a' } } } });
    await new Promise(r => setTimeout(r, 30));
    send({ method: 'session/update', params: { sessionId: 's-q', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn' + seq + '-b' } } } });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const agent = new AcpAgent(createConfig(scriptPath));

    const drain = async (gen: AsyncIterable<any>): Promise<any[]> => {
      const out: any[] = [];
      for await (const event of gen) out.push(event);
      return out;
    };

    try {
      const [a, b] = await Promise.all([
        drain(agent.chat('one')),
        drain(agent.chat('two')),
      ]);
      const aTexts = a.filter(e => e.type === 'text_delta').map(e => e.text);
      const bTexts = b.filter(e => e.type === 'text_delta').map(e => e.text);
      // Both turns saw their own chunks in order, with no cross-contamination.
      expect(aTexts).toEqual(['turn1-a', 'turn1-b']);
      expect(bTexts).toEqual(['turn2-a', 'turn2-b']);
    } finally {
      agent.destroy();
    }
  });

  it('uses session/load when the agent advertises loadSession and we have a saved id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-load-'));
    const scriptPath = join(dir, 'fixture-acp-load.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (msg.method === 'session/load') {
    if (msg.params?.sessionId === 'persisted-1') return send({ id: msg.id, result: {} });
    return send({ id: msg.id, error: { code: -32602, message: 'unknown session' } });
  }
  if (msg.method === 'session/new') {
    return send({ id: msg.id, result: { sessionId: 'fresh-1' } });
  }
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on:' + msg.params.sessionId } } } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const config = createConfig(scriptPath);
    config.session = { ...config.session!, acpSessionId: 'persisted-1' };
    const agent = new AcpAgent(config);
    const events: any[] = [];
    try {
      for await (const event of agent.chat('hi')) events.push(event);
    } finally {
      agent.destroy();
    }
    // Loaded onto the persisted id rather than starting fresh.
    expect(events).toContainEqual({ type: 'text_delta', text: 'on:persisted-1' });
  });

  it('persists captured acpSessionId via onAcpSessionIdUpdate on first session/new', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-persist-'));
    const scriptPath = join(dir, 'fixture-acp-persist.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 'fresh-acp' } });
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'fresh-acp', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const config = createConfig(scriptPath);
    let captured = '';
    config.onAcpSessionIdUpdate = (id: string) => { captured = id; };
    const agent = new AcpAgent(config);
    try {
      for await (const _ of agent.chat('hi')) { /* drain */ }
    } finally {
      agent.destroy();
    }
    expect(captured).toBe('fresh-acp');
  });

  it('falls back to session/new when session/load errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-load-fallback-'));
    const scriptPath = join(dir, 'fixture-acp-load-fallback.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (msg.method === 'session/load') {
    return send({ id: msg.id, error: { code: -32602, message: 'unknown session' } });
  }
  if (msg.method === 'session/new') {
    return send({ id: msg.id, result: { sessionId: 'recovered' } });
  }
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on:' + msg.params.sessionId } } } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const config = createConfig(scriptPath);
    config.session = { ...config.session!, acpSessionId: 'stale-id' };
    let cleared = false;
    let updatedTo = '';
    config.onAcpSessionIdCleared = () => { cleared = true; };
    config.onAcpSessionIdUpdate = (id: string) => { updatedTo = id; };
    const agent = new AcpAgent(config);
    const events: any[] = [];
    try {
      for await (const event of agent.chat('hi')) events.push(event);
    } finally {
      agent.destroy();
    }
    expect(cleared).toBe(true);
    expect(updatedTo).toBe('recovered');
    expect(events).toContainEqual({ type: 'text_delta', text: 'on:recovered' });
  });

  it('rejects with a timeout error when initialize never responds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-init-timeout-'));
    const scriptPath = join(dir, 'fixture-acp-init-timeout.mjs');
    // Server reads stdin but never replies — initialize must time out.
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => { /* swallow forever */ });
`, 'utf8');
    const config = createConfig(scriptPath);
    config.runtime = {
      ...(config.runtime ?? {}),
      acpRequestTimeoutMs: { initialize: 250 },
    };
    const agent = new AcpAgent(config);
    const events: any[] = [];
    try {
      for await (const event of agent.chat('hi')) events.push(event);
    } finally {
      agent.destroy();
    }
    const errEvents = events.filter(e => e.type === 'error');
    expect(errEvents.length).toBeGreaterThan(0);
    expect(errEvents[0].message).toContain('initialize timed out');
  });

  it('recovers cleanly from an initialize timeout — next chat() can succeed', async () => {
    // Phase H regression for HIGH #2: previously, a timed-out initialize
    // left this.subprocess + this.initialized populated with a cached
    // rejection, so every subsequent chat() saw `subprocess && initialized`
    // truthy and re-threw the same error forever.
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-init-recover-'));
    const wedgedPath = join(dir, 'fixture-wedged.mjs');
    const healthyPath = join(dir, 'fixture-healthy.mjs');
    await writeFile(wedgedPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => { /* swallow forever */ });
`, 'utf8');
    await writeFile(healthyPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-rec' } });
  if (msg.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 's-rec', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } } } });
    return send({ id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const config = createConfig(wedgedPath);
    config.runtime = { ...(config.runtime ?? {}), acpRequestTimeoutMs: { initialize: 200 } };
    const agent = new AcpAgent(config);
    try {
      // First chat — initialize times out.
      const events1: any[] = [];
      for await (const event of agent.chat('first')) events1.push(event);
      expect(events1.some(e => e.type === 'error' && /initialize timed out/.test(e.message))).toBe(true);

      // Swap the runtime to a healthy fixture and try again — must succeed,
      // not re-throw the cached failure.
      (config.runtime as any).acpCommand = process.execPath;
      (config.runtime as any).acpArgs = [healthyPath];
      const events2: any[] = [];
      for await (const event of agent.chat('second')) events2.push(event);
      expect(events2).toContainEqual({ type: 'text_delta', text: 'recovered' });
    } finally {
      agent.destroy();
    }
  });

  it('does not double-emit an error event when the subprocess exits during abort', async () => {
    // Phase H regression for HIGH #4: the subprocess exit handler used
    // to enqueue { type: 'error' } even when forceAbort had set
    // abortReason — the consumer then saw a stale error after the
    // graceful cancel completed.
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-abort-race-'));
    const scriptPath = join(dir, 'fixture-acp-abort-race.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-ab' } });
  if (msg.method === 'session/prompt') {
    // Stream forever (until we get cancelled).
    setInterval(() => {
      send({ method: 'session/update', params: { sessionId: 's-ab', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } } } });
    }, 20);
    return;
  }
  if (msg.method === 'session/cancel') {
    // Spec says cancel is a notification — no response. Exit shortly to
    // simulate the agent shutting down gracefully.
    setTimeout(() => process.exit(0), 50);
  }
});
`, 'utf8');
    const config = createConfig(scriptPath);
    config.runtime = { ...(config.runtime ?? {}), acpRequestTimeoutMs: { sessionCancel: 300 }, acpCancelTermGraceMs: 200 };
    const agent = new AcpAgent(config);
    const events: any[] = [];
    const drain = (async () => {
      for await (const event of agent.chat('stream forever')) events.push(event);
    })();

    // Let the stream get going, then abort.
    await new Promise(r => setTimeout(r, 100));
    await agent.abort();
    await drain;
    agent.destroy();

    const errors = events.filter(e => e.type === 'error');
    expect(errors).toEqual([]);
  });

  it('legacy permission response omits the spec outcome envelope', async () => {
    // Phase H regression for MEDIUM #6: the legacy non-spec server path
    // used to fabricate { outcome: { outcome: 'selected', optionId: 'allow' } }
    // even though no such option was ever offered.
    const dir = await mkdtemp(join(tmpdir(), 'craft-acp-legacy-perm-'));
    const scriptPath = join(dir, 'fixture-acp-legacy-perm.mjs');
    await writeFile(scriptPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
let approvalEcho = null;
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's-leg' } });
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    return send({ id: 'leg-1', method: 'permission/request', params: { toolName: 'Bash', command: 'echo' } });
  }
  if (msg.id === 'leg-1') {
    approvalEcho = msg.result;
    send({ method: 'session/update', params: { sessionId: 's-leg', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:' + JSON.stringify(approvalEcho) } } } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`, 'utf8');
    const agent = new AcpAgent(createConfig(scriptPath));
    agent.onPermissionRequest = (request) => {
      agent.respondToPermission(request.requestId, true);
    };
    const events: any[] = [];
    try {
      for await (const event of agent.chat('do it')) events.push(event);
    } finally {
      agent.destroy();
    }
    const echoed = events.find(e => e.type === 'text_delta' && typeof e.text === 'string' && e.text.startsWith('echo:'))?.text as string | undefined;
    expect(echoed).toBeDefined();
    const payload = JSON.parse(echoed!.slice('echo:'.length));
    // Legacy fields preserved...
    expect(payload).toEqual({ allowed: true, decision: 'accept' });
    // ...and we never fabricated an `optionId: 'allow'`.
    expect(payload.outcome).toBeUndefined();
  });
});
