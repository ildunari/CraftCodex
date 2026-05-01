import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { CONFIG_DIR } from '../../config/paths.ts';
import {
  DEFAULT_NATIVE_CAPABILITY_POLICY,
  getNativeCapabilityPolicy,
  shadowedMcpServerNames,
  type NativeCapabilityInventory,
  type NativeCapabilityPolicy,
  type NativeCapabilitySyncManifest,
} from './native-capabilities.ts';

export interface CodexRuntimeHomeResult {
  rootHome: string;
  runtimeHome: string;
  env: Record<string, string>;
  manifest: NativeCapabilitySyncManifest;
  configOverrides: Record<string, unknown>;
}

export interface PrepareCodexRuntimeHomeArgs {
  connectionSlug?: string;
  craftInventory?: NativeCapabilityInventory;
  policy?: Partial<NativeCapabilityPolicy> | null;
  model?: string;
  debug?: (message: string) => void;
}

const TOP_LEVEL_KEYS_TO_DROP = new Set([
  'approval_policy',
  'agents',
  'features',
  'sandbox_mode',
  'instructions',
  'developer_instructions',
  'model_instructions_file',
  'project_doc_max_bytes',
  'project_doc_fallback_filenames',
]);

const TABLES_TO_DROP = new Set([
  'agents',
  'developer',
]);

function safeSlug(value: string | undefined): string {
  return (value || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rootCodexHome(): string {
  return process.env.CRAFT_ROOT_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
}

function generatedCodexHome(connectionSlug?: string): string {
  return join(CONFIG_DIR, 'runtime', 'codex', safeSlug(connectionSlug));
}

function parseTomlTable(line: string): string | null {
  const match = line.trim().match(/^\[\[?([^\]]+)\]?\]$/);
  return match?.[1] || null;
}

function topLevelKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) return null;
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
  return match?.[1] || null;
}

function tableIsShadowedMcp(table: string, shadowedNames: Set<string>): boolean {
  const match = table.match(/^mcp_servers\.("?)([^"]+)\1$/);
  return !!match && shadowedNames.has(match[2]!);
}

function tableShouldBeDropped(table: string, shadowedNames: Set<string>): boolean {
  const rootName = table.split('.')[0] || table;
  return table === 'features'
    || TABLES_TO_DROP.has(rootName)
    || tableIsShadowedMcp(table, shadowedNames);
}

function continuedTomlValue(line: string): { kind: 'triple-single' | 'triple-double' | 'bracket'; depth?: number } | null {
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (value.startsWith('"""') && !value.slice(3).includes('"""')) return { kind: 'triple-double' };
  if (value.startsWith("'''") && !value.slice(3).includes("'''")) return { kind: 'triple-single' };
  const depth = (value.match(/[\[{]/g)?.length ?? 0) - (value.match(/[\]}]/g)?.length ?? 0);
  return depth > 0 ? { kind: 'bracket', depth } : null;
}

function updateContinuedValue(
  state: { kind: 'triple-single' | 'triple-double' | 'bracket'; depth?: number },
  line: string,
): { kind: 'triple-single' | 'triple-double' | 'bracket'; depth?: number } | null {
  if (state.kind === 'triple-double') return line.includes('"""') ? null : state;
  if (state.kind === 'triple-single') return line.includes("'''") ? null : state;
  const nextDepth = (state.depth ?? 0)
    + (line.match(/[\[{]/g)?.length ?? 0)
    - (line.match(/[\]}]/g)?.length ?? 0);
  return nextDepth > 0 ? { kind: 'bracket', depth: nextDepth } : null;
}

function filterRootConfig(rootConfig: string, shadowedNames: string[]): { topLevel: string; tables: string } {
  const shadowed = new Set(shadowedNames);
  const lines = rootConfig.split(/\r?\n/);
  const topLevelOutput: string[] = [];
  const tableOutput: string[] = [];
  let skippingShadowedTable = false;
  let skippingTopLevelValue: ReturnType<typeof continuedTomlValue> = null;
  let currentTable: string | null = null;

  for (const line of lines) {
    if (skippingTopLevelValue) {
      skippingTopLevelValue = updateContinuedValue(skippingTopLevelValue, line);
      continue;
    }

    const table = parseTomlTable(line);
    if (table) {
      currentTable = table;
      skippingShadowedTable = tableShouldBeDropped(table, shadowed);
      if (skippingShadowedTable) continue;
      tableOutput.push(line);
      continue;
    }

    if (skippingShadowedTable) continue;

    if (!currentTable) {
      const key = topLevelKey(line);
      if (key && TOP_LEVEL_KEYS_TO_DROP.has(key.split('.')[0] || key)) {
        skippingTopLevelValue = continuedTomlValue(line);
        continue;
      }
      topLevelOutput.push(line);
    } else {
      tableOutput.push(line);
    }
  }

  return {
    topLevel: topLevelOutput.join('\n').trim(),
    tables: tableOutput.join('\n').trim(),
  };
}

