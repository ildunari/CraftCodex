import type { ProviderDriver } from '../driver-types.ts';
import type { LlmConnection } from '../../../../config/storage.ts';
import { getAgentCatalogEntry } from '../../../../config/agent-catalog.ts';
import { DROID_FACTORY_API_KEY_ENV, isDroidAgentConnection } from '../../../../config/agent-auth.ts';
import { homedir } from 'node:os';

function acpArgsForConnection(connection: Pick<LlmConnection, 'agentId' | 'acpArgs'> | null | undefined): string[] {
  if (connection?.acpArgs?.length) return connection.acpArgs;
  const catalogArgs = getAgentCatalogEntry(connection?.agentId)?.defaultArgs;
  if (catalogArgs?.length) return catalogArgs;
  return ['acp', '--agent', 'codex'];
}

function acpCommandForConnection(connection: Pick<LlmConnection, 'agentId' | 'acpCommand'> | null | undefined): string {
  if (connection?.acpCommand) return connection.acpCommand;
  return getAgentCatalogEntry(connection?.agentId)?.defaultCommand || 'agent-proxy';
}

export const acpDriver: ProviderDriver = {
  provider: 'acp',

  buildRuntime({ context }) {
    const connection = context.connection;
    return {
      acpCommand: acpCommandForConnection(connection),
      acpArgs: acpArgsForConnection(connection),
      acpName: connection?.name || 'ACP Agent',
      nativeCapabilityPolicy: connection?.nativeCapabilityPolicy,
    };
  },

  async validateStoredConnection({ slug, connection, credentialManager }) {
    const { AcpAgent } = await import('../../../acp-agent.ts');
    const rootPath = homedir();
    const factoryApiKey = isDroidAgentConnection(connection)
      ? await credentialManager.getLlmApiKey(slug)
      : null;
    const agent = new AcpAgent({
      provider: 'acp',
      providerType: 'acp',
      authType: 'none',
      workspace: {
        id: '__acp-health',
        name: 'ACP Health Check',
        slug: '__acp-health',
        rootPath,
        createdAt: 0,
      },
      session: {
        id: `acp-health-${Date.now()}`,
        workspaceRootPath: rootPath,
        createdAt: 0,
        lastUsedAt: 0,
      },
      isHeadless: true,
      model: connection.defaultModel,
      runtime: {
        acpCommand: acpCommandForConnection(connection),
        acpArgs: acpArgsForConnection(connection),
      },
      envOverrides: factoryApiKey
        ? { [DROID_FACTORY_API_KEY_ENV]: factoryApiKey }
        : undefined,
    });

    try {
      await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ACP health check timed out')), 10_000)
        ),
      ]);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      agent.destroy();
    }
  },

  async testConnection({ apiKey, connection, model, timeoutMs }) {
    const { AcpAgent } = await import('../../../acp-agent.ts');
    const rootPath = homedir();
    const factoryApiKey = connection && isDroidAgentConnection({
      ...connection,
      slug: 'droid',
      name: 'Droid',
    })
      ? apiKey.trim()
      : '';
    const agent = new AcpAgent({
      provider: 'acp',
      providerType: 'acp',
      authType: 'none',
      workspace: {
        id: '__acp-test',
        name: 'ACP Test',
        slug: '__acp-test',
        rootPath,
        createdAt: 0,
      },
      session: {
        id: `acp-test-${Date.now()}`,
        workspaceRootPath: rootPath,
        createdAt: 0,
        lastUsedAt: 0,
      },
      isHeadless: true,
      model,
      runtime: {
        acpCommand: acpCommandForConnection(connection),
        acpArgs: acpArgsForConnection(connection),
      },
      envOverrides: factoryApiKey
        ? { [DROID_FACTORY_API_KEY_ENV]: factoryApiKey }
        : undefined,
    });

    try {
      await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ACP health check timed out')), timeoutMs)
        ),
      ]);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      agent.destroy();
    }
  },
};
