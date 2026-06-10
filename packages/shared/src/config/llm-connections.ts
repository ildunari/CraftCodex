/**
 * LLM Connections
 *
 * Named provider configurations that users can add, configure, and switch between.
 * Each session locks to a specific connection after the first message.
 * Workspaces can set a default connection.
 */

// Import model types and lists from centralized registry
// NOTE: Pi SDK functions (getPiModelsForAuthProvider, getAllPiModels) are NOT imported
// here because @mariozechner/pi-ai transitively pulls in @aws-sdk which uses Node.js
// `stream` module — breaking the Vite renderer build. Instead, Pi model resolution is
// injected at app startup via registerPiModelResolver().
import {
  type ModelDefinition,
  ANTHROPIC_MODELS,
  getModelById,
  normalizeDeprecatedModelId,
} from './models';
import type { CredentialManager } from '../credentials/manager.ts';
import type { NativeCapabilityPolicy } from '../agent/backend/native-capabilities.ts';
import type { AgentCatalogId } from './agent-catalog.ts';

// ============================================================
// Pi Model Resolver (dependency injection to avoid Pi SDK in renderer)
// ============================================================

type PiModelResolver = (piAuthProvider?: string) => ModelDefinition[];
let _piModelResolver: PiModelResolver = () => [];

/**
 * Register the Pi model resolver function.
 * Must be called from main process at app startup (before any Pi connections are used).
 * This avoids pulling @mariozechner/pi-ai into the renderer bundle.
 */
export function registerPiModelResolver(resolver: PiModelResolver): void {
  _piModelResolver = resolver;
}

// ============================================================
// Types
// ============================================================

/**
 * Provider type determines which backend/SDK implementation to use.
 * This is separate from auth mechanism - a provider may support multiple auth types.
 *
 * - 'anthropic': Direct Anthropic API (api.anthropic.com)
 * - 'anthropic_compat': Anthropic-format compatible endpoints (OpenRouter, etc.)
 * - 'bedrock': AWS Bedrock (Claude models via AWS)
 * - 'vertex': Google Vertex AI (Claude models via GCP)
 * - 'pi': Pi unified LLM API (20+ providers via @mariozechner/pi-ai)
 * - 'pi_compat': Pi with custom endpoint (Ollama, self-hosted models)
 * - 'acp': Agent Client Protocol stdio bridge (Codex, Droid, or compatible gateways)
 * - 'codex': Native Codex app-server backend
 */
export type LlmProviderType =
  | 'anthropic'
  | 'anthropic_compat'
  | 'bedrock'
  | 'vertex'
  | 'pi'
  | 'pi_compat'
  | 'acp'
  | 'codex';

/**
 * @deprecated Use LlmProviderType instead. Kept for migration compatibility.
 */
export type LlmConnectionType = 'anthropic' | 'openai' | 'openai-compat';

/**
 * Authentication mechanism for the connection.
 * Determines the UI pattern, credential storage format, and how credentials are passed.
 *
 * Simple token auth:
 * - 'api_key': Single API key field, fixed endpoint known
 * - 'api_key_with_endpoint': API key + custom endpoint URL fields
 * - 'bearer_token': Single bearer token (different header than API key)
 *
 * OAuth flows (browser redirect):
 * - 'oauth': Browser OAuth flow, provider determined by providerType
 *
 * Cloud provider auth:
 * - 'iam_credentials': AWS-style (Access Key + Secret Key + Region)
 * - 'service_account_file': GCP-style JSON file upload
 * - 'environment': Auto-detect from environment variables
 *
 * No auth:
 * - 'none': No authentication required (local models like Ollama)
 */
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'iam_credentials'
  | 'bearer_token'
  | 'service_account_file'
  | 'environment'
  | 'none';

/**
 * Ownership mode for a connection's model list.
 * - automaticallySyncedFromProvider: provider defaults are synced automatically.
 * - userDefined3Tier: user-picked Best/Balanced/Fast list is preserved.
 */
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';

/**
 * Protocol for custom API endpoints.
 * Determines which streaming adapter the Pi SDK uses for requests.
 */
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/**
 * Custom endpoint protocol config.
 * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
 */
export interface CustomEndpointConfig {
  api: CustomEndpointApi;
  supportsImages?: boolean;
}

/**
 * Per-connection behavior when the user sends a message while the agent is
 * still streaming/processing a previous turn.
 *
 * - 'steer': Try to deliver the message into the in-flight turn (Pi's native
 *   `.steer()` or Claude's PreToolUse `additionalContext` hook). Falls back to
 *   abort+queue when the backend can't steer.
 * - 'queue': Hold the message; let the current turn finish naturally; replay
 *   as a new turn afterwards. No abort, no destructive interruption.
 *
 * Default is per-`providerType` via {@link defaultMidStreamBehavior}; reads
 * everywhere should go through {@link resolveMidStreamBehavior} so connections
 * created before this field existed still pick up the right default.
 */
export type MidStreamBehavior = 'steer' | 'queue';

/**
 * LLM Connection configuration.
 * Stored in config.llmConnections array.
 */
export interface LlmConnection {
  /** URL-safe identifier (e.g., 'anthropic-api', 'ollama-local') */
  slug: string;

  /** Display name shown in UI (e.g., 'Anthropic (API Key)', 'Ollama') */
  name: string;

  /** Provider type determines backend/SDK implementation */
  providerType: LlmProviderType;

