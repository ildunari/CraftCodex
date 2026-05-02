/**
 * Spec-typed shapes for the Agent Client Protocol (ACP).
 *
 * Mirrors `zed-industries/agent-client-protocol/main/schema/schema.json`.
 * These types describe what we *send to* and *receive from* an ACP server;
 * the surrounding `AcpAgent` adapts them to Craft's `AgentEvent` stream.
 */

export type SessionId = string;
export type PermissionOptionId = string;

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface SessionCapabilities {
  list?: unknown;
  resume?: unknown;
  close?: unknown;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface PromptResponse {
  stopReason: StopReason;
  _meta?: Record<string, unknown> | null;
}

export type SessionUpdateKind =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update';

export type ContentBlockType = 'text' | 'image' | 'audio' | 'resource' | 'resource_link';

export interface TextContentBlock {
  type: 'text';
  text: string;
  annotations?: Record<string, unknown> | null;
}

export interface ImageContentBlock {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string | null;
  annotations?: Record<string, unknown> | null;
}

export interface AudioContentBlock {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: Record<string, unknown> | null;
}

export interface ResourceContentBlock {
  type: 'resource';
  resource: Record<string, unknown>;
  annotations?: Record<string, unknown> | null;
}

export interface ResourceLinkContentBlock {
  type: 'resource_link';
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown> | null;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | AudioContentBlock
  | ResourceContentBlock
  | ResourceLinkContentBlock;

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: PermissionOptionId;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionParams {
  sessionId: SessionId;
  toolCall: {
    toolCallId?: string;
    title?: string;
    rawInput?: unknown;
    kind?: string;
    status?: string;
    [key: string]: unknown;
  };
  options: PermissionOption[];
  _meta?: Record<string, unknown> | null;
}

export type RequestPermissionResponse =
  | { outcome: { outcome: 'cancelled' } }
  | { outcome: { outcome: 'selected'; optionId: PermissionOptionId } };

export interface LoadSessionRequest {
  sessionId: SessionId;
  cwd: string;
  mcpServers: unknown[];
  _meta?: Record<string, unknown> | null;
}

export interface LoadSessionResponse {
  modes?: unknown;
  configOptions?: unknown[] | null;
  _meta?: Record<string, unknown> | null;
}

/**
 * Coerce a free-form agent-capabilities record into our typed shape with
 * strict per-field validation. We intentionally don't trust agents to send
 * the right types — `loadSession: 'yes'` would otherwise be truthy and
 * cause us to issue a `session/load` RPC that the agent doesn't support.
 *
 * Returns `null` when the input isn't a plain object.
 */
export function normalizeAgentCapabilities(value: unknown): AgentCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;

  const normalizePromptCaps = (raw: unknown): PromptCapabilities | undefined => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    const out: PromptCapabilities = {};
    if (typeof r.image === 'boolean') out.image = r.image;
    if (typeof r.audio === 'boolean') out.audio = r.audio;
    if (typeof r.embeddedContext === 'boolean') out.embeddedContext = r.embeddedContext;
    return out;
  };

  const normalizeMcpCaps = (raw: unknown): McpCapabilities | undefined => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    const out: McpCapabilities = {};
    if (typeof r.http === 'boolean') out.http = r.http;
    if (typeof r.sse === 'boolean') out.sse = r.sse;
    return out;
  };

  const out: AgentCapabilities = {};
  if (typeof root.loadSession === 'boolean') out.loadSession = root.loadSession;
  const promptCaps = normalizePromptCaps(root.promptCapabilities);
  if (promptCaps) out.promptCapabilities = promptCaps;
  const mcpCaps = normalizeMcpCaps(root.mcpCapabilities);
  if (mcpCaps) out.mcpCapabilities = mcpCaps;
  if (root.sessionCapabilities && typeof root.sessionCapabilities === 'object' && !Array.isArray(root.sessionCapabilities)) {
    out.sessionCapabilities = root.sessionCapabilities as SessionCapabilities;
  }
  return out;
}
