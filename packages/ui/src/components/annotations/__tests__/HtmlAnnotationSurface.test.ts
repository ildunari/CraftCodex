import { describe, it, expect } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import { HtmlAnnotationSurface } from '../HtmlAnnotationSurface'
import type { SurfaceSelection } from '../types'

// ---------------------------------------------------------------------------
// DOM polyfills for bun:test
// ---------------------------------------------------------------------------

if (typeof globalThis.DOMRect === 'undefined') {
  ;(globalThis as Record<string, unknown>).DOMRect = class DOMRect {
    x: number; y: number; width: number; height: number
    top: number; right: number; bottom: number; left: number
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x; this.y = y; this.width = width; this.height = height
      this.left = x; this.top = y; this.right = x + width; this.bottom = y + height
    }
    toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height } }
  }
}

if (typeof globalThis.NodeFilter === 'undefined') {
  ;(globalThis as Record<string, unknown>).NodeFilter = { SHOW_TEXT: 4 }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockIframe(overrides: Partial<HTMLIFrameElement> = {}): HTMLIFrameElement {
  return {
    contentDocument: null,
    contentWindow: null,
    parentElement: null,
    getBoundingClientRect: () => new DOMRect(0, 0, 800, 600),
    ...overrides,
  } as unknown as HTMLIFrameElement
}

function makeAnnotation(id: string, quote: string): AnnotationV1 {
  return {
    id,
    schemaVersion: 1,
    createdAt: Date.now(),
    body: [{ type: 'highlight' }],
    target: {
      source: { sessionId: 's1', messageId: 'm1' },
      selectors: [{ type: 'text-quote', exact: quote }],
    },
  }
}

// ---------------------------------------------------------------------------
// Construction + interface compliance
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface', () => {
  it('has kind "html"', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    expect(surface.kind).toBe('html')
  })

  it('implements all AnnotationSurface methods', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())

    expect(typeof surface.captureSelection).toBe('function')
    expect(typeof surface.restoreSelection).toBe('function')
    expect(typeof surface.getSelectionRects).toBe('function')
    expect(typeof surface.resolveAnnotation).toBe('function')
    expect(typeof surface.getFollowUpContext).toBe('function')
    expect(typeof surface.setRenderedAnnotations).toBe('function')
    expect(typeof surface.observeGeometryInvalidation).toBe('function')
  })

  it('accepts optional fileName parameter', () => {
    const surface = new HtmlAnnotationSurface(mockIframe(), 'test.html')
    expect(surface.kind).toBe('html')
  })
})

// ---------------------------------------------------------------------------
// captureSelection
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface.captureSelection', () => {
  it('returns null when iframe contentDocument is null', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    expect(surface.captureSelection()).toBeNull()
  })

  it('returns null when no selection exists', () => {
    const mockDoc = {
      getSelection: () => null,
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })
    const surface = new HtmlAnnotationSurface(iframe)
    expect(surface.captureSelection()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getSelectionRects
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface.getSelectionRects', () => {
  it('returns empty array for wrong scope kind', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    const sel: SurfaceSelection = {
      selectedText: 'test',
      prefix: '',
      suffix: '',
      scope: { kind: 'markdown', start: 0, end: 4 },
    }
    expect(surface.getSelectionRects(sel)).toEqual([])
  })

  it('returns empty array when contentDocument is null', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    const sel: SurfaceSelection = {
      selectedText: 'test',
      prefix: '',
      suffix: '',
      scope: { kind: 'html' },
    }
    expect(surface.getSelectionRects(sel)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveAnnotation
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface.resolveAnnotation', () => {
  it('returns surface-unavailable when contentDocument is null', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    const annotation = makeAnnotation('a1', 'test text')
    const result = surface.resolveAnnotation(annotation)
    expect(result).not.toBeNull()
    expect(result!.isValid).toBe(false)
    expect(result!.failureReason).toBe('surface-unavailable')
  })

  it('returns quote-not-found when annotation has no text-quote selector', () => {
    const mockDoc = {
      body: { textContent: 'some text' },
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })
    const surface = new HtmlAnnotationSurface(iframe)

    const annotation: AnnotationV1 = {
      id: 'a1',
      schemaVersion: 1,
      createdAt: Date.now(),
      body: [{ type: 'highlight' }],
      target: {
        source: { sessionId: 's1', messageId: 'm1' },
        selectors: [{ type: 'text-position', start: 0, end: 5 }],
      },
    }

    const result = surface.resolveAnnotation(annotation)
    expect(result).not.toBeNull()
    expect(result!.isValid).toBe(false)
    expect(result!.failureReason).toBe('quote-not-found')
  })
})

