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
import { normalizeAgentCapabilities, type AgentCapabilities, type PermissionOption, type PromptCapabilities } from './acp/acp-types.ts';
import { buildPromptContent, extractAcpText as helperExtractAcpText, walkContentBlocks } from './acp/acp-content.ts';
import {
  buildPermissionResponse,
  parsePermissionRequestParams,
  pickOptionId,
} from './acp/acp-permissions.ts';
import { withTimeout } from './acp/acp-timeout.ts';
import { AcpPromptQueue } from './acp/acp-prompt-queue.ts';
import { createNdjsonMirror, type NdjsonMirror } from './acp/acp-debug.ts';

/** Re-export so the existing test import (`{ extractAcpText } from '../acp-agent'`) keeps working. */
export const extractAcpText = helperExtractAcpText;

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

function normalizeSessionUpdateKind(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[-\s]/g, '_');
}

function extractAcpStatusText(update: Record<string, unknown> | null): string | undefined {
  const direct = firstString(update, ['message', 'text', 'status', 'summary', 'title']);
  if (direct) return direct;

  const nested = firstRecord(update, ['content', 'delta', 'progress']);
  return firstString(nested, ['message', 'text', 'status', 'summary', 'title']);
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
  private agentCapabilities: AgentCapabilities | null = null;
  private abortReason?: AbortReason;
  private currentTurnText = '';
  /**
   * True only for the very first prompt of a freshly created or loaded session.
   * Used to gate the inclusion of `_meta.systemContext` on `session/prompt`
   * (subsequent turns reuse the agent's in-memory history).
   */
  private firstTurnInSession = true;
  private pendingPermissions = new Map<string, {
    resolve: (decision: { allowed: boolean; alwaysAllow: boolean; optionId?: string }) => void;
    requestId: string | number;
    options: PermissionOption[];
  }>();
  private promptQueue = new AcpPromptQueue();

  private static readonly DEFAULT_TIMEOUTS = {
    initialize: 10_000,
    sessionNew: 10_000,
    sessionLoad: 10_000,
    sessionCancel: 2_000,
    prompt: 0, // unbounded by default; long turns are normal
  } as const;

  private getRequestTimeoutMs(label: keyof typeof AcpAgent.DEFAULT_TIMEOUTS): number {
    const runtime = getBackendRuntime(this.config) as { acpRequestTimeoutMs?: Partial<typeof AcpAgent.DEFAULT_TIMEOUTS> };
    const override = runtime.acpRequestTimeoutMs?.[label];
    if (typeof override === 'number' && Number.isFinite(override)) return override;
    return AcpAgent.DEFAULT_TIMEOUTS[label];
  }

  constructor(config: BackendConfig) {
    super(config, config.model || '');
    this._supportsBranching = false;
    // Seed the ACP session ID from persisted state so we can attempt
    // session/load on the very first chat() after a process restart.
    if (config.session?.acpSessionId) {
      this.acpSessionId = config.session.acpSessionId;
    }
    const runtime = getBackendRuntime(config) as { acpNdjsonPath?: string };
    this.ndjson = createNdjsonMirror({
      path: runtime.acpNdjsonPath,
      tag: config.session?.id,
    });
    if (this.ndjson.enabled) {
      this.debug(`ACP NDJSON mirror enabled: ${this.ndjson.path}`);
    }
    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  private static readonly RESPAWN_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
  private respawnAttempts = 0;
  /**
   * True when the *current* subprocess has answered `session/load` or
   * `session/new` for our `acpSessionId`. A surviving acpSessionId in
   * memory after a crash does NOT count — we must (re)establish the
   * session against the freshly spawned process.
   */
  private sessionEstablished = false;

  /** Optional NDJSON mirror for protocol traffic (gated by env / runtime). */
  private ndjson: NdjsonMirror | null = null;

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    // Serialize concurrent chat() calls so they don't race on the shared
    // subprocess, eventQueue, currentTurnText, or session id. The slot is
    // released at the end of this turn; queued callers proceed in order.
    const slot = this.promptQueue.acquire();
    await slot.ready;

    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentTurnText = '';

    try {
      await this.ensureSubprocess();
      await this.ensureSession();

      const promptContent = this.buildSessionPromptContent(message, attachments);
      const promptParams: Record<string, unknown> = {
        sessionId: this.acpSessionId,
        prompt: promptContent,
      };
      const meta = this.buildPromptMeta();
      if (meta) promptParams._meta = meta;

      const promptId = this.nextId('prompt');
      const done = this.sendRequestWithId(promptId, 'session/prompt', promptParams).then((result) => {
        // Mark first-turn-after-(new|load) as consumed; subsequent prompts
        // skip systemContext to avoid resending it every turn.
        this.firstTurnInSession = false;

        // Stream is authoritative. The session/prompt result carries
        // `stopReason` (per spec) — use any text only as a fallback when
        // the agent never streamed anything (some servers only emit
        // final-result text instead of agent_message_chunk).
        let finalText = this.currentTurnText;
        if (!finalText) {
          const fallback = extractAcpText(result).join('');
          if (fallback) {
            this.debug('stream was empty; falling back to session/prompt result text');
            finalText = fallback;
          }
        }
        if (finalText) {
          this.eventQueue.enqueue({ type: 'text_complete', text: finalText });
        }

        // Surface the spec-shaped stop reason so the UI can distinguish
        // end_turn from cancelled / max_tokens / refusal etc.
        const reason = this.extractStopReason(result);
        if (reason) {
          this.eventQueue.enqueue({ type: 'stop_reason', reason });
        }

        // Successful turn — clear the respawn back-off counter inside
        // `done` so the reset happens even when the consumer breaks out
        // of the for-await early (the generator's finally would skip
        // any code positioned after `await done`).
        this.respawnAttempts = 0;
      }).catch((error) => {
        if (this.abortReason) return;
        this.eventQueue.enqueue({ type: 'error', message: error.message });
      }).finally(() => {
        this.eventQueue.complete();
      });

      yield* this.eventQueue.drain();
      // `done` may already be settled (because `complete()` ran in its
      // finally), but await it anyway so any synchronous post-stream
      // work is observable to the caller.
      await done;
    } catch (error) {
      // Spawn / initialize / session-setup failure — bump the back-off
      // counter so the next chat() waits before trying again.
      this.respawnAttempts += 1;
      if (!this.abortReason) {
        yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this._isProcessing = false;
      slot.release();
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

    const promptContent = this.buildSessionPromptContent(prompt, undefined);
    const params: Record<string, unknown> = {
      sessionId: this.acpSessionId,
      prompt: promptContent,
    };
    const meta = this.buildPromptMeta();
    if (meta) params._meta = meta;

    const result = await this.sendRequest('session/prompt', params);
    this.firstTurnInSession = false;

    // Stream-authoritative; fall back to result text only when nothing streamed.
    let text = this.currentTurnText.trim();
    if (!text) {
      text = extractAcpText(result).join('').trim();
    }
    return text || null;
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

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve({ allowed, alwaysAllow: !!alwaysAllow, optionId });
  }

  async abort(reason?: string): Promise<void> {
    this.forceAbort(reason === AbortReason.Redirect ? AbortReason.Redirect : AbortReason.UserStop);
  }

  forceAbort(reason: AbortReason = AbortReason.UserStop): void {
    this.abortReason = reason;
    this._isProcessing = false;
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve({ allowed: false, alwaysAllow: false });
    }
    this.pendingPermissions.clear();
    // Cooperative cancel first; if the agent doesn't ack within the grace
    // window, escalate to SIGTERM and finally SIGKILL. The event queue is
    // completed regardless once we've stopped trying.
    void this.shutdownSubprocessGracefully().finally(() => {
      this.eventQueue.complete();
    });
  }

  /**
   * Cancel + graceful kill chain.
   *
   * Sequence (bounded):
   *  1) Send `session/cancel` as an ACP notification (no id) — this is the
   *     spec shape; expecting a response would make strict servers reply
   *     "method not found".
   *  2) Wait up to `sessionCancel` timeout for the in-flight session/prompt
   *     to settle (the agent should return `stopReason: 'cancelled'`).
   *  3) If still alive, send SIGTERM and wait `cancelTermGraceMs`.
   *  4) If still alive, send SIGKILL.
   *
   * Each step is a no-op if the subprocess has already exited.
   */
  private async shutdownSubprocessGracefully(): Promise<void> {
    const child = this.subprocess;
    if (!child) return;

    const sessionId = this.acpSessionId;
    if (sessionId) {
      try {
        this.writeMessage({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId },
        });
      } catch {
        // Stdin closed before we could write — fall through to kill.
      }

      // Briefly wait for the agent to acknowledge by exiting or by
      // settling its in-flight prompt. Bounded by the same budget as
      // the previous request-style cancel.
      const cancelDeadline = this.getRequestTimeoutMs('sessionCancel');
      if (cancelDeadline > 0) {
        await new Promise<void>((resolve) => {
          if (this.pending.size === 0 || child.exitCode != null || child.signalCode != null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, cancelDeadline);
          const onExit = () => { clearTimeout(timer); resolve(); };
          child.once('exit', onExit);
          // If all in-flight RPCs settle (the prompt rejected with
          // cancelled), proceed early without waiting the full budget.
          const tick = setInterval(() => {
            if (this.pending.size === 0) {
              clearInterval(tick);
              clearTimeout(timer);
              child.removeListener('exit', onExit);
              resolve();
            }
          }, 50);
        });
      }
    }

    if (child.exitCode != null || child.signalCode != null) return;

    const runtime = getBackendRuntime(this.config) as { acpCancelTermGraceMs?: number };
    const grace = typeof runtime.acpCancelTermGraceMs === 'number' && runtime.acpCancelTermGraceMs >= 0
      ? runtime.acpCancelTermGraceMs
      : 2_000;

    try { child.kill('SIGTERM'); } catch { /* ignore */ }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        } catch { /* ignore */ }
        resolve();
      }, grace);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.killSubprocess();
    this.ndjson?.close();
    this.ndjson = null;
    super.destroy();
  }

  private async ensureSubprocess(): Promise<void> {
    if (this.subprocess && this.initialized) {
      await this.initialized;
      return;
    }

    // Bounded back-off when the previous spawn failed; reset to attempt 0
    // on a successful turn (handled at end of chatImpl).
    if (this.respawnAttempts > 0) {
      const idx = Math.min(this.respawnAttempts - 1, AcpAgent.RESPAWN_DELAYS_MS.length - 1);
      const delay = AcpAgent.RESPAWN_DELAYS_MS[idx]!;
      if (this.respawnAttempts > AcpAgent.RESPAWN_DELAYS_MS.length) {
        throw new Error(`ACP backend unavailable after ${this.respawnAttempts - 1} respawn attempts`);
      }
      await new Promise((res) => setTimeout(res, delay));
    }

    this.spawnSubprocess();
    this.initialized = withTimeout(
      this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'craft-agent',
          version: '0.0.0',
        },
      }),
      this.getRequestTimeoutMs('initialize'),
      'initialize',
    ).then((result) => {
      const caps = asRecord(asRecord(result)?.agentCapabilities ?? asRecord(result)?.capabilities);
      this.agentCapabilities = normalizeAgentCapabilities(caps);
    });

    try {
      await this.initialized;
    } catch (error) {
      // Initialize failed (timeout, JSON-RPC error, ...). Without this
      // cleanup the subprocess stays alive and `this.initialized` keeps
      // its rejected promise, so the next chat() finds
      // `subprocess && initialized` truthy at the top of ensureSubprocess
      // and re-throws the cached rejection forever.
      this.killSubprocess();
      throw error;
    }
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
      // Stale handler: if we've already torn this subprocess down (e.g.
      // killSubprocess() ran during recovery and a new subprocess is now
      // active), the captured `child` is no longer authoritative. Don't
      // touch the event queue or the active turn's state.
      if (this.subprocess !== child) return;
      const error = new Error(`ACP subprocess exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.abortReason) {
        // Exit during a graceful shutdown — `forceAbort` will complete
        // the queue once the kill chain settles. Don't double-emit
        // error events or race with that path.
        this.resetSubprocessState({ clearSessionId: false });
        return;
      }
      if (this._isProcessing) {
        this.eventQueue.enqueue({ type: 'error', message: error.message });
      }
      this.eventQueue.complete();
      // Keep acpSessionId so the next chat() can attempt session/load.
      this.resetSubprocessState({ clearSessionId: false });
    });

    child.on('error', (error) => {
      if (this.subprocess !== child) return;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (this.abortReason) {
        this.resetSubprocessState({ clearSessionId: false });
        return;
      }
      this.eventQueue.enqueue({ type: 'error', message: `ACP subprocess error: ${error.message}` });
      this.eventQueue.complete();
      this.resetSubprocessState({ clearSessionId: false });
    });
  }

  private async ensureSession(): Promise<void> {
    // Established against the *current* subprocess — nothing to do.
    if (this.sessionEstablished && this.subprocess) return;

    const candidate = this.acpSessionId;
    const supportsLoad = !!this.agentCapabilities?.loadSession;

    // Try session/load when the agent advertises support and we have a
    // saved session id (either from the previous process or from
    // persisted SessionConfig.acpSessionId seeded in the ctor).
    if (candidate && supportsLoad) {
      try {
        await withTimeout(
          this.sendRequest('session/load', {
            sessionId: candidate,
            cwd: this.resolvedCwd(),
            mcpServers: normalizeAcpMcpServers(this.config.initialSources?.mcpServers),
            _meta: this.buildSessionInitMeta(),
          }),
          this.getRequestTimeoutMs('sessionLoad'),
          'session/load',
        );
        // Loaded successfully — reuse the saved id.
        this.acpSessionId = candidate;
        this.sessionEstablished = true;
        // Re-prime systemContext for this first turn after load; the
        // freshly spawned agent process needs it once.
        this.firstTurnInSession = true;
        return;
      } catch (error) {
        // Stale or rejected — discard the saved id and fall through to
        // session/new. Notify the host so persisted state matches reality.
        this.debug(`session/load failed for ${candidate}; falling back to session/new (${(error as Error).message})`);
        this.acpSessionId = null;
        this.config.onAcpSessionIdCleared?.();
      }
    }

    const result = await withTimeout(
      this.sendRequest('session/new', {
        cwd: this.resolvedCwd(),
        mcpServers: normalizeAcpMcpServers(this.config.initialSources?.mcpServers),
        _meta: this.buildSessionInitMeta(),
      }),
      this.getRequestTimeoutMs('sessionNew'),
      'session/new',
    );

    const newId = this.extractSessionId(result) || this.config.session?.id || this._sessionId;
    this.acpSessionId = newId;
    this.sessionEstablished = true;
    this.firstTurnInSession = true;
    if (newId && newId !== candidate) {
      this.config.onAcpSessionIdUpdate?.(newId);
    }
  }

  /**
   * Build the per-prompt content array, branching on the agent's
   * advertised PromptCapabilities for image/audio attachments. The
   * Craft system context is *not* included here — it goes on the
   * first prompt's `_meta.systemContext` (see `buildPromptMeta`).
   */
  private buildSessionPromptContent(message: string, attachments: readonly FileAttachment[] | undefined) {
    const caps: PromptCapabilities | undefined = this.agentCapabilities?.promptCapabilities;
    return buildPromptContent(message, attachments, caps);
  }

  /**
   * Build `_meta` for `session/prompt`. Returns a Craft-context payload only
   * on the first turn after `session/new` (or `session/load` in later phases).
   * Returns `null` for subsequent turns so we don't resend the system prompt.
   */
  private buildPromptMeta(): Record<string, unknown> | null {
    if (!this.firstTurnInSession) return null;
    const systemContext = this.buildCraftContext();
    if (!systemContext) return null;
    return { systemContext };
  }

  /** Metadata sent on `session/new` and (later) `session/load`. */
  private buildSessionInitMeta(): Record<string, unknown> {
    return {
      craftSessionId: this.config.session?.id || this._sessionId,
      workspaceRoot: this.config.workspace.rootPath,
      model: this._model || undefined,
      systemContext: this.buildCraftContext(),
      craftAgentCapabilities: this.agentCapabilities ? Object.keys(this.agentCapabilities) : [],
    };
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
    this.ndjson?.logIn(message);

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

    switch (updateKind) {
      case 'tool_call':
      case 'tool_call_update': {
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

      case 'agent_message_chunk':
      case 'user_message_chunk': {
        const walked = walkContentBlocks(update, 'agent_message_chunk');
        for (const text of walked.texts) {
          this.currentTurnText += text;
          this.eventQueue.enqueue({ type: 'text_delta', text });
        }
        return;
      }

      case 'agent_thought_chunk': {
        const walked = walkContentBlocks(update, 'agent_thought_chunk');
        for (const text of walked.thoughts) {
          this.eventQueue.enqueue({ type: 'thinking', text });
        }
        return;
      }

      case 'plan':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update': {
        // Surface these as informational events so the UI can render them
        // when supported, without blocking the stream on unknown shapes.
        const message = extractAcpStatusText(update);
        if (message) this.eventQueue.enqueue({ type: 'info', message });
        return;
      }

      // Non-spec but commonly seen Craft extension — some agents emit progress
      // markers under `status`/`progress`/`thought` discriminators. Treat them
      // as status events rather than slurping their text into the assistant
      // message stream.
      case 'status':
      case 'progress':
      case 'agent_status':
      case 'session_status': {
        const message = extractAcpStatusText(update);
        if (message) this.eventQueue.enqueue({ type: 'status', message });
        return;
      }
      case 'thinking':
      case 'thinking_chunk':
      case 'thought':
      case 'thought_chunk':
      case 'agent_thought': {
        const text = extractAcpStatusText(update);
        if (text) this.eventQueue.enqueue({ type: 'thinking', text });
        return;
      }

      default: {
        if (updateKind) {
          this.debug(`Ignoring unsupported ACP session update kind: ${updateKind}`);
          return;
        }
        // Unkinded update with bare text — fall back to legacy text extraction
        // for older agents that pre-date the SessionUpdate discriminator.
        for (const text of extractAcpText(update ?? params)) {
          this.currentTurnText += text;
          this.eventQueue.enqueue({ type: 'text_delta', text });
        }
      }
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

    // Parse the spec shape first; tolerate the legacy command/toolName/...
    // payload by falling back to the bare-record reader when no spec
    // toolCall/options are present.
    const spec = parsePermissionRequestParams(message.params);
    const params = asRecord(message.params);
    const toolCallRecord = spec ? asRecord(spec.toolCall) : null;

    // Tool-call metadata: spec puts these on `toolCall.{title,rawInput,kind}`.
    const toolName = firstString(toolCallRecord, ['title', 'name', 'toolName'])
      ?? firstString(params, ['toolName', 'tool_name', 'tool'])
      ?? 'ACP Tool';
    const rawInput = asRecord(toolCallRecord?.rawInput) ?? asRecord(toolCallRecord?.input);
    const command = firstString(rawInput, ['command', 'cmd'])
      ?? firstString(params, ['command', 'cmd']);
    const description = firstString(toolCallRecord, ['description', 'title'])
      ?? firstString(params, ['description', 'message', 'reason'])
      ?? command
      ?? `${toolName} requests permission to continue`;
    const permissionType = command ? 'bash' : 'mcp_mutation';
    const reason = firstString(params, ['reason']);
    const options: PermissionOption[] = spec?.options ?? [];

    const permissionId = `acp-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const decision = await new Promise<{ allowed: boolean; alwaysAllow: boolean; optionId?: string }>((resolve) => {
      this.pendingPermissions.set(permissionId, { resolve, requestId: message.id!, options });
      this.onPermissionRequest?.({
        requestId: permissionId,
        toolName,
        command,
        description,
        type: permissionType,
        reason,
        options: options.length ? options : undefined,
      });
      // No callback configured (headless or test fixture) — auto-allow once.
      if (!this.onPermissionRequest) resolve({ allowed: true, alwaysAllow: false });
    });

    this.pendingPermissions.delete(permissionId);

    // Aborted mid-flight: respond with the spec `cancelled` outcome.
    if (this.abortReason) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { outcome: { outcome: 'cancelled' } },
      });
      return;
    }

    const optionId = options.length
      ? pickOptionId(options, decision.allowed, decision.alwaysAllow, decision.optionId)
      : null;

    if (options.length) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result: buildPermissionResponse(optionId),
      });
      return;
    }

    // Legacy / non-spec server: emit the historical { allowed, decision }
    // payload so we don't regress agents that didn't send an `options`
    // list. We deliberately do NOT fabricate an `optionId: 'allow'` here:
    // a strict spec-compliant server would reject it because no such
    // option was ever offered. The `outcome` field is also omitted so
    // the agent can choose the legacy or spec parser based on the keys
    // that are present.
    this.writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        allowed: decision.allowed,
        decision: decision.allowed ? 'accept' : 'decline',
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
    this.ndjson?.logOut(payload);
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
    this.resetSubprocessState({ clearSessionId: true });
  }

  /**
   * Reset subprocess-bound state so the next chat() can spawn fresh.
   *
   * @param clearSessionId When true (destroy/abort), forget the saved
   *   acpSessionId. When false (crash recovery), keep it so the next
   *   chat() can attempt session/load if the agent supports it.
   */
  private resetSubprocessState(options: { clearSessionId: boolean }): void {
    this.readline = null;
    this.subprocess = null;
    this.initialized = null;
    this.sessionEstablished = false;
    if (options.clearSessionId) this.acpSessionId = null;
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

  private extractStopReason(value: unknown): 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | null {
    if (!value || typeof value !== 'object') return null;
    const reason = (value as { stopReason?: unknown }).stopReason;
    if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'max_turn_requests' || reason === 'refusal' || reason === 'cancelled') {
      return reason;
    }
    return null;
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
