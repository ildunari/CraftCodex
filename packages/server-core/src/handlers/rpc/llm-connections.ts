import { RPC_CHANNELS, type AgentCatalogActionResult, type AgentCatalogStatus, type LlmConnectionSetup } from '@craft-agent/shared/protocol'
import { getLlmConnections, getLlmConnection, addLlmConnection, updateLlmConnection, deleteLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection, touchLlmConnection, isCompatProvider, isAnthropicProvider, getDefaultModelsForConnection, getDefaultModelForConnection, AGENT_CATALOG, createConnectionForAgent, getAgentCatalogEntry, DROID_FACTORY_API_KEY_URL, CONFIG_DIR, type AgentCatalogId, type LlmConnection, type LlmConnectionWithStatus, toBedrockNativeId } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { setSetupDeferred } from '@craft-agent/shared/config/storage'
import {
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '@craft-agent/shared/agent/backend'
import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers'
import { parseTestConnectionError, createBuiltInConnection, validateModelList, piAuthProviderDisplayName, validateSetupTestInput, setupTestRequiresApiKey, droidShadowWarning, isLegacyDroidBridge, loadFactoryDroidModelConfig, mergeDroidModels, normalizeAgentReadinessError, selectPreferredCommand, type CommandCandidate } from '@craft-agent/server-core/domain'
import { getWorkspaceOrThrow, buildBackendHostRuntimeContext } from '@craft-agent/server-core/handlers'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { randomUUID } from 'node:crypto'
import { CLIENT_OPEN_EXTERNAL } from '@craft-agent/server-core/transport'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Local OAuth state
let copilotOAuthAbort: AbortController | null = null

const AGENT_CATALOG_STATUS_CACHE_FILE = join(CONFIG_DIR, 'agent-catalog-status-cache.json')
const AGENT_CATALOG_STATUS_CACHE_VERSION = 1
const AGENT_CATALOG_STATUS_CACHE_FRESH_MS = 5 * 60 * 1000
const AGENT_CATALOG_STATUS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface ListAgentCatalogOptions {
  forceRefresh?: boolean
}

export type CachedAgentCatalogStatus = Pick<
  AgentCatalogStatus,
  'id' | 'status' | 'connectionSlug' | 'installed' | 'configured' | 'ready' | 'message'
>

export interface AgentCatalogStatusCache {
  version: typeof AGENT_CATALOG_STATUS_CACHE_VERSION
  updatedAt: number
  connectionSignature: string
  statuses: CachedAgentCatalogStatus[]
}

let agentCatalogStatusCacheLoaded = false
let agentCatalogStatusCache: AgentCatalogStatusCache | null = null
let agentCatalogStatusRefreshPromise: Promise<AgentCatalogStatus[]> | null = null
let agentCatalogStatusRefreshSignature: string | null = null

function runCommandProbe(command: string, args: string[], acceptAnyExit: boolean, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(command, args, { stdio: 'ignore' })
    const finish = (exists: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exists)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, timeoutMs)
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(acceptAnyExit || code === 0))
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise
      .then(value => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(error => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function runCommandForOutput(command: string, args: string[], timeoutMs = 3000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, timeoutMs)
    child.stdout?.on('data', data => { stdout += data.toString() })
    child.stderr?.on('data', data => { stderr += data.toString() })
    child.once('error', () => finish(false))
    child.once('exit', code => finish(code === 0))
  })
}

function commandExists(command: string, timeoutMs = 3000): Promise<boolean> {
  return runCommandProbe(command, ['--version'], true, timeoutMs)
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
  const result = await runCommandForOutput('/bin/bash', ['-lc', `command -v ${JSON.stringify(command)}`], 1000)
  return result.ok ? result.stdout.trim().split('\n')[0] : undefined
}

async function inspectCommandCandidate(command: string): Promise<CommandCandidate> {
  const path = command.includes('/') ? command : await resolveCommandPath(command)
  const target = path || command
  const result = await runCommandForOutput(target, ['--version'], 3000)
  const version = (result.stdout || result.stderr).trim().split(/\s+/).find(part => /\d+\.\d+/.test(part))
  return {
    command,
    path,
    version,
    exists: result.ok || !!version,
  }
}

async function resolvePreferredAgentCommand(entry: NonNullable<ReturnType<typeof getAgentCatalogEntry>>): Promise<string | undefined> {
  if (!entry.preferredCommandCandidates?.length) return entry.defaultCommand
  const candidates = await Promise.all(entry.preferredCommandCandidates.map(inspectCommandCandidate))
  return selectPreferredCommand(candidates)?.path ?? entry.defaultCommand
}

async function createResolvedConnectionForAgent(entry: NonNullable<ReturnType<typeof getAgentCatalogEntry>>): Promise<LlmConnection> {
  const defaults = createConnectionForAgent(entry)
  if (entry.providerType === 'acp') {
    defaults.acpCommand = await resolvePreferredAgentCommand(entry)
    defaults.acpArgs = entry.defaultArgs
  }
  if (entry.id === 'droid') {
    const localConfig = loadFactoryDroidModelConfig()
    defaults.models = mergeDroidModels(defaults.models, localConfig.models)
    if (localConfig.defaultModel && defaults.models.some(model => (typeof model === 'string' ? model : model.id) === localConfig.defaultModel)) {
      defaults.defaultModel = localConfig.defaultModel
    }
  }
  return defaults
}

async function resolveDroidWarning(entry: NonNullable<ReturnType<typeof getAgentCatalogEntry>>): Promise<string | undefined> {
  if (entry.id !== 'droid') return undefined
  const active = await inspectCommandCandidate('droid')
  const candidates = await Promise.all((entry.preferredCommandCandidates ?? ['droid']).map(inspectCommandCandidate))
  const preferred = selectPreferredCommand(candidates)
  return droidShadowWarning(active, preferred)
}

function isConnectionCommandMissing(connection: LlmConnection): Promise<boolean> {
  const command = connection.providerType === 'acp'
    ? connection.acpCommand
    : connection.providerType === 'codex'
      ? connection.codexCommand
      : undefined
  return command ? commandExists(command).then(exists => !exists) : Promise.resolve(false)
}

function modelIds(models: LlmConnection['models'] | undefined): string[] {
  return (models ?? []).map(model => typeof model === 'string' ? model : model.id)
}

function syncDroidByokModels(connection: LlmConnection): LlmConnection {
  if (inferCuratedAgentId(connection) !== 'droid') return connection

  const localConfig = loadFactoryDroidModelConfig()
  if (localConfig.models.length === 0 && !localConfig.defaultModel) return connection

  const mergedModels = mergeDroidModels(connection.models, localConfig.models)
  const nextDefaultModel = localConfig.defaultModel
    && mergedModels.some(model => (typeof model === 'string' ? model : model.id) === localConfig.defaultModel)
    ? localConfig.defaultModel
    : connection.defaultModel
  const currentIds = modelIds(connection.models)
  const nextIds = modelIds(mergedModels)
  const changed = currentIds.length !== nextIds.length
    || currentIds.some((id, index) => id !== nextIds[index])
    || nextDefaultModel !== connection.defaultModel

  if (changed) {
    updateLlmConnection(connection.slug, {
      models: mergedModels,
      defaultModel: nextDefaultModel,
    })
    return {
      ...connection,
      models: mergedModels,
      defaultModel: nextDefaultModel,
    }
  }

  return connection
}