async function symlinkOrCopy(source: string, dest: string, debug?: (message: string) => void): Promise<void> {
  if (!existsSync(source)) return;
  await rm(dest, { recursive: true, force: true });
  try {
    await symlink(source, dest);
  } catch (error) {
    debug?.(`Symlink failed for ${basename(source)}, falling back to copy: ${error instanceof Error ? error.message : String(error)}`);
    await copyFile(source, dest);
  }
}

export async function prepareCodexRuntimeHome(args: PrepareCodexRuntimeHomeArgs): Promise<CodexRuntimeHomeResult> {
  const policy = getNativeCapabilityPolicy(args.policy);
  const rootHome = rootCodexHome();
  const runtimeHome = generatedCodexHome(args.connectionSlug);
  const warnings: string[] = [];
  const shadowedNames = shadowedMcpServerNames(args.craftInventory).map(name => name.trim()).filter(Boolean);
  const rootConfigPath = join(rootHome, 'config.toml');
  const rootConfig = existsSync(rootConfigPath) ? await readFile(rootConfigPath, 'utf8') : '';
  const filteredRootConfig = rootConfig && policy.syncFromRoot
    ? filterRootConfig(rootConfig, shadowedNames)
    : null;

  await mkdir(runtimeHome, { recursive: true });

  for (const name of ['auth.json', 'installation_id', 'version.json', 'models_cache.json']) {
    await symlinkOrCopy(join(rootHome, name), join(runtimeHome, name), args.debug);
  }
  for (const name of ['plugins', 'vendor_imports', 'browser']) {
    if (existsSync(join(rootHome, name))) {
      await symlinkOrCopy(join(rootHome, name), join(runtimeHome, name), args.debug);
    }
  }

  const configParts: string[] = [
    '# Generated by Craft Agents. Do not edit directly.',
    '# Source: Craft-managed Codex runtime home.',
  ];
  if (filteredRootConfig) {
    if (filteredRootConfig.topLevel) {
      configParts.push(filteredRootConfig.topLevel);
    }
  }
  configParts.push(
    '',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'developer_instructions = ""',
    '',
    '[features]',
    `apps = ${policy.allowNativeApps ? 'true' : 'false'}`,
    `plugins = ${policy.allowNativePlugins ? 'true' : 'false'}`,
  );
  if (filteredRootConfig) {
    if (filteredRootConfig.tables) {
      configParts.push('', filteredRootConfig.tables);
    }
  }

  const generatedConfig = `${configParts.filter(part => part != null).join('\n').trim()}\n`;
  await writeFile(join(runtimeHome, 'config.toml'), generatedConfig, 'utf8');

  const manifest: NativeCapabilitySyncManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootHome,
    runtimeHome,
    policy,
    craftInventory: args.craftInventory || { items: [], generatedAt: Date.now() },
    decisions: [],
    shadowedMcpServerNames: shadowedNames,
    warnings,
  };
  await writeFile(join(runtimeHome, 'manifest.json'), JSON.stringify({
    ...manifest,
    rootConfigHash: rootConfig ? sha256(rootConfig) : null,
    generatedConfigHash: sha256(generatedConfig),
  }, null, 2), 'utf8');

  return {
    rootHome,
    runtimeHome,
    env: {
      CODEX_HOME: runtimeHome,
      CODEX_SQLITE_HOME: runtimeHome,
      CRAFT_ROOT_CODEX_HOME: rootHome,
    },
    configOverrides: {
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      developer_instructions: '',
      features: {
        apps: policy.allowNativeApps,
        plugins: policy.allowNativePlugins,
      },
    },
    manifest,
  };
}

export { DEFAULT_NATIVE_CAPABILITY_POLICY };
