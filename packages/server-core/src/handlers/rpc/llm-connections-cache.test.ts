import { describe, expect, it } from 'bun:test'
import { AGENT_CATALOG } from '@craft-agent/shared/config'
import {
  createAgentCatalogConnectionSignature,
  hydrateAgentCatalogStatusCache,
  type AgentCatalogStatusCache,
} from './llm-connections'

const visibleAgentIds = AGENT_CATALOG
  .filter(entry => entry.showInAgentManager !== false)
  .map(entry => entry.id)

function makeCache(overrides: Partial<AgentCatalogStatusCache> = {}): AgentCatalogStatusCache {
  return {
    version: 1,
    updatedAt: Date.now(),
    connectionSignature: createAgentCatalogConnectionSignature([]),
    statuses: visibleAgentIds.map(id => ({
      id,
      status: 'ready',
      installed: true,
      configured: true,
      ready: true,
      message: `${id} cached`,
    })),
    ...overrides,
  }
}

describe('agent catalog status cache', () => {
  it('hydrates cached readiness onto the current catalog entries', () => {
    const statuses = hydrateAgentCatalogStatusCache(makeCache(), [])

    expect(statuses?.map(status => status.id)).toEqual(visibleAgentIds)
    expect(statuses?.find(status => status.id === 'pi')?.name).toBe('Craft Agents Backend')
    expect(statuses?.find(status => status.id === 'codex')?.message).toBe('codex cached')
  })

  it('rejects stale cache entries when the configured connections changed', () => {
    const cache = makeCache({ connectionSignature: 'old-connections' })

    expect(hydrateAgentCatalogStatusCache(cache, [])).toBeNull()
  })

  it('rejects incomplete cache entries so new catalog agents are not hidden', () => {
    const cache = makeCache({
      statuses: makeCache().statuses.filter(status => status.id !== 'pi'),
    })

    expect(hydrateAgentCatalogStatusCache(cache, [])).toBeNull()
  })
})
