/**
 * ACP `session/request_permission` decoding & response helpers.
 *
 * The ACP spec sends an `options` array with explicit allow/reject choices.
 * Today's Craft UI surfaces a binary Allow / Always Allow / Deny set, so we
 * map (allowed, alwaysAllow) to the closest spec-shaped optionId. When the
 * UI evolves to render the agent-supplied options directly, callers can
 * pass the chosen `optionId` straight through to `respondToPermission`.
 */

import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionParams,
  RequestPermissionResponse,
} from './acp-types.ts';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return value === 'allow_once'
    || value === 'allow_always'
    || value === 'reject_once'
    || value === 'reject_always';
}

function normalizeOption(raw: unknown): PermissionOption | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const optionId = typeof rec.optionId === 'string' ? rec.optionId : null;
  const name = typeof rec.name === 'string' ? rec.name : null;
  const kind = isPermissionOptionKind(rec.kind) ? rec.kind : null;
  if (!optionId || !name || !kind) return null;
  return { optionId, name, kind };
}

export function parsePermissionRequestParams(params: unknown): RequestPermissionParams | null {
  const root = asRecord(params);
  if (!root) return null;

  const sessionId = typeof root.sessionId === 'string' ? root.sessionId : '';
  const toolCall = asRecord(root.toolCall) ?? {};
  const rawOptions = Array.isArray(root.options) ? root.options : [];
  const options = rawOptions.map(normalizeOption).filter((o): o is PermissionOption => o !== null);

  return {
    sessionId,
    toolCall,
    options,
    _meta: asRecord(root._meta),
  };
}

/**
 * Map (allowed, alwaysAllow) to a concrete optionId chosen from the
 * agent-supplied list. Preference order:
 *   - explicit optionId (caller wants to pass through verbatim)
 *   - exact kind match (allow_always > allow_once for accept, mirror for reject)
 *   - fallback by name substring ("allow"/"always"/"deny"/"reject")
 *   - first option as last resort
 */
export function pickOptionId(
  options: PermissionOption[],
  allowed: boolean,
  alwaysAllow = false,
  explicitOptionId?: string,
): string | null {
  if (!options.length) return null;
  if (explicitOptionId && options.some(o => o.optionId === explicitOptionId)) {
    return explicitOptionId;
  }

  const targetKinds: PermissionOptionKind[] = allowed
    ? (alwaysAllow ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'])
    : (alwaysAllow ? ['reject_always', 'reject_once'] : ['reject_once', 'reject_always']);

  for (const kind of targetKinds) {
    const match = options.find(o => o.kind === kind);
    if (match) return match.optionId;
  }

  const nameMatchers = allowed
    ? [/always.*allow/i, /allow/i, /accept/i, /yes/i]
    : [/reject/i, /deny/i, /no/i];
  for (const re of nameMatchers) {
    const match = options.find(o => re.test(o.name));
    if (match) return match.optionId;
  }

  return options[0]!.optionId;
}

export function buildPermissionResponse(optionId: string | null): RequestPermissionResponse {
  if (!optionId) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId } };
}
