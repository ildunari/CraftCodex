/**
 * Pure (renderer-safe) helpers for the Hermes profile feature.
 *
 * The runtime side (`hermes-profiles.ts`) spawns child processes and is
 * therefore Node-only. This file contains only the types and string-encoding
 * helpers, so the renderer can import it without bundling `node:child_process`.
 */

export const HERMES_PROFILE_MODEL_PREFIX = 'hermes:';

export interface HermesProfileInfo {
  name: string;
  model: string;
  /** True when the Hermes CLI sticky default points at this profile. */
  isDefault: boolean;
  /** Gateway state as reported by `hermes profile list`. */
  gateway: 'running' | 'stopped' | 'unknown';
  /** Optional alias as reported by `hermes profile list`. */
  alias?: string;
}

export function profileNameFromModelString(model: string | undefined): string | null {
  if (!model || !model.startsWith(HERMES_PROFILE_MODEL_PREFIX)) return null;
  return model.slice(HERMES_PROFILE_MODEL_PREFIX.length) || null;
}

export function modelStringForProfile(name: string): string {
  return `${HERMES_PROFILE_MODEL_PREFIX}${name}`;
}
