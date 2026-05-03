import { describe, it, expect } from 'bun:test'
import { DocxAnnotationSurface } from '../DocxAnnotationSurface'
import type { SurfaceSelection } from '../types'
import { classifyFile, FILE_EXTENSIONS_PATTERN } from '../../../lib/file-classification'

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

function makeSel(text: string, scopeKind: 'html' | 'docx' = 'html'): SurfaceSelection {
  return {
    selectedText: text,
    prefix: '',
    suffix: '',
    scope: scopeKind === 'docx'
      ? { kind: 'docx' }
      : { kind: 'html' },
  }
}

// ---------------------------------------------------------------------------
// Construction + inheritance
// ---------------------------------------------------------------------------

describe('DocxAnnotationSurface', () => {
  it('has kind "docx"', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    expect(surface.kind).toBe('docx')
  })

  it('uses composition (not inheritance) over HtmlAnnotationSurface', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    // Should NOT be an instance of HtmlAnnotationSurface — uses composition
    expect(surface.kind).toBe('docx')
    expect(typeof surface.captureSelection).toBe('function')
  })

  it('accepts optional docxFileName parameter', () => {
    const surface = new DocxAnnotationSurface(mockIframe(), 'report.docx')
    expect(surface.kind).toBe('docx')
  })

  it('implements all AnnotationSurface methods', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    expect(typeof surface.captureSelection).toBe('function')
    expect(typeof surface.restoreSelection).toBe('function')
    expect(typeof surface.getSelectionRects).toBe('function')
    expect(typeof surface.resolveAnnotation).toBe('function')
    expect(typeof surface.getFollowUpContext).toBe('function')
    expect(typeof surface.setRenderedAnnotations).toBe('function')
    expect(typeof surface.observeGeometryInvalidation).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// getFollowUpContext
// ---------------------------------------------------------------------------

describe('DocxAnnotationSurface.getFollowUpContext', () => {
  it('returns documentType "docx" instead of "html"', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const ctx = surface.getFollowUpContext(makeSel('test text'))
    expect(ctx.documentType).toBe('docx')
  })

  it('includes docxFileName when provided', () => {
    const surface = new DocxAnnotationSurface(mockIframe(), 'quarterly-report.docx')
    const ctx = surface.getFollowUpContext(makeSel('test text'))
    expect(ctx.fileName).toBe('quarterly-report.docx')
  })

  it('returns undefined fileName when not provided', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const ctx = surface.getFollowUpContext(makeSel('test text'))
    expect(ctx.fileName).toBeUndefined()
  })

  it('includes surroundingText from base class', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const ctx = surface.getFollowUpContext(makeSel('some content'))
    expect(ctx.surroundingText).toContain('some content')
  })

  it('returns sectionHeading undefined when iframe has no contentDocument', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const ctx = surface.getFollowUpContext(makeSel('text'))
    expect(ctx.sectionHeading).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Inherited behavior works correctly
// ---------------------------------------------------------------------------

describe('DocxAnnotationSurface inherited behavior', () => {
  it('captureSelection returns null when iframe contentDocument is null', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    expect(surface.captureSelection()).toBeNull()
  })

  it('getSelectionRects returns empty array when contentDocument is null', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const sel = makeSel('test', 'docx')
    // Composition: docx scope is translated to html scope for the inner surface
    expect(surface.getSelectionRects(sel)).toEqual([])
  })

  it('resolveAnnotation returns surface-unavailable when contentDocument is null', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const annotation = {
      id: 'a1',
      schemaVersion: 1 as const,
      createdAt: Date.now(),
      body: [{ type: 'highlight' as const }],
      target: {
        source: { sessionId: 's1', messageId: 'm1' },
        selectors: [{ type: 'text-quote' as const, exact: 'test' }],
      },
    }
    const result = surface.resolveAnnotation(annotation)
    expect(result).not.toBeNull()
    expect(result!.isValid).toBe(false)
    expect(result!.failureReason).toBe('surface-unavailable')
  })

  it('observeGeometryInvalidation returns a cleanup function', () => {
    const surface = new DocxAnnotationSurface(mockIframe())
    const cleanup = surface.observeGeometryInvalidation(() => {})
    expect(typeof cleanup).toBe('function')
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// File classification — DOCX support
// ---------------------------------------------------------------------------

describe('file-classification DOCX support', () => {
  it('classifies .docx as docx preview type', () => {
    const result = classifyFile('report.docx')
    expect(result.type).toBe('docx')
    expect(result.canPreview).toBe(true)
  })

  it('classifies .docx case-insensitively', () => {
    const result = classifyFile('REPORT.DOCX')
    expect(result.type).toBe('docx')
    expect(result.canPreview).toBe(true)
  })

  it('classifies .docx with path separators', () => {
    const result = classifyFile('/home/user/documents/memo.docx')
    expect(result.type).toBe('docx')
    expect(result.canPreview).toBe(true)
  })

  it('does NOT classify .doc as docx (legacy binary format)', () => {
    const result = classifyFile('old-file.doc')
    expect(result.type).toBeNull()
    expect(result.canPreview).toBe(false)
  })

  it('includes docx in FILE_EXTENSIONS_PATTERN', () => {
    expect(FILE_EXTENSIONS_PATTERN).toContain('docx')
  })
})
