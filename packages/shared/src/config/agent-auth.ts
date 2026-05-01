import type { LlmConnection } from './llm-connections.ts';

export const DROID_FACTORY_API_KEY_ENV = 'FACTORY_API_KEY';
export const DROID_FACTORY_API_KEY_URL = 'https://app.factory.ai/settings/api-keys';

export function isDroidAgentConnection(
  connection: Pick<LlmConnection, 'agentId' | 'providerType' | 'slug' | 'name' | 'acpCommand' | 'acpArgs'> | null | undefined,
): boolean {
  if (!connection) return false;
  if (connection.agentId === 'droid') return true;
  if (connection.providerType !== 'acp') return false;
  if (connection.slug === 'droid') return true;

  const command = (connection.acpCommand || '').toLowerCase();
  const args = (connection.acpArgs || []).join(' ').toLowerCase();
  const name = connection.name.toLowerCase();
  return command.includes('droid') || args.includes('droid') || name.includes('droid');
}

