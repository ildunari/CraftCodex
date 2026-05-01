import { describe, expect, it } from 'bun:test'
import {
  compareVersionStrings,
  droidShadowWarning,
  isLegacyDroidBridge,
  normalizeAgentReadinessError,
  selectPreferredCommand,
} from './agent-readiness'

describe('agent readiness helpers', () => {
  it('selects the newest available Droid command candidate', () => {
    const preferred = selectPreferredCommand([
      { command: 'droid', path: '/Users/Kosta/.local/bin/droid', version: '0.96.2', exists: true },
      { command: '/Users/Kosta/.npm-global/bin/droid', path: '/Users/Kosta/.npm-global/bin/droid', version: '0.113.0', exists: true },
    ])

    expect(preferred?.path).toBe('/Users/Kosta/.npm-global/bin/droid')
    expect(compareVersionStrings('0.113.0', '0.96.2')).toBeGreaterThan(0)
  })

  it('warns when PATH shadows a newer Droid binary', () => {
    const warning = droidShadowWarning(
      { command: 'droid', path: '/Users/Kosta/.local/bin/droid', version: '0.96.2', exists: true },
      { command: '/Users/Kosta/.npm-global/bin/droid', path: '/Users/Kosta/.npm-global/bin/droid', version: '0.113.0', exists: true },
    )

    expect(warning).toContain('PATH resolves /Users/Kosta/.local/bin/droid')
    expect(warning).toContain('newer /Users/Kosta/.npm-global/bin/droid')
  })

  it('detects only the legacy Droid agent-proxy bridge default', () => {
    expect(isLegacyDroidBridge({
      agentId: 'droid',
      acpCommand: 'agent-proxy',
      acpArgs: ['acp', '--agent', 'droid'],
    })).toBe(true)

    expect(isLegacyDroidBridge({
      agentId: 'droid',
      acpCommand: 'droid',
      acpArgs: ['exec', '--output-format', 'acp'],
    })).toBe(false)
  })

  it('maps Droid auth challenges to setup guidance', () => {
    const result = normalizeAgentReadinessError('droid', 'Authentication required: Your code: QQBB-HLSL. Set FACTORY_API_KEY.')

    expect(result.status).toBe('needs_setup')
    expect(result.message).toContain('Factory authentication')
  })

  it('maps invalid Droid API keys to replacement guidance', () => {
    const result = normalizeAgentReadinessError('droid', 'Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.')

    expect(result.status).toBe('needs_setup')
    expect(result.message).toContain('rejected the saved Factory API key')
  })

  it('maps missing Hermes ACP extras to repair guidance', () => {
    const result = normalizeAgentReadinessError('hermes', "ACP dependencies not installed. Install them with: pip install -e '.[acp]'")

    expect(result.status).toBe('needs_setup')
    expect(result.message).toContain("pip install --no-user -e '.[acp]'")
  })
})
