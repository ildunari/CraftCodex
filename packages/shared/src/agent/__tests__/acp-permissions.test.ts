import { describe, expect, it } from 'bun:test';

import {
  buildPermissionResponse,
  parsePermissionRequestParams,
  pickOptionId,
} from '../acp/acp-permissions.ts';
import type { PermissionOption } from '../acp/acp-types.ts';

const optAllowOnce: PermissionOption = { optionId: 'a', name: 'Allow once', kind: 'allow_once' };
const optAllowAlways: PermissionOption = { optionId: 'b', name: 'Allow always', kind: 'allow_always' };
const optRejectOnce: PermissionOption = { optionId: 'c', name: 'Reject', kind: 'reject_once' };
const optRejectAlways: PermissionOption = { optionId: 'd', name: 'Always reject', kind: 'reject_always' };

describe('parsePermissionRequestParams', () => {
  it('returns null when params is not an object', () => {
    expect(parsePermissionRequestParams(null)).toBeNull();
    expect(parsePermissionRequestParams('hi')).toBeNull();
    expect(parsePermissionRequestParams([1, 2])).toBeNull();
  });

  it('extracts sessionId, toolCall, and a normalized options array', () => {
    const out = parsePermissionRequestParams({
      sessionId: 's1',
      toolCall: { toolCallId: 't1', title: 'Bash', rawInput: { command: 'echo' }, kind: 'execute' },
      options: [
        optAllowOnce,
        { optionId: 'x', name: 42 }, // invalid, should be filtered
        optAllowAlways,
        { optionId: 'y', name: 'Custom', kind: 'mystery' }, // invalid kind, filtered
      ],
    });

    expect(out).not.toBeNull();
    expect(out!.sessionId).toBe('s1');
    expect(out!.toolCall.toolCallId).toBe('t1');
    expect(out!.options).toEqual([optAllowOnce, optAllowAlways]);
  });
});

describe('pickOptionId', () => {
  const allOptions = [optAllowOnce, optAllowAlways, optRejectOnce, optRejectAlways];

  it('honors an explicit optionId when present in the option list', () => {
    expect(pickOptionId(allOptions, true, false, 'b')).toBe('b');
  });

  it('ignores an explicit optionId not in the list and falls back to kind matching', () => {
    expect(pickOptionId(allOptions, true, false, 'unknown')).toBe('a');
  });

  it('prefers allow_once when allowed=true and alwaysAllow=false', () => {
    expect(pickOptionId(allOptions, true, false)).toBe('a');
  });

  it('prefers allow_always when allowed=true and alwaysAllow=true', () => {
    expect(pickOptionId(allOptions, true, true)).toBe('b');
  });

  it('prefers reject_once when allowed=false', () => {
    expect(pickOptionId(allOptions, false, false)).toBe('c');
  });

  it('prefers reject_always when allowed=false and alwaysAllow=true', () => {
    expect(pickOptionId(allOptions, false, true)).toBe('d');
  });

  it('falls back to name matching when no kind matches', () => {
    const oddly = [
      { optionId: '1', name: 'Approve', kind: 'allow_once' as const },
      { optionId: '2', name: 'Decline', kind: 'reject_once' as const },
    ];
    expect(pickOptionId(oddly, true)).toBe('1');
    expect(pickOptionId(oddly, false)).toBe('2');
  });

  it('returns null when no options at all', () => {
    expect(pickOptionId([], true)).toBeNull();
  });
});

describe('buildPermissionResponse', () => {
  it('returns the spec-shaped selected outcome', () => {
    expect(buildPermissionResponse('opt-1')).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-1' },
    });
  });

  it('returns the cancelled outcome when no option chosen', () => {
    expect(buildPermissionResponse(null)).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
