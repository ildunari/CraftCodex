import { describe, expect, it } from 'bun:test';

import { normalizeAgentCapabilities } from '../acp/acp-types.ts';

describe('normalizeAgentCapabilities', () => {
  it('returns null for non-objects', () => {
    expect(normalizeAgentCapabilities(null)).toBeNull();
    expect(normalizeAgentCapabilities('hi')).toBeNull();
    expect(normalizeAgentCapabilities([1, 2])).toBeNull();
  });

  it('passes through a well-typed capability blob unchanged', () => {
    const caps = normalizeAgentCapabilities({
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { close: null },
    });
    expect(caps).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { close: null },
    });
  });

  it('drops non-boolean loadSession (e.g., string "yes" must not be truthy)', () => {
    // Without normalization, loadSession: 'yes' would be truthy and we'd
    // happily call session/load against an agent that doesn't support it.
    const caps = normalizeAgentCapabilities({ loadSession: 'yes' });
    expect(caps?.loadSession).toBeUndefined();
  });

  it('drops non-boolean prompt capability flags', () => {
    const caps = normalizeAgentCapabilities({
      promptCapabilities: { image: 1 as any, audio: 'true' as any, embeddedContext: true },
    });
    expect(caps?.promptCapabilities).toEqual({ embeddedContext: true });
  });

  it('drops promptCapabilities entirely when it is not a plain object', () => {
    const caps = normalizeAgentCapabilities({ promptCapabilities: 'oops' });
    expect(caps?.promptCapabilities).toBeUndefined();
  });

  it('returns an empty object for {} input', () => {
    expect(normalizeAgentCapabilities({})).toEqual({});
  });
});
