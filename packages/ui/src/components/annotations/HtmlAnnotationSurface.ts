/**
 * HtmlAnnotationSurface — AnnotationSurface implementation for HTML iframes.
 *
 * Works with sandboxed iframes that use `sandbox="allow-same-origin"`,
 * which allows access to `iframe.contentDocument` for selection capture,
 * text search, and highlight rendering.
 *
 * Highlights use the CSS Custom Highlight API when available
 * (`iframe.contentWindow.CSS.highlights`), falling back to overlay rects.
 */

import type { AnnotationV1 } from '@craft-agent/core'
import type {
  AnnotationSurface,
  SurfaceSelection,
  FollowUpContext,
  ResolvedAnnotation,
} from './types'
import {
  captureIframeSelection,
  mapIframeRectsToParent,
  extractIframeContext,
} from './iframe-selection-bridge'
import { annotationColorToCss, HIGHLIGHT_FALLBACK_COLOR } from './annotation-style-tokens'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGHLIGHT_STYLE_ID = 'annotation-highlight-styles'
const OVERLAY_CONTAINER_CLASS = 'html-annotation-overlay'
const OVERLAY_HIGHLIGHT_CLASS = 'html-annotation-highlight'

// ---------------------------------------------------------------------------
// HtmlAnnotationSurface
// ---------------------------------------------------------------------------

export class HtmlAnnotationSurface implements AnnotationSurface {
  readonly kind = 'html' as const

  private iframe: HTMLIFrameElement
  private fileName?: string

  constructor(iframe: HTMLIFrameElement, fileName?: string) {
    this.iframe = iframe
    this.fileName = fileName
  }

  // -------------------------------------------------------------------------
  // captureSelection
  // -------------------------------------------------------------------------

  captureSelection(): SurfaceSelection | null {
    const captured = captureIframeSelection(this.iframe)
    if (!captured) return null

    // Build a CSS selector scope for the selection's container
    const cssSelector = this.buildCssSelector(captured.range)

    return {
      selectedText: captured.selectedText,
      prefix: captured.prefix,
      suffix: captured.suffix,
      scope: { kind: 'html', cssSelector: cssSelector ?? undefined },
    }
  }

  // -------------------------------------------------------------------------
  // restoreSelection
  // -------------------------------------------------------------------------

  /**
   * Restore a selection visually. Uses CSS Custom Highlight API if available,
   * otherwise falls back to overlay rects.
   */
  restoreSelection(sel: SurfaceSelection): void {
    if (sel.scope.kind !== 'html') return

    const doc = this.getContentDocument()
    if (!doc) return

    const range = this.findTextRange(doc, sel.selectedText)
    if (!range) return

    const highlights = this.getHighlightsAPI()
    if (highlights) {
      try {
        const HighlightCtor = this.getHighlightConstructor()
        if (HighlightCtor) {
          const highlight = new HighlightCtor(range)
          highlights.set('selection-restore', highlight)
          this.ensureHighlightStyles([{ id: 'selection-restore', color: 'rgba(100, 150, 255, 0.3)' }])
        }
        return
      } catch {
        // Fall through to overlay
      }
    }

    // Fallback: overlay rects
    const rects = mapIframeRectsToParent(this.iframe, Array.from(range.getClientRects()))
    this.renderOverlayRects(rects, 'selection-restore')
  }

  // -------------------------------------------------------------------------
  // getSelectionRects
  // -------------------------------------------------------------------------

  getSelectionRects(sel: SurfaceSelection): DOMRect[] {
    if (sel.scope.kind !== 'html') return []

    const doc = this.getContentDocument()
    if (!doc) return []

    const range = this.findTextRange(doc, sel.selectedText)
    if (!range) return []

    const innerRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0,
    )

