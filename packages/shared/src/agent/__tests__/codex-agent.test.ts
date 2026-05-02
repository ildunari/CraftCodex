import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CodexAgent } from '../codex-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

async function createFixtureCodexServer(options: { duplicateTurnCompleted?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-codex-fixture-'));
  const scriptPath = join(dir, 'fixture-codex.mjs');
  await writeFile(scriptPath, `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (!msg.params.clientInfo.version) {
      send({ id: msg.id, error: { message: 'missing version' } });
      return;
    }
    send({ id: msg.id, result: { userAgent: 'fixture', codexHome: '/tmp/codex' } });
    return;
  }
  if (msg.method === 'initialized') {
    return;
  }
  if (msg.method === 'model/list') {
    send({ id: msg.id, result: { models: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000 }] } });
    return;
  }
  if (msg.method === 'mcpServerStatus/list') {
    send({ id: msg.id, result: { data: [] } });
    return;
  }
  if (msg.method === 'plugin/list') {
    send({ id: msg.id, result: { marketplaces: [] } });
    return;
  }
  if (msg.method === 'app/list') {
    send({ id: msg.id, result: { data: [] } });
    return;
  }
  if (msg.method === 'skills/list') {
    send({ id: msg.id, result: { data: [] } });
    return;
  }
	  if (msg.method === 'thread/start') {
	    if (
	      msg.params.approvalPolicy !== 'on-request' ||
	      msg.params.sandbox !== 'workspace-write' ||
        typeof msg.params.developerInstructions !== 'string' ||
	      msg.params.experimentalRawEvents !== false ||
	      msg.params.persistExtendedHistory !== true
	    ) {
	      send({ id: msg.id, error: { message: 'invalid thread/start params', params: msg.params } });
	      return;
	    }
	    send({ id: msg.id, result: { thread: { id: 'thr_fixture' } } });
	    send({ method: 'thread/started', params: { thread: { id: 'thr_fixture' } } });
	    return;
	  }
  if (msg.method === 'turn/start') {
    const text = msg.params.input?.[0]?.text || '';
    if (text.includes('Codex App Server') || text.includes('plans folder')) {
      send({ id: msg.id, error: { message: 'system prompt leaked into user turn', text } });
      return;
    }
    send({ id: msg.id, result: { turn: { id: 'turn_fixture', status: 'inProgress', items: [] } } });
    send({ method: 'turn/started', params: { turn: { id: 'turn_fixture' } } });
	    send({ method: 'item/started', params: { item: { id: 'cmd_fixture', type: 'commandExecution', command: ['echo', 'ok'], cwd: '/tmp' } } });
	    send({ method: 'item/completed', params: { item: { id: 'cmd_fixture', type: 'commandExecution', status: 'completed', aggregatedOutput: 'ok\\n' } } });
	    send({ method: 'item/agentMessage/delta', params: { itemId: 'msg_fixture', delta: 'hello ' } });
	    send({ method: 'item/agentMessage/delta', params: { itemId: 'msg_fixture', delta: 'world' } });
	    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr_fixture', turnId: 'turn_fixture', tokenUsage: { total: { inputTokens: 123, totalTokens: 130, cachedInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 0 }, last: { inputTokens: 123, totalTokens: 130, cachedInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 0 }, modelContextWindow: 272000 } } });
	    send({ method: 'turn/completed', params: { turn: { id: 'turn_fixture', status: 'completed' } } });
	    ${options.duplicateTurnCompleted ? "send({ method: 'turn/completed', params: { turn: { id: 'turn_fixture', status: 'completed' } } });" : ''}
	    return;
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
  }
});
`, 'utf8');
  return scriptPath;
}

function createConfig(scriptPath: string): BackendConfig {
  const rootPath = tmpdir();
  return {
    provider: 'codex',
    providerType: 'codex',
    authType: 'none',
    model: 'gpt-5.5',
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
      codexCommand: process.execPath,
      codexArgs: [scriptPath],
    },
  };
}

describe('CodexAgent', () => {
  it('streams Codex app-server turns as AgentEvents', async () => {
    const scriptPath = await createFixtureCodexServer();
    const agent = new CodexAgent(createConfig(scriptPath));
    const events = [];

    try {
      for await (const event of agent.chat('Say hi')) {
        events.push(event);
      }
    } finally {
      agent.destroy();
    }

    expect(events).toContainEqual({ type: 'text_delta', text: 'hello ', turnId: 'turn_fixture' });
    expect(events).toContainEqual({
      type: 'tool_start',
      toolName: 'Bash',
      toolUseId: 'cmd_fixture',
      input: { command: 'echo ok', cwd: '/tmp' },
      turnId: 'turn_fixture',
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      toolName: 'Bash',
      toolUseId: 'cmd_fixture',
      result: 'ok\n',
      isError: false,
      turnId: 'turn_fixture',
    });
    expect(events).toContainEqual({ type: 'text_delta', text: 'world', turnId: 'turn_fixture' });
    expect(events).toContainEqual({ type: 'usage_update', usage: { inputTokens: 123, contextWindow: 272000 } });
    expect(events).toContainEqual({ type: 'text_complete', text: 'hello world', turnId: 'turn_fixture' });
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('fetches models through model/list', async () => {
    const scriptPath = await createFixtureCodexServer();

    const models = await CodexAgent.fetchAvailableModels({
      command: process.execPath,
      args: [scriptPath],
    });

    expect(models).toEqual([{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000 }]);
  });

  it('emits one final text_complete if Codex repeats turn/completed', async () => {
    const scriptPath = await createFixtureCodexServer({ duplicateTurnCompleted: true });
    const agent = new CodexAgent(createConfig(scriptPath));
    const events = [];

    try {
      for await (const event of agent.chat('Say hi')) {
        events.push(event);
      }
    } finally {
      agent.destroy();
    }

    expect(events.filter(event => event.type === 'text_complete')).toEqual([
      { type: 'text_complete', text: 'hello world', turnId: 'turn_fixture' },
    ]);
  });
});
