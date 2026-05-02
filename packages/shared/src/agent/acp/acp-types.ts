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