  /** Curated first-party agent identity. ACP remains an internal transport. */
  agentId?: AgentCatalogId;

  /**
   * @deprecated Use providerType instead. Kept for migration compatibility.
   * Will be removed in a future version.
   */
  type?: LlmConnectionType;

  /** Custom base URL (required for *_compat providers, optional override for others) */
  baseUrl?: string;

  /** Authentication mechanism */
  authType: LlmAuthType;

  /** Override available models (for custom endpoints that don't support model listing) */
  models?: Array<ModelDefinition | string>;

  /** Default model for this connection */
  defaultModel?: string;

  /**
   * Ownership mode for the model list.
   * - automaticallySyncedFromProvider: provider defaults are kept in sync.
   * - userDefined3Tier: preserve user-selected Best/Balanced/Fast list.
   */
  modelSelectionMode?: ModelSelectionMode;

  /**
   * Pi auth provider name (e.g., 'anthropic', 'openai', 'github-copilot').
   * Determines which provider credential Pi SDK uses for LLM calls.
   * Only relevant for 'pi' providerType connections.
   */
  piAuthProvider?: string;

  /**
   * Custom endpoint protocol config.
   * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
   * Determines which streaming adapter the Pi SDK uses for requests.
   */
  customEndpoint?: CustomEndpointConfig;

  /**
   * Command used for ACP stdio bridges. Examples:
   *   - "codex"
   *   - "droid"
   *   - "agent-proxy"
   */
  acpCommand?: string;

  /**
   * Arguments passed to acpCommand. For Droid's direct ACP mode this is
   * ["exec", "--output-format", "acp"]. The optional local agent-proxy bridge
   * commonly uses ["acp", "--agent", "codex"] or ["acp", "--agent", "droid"].
   */
  acpArgs?: string[];

  /**
   * Command used for native Codex app-server backends. Defaults to "codex".
   */
  codexCommand?: string;

  /**
   * Arguments passed to codexCommand. Defaults to ["app-server", "--listen", "stdio://"].
   */
  codexArgs?: string[];

  /**
   * Policy for inheriting native capabilities from command-backed agents.
   * Craft remains authoritative by default and native-only capabilities pass through.
   */
  nativeCapabilityPolicy?: Partial<NativeCapabilityPolicy>;

  // --- Cloud provider specific fields ---

  /** AWS region (for 'bedrock' provider) */
  awsRegion?: string;

  /** GCP project ID (for 'vertex' provider) */
  gcpProjectId?: string;

  /** GCP region (for 'vertex' provider, e.g., 'us-central1') */
  gcpRegion?: string;

  /**
   * Behavior when the user sends a message while the agent is still streaming.
   * Optional for backward compat with config.json from before this field existed —
   * read via {@link resolveMidStreamBehavior} which falls back to a per-provider
   * default ({@link defaultMidStreamBehavior}).
   */
  midStreamBehavior?: MidStreamBehavior;

  // --- Resolved Anthropic OAuth identity (issue #838) ---
  // Captured from the token-exchange response; lets the UI flag two Claude
  // connections that resolve to the same underlying account. All optional and
  // fail-soft — absent identity simply means nothing is shown.
  oauthAccountUuid?: string;
  oauthAccountEmail?: string;
  oauthOrganizationUuid?: string;
  oauthOrganizationName?: string;
  oauthProfileVerifiedAt?: number; // epoch ms

  // --- Timestamps ---

  /** Timestamp when connection was created */
  createdAt: number;

  /** Timestamp when connection was last used */
  lastUsedAt?: number;
}

/**
 * LLM Connection with authentication status.
 * Used by UI to show which connections are ready to use.
 */
export interface LlmConnectionWithStatus extends LlmConnection {
  /** Whether the connection has valid credentials */
  isAuthenticated: boolean;

  /** Error message if authentication check failed */
  authError?: string;

  /** Runtime/install readiness for curated command-backed agents */
  agentStatus?: 'ready' | 'needs_setup' | 'not_installed' | 'broken';

  /** Whether this is the global default connection */
  isDefault?: boolean;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Get the mini/utility model ID for a connection.
 * Provider-aware search:
 *   - Anthropic (incl. bedrock/vertex): find any model with "haiku" in its id/name
 *   - OpenAI: find any model with "mini" in its id/name
 *   - Otherwise: last model in the list
 *
 * Used for mini agent, title generation, and mini completions.
 *
 * @param connection - LLM connection (or partial with models + providerType)
 * @returns Model ID string, or undefined if no models available
 */
export function getMiniModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * Returns true if the model ID should never be used as a mini/utility model
 * for the given auth provider.
 *
 * Currently denies:
 *   - `codex-mini-latest` for any provider (the Codex CLI bundles it but it
 *     isn't usable as a generic mini model — it's tuned for code review and
 *     refuses arbitrary completions).
 *   - `*codex-mini*` under `openai-codex` (ChatGPT-account auth) because
 *     ChatGPT-account access for OpenAI's Codex models is gated separately
 *     from API-key access and we can't predict which the user has.
 *
 * Re-exported by `pi-agent-server/src/model-resolution.ts` as the single
 * source of truth used both at registration time and selection time.
 */
export function isDeniedMiniModelId(modelId: string, piAuthProvider?: string): boolean {
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  if (bare === 'codex-mini-latest') return true;
  if (piAuthProvider === 'openai-codex' && bare.includes('codex-mini')) return true;
  return false;
}

/**
 * Get the summarization model ID for a connection.
 * Same provider-aware logic as getMiniModel(), but separate
 * so summarization and mini agent models can diverge independently.
 *
 * Used for response summarization and API tool summarization.
 *
 * @param connection - LLM connection (or partial with models + providerType)
 * @returns Model ID string, or undefined if no models available
 */
export function getSummarizationModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * Provider-aware small model resolution.
 * Shared implementation for getMiniModel() and getSummarizationModel().
 *
 *   - Anthropic (incl. bedrock/vertex/compat): find "haiku"
 *   - Pi: find "mini" or "flash"
 *   - Otherwise: last model in the list
 */
function findSmallModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;

