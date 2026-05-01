import type { SdkMcpServerConfig } from './types.ts';

export type NativeCapabilityKind =
  | 'mcp-server'
  | 'mcp-tool'
  | 'plugin'
  | 'app'
  | 'app-tool'
  | 'skill'
  | 'agent-profile'
  | 'model'
  | 'instruction';

export type NativeCapabilitySource = 'craft' | 'codex' | 'acp' | 'droid' | 'native';

export interface NativeCapabilityItem {
  id: string;
  kind: NativeCapabilityKind;
  source: NativeCapabilitySource;
  name: string;
  enabled?: boolean;
  parentId?: string;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

export interface NativeCapabilityInventory {
  items: NativeCapabilityItem[];
  generatedAt: number;
  warnings?: string[];
}

export type NativeCapabilityPolicyMode = 'craft_first' | 'craft_only' | 'native_only';
export type NativeSkillPassthrough = boolean | 'plugin_only';

export interface NativeCapabilityPolicy {
  mode: NativeCapabilityPolicyMode;
  syncFromRoot: boolean;
  allowNativePlugins: boolean;
  allowNativeApps: boolean;
  allowNativeMcp: boolean;
  allowNativeSkills: NativeSkillPassthrough;
  allowNativeInstructions: boolean;
  shadowDuplicates: boolean;
}

export interface NativeCapabilityDecision {
  item: NativeCapabilityItem;
  action: 'enable' | 'shadow' | 'disable' | 'warn';
  reason: string;
  shadowedBy?: string;
}

export interface NativeCapabilitySyncManifest {
  version: 1;
  generatedAt: string;
  rootHome?: string;
  runtimeHome?: string;
  policy: NativeCapabilityPolicy;
  craftInventory: NativeCapabilityInventory;
  nativeInventory?: NativeCapabilityInventory;
  decisions: NativeCapabilityDecision[];
  shadowedMcpServerNames: string[];
  warnings: string[];
}

export const DEFAULT_NATIVE_CAPABILITY_POLICY: NativeCapabilityPolicy = {
  mode: 'craft_first',
  syncFromRoot: true,
  allowNativePlugins: true,
  allowNativeApps: true,
  allowNativeMcp: true,
  allowNativeSkills: 'plugin_only',
  allowNativeInstructions: false,
  shadowDuplicates: true,
};

export function normalizeCapabilityName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^mcp__/, '')
    .replace(/__+/g, ':')
    .replace(/[_\s-]+/g, '-')
    .replace(/[^a-z0-9:.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function capabilityDedupeKey(kind: NativeCapabilityKind, name: string, parentName?: string): string {
  const normalizedName = normalizeCapabilityName(name);
  const normalizedParent = parentName ? normalizeCapabilityName(parentName) : '';
  if (kind === 'mcp-tool' && normalizedParent) return `mcp-tool:${normalizedParent}:${normalizedName}`;
  if (kind === 'app-tool' && normalizedParent) return `app-tool:${normalizedParent}:${normalizedName}`;
  return `${kind}:${normalizedName}`;
}

export function getNativeCapabilityPolicy(input?: Partial<NativeCapabilityPolicy> | null): NativeCapabilityPolicy {
  return {
    ...DEFAULT_NATIVE_CAPABILITY_POLICY,
    ...(input || {}),
  };
}

export function buildCraftCapabilityInventory(args: {
  enabledSourceSlugs?: string[];
  mcpServers?: Record<string, SdkMcpServerConfig>;
}): NativeCapabilityInventory {
  const items: NativeCapabilityItem[] = [];
  const slugs = new Set<string>([
    ...(args.enabledSourceSlugs || []),
    ...Object.keys(args.mcpServers || {}),
  ]);

  for (const slug of slugs) {
    const name = normalizeCapabilityName(slug);
    if (!name) continue;
    items.push({
      id: `craft:mcp-server:${name}`,
      kind: 'mcp-server',
      source: 'craft',
      name: slug,
      enabled: true,
      dedupeKey: capabilityDedupeKey('mcp-server', slug),
    });
  }

  return { items, generatedAt: Date.now() };
}

export function shadowedMcpServerNames(craftInventory?: NativeCapabilityInventory): string[] {
  const names = new Set<string>();
  for (const item of craftInventory?.items || []) {
    if (item.kind !== 'mcp-server') continue;
    const normalized = normalizeCapabilityName(item.name);
    if (normalized) names.add(normalized);
    if (item.name) names.add(item.name);
  }
  return [...names].filter(Boolean);
}

export function evaluateNativeCapabilityPolicy(args: {
  policy?: Partial<NativeCapabilityPolicy> | null;
  craftInventory?: NativeCapabilityInventory;
  nativeInventory: NativeCapabilityInventory;
}): NativeCapabilityDecision[] {
  const policy = getNativeCapabilityPolicy(args.policy);
  const craftByKey = new Map<string, NativeCapabilityItem>();
  for (const item of args.craftInventory?.items || []) {
    const key = item.dedupeKey || capabilityDedupeKey(item.kind, item.name);
    craftByKey.set(key, item);
  }

  return args.nativeInventory.items.map((item): NativeCapabilityDecision => {
    const key = item.dedupeKey || capabilityDedupeKey(item.kind, item.name);
    const duplicate = craftByKey.get(key);

    if (policy.mode === 'craft_only') {
      return { item, action: 'disable', reason: 'Native passthrough is disabled by policy' };
    }

    if (policy.mode === 'craft_first' && policy.shadowDuplicates && duplicate) {
      return { item, action: 'shadow', reason: 'Craft provides this capability', shadowedBy: duplicate.id };
    }

    if (item.kind === 'mcp-server' || item.kind === 'mcp-tool') {
      return policy.allowNativeMcp
        ? { item, action: 'enable', reason: 'Native MCP capability is not provided by Craft' }
        : { item, action: 'disable', reason: 'Native MCP passthrough is disabled by policy' };
    }

    if (item.kind === 'plugin') {
      return policy.allowNativePlugins
        ? { item, action: 'enable', reason: 'Native plugin passthrough is enabled' }
        : { item, action: 'disable', reason: 'Native plugin passthrough is disabled by policy' };
    }

    if (item.kind === 'app' || item.kind === 'app-tool') {
      return policy.allowNativeApps
        ? { item, action: 'enable', reason: 'Native app passthrough is enabled' }
        : { item, action: 'disable', reason: 'Native app passthrough is disabled by policy' };
    }

    if (item.kind === 'instruction') {
      return policy.allowNativeInstructions
        ? { item, action: 'warn', reason: 'Native instructions are allowed but should be reviewed for prompt conflicts' }
        : { item, action: 'disable', reason: 'Craft instructions are authoritative' };
    }

    if (item.kind === 'skill') {
      return policy.allowNativeSkills
        ? { item, action: 'enable', reason: 'Native skills passthrough is enabled' }
        : { item, action: 'disable', reason: 'Native skills passthrough is disabled by policy' };
    }

    return { item, action: 'enable', reason: 'Native capability is available' };
  });
}

export function redactNativeCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNativeCapabilityValue);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|authorization|apikey|api_key|access[_-]?key/i.test(key)) {
      output[key] = '<redacted>';
    } else {
      output[key] = redactNativeCapabilityValue(child);
    }
  }
  return output;
}

export function redactNativeCapabilityManifest(
  manifest: NativeCapabilitySyncManifest,
): NativeCapabilitySyncManifest {
  return redactNativeCapabilityValue(manifest) as NativeCapabilitySyncManifest;
}
