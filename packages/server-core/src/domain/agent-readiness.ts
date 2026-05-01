import type { AgentCatalogId, LlmConnection } from '@craft-agent/shared/config'

export interface AgentReadinessMessage {
  status: 'needs_setup' | 'broken'
  message: string
}

export interface CommandCandidate {
  command: string
  path?: string
  version?: string
  exists: boolean
}

export function isLegacyDroidBridge(connection: Pick<LlmConnection, 'agentId' | 'acpCommand' | 'acpArgs'> | undefined): boolean {
  if (connection?.agentId !== 'droid') return false
  return (connection.acpCommand ?? '') === 'agent-proxy'
    && JSON.stringify(connection.acpArgs ?? []) === JSON.stringify(['acp', '--agent', 'droid'])
}

export function compareVersionStrings(a: string | undefined, b: string | undefined): number {
  const left = (a ?? '').match(/\d+(?:\.\d+)*/)?.[0]?.split('.').map(Number) ?? []
  const right = (b ?? '').match(/\d+(?:\.\d+)*/)?.[0]?.split('.').map(Number) ?? []
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function selectPreferredCommand(candidates: CommandCandidate[]): CommandCandidate | undefined {
  return candidates
    .filter(candidate => candidate.exists)
    .sort((a, b) => compareVersionStrings(b.version, a.version))[0]
}

export function droidShadowWarning(active: CommandCandidate | undefined, preferred: CommandCandidate | undefined): string | undefined {
  if (!active?.exists || !preferred?.exists) return undefined
  if (!active.path || !preferred.path || active.path === preferred.path) return undefined
  if (compareVersionStrings(preferred.version, active.version) <= 0) return undefined
  return `Droid is installed, but PATH resolves ${active.path}${active.version ? ` (${active.version})` : ''} while newer ${preferred.path}${preferred.version ? ` (${preferred.version})` : ''} is available. New Droid connections will use ${preferred.path}.`
}

export function normalizeAgentReadinessError(agentId: AgentCatalogId, error: string): AgentReadinessMessage {
  const lower = error.toLowerCase()

  if (agentId === 'droid' && (
    lower.includes('authentication failed')
    || lower.includes('valid factory_api_key')
  )) {
    return {
      status: 'needs_setup',
      message: 'Droid rejected the saved Factory API key. Create a fresh Factory API key, save it in Droid setup, then re-check Droid.',
    }
  }

  if (agentId === 'droid' && (
    lower.includes('authentication required')
    || lower.includes('factory_api_key')
    || lower.includes('your code:')
    || lower.includes('device code')
  )) {
    return {
      status: 'needs_setup',
      message: 'Droid needs Factory authentication. Complete the device-code login in Factory, or set FACTORY_API_KEY for headless launches.',
    }
  }

  if (agentId === 'hermes' && (
    lower.includes('acp dependencies not installed')
    || lower.includes("pip install -e '.[acp]'")
    || lower.includes('agent-client-protocol')
  )) {
    return {
      status: 'needs_setup',
      message: "Hermes ACP support is missing. Install it with: ~/.hermes/hermes-agent/.venv/bin/python -m pip install --no-user -e '.[acp]'",
    }
  }

  return {
    status: 'broken',
    message: error,
  }
}
