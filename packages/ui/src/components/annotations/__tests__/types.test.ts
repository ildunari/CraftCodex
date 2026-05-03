import { describe, expect, it } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import type {
  AnnotationSurface,
  SurfaceSelection,
  SelectionScope,
  FollowUpContext,
  ResolvedAnnotation,
  SurfaceKind,
  AnnotationDocumentMeta,
} from '../types'
import { AnnotationDocumentMetaSchema } from '../types'

// ---------------------------------------------------------------------------
// 1. AnnotationSurface — mock object satisfies the interface at runtime
// ---------------------------------------------------------------------------
describe('AnnotationSurface interface', () => {
  it('can be satisfied by a mock object', () => {
    const surface: AnnotationSurface = {
      kind: 'markdown',
      captureSelection: () => null,
      restoreSelection: () => {},
      getSelectionRects: () => [],
      resolveAnnotation: () => null,
      getFollowUpContext: (sel: SurfaceSelection) => ({
        surroundingText: sel.selectedText,
        documentType: 'markdown',
      }),
      setRenderedAnnotations: () => {},
      observeGeometryInvalidation: () => () => {},
    }

    expect(surface.kind).toBe('markdown')
    expect(surface.captureSelection()).toBeNull()
    expect(surface.getSelectionRects({} as SurfaceSelection)).toEqual([])
    expect(typeof surface.observeGeometryInvalidation(() => {})).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 2. SelectionScope discriminated union — each variant
// ---------------------------------------------------------------------------
describe('SelectionScope discriminated union', () => {
  it('supports markdown scope', () => {
    const scope: SelectionScope = { kind: 'markdown', start: 0, end: 42 }
    expect(scope.kind).toBe('markdown')
    expect(scope.start).toBe(0)
    expect(scope.end).toBe(42)
  })

  it('supports pdf scope', () => {
    const scope: SelectionScope = { kind: 'pdf', pageNumber: 3, itemRunHash: 'abc123' }
    expect(scope.kind).toBe('pdf')
    expect(scope.pageNumber).toBe(3)
  })

  it('supports docx scope', () => {
    const scope: SelectionScope = { kind: 'docx', pageNumber: 1, sectionPath: ['Introduction'] }
    expect(scope.kind).toBe('docx')
    expect(scope.sectionPath).toEqual(['Introduction'])
  })

  it('supports html scope', () => {
    const scope: SelectionScope = { kind: 'html', cssSelector: '#main p:nth-child(2)' }
    expect(scope.kind).toBe('html')
    expect(scope.cssSelector).toBe('#main p:nth-child(2)')
  })

  it('supports pptx scope', () => {
    const scope: SelectionScope = { kind: 'pptx', slideNumber: 5 }
    expect(scope.kind).toBe('pptx')
    expect(scope.slideNumber).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 3. AnnotationDocumentMetaSchema — parse valid variants
// ---------------------------------------------------------------------------
describe('AnnotationDocumentMetaSchema', () => {
  it('parses a valid markdown meta', () => {
    const result = AnnotationDocumentMetaSchema.parse({
      kind: 'markdown',
      title: 'README',
      sectionPath: ['Getting Started'],
    })
    expect(result.kind).toBe('markdown')
  })

  it('parses a valid pdf meta', () => {
    const result = AnnotationDocumentMetaSchema.parse({
      kind: 'pdf',
      title: 'Report.pdf',
      page: 7,
      pageLabel: 'vii',
    })
    expect(result.kind).toBe('pdf')
    expect(result.page).toBe(7)
  })

  it('parses a valid docx meta', () => {
    const result = AnnotationDocumentMetaSchema.parse({
      kind: 'docx',
      page: 2,
      sectionPath: ['Abstract'],
    })
    expect(result.kind).toBe('docx')
  })

  it('parses a valid pptx meta', () => {
    const result = AnnotationDocumentMetaSchema.parse({
      kind: 'pptx',
      slide: 3,
      slideTitle: 'Conclusion',
    })
    expect(result.kind).toBe('pptx')
    expect(result.slide).toBe(3)
  })

  it('parses a valid html meta', () => {
    const result = AnnotationDocumentMetaSchema.parse({
      kind: 'html',
      title: 'index.html',
    })
    expect(result.kind).toBe('html')
  })

  it('parses markdown meta with only kind (all optional fields omitted)', () => {
    const result = AnnotationDocumentMetaSchema.parse({ kind: 'markdown' })
    expect(result.kind).toBe('markdown')
  })

  it('throws for missing required pdf page field', () => {
    expect(() =>
      AnnotationDocumentMetaSchema.parse({ kind: 'pdf', title: 'Oops' }),
    ).toThrow()
  })

  it('throws for missing required pptx slide field', () => {
    expect(() =>
      AnnotationDocumentMetaSchema.parse({ kind: 'pptx' }),
    ).toThrow()
  })

  it('throws for unknown kind', () => {
    expect(() =>
      AnnotationDocumentMetaSchema.parse({ kind: 'csv', title: 'data.csv' }),
    ).toThrow()
  })

  it('throws for completely invalid data', () => {
    expect(() => AnnotationDocumentMetaSchema.parse('not an object')).toThrow()
    expect(() => AnnotationDocumentMetaSchema.parse(null)).toThrow()
    expect(() => AnnotationDocumentMetaSchema.parse(42)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 4. FollowUpContext — optional fields omitted
// ---------------------------------------------------------------------------
describe('FollowUpContext', () => {
  it('can be created with only required fields', () => {
    const ctx: FollowUpContext = {
      surroundingText: 'Lorem ipsum dolor sit amet...',
      documentType: 'pdf',
    }
    expect(ctx.surroundingText).toBeTruthy()
    expect(ctx.fileName).toBeUndefined()
    expect(ctx.pageOrSlide).toBeUndefined()
    expect(ctx.sectionHeading).toBeUndefined()
  })

  it('can be created with all fields', () => {
    const ctx: FollowUpContext = {
      fileName: 'report.pdf',
      pageOrSlide: 12,
      sectionHeading: 'Results',
      surroundingText: '...statistically significant...',
      documentType: 'pdf',
    }
    expect(ctx.fileName).toBe('report.pdf')
    expect(ctx.pageOrSlide).toBe(12)
    expect(ctx.sectionHeading).toBe('Results')
  })
})

// ---------------------------------------------------------------------------
// 5. ResolvedAnnotation — with and without failure
// ---------------------------------------------------------------------------
describe('ResolvedAnnotation', () => {
  it('represents a valid resolved annotation', () => {
    const resolved: ResolvedAnnotation = {
      rects: [],
      isValid: true,
    }
    expect(resolved.isValid).toBe(true)
    expect(resolved.failureReason).toBeUndefined()
  })

  it('represents a failed resolution with reason', () => {
    const resolved: ResolvedAnnotation = {
      rects: [],
      isValid: false,
      failureReason: 'quote-not-found',
    }
    expect(resolved.isValid).toBe(false)
    expect(resolved.failureReason).toBe('quote-not-found')
  })

  it('supports page-missing failure reason', () => {
    const resolved: ResolvedAnnotation = {
      rects: [],
      isValid: false,
      failureReason: 'page-missing',
    }
    expect(resolved.failureReason).toBe('page-missing')
  })

  it('supports surface-unavailable failure reason', () => {
    const resolved: ResolvedAnnotation = {
      rects: [],
      isValid: false,
      failureReason: 'surface-unavailable',
    }
    expect(resolved.failureReason).toBe('surface-unavailable')
  })
})

// ---------------------------------------------------------------------------
// 6. SurfaceKind — type-level check via runtime values
// ---------------------------------------------------------------------------
describe('SurfaceKind', () => {
  it('accepts all valid surface kinds', () => {
    const kinds: SurfaceKind[] = ['markdown', 'html', 'pdf', 'docx', 'pptx']
    expect(kinds).toHaveLength(5)
  })
})
