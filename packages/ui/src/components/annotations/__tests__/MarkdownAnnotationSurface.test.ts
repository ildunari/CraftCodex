import { describe, it, expect } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core'
import { MarkdownAnnotationSurface } from '../MarkdownAnnotationSurface'
import type { SurfaceSelection } from '../types'

describe('MarkdownAnnotationSurface', () => {
  it('has kind "markdown"', () => {
    // MarkdownAnnotationSurface requires a DOM root, which is not available in bun:test.
    // We test construction with a minimal mock to verify the interface contract.
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)
    expect(surface.kind).toBe('markdown')
  })

  it('implements all AnnotationSurface methods', () => {
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)

    // Verify all required methods exist
    expect(typeof surface.captureSelection).toBe('function')
    expect(typeof surface.restoreSelection).toBe('function')
    expect(typeof surface.getSelectionRects).toBe('function')
    expect(typeof surface.resolveAnnotation).toBe('function')
    expect(typeof surface.getFollowUpContext).toBe('function')
    expect(typeof surface.setRenderedAnnotations).toBe('function')
    expect(typeof surface.observeGeometryInvalidation).toBe('function')
  })

  it('getFollowUpContext returns markdown document type', () => {
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)
    const sel: SurfaceSelection = {
      selectedText: 'test text',
      prefix: 'before ',
      suffix: ' after',
      scope: { kind: 'markdown', start: 7, end: 16 },
    }
    const ctx = surface.getFollowUpContext(sel)
    expect(ctx.documentType).toBe('markdown')
    expect(ctx.surroundingText).toContain('test text')
  })

  it('captureSelection returns null when no DOM selection exists', () => {
    // In bun:test there's no real DOM, so window.getSelection won't work.
    // This tests the graceful fallback behavior.
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)
    // Should return null without throwing when DOM is unavailable
    const result = surface.captureSelection()
    expect(result).toBeNull()
  })

  it('getSelectionRects returns empty array for invalid scope', () => {
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)
    const sel: SurfaceSelection = {
      selectedText: 'test',
      prefix: '',
      suffix: '',
      scope: { kind: 'markdown', start: 0, end: 0 },
    }
    // end <= start returns empty
    const rects = surface.getSelectionRects(sel)
    expect(rects).toEqual([])
  })

  it('observeGeometryInvalidation returns a cleanup function', () => {
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)
    const cleanup = surface.observeGeometryInvalidation(() => {})
    expect(typeof cleanup).toBe('function')
    // Should not throw when called
    cleanup()
  })

  it('resolveAnnotation returns null for annotation without matching selectors', () => {
    const root = {} as HTMLElement
    const surface = new MarkdownAnnotationSurface(root)
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
    // Without a real DOM, resolution should fail gracefully
    const result = surface.resolveAnnotation(annotation)
    expect(result === null || result.isValid === false).toBe(true)
  })
})
