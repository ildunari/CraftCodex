/**
 * Backend capability flags used by session orchestration and renderer UI.
 *
 * Defaults are provider-level; command-backed agents may refine these later
 * from runtime metadata when their protocols expose it.
 */
export interface AgentBackendCapabilities {
  /** Whether the backend needs an HTTP MCP pool server bridge. */
  needsHttpPoolServer: boolean;
  /** Whether provider-native branch/fork context is supported. */
  supportsBranching: boolean;
  /** Whether backend emits normalized tool_start/tool_result events. */
  supportsToolEvents: boolean;
  /** Whether backend can surface MCP tool calls as Craft tool events. */
  supportsMcpToolEvents: boolean;
  /** Whether backend permission requests can be forwarded to Craft UI. */
  supportsPermissionForwarding: boolean;
  /** Whether an active turn can be cancelled/interrupted. */
  supportsCancellation: boolean;
  /** Whether an active turn can receive steering/redirect text. */
  supportsSteering: boolean;
  /** Whether model discovery can be attempted for this backend. */
  supportsModelDiscovery: boolean;
  /** Whether token/context usage updates can be emitted. */
  supportsUsageUpdates: boolean;
  /** Whether the backend has provider-native session resume identifiers. */
  supportsSessionResume: boolean;
  /** Whether the backend is launched from a local command. */
  isCommandBacked: boolean;
  /** Whether a connection test can initialize the backend command/protocol. */
  supportsHealthCheck: boolean;
}

export const CONSERVATIVE_BACKEND_CAPABILITIES: AgentBackendCapabilities = {
  needsHttpPoolServer: false,
  supportsBranching: false,
  supportsToolEvents: false,
  supportsMcpToolEvents: false,
  supportsPermissionForwarding: false,
  supportsCancellation: false,
  supportsSteering: false,
  supportsModelDiscovery: false,
  supportsUsageUpdates: false,
  supportsSessionResume: false,
  isCommandBacked: false,
  supportsHealthCheck: false,
};
