import type { ProviderDriver } from '../driver-types.ts';
import type { ModelDefinition } from '../../../../config/models.ts';

function normalizeModel(value: unknown): ModelDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string'
    ? raw.id
    : typeof raw.model === 'string'
      ? raw.model
      : undefined;
  if (!id) return null;
  const name = typeof raw.name === 'string' ? raw.name : id;
  const contextWindow =
    typeof raw.contextWindow === 'number'
      ? raw.contextWindow
      : typeof raw.context_window === 'number'
        ? raw.context_window
        : 272_000;
  return {
    id,
    name,
    shortName: name,
    description: '',
    provider: 'codex',
    contextWindow,
    supportsThinking: true,
  };
}

export const codexDriver: ProviderDriver = {
  provider: 'codex',

  buildRuntime({ context }) {
    const connection = context.connection;
    return {
      codexCommand: connection?.codexCommand || 'codex',
      codexArgs: connection?.codexArgs || ['app-server', '--listen', 'stdio://'],
      codexName: connection?.name || 'Codex App Server',
      nativeCapabilityPolicy: connection?.nativeCapabilityPolicy,
    };
  },

  async fetchModels({ connection, timeoutMs }) {
    const { CodexAgent } = await import('../../../codex-agent.ts');
    const models = await CodexAgent.fetchAvailableModels({
      command: connection.codexCommand || 'codex',
      args: connection.codexArgs || ['app-server', '--listen', 'stdio://'],
      timeoutMs,
    });
    const normalized = models.map(normalizeModel).filter((m): m is ModelDefinition => !!m);
    return {
      models: normalized.length > 0
        ? normalized
        : [{
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          shortName: 'GPT-5.5',
          description: 'Codex app-server default model',
          provider: 'codex',
          contextWindow: 272_000,
          supportsThinking: true,
        }],
      serverDefault: normalized[0]?.id,
    };
  },

  async validateStoredConnection({ connection }) {
    try {
      const { CodexAgent } = await import('../../../codex-agent.ts');
      await CodexAgent.fetchAvailableModels({
        command: connection.codexCommand || 'codex',
        args: connection.codexArgs || ['app-server', '--listen', 'stdio://'],
        timeoutMs: 10_000,
      });
      return { success: true, shouldRefreshModels: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async testConnection({ connection, timeoutMs }) {
    try {
      const { CodexAgent } = await import('../../../codex-agent.ts');
      await CodexAgent.fetchAvailableModels({
        command: connection?.codexCommand || 'codex',
        args: connection?.codexArgs || ['app-server', '--listen', 'stdio://'],
        timeoutMs,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
