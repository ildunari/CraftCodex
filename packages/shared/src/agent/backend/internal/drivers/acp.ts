import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

import type { ProviderDriver } from '../driver-types.ts';
import type { LlmConnection } from '../../../../config/storage.ts';
import { getAgentCatalogEntry } from '../../../../config/agent-catalog.ts';
import { DROID_FACTORY_API_KEY_ENV, isDroidAgentConnection } from '../../../../config/agent-auth.ts';

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

/**
 * Per-process cache: probe results for `${command}:${args.join(' ')}`.
 * Probes are cheap (sub-second) but firing them on every test/health-check
 * adds visible latency in agent-manager UIs, so we memoize the boolean
 * outcome for the lifetime of the process.
 */
const probeCache = new Map<string, Promise<boolean>>();

function probeKey(command: string, args: string[] | undefined): string {
  return `${command}:${(args ?? []).join(' ')}`;
}

async function runProbe(command: string, args: string[], timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Run `commandProbes` declared in the agent catalog at registration / health-check
 * time. Memoized per (command, args) so repeated calls are free.
 *
 * Result: `true` if every probe succeeded, `false` otherwise. Probe failure is
 * logged via console.warn but does NOT abort the connection — the caller
 * decides what to do with the result.
 */
export async function runCommandProbes(connection: Pick<LlmConnection, 'agentId'> | null | undefined): Promise<boolean> {
  const probes = getAgentCatalogEntry(connection?.agentId)?.commandProbes;
  if (!probes?.length) return true;

  for (const probe of probes) {
    const key = probeKey(probe.command, probe.args);
    let pending = probeCache.get(key);
    if (!pending) {
      pending = runProbe(probe.command, probe.args ?? []);
      probeCache.set(key, pending);
    }
    const ok = await pending;
    if (!ok) {
      probeCache.delete(key); // allow retry next time
      // eslint-disable-next-line no-console
      console.warn(`[acp] commandProbe failed: ${probe.label ?? probe.command} (${probe.command} ${probe.args?.join(' ') ?? ''})`);
      return false;
    }
  }
  return true;
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
    const probesOk = await runCommandProbes(connection);
    if (!probesOk) {
      return {
        success: false,
        error: 'ACP agent command not installed or failed its catalog command-probe',
      };
    }
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
          setTimeout(() => reject(new Error('ACP health check timed out')), 60_000)
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
    const probesOk = await runCommandProbes(connection);
    if (!probesOk) {
      return {
        success: false,
        error: 'ACP agent command not installed or failed its catalog command-probe',
      };
    }
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