    return mapIframeRectsToParent(this.iframe, innerRects)
  }

  // -------------------------------------------------------------------------
  // resolveAnnotation
  // -------------------------------------------------------------------------

  resolveAnnotation(annotation: AnnotationV1): ResolvedAnnotation | null {
    const doc = this.getContentDocument()
    if (!doc) {
      return { rects: [], isValid: false, failureReason: 'surface-unavailable' }
    }

    const quote = this.getQuoteSelector(annotation)
    if (!quote) {
      return { rects: [], isValid: false, failureReason: 'quote-not-found' }
    }

    const range = this.findTextRange(doc, quote.exact)
    if (!range) {
      return { rects: [], isValid: false, failureReason: 'quote-not-found' }
    }

    const innerRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0,
    )

    const rects = mapIframeRectsToParent(this.iframe, innerRects)
    return { rects, isValid: true }
  }

  // -------------------------------------------------------------------------
  // getFollowUpContext
  // -------------------------------------------------------------------------

  getFollowUpContext(sel: SurfaceSelection): FollowUpContext {
    const ctx = extractIframeContext(this.iframe, sel.selectedText, 500)

    return {
      fileName: this.fileName?.split('/').pop() ?? this.fileName,
      sectionHeading: ctx.sectionHeading,
      surroundingText: ctx.surrounding || sel.selectedText,
      documentType: 'html',
    }
  }

  // -------------------------------------------------------------------------
  // setRenderedAnnotations
  // -------------------------------------------------------------------------

  /**
   * Render annotations as highlights in the iframe.
   * Prefers CSS Custom Highlight API; falls back to overlay rects.
   */
  setRenderedAnnotations(annotations: AnnotationV1[]): void {
    this.clearAllHighlights()

    if (annotations.length === 0) return

    const doc = this.getContentDocument()
    if (!doc) return

    const highlights = this.getHighlightsAPI()
    const HighlightCtor = this.getHighlightConstructor()
    const useCustomHighlights = !!(highlights && HighlightCtor)

    const styleEntries: Array<{ id: string; color: string }> = []

    for (let i = 0; i < annotations.length; i++) {
      const annotation = annotations[i]!
      const quote = this.getQuoteSelector(annotation)
      if (!quote) continue

      const range = this.findTextRange(doc, quote.exact)
      if (!range) continue

      const highlightId = `annotation-${annotation.id}`

      if (useCustomHighlights) {
        try {
          const highlight = new HighlightCtor!(range)
          highlights!.set(highlightId, highlight)
          styleEntries.push({ id: highlightId, color: HIGHLIGHT_FALLBACK_COLOR })
          continue
        } catch {
          // Fall through to overlay for this annotation
        }
      }

      // Overlay fallback
      const innerRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      )
      const parentRects = mapIframeRectsToParent(this.iframe, innerRects)
      this.renderOverlayRects(parentRects, highlightId, i + 1)
    }

    if (styleEntries.length > 0) {
      this.ensureHighlightStyles(styleEntries)
    }
  }

  // -------------------------------------------------------------------------
  // observeGeometryInvalidation
  // -------------------------------------------------------------------------

  observeGeometryInvalidation(cb: () => void): () => void {
    const handleChange = () => cb()

    // Parent window resize
    try {
      window.addEventListener('resize', handleChange)
    } catch {
      return () => {}
    }

    // Iframe internal scroll
    let iframeCleanup: (() => void) | null = null
    try {
      const win = this.iframe.contentWindow
      if (win) {
        win.addEventListener('scroll', handleChange, { passive: true })
        iframeCleanup = () => {
          try { win.removeEventListener('scroll', handleChange) } catch { /* noop */ }
        }
      }
    } catch {
      // Cross-origin or no window
    }

    // ResizeObserver on iframe element
    let resizeObserver: ResizeObserver | undefined
    try {
      resizeObserver = new ResizeObserver(handleChange)
      resizeObserver.observe(this.iframe)
    } catch {
      // Not available
    }

    return () => {
      try { window.removeEventListener('resize', handleChange) } catch { /* noop */ }
      iframeCleanup?.()
      resizeObserver?.disconnect()
    }
  }

  // -------------------------------------------------------------------------
  // Private: CSS Custom Highlight API
  // -------------------------------------------------------------------------

  /**
   * Get the CSS.highlights map from the iframe's content window.
   * Returns null if the API is not available.
   */
  private getHighlightsAPI(): Map<string, unknown> | null {
    try {
      const win = this.iframe.contentWindow as {
        CSS?: { highlights?: Map<string, unknown> }
      } | null
      return win?.CSS?.highlights ?? null
    } catch {
      return null
    }
  }

  /**
   * Get the Highlight constructor from the iframe's content window.
   */
  private getHighlightConstructor(): (new (...args: Range[]) => unknown) | null {
    try {
      const win = this.iframe.contentWindow as {
        Highlight?: new (...args: Range[]) => unknown
      } | null
      return win?.Highlight ?? null
    } catch {
      return null
    }
  }

  /**
   * Inject or update a <style> element in the iframe document with
   * ::highlight() pseudo-element rules for each annotation.
   */
  private ensureHighlightStyles(entries: Array<{ id: string; color: string }>): void {
    const doc = this.getContentDocument()
    if (!doc) return

    let styleEl = doc.getElementById(HIGHLIGHT_STYLE_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = doc.createElement('style')
      styleEl.id = HIGHLIGHT_STYLE_ID
      ;(doc.head ?? doc.documentElement).appendChild(styleEl)
    }

    const css = entries
      .map((e) => `::highlight(${e.id}) { background-color: ${e.color}; }`)
      .join('\n')
    styleEl.textContent = css
  }

  // -------------------------------------------------------------------------
  // Private: overlay highlight fallback
  // -------------------------------------------------------------------------

  private renderOverlayRects(
    rects: DOMRect[],
    groupId: string,
    _index?: number,
  ): void {
    const parent = this.iframe.parentElement
    if (!parent) return

    let overlay = parent.querySelector(`.${OVERLAY_CONTAINER_CLASS}`) as HTMLElement | null
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = OVERLAY_CONTAINER_CLASS
      overlay.style.position = 'absolute'
      overlay.style.top = '0'
      overlay.style.left = '0'
      overlay.style.width = '100%'
      overlay.style.height = '100%'
      overlay.style.pointerEvents = 'none'
      overlay.style.zIndex = '2'

      const parentPosition = getComputedStyle(parent).position
      if (parentPosition === 'static') {
        parent.style.position = 'relative'
      }

      parent.appendChild(overlay)
    }

    const parentRect = parent.getBoundingClientRect()
    for (const rect of rects) {
      const div = document.createElement('div')
      div.className = OVERLAY_HIGHLIGHT_CLASS
      div.dataset.group = groupId
      div.style.position = 'absolute'
      div.style.left = `${rect.left - parentRect.left}px`
      div.style.top = `${rect.top - parentRect.top}px`
      div.style.width = `${rect.width}px`
      div.style.height = `${rect.height}px`
      div.style.backgroundColor = annotationColorToCss()
      div.style.pointerEvents = 'none'
      div.style.borderRadius = '3px'
      overlay.appendChild(div)
    }
  }

  // -------------------------------------------------------------------------
  // Private: cleanup
  // -------------------------------------------------------------------------

  private clearAllHighlights(): void {
    // Clear CSS Custom Highlights
    const highlights = this.getHighlightsAPI()
    if (highlights) {
      try {
        highlights.clear()
      } catch {
        // API error
      }
    }

    // Remove injected styles
    try {
      const doc = this.getContentDocument()
      doc?.getElementById(HIGHLIGHT_STYLE_ID)?.remove()
    } catch {
      // noop
    }

    // Clear overlay rects
    const parent = this.iframe.parentElement
    if (parent) {
      const overlay = parent.querySelector(`.${OVERLAY_CONTAINER_CLASS}`)
      overlay?.remove()
    }
  }

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private getContentDocument(): Document | null {
    try {
      return this.iframe.contentDocument
    } catch {
      return null
    }
  }

  /**
   * Find a Range in the document that covers the given text string.
   * Walks all text nodes and builds a range from the first occurrence.
   */
  private findTextRange(doc: Document, searchText: string): Range | null {
    if (!searchText || !doc.body) return null

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let fullText = ''

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text)
      fullText += (walker.currentNode as Text).textContent ?? ''
    }

    const idx = fullText.indexOf(searchText)
    if (idx === -1) return null

    // Map character offset to text node + offset
    let charCount = 0
    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0
    const targetEnd = idx + searchText.length

    for (const node of textNodes) {
      const len = node.textContent?.length ?? 0

      if (!startNode && charCount + len > idx) {
        startNode = node
        startOffset = idx - charCount
      }

      if (charCount + len >= targetEnd) {
        endNode = node
        endOffset = targetEnd - charCount
        break
      }

      charCount += len
    }

    if (!startNode || !endNode) return null

    try {
      const range = doc.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      return range
    } catch {
      return null
    }
  }

  /**
   * Build a CSS selector for the range's common ancestor container.
   */
  private buildCssSelector(range: Range): string | null {
    try {
      const container = range.commonAncestorContainer
      const el = container.nodeType === Node.ELEMENT_NODE
        ? (container as HTMLElement)
        : container.parentElement
      if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return null

      // Use id if available
      if (el.id) return `#${el.id}`

      // Use tag + class combo
      const tag = el.tagName.toLowerCase()
      const classes = Array.from(el.classList).join('.')
      return classes ? `${tag}.${classes}` : tag
    } catch {
      return null
    }
  }

  /**
   * Extract the text-quote selector from an annotation.
   */
  private getQuoteSelector(
    annotation: AnnotationV1,
  ): { type: 'text-quote'; exact: string; prefix?: string; suffix?: string } | null {
    for (const sel of annotation.target.selectors) {
      if (sel.type === 'text-quote') return sel
    }
    return null
  }
}
