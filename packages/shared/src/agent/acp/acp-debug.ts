/**
 * Optional NDJSON mirror for ACP JSON-RPC traffic.
 *
 * Enabled either explicitly via `runtime.acpNdjsonPath` or globally via
 * `CRAFT_ACP_NDJSON=1` (which writes to `~/.craft-agent/acp-debug-<pid>.ndjson`).
 *
 * Each frame is logged as a single line: `{ ts, dir: 'in'|'out', frame }`.
 * Failures during open/write are swallowed — debug logging must never
 * affect runtime correctness.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface NdjsonMirror {
  logIn(frame: unknown): void;
  logOut(frame: unknown): void;
  close(): void;
  readonly enabled: boolean;
  readonly path: string | null;
}

const noopMirror: NdjsonMirror = {
  logIn() {},
  logOut() {},
  close() {},
  enabled: false,
  path: null,
};

export interface NdjsonMirrorOptions {
  /** Explicit override; takes precedence over the env var. */
  path?: string;
  /** Optional override of the env var (default: process.env.CRAFT_ACP_NDJSON). */
  envFlag?: string;
  /** Optional suffix appended to the auto-generated path. */
  tag?: string;
}

function defaultPath(tag?: string): string {
  const dir = join(homedir(), '.craft-agent');
  const suffix = tag ? `-${tag}` : '';
  return join(dir, `acp-debug${suffix}-${process.pid}.ndjson`);
}

export function createNdjsonMirror(options: NdjsonMirrorOptions = {}): NdjsonMirror {
  const explicit = options.path?.trim();
  const envEnabled = (options.envFlag ?? process.env.CRAFT_ACP_NDJSON) === '1';

  const target = explicit || (envEnabled ? defaultPath(options.tag) : null);
  if (!target) return noopMirror;

  let stream: WriteStream | null = null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    stream = createWriteStream(target, { flags: 'a' });
    stream.on('error', () => {
      try { stream?.destroy(); } catch { /* ignore */ }
      stream = null;
    });
  } catch {
    return noopMirror;
  }

  const write = (dir: 'in' | 'out', frame: unknown): void => {
    if (!stream) return;
    try {
      stream.write(`${JSON.stringify({ ts: Date.now(), dir, frame })}\n`);
    } catch {
      /* ignore */
    }
  };

  return {
    enabled: true,
    path: target,
    logIn(frame) { write('in', frame); },
    logOut(frame) { write('out', frame); },
    close() {
      try { stream?.end(); } catch { /* ignore */ }
      stream = null;
    },
  };
}
