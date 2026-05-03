import { describe, it, expect } from 'bun:test'
import '../../../tests/setup/register-pi-model-resolver.ts'
import {
  AGENT_CATALOG,
  createConnectionForAgent,
} from '../agent-catalog'
import {
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  getAvailableModelsForConnection,
  isModelAvailableForConnection,
  isCompatProvider,
  isAnthropicProvider,
  isPiProvider,
  isAcpProvider,
  isCodexProvider,
  toBedrockNativeId,
  fromBedrockNativeId,
  normalizeBedrockModelId,
  getModelDefinitionForConnection,
  getConnectionModelContextWindow,
  getConnectionModelSupportsThinking,
} from '../llm-connections'
import type { LlmConnection } from '../llm-connections'
import { ANTHROPIC_MODELS, getModelDisplayName, getModelContextWindow, getModelShortName, isClaudeModel } from '../models'

// ============================================================
// getDefaultModelsForConnection
// ============================================================

describe('getDefaultModelsForConnection', () => {
  it('anthropic returns ANTHROPIC_MODELS (ModelDefinition[])', () => {
    const models = getDefaultModelsForConnection('anthropic')
    expect(models).toEqual(ANTHROPIC_MODELS)
    expect(models.length).toBeGreaterThan(0)
    // Verify they are ModelDefinition objects, not strings
    const first = models[0]!
    expect(typeof first).toBe('object')
    expect(typeof (first as any).id).toBe('string')
  })

  it('bedrock returns bare Anthropic models (same as anthropic)', () => {
    // providerType==='bedrock' is not the Pi SDK Bedrock path — it keeps bare IDs
    expect(getDefaultModelsForConnection('bedrock')).toEqual(ANTHROPIC_MODELS)
  })

  it('vertex returns same models as anthropic', () => {
    expect(getDefaultModelsForConnection('vertex')).toEqual(ANTHROPIC_MODELS)
  })

  it('pi with piAuthProvider returns filtered models', () => {
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    expect(models.length).toBeGreaterThan(0)
    // All should have pi/ prefix in their id
    for (const m of models) {
      const id = typeof m === 'string' ? m : m.id
      expect(id.startsWith('pi/')).toBe(true)
    }
  })

  it('pi without piAuthProvider returns all Pi models', () => {
    const models = getDefaultModelsForConnection('pi')
    expect(models.length).toBeGreaterThan(0)
  })

  it('anthropic_compat returns empty list (dynamic provider)', () => {
    const models = getDefaultModelsForConnection('anthropic_compat')
    expect(models).toEqual([])
  })

  it('acp returns empty list (command-backed dynamic provider)', () => {
    const models = getDefaultModelsForConnection('acp')
    expect(models).toEqual([])
  })

  it('codex returns native app-server defaults', () => {
    const models = getDefaultModelsForConnection('codex')
    expect(models.map(m => typeof m === 'string' ? m : m.id)).toContain('gpt-5.5')
  })
})

// ============================================================
// getDefaultModelForConnection
// ============================================================

describe('getDefaultModelForConnection', () => {
  it('returns first model ID for anthropic', () => {
    const modelId = getDefaultModelForConnection('anthropic')
    expect(typeof modelId).toBe('string')
    expect(modelId.length).toBeGreaterThan(0)
    // Should match the first ANTHROPIC_MODELS entry
    expect(modelId).toBe(ANTHROPIC_MODELS[0]!.id)
  })

  // Regression: Pi 'anthropic' default must be present in its own model list
  it('regression: Pi anthropic default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'anthropic')
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi openai default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'openai')
    const models = getDefaultModelsForConnection('pi', 'openai')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('returns empty string for anthropic_compat (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('anthropic_compat')
    expect(defaultModel).toBe('')
  })

  it('returns empty string for pi_compat (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('pi_compat')
    expect(defaultModel).toBe('')
  })

  it('returns empty string for acp (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('acp')
    expect(defaultModel).toBe('')
  })

  it('returns gpt-5.5 for codex', () => {
    expect(getDefaultModelForConnection('codex')).toBe('gpt-5.5')
  })
})

