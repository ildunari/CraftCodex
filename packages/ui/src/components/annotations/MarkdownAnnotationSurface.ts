import type { AnnotationV1 } from '@craft-agent/core'
import type {
  AnnotationSurface,
  SurfaceSelection,
  FollowUpContext,
  ResolvedAnnotation,
} from './types'
import {
  ANNOTATION_PREFIX_SUFFIX_WINDOW,
  collectTextSegments,
  getCanonicalText,
  getClientRectsForOffsets,
  resolveNodeOffset,
} from './annotation-core'
import { restoreDomSelectionFromOffsets } from './selection-restore'
import { resolveTextAnnotations } from '../markdown/annotation-resolver'
import { clearAnnotationMarks, applyTextHighlightRange } from './highlight-dom-mutations'

/**
 * AnnotationSurface implementation for markdown-rendered text in TurnCard.
 *
 * This is a facade over the existing annotation-core, selection-restore, and
 * annotation-resolver modules. No new logic — just adapts the existing
 * DOM-root-based helpers to the surface interface.
 */
export class MarkdownAnnotationSurface implements AnnotationSurface {
  readonly kind = 'markdown' as const
  readonly rootElement: HTMLElement

  constructor(private root: HTMLElement) {
    this.rootElement = root
  }

  captureSelection(): SurfaceSelection | null {
    let selection: Selection | null = null
    try {
      selection = window.getSelection()
    } catch {
      return null
    }

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null
    }

    const range = selection.getRangeAt(0)
    const root = this.root
    if (!root) return null

    // Verify selection is within our root
    const common = range.commonAncestorContainer
    const commonEl = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement
    if (!commonEl || !root.contains(commonEl)) return null

    const start = resolveNodeOffset(root, range.startContainer, range.startOffset)
    const end = resolveNodeOffset(root, range.endContainer, range.endOffset)
    if (start === null || end === null || end <= start) return null

    const selectedText = range.toString()
    if (!selectedText.trim()) return null

    // Extract prefix/suffix from canonical text
    const canonical = getCanonicalText(root)
    const prefix = canonical.slice(
      Math.max(0, start - ANNOTATION_PREFIX_SUFFIX_WINDOW),
      start,
    )
    const suffix = canonical.slice(end, end + ANNOTATION_PREFIX_SUFFIX_WINDOW)

    return {
      selectedText,
      prefix,
      suffix,
      scope: { kind: 'markdown', start, end },
    }
  }

  restoreSelection(sel: SurfaceSelection): void {
    if (sel.scope.kind !== 'markdown') return
    restoreDomSelectionFromOffsets(this.root, sel.scope.start, sel.scope.end)
  }

  getSelectionRects(sel: SurfaceSelection): DOMRect[] {
    if (sel.scope.kind !== 'markdown') return []
    return getClientRectsForOffsets(this.root, sel.scope.start, sel.scope.end)
  }

  resolveAnnotation(annotation: AnnotationV1): ResolvedAnnotation | null {
    let canonical: string
    try {
      canonical = getCanonicalText(this.root)
    } catch {
      return { rects: [], isValid: false, failureReason: 'surface-unavailable' }
    }
    if (!canonical) {
      return { rects: [], isValid: false, failureReason: 'surface-unavailable' }
    }

    const result = resolveTextAnnotations(canonical, [annotation])
    const resolved = result.resolved[0]
    if (!resolved) {
      return { rects: [], isValid: false, failureReason: 'quote-not-found' }
    }

    const rects = getClientRectsForOffsets(this.root, resolved.range.start, resolved.range.end)
    return { rects, isValid: true }
  }

  getFollowUpContext(sel: SurfaceSelection): FollowUpContext {
    let canonical: string
    try {
      canonical = getCanonicalText(this.root)
    } catch {
      // No DOM available (test environment)
      return { surroundingText: sel.selectedText, documentType: 'markdown' }
    }
    const start = sel.scope.kind === 'markdown' ? sel.scope.start : 0
    const end = sel.scope.kind === 'markdown' ? sel.scope.end : sel.selectedText.length

    const contextStart = Math.max(0, start - 500)
    const contextEnd = Math.min(canonical.length, end + 500)
    const surroundingText = canonical.slice(contextStart, contextEnd)

    return {
      surroundingText: surroundingText || sel.selectedText,
      documentType: 'markdown',
    }
  }

  setRenderedAnnotations(annotations: AnnotationV1[]): void {
    const root = this.root
    if (!root) return

    clearAnnotationMarks(root)

    if (annotations.length === 0) return

    let canonical: string
    try {
      canonical = getCanonicalText(root)
    } catch {
      return
    }
    if (!canonical) return

    const resolution = resolveTextAnnotations(canonical, annotations)

    for (const item of resolution.resolved) {
      // Build a stable 1-based index from the original annotation order
      const index = annotations.indexOf(item.annotation)
      applyTextHighlightRange(root, item.range, item.annotation, index >= 0 ? index + 1 : undefined)
    }
  }

  observeGeometryInvalidation(cb: () => void): () => void {
    // Throttle to at most once per animation frame
    let rafId: number | null = null
    const throttledCb = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        cb()
      })
    }

    try {
      window.addEventListener('resize', throttledCb)
    } catch {
      // No window in test environment
      return () => {}
    }

    // Scroll observation on the root's scroll container
    const scrollParent = findScrollParent(this.root)
    if (scrollParent) {
      scrollParent.addEventListener('scroll', throttledCb, { passive: true })
    }

    // ResizeObserver for content reflows
    let resizeObserver: ResizeObserver | undefined
    try {
      resizeObserver = new ResizeObserver(throttledCb)
      resizeObserver.observe(this.root)
    } catch {
      // ResizeObserver not available
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      try { window.removeEventListener('resize', throttledCb) } catch { /* noop */ }
      if (scrollParent) {
        scrollParent.removeEventListener('scroll', throttledCb)
      }
      resizeObserver?.disconnect()
    }
  }
}

/** Walk up the DOM to find the nearest scrollable ancestor. */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el.parentElement
  while (current) {
    const overflow = getComputedStyle(current).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return current
    current = current.parentElement
  }
  return null
}
