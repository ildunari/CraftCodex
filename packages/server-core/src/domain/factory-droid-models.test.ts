import { describe, expect, it } from 'bun:test'
import {
  mergeDroidModels,
  mergeFactoryDroidModelConfigs,
  parseFactoryDroidModelConfig,
} from './factory-droid-models'

describe('Factory Droid model config', () => {
  it('parses BYOK custom models without exposing API key fields', () => {
    const result = parseFactoryDroidModelConfig({
      model: 'custom:gpt-5.4-medium',
      customModels: [
        {
          id: 'custom:gpt-5.4-medium',
          model: 'gpt-5.4-medium',
          displayName: 'GPT-5.4 (Medium)',
          provider: 'openai',
          apiKey: 'secret',
          maxContextLimit: 300000,
        },
        {
          model: 'glm-5.1',
          displayName: 'GLM-5.1',
          provider: 'generic-chat-completion-api',
        },
      ],
    })

    expect(result.defaultModel).toBe('custom:gpt-5.4-medium')
    expect(result.models.map(model => model.id)).toEqual(['custom:gpt-5.4-medium', 'custom:glm-5.1'])
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.models[0]?.contextWindow).toBe(300000)
  })

  it('uses the session default Droid model when top-level model is absent', () => {
    const result = parseFactoryDroidModelConfig({
      sessionDefaultSettings: {
        model: 'custom:gpt-5.4-medium',
      },
      customModels: [],
    })

    expect(result.defaultModel).toBe('custom:gpt-5.4-medium')
  })

  it('merges base Droid models with BYOK models without duplicates', () => {
    const merged = mergeDroidModels(['claude-opus-4-6', 'custom:gpt-5.4-medium'], [
      {
        id: 'custom:gpt-5.4-medium',
        name: 'GPT-5.4 (Medium)',
        shortName: 'GPT-5.4 (Medium)',
        description: 'Factory BYOK (openai)',
        provider: 'acp',
        contextWindow: 300000,
      },
      {
        id: 'custom:glm-5.1',
        name: 'GLM-5.1',
        shortName: 'GLM-5.1',
        description: 'Factory BYOK',
        provider: 'acp',
        contextWindow: 128000,
      },
    ])

    expect(merged.map(model => typeof model === 'string' ? model : model.id)).toEqual([
      'claude-opus-4-6',
      'custom:gpt-5.4-medium',
      'custom:glm-5.1',
    ])
  })

  it('lets settings.local default override settings default', () => {
    const merged = mergeFactoryDroidModelConfigs([
      { models: [], defaultModel: 'custom:first' },
      { models: [], defaultModel: 'custom:second' },
    ])

    expect(merged.defaultModel).toBe('custom:second')
  })
})