  const toId = (m: ModelDefinition | string) => typeof m === 'string' ? m : m.id;

  const toSearchStr = (m: ModelDefinition | string) =>
    typeof m === 'string' ? m.toLowerCase() : `${m.id} ${m.name} ${m.shortName}`.toLowerCase();

  const isAllowedModel = (m: ModelDefinition | string): boolean =>
    !isDeniedMiniModelId(toId(m), connection.piAuthProvider);

  // Provider-aware keyword search
  const keywords: string[] = [];

  if (isAnthropicProvider(connection.providerType)) {
    keywords.push('haiku');
  } else if (isPiProvider(connection.providerType)) {
    keywords.push('mini', 'flash');
  } else {
    // Aggregator providers (copilot, etc.) — try all common small-model keywords
    keywords.push('mini', 'haiku', 'flash');
  }

  if (keywords.length > 0) {
    const match = connection.models.find(m => {
      if (!isAllowedModel(m)) return false;
      const searchStr = toSearchStr(m);
      return keywords.some(k => searchStr.includes(k));
    });
    if (match) {
      return toId(match);
    }
  }

  // Fallback: last allowed model in the list, otherwise final entry.
  const fallback = [...connection.models].reverse().find(isAllowedModel);
  return fallback ? toId(fallback) : toId(connection.models[connection.models.length - 1]!);
}

/**
 * Generate a URL-safe slug from a display name.
 * @param name - Display name to convert
 * @returns URL-safe slug
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a slug is valid (URL-safe, non-empty).
 * @param slug - Slug to validate
 * @returns true if valid
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

/**
 * Get credential key for an LLM connection.
 * Format: llm::{slug}::{credentialType}
 *
 * @param slug - Connection slug
 * @param credentialType - Type of credential ('api_key' or 'oauth_token')
 * @returns Credential key string
 */
export function getLlmCredentialKey(slug: string, credentialType: 'api_key' | 'oauth_token'): string {
  return `llm::${slug}::${credentialType}`;
}

/**
 * Credential storage type for each auth mechanism.
 */
export type LlmCredentialStorageType =
  | 'api_key'           // Single token stored as value
  | 'oauth_token'       // OAuth tokens (access, refresh, expiry)
  | 'iam_credentials'   // AWS-style (accessKeyId, secretAccessKey, region)
  | 'service_account'   // JSON file contents
  | null;               // No storage needed (environment or none)

/**
 * Map LlmAuthType to credential storage type.
 * Determines how credentials are stored in the credential manager.
 *
 * @param authType - LLM auth type
 * @returns Credential storage type or null if no credential storage needed
 */
export function authTypeToCredentialStorageType(authType: LlmAuthType): LlmCredentialStorageType {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
      return 'api_key';
    case 'oauth':
      return 'oauth_token';
    case 'iam_credentials':
      return 'iam_credentials';
    case 'service_account_file':
      return 'service_account';
    case 'environment':
    case 'none':
      return null;
  }
}

/**
 * @deprecated Use authTypeToCredentialStorageType instead.
 * Kept for backwards compatibility during migration.
 */
export function authTypeToCredentialType(authType: LlmAuthType): 'api_key' | 'oauth_token' | null {
  const storageType = authTypeToCredentialStorageType(authType);
  if (storageType === 'api_key' || storageType === 'oauth_token') {
    return storageType;
  }
  return null;
}

/**
 * Check if an auth type requires a custom endpoint URL.
 * @param authType - LLM auth type
 * @returns true if endpoint URL field should be shown in UI
 */
export function authTypeRequiresEndpoint(authType: LlmAuthType): boolean {
  return authType === 'api_key_with_endpoint';
}

/**
 * Check if a provider type is a "compat" provider.
 * Compat providers use custom endpoints and require explicit model lists.
 * @param providerType - Provider type to check
 * @returns true if this is a compat provider (anthropic_compat or pi_compat)
 */
export function isCompatProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic_compat' || providerType === 'pi_compat';
}

/**
 * Check if a provider type uses Anthropic models (Claude).
 * Includes direct Anthropic, compat endpoints, and cloud providers (Bedrock, Vertex).
 * @param providerType - Provider type to check
 * @returns true if this provider uses Anthropic/Claude models
 */
export function isAnthropicProvider(providerType: LlmProviderType): boolean {
  return (
    providerType === 'anthropic' ||
    providerType === 'anthropic_compat' ||
    providerType === 'bedrock' ||
    providerType === 'vertex'
  );
}


/**
 * Check if a provider type uses Pi unified API.
 * @param providerType - Provider type to check
 * @returns true if this provider uses Pi
 */
export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi' || providerType === 'pi_compat';
}

/**
 * Check if a provider type speaks Agent Client Protocol over stdio.
 * @param providerType - Provider type to check
 * @returns true if this provider uses ACP
 */