// ============================================================
// getAvailableModelsForConnection / isModelAvailableForConnection
// ============================================================

function testConnection(overrides: Partial<LlmConnection>): LlmConnection {
  return {
    slug: overrides.slug ?? 'test',
    name: overrides.name ?? 'Test',
    providerType: overrides.providerType ?? 'anthropic',
    authType: overrides.authType ?? 'api_key',
    createdAt: 1,
    ...overrides,
  }
}

describe('connection model availability', () => {
  it('prefers explicit connection models over provider defaults', () => {
    const connection = testConnection({
      providerType: 'codex',
      models: ['gpt-5.5', 'gpt-5.5-low'],
    })

    expect(getAvailableModelsForConnection(connection)).toEqual(['gpt-5.5', 'gpt-5.5-low'])
    expect(isModelAvailableForConnection(connection, 'gpt-5.5-low')).toBe(true)
    expect(isModelAvailableForConnection(connection, 'claude-sonnet-4-6')).toBe(false)
  })

  it('keeps ACP closed unless the connection declares a model', () => {
    const connection = testConnection({ providerType: 'acp' })

    expect(getAvailableModelsForConnection(connection)).toEqual([])
    expect(isModelAvailableForConnection(connection, 'droid-pro')).toBe(false)
  })

  it('allows a fixed connection default model when no list is available', () => {
    const connection = testConnection({
      providerType: 'acp',
      defaultModel: 'droid-pro',
    })

    expect(getAvailableModelsForConnection(connection)).toEqual(['droid-pro'])
    expect(isModelAvailableForConnection(connection, 'droid-pro')).toBe(true)
  })

  it('falls back to static provider defaults for Codex', () => {
    const connection = testConnection({ providerType: 'codex' })

    expect(isModelAvailableForConnection(connection, 'gpt-5.5')).toBe(true)
  })
})

describe('curated agent catalog', () => {
  it('exposes Craft Agents Backend as the default Pi/OpenAI-Codex agent', () => {
    const pi = AGENT_CATALOG.find(agent => agent.id === 'pi')!
    const connection = createConnectionForAgent(pi)

    expect(pi.showInAgentManager).toBe(true)
    expect(connection).toMatchObject({
      slug: 'craft-agents-backend',
      name: 'Craft Agents Backend',
      agentId: 'pi',
      providerType: 'pi',
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      defaultModel: 'pi/gpt-5.2',
      modelSelectionMode: 'automaticallySyncedFromProvider',
    })
    expect(connection.slug).not.toBe('pi-api-key')
  })

  it('creates Hermes as a first-party ACP-backed connection', () => {
    const hermes = AGENT_CATALOG.find(agent => agent.id === 'hermes')!
    const connection = createConnectionForAgent(hermes)

    expect(connection).toMatchObject({
      slug: 'hermes',
      name: 'Hermes',
      agentId: 'hermes',
      providerType: 'acp',
      authType: 'none',
      acpCommand: 'hermes',
      acpArgs: ['acp', '--accept-hooks'],
      defaultModel: 'gpt-5.5',
    })
    expect(hermes.commandProbes).toEqual([
      { command: 'hermes', args: ['acp', '--help'], label: 'Hermes ACP mode' },
    ])
  })

  it('keeps Droid curated above ACP transport details', () => {
    const droid = AGENT_CATALOG.find(agent => agent.id === 'droid')!
    const connection = createConnectionForAgent(droid)

    expect(droid.name).toBe('Droid')
    expect(droid.providerType).toBe('acp')
    expect(droid.defaultCommand).toBe('droid')
    expect(droid.defaultArgs).toEqual(['exec', '--output-format', 'acp'])
    expect(droid.requiredCommands).toEqual(['droid'])
    expect(droid.models).toEqual(['claude-opus-4-7', 'gpt-5.4', 'gpt-5.3-codex', 'glm-5.1'])
    expect(droid.defaultModel).toBe('claude-opus-4-7')
    expect(droid.commandProbes).toEqual([
      { command: 'droid', args: ['exec', '--help'], label: 'Droid direct ACP mode' },
    ])
    expect(connection.acpCommand).toBe('droid')
    expect(connection.acpArgs).toEqual(['exec', '--output-format', 'acp'])
  })

  it('probes Codex through its app-server entrypoint', () => {
    const codex = AGENT_CATALOG.find(agent => agent.id === 'codex')!

    expect(codex.defaultArgs).toEqual(['app-server', '--listen', 'stdio://'])
    expect(codex.commandProbes).toEqual([
      { command: 'codex', args: ['app-server', '--help'], label: 'Codex app-server' },
    ])
  })
})

