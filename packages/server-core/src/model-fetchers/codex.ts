import { CodexAgent } from '@craft-agent/shared/agent'
import type { LlmConnection, ModelDefinition, ModelFetcher, ModelFetchResult, ModelFetcherCredentials } from '@craft-agent/shared/config'

function normalizeModel(value: unknown): ModelDefinition | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string'
    ? raw.id
    : typeof raw.model === 'string'
      ? raw.model
      : undefined
  if (!id) return null
  const name = typeof raw.name === 'string' ? raw.name : id
  return {
    id,
    name,
    shortName: name,
    description: '',
    provider: 'codex',
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : 272_000,
    supportsThinking: true,
  }
}

export class CodexModelFetcher implements ModelFetcher {
  readonly refreshIntervalMs = 0

  async fetchModels(
    connection: LlmConnection,
    _credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult> {
    const rawModels = await CodexAgent.fetchAvailableModels({
      command: connection.codexCommand || 'codex',
      args: connection.codexArgs || ['app-server', '--listen', 'stdio://'],
      timeoutMs: 30_000,
    })
    const models = rawModels.map(normalizeModel).filter((m): m is ModelDefinition => !!m)
    return {
      models: models.length > 0
        ? models
        : [{
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          shortName: 'GPT-5.5',
          description: 'Codex app-server default model',
          provider: 'codex',
          contextWindow: 272_000,
          supportsThinking: true,
        }],
      serverDefault: models[0]?.id,
    }
  }
}
