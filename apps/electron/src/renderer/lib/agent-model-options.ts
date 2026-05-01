import {
  getAvailableModelsForConnection,
  type LlmConnection,
} from '@config/llm-connections'
import { getModelShortName, type ModelDefinition } from '@config/models'

export type AgentModelEntry = ModelDefinition | string

export interface AgentDisplayInfo {
  group: string
  description: string
}

export function isConnectionReady(connection: Pick<LlmConnection, 'authType'> & { isAuthenticated?: boolean; agentStatus?: string }): boolean {
  if (connection.isAuthenticated === false) return false
  if (connection.agentStatus && connection.agentStatus !== 'ready') return false
  return true
}

const AGENT_GROUP_ORDER = [
  'Claude',
  'Craft Agents Backend',
  'Codex',
  'Droid',
  'Hermes',
  'Custom Agent',
]

function providerTypeOf(connection: LlmConnection) {
  return connection.providerType || 'anthropic'
}

export function getAgentDisplayInfo(connection: LlmConnection): AgentDisplayInfo {
  if (connection.agentId === 'codex') return { group: 'Codex', description: 'Local Codex app server' }
  if (connection.agentId === 'droid') return { group: 'Droid', description: 'Factory Droid' }
  if (connection.agentId === 'hermes') return { group: 'Hermes', description: 'Hermes Agent' }
  switch (providerTypeOf(connection)) {
    case 'anthropic':
      return { group: 'Claude', description: 'Anthropic API' }
    case 'anthropic_compat':
      return { group: 'Claude', description: 'Anthropic-compatible endpoint' }
    case 'bedrock':
      return { group: 'Claude', description: 'AWS Bedrock' }
    case 'vertex':
      return { group: 'Claude', description: 'Google Vertex AI' }
    case 'pi':
      return { group: 'Craft Agents Backend', description: 'Craft Agents Backend' }
    case 'pi_compat':
      return { group: 'Craft Agents Backend', description: 'Craft Agents compatible endpoint' }
    case 'codex':
      return { group: 'Codex', description: 'Local Codex app server' }
    case 'acp':
      return { group: 'ACP Gateway', description: 'Local ACP-compatible agent gateway; capabilities depend on the child agent' }
    default:
      return { group: 'Custom Agent', description: providerTypeOf(connection) }
  }
}

export function getModelEntriesForConnection(connection: LlmConnection | undefined): AgentModelEntry[] {
  if (!connection) return []
  return getAvailableModelsForConnection(connection)
}

export function getModelId(model: AgentModelEntry): string {
  return typeof model === 'string' ? model : model.id
}

export function getModelName(model: AgentModelEntry): string {
  return typeof model === 'string' ? getModelShortName(model) : model.name
}

export function getModelDescription(model: AgentModelEntry): string {
  return typeof model === 'string' ? '' : model.description
}

export function getSettingsModelOptions(
  connection: LlmConnection | undefined,
): Array<{ value: string; label: string; description: string }> {
  return getModelEntriesForConnection(connection).map((model) => ({
    value: getModelId(model),
    label: getModelName(model),
    description: getModelDescription(model),
  }))
}

export function groupConnectionsByAgent<T extends LlmConnection>(connections: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()

  for (const connection of connections) {
    const group = getAgentDisplayInfo(connection).group
    const existing = groups.get(group)
    if (existing) {
      existing.push(connection)
    } else {
      groups.set(group, [connection])
    }
  }

  return Array.from(groups.entries()).sort(([left], [right]) => {
    const leftIndex = AGENT_GROUP_ORDER.indexOf(left)
    const rightIndex = AGENT_GROUP_ORDER.indexOf(right)
    const normalizedLeft = leftIndex === -1 ? AGENT_GROUP_ORDER.length : leftIndex
    const normalizedRight = rightIndex === -1 ? AGENT_GROUP_ORDER.length : rightIndex
    return normalizedLeft - normalizedRight || left.localeCompare(right)
  })
}
