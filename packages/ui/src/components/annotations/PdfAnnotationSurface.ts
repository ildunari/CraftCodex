/**
 * PdfAnnotationSurface — AnnotationSurface implementation for PDF documents.
 *
 * Works with react-pdf's text layer (renderTextLayer=true). Text selection
 * happens natively on the text layer spans; this surface captures and resolves
 * selections using the DOM text content for stable prefix/suffix anchoring.
 *
 * Highlights are rendered as overlay divs (position: absolute) rather than
 * DOM mutation — the PDF text layer is too fragile for CSS Custom Highlight
 * or direct span manipulation.
 */

import type { AnnotationV1 } from '@craft-agent/core'
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api'
import type {
  AnnotationSurface,
  SurfaceSelection,
  FollowUpContext,
  ResolvedAnnotation,
} from './types'
import { extractContext } from './pdf-text-utils'
import { annotationColorToCss } from './annotation-style-tokens'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGHLIGHT_CLASS = 'pdf-annotation-highlight'
const HIGHLIGHT_CONTAINER_CLASS = 'pdf-annotation-overlay'
const PREFIX_SUFFIX_WINDOW = 200

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the `.react-pdf__Page` ancestor of a node.
 */
function findPageElement(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement
  return el?.closest<HTMLElement>('.react-pdf__Page') ?? null
}

/**
 * Extract page number from a react-pdf Page element.
 */
function getPageNumber(pageEl: HTMLElement): number | null {
  const attr = pageEl.getAttribute('data-page-number')
  if (attr) {
    const num = parseInt(attr, 10)
    if (!Number.isNaN(num)) return num
  }
  return null
}

/**
 * Check whether a browser selection spans multiple PDF pages.
 */
function isCrossPageSelection(range: Range): boolean {
  const startPage = findPageElement(range.startContainer)
  const endPage = findPageElement(range.endContainer)
  if (!startPage || !endPage) return false
  return startPage !== endPage
}

/**
 * Find the text-quote selector on an annotation, if present.
 */
function getQuoteSelector(
  annotation: AnnotationV1,
): { type: 'text-quote'; exact: string; prefix?: string; suffix?: string } | null {
  for (const sel of annotation.target.selectors) {
    if (sel.type === 'text-quote') return sel
  }
  return null
}

/**
 * Get the page number from annotation meta.document.page or xywh selectors.
 */
function getAnnotationPage(annotation: AnnotationV1): number | null {
  const meta = annotation.meta as Record<string, unknown> | undefined
  if (meta?.document && typeof meta.document === 'object') {
    const doc = meta.document as Record<string, unknown>
    if (typeof doc.page === 'number') return doc.page
  }
  for (const sel of annotation.target.selectors) {
    if (sel.type === 'xywh' && sel.page != null) return sel.page
  }
  return null
}

// ---------------------------------------------------------------------------
// PdfAnnotationSurface
// ---------------------------------------------------------------------------

export class PdfAnnotationSurface implements AnnotationSurface {
  readonly kind = 'pdf' as const

  private container: HTMLElement
  private getPage: (pageNumber: number) => Promise<PDFPageProxy>
  private overlayContainer: HTMLElement | null = null
  private fileName?: string

  constructor(
    container: HTMLElement,
    getPage: (pageNumber: number) => Promise<PDFPageProxy>,
    fileName?: string,
  ) {
    this.container = container
    this.getPage = getPage
    this.fileName = fileName
  }

  // -------------------------------------------------------------------------
  // captureSelection
  // -------------------------------------------------------------------------

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

    // Verify selection is within our container
    const common = range.commonAncestorContainer
    const commonEl = common.nodeType === Node.ELEMENT_NODE
      ? (common as HTMLElement)
      : common.parentElement
    if (!commonEl || !this.container.contains(commonEl)) return null

    // Cross-page selection: return null (caller should show a toast)
    if (isCrossPageSelection(range)) {
      return null
    }

    const selectedText = range.toString()
    if (!selectedText.trim()) return null

    const pageEl = findPageElement(range.startContainer)
    if (!pageEl) return null

    const pageNumber = getPageNumber(pageEl)
    if (pageNumber == null) return null