export function isAcpProvider(providerType: LlmProviderType): boolean {
  return providerType === 'acp';
}

/**
 * Check if a provider type uses native Codex app-server.
 * @param providerType - Provider type to check
 * @returns true if this provider uses Codex app-server
 */
export function isCodexProvider(providerType: LlmProviderType): boolean {
  return providerType === 'codex';
}

/**
 * Default mid-stream send behavior for a given provider type.
 *
 * - 'anthropic' → 'queue': Claude's emulated steer (PreToolUse hook injection)
 *   has a real failure mode — if no tool fires before the turn ends, the steer
 *   becomes `steer_undelivered` and gets re-queued anyway, paying for the
 *   original turn's tokens for nothing. Default to queue for predictability.
 * - 'pi' / 'pi_compat' → 'steer': Pi's native `.steer()` is non-destructive
 *   (delivers after the current tool finishes, keeps full context). No
 *   downside to defaulting to immediate steering.
 */
export function defaultMidStreamBehavior(providerType: LlmProviderType): MidStreamBehavior {
  return providerType === 'anthropic' ? 'queue' : 'steer';
}

/**
 * Read the effective mid-stream behavior for a connection.
 *
 * Single source of truth — every call site that needs to decide steer-vs-queue
 * should go through here so legacy connections (created before the field
 * existed) and connections with corrupt/unexpected values fall through to the
 * provider-appropriate default.
 */
export function resolveMidStreamBehavior(
  connection: Pick<LlmConnection, 'midStreamBehavior' | 'providerType'>,
): MidStreamBehavior {
  if (connection.midStreamBehavior === 'steer' || connection.midStreamBehavior === 'queue') {
    return connection.midStreamBehavior;
  }
  return defaultMidStreamBehavior(connection.providerType);
}

/**
 * Return a new LlmConnection with the given model's `supportsImages` override set.
 *
 * Centralizes the string-vs-object normalization for `connection.models[]`:
 *   - string entry → promoted to `{ id, name, shortName, supportsImages: enabled }`
 *   - object entry → only `supportsImages` is updated
 *   - model not in array → connection returned unchanged (defensive)
 *
 * Pure function — does not mutate the input. Storage round-trip is handled
 * upstream via `saveLlmConnection`. The stored object form for custom-endpoint
 * models is `{ id, name?, shortName?, contextWindow?, supportsImages? }`
 * (passthrough-validated by the storage schema). `name` and `shortName` default
 * to the model's `id` when promoting so that downstream renderer surfaces that
 * read `m.name` (the trigger button display, picker row labels) keep showing a
 * label after the toggle promotes a string entry. The `ModelDefinition` cast
 * matches the existing shape produced by `ApiKeyInput.tsx` and the Pi driver.
 */
export function setModelSupportsImages(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
): LlmConnection {
  if (!connection.models) return connection;
  const idOf = (m: ModelDefinition | string) => (typeof m === 'string' ? m : m.id);
  const idx = connection.models.findIndex(m => idOf(m) === modelId);
  if (idx === -1) return connection;

  const entry = connection.models[idx]!;
  const nextEntry =
    typeof entry === 'string'
      ? { id: entry, name: entry, shortName: entry, supportsImages: enabled }
      : { ...entry, supportsImages: enabled };

  const nextModels = connection.models.slice();
  nextModels[idx] = nextEntry as ModelDefinition;
  return { ...connection, models: nextModels };
}

/**
 * Resolve whether a given model on a connection accepts image input.
 *
 * For `pi_compat` (custom-endpoint) connections this mirrors the precedence used
 * by Pi's `buildCustomEndpointModelDef`:
 *   per-model `supportsImages` override
 *   ?? connection-level `customEndpoint.supportsImages` default
 *   ?? false
 *
 * For non-`pi_compat` connections the renderer doesn't own the catalog — Pi SDK's
 * bundled provider definitions and Anthropic's API do. This helper conservatively
 * returns `true` there (we don't know better; the upstream decides). The
 * pre-flight banner gates on `pi_compat` separately, so this just reports what
 * the renderer can know with confidence.
 */
export function modelSupportsImages(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'customEndpoint'>,
  modelId: string,
): boolean {
  if (!isCompatProvider(connection.providerType)) return true;

  const entry = connection.models?.find(m =>
    (typeof m === 'string' ? m : m.id) === modelId,
  );
  if (entry && typeof entry !== 'string' && typeof entry.supportsImages === 'boolean') {
    return entry.supportsImages;
  }
  return connection.customEndpoint?.supportsImages ?? false;
}

/**
 * Get the default model list for a provider type from the registry.
 * For *_compat providers, returns empty array - those should use connection.models instead.
 *
 * @param providerType - Provider type
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Model list from registry, or empty array for compat providers
 */
export function getModelsForProviderType(providerType: LlmProviderType, piAuthProvider?: string): ModelDefinition[] {
  // Compat providers require explicit model lists from the connection
  if (isCompatProvider(providerType)) {
    return [];
  }

  // Pi: fetch models via registered resolver (avoids Pi SDK import in renderer)
  if (providerType === 'pi') {
    return _piModelResolver(piAuthProvider);
  }

  // ACP backends are command/gateway driven; models are declared on the connection.
  if (providerType === 'acp') {
    return [];
  }

  if (providerType === 'codex') {
    return [];
  }

  // Anthropic, Bedrock, Vertex use Claude models with bare Anthropic IDs.
  // Note: providerType==='bedrock' goes through ClaudeAgent → Anthropic API,
  // which requires bare IDs. Pi+amazon-bedrock goes through PiAgent and
  // gets Bedrock-native IDs via the Pi SDK model resolver.
  return ANTHROPIC_MODELS;
}

