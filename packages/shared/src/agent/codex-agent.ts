/**
 * Codex Backend (native app-server JSON-RPC client)
 *
 * Runs `codex app-server --listen stdio://` as a subprocess and adapts the
 * Codex app-server event stream into Craft Agent events.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFile } from 'node:fs/promises';

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
import { prepareCodexRuntimeHome, type CodexRuntimeHomeResult } from './backend/codex-runtime-home.ts';
import {
  capabilityDedupeKey,
  evaluateNativeCapabilityPolicy,
  type NativeCapabilityInventory,
  type NativeCapabilityItem,
} from './backend/native-capabilities.ts';

interface JsonRpcMessage {
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

function extractId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ['id', 'threadId', 'turnId']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

function extractCodexText(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (!record) return '';
  const direct = record.delta ?? record.text;
  return typeof direct === 'string' ? direct : '';
}

export class CodexAgent extends BaseAgent {
  protected backendName = 'Codex App Server';

  private subprocess: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private initialized: Promise<void> | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private eventQueue = new EventQueue();
  private requestId = 0;
  private _isProcessing = false;
  private codexThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private abortReason?: AbortReason;
  private currentTurnText = '';
  private runtimeHome: CodexRuntimeHomeResult | null = null;
  private nativeInventory: NativeCapabilityInventory | null = null;
  private pendingPermissions = new Map<string, {
    resolve: (allowed: boolean) => void;
    requestId: string | number;
  }>();

  constructor(config: BackendConfig) {
    super(config, config.model || 'gpt-5.5');
    this._supportsBranching = false;
    this.codexThreadId = config.session?.sdkSessionId || null;
    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  static async fetchAvailableModels(args: {
    command?: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<unknown[]> {
    const agent = new CodexAgent({
      provider: 'codex',
      providerType: 'codex',
      authType: 'none',
      workspace: { id: '__models', name: 'Model Fetch', slug: '__models', rootPath: homedir(), createdAt: 0 },
      session: { id: `models-${Date.now()}`, workspaceRootPath: homedir(), createdAt: 0, lastUsedAt: 0 },
      isHeadless: true,
      runtime: {
        codexCommand: args.command || 'codex',
        codexArgs: args.args || ['app-server', '--listen', 'stdio://'],
      },
    });

    try {
      await agent.ensureSubprocess();
      const result = await agent.sendRequest('model/list', { includeHidden: false }, args.timeoutMs);
      const record = asRecord(result);
      const models = record?.models ?? record?.data;
      return Array.isArray(models) ? models : [];
    } finally {
      agent.destroy();
    }
  }

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentTurnText = '';

    try {
      await this.ensureSubprocess();
      const craftInstructions = this.buildCraftInstructions();
      await this.ensureThread(false, craftInstructions);

      const attachmentText = (attachments || [])
        .map(att => `[Attached file: ${att.name || att.path || att.storedPath}]\n[Stored at: ${att.storedPath || att.path || ''}]`)
        .join('\n\n');
      const userText = [attachmentText, message].filter(Boolean).join('\n\n');

      const turn = asRecord(await this.sendRequest('turn/start', {
        threadId: this.codexThreadId,
        input: [{ type: 'text', text: userText }],
        cwd: this.resolvedCwd(),
        model: this._model || undefined,
        effort: options?.thinkingOverride || this._thinkingLevel || undefined,
      }))?.turn;
      this.activeTurnId = extractId(turn);

      yield* this.eventQueue.drain();
    } catch (error) {
      if (!this.abortReason) {
        yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this._isProcessing = false;
      this.activeTurnId = null;
      yield { type: 'complete' };
    }
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    if (this._isProcessing) {
      const session = this.config.session;
      if (!session) {
        throw new Error('Codex mini completion requires a session context');
      }
      const miniAgent = new CodexAgent({
        ...this.config,
        isHeadless: true,
        session: {
          ...session,
          id: `${session.id}-mini-${Date.now()}`,
          sdkSessionId: undefined,
        },
      });
      try {
        return await miniAgent.runMiniCompletion(prompt);
      } finally {
        miniAgent.destroy();
      }
    }

    await this.ensureSubprocess();
    const previousThreadId = this.codexThreadId;
    this.eventQueue.reset();
    this.currentTurnText = '';
    await this.ensureThread(true);

    try {
      const result = asRecord(await this.sendRequest('turn/start', {
        threadId: this.codexThreadId,
        input: [{ type: 'text', text: prompt }],
        cwd: this.resolvedCwd(),
        model: this.config.miniModel || this._model || undefined,
        effort: 'low',
      }));
      this.activeTurnId = extractId(result?.turn);

      await this.waitForTurnCompletion();
      return this.currentTurnText.trim() || null;
    } finally {
      this.codexThreadId = previousThreadId;
      this.activeTurnId = null;
    }
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

  respondToPermission(requestId: string, allowed: boolean, _alwaysAllow?: boolean, _optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(allowed);
  }

  private rejectPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
  }

  async abort(reason?: string): Promise<void> {
    this.forceAbort(reason === AbortReason.Redirect ? AbortReason.Redirect : AbortReason.UserStop);
  }

  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.abortReason = reason;
    this._isProcessing = false;
    this.rejectPendingPermissions();
    if (this.codexThreadId && this.activeTurnId) {
      void this.sendRequest('turn/interrupt', {
        threadId: this.codexThreadId,
        turnId: this.activeTurnId,
      }).catch(() => {});
    }
    this.eventQueue.complete();
  }

  override redirect(message: string): boolean {
    if (!this._isProcessing || !this.codexThreadId || !this.activeTurnId) {
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    void this.sendRequest('turn/steer', {
      threadId: this.codexThreadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: 'text', text: message }],
    }).catch(() => {
      this.forceAbort(AbortReason.Redirect);
    });
    return true;
  }

  override getSessionId(): string | null {
    return this.codexThreadId;
  }

  override setSessionId(sessionId: string | null): void {
    this.codexThreadId = sessionId;
  }

  override clearHistory(): void {
    this.codexThreadId = null;
    super.clearHistory();
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

    await this.prepareRuntimeHome();
    this.spawnSubprocess();
    this.initialized = this.sendRequest('initialize', {
      clientInfo: {
        name: 'craft_agent',
        title: 'Craft Agents',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }).then(() => {
      this.sendNotification('initialized');
      void this.refreshNativeInventory();
    });

    await this.initialized;
  }

  private spawnSubprocess(): void {
    const runtime = getBackendRuntime(this.config);
    const command = runtime.codexCommand || 'codex';
    const args = runtime.codexArgs || ['app-server', '--listen', 'stdio://'];
    const cwd = this.resolvedCwd();
    const envOverrides = {
      ...this.runtimeHome?.env,
      ...this.config.envOverrides,
    };

    this.debug(`Spawning Codex app-server subprocess: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    this.subprocess = child;
    this.readline = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.readline.on('line', (line) => this.handleLine(line));

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.debug(`[codex stderr] ${text}`);
    });

    child.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.rejectPendingPermissions();
      if (this._isProcessing && !this.abortReason) {
        this.eventQueue.enqueue({ type: 'error', message: error.message });
      }
      this.eventQueue.complete();
      this.resetSubprocessState();
    });

    child.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.rejectPendingPermissions();
      this.eventQueue.enqueue({ type: 'error', message: `Codex app-server error: ${error.message}` });
      this.eventQueue.complete();
      this.resetSubprocessState();
    });
  }

  private async ensureThread(ephemeral: boolean, developerInstructions?: string): Promise<void> {
    if (this.codexThreadId) {
      if (!ephemeral) {
        return;
      }
      this.codexThreadId = null;
    }

    const result = asRecord(await this.sendRequest('thread/start', {
      model: this._model || undefined,
      cwd: this.resolvedCwd(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'craft_agent',
      config: this.runtimeHome?.configOverrides,
      developerInstructions: developerInstructions || undefined,
      ephemeral,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    }));
    const thread = asRecord(result?.thread);
    const threadId = extractId(thread);
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id');
    }
    this.codexThreadId = threadId;
    if (!ephemeral) {
      this.config.onSdkSessionIdUpdate?.(threadId);
    }
  }

  private async prepareRuntimeHome(): Promise<void> {
    if (this.runtimeHome) return;
    const runtime = getBackendRuntime(this.config);
    this.runtimeHome = await prepareCodexRuntimeHome({
      connectionSlug: this.config.connectionSlug || runtime.codexName,
      craftInventory: this.config.craftCapabilityInventory,
      policy: this.config.nativeCapabilityPolicy || runtime.nativeCapabilityPolicy,
      model: this._model || undefined,
      debug: (message) => this.debug(`[codex-runtime] ${message}`),
    });
    this.config.nativeCapabilityManifest = this.runtimeHome.manifest;
  }

  private buildCraftInstructions(): string {
    const systemPrompt = getSystemPrompt(
      undefined,
      this.config.debugMode,
      this.config.workspace.rootPath,
      this.config.session?.workingDirectory,
      this.config.systemPromptPreset,
      'Codex App Server',
    );
    const sourceContext = this.sourceManager.formatSourceState();
    const contextParts = this.promptBuilder.buildContextParts(
      { plansFolderPath: getSessionPlansPath(this.config.workspace.rootPath, this._sessionId) },
      sourceContext,
    );
    return [systemPrompt, ...contextParts].filter(Boolean).join('\n\n');
  }

  private async refreshNativeInventory(): Promise<void> {
    const items: NativeCapabilityItem[] = [];
    const warnings: string[] = [];

    const addItem = (item: NativeCapabilityItem) => {
      items.push({
        ...item,
        dedupeKey: item.dedupeKey || capabilityDedupeKey(item.kind, item.name),
      });
    };

    const safeRequest = async (method: string, params: unknown): Promise<unknown | null> => {
      try {
        return await this.sendRequest(method, params, 10_000);
      } catch (error) {
        warnings.push(`${method}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    const mcpStatus = asRecord(await safeRequest('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100 }));
    const mcpRows = Array.isArray(mcpStatus?.data) ? mcpStatus.data : [];
    for (const row of mcpRows) {
      const server = asRecord(row);
      const serverName = typeof server?.name === 'string' ? server.name : '';
      if (!serverName) continue;
      addItem({
        id: `codex:mcp-server:${serverName}`,
        kind: 'mcp-server',
        source: 'codex',
        name: serverName,
        enabled: true,
      });
      const tools = asRecord(server?.tools);
      for (const toolName of Object.keys(tools || {})) {
        addItem({
          id: `codex:mcp-tool:${serverName}:${toolName}`,
          kind: 'mcp-tool',
          source: 'codex',
          name: toolName,
          parentId: `codex:mcp-server:${serverName}`,
          enabled: true,
          dedupeKey: capabilityDedupeKey('mcp-tool', toolName, serverName),
        });
      }
    }

    const plugins = asRecord(await safeRequest('plugin/list', { cwds: [this.resolvedCwd()] }));
    const marketplaces = Array.isArray(plugins?.marketplaces) ? plugins.marketplaces : [];
    for (const marketplace of marketplaces) {
      const market = asRecord(marketplace);
      const pluginRows = Array.isArray(market?.plugins) ? market.plugins : [];
      for (const row of pluginRows) {
        const plugin = asRecord(row);
        const id = typeof plugin?.id === 'string' ? plugin.id : '';
        const name = typeof plugin?.name === 'string' ? plugin.name : id;
        if (!id && !name) continue;
        addItem({
          id: `codex:plugin:${id || name}`,
          kind: 'plugin',
          source: 'codex',
          name,
          enabled: plugin?.enabled !== false,
          metadata: { installed: plugin?.installed === true },
        });
      }
    }

    const apps = asRecord(await safeRequest('app/list', { cwds: [this.resolvedCwd()] }));
    const appRows = Array.isArray(apps?.data) ? apps.data : Array.isArray(apps?.apps) ? apps.apps : [];
    for (const row of appRows) {
      const app = asRecord(row);
      const id = typeof app?.id === 'string' ? app.id : '';
      const name = typeof app?.name === 'string' ? app.name : id;
      if (!id && !name) continue;
      addItem({
        id: `codex:app:${id || name}`,
        kind: 'app',
        source: 'codex',
        name,
        enabled: app?.isEnabled === true,
        metadata: { accessible: app?.isAccessible === true },
      });
    }

    const skills = asRecord(await safeRequest('skills/list', { cwds: [this.resolvedCwd()], forceReload: false }));
    const skillEntries = Array.isArray(skills?.data) ? skills.data : [];
    for (const entry of skillEntries) {
      const skillEntry = asRecord(entry);
      const skillRows = Array.isArray(skillEntry?.skills) ? skillEntry.skills : [];
      for (const row of skillRows) {
        const skill = asRecord(row);
        const name = typeof skill?.name === 'string' ? skill.name : '';
        if (!name) continue;
        addItem({
          id: `codex:skill:${name}`,
          kind: 'skill',
          source: 'codex',
          name,
          enabled: skill?.enabled !== false,
          metadata: { scope: skill?.scope },
        });
      }
    }

    this.nativeInventory = { items, generatedAt: Date.now(), warnings };
    if (this.runtimeHome) {
      const decisions = evaluateNativeCapabilityPolicy({
        policy: this.config.nativeCapabilityPolicy,
        craftInventory: this.config.craftCapabilityInventory,
        nativeInventory: this.nativeInventory,
      });
      const manifest = {
        ...this.runtimeHome.manifest,
        nativeInventory: this.nativeInventory,
        decisions,
        warnings: [...this.runtimeHome.manifest.warnings, ...warnings],
      };
      this.config.nativeCapabilityManifest = manifest;
      await writeFile(join(this.runtimeHome.runtimeHome, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    }
  }

  private sendRequest(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.requestId;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.writeMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.writeMessage({ method, params });
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.subprocess?.stdin?.writable) {
      throw new Error('Codex app-server subprocess is not running');
    }
    this.subprocess.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.debug(`Invalid JSONL from Codex app-server: ${line.slice(0, 200)}`);
      return;
    }

    if (message.id != null && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(asRecord(message.error)?.message as string || JSON.stringify(message.error)));
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
    const record = asRecord(params);
    switch (method) {
      case 'thread/started': {
        const threadId = extractId(record?.thread);
        if (threadId && !this.codexThreadId) {
          this.codexThreadId = threadId;
          this.config.onSdkSessionIdUpdate?.(threadId);
        }
        break;
      }
      case 'turn/started': {
        const turnId = extractId(record?.turn);
        if (turnId) this.activeTurnId = turnId;
        break;
      }
      case 'item/agentMessage/delta': {
        const text = extractCodexText(record);
        if (text) {
          this.currentTurnText += text;
          this.eventQueue.enqueue({ type: 'text_delta', text, turnId: this.activeTurnId || undefined });
        }
        break;
      }
      case 'item/started': {
        this.handleItemStarted(record);
        break;
      }
      case 'item/completed': {
        this.handleItemCompleted(record);
        break;
      }
      case 'turn/completed': {
        const turn = asRecord(record?.turn);
        if (turn) {
          const status = typeof turn.status === 'string' ? turn.status : '';
          const error = asRecord(turn.error);
          if (status === 'failed' && !this.abortReason) {
            this.eventQueue.enqueue({
              type: 'error',
              message: typeof error?.message === 'string' ? error.message : 'Codex turn failed',
            });
          }
          if (this.currentTurnText) {
            this.eventQueue.enqueue({
              type: 'text_complete',
              text: this.currentTurnText,
              turnId: this.activeTurnId || undefined,
            });
          }
        }
        this.eventQueue.complete();
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = asRecord(record?.tokenUsage) ?? asRecord(record?.usage);
        const total = asRecord(usage?.total);
        const inputTokens = total?.inputTokens ?? total?.input_tokens ?? usage?.inputTokens ?? usage?.input_tokens;
        if (typeof inputTokens === 'number') {
          const contextWindow = usage?.modelContextWindow ?? usage?.model_context_window;
          this.eventQueue.enqueue({
            type: 'usage_update',
            usage: {
              inputTokens,
              contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private handleItemStarted(params: Record<string, unknown> | null): void {
    const item = asRecord(params?.item);
    if (!item) return;
    const id = typeof item.id === 'string' ? item.id : `codex-item-${Date.now()}`;
    if (item.type === 'commandExecution') {
      const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
      this.eventQueue.enqueue({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: id,
        input: { command, cwd: item.cwd },
        turnId: this.activeTurnId || undefined,
      });
    } else if (item.type === 'mcpToolCall') {
      this.eventQueue.enqueue({
        type: 'tool_start',
        toolName: String(item.tool || 'mcp_tool'),
        toolUseId: id,
        input: asRecord(item.arguments) || {},
        turnId: this.activeTurnId || undefined,
      });
    }
  }

  private handleItemCompleted(params: Record<string, unknown> | null): void {
    const item = asRecord(params?.item);
    if (!item) return;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) return;
    if (item.type === 'commandExecution') {
      this.eventQueue.enqueue({
        type: 'tool_result',
        toolUseId: id,
        toolName: 'Bash',
        result: String(item.aggregatedOutput || item.output || ''),
        isError: item.status === 'failed' || item.status === 'declined',
        turnId: this.activeTurnId || undefined,
      });
    } else if (item.type === 'mcpToolCall') {
      this.eventQueue.enqueue({
        type: 'tool_result',
        toolUseId: id,
        toolName: String(item.tool || 'mcp_tool'),
        result: String(item.result || item.error || ''),
        isError: item.status === 'failed',
        turnId: this.activeTurnId || undefined,
      });
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (!message.method || message.id == null) return;
    if (
      message.method === 'item/commandExecution/requestApproval' ||
      message.method === 'item/fileChange/requestApproval'
    ) {
      const params = asRecord(message.params);
      const command = params?.command;
      const commandText = Array.isArray(command) ? command.join(' ') : String(command || '');
      const permissionId = `codex-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const allowed = await new Promise<boolean>((resolve) => {
        this.pendingPermissions.set(permissionId, { resolve, requestId: message.id! });
        this.onPermissionRequest?.({
          requestId: permissionId,
          toolName: message.method!.includes('fileChange') ? 'Edit' : 'Bash',
          command: commandText || undefined,
          description: commandText || String(params?.reason || 'Codex requests permission to continue'),
          type: message.method!.includes('fileChange') ? 'file_write' : 'bash',
          reason: typeof params?.reason === 'string' ? params.reason : undefined,
        });
        if (!this.onPermissionRequest) resolve(true);
      });
      this.pendingPermissions.delete(permissionId);
      this.writeMessage({
        id: message.id,
        result: { decision: allowed ? 'accept' : 'decline' },
      });
      return;
    }

    this.writeMessage({
      id: message.id,
      error: { code: -32601, message: `Unsupported Codex app-server request: ${message.method}` },
    });
  }

  private waitForTurnCompletion(timeoutMs = 60_000): Promise<void> {
    if (this.eventQueue.isComplete) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex turn timed out')), timeoutMs);
      const drain = async () => {
        try {
          for await (const _event of this.eventQueue.drain()) {
            // Drain mini-completion events without exposing them.
          }
          clearTimeout(timer);
          resolve();
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      };
      void drain();
    });
  }

  private killSubprocess(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.subprocess) {
      this.subprocess.kill('SIGTERM');
      this.subprocess = null;
    }
    this.resetSubprocessState();
  }

  private resetSubprocessState(): void {
    this.readline = null;
    this.subprocess = null;
    this.initialized = null;
    this.codexThreadId = null;
    this.activeTurnId = null;
  }

  private resolvedCwd(): string {
    const wd = this.workingDirectory;
    if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
    if (wd === '~') return homedir();
    return wd;
  }
}
