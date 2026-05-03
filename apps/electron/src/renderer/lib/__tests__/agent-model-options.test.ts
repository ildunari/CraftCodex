import { describe, expect, it } from 'bun:test'
import type { LlmConnection } from '@config/llm-connections'
import {
  getAgentDisplayInfo,
  getModelEntriesForConnection,
  getSettingsModelOptions,
  groupConnectionsByAgent,
  isConnectionReady,
} from '../agent-model-options'

function connection(overrides: Partial<LlmConnection>): LlmConnection {
  return {
    slug: overrides.slug ?? 'test',
    name: overrides.name ?? 'Test',
    providerType: overrides.providerType ?? 'anthropic',
    authType: overrides.authType ?? 'api_key',
    createdAt: 1,
    ...overrides,
  }
}

describe('agent-model-options', () => {
  it('uses explicit connection models before provider defaults', () => {
    const conn = connection({
      providerType: 'acp',
      models: [
        { id: 'droid-pro', name: 'Droid Pro', shortName: 'Droid', description: 'Factory Droid', provider: 'acp', contextWindow: 128000 },
      ],
    })

    expect(getSettingsModelOptions(conn)).toEqual([
      { value: 'droid-pro', label: 'Droid Pro', description: 'Factory Droid' },
    ])
  })

  it('keeps dynamic ACP agents empty when they do not advertise models', () => {
    expect(getModelEntriesForConnection(connection({ providerType: 'acp' }))).toEqual([])
  })

  it('falls back to the native Codex app-server default model', () => {
    expect(getSettingsModelOptions(connection({ providerType: 'codex' }))).toEqual([
      { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Codex app-server default model' },
    ])
  })

  it('groups connections by backend agent', () => {
    const groups = groupConnectionsByAgent([
      connection({ slug: 'acp', providerType: 'acp' }),
      connection({ slug: 'codex', providerType: 'codex' }),
      connection({ slug: 'hermes', providerType: 'acp', agentId: 'hermes' }),
      connection({ slug: 'pi', providerType: 'pi' }),
      connection({ slug: 'anthropic', providerType: 'anthropic' }),
    ])

    expect(groups.map(([name]) => name)).toEqual([
      'Claude',
      'Craft Agents Backend',
      'Codex',
      'Hermes',
      'ACP Gateway',
    ])
  })

  it('keeps existing Pi OpenAI-Codex models under Craft Agents Backend', () => {
    const conn = connection({
      slug: 'chatgpt-plus-2',
      name: 'ChatGPT Pro',
      providerType: 'pi',
      authType: 'oauth',
      piAuthProvider: 'openai-codex',
      models: [
        { id: 'pi/gpt-5.2', name: 'GPT-5.2', shortName: 'GPT-5.2', description: 'openai-codex model via Craft Agents Backend', provider: 'pi', contextWindow: 272000 },
        { id: 'pi/gpt-5.3-codex', name: 'GPT-5.3 Codex', shortName: 'GPT-5.3 Codex', description: 'openai-codex model via Craft Agents Backend', provider: 'pi', contextWindow: 272000 },
      ],
    })

    expect(getAgentDisplayInfo(conn).group).toBe('Craft Agents Backend')
    expect(getSettingsModelOptions(conn).map(option => option.value)).toEqual([
      'pi/gpt-5.2',
      'pi/gpt-5.3-codex',
    ])
  })

  it('describes non-Claude agents for settings rows', () => {
    expect(getAgentDisplayInfo(connection({ providerType: 'codex', agentId: 'codex' })).description).toBe('Local Codex app server')
    expect(getAgentDisplayInfo(connection({ providerType: 'codex' })).group).toBe('Codex')
    expect(getAgentDisplayInfo(connection({ providerType: 'acp' })).description).toBe('Local ACP-compatible agent gateway; capabilities depend on the child agent')
    expect(getAgentDisplayInfo(connection({ providerType: 'acp', agentId: 'hermes' })).description).toBe('Hermes Agent')
  })

  it('only treats ready agent connections as selectable', () => {
    expect(isConnectionReady({ authType: 'none', isAuthenticated: true, agentStatus: 'ready' })).toBe(true)
    expect(isConnectionReady({ authType: 'none', isAuthenticated: false, agentStatus: 'not_installed' })).toBe(false)
    expect(isConnectionReady({ authType: 'none', isAuthenticated: true, agentStatus: 'broken' })).toBe(false)
    expect(isConnectionReady({ authType: 'none', isAuthenticated: undefined })).toBe(true)
  })
})