/**
 * Get the default model list for a connection's provider type.
 * Unlike getModelsForProviderType(), this handles compat providers by returning
 * the appropriate compat-prefixed model IDs instead of an empty array.
 *
 * Use this whenever you need to populate or backfill a connection's models.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model list (ModelDefinition[] for standard, string[] for compat)
 */
/**
 * Preferred default model IDs per Pi auth provider.
 * The Pi SDK returns models in arbitrary order (alphabetical by ID), which means
 * deprecated models like claude-3-5-haiku-20241022 can end up first.
 * This map ensures getDefaultModelForConnection() picks a modern, capable model.
 *
 * Format: bare model IDs (without pi/ prefix). Matched against pi/{id} or pi/{id}-*.
 */
export const PI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  'openai-codex': ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // Stable models first so the connection-setup test (which uses
  // getDefaultModelForConnection) lands on a reliable model.
  // gemini-3-pro-preview and gemini-3.1-pro-preview are intermittently
  // unresponsive on generateContent — verified against the live API in
  // April 2026 — and are deliberately excluded from defaults.
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'github-copilot': ['claude-sonnet-4-6', 'gpt-5', 'o4-mini', 'claude-haiku-4-5'],
  'amazon-bedrock': ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};

export function getDefaultModelsForConnection(providerType: LlmProviderType, piAuthProvider?: string): Array<ModelDefinition | string> {
  if (providerType === 'pi') {
    const models = _piModelResolver(piAuthProvider);
    // Sort preferred defaults first so getDefaultModelForConnection picks a modern model.
    // For Bedrock models, the Pi SDK returns IDs like pi/us.anthropic.claude-opus-4-8
    // but preferred defaults use bare IDs (claude-opus-4-8). We match via both direct
    // comparison and reverse Bedrock ID mapping.
    const preferred = (piAuthProvider && PI_PREFERRED_DEFAULTS[piAuthProvider]) || [];
    if (preferred.length > 0) {
      const findPreferredIndex = (id: string): number => {
        const bare = id.startsWith('pi/') ? id.slice(3) : id
        const direct = preferred.findIndex(p => bare === p || bare.startsWith(`${p}-`))
        if (direct >= 0) return direct
        const reversed = fromBedrockNativeId(bare)
        if (reversed !== bare) {
          return preferred.findIndex(p => reversed === p || reversed.startsWith(`${p}-`))
        }
        return -1
      }

      models.sort((a, b) => {
        const aIdx = findPreferredIndex(a.id);
        const bIdx = findPreferredIndex(b.id);
        const aPrio = aIdx >= 0 ? aIdx : preferred.length;
        const bPrio = bIdx >= 0 ? bIdx : preferred.length;
        return aPrio - bPrio;
      });
    }
    return models;
  }
  if (providerType === 'pi_compat') return [];  // Dynamic — user specifies
  if (providerType === 'anthropic_compat') return [];  // Dynamic — user specifies
  if (providerType === 'acp') return [];  // Dynamic — command/gateway specifies
  if (providerType === 'codex') return [{ id: 'gpt-5.5', name: 'GPT-5.5', shortName: 'GPT-5.5', description: 'Codex app-server default model', provider: 'codex', contextWindow: 272_000 }];
  // anthropic, bedrock, vertex
  return ANTHROPIC_MODELS;
}

/**
 * Get the model list a specific connection can expose to users.
 *
 * Priority:
 * 1. The connection's explicit model list, usually refreshed from the backend.
 * 2. Provider defaults for static providers such as Claude/Pi/Codex.
 * 3. A configured connection default model for fixed custom/agent endpoints.
 */
export function getAvailableModelsForConnection(connection: LlmConnection): Array<ModelDefinition | string> {
  if (connection.models && connection.models.length > 0) return connection.models;

  const defaults = getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
  if (defaults.length > 0) return defaults;

  if (connection.defaultModel) return [connection.defaultModel];

  return [];
}

export function getModelIdFromEntry(model: ModelDefinition | string): string {
  return typeof model === 'string' ? model : model.id;
}

/**
 * Validate that a model belongs to the selected agent connection.
 * Dynamic agent connections such as ACP must declare or discover models before
 * arbitrary model IDs are accepted.
 */
export function isModelAvailableForConnection(connection: LlmConnection, model: string | null | undefined): boolean {
  if (!model) return true;
  return getAvailableModelsForConnection(connection).some((entry) => getModelIdFromEntry(entry) === model);
}

/**
 * Get the default model ID for a connection's provider type.
 * Derived from the first entry in getDefaultModelsForConnection() — single source of truth.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model ID string
 */
export function getDefaultModelForConnection(providerType: LlmProviderType, piAuthProvider?: string): string {
  const models = getDefaultModelsForConnection(providerType, piAuthProvider);
  const first = models[0];
  if (!first) return '';  // Dynamic provider — no default
  return typeof first === 'string' ? first : first.id;
}

/**
 * Resolve full model metadata for a model ID within the context of a connection.
 *
 * Why this exists:
 * - Built-in Claude models live in MODEL_REGISTRY
 * - Compat/custom endpoint models often exist only in connection.models
 * - UI and backend logic (context window, thinking support) need a single lookup path
 *   that prefers connection-specific metadata but still falls back to known registry data.
 */
