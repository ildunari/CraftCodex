import { describe, expect, it } from 'bun:test';

import {
  buildCraftCapabilityInventory,
  capabilityDedupeKey,
  evaluateNativeCapabilityPolicy,
  normalizeCapabilityName,
  redactNativeCapabilityManifest,
  redactNativeCapabilityValue,
  type NativeCapabilityInventory,
  type NativeCapabilitySyncManifest,
} from '../native-capabilities.ts';

describe('native capability policy', () => {
  it('normalizes capability names for duplicate matching', () => {
    expect(normalizeCapabilityName('Word Swift Kosta')).toBe('word-swift-kosta');
    expect(normalizeCapabilityName('mcp__word__create_doc')).toBe('word:create-doc');
  });

  it('shadows duplicate native MCP servers while allowing native-only plugins and apps', () => {
    const craft = buildCraftCapabilityInventory({
      enabledSourceSlugs: ['word-swift-kosta'],
      mcpServers: {},
    });
    const nativeInventory: NativeCapabilityInventory = {
      generatedAt: Date.now(),
      items: [
        {
          id: 'codex:mcp-server:word-swift-kosta',
          kind: 'mcp-server',
          source: 'codex',
          name: 'word-swift-kosta',
          dedupeKey: capabilityDedupeKey('mcp-server', 'word-swift-kosta'),
        },
        {
          id: 'codex:plugin:documents',
          kind: 'plugin',
          source: 'codex',
          name: 'documents',
        },
        {
          id: 'codex:app:canva',
          kind: 'app',
          source: 'codex',
          name: 'Canva',
        },
      ],
    };

    const decisions = evaluateNativeCapabilityPolicy({
      craftInventory: craft,
      nativeInventory,
    });

    expect(decisions.find(d => d.item.id === 'codex:mcp-server:word-swift-kosta')?.action).toBe('shadow');
    expect(decisions.find(d => d.item.id === 'codex:plugin:documents')?.action).toBe('enable');
    expect(decisions.find(d => d.item.id === 'codex:app:canva')?.action).toBe('enable');
  });

  it('does not enable native instructions by default', () => {
    const decisions = evaluateNativeCapabilityPolicy({
      nativeInventory: {
        generatedAt: Date.now(),
        items: [{
          id: 'codex:instruction:agents',
          kind: 'instruction',
          source: 'codex',
          name: 'AGENTS.md',
        }],
      },
    });

    expect(decisions[0]?.action).toBe('disable');
    expect(decisions[0]?.reason).toContain('Craft instructions');
  });

  it('redacts secret-like diagnostic values', () => {
    expect(redactNativeCapabilityValue({
      api_key: 'secret',
      nested: { Authorization: 'Bearer secret', safe: 'ok' },
    })).toEqual({
      api_key: '<redacted>',
      nested: { Authorization: '<redacted>', safe: 'ok' },
    });
  });

  it('redacts secret-like fields in native capability manifests', () => {
    const manifest: NativeCapabilitySyncManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      rootHome: '/tmp/root',
      runtimeHome: '/tmp/runtime',
      policy: { allowNativePlugins: true } as NativeCapabilitySyncManifest['policy'],
      craftInventory: { generatedAt: Date.now(), items: [] },
      decisions: [{
        item: {
          id: 'codex:plugin:example',
          kind: 'plugin',
          source: 'codex',
          name: 'example',
          metadata: { accessToken: 'secret', safe: 'ok' },
        },
        action: 'enable',
        reason: 'Native plugin passthrough is enabled',
      }],
      shadowedMcpServerNames: [],
      warnings: [],
    };

    expect(redactNativeCapabilityManifest(manifest).decisions[0]?.item.metadata).toEqual({
      accessToken: '<redacted>',
      safe: 'ok',
    });
  });
});