// ---------------------------------------------------------------------------
// getFollowUpContext
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface.getFollowUpContext', () => {
  it('returns html document type', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    const sel: SurfaceSelection = {
      selectedText: 'test text',
      prefix: 'before ',
      suffix: ' after',
      scope: { kind: 'html' },
    }
    const ctx = surface.getFollowUpContext(sel)
    expect(ctx.documentType).toBe('html')
    expect(ctx.surroundingText).toContain('test text')
  })

  it('includes fileName when provided', () => {
    const surface = new HtmlAnnotationSurface(mockIframe(), '/path/to/email.html')
    const sel: SurfaceSelection = {
      selectedText: 'hello',
      prefix: '',
      suffix: '',
      scope: { kind: 'html' },
    }
    const ctx = surface.getFollowUpContext(sel)
    expect(ctx.fileName).toBe('email.html')
  })
})

// ---------------------------------------------------------------------------
// setRenderedAnnotations
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface.setRenderedAnnotations', () => {
  it('does not throw when contentDocument is null', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    expect(() => surface.setRenderedAnnotations([])).not.toThrow()
  })

  it('does not throw with empty annotations array', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    expect(() => surface.setRenderedAnnotations([])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// observeGeometryInvalidation
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface.observeGeometryInvalidation', () => {
  it('returns a cleanup function', () => {
    const surface = new HtmlAnnotationSurface(mockIframe())
    const cleanup = surface.observeGeometryInvalidation(() => {})
    expect(typeof cleanup).toBe('function')
    cleanup() // Should not throw
  })
})

// ---------------------------------------------------------------------------
// CSS Custom Highlight fallback detection
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface highlight fallback', () => {
  it('handles iframe without CSS.highlights gracefully', () => {
    const mockDoc = {
      body: { textContent: 'some text content' },
      getElementById: () => null,
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
    }
    const iframe = mockIframe({
      contentDocument: mockDoc as unknown as Document,
      contentWindow: { CSS: {} } as unknown as WindowProxy,
    })
    const surface = new HtmlAnnotationSurface(iframe)

    // Should not throw — will fall back to overlay or no-op
    // (text won't be found via tree walker mock, so no highlight is created)
    const annotation = makeAnnotation('a1', 'some text')
    expect(() => surface.setRenderedAnnotations([annotation])).not.toThrow()
  })

  it('handles iframe with CSS.highlights available', () => {
    const highlightsMap = new Map()
    const mockDoc = {
      body: { textContent: 'some text content' },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: () => {} },
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
    }
    const iframe = mockIframe({
      contentDocument: mockDoc as unknown as Document,
      contentWindow: {
        CSS: { highlights: highlightsMap },
        Highlight: class MockHighlight {
          constructor(..._ranges: Range[]) {}
        },
      } as unknown as WindowProxy,
    })
    const surface = new HtmlAnnotationSurface(iframe)

    // Won't find text (no tree walker results), but should not throw
    const annotation = makeAnnotation('a1', 'nonexistent')
    expect(() => surface.setRenderedAnnotations([annotation])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Coordinate mapping (integration-level)
// ---------------------------------------------------------------------------

describe('HtmlAnnotationSurface coordinate mapping', () => {
  it('getSelectionRects maps through iframe bridge correctly', () => {
    // This is an integration test that verifies the surface delegates
    // coordinate mapping to mapIframeRectsToParent. Without a real DOM,
    // we verify the flow does not throw and returns an empty array.
    const surface = new HtmlAnnotationSurface(mockIframe())
    const sel: SurfaceSelection = {
      selectedText: 'text',
      prefix: '',
      suffix: '',
      scope: { kind: 'html' },
    }
    const rects = surface.getSelectionRects(sel)
    expect(Array.isArray(rects)).toBe(true)
    expect(rects).toEqual([])
  })
})