export function getModelDefinitionForConnection(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  modelId: string,
): ModelDefinition | undefined {
  const connectionModel = connection?.models?.find(m => (typeof m === 'string' ? m : m.id) === modelId)

  if (connectionModel && typeof connectionModel !== 'string') {
    const registryModel = getModelById(modelId)
    return {
      ...(registryModel ?? {
        id: connectionModel.id,
        name: connectionModel.name || connectionModel.id,
        shortName: connectionModel.shortName || connectionModel.name || connectionModel.id,
        description: connectionModel.description || '',
        provider: connectionModel.provider || 'anthropic',
        contextWindow: connectionModel.contextWindow,
      }),
      ...connectionModel,
    }
  }

  return getModelById(modelId)
}

/**
 * Resolve context window using connection-specific metadata first, then global registry fallback.
 */
export function getConnectionModelContextWindow(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  modelId: string,
): number | undefined {
  return getModelDefinitionForConnection(connection, modelId)?.contextWindow
}

/**
 * Resolve whether a model supports thinking/reasoning.
 * Returns undefined when no explicit metadata is available.
 */
export function getConnectionModelSupportsThinking(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  modelId: string,
): boolean | undefined {
  return getModelDefinitionForConnection(connection, modelId)?.supportsThinking
}

/**
 * Resolve the effective LLM connection slug from available fallbacks.
 *
 * Single source of truth for the fallback chain used everywhere in the UI:
 *   1. Explicit session connection (locked after first message)
 *   2. Workspace-level default override
 *   3. Global default (isDefault flag on a connection)
 *   4. First available connection
 *
 * @param sessionConnection  - Per-session connection slug (session.llmConnection)
 * @param workspaceDefault   - Workspace-level default connection slug
 * @param connections        - All available connections (with status metadata)
 * @returns The resolved slug, or undefined when no connections exist
 */
export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  return sessionConnection
    ?? workspaceDefault
    ?? connections.find(c => c.isDefault)?.slug
    ?? connections[0]?.slug
}

/**
 * Check if a session's locked connection is unavailable (deleted/removed).
 * Returns true only when a session has an explicit llmConnection that doesn't
 * match any current connection. Sessions without a stored connection (using
 * the fallback chain) are never "unavailable".
 *
 * @param sessionConnection - Per-session connection slug (session.llmConnection)
 * @param connections - All available connections
 * @returns true if the session's connection no longer exists
 */
export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false
  return !connections.some(c => c.slug === sessionConnection)
}

/**
 * Check if an auth type uses browser OAuth flow.
 * @param authType - LLM auth type
 * @returns true if OAuth browser flow should be triggered
 */
export function authTypeIsOAuth(authType: LlmAuthType): boolean {
  return authType === 'oauth';
}

/**
 * Check if a provider supports a given auth type.
 * Returns valid combinations for the type system.
 *
 * @param providerType - Provider type
 * @param authType - Auth type to check
 * @returns true if this is a valid combination
 */
export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType
): boolean {
  const validCombinations: Record<LlmProviderType, LlmAuthType[]> = {
    anthropic: ['api_key', 'oauth'],
    anthropic_compat: ['api_key_with_endpoint'],
    bedrock: ['bearer_token', 'iam_credentials', 'environment'],
    vertex: ['oauth', 'service_account_file', 'environment'],
    pi: ['api_key', 'oauth', 'none'],
    pi_compat: ['api_key_with_endpoint', 'none'],
    acp: ['none'],
    codex: ['none'],
  };

  return validCombinations[providerType]?.includes(authType) ?? false;
}

/**
 * Maps bare Anthropic model IDs → Bedrock cross-region inference profile IDs.
 * Uses US inference profiles (us.*) — required for on-demand throughput with
 * newer Claude models. Direct model IDs (anthropic.claude-*) are rejected
 * by Bedrock with "Retry your request with the ID or ARN of an inference profile".
 *
 * Source: Pi SDK registry (models.generated.js) — us.* variants
 */
const BEDROCK_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  'claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  'claude-fable-5': 'us.anthropic.claude-fable-5',
  'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Older models (for migration of existing connections)
  'claude-opus-4-5-20251101': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  // Also map base IDs (without region prefix) to US inference profiles
  'anthropic.claude-opus-4-8': 'us.anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7': 'us.anthropic.claude-opus-4-7',
  'anthropic.claude-fable-5': 'us.anthropic.claude-fable-5',
  'anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
}

/** Reverse map: all known Bedrock ID variants → bare Anthropic ID */
const BEDROCK_REVERSE_MAP: Record<string, string> = {
  // US inference profiles
  'us.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'us.anthropic.claude-fable-5': 'claude-fable-5',
  'us.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'us.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'us.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // EU inference profiles
  'eu.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'eu.anthropic.claude-fable-5': 'claude-fable-5',
  'eu.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'eu.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'eu.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // Global inference profiles
  'global.anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'global.anthropic.claude-fable-5': 'claude-fable-5',
  'global.anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'global.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'global.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  // Base IDs (no region prefix)
  'anthropic.claude-opus-4-8': 'claude-opus-4-8',
  'anthropic.claude-fable-5': 'claude-fable-5',
  'anthropic.claude-opus-4-7': 'claude-opus-4-7',
  'anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
}