function inferCuratedAgentId(conn: LlmConnection): AgentCatalogId | null {
  if (conn.agentId) return conn.agentId
  if (conn.providerType === 'codex') return 'codex'
  if (conn.providerType === 'pi' && conn.piAuthProvider === 'openai-codex') return 'pi'
  if (conn.providerType !== 'acp') return null
  const command = (conn.acpCommand || '').toLowerCase()
  const args = (conn.acpArgs || []).join(' ').toLowerCase()
  if (command.includes('hermes') || args.includes('hermes')) return 'hermes'
  if (command.includes('droid') || args.includes('droid')) return 'droid'
  const name = conn.name.toLowerCase()
  if (name.includes('hermes')) return 'hermes'
  if (name.includes('droid')) return 'droid'
  return null
}

function getVisibleAgentCatalogEntries() {
  return AGENT_CATALOG.filter(entry => entry.showInAgentManager !== false)
}

export function createAgentCatalogConnectionSignature(connections: LlmConnection[]): string {
  return JSON.stringify(
    connections
      .map(connection => ({
        slug: connection.slug,
        agentId: connection.agentId,
        providerType: connection.providerType,
        authType: connection.authType,
        piAuthProvider: connection.piAuthProvider,
        acpCommand: connection.acpCommand,
        acpArgs: connection.acpArgs,
        codexCommand: connection.codexCommand,
        codexArgs: connection.codexArgs,
        name: connection.name,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  )
}

function isAgentCatalogStatusCache(value: unknown): value is AgentCatalogStatusCache {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<AgentCatalogStatusCache>
  return cache.version === AGENT_CATALOG_STATUS_CACHE_VERSION
    && typeof cache.updatedAt === 'number'
    && typeof cache.connectionSignature === 'string'
    && Array.isArray(cache.statuses)
}

function loadAgentCatalogStatusCache(): AgentCatalogStatusCache | null {
  if (agentCatalogStatusCacheLoaded) return agentCatalogStatusCache
  agentCatalogStatusCacheLoaded = true
  try {
    if (!existsSync(AGENT_CATALOG_STATUS_CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(AGENT_CATALOG_STATUS_CACHE_FILE, 'utf-8'))
    if (isAgentCatalogStatusCache(parsed)) {
      agentCatalogStatusCache = parsed
    }
  } catch {
    agentCatalogStatusCache = null
  }
  return agentCatalogStatusCache
}

function persistAgentCatalogStatusCache(cache: AgentCatalogStatusCache): void {
  agentCatalogStatusCache = cache
  agentCatalogStatusCacheLoaded = true
  try {
    mkdirSync(dirname(AGENT_CATALOG_STATUS_CACHE_FILE), { recursive: true })
    writeFileSync(AGENT_CATALOG_STATUS_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8')
  } catch {
    // Best-effort cache only. Runtime probing remains the source of truth.
  }
}

export function hydrateAgentCatalogStatusCache(cache: AgentCatalogStatusCache, connections: LlmConnection[], now = Date.now()): AgentCatalogStatus[] | null {
  if (cache.connectionSignature !== createAgentCatalogConnectionSignature(connections)) return null
  if (now - cache.updatedAt > AGENT_CATALOG_STATUS_CACHE_MAX_AGE_MS) return null

  const visibleEntries = getVisibleAgentCatalogEntries()
  const cachedById = new Map(cache.statuses.map(status => [status.id, status]))
  if (visibleEntries.some(entry => !cachedById.has(entry.id))) return null

  return visibleEntries.map(entry => {
    const cached = cachedById.get(entry.id)!
    return {
      ...entry,
      status: cached.status,
      connectionSlug: cached.connectionSlug,
      installed: cached.installed,
      configured: cached.configured,
      ready: cached.ready,
      message: cached.message,
    }
  })
}

function getCachedAgentCatalogStatuses(connections: LlmConnection[], now = Date.now()): AgentCatalogStatus[] | null {
  const cache = loadAgentCatalogStatusCache()
  return cache ? hydrateAgentCatalogStatusCache(cache, connections, now) : null
}

function shouldRefreshAgentCatalogCache(connections: LlmConnection[], now = Date.now()): boolean {
  const cache = loadAgentCatalogStatusCache()
  if (!cache) return true
  if (!hydrateAgentCatalogStatusCache(cache, connections, now)) return true
  return now - cache.updatedAt > AGENT_CATALOG_STATUS_CACHE_FRESH_MS
}

async function resolveAgentCatalogStatus(entryId: AgentCatalogId, connections = getLlmConnections()): Promise<AgentCatalogStatus> {
  const entry = getAgentCatalogEntry(entryId)
  if (!entry) {
    throw new Error(`Unknown agent: ${entryId}`)
  }
  const connection = connections.find(c => inferCuratedAgentId(c) === entry.id)
    ?? connections.find(c => c.slug === entry.defaultSlug)
  const commandChecks = await Promise.all(entry.requiredCommands.map(async command => ({
    command,
    exists: await commandExists(command),
  })))
  const missingCommands = commandChecks.filter(check => !check.exists).map(check => check.command)
  const installed = missingCommands.length === 0
  const failedProbe = installed
    ? (await Promise.all((entry.commandProbes ?? []).map(async probe => ({
        label: probe.label ?? `${probe.command} ${(probe.args ?? []).join(' ')}`.trim(),
        ok: await runCommandProbe(probe.command, probe.args ?? ['--version'], true),
      })))).find(probe => !probe.ok)
    : undefined
  const configured = !!connection
  const droidWarning = installed ? await resolveDroidWarning(entry) : undefined
  const legacyDroidBridgeMissing = connection && isLegacyDroidBridge(connection)
    ? await isConnectionCommandMissing(connection)
    : false
  let status: AgentCatalogStatus['status']
  let message: string | undefined

  if (!installed) {
    status = 'not_installed'
    message = missingCommands.length === 1
      ? `${missingCommands[0]} is not installed or not on PATH`
      : `Missing required commands: ${missingCommands.join(', ')}`
  } else if (legacyDroidBridgeMissing) {
    status = 'needs_setup'
    message = 'Droid is configured through the optional agent-proxy bridge, but agent-proxy is not available. Re-enable Droid to switch to direct ACP.'
  } else if (failedProbe) {
    status = 'broken'
    message = `${failedProbe.label} is installed but did not pass its readiness check.`
  } else if (!configured) {
    status = 'needs_setup'
    message = droidWarning || `${entry.name} is installed and can be enabled.`
  } else {
    status = 'ready'
    message = droidWarning || `${entry.name} is enabled.`
  }

  return {
    ...entry,
    status,
    connectionSlug: connection?.slug,
    installed,
    configured,
    ready: status === 'ready',
    message,
  }
}

async function resolveAgentCatalogStatusSafe(
  entry: NonNullable<ReturnType<typeof getAgentCatalogEntry>>,
  connections: LlmConnection[],
): Promise<AgentCatalogStatus> {
  try {
    return await withTimeout(
      resolveAgentCatalogStatus(entry.id, connections),
      10_000,
      `${entry.name} readiness check timed out.`,
    )
  } catch (error) {
    return {
      ...entry,
      status: 'broken',
      installed: false,
      configured: connections.some(c => inferCuratedAgentId(c) === entry.id || c.slug === entry.defaultSlug),
      ready: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function refreshAgentCatalogStatusCache(connections = getLlmConnections()): Promise<AgentCatalogStatus[]> {
  const connectionSignature = createAgentCatalogConnectionSignature(connections)
  if (agentCatalogStatusRefreshPromise) {
    if (agentCatalogStatusRefreshSignature === connectionSignature) {
      return agentCatalogStatusRefreshPromise
    }
    await agentCatalogStatusRefreshPromise.catch(() => null)
  }

  agentCatalogStatusRefreshPromise = Promise.all(
    getVisibleAgentCatalogEntries()
      .map(entry => resolveAgentCatalogStatusSafe(entry, connections))
  ).then(statuses => {
    persistAgentCatalogStatusCache({
      version: AGENT_CATALOG_STATUS_CACHE_VERSION,
      updatedAt: Date.now(),
      connectionSignature,
      statuses: statuses.map(status => ({
        id: status.id,
        status: status.status,
        connectionSlug: status.connectionSlug,
        installed: status.installed,
        configured: status.configured,
        ready: status.ready,
        message: status.message,
      })),
    })
    return statuses
  }).finally(() => {
    agentCatalogStatusRefreshPromise = null
    agentCatalogStatusRefreshSignature = null
  })
  agentCatalogStatusRefreshSignature = connectionSignature

  return agentCatalogStatusRefreshPromise
}

function invalidateAgentCatalogStatusCache(): void {
  agentCatalogStatusCache = null
  agentCatalogStatusCacheLoaded = true
  try {
    rmSync(AGENT_CATALOG_STATUS_CACHE_FILE, { force: true })
  } catch {
    // Best-effort cache invalidation only.
  }
}

async function resolveCommandBackedConnectionStatus(conn: LlmConnection): Promise<Pick<LlmConnectionWithStatus, 'isAuthenticated' | 'authError' | 'agentStatus'>> {
  const agentId = inferCuratedAgentId(conn)
  if (!agentId) {
    if (conn.providerType === 'acp') {
      return {
        isAuthenticated: false,
        authError: 'This ACP connection is legacy. Add Droid or Hermes from Agents to use a curated first-party integration.',
        agentStatus: 'needs_setup',
      }
    }
    return { isAuthenticated: conn.authType === 'none', agentStatus: conn.authType === 'none' ? 'ready' : undefined }
  }
  const entry = getAgentCatalogEntry(agentId)
  if (!entry) {
    return { isAuthenticated: false, authError: `Unknown agent "${agentId}"`, agentStatus: 'broken' }
  }
  const cachedStatus = getCachedAgentCatalogStatuses(getLlmConnections())?.find(status => status.id === entry.id)
  const status = cachedStatus ?? await resolveAgentCatalogStatus(entry.id)
  return {
    isAuthenticated: status.ready,
    authError: status.ready ? undefined : status.message,
    agentStatus: status.status,
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.llmConnections.LIST_AGENT_CATALOG,
  RPC_CHANNELS.llmConnections.LIST_HERMES_PROFILES,
  RPC_CHANNELS.llmConnections.ENABLE_AGENT,
  RPC_CHANNELS.llmConnections.OPEN_AGENT_SETUP,
  RPC_CHANNELS.chatgpt.START_OAUTH,
  RPC_CHANNELS.chatgpt.COMPLETE_OAUTH,
  RPC_CHANNELS.chatgpt.CANCEL_OAUTH,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,
  RPC_CHANNELS.copilot.START_OAUTH,
  RPC_CHANNELS.copilot.CANCEL_OAUTH,
  RPC_CHANNELS.copilot.GET_AUTH_STATUS,
  RPC_CHANNELS.copilot.LOGOUT,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,
] as const

export function registerLlmConnectionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  // Unified handler for LLM connection setup
  server.handle(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, async (_ctx, setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }> => {
    try {
      const manager = getCredentialManager()

      // Ensure connection exists in config
      let connection = getLlmConnection(setup.slug)
      let isNewConnection = false
      if (!connection) {
        // Reauth guard: if updateOnly is set, the connection must already exist.
        // Clean up any orphaned credentials from a preceding OAuth flow.
        if (setup.updateOnly) {
          await manager.deleteLlmCredentials(setup.slug).catch(() => {})
          deps.platform.logger?.warn(`[SETUP_LLM_CONNECTION] updateOnly rejected for missing slug: ${setup.slug}`)
          return { success: false, error: 'Connection not found. Cannot re-authenticate a non-existent connection.' }
        }
        // Create connection with appropriate defaults based on slug
        connection = createBuiltInConnection(setup.slug, setup.baseUrl)
        isNewConnection = true
      }

      const updates: Partial<LlmConnection> = {}
      const hasConfiguredBaseUrl = !!setup.baseUrl?.trim()
      if (setup.baseUrl !== undefined) {
        updates.baseUrl = setup.baseUrl?.trim() || undefined

        // Only mutate providerType for API key connections (not OAuth connections)
        if (isAnthropicProvider(connection.providerType) && connection.authType !== 'oauth') {
          const pt = hasConfiguredBaseUrl ? 'anthropic_compat' as const : 'anthropic' as const
          updates.providerType = pt
          updates.authType = hasConfiguredBaseUrl ? 'api_key_with_endpoint' : 'api_key'
          if (!hasConfiguredBaseUrl) {
            updates.models = getDefaultModelsForConnection(pt)
            updates.defaultModel = getDefaultModelForConnection(pt)
          }
        }

        // Pi API key flow: store baseUrl on the connection (Pi SDK doesn't use it yet,
        // but it's persisted for future backend support)

      }

      if (setup.defaultModel !== undefined) {
        updates.defaultModel = setup.defaultModel ?? undefined
      }
      if (setup.models !== undefined) {
        updates.models = setup.models ?? undefined
      }
      if (setup.modelSelectionMode !== undefined) {
        updates.modelSelectionMode = setup.modelSelectionMode
      }

      const customEndpoint = hasConfiguredBaseUrl ? setup.customEndpoint : undefined
      const isCustomEndpointCompat = !!customEndpoint
      if (customEndpoint) {
        updates.customEndpoint = customEndpoint
        // Route custom OpenAI/Anthropic-compatible endpoints through PiAgent.
        updates.providerType = 'pi_compat'
        updates.authType = 'api_key_with_endpoint'
        // Keep provider hint in lockstep with selected protocol toggle.
        updates.piAuthProvider = customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai'
      } else if (setup.baseUrl !== undefined) {
        // Base URL was explicitly updated without custom protocol config.
        // Treat this as non-custom mode and clear stale custom endpoint metadata.
        updates.customEndpoint = undefined
        if (connection.providerType === 'pi_compat' && connection.authType !== 'oauth') {
          updates.providerType = 'pi'
          updates.authType = 'api_key'
        }
      }

      // Pi API key flow: set piAuthProvider from setup data (e.g. 'anthropic', 'google', 'openai').
      // Skip when custom endpoint protocol is driving routing.
      if (setup.piAuthProvider && !isCustomEndpointCompat) {
        updates.piAuthProvider = setup.piAuthProvider
        // Update connection name to show the actual provider (e.g. "Craft Agents Backend (Google AI Studio)")
        const providerName = piAuthProviderDisplayName(setup.piAuthProvider)
        if (providerName) {
          updates.name = `Craft Agents Backend (${providerName})`
        }
        // Only set default models when using standard Pi provider AND user didn't pick explicit models
        if (!hasConfiguredBaseUrl && !setup.models?.length) {
          updates.models = getDefaultModelsForConnection('pi', setup.piAuthProvider)
          updates.defaultModel = getDefaultModelForConnection('pi', setup.piAuthProvider)
          updates.modelSelectionMode ??= 'automaticallySyncedFromProvider'
        }
      }

      // Bedrock auth method override — set authType and region.
      // providerType stays 'pi' when piAuthProvider==='amazon-bedrock' (Pi SDK Bedrock path).
      // Only set providerType='bedrock' when there's no Pi auth provider.
      if (setup.bedrockAuthMethod) {
        updates.authType = setup.bedrockAuthMethod
        const hasPiBedrockAuth = (updates.piAuthProvider ?? connection.piAuthProvider) === 'amazon-bedrock'
        if (!hasPiBedrockAuth) {
          updates.providerType = 'bedrock'
        }
        if (setup.awsRegion) updates.awsRegion = setup.awsRegion
      }

      const effectiveProviderType = updates.providerType ?? connection.providerType
      if (effectiveProviderType === 'pi') {
        const isBedrockPi = (updates.piAuthProvider ?? connection.piAuthProvider) === 'amazon-bedrock'
        // For Pi+Bedrock, normalize bare Anthropic IDs to Bedrock-native before adding pi/ prefix
        // so that resolvePiModel() can find them in the amazon-bedrock registry.
        const toPiModelId = (id: string) => {
          const bare = id.startsWith('pi/') ? id.slice(3) : id
          const normalized = isBedrockPi ? toBedrockNativeId(bare) : bare
          return `pi/${normalized}`
        }
        if (updates.models) {
          updates.models = updates.models.map(m => typeof m === 'string' ? toPiModelId(m) : { ...m, id: toPiModelId(m.id) })
        }
        if (updates.defaultModel) {
          updates.defaultModel = toPiModelId(updates.defaultModel)
        }
      } else if (effectiveProviderType === 'bedrock') {
        // providerType==='bedrock' goes through ClaudeAgent → Anthropic API,
        // which uses bare Anthropic IDs. Only strip the pi/ prefix.
        const stripPiPrefix = (id: string) => id.startsWith('pi/') ? id.slice(3) : id
        if (updates.models) {
          updates.models = updates.models.map(m => typeof m === 'string'
            ? stripPiPrefix(m)
            : { ...m, id: stripPiPrefix(m.id) })
        }
        if (updates.defaultModel) {
          updates.defaultModel = stripPiPrefix(updates.defaultModel)
        }
      }

      const pendingConnection: LlmConnection = {
        ...connection,
        ...updates,
      }

      if (pendingConnection.providerType === 'pi') {
        const modelIds = (pendingConnection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
        deps.platform.logger?.info('Pi setup pending connection snapshot', {
          slug: pendingConnection.slug,
          piAuthProvider: pendingConnection.piAuthProvider,
          modelSelectionMode: pendingConnection.modelSelectionMode,
          defaultModel: pendingConnection.defaultModel,
          modelCount: modelIds.length,
          modelsFirst5: modelIds.slice(0, 5),
          setupModelCount: setup.models?.length,
          setupDefaultModel: setup.defaultModel,
        })
      }

      if (pendingConnection.providerType === 'pi' && pendingConnection.piAuthProvider && !pendingConnection.modelSelectionMode) {
        const inferredMode = setup.models?.length
          ? 'userDefined3Tier'
          : 'automaticallySyncedFromProvider'
        pendingConnection.modelSelectionMode = inferredMode
        updates.modelSelectionMode = inferredMode
      }

      if (updates.models && updates.models.length > 0) {
        const validation = validateModelList(updates.models, pendingConnection.defaultModel)
        if (!validation.valid) {
          return { success: false, error: validation.error }
        }
        if (validation.resolvedDefaultModel) {
          pendingConnection.defaultModel = validation.resolvedDefaultModel
          updates.defaultModel = validation.resolvedDefaultModel
        }
      }

      if (isCompatProvider(pendingConnection.providerType) && !pendingConnection.defaultModel) {
        return { success: false, error: 'Default model is required for compatible endpoints.' }
      }

      if (isNewConnection) {
        const added = addLlmConnection(pendingConnection)
        if (!added) {
          deps.platform.logger?.error(`Failed to persist LLM connection: ${setup.slug} (config may be inaccessible)`)
          return { success: false, error: 'Failed to save connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Created LLM connection: ${setup.slug}`)
      } else if (Object.keys(updates).length > 0) {
        const updated = updateLlmConnection(setup.slug, updates)
        if (!updated) {
          deps.platform.logger?.error(`Failed to update LLM connection: ${setup.slug}`)
          return { success: false, error: 'Failed to update connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Updated LLM connection settings: ${setup.slug}`)
      }

      // Store credential if provided (skip masked placeholders from GET_API_KEY)
      const isMasked = setup.credential?.includes('••')
      if (setup.credential && !isMasked) {
        const authType = pendingConnection.authType
        if (authType === 'oauth') {
          await manager.setLlmOAuth(setup.slug, { accessToken: setup.credential })
          deps.platform.logger?.info('Saved OAuth access token to LLM connection')
        } else {
          await manager.setLlmApiKey(setup.slug, setup.credential)
          deps.platform.logger?.info('Saved API key to LLM connection')
        }
      }

      // Bedrock IAM credentials — stored separately from API keys
      if (setup.iamCredentials) {
        await manager.setLlmIamCredentials(setup.slug, {
          ...setup.iamCredentials,
          region: setup.awsRegion,
        })
        deps.platform.logger?.info('Saved IAM credentials to LLM connection')
      }

      // Set as default only if no default exists yet (first connection)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(setup.slug)
        deps.platform.logger?.info(`Set default LLM connection: ${setup.slug}`)
      }

      // Fetch available models (non-blocking).
      // Always refresh for auto-synced connections (e.g. Copilot) — the static
      // catalog from setup is just a seed that needs replacing with live API data
      // filtered by the user's policy. For user-defined connections, only refresh
      // when no models were populated during setup.
      const pendingModels = Array.isArray(pendingConnection.models) ? pendingConnection.models : []
      const isAutoSynced = pendingConnection.modelSelectionMode === 'automaticallySyncedFromProvider'
      if (!pendingModels.length || isAutoSynced) {
        getModelRefreshService().refreshNow(setup.slug).catch(err => {
          deps.platform.logger?.warn(`Model refresh after setup failed for ${setup.slug}: ${err instanceof Error ? err.message : err}`)
        })
      }

      // Reinitialize auth for the connection that was just created/updated,
      // not the global default (which may be a different connection).
      await sessionManager.reinitializeAuth(setup.slug)
      deps.platform.logger?.info('Reinitialized auth after LLM connection setup')

      // Clear "Setup later" flag now that user has configured a provider
      setSetupDeferred(false)
      invalidateAgentCatalogStatusCache()

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error('Failed to setup LLM connection:', message)
      return { success: false, error: message }
    }
  })

  // Unified connection test — uses the agent factory to spawn a real agent subprocess
  // and validate credentials via runMiniCompletion(). Same code path as actual chat.
  server.handle(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, async (_ctx, params: import('@craft-agent/shared/protocol').TestLlmConnectionParams): Promise<import('@craft-agent/shared/protocol').TestLlmConnectionResult> => {
    const { provider, apiKey, baseUrl, model, piAuthProvider, customEndpoint, acpCommand, acpArgs, codexCommand, codexArgs } = params
    const trimmedKey = apiKey?.trim() ?? ''
    const allowEmptyApiKey = provider === 'codex' || provider === 'acp' || !setupTestRequiresApiKey(baseUrl)

    if (!trimmedKey && !allowEmptyApiKey) {
      return { success: false, error: 'API key is required' }
    }

    const setupValidation = validateSetupTestInput({ provider, baseUrl, piAuthProvider })
    if (!setupValidation.valid) {
      return { success: false, error: setupValidation.error }
    }

    const hint = resolveSetupTestConnectionHint({ provider, baseUrl, piAuthProvider, customEndpoint, acpCommand, acpArgs, codexCommand, codexArgs })
    deps.platform.logger?.info(`[testLlmConnectionSetup] Testing: provider=${provider}${piAuthProvider ? ` piAuth=${piAuthProvider}` : ''}${baseUrl ? ` baseUrl=${baseUrl}` : ''} hasCustomEndpoint=${!!customEndpoint} hintProvider=${hint.providerType}`)

    try {
      const testModel = model || getDefaultModelForConnection(provider, piAuthProvider)
      const result = await testBackendConnection({
        provider,
        apiKey: trimmedKey,
        allowEmptyApiKey,
        model: testModel,
        baseUrl,
        timeoutMs: 20000,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        connection: hint,
      })

      if (!result.success) {
        return { success: false, error: parseTestConnectionError(result.error || 'Unknown error') }
      }
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Error: ${msg.slice(0, 500)}`)
      return { success: false, error: parseTestConnectionError(msg) }
    }
  })

  // ============================================================
  // Pi Provider Discovery (main process only — Pi SDK can't run in renderer)
  // ============================================================

  server.handle(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS, async () => {
    const { getPiApiKeyProviders } = await import('@craft-agent/shared/config')
    return getPiApiKeyProviders()
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL, async (_ctx, provider: string) => {
    const { getPiProviderBaseUrl } = await import('@craft-agent/shared/config')
    return getPiProviderBaseUrl(provider)
  })

  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_MODELS, async (_ctx, provider: string) => {
    const { getModels } = await import('@mariozechner/pi-ai')
    try {
      const models = getModels(provider as Parameters<typeof getModels>[0])
      const sorted = [...models].sort((a, b) => b.cost.output - a.cost.output || b.cost.input - a.cost.input)
      return {
        models: sorted.map(m => ({
          id: m.id.startsWith('pi/') ? m.id : `pi/${m.id}`,
          name: m.name,
          costInput: m.cost.input,
          costOutput: m.cost.output,
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
        })),
        totalCount: models.length,
      }
    } catch {
      return { models: [], totalCount: 0 }
    }
  })

  // ============================================================
  // LLM Connections (provider configurations)
  // ============================================================

  // List all LLM connections (includes built-in and custom)
  server.handle(RPC_CHANNELS.llmConnections.LIST, async (): Promise<LlmConnection[]> => {
    return getLlmConnections()
  })

  // List all LLM connections with authentication status
  server.handle(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS, async (): Promise<LlmConnectionWithStatus[]> => {
    const connections = getLlmConnections()
    const credentialManager = getCredentialManager()
    const defaultSlug = getDefaultLlmConnection()

    return Promise.all(connections.map(async (rawConn): Promise<LlmConnectionWithStatus> => {
      const conn = syncDroidByokModels(rawConn)
      if (conn.agentId || conn.providerType === 'codex' || conn.providerType === 'acp') {
        const status = await resolveCommandBackedConnectionStatus(conn)
        return {
          ...conn,
          isDefault: conn.slug === defaultSlug,
          ...status,
        }
      }
      // Check if credentials exist for this connection
      const hasCredentials = await credentialManager.hasLlmCredentials(conn.slug, conn.authType)
      return {
        ...conn,
        isAuthenticated: conn.authType === 'none' || hasCredentials,
        isDefault: conn.slug === defaultSlug,
      }
    }))
  })

  // Get a specific LLM connection by slug
  server.handle(RPC_CHANNELS.llmConnections.GET, async (_ctx, slug: string): Promise<LlmConnection | null> => {
    return getLlmConnection(slug)
  })

  // Get stored API key for an LLM connection (masked — for edit form display only)
  server.handle(RPC_CHANNELS.llmConnections.GET_API_KEY, async (_ctx, slug: string): Promise<string | null> => {
    const manager = getCredentialManager()
    const key = await manager.getLlmApiKey(slug)
    if (!key) return null
    // Show provider prefix (first 7 chars) + last 4 chars, mask the middle
    if (key.length > 15) {
      return key.slice(0, 7) + '••••••••' + key.slice(-4)
    }
    return '••••••••'
  })

  // Save (create or update) an LLM connection
  // If connection.slug exists and is found, updates it; otherwise creates new
  server.handle(RPC_CHANNELS.llmConnections.SAVE, async (_ctx, connection: LlmConnection): Promise<{ success: boolean; error?: string }> => {
    try {
      // Check if this is an update or create
      const existing = getLlmConnection(connection.slug)
      if (existing) {
        // Update existing connection (can't change slug)
        const { slug: _slug, ...updates } = connection
        const success = updateLlmConnection(connection.slug, updates)
        if (!success) {
          return { success: false, error: 'Failed to update connection' }
        }
      } else {
        // Create new connection
        const success = addLlmConnection(connection)
        if (!success) {
          return { success: false, error: 'Connection with this slug already exists' }
        }
      }
      invalidateAgentCatalogStatusCache()
      deps.platform.logger?.info(`LLM connection saved: ${connection.slug}`)
      // Reinitialize auth if the saved connection is the current default
      // (updates env vars and summarization model override)
      const defaultSlug = getDefaultLlmConnection()
      if (defaultSlug === connection.slug) {
        await sessionManager.reinitializeAuth()
      }
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to save LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Delete an LLM connection (at least one connection must remain)
  server.handle(RPC_CHANNELS.llmConnections.DELETE, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }
      // deleteLlmConnection handles the "at least one must remain" check
      const success = deleteLlmConnection(slug)
      if (success) {
        invalidateAgentCatalogStatusCache()
        // Stop any periodic model refresh timer for this connection
        getModelRefreshService().stopConnection(slug)
        // Also delete associated credentials
        const credentialManager = getCredentialManager()
        await credentialManager.deleteLlmCredentials(slug)
        deps.platform.logger?.info(`LLM connection deleted: ${slug}`)
      }
      return { success }
    } catch (error) {
      deps.platform.logger?.error('Failed to delete LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Test an LLM connection (validate credentials and connectivity with actual API call)
  server.handle(RPC_CHANNELS.llmConnections.TEST, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await validateStoredBackendConnection({
        slug,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      })

      if (!result.success) {
        const connection = getLlmConnection(slug)
        const agentId = connection ? inferCuratedAgentId(connection) : null
        const normalized = agentId && result.error
          ? normalizeAgentReadinessError(agentId, result.error)
          : null
        return { success: false, error: normalized?.message ?? result.error }
      }

      touchLlmConnection(slug)

      if (result.shouldRefreshModels) {
        getModelRefreshService().refreshNow(slug).catch(err => {
          deps.platform.logger?.warn(`Model refresh failed during validation: ${err instanceof Error ? err.message : err}`)
        })
      }

      deps.platform.logger?.info(`LLM connection validated: ${slug}`)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[LLM_CONNECTION_TEST] Error for ${slug}: ${msg.slice(0, 500)}`)
      const { parseValidationError } = await import('@craft-agent/shared/config')
      return { success: false, error: parseValidationError(msg) }
    }
  })

  // Set global default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_DEFAULT, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }
      if (connection.agentId || connection.providerType === 'codex' || connection.providerType === 'acp') {
        const status = await resolveCommandBackedConnectionStatus(connection)
        if (!status.isAuthenticated) {
          return { success: false, error: status.authError || 'Agent is not ready' }
        }
      }
      const success = setDefaultLlmConnection(slug)
      if (success) {
        deps.platform.logger?.info(`Global default LLM connection set to: ${slug}`)
        // Reinitialize auth so env vars and summarization model override match the new default
        await sessionManager.reinitializeAuth()
      }
      return { success, error: success ? undefined : 'Connection not found' }
    } catch (error) {
      deps.platform.logger?.error('Failed to set default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Set workspace default LLM connection
  server.handle(RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT, async (_ctx, workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }> => {
    try {
      const workspace = getWorkspaceOrThrow(workspaceId)

      // Validate connection exists if setting (not clearing)
      if (slug) {
        const connection = getLlmConnection(slug)
        if (!connection) {
          return { success: false, error: 'Connection not found' }
        }
        if (connection.agentId || connection.providerType === 'codex' || connection.providerType === 'acp') {
          const status = await resolveCommandBackedConnectionStatus(connection)
          if (!status.isAuthenticated) {
            return { success: false, error: status.authError || 'Agent is not ready' }
          }
        }
      }

      const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
      const config = loadWorkspaceConfig(workspace.rootPath)
      if (!config) {
        return { success: false, error: 'Failed to load workspace config' }
      }

      // Update workspace defaults
      config.defaults = config.defaults || {}
      if (slug) {
        config.defaults.defaultLlmConnection = slug
      } else {
        delete config.defaults.defaultLlmConnection
      }

      saveWorkspaceConfig(workspace.rootPath, config)
      deps.platform.logger?.info(`Workspace ${workspaceId} default LLM connection set to: ${slug}`)
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to set workspace default LLM connection:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Refresh available models for a connection (dynamic model discovery)
  server.handle(RPC_CHANNELS.llmConnections.REFRESH_MODELS, async (_ctx, slug: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const connection = getLlmConnection(slug)
      if (!connection) {
        return { success: false, error: 'Connection not found' }
      }

      await getModelRefreshService().refreshNow(slug)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error(`Failed to refresh models for ${slug}: ${msg}`)
      return { success: false, error: msg }
    }
  })

  server.handle(RPC_CHANNELS.llmConnections.LIST_HERMES_PROFILES, async (_ctx, options?: { force?: boolean }): Promise<import('@craft-agent/shared/agent/backend/internal/drivers/hermes-profiles').HermesProfileInfo[]> => {
    const { listHermesProfiles, modelStringForProfile } = await import('@craft-agent/shared/agent/backend/internal/drivers/hermes-profiles')
    const profiles = await listHermesProfiles({ force: options?.force })
    // Best-effort: keep the Hermes connection's `models` mirror in sync with
    // discovered profiles so the model picker shows them without a refetch.
    if (profiles.length > 0) {
      const hermes = getLlmConnections().find(c => c.agentId === 'hermes')
      if (hermes) {
        const expected = profiles.map(p => modelStringForProfile(p.name))
        const current = hermes.models ?? []
        const same = expected.length === current.length && expected.every((m, i) => m === current[i])
        if (!same) {
          const defaultProfile = profiles.find(p => p.isDefault) ?? profiles[0]
          updateLlmConnection(hermes.slug, {
            models: expected,
            defaultModel: hermes.defaultModel && expected.includes(hermes.defaultModel)
              ? hermes.defaultModel
              : modelStringForProfile(defaultProfile.name),
          })
        }
      }
    }
    return profiles
  })

  server.handle(RPC_CHANNELS.llmConnections.LIST_AGENT_CATALOG, async (_ctx, options?: ListAgentCatalogOptions): Promise<AgentCatalogStatus[]> => {
    const connections = getLlmConnections()
    if (!options?.forceRefresh) {
      const cached = getCachedAgentCatalogStatuses(connections)
      if (cached) {
        if (shouldRefreshAgentCatalogCache(connections)) {
          void refreshAgentCatalogStatusCache(connections)
        }
        return cached
      }
    }
    return refreshAgentCatalogStatusCache(connections)
  })

  server.handle(RPC_CHANNELS.llmConnections.ENABLE_AGENT, async (_ctx, agentId: AgentCatalogId): Promise<AgentCatalogActionResult> => {
    try {
      const entry = getAgentCatalogEntry(agentId)
      if (!entry) {
        return { success: false, error: `Unknown agent: ${agentId}` }
      }

      const status = await resolveAgentCatalogStatus(entry.id)
      if (!status.installed) {
        return { success: false, error: status.message || `${entry.name} is not installed` }
      }

      const defaults = await createResolvedConnectionForAgent(entry)
      const existing = getLlmConnections().find(c => inferCuratedAgentId(c) === entry.id)
        ?? getLlmConnection(entry.defaultSlug)
      if (existing) {
        const replaceLegacyDroidBridge = isLegacyDroidBridge(existing)
        const success = updateLlmConnection(existing.slug, {
          agentId: existing.agentId ?? defaults.agentId,
          providerType: existing.providerType || defaults.providerType,
          authType: existing.authType || defaults.authType,
          modelSelectionMode: existing.modelSelectionMode || defaults.modelSelectionMode,
          acpCommand: replaceLegacyDroidBridge ? defaults.acpCommand : existing.acpCommand ?? defaults.acpCommand,
          acpArgs: replaceLegacyDroidBridge ? defaults.acpArgs : existing.acpArgs ?? defaults.acpArgs,
          codexCommand: existing.codexCommand ?? defaults.codexCommand,
          codexArgs: existing.codexArgs ?? defaults.codexArgs,
          models: entry.id === 'droid' ? mergeDroidModels(existing.models, defaults.models ?? []) : existing.models?.length ? existing.models : defaults.models,
          defaultModel: entry.id === 'droid' && defaults.defaultModel ? defaults.defaultModel : existing.defaultModel || defaults.defaultModel,
          name: existing.name || entry.name,
        })
        invalidateAgentCatalogStatusCache()
        return success
          ? { success: true, connectionSlug: existing.slug, message: `${entry.name} is enabled.` }
          : { success: false, error: `Failed to update ${entry.name}` }
      }

      const added = addLlmConnection(defaults)
      invalidateAgentCatalogStatusCache()
      if (!added) {
        return { success: false, error: `Failed to add ${entry.name}` }
      }

      deps.platform.logger?.info(`Enabled curated agent: ${entry.id}`)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(defaults.slug)
      }
      return { success: true, connectionSlug: defaults.slug, message: `${entry.name} is enabled.` }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.llmConnections.OPEN_AGENT_SETUP, async (ctx, agentId: AgentCatalogId): Promise<AgentCatalogActionResult> => {
    const entry = getAgentCatalogEntry(agentId)
    if (!entry) {
      return { success: false, error: `Unknown agent: ${agentId}` }
    }
    if (agentId === 'droid') {
      try {
        await server.invokeClient(ctx.clientId, CLIENT_OPEN_EXTERNAL, DROID_FACTORY_API_KEY_URL)
      } catch (error) {
        deps.platform.logger?.warn(`Failed to open Droid API key URL: ${error instanceof Error ? error.message : error}`)
      }
      return {
        success: true,
        message: 'Create a Factory API key, paste it into Droid setup, then re-check Droid.',
      }
    }
    if (entry.setupUrl || entry.docsUrl) {
      try {
        await server.invokeClient(ctx.clientId, CLIENT_OPEN_EXTERNAL, entry.setupUrl || entry.docsUrl)
        return { success: true, message: entry.setupCommand ? `After setup, run: ${entry.setupCommand}` : undefined }
      } catch (error) {
        deps.platform.logger?.warn(`Failed to open setup URL for ${agentId}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return {
      success: true,
      message: entry.setupCommand
        ? `Run ${entry.setupCommand}, then re-check ${entry.name}.`
        : `Install or configure ${entry.name}, then re-check.`,
    }
  })

  server.handle(RPC_CHANNELS.llmConnections.SAVE_AGENT_API_KEY, async (_ctx, agentId: AgentCatalogId, apiKey: string): Promise<AgentCatalogActionResult> => {
    try {
      if (agentId !== 'droid') {
        return { success: false, error: `API key setup is not supported for ${agentId}` }
      }
      const trimmed = apiKey.trim()
      if (!trimmed) {
        return { success: false, error: 'Enter a Factory API key.' }
      }

      const entry = getAgentCatalogEntry(agentId)
      if (!entry) {
        return { success: false, error: `Unknown agent: ${agentId}` }
      }

      const status = await resolveAgentCatalogStatus(entry.id)
      if (!status.installed) {
        return { success: false, error: status.message || `${entry.name} is not installed` }
      }

      const defaults = await createResolvedConnectionForAgent(entry)
      const existing = getLlmConnections().find(c => inferCuratedAgentId(c) === entry.id)
        ?? getLlmConnection(entry.defaultSlug)
      const connectionSlug = existing?.slug ?? defaults.slug

      if (existing) {
        const replaceLegacyDroidBridge = isLegacyDroidBridge(existing)
        const success = updateLlmConnection(existing.slug, {
          agentId: existing.agentId ?? defaults.agentId,
          providerType: existing.providerType || defaults.providerType,
          authType: existing.authType || defaults.authType,
          modelSelectionMode: existing.modelSelectionMode || defaults.modelSelectionMode,
          acpCommand: replaceLegacyDroidBridge ? defaults.acpCommand : existing.acpCommand ?? defaults.acpCommand,
          acpArgs: replaceLegacyDroidBridge ? defaults.acpArgs : existing.acpArgs ?? defaults.acpArgs,
          models: mergeDroidModels(existing.models, defaults.models ?? []),
          defaultModel: defaults.defaultModel || existing.defaultModel,
          name: existing.name || entry.name,
        })
        if (!success) {
          return { success: false, error: `Failed to update ${entry.name}` }
        }
      } else {
        const added = addLlmConnection(defaults)
        if (!added) {
          return { success: false, error: `Failed to add ${entry.name}` }
        }
      }

      const credentialManager = getCredentialManager()
      await credentialManager.setLlmApiKey(connectionSlug, trimmed)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(connectionSlug)
      }
      await sessionManager.reinitializeAuth(connectionSlug)
      invalidateAgentCatalogStatusCache()

      return {
        success: true,
        connectionSlug,
        message: 'Droid Factory API key saved. Droid will use it when Craft launches Droid.',
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ============================================================
  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  // Server-owned: prepare + exchange happen here, browser + callback on client.
  // ============================================================

  interface PendingChatGptFlow {
    flowId: string
    state: string
    codeVerifier: string
    connectionSlug: string
    ownerClientId: string
    createdAt: number
  }
  const pendingChatGptFlows = new Map<string, PendingChatGptFlow>()
  const CHATGPT_FLOW_TTL_MS = 5 * 60 * 1000

  function cleanupExpiredChatGptFlows() {
    const now = Date.now()
    for (const [state, flow] of pendingChatGptFlows) {
      if (now - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
        pendingChatGptFlows.delete(state)
      }
    }
  }

  // chatgpt:startOAuth — prepare PKCE + auth URL, store flow, return to client
  server.handle(RPC_CHANNELS.chatgpt.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    authUrl: string
    state: string
    flowId: string
  }> => {
    cleanupExpiredChatGptFlows()
    const { prepareChatGptOAuth } = await import('@craft-agent/shared/auth')

    const prepared = prepareChatGptOAuth()
    const flowId = randomUUID()

    pendingChatGptFlows.set(prepared.state, {
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      connectionSlug,
      ownerClientId: ctx.clientId,
      createdAt: Date.now(),
    })

    deps.platform.logger?.info(`[ChatGPT OAuth] Flow started for ${connectionSlug} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  // chatgpt:completeOAuth — exchange code for tokens and store credentials
  server.handle(RPC_CHANNELS.chatgpt.COMPLETE_OAUTH, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }): Promise<{ success: boolean; error?: string }> => {
    const { flowId, code, state } = args
    const flow = pendingChatGptFlows.get(state)

    if (!flow) throw new Error('Unknown or expired ChatGPT OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')
    if (flow.ownerClientId !== ctx.clientId) throw new Error('OAuth flow owned by different client')
    if (Date.now() - flow.createdAt > CHATGPT_FLOW_TTL_MS) {
      pendingChatGptFlows.delete(state)
      throw new Error('ChatGPT OAuth flow expired')
    }

    try {
      const { exchangeChatGptTokens } = await import('@craft-agent/shared/auth')
      const credentialManager = getCredentialManager()

      const tokens = await exchangeChatGptTokens(code, flow.codeVerifier)

      await credentialManager.setLlmOAuth(flow.connectionSlug, {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })

      pendingChatGptFlows.delete(state)
      deps.platform.logger?.info(`[ChatGPT OAuth] Flow complete for ${flow.connectionSlug}`)
      return { success: true }
    } catch (error) {
      pendingChatGptFlows.delete(state)
      deps.platform.logger?.error('[ChatGPT OAuth] Token exchange failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
      }
    }
  })

  // Cancel ongoing ChatGPT OAuth flow
  server.handle(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, async (ctx, args?: { state?: string }): Promise<{ success: boolean }> => {
    if (args?.state) {
      const flow = pendingChatGptFlows.get(args.state)
      if (flow && flow.ownerClientId === ctx.clientId) {
        pendingChatGptFlows.delete(args.state)
        deps.platform.logger?.info(`[ChatGPT OAuth] Flow cancelled for ${flow.connectionSlug}`)
      }
    }
    return { success: true }
  })

  // Get ChatGPT authentication status
  server.handle(RPC_CHANNELS.chatgpt.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
    expiresAt?: number
    hasRefreshToken?: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      if (!creds) {
        return { authenticated: false }
      }

      // Check if expired (with 5-minute buffer)
      const isExpired = creds.expiresAt && Date.now() > creds.expiresAt - 5 * 60 * 1000

      return {
        authenticated: !isExpired || !!creds.refreshToken, // Can refresh if has refresh token
        expiresAt: creds.expiresAt,
        hasRefreshToken: !!creds.refreshToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get ChatGPT auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from ChatGPT (clear stored tokens)
  server.handle(RPC_CHANNELS.chatgpt.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('ChatGPT credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear ChatGPT credentials:', error)
      return { success: false }
    }
  })

  // ============================================================
  // GitHub Copilot OAuth
  // ============================================================

  // Start GitHub Copilot OAuth flow (device flow via Pi SDK)
  server.handle(RPC_CHANNELS.copilot.START_OAUTH, async (ctx, connectionSlug: string): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      const { loginGitHubCopilot } = await import('@mariozechner/pi-ai/oauth')
      const credentialManager = getCredentialManager()

      // Cancel any previous in-flight flow
      copilotOAuthAbort?.abort()
      copilotOAuthAbort = new AbortController()

      deps.platform.logger?.info(`Starting GitHub Copilot OAuth device flow for connection: ${connectionSlug}`)

      // Use Pi SDK's login flow — this handles the device code flow AND
      // the critical Copilot token exchange that determines the correct
      // API endpoint for the user's subscription tier (individual/business/enterprise).
      const credentials = await loginGitHubCopilot({
        onAuth: (url, instructions) => {
          // Extract user code from instructions (format: "Enter code: XXXX-YYYY")
          const codeMatch = instructions?.match(/:\s*(\S+)/)
          const userCode = codeMatch?.[1] ?? ''
          deps.platform.logger?.info(`[GitHub OAuth] Device code: ${userCode}`)
          pushTyped(server, RPC_CHANNELS.copilot.DEVICE_CODE, { to: 'client', clientId: ctx.clientId }, {
            userCode,
            verificationUri: url,
          })
          // Open GitHub device code page on the client's machine
          server.invokeClient(ctx.clientId, CLIENT_OPEN_EXTERNAL, url).catch(err => {
            deps.platform.logger?.warn(`Failed to open browser for GitHub OAuth: ${err}`)
          })
        },
        onPrompt: async () => {
          // Pi SDK asks for GitHub Enterprise domain — return empty for github.com
          return ''
        },
        onProgress: (message) => {
          deps.platform.logger?.info(`[GitHub OAuth] ${message}`)
        },
        signal: copilotOAuthAbort.signal,
      })

      copilotOAuthAbort = null

      // Store the full OAuth credential:
      // - accessToken = Copilot API token (contains proxy-ep for correct endpoint)
      // - refreshToken = GitHub access token (used to refresh the Copilot token)
      // - expiresAt = Copilot token expiry (short-lived, ~1 hour)
      await credentialManager.setLlmOAuth(connectionSlug, {
        accessToken: credentials.access,
        refreshToken: credentials.refresh,
        expiresAt: credentials.expires,
      })

      deps.platform.logger?.info('GitHub Copilot OAuth completed successfully')
      return { success: true }
    } catch (error) {
      copilotOAuthAbort = null
      deps.platform.logger?.error('GitHub Copilot OAuth failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OAuth authentication failed',
      }
    }
  })

  // Cancel ongoing GitHub OAuth flow
  server.handle(RPC_CHANNELS.copilot.CANCEL_OAUTH, async (): Promise<{ success: boolean }> => {
    if (copilotOAuthAbort) {
      copilotOAuthAbort.abort()
      copilotOAuthAbort = null
      deps.platform.logger?.info('GitHub Copilot OAuth cancelled')
    }
    return { success: true }
  })

  // Get GitHub Copilot authentication status
  server.handle(RPC_CHANNELS.copilot.GET_AUTH_STATUS, async (_ctx, connectionSlug: string): Promise<{
    authenticated: boolean
  }> => {
    try {
      const credentialManager = getCredentialManager()
      const creds = await credentialManager.getLlmOAuth(connectionSlug)

      return {
        authenticated: !!creds?.accessToken,
      }
    } catch (error) {
      deps.platform.logger?.error('Failed to get GitHub auth status:', error)
      return { authenticated: false }
    }
  })

  // Logout from Copilot (clear stored tokens)
  server.handle(RPC_CHANNELS.copilot.LOGOUT, async (_ctx, connectionSlug: string): Promise<{ success: boolean }> => {
    try {
      const credentialManager = getCredentialManager()
      await credentialManager.deleteLlmCredentials(connectionSlug)
      deps.platform.logger?.info('Copilot credentials cleared')
      return { success: true }
    } catch (error) {
      deps.platform.logger?.error('Failed to clear Copilot credentials:', error)
      return { success: false }
    }
  })
}
