import { describe, it, expect } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api'
import { PdfAnnotationSurface } from '../PdfAnnotationSurface'
import type { SurfaceSelection } from '../types'

// ---------------------------------------------------------------------------
// Mock helpers — bun:test runs outside the browser, so DOM APIs are absent.
// These tests verify construction, method signatures, and synchronous logic
// that degrades gracefully without a real DOM.
// ---------------------------------------------------------------------------

const mockGetPage = (_pageNumber: number): Promise<PDFPageProxy> => {
  return Promise.resolve({} as PDFPageProxy)
}

describe('PdfAnnotationSurface', () => {
  it('has kind "pdf"', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    expect(surface.kind).toBe('pdf')
  })

  it('implements all AnnotationSurface methods', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)

    expect(typeof surface.captureSelection).toBe('function')
    expect(typeof surface.restoreSelection).toBe('function')
    expect(typeof surface.getSelectionRects).toBe('function')
    expect(typeof surface.resolveAnnotation).toBe('function')
    expect(typeof surface.getFollowUpContext).toBe('function')
    expect(typeof surface.setRenderedAnnotations).toBe('function')
    expect(typeof surface.observeGeometryInvalidation).toBe('function')
  })

  it('captureSelection returns null without a DOM', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    // No window.getSelection in bun:test — should return null gracefully
    const result = surface.captureSelection()
    expect(result).toBeNull()
  })

  it('getFollowUpContext returns pdf document type', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage, 'report.pdf')
    const sel: SurfaceSelection = {
      selectedText: 'sample text',
      prefix: 'before ',
      suffix: ' after',
      scope: { kind: 'pdf', pageNumber: 3 },
    }
    const ctx = surface.getFollowUpContext(sel)
    expect(ctx.documentType).toBe('pdf')
    expect(ctx.pageOrSlide).toBe(3)
    expect(ctx.fileName).toBe('report.pdf')
    expect(ctx.surroundingText).toContain('sample text')
  })

  it('getFollowUpContext falls back for non-pdf scope', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    const sel: SurfaceSelection = {
      selectedText: 'some text',
      prefix: '',
      suffix: '',
      scope: { kind: 'markdown', start: 0, end: 9 },
    }
    const ctx = surface.getFollowUpContext(sel)
    expect(ctx.documentType).toBe('pdf')
    expect(ctx.surroundingText).toBe('some text')
  })

  it('getSelectionRects returns empty array for non-pdf scope', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    const sel: SurfaceSelection = {
      selectedText: 'test',
      prefix: '',
      suffix: '',
      scope: { kind: 'markdown', start: 0, end: 4 },
    }
    expect(surface.getSelectionRects(sel)).toEqual([])
  })

  it('resolveAnnotation returns quote-not-found when no text-quote selector', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    const annotation: AnnotationV1 = {
      id: 'test-1',
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

  it('observeGeometryInvalidation returns a cleanup function', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    const cleanup = surface.observeGeometryInvalidation(() => {})
    expect(typeof cleanup).toBe('function')
    // Should not throw
    cleanup()
  })

  it('setRenderedAnnotations does not throw with empty array', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    expect(() => surface.setRenderedAnnotations([])).not.toThrow()
  })

  it('restoreSelection does not throw for pdf scope', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    const sel: SurfaceSelection = {
      selectedText: 'test',
      prefix: '',
      suffix: '',
      scope: { kind: 'pdf', pageNumber: 1 },
    }
    expect(() => surface.restoreSelection(sel)).not.toThrow()
  })

  it('restoreSelection is no-op for non-pdf scope', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage)
    const sel: SurfaceSelection = {
      selectedText: 'test',
      prefix: '',
      suffix: '',
      scope: { kind: 'markdown', start: 0, end: 4 },
    }
    expect(() => surface.restoreSelection(sel)).not.toThrow()
  })

  it('accepts optional fileName in constructor', () => {
    const container = {} as HTMLElement
    const surface = new PdfAnnotationSurface(container, mockGetPage, '/path/to/doc.pdf')
    const sel: SurfaceSelection = {
      selectedText: 'text',
      prefix: '',
      suffix: '',
      scope: { kind: 'pdf', pageNumber: 1 },
    }
    const ctx = surface.getFollowUpContext(sel)
    expect(ctx.fileName).toBe('doc.pdf')
  })
})
