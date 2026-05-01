/**
 * ACP Backend (stdio JSON-RPC client)
 *
 * Runs an Agent Client Protocol compatible command as a subprocess and adapts
 * its session/update stream into Craft Agent events. This is intentionally a
 * small gateway: Codex, Droid, or agent-proxy can sit behind the same protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import { BaseAgent } from './base-agent.ts';
import type { BackendConfig, ChatOptions } from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { EventQueue } from './backend/event-queue.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { getSystemPrompt } from '../prompts/system.ts';
import { getSessionPlansPath } from '../sessions/storage.ts';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string } | unknown;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function firstRecord(record: Record<string, unknown> | null, keys: string[]): Record<string, unknown> | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) return value;
  }
  return null;
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (asRecord(value)) return value as Record<string, unknown>;
  return {};
}

function textBlock(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

function normalizeAcpMcpServers(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractToolPayload(params: unknown): {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  parentToolUseId?: string;
} | null {
  const root = asRecord(params);
  const tool = firstRecord(root, ['toolCall', 'tool_call', 'tool', 'call', 'item']) ?? root;
  if (!tool) return null;

  const id = firstString(tool, ['id', 'toolUseId', 'tool_use_id', 'toolCallId', 'tool_call_id', 'callId']);
  const name = firstString(tool, ['name', 'toolName', 'tool_name', 'title'])
    ?? firstString(asRecord(tool.server), ['name'])
    ?? firstString(root, ['toolName', 'tool_name']);
  if (!id || !name) return null;

  const input = normalizeToolInput(tool.input ?? tool.rawInput ?? tool.arguments ?? tool.args ?? root?.input ?? root?.arguments);
  const resultValue = tool.result ?? tool.rawOutput ?? tool.output ?? tool.content ?? root?.result ?? root?.rawOutput ?? root?.output ?? root?.content;
  const errorValue = tool.error ?? root?.error;
  const result = errorValue != null
    ? (typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue))
    : resultValue != null
      ? (typeof resultValue === 'string' ? resultValue : JSON.stringify(resultValue))
      : undefined;

  return {
    id,
    name,
    input,
    result,
    isError: Boolean(tool.isError ?? tool.is_error ?? tool.error ?? root?.isError ?? root?.is_error ?? root?.error ?? tool.status === 'failed'),
    parentToolUseId: firstString(tool, ['parentToolUseId', 'parent_tool_use_id']),
  };
}

function isToolStartMethod(method: string): boolean {
  const normalized = method.toLowerCase().replace(/[-_.]/g, '/');
  return normalized.includes('tool/call/start')
    || normalized.includes('toolcall/start')
    || normalized.includes('tool/start')
    || normalized === 'item/started';
}

function isToolResultMethod(method: string): boolean {
  const normalized = method.toLowerCase().replace(/[-_.]/g, '/');
  return normalized.includes('tool/call/result')
    || normalized.includes('toolcall/result')
    || normalized.includes('tool/call/end')
    || normalized.includes('toolcall/end')
    || normalized.includes('tool/call/complete')
    || normalized.includes('toolcall/complete')
    || normalized.includes('tool/result')
    || normalized.includes('tool/end')
    || normalized.includes('tool/complete')
    || normalized === 'item/completed';
}

function isPermissionRequestMethod(method: string): boolean {
  return /permission|approval/i.test(method) && /request|ask|approve/i.test(method);
}

const TEXT_SESSION_UPDATE_KINDS = new Set([
  'agent_message_chunk',
  'agent_message',
  'assistant_message_chunk',
  'assistant_message',
  'message_chunk',
  'message_delta',
  'text',
  'text_delta',
  'output',
]);

const STATUS_SESSION_UPDATE_KINDS = new Set([
  'status',
  'progress',
  'agent_status',
  'session_status',
  'thinking',
  'thinking_chunk',
  'thought',
  'thought_chunk',
  'agent_thought',
  'agent_thought_chunk',
]);

function normalizeSessionUpdateKind(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[-\s]/g, '_');
}

function extractAcpStatusText(update: Record<string, unknown> | null): string | undefined {
  const direct = firstString(update, ['message', 'text', 'status', 'summary', 'title']);
  if (direct) return direct;

  const nested = firstRecord(update, ['content', 'delta', 'progress']);
  return firstString(nested, ['message', 'text', 'status', 'summary', 'title']);
}

export function extractAcpText(value: unknown): string[] {
  const texts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, keyHint?: string): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (keyHint && /^(text|delta|content|message|output|summary)$/i.test(keyHint)) {
        texts.push(node);
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint);
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, key);
    }
  };

  visit(value);
  return texts.filter(text => text.trim().length > 0);
}

export class AcpAgent extends BaseAgent {
  protected backendName = 'ACP Agent';

  private subprocess: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private initialized: Promise<void> | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private eventQueue = new EventQueue();
  private requestId = 0;
  private _isProcessing = false;
  private acpSessionId: string | null = null;
  private agentCapabilities: Record<string, unknown> | null = null;
  private abortReason?: AbortReason;
  private currentTurnText = '';
  private pendingPermissions = new Map<string, {
    resolve: (allowed: boolean) => void;
    requestId: string | number;
  }>();

  constructor(config: BackendConfig) {
    super(config, config.model || '');
    this._supportsBranching = false;
    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentTurnText = '';

    try {
      await this.ensureSubprocess();
      await this.ensureSession();

      const craftContext = this.buildCraftContext();
      const attachmentText = (attachments || [])
        .map(att => `[Attached file: ${att.name || att.path || att.storedPath}]\n[Stored at: ${att.storedPath || att.path || ''}]`)
        .join('\n\n');
      const promptText = [craftContext, attachmentText, message].filter(Boolean).join('\n\n');

      const promptId = this.nextId('prompt');
      const done = this.sendRequestWithId(promptId, 'session/prompt', {
        sessionId: this.acpSessionId,
        prompt: textBlock(promptText),
      }).then((result) => {
        const resultText = extractAcpText(result).join('');
        const finalText = this.combineStreamAndResult(this.currentTurnText, resultText);
        if (finalText) {
          this.eventQueue.enqueue({ type: 'text_complete', text: finalText });
        }
      }).catch((error) => {
        if (this.abortReason) return;
        this.eventQueue.enqueue({ type: 'error', message: error.message });
      }).finally(() => {
        this.eventQueue.complete();
      });

      yield* this.eventQueue.drain();
      await done;
    } catch (error) {
      if (!this.abortReason) {
        yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this._isProcessing = false;
      yield { type: 'complete' };
    }
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    if (this._isProcessing) {
      const session = this.config.session;
      if (!session) {
        throw new Error('ACP mini completion requires a session context');
      }
      const miniAgent = new AcpAgent({
        ...this.config,
        isHeadless: true,
        session: {
          ...session,
          id: `${session.id}-mini-${Date.now()}`,
        },
      });
      try {
        return await miniAgent.runMiniCompletion(prompt);
      } finally {
        miniAgent.destroy();
      }
    }

    await this.ensureSubprocess();
    await this.ensureSession();
    this.currentTurnText = '';

    const result = await this.sendRequest('session/prompt', {
      sessionId: this.acpSessionId,
      prompt: textBlock(prompt),
    });

    const resultText = extractAcpText(result).join('');
    return this.combineStreamAndResult(this.currentTurnText, resultText).trim() || null;
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    const text = await this.runMiniCompletion(
      [request.systemPrompt, request.prompt].filter(Boolean).join('\n\n'),
    );
    return {
      text: text || '',
      model: request.model || this.config.miniModel || this._model || '',
    };
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  respondToPermission(requestId: string, allowed: boolean, _alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(allowed);
  }

  async abort(reason?: string): Promise<void> {
    this.forceAbort(reason === AbortReason.Redirect ? AbortReason.Redirect : AbortReason.UserStop);
  }

  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.abortReason = reason;
    this._isProcessing = false;
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
    void this.sendRequest('session/cancel', { sessionId: this.acpSessionId }).catch(() => {});
    this.eventQueue.complete();
  }

  destroy(): void {
    this.killSubprocess();
    super.destroy();
  }

  private async ensureSubprocess(): Promise<void> {
    if (this.subprocess && this.initialized) {
      await this.initialized;
      return;
    }

    this.spawnSubprocess();
    this.initialized = this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'craft-agent',
        version: '0.0.0',
      },
    }).then((result) => {
      this.agentCapabilities = asRecord(asRecord(result)?.agentCapabilities ?? asRecord(result)?.capabilities);
    });

    await this.initialized;
  }

  private spawnSubprocess(): void {
    const runtime = getBackendRuntime(this.config);
    const command = runtime.acpCommand || 'agent-proxy';
    const args = runtime.acpArgs || ['acp', '--agent', 'codex'];
    const cwd = this.resolvedCwd();

    this.debug(`Spawning ACP subprocess: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.config.envOverrides,
      },
    });

    this.subprocess = child;
    this.readline = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.readline.on('line', (line) => this.handleLine(line));

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.debug(`[acp stderr] ${text}`);
    });

    child.on('exit', (code, signal) => {
      const error = new Error(`ACP subprocess exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this._isProcessing && !this.abortReason) {
        this.eventQueue.enqueue({ type: 'error', message: error.message });
      }
      this.eventQueue.complete();
      this.resetSubprocessState();
    });

    child.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.eventQueue.enqueue({ type: 'error', message: `ACP subprocess error: ${error.message}` });
      this.eventQueue.complete();
      this.resetSubprocessState();
    });
  }

  private async ensureSession(): Promise<void> {
    if (this.acpSessionId) return;

    const result = await this.sendRequest('session/new', {
      cwd: this.resolvedCwd(),
      mcpServers: normalizeAcpMcpServers(this.config.initialSources?.mcpServers),
      _meta: {
        craftSessionId: this.config.session?.id || this._sessionId,
        workspaceRoot: this.config.workspace.rootPath,
        model: this._model || undefined,
        systemContext: this.buildCraftContext(),
        craftAgentCapabilities: this.agentCapabilities ? Object.keys(this.agentCapabilities) : [],
      },
    });

    this.acpSessionId = this.extractSessionId(result) || this.config.session?.id || this._sessionId;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.debug(`Ignoring non-JSON ACP line: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(this.formatJsonRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id != null && message.method) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'session/update' || method === 'sessionUpdate') {
      this.handleSessionUpdate(params);
      return;
    }

    if (isToolStartMethod(method)) {
      const tool = extractToolPayload(params);
      if (!tool) return;
      this.eventQueue.enqueue({
        type: 'tool_start',
        toolName: tool.name,
        toolUseId: tool.id,
        input: tool.input,
        parentToolUseId: tool.parentToolUseId,
      });
      return;
    }

    if (isToolResultMethod(method)) {
      const tool = extractToolPayload(params);
      if (!tool) return;
      this.eventQueue.enqueue({
        type: 'tool_result',
        toolName: tool.name,
        toolUseId: tool.id,
        result: tool.result ?? '',
        isError: !!tool.isError,
        parentToolUseId: tool.parentToolUseId,
      });
    }
  }

  private handleSessionUpdate(params: unknown): void {
    const update = firstRecord(asRecord(params), ['update']) ?? asRecord(params);
    const updateKind = normalizeSessionUpdateKind(firstString(update, ['sessionUpdate', 'session_update']));

    if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
      const tool = extractToolPayload(update);
      if (!tool) return;
      if (updateKind === 'tool_call') {
        this.eventQueue.enqueue({
          type: 'tool_start',
          toolName: tool.name,
          toolUseId: tool.id,
          input: tool.input,
          parentToolUseId: tool.parentToolUseId,
        });
        if (tool.result == null) return;
      }
      this.eventQueue.enqueue({
        type: 'tool_result',
        toolName: tool.name,
        toolUseId: tool.id,
        result: tool.result ?? '',
        isError: !!tool.isError,
        parentToolUseId: tool.parentToolUseId,
      });
      return;
    }

    if (updateKind && STATUS_SESSION_UPDATE_KINDS.has(updateKind)) {
      const message = extractAcpStatusText(update);
      if (message) {
        this.eventQueue.enqueue({ type: 'status', message });
      }
      return;
    }

    if (updateKind && !TEXT_SESSION_UPDATE_KINDS.has(updateKind)) {
      this.debug(`Ignoring unsupported ACP session update kind: ${updateKind}`);
      return;
    }

    for (const text of extractAcpText(update ?? params)) {
      this.currentTurnText += text;
      this.eventQueue.enqueue({ type: 'text_delta', text });
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (!message.method || message.id == null) return;
    if (!isPermissionRequestMethod(message.method)) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unsupported ACP request: ${message.method}` },
      });
      return;
    }

    const params = asRecord(message.params);
    const permissionId = `acp-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const command = firstString(params, ['command', 'cmd']);
    const toolName = firstString(params, ['toolName', 'tool_name', 'tool']) ?? 'ACP Tool';
    const description = firstString(params, ['description', 'message', 'reason'])
      ?? command
      ?? `${toolName} requests permission to continue`;
    const permissionType = command ? 'bash' : 'mcp_mutation';

    const allowed = await new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(permissionId, { resolve, requestId: message.id! });
      this.onPermissionRequest?.({
        requestId: permissionId,
        toolName,
        command,
        description,
        type: permissionType,
        reason: firstString(params, ['reason']),
      });
      if (!this.onPermissionRequest) resolve(true);
    });

    this.pendingPermissions.delete(permissionId);
    this.writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        allowed,
        decision: allowed ? 'accept' : 'decline',
      },
    });
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return this.sendRequestWithId(this.nextId(method), method, params);
  }

  private sendRequestWithId(id: string, method: string, params?: unknown): Promise<unknown> {
    if (!this.subprocess?.stdin) {
      return Promise.reject(new Error('ACP subprocess is not running'));
    }

    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.writeMessage(payload, (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeMessage(payload: Record<string, unknown>, callback?: (error?: Error | null) => void): void {
    if (!this.subprocess?.stdin?.writable) {
      throw new Error('ACP subprocess is not running');
    }
    this.subprocess.stdin.write(`${JSON.stringify(payload)}\n`, callback);
  }

  private nextId(prefix: string): string {
    this.requestId += 1;
    return `${prefix}-${this.requestId}`;
  }

  private killSubprocess(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('ACP subprocess stopped'));
    }
    this.pending.clear();
    this.readline?.close();
    this.subprocess?.kill();
    this.resetSubprocessState();
  }

  private resetSubprocessState(): void {
    this.readline = null;
    this.subprocess = null;
    this.initialized = null;
    this.acpSessionId = null;
  }

  private resolvedCwd(): string {
    const wd = this.config.session?.workingDirectory || this.workingDirectory;
    if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
    if (wd === '~') return homedir();
    return wd;
  }

  private extractSessionId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    return typeof record.sessionId === 'string'
      ? record.sessionId
      : typeof record.id === 'string'
        ? record.id
        : null;
  }

  private formatJsonRpcError(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return JSON.stringify(error);
  }

  private combineStreamAndResult(streamed: string, result: string): string {
    if (!streamed) return result;
    if (!result) return streamed;
    return result.startsWith(streamed) ? result : `${streamed}${result}`;
  }

  private buildCraftContext(): string {
    const systemPrompt = getSystemPrompt(
      undefined,
      this.config.debugMode,
      this.config.workspace.rootPath,
      this.config.session?.workingDirectory,
      this.config.systemPromptPreset,
      'ACP Agent',
    );
    const sourceContext = this.sourceManager.formatSourceState();
    const contextParts = this.promptBuilder.buildContextParts(
      { plansFolderPath: getSessionPlansPath(this.config.workspace.rootPath, this._sessionId) },
      sourceContext,
    );
    return [systemPrompt, ...contextParts].filter(Boolean).join('\n\n');
  }
}
