import { describe, it, expect } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import { isDuplicateAnnotation } from '../duplicate-detection'
import type { SurfaceSelection } from '../types'

function makeAnnotation(overrides: Partial<AnnotationV1> & { id: string }): AnnotationV1 {
  return {
    schemaVersion: 1,
    createdAt: Date.now(),
    body: [{ type: 'highlight' }],
    target: {
      source: { sessionId: 's1', messageId: 'm1' },
      selectors: [],
    },
    ...overrides,
  }
}

function makeSelection(text: string, scope: SurfaceSelection['scope']): SurfaceSelection {
  return { selectedText: text, prefix: '', suffix: '', scope }
}

describe('isDuplicateAnnotation', () => {
  it('returns false for empty annotations array', () => {
    const sel = makeSelection('hello', { kind: 'markdown', start: 0, end: 5 })
    expect(isDuplicateAnnotation([], sel, 'markdown')).toBe(false)
    expect(isDuplicateAnnotation(undefined, sel, 'markdown')).toBe(false)
  })

  it('detects markdown duplicate via text-position (legacy compat)', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [
            { type: 'text-position', start: 10, end: 20 },
            { type: 'text-quote', exact: 'hello world' },
          ],
        },
      }),
    ]
    const sel = makeSelection('hello world', { kind: 'markdown', start: 10, end: 20 })
    expect(isDuplicateAnnotation(existing, sel, 'markdown')).toBe(true)
  })

  it('detects PDF duplicate on same page via normalized quote', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        meta: { document: { kind: 'pdf', page: 3 } },
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [{ type: 'text-quote', exact: 'Revenue increased 15%' }],
        },
      }),
    ]
    const sel = makeSelection('revenue  increased  15%', { kind: 'pdf', pageNumber: 3 })
    expect(isDuplicateAnnotation(existing, sel, 'pdf')).toBe(true)
  })

  it('does NOT flag PDF annotation on different page as duplicate', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        meta: { document: { kind: 'pdf', page: 3 } },
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [{ type: 'text-quote', exact: 'Revenue increased' }],
        },
      }),
    ]
    const sel = makeSelection('Revenue increased', { kind: 'pdf', pageNumber: 5 })
    expect(isDuplicateAnnotation(existing, sel, 'pdf')).toBe(false)
  })

  it('does NOT flag annotation from different attachment as duplicate', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        meta: { document: { kind: 'pdf', page: 1 }, attachmentId: 'file-A' },
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [{ type: 'text-quote', exact: 'Hello' }],
        },
      }),
    ]
    const sel = makeSelection('Hello', { kind: 'pdf', pageNumber: 1 })
    expect(isDuplicateAnnotation(existing, sel, 'pdf', 'file-B')).toBe(false)
  })

  it('does NOT flag annotation from different surface kind', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        meta: { document: { kind: 'html' } },
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [{ type: 'text-quote', exact: 'same text' }],
        },
      }),
    ]
    const sel = makeSelection('same text', { kind: 'pdf', pageNumber: 1 })
    expect(isDuplicateAnnotation(existing, sel, 'pdf')).toBe(false)
  })

  it('skips deleted annotations', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        deletedAt: Date.now(),
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [
            { type: 'text-position', start: 0, end: 5 },
            { type: 'text-quote', exact: 'hello' },
          ],
        },
      }),
    ]
    const sel = makeSelection('hello', { kind: 'markdown', start: 0, end: 5 })
    expect(isDuplicateAnnotation(existing, sel, 'markdown')).toBe(false)
  })

  it('detects PPTX duplicate on same slide', () => {
    const existing = [
      makeAnnotation({
        id: 'a1',
        meta: { document: { kind: 'pptx', slide: 2 } },
        target: {
          source: { sessionId: 's1', messageId: 'm1' },
          selectors: [{ type: 'text-quote', exact: 'Key Findings' }],
        },
      }),
    ]
    const sel = makeSelection('key findings', { kind: 'pptx', slideNumber: 2 })
    expect(isDuplicateAnnotation(existing, sel, 'pptx')).toBe(true)
  })
})