// ============================================================
// Provider type guards
// ============================================================

describe('isCompatProvider', () => {
  it('returns true for anthropic_compat', () => {
    expect(isCompatProvider('anthropic_compat')).toBe(true)
  })

  it('returns true for pi_compat', () => {
    expect(isCompatProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isCompatProvider('anthropic')).toBe(false)
  })

  it('returns false for pi', () => {
    expect(isCompatProvider('pi')).toBe(false)
  })
})

describe('isAnthropicProvider', () => {
  it('returns true for anthropic', () => {
    expect(isAnthropicProvider('anthropic')).toBe(true)
  })

  it('returns true for anthropic_compat', () => {
    expect(isAnthropicProvider('anthropic_compat')).toBe(true)
  })

  it('returns true for bedrock', () => {
    expect(isAnthropicProvider('bedrock')).toBe(true)
  })

  it('returns true for vertex', () => {
    expect(isAnthropicProvider('vertex')).toBe(true)
  })

  it('returns false for pi', () => {
    expect(isAnthropicProvider('pi')).toBe(false)
  })
})

describe('isPiProvider', () => {
  it('returns true for pi', () => {
    expect(isPiProvider('pi')).toBe(true)
  })

  it('returns true for pi_compat', () => {
    expect(isPiProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isPiProvider('anthropic')).toBe(false)
  })
})

describe('isAcpProvider', () => {
  it('returns true for acp', () => {
    expect(isAcpProvider('acp')).toBe(true)
  })

  it('returns false for pi', () => {
    expect(isAcpProvider('pi')).toBe(false)
  })
})

describe('isCodexProvider', () => {
  it('returns true for codex', () => {
    expect(isCodexProvider('codex')).toBe(true)
  })

  it('returns false for acp', () => {
    expect(isCodexProvider('acp')).toBe(false)
  })
})

describe('connection-scoped model metadata', () => {
  const compatConnection = {
    models: [
      {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        shortName: 'GLM-5.1',
        description: 'Z.AI flagship coding model',
        provider: 'anthropic' as const,
        contextWindow: 204_800,
        supportsThinking: true,
      },
    ],
  }

  it('prefers connection model definitions for custom compat models', () => {
    expect(getModelDefinitionForConnection(compatConnection, 'glm-5.1')).toMatchObject({
      id: 'glm-5.1',
      contextWindow: 204_800,
      supportsThinking: true,
    })
  })

  it('resolves context window from connection models when registry has no entry', () => {
    expect(getConnectionModelContextWindow(compatConnection, 'glm-5.1')).toBe(204_800)
  })

  it('resolves supportsThinking from connection models when registry has no entry', () => {
    expect(getConnectionModelSupportsThinking(compatConnection, 'glm-5.1')).toBe(true)
  })

  it('falls back to registry metadata for built-in Claude models', () => {
    expect(getConnectionModelContextWindow({ models: [] }, 'claude-opus-4-6')).toBe(1_000_000)
    expect(getConnectionModelSupportsThinking({ models: [] }, 'claude-opus-4-6')).toBeUndefined()
  })
})