/**
 * Derive the Bedrock inference profile region prefix from an AWS region string.
 * Returns 'us', 'eu', or 'us' (default fallback for regions without inference profiles).
 */
export function deriveBedrockRegionPrefix(awsRegion?: string): string {
  if (!awsRegion) return 'us'
  if (awsRegion.startsWith('eu-')) return 'eu'
  // US regions and all others (ap-*, me-*, etc.) use US inference profiles
  return 'us'
}

/**
 * Map a bare Anthropic model ID to its Bedrock-native equivalent.
 * Uses the specified region prefix (default: 'us') for inference profile IDs.
 * Pass-through if already native or unknown.
 */
export function toBedrockNativeId(modelId: string, regionPrefix?: string): string {
  const normalizedModelId = normalizeDeprecatedModelId(modelId)
  const nativeId = BEDROCK_MODEL_MAP[normalizedModelId]
  if (!nativeId) return normalizedModelId
  if (!regionPrefix || regionPrefix === 'us') return nativeId
  // BEDROCK_MODEL_MAP stores us.* variants — swap the region prefix
  return nativeId.replace(/^us\./, `${regionPrefix}.`)
}

/** Map a Bedrock-native model ID back to its bare Anthropic equivalent. Pass-through if already bare or unknown. */
export function fromBedrockNativeId(modelId: string): string {
  const normalizedModelId = normalizeDeprecatedModelId(modelId)
  return BEDROCK_REVERSE_MAP[normalizedModelId] ?? normalizedModelId
}

/**
 * Normalize a model ID for Bedrock storage/usage.
 * Strips pi/ prefix and maps bare Anthropic IDs to Bedrock-native format.
 * Idempotent — already-native IDs pass through unchanged.
 */
export function normalizeBedrockModelId(
  modelId: string | undefined,
  regionPrefix?: string,
): string {
  if (!modelId) return '';
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId
  return toBedrockNativeId(bare, regionPrefix)
}

// ============================================================
// Migration Helpers
// ============================================================

/**
 * Migrate legacy connection type to new provider type.
 * Used during config migration.
 *
 * @param legacyType - Legacy LlmConnectionType value
 * @returns New LlmProviderType value
 */
export function migrateConnectionType(legacyType: LlmConnectionType): LlmProviderType {
  switch (legacyType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'pi';
    case 'openai-compat':
      return 'pi_compat';
  }
}

/**
 * Migrate legacy auth type to new auth type.
 * Determines new auth type based on legacy type + connection context.
 *
 * @param legacyAuthType - Legacy auth type ('api_key' | 'oauth' | 'none')
 * @param hasCustomEndpoint - Whether connection has a custom baseUrl
 * @returns New LlmAuthType value
 */
export function migrateAuthType(
  legacyAuthType: 'api_key' | 'oauth' | 'none',
  hasCustomEndpoint: boolean
): LlmAuthType {
  switch (legacyAuthType) {
    case 'api_key':
      // If has custom endpoint, use api_key_with_endpoint
      return hasCustomEndpoint ? 'api_key_with_endpoint' : 'api_key';
    case 'oauth':
      return 'oauth';
    case 'none':
      return 'none';
  }
}

// ============================================================
// Auth Environment Variable Resolution
// ============================================================

const CLAUDE_BEDROCK_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
] as const

const CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET = new Set<string>(
  CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
)

const MANAGED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

function getRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined
  }
  return process.env[key]
}

const MANAGED_ANTHROPIC_AUTH_ENV_BASELINE: Record<string, string | undefined> =
  Object.fromEntries(
    MANAGED_ANTHROPIC_AUTH_ENV_KEYS.map((key) => [
      key,
      CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET.has(key)
        ? undefined
        : getRuntimeEnvValue(key),
    ]),
  )

export function clearClaudeBedrockRoutingEnvVars(
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  for (const key of CLAUDE_BEDROCK_ROUTING_ENV_KEYS) {
    delete targetEnv[key]
  }
}