    // Check for text layer (scanned pages won't have one)
    const textLayer = pageEl.querySelector('.react-pdf__Page__textContent')
    if (!textLayer) return null

    // Build prefix/suffix from the text layer's DOM content
    const pageText = textLayer.textContent ?? ''
    const { prefix, suffix } = extractContext(pageText, selectedText, PREFIX_SUFFIX_WINDOW)

    return {
      selectedText,
      prefix,
      suffix,
      scope: { kind: 'pdf', pageNumber },
    }
  }

  // -------------------------------------------------------------------------
  // restoreSelection
  // -------------------------------------------------------------------------

  /**
   * Restore a selection visually via overlay rectangles.
   * We do NOT restore a native DOM selection — the PDF text layer spans
   * are too fragile and may have been re-rendered.
   */
  restoreSelection(sel: SurfaceSelection): void {
    if (sel.scope.kind !== 'pdf') return

    try {
      const rects = this.getSelectionRects(sel)
      if (rects.length === 0) return

      this.renderHighlightRects(rects, 'pdf-selection-restore')
    } catch {
      // DOM not available
    }
  }

  // -------------------------------------------------------------------------
  // getSelectionRects
  // -------------------------------------------------------------------------

  getSelectionRects(sel: SurfaceSelection): DOMRect[] {
    if (sel.scope.kind !== 'pdf') return []

    try {
      const pageNumber = sel.scope.pageNumber
      const pageEl = this.container.querySelector?.(
        `.react-pdf__Page[data-page-number="${pageNumber}"]`,
      )
      if (!pageEl) return []

      const textLayer = pageEl.querySelector('.react-pdf__Page__textContent')
      if (!textLayer) return []

      return this.findTextRects(textLayer as HTMLElement, sel.selectedText)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // resolveAnnotation
  // -------------------------------------------------------------------------

  resolveAnnotation(annotation: AnnotationV1): ResolvedAnnotation | null {
    const quote = getQuoteSelector(annotation)
    if (!quote) {
      return { rects: [], isValid: false, failureReason: 'quote-not-found' }
    }

    const pageNumber = getAnnotationPage(annotation)

    // Search text layers for the quoted text
    const pages = this.container.querySelectorAll<HTMLElement>('.react-pdf__Page')
    const targetPages = pageNumber
      ? Array.from(pages).filter((p) => getPageNumber(p) === pageNumber)
      : Array.from(pages)

    if (pageNumber && targetPages.length === 0) {
      return { rects: [], isValid: false, failureReason: 'page-missing' }
    }

    for (const page of targetPages) {
      const textLayer = page.querySelector('.react-pdf__Page__textContent')
      if (!textLayer) continue

      const rects = this.findTextRects(textLayer as HTMLElement, quote.exact)
      if (rects.length > 0) {
        return { rects, isValid: true }
      }
    }

    return { rects: [], isValid: false, failureReason: 'quote-not-found' }
  }

  // -------------------------------------------------------------------------
  // getFollowUpContext
  // -------------------------------------------------------------------------

  getFollowUpContext(sel: SurfaceSelection): FollowUpContext {
    if (sel.scope.kind !== 'pdf') {
      return { surroundingText: sel.selectedText, documentType: 'pdf' }
    }

    const pageNumber = sel.scope.pageNumber
    let pageText = sel.selectedText

    try {
      const pageEl = this.container.querySelector?.(
        `.react-pdf__Page[data-page-number="${pageNumber}"]`,
      )
      const textLayer = pageEl?.querySelector('.react-pdf__Page__textContent')
      if (textLayer?.textContent) {
        pageText = textLayer.textContent
      }
    } catch {
      // DOM not available (test environment)
    }

    const { surrounding } = extractContext(pageText, sel.selectedText, 500)

    return {
      fileName: this.fileName?.split('/').pop() ?? this.fileName,
      pageOrSlide: pageNumber,
      surroundingText: surrounding || sel.selectedText,
      documentType: 'pdf',
    }
  }

  // -------------------------------------------------------------------------
  // setRenderedAnnotations
  // -------------------------------------------------------------------------

  setRenderedAnnotations(annotations: AnnotationV1[]): void {
    this.clearOverlayHighlights()

    if (annotations.length === 0) return

    for (let i = 0; i < annotations.length; i++) {
      const annotation = annotations[i]!
      const resolved = this.resolveAnnotation(annotation)
      if (!resolved || !resolved.isValid) continue

      this.renderHighlightRects(
        resolved.rects,
        `pdf-annotation-${annotation.id}`,
        i + 1,
      )
    }
  }

  // -------------------------------------------------------------------------
  // observeGeometryInvalidation
  // -------------------------------------------------------------------------

  observeGeometryInvalidation(cb: () => void): () => void {
    const handleChange = () => cb()

    try {
      window.addEventListener('resize', handleChange)
    } catch {
      return () => {}
    }

    // Watch scroll on the container (PDF overlay scrolls)
    this.container.addEventListener('scroll', handleChange, { passive: true })

    // ResizeObserver for container size changes (zoom, etc.)
    let resizeObserver: ResizeObserver | undefined
    try {
      resizeObserver = new ResizeObserver(handleChange)
      resizeObserver.observe(this.container)
    } catch {
      // Not available
    }

    return () => {
      try { window.removeEventListener('resize', handleChange) } catch { /* noop */ }
      this.container.removeEventListener('scroll', handleChange)
      resizeObserver?.disconnect()
    }
  }

  // -------------------------------------------------------------------------
  // Private: text search in DOM
  // -------------------------------------------------------------------------

  /**
   * Find DOMRects for a text string within a text layer element.
   * Walks text nodes, builds a Range over the matching substring.
   */
  private findTextRects(textLayer: HTMLElement, searchText: string): DOMRect[] {
    if (!searchText) return []

    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let fullText = ''

    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text
      textNodes.push(textNode)
      fullText += textNode.textContent ?? ''
    }

    const idx = fullText.indexOf(searchText)
    if (idx === -1) return []

    // Map character offsets to text nodes
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

    if (!startNode || !endNode) return []

    try {
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      return Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      )
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // Private: overlay highlight rendering
  // -------------------------------------------------------------------------

  private getOrCreateOverlayContainer(): HTMLElement {
    if (this.overlayContainer && this.container.contains(this.overlayContainer)) {
      return this.overlayContainer
    }

    let overlay = this.container.querySelector(`.${HIGHLIGHT_CONTAINER_CLASS}`) as HTMLElement | null
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = HIGHLIGHT_CONTAINER_CLASS
      overlay.style.position = 'absolute'
      overlay.style.top = '0'
      overlay.style.left = '0'
      overlay.style.width = '100%'
      overlay.style.height = '100%'
      overlay.style.pointerEvents = 'none'
      overlay.style.zIndex = '5'

      // Ensure container is positioned for absolute children
      const containerPosition = getComputedStyle(this.container).position
      if (containerPosition === 'static') {
        this.container.style.position = 'relative'
      }

      this.container.appendChild(overlay)
    }

    this.overlayContainer = overlay
    return overlay
  }

  private renderHighlightRects(
    rects: DOMRect[],
    groupId: string,
    _annotationIndex?: number,
  ): void {
    const overlay = this.getOrCreateOverlayContainer()
    const containerRect = this.container.getBoundingClientRect()

    for (const rect of rects) {
      const div = document.createElement('div')
      div.className = HIGHLIGHT_CLASS
      div.dataset.group = groupId
      div.style.position = 'absolute'
      div.style.left = `${rect.left - containerRect.left + this.container.scrollLeft}px`
      div.style.top = `${rect.top - containerRect.top + this.container.scrollTop}px`
      div.style.width = `${rect.width}px`
      div.style.height = `${rect.height}px`
      div.style.backgroundColor = annotationColorToCss()
      div.style.pointerEvents = 'none'
      div.style.borderRadius = '3px'
      overlay.appendChild(div)
    }
  }

  private clearOverlayHighlights(): void {
    if (!this.overlayContainer) return
    const highlights = this.overlayContainer.querySelectorAll(`.${HIGHLIGHT_CLASS}`)
    highlights.forEach((el) => el.remove())
  }
}
