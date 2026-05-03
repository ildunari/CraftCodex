/**
 * Hermes profile discovery and gateway control.
 *
 * Hermes is a multi-profile agent: each profile pins a primary model and a
 * gateway state. We surface profiles as if they were "models" inside the
 * existing connection picker by encoding them as `hermes:<profile>` strings.
 *
 * Spawn-time activation lives in `AcpAgent.ensureSubprocess` — before the
 * `hermes acp` subprocess is launched, we call `useHermesProfile` (sticky
 * default) and `startHermesGatewayIfStopped`, both via this module.
 */

import { spawn } from 'node:child_process';

export {
  HERMES_PROFILE_MODEL_PREFIX,
  profileNameFromModelString,
  modelStringForProfile,
  type HermesProfileInfo,
} from './hermes-profiles-types.ts';
import type { HermesProfileInfo } from './hermes-profiles-types.ts';

interface RunCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runCommand(command: string, args: string[], timeoutMs = 8000): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr || err.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

// Strip ANSI escape codes (hermes CLI emits them even without a TTY).
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parse `hermes profile list` table output.
 *
 * Sample:
 *   Profile          Model                        Gateway      Alias
 *   ───────────────  ───────────────────────────  ───────────  ────────────
 *   ◆default         deepseek-v4-pro              running      —
 *    coding          gpt-5.4                      stopped      —
 *
 * The default-marker glyph (`◆`) prefixes the active profile name. The table
 * uses unicode box-drawing dashes for separators.
 */
export function parseHermesProfileList(output: string): HermesProfileInfo[] {
  const profiles: HermesProfileInfo[] = [];
  const lines = stripAnsi(output).split('\n');
  let inBody = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^\s*Profile\s+Model\s+Gateway/i.test(line)) {
      inBody = false;
      continue;
    }
    if (/[─━_-]{3,}/.test(line)) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    // Strip leading default-marker glyph, keep rest.
    const stripped = line.replace(/^\s*[◆◇►▶•*]\s*/u, '');
    const isDefault = /^\s*[◆◇►▶•*]/u.test(line);
    const cols = stripped.trim().split(/\s{2,}/);
    if (cols.length < 3) continue;
    const [name, model, gatewayRaw, aliasRaw] = cols;
    if (!name || /^profile$/i.test(name)) continue;
    const gateway: HermesProfileInfo['gateway'] =
      /running/i.test(gatewayRaw ?? '') ? 'running'
      : /stopped/i.test(gatewayRaw ?? '') ? 'stopped'
      : 'unknown';
    const alias = aliasRaw && aliasRaw !== '—' && aliasRaw !== '-' ? aliasRaw : undefined;
    profiles.push({ name: name.trim(), model: (model ?? '').trim(), isDefault, gateway, alias });
  }
  return profiles;
}

let cachedProfiles: { value: HermesProfileInfo[]; expiresAt: number } | null = null;
const PROFILE_CACHE_TTL_MS = 30_000;

export async function listHermesProfiles(options: { command?: string; force?: boolean } = {}): Promise<HermesProfileInfo[]> {
  if (!options.force && cachedProfiles && cachedProfiles.expiresAt > Date.now()) {
    return cachedProfiles.value;
  }
  const command = options.command ?? 'hermes';
  const result = await runCommand(command, ['profile', 'list']);
  if (result.exitCode !== 0) {
    if (process.env.CRAFT_DEBUG_HERMES) {
      // eslint-disable-next-line no-console
      console.warn(`[hermes-profiles] '${command} profile list' failed (code=${result.exitCode}): ${result.stderr.trim()}`);
    }
    return [];
  }
  const profiles = parseHermesProfileList(result.stdout);
  cachedProfiles = { value: profiles, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS };
  return profiles;
}

export function invalidateHermesProfileCache(): void {
  cachedProfiles = null;
}

export async function useHermesProfile(name: string, options: { command?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const command = options.command ?? 'hermes';
  const result = await runCommand(command, ['profile', 'use', name], 6000);
  invalidateHermesProfileCache();
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, error: (result.stderr || result.stdout || `hermes profile use ${name} failed`).trim() };
}

export async function getHermesGatewayStatus(options: { command?: string } = {}): Promise<'running' | 'stopped' | 'unknown'> {
  const command = options.command ?? 'hermes';
  const result = await runCommand(command, ['gateway', 'status'], 5000);
  if (result.exitCode !== 0) return 'unknown';
  const text = stripAnsi(result.stdout).toLowerCase();
  if (/running|active|healthy|listening/.test(text)) return 'running';
  if (/stopped|inactive|not running|down/.test(text)) return 'stopped';
  return 'unknown';
}

export async function startHermesGatewayIfStopped(options: { command?: string } = {}): Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }> {
  const status = await getHermesGatewayStatus(options);
  if (status === 'running') return { ok: true, alreadyRunning: true };
  const command = options.command ?? 'hermes';
  const result = await runCommand(command, ['gateway', 'start'], 12_000);
  if (result.exitCode !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || 'hermes gateway start failed').trim() };
  }
  return { ok: true };
}