// ============================================================
// Bedrock model ID mapping
// ============================================================

describe('toBedrockNativeId', () => {
  it('maps bare Anthropic IDs to US inference profile IDs', () => {
    expect(toBedrockNativeId('claude-opus-4-6')).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(toBedrockNativeId('claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
    expect(toBedrockNativeId('claude-haiku-4-5-20251001')).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
  })

  it('maps base Bedrock IDs to US inference profile IDs', () => {
    expect(toBedrockNativeId('anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(toBedrockNativeId('anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('passes through already US-prefixed IDs', () => {
    expect(toBedrockNativeId('us.anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  it('passes through unknown IDs', () => {
    expect(toBedrockNativeId('some-custom-model')).toBe('some-custom-model')
    expect(toBedrockNativeId('gpt-5')).toBe('gpt-5')
  })
})

describe('fromBedrockNativeId', () => {
  it('maps US inference profile IDs back to bare Anthropic', () => {
    expect(fromBedrockNativeId('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
    expect(fromBedrockNativeId('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(fromBedrockNativeId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5-20251001')
  })

  it('maps EU/Global inference profile IDs back to bare', () => {
    expect(fromBedrockNativeId('eu.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
    expect(fromBedrockNativeId('global.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
  })

  it('maps base Bedrock IDs back to bare', () => {
    expect(fromBedrockNativeId('anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
  })

  it('passes through bare IDs', () => {
    expect(fromBedrockNativeId('claude-opus-4-6')).toBe('claude-opus-4-6')
  })
})

describe('normalizeBedrockModelId', () => {
  it('strips pi/ prefix and maps to US inference profile', () => {
    expect(normalizeBedrockModelId('pi/claude-opus-4-6')).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(normalizeBedrockModelId('pi/claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('maps bare IDs to US inference profile', () => {
    expect(normalizeBedrockModelId('claude-opus-4-6')).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  it('maps base Bedrock IDs to US inference profile', () => {
    expect(normalizeBedrockModelId('anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  it('is idempotent for already US-prefixed IDs', () => {
    expect(normalizeBedrockModelId('us.anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  it('handles empty/undefined', () => {
    expect(normalizeBedrockModelId(undefined)).toBe('')
    expect(normalizeBedrockModelId('')).toBe('')
  })
})

// ============================================================
// Bedrock-aware display and lookup
// ============================================================

describe('Bedrock-native model display', () => {
  it('getModelDisplayName resolves US inference profile IDs', () => {
    expect(getModelDisplayName('us.anthropic.claude-opus-4-6-v1')).toBe('Opus 4.6')
    expect(getModelDisplayName('us.anthropic.claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(getModelDisplayName('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5')
  })

  it('getModelDisplayName resolves EU/base Bedrock IDs', () => {
    expect(getModelDisplayName('eu.anthropic.claude-opus-4-6-v1')).toBe('Opus 4.6')
    expect(getModelDisplayName('anthropic.claude-opus-4-6-v1')).toBe('Opus 4.6')
  })

  it('getModelShortName resolves Bedrock IDs', () => {
    expect(getModelShortName('us.anthropic.claude-opus-4-6-v1')).toBe('Opus')
    expect(getModelShortName('us.anthropic.claude-sonnet-4-6')).toBe('Sonnet')
  })

  it('getModelContextWindow resolves Bedrock IDs', () => {
    expect(getModelContextWindow('us.anthropic.claude-opus-4-6-v1')).toBe(200_000)
    expect(getModelContextWindow('us.anthropic.claude-sonnet-4-6')).toBe(200_000)
  })

  it('isClaudeModel recognizes Bedrock IDs', () => {
    expect(isClaudeModel('us.anthropic.claude-opus-4-6-v1')).toBe(true)
    expect(isClaudeModel('anthropic.claude-sonnet-4-6')).toBe(true)
    expect(isClaudeModel('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true)
  })
})