export function resetManagedAnthropicAuthEnvVars(): void {
  if (typeof process === 'undefined' || !process?.env) {
    return
  }

  for (const key of MANAGED_ANTHROPIC_AUTH_ENV_KEYS) {
    const originalValue = MANAGED_ANTHROPIC_AUTH_ENV_BASELINE[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

/**
 * Result of resolving auth env vars for an LLM connection.
 */
export interface ResolvedAuthEnvVars {
  /** Environment variables to set (e.g., ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) */
  envVars: Record<string, string>;
  /** Whether credentials were successfully resolved */
  success: boolean;
  /** Warning message if auth resolution encountered issues */
  warning?: string;
}

/**
 * Resolve authentication environment variables for an LLM connection.
 *
 * Provider-agnostic: switches on providerType to determine which env vars
 * to set and how to retrieve credentials. Shared by:
 * - `SessionManager.reinitializeAuth()` (applies to process.env)
 * - `ClaudeAgent.postInit()` (applies to process.env + envOverrides)
 *
 * Providers that handle auth internally (openai, copilot, pi) return
 * empty envVars — their auth is managed in postInit() via native mechanisms.
 *
 * @param connection - The LLM connection config
 * @param connectionSlug - Connection slug for credential lookup
 * @param credentialManager - Credential manager instance
 * @param getValidOAuthToken - Function to get a valid (refreshed) OAuth token
 * @returns Resolved env vars and status
 */
export async function resolveAuthEnvVars(
  connection: LlmConnection,
  connectionSlug: string,
  credentialManager: CredentialManager,
  getValidOAuthToken: (slug: string) => Promise<{ accessToken?: string | null }>,
): Promise<ResolvedAuthEnvVars> {
  const envVars: Record<string, string> = {};

  // Only Anthropic-SDK-based providers use env var auth
  // OpenAI (Codex), Copilot, and Pi handle auth internally in their postInit()
  if (!isAnthropicProvider(connection.providerType)) {
    return { envVars, success: true };
  }

  if (connection.providerType === 'bedrock') {
    // Bedrock is handled by the Pi SDK in product architecture.
    // Do not enable Claude SDK Bedrock routing here.

    if (connection.baseUrl) {
      envVars.ANTHROPIC_BEDROCK_BASE_URL = connection.baseUrl
    }

    const configuredRegion =
      connection.awsRegion ||
      getRuntimeEnvValue('AWS_REGION') ||
      getRuntimeEnvValue('AWS_DEFAULT_REGION')
    if (!configuredRegion) {
      return {
        envVars,
        success: false,
        warning: `No AWS region found for Bedrock connection: ${connectionSlug}`,
      }
    }

    envVars.AWS_REGION = configuredRegion

    if (connection.authType === 'bearer_token') {
      const bearerToken = await credentialManager.getLlmApiKey(connectionSlug)
      if (!bearerToken) {
        return {
          envVars,
          success: false,
          warning: `No Bedrock bearer token found for: ${connectionSlug}`,
        }
      }

      envVars.AWS_BEARER_TOKEN_BEDROCK = bearerToken
      return { envVars, success: true }
    }

    if (connection.authType === 'iam_credentials') {
      const iamCredentials =
        await credentialManager.getLlmIamCredentials(connectionSlug)
      if (!iamCredentials?.accessKeyId || !iamCredentials.secretAccessKey) {
        return {
          envVars,
          success: false,
          warning: `No IAM credentials found for: ${connectionSlug}`,
        }
      }

      envVars.AWS_ACCESS_KEY_ID = iamCredentials.accessKeyId
      envVars.AWS_SECRET_ACCESS_KEY = iamCredentials.secretAccessKey
      if (iamCredentials.sessionToken) {
        envVars.AWS_SESSION_TOKEN = iamCredentials.sessionToken
      }
      envVars.AWS_REGION = iamCredentials.region || configuredRegion

      return { envVars, success: true }
    }

    if (connection.authType === 'environment') {
      return { envVars, success: true }
    }

    return {
      envVars,
      success: false,
      warning: `Unsupported Bedrock auth type: ${connection.authType}`,
    }
  }

  // Set base URL if configured
  if (connection.baseUrl) {
    envVars.ANTHROPIC_BASE_URL = connection.baseUrl;
  }

  const authType = connection.authType;

  if (authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token') {
    const apiKey = await credentialManager.getLlmApiKey(connectionSlug);
    if (apiKey) {
      envVars.ANTHROPIC_API_KEY = apiKey;
    } else if (connection.baseUrl) {
      // Keyless provider (e.g. Ollama)
      envVars.ANTHROPIC_API_KEY = 'not-needed';
    } else {
      return { envVars, success: false, warning: `No API key found for: ${connectionSlug}` };
    }
  } else if (authType === 'oauth') {
    if (connection.providerType === 'anthropic') {
      // Anthropic OAuth uses getValidClaudeOAuthToken which handles token refresh
      const tokenResult = await getValidOAuthToken(connectionSlug);
      if (tokenResult.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = tokenResult.accessToken;
      } else {
        return { envVars, success: false, warning: `Failed to get OAuth token for: ${connectionSlug}` };
      }
    } else {
      // Non-Anthropic OAuth (e.g. anthropic_compat with OAuth)
      const llmOAuth = await credentialManager.getLlmOAuth(connectionSlug);
      if (llmOAuth?.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = llmOAuth.accessToken;
      } else {
        return { envVars, success: false, warning: `No OAuth token found for: ${connectionSlug}` };
      }
    }
  } else if (authType === 'environment') {
    // Environment auth — credentials come from process.env, nothing to inject
    return { envVars, success: true };
  }

  return { envVars, success: true };
}

/**
 * Migrate a legacy LlmConnection to the new format.
 * Creates a new connection object with providerType instead of type.
 *
 * @param legacy - Legacy connection with 'type' field
 * @returns Migrated connection with 'providerType' field
 */
export function migrateLlmConnection(legacy: {
  slug: string;
  name: string;
  type: LlmConnectionType;
  baseUrl?: string;
  authType: 'api_key' | 'oauth' | 'none';
  models?: ModelDefinition[];
  defaultModel?: string;
  createdAt: number;
  lastUsedAt?: number;
}): LlmConnection {
  const providerType = migrateConnectionType(legacy.type);
  const hasCustomEndpoint = !!legacy.baseUrl && legacy.type !== 'anthropic';
  const authType = migrateAuthType(legacy.authType, hasCustomEndpoint);

  return {
    slug: legacy.slug,
    name: legacy.name,
    providerType,
    type: legacy.type, // Keep for backwards compatibility
    baseUrl: legacy.baseUrl,
    authType,
    models: legacy.models,
    defaultModel: legacy.defaultModel,
    createdAt: legacy.createdAt,
    lastUsedAt: legacy.lastUsedAt,
  };
}
