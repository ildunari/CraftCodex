/**
 * iframe-selection-bridge — Bridge between iframe content and parent frame
 * for selection operations.
 *
 * Because our iframes use `sandbox="allow-same-origin"`, we can access
 * `iframe.contentDocument` directly. This module handles:
 * - Capturing selections from iframe content documents
 * - Mapping DOMRect coordinates from iframe space to parent frame space
 * - Bridging selection/mouse events from iframe to parent
 * - Extracting contextual text around selections
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IframeSelection {
  selectedText: string
  prefix: string
  suffix: string
  range: Range
}

export interface IframeContext {
  surrounding: string
  sectionHeading?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_CHARS = 200

// ---------------------------------------------------------------------------
// captureIframeSelection
// ---------------------------------------------------------------------------

/**
 * Capture the current selection from an iframe's content document.
 * Returns null if there is no selection, the iframe is inaccessible, or
 * the selection is collapsed/empty.
 */
export function captureIframeSelection(
  iframe: HTMLIFrameElement,
): IframeSelection | null {
  let doc: Document | null = null
  try {
    doc = iframe.contentDocument
  } catch {
    return null
  }
  if (!doc) return null

  let selection: Selection | null = null
  try {
    selection = doc.getSelection?.() ?? iframe.contentWindow?.getSelection?.() ?? null
  } catch {
    return null
  }

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null
  }

  const range = selection.getRangeAt(0)
  const selectedText = range.toString()
  if (!selectedText.trim()) return null

  // Build prefix/suffix from the full document text
  const bodyText = doc.body?.textContent ?? ''
  const selIdx = bodyText.indexOf(selectedText)

  let prefix = ''
  let suffix = ''

  if (selIdx >= 0) {
    prefix = bodyText.slice(Math.max(0, selIdx - DEFAULT_CONTEXT_CHARS), selIdx)
    suffix = bodyText.slice(
      selIdx + selectedText.length,
      selIdx + selectedText.length + DEFAULT_CONTEXT_CHARS,
    )
  }

  return { selectedText, prefix, suffix, range }
}

// ---------------------------------------------------------------------------
// mapIframeRectsToParent
// ---------------------------------------------------------------------------

/**
 * Map DOMRect coordinates from iframe-internal space to parent frame space.
 *
 * Accounts for:
 * - The iframe element's bounding rect in the parent
 * - Internal scroll position within the iframe
 * - CSS transforms (scale) applied to the iframe element
 */
export function mapIframeRectsToParent(
  iframe: HTMLIFrameElement,
  rects: DOMRect[],
): DOMRect[] {
  const iframeRect = iframe.getBoundingClientRect()
  const scale = getIframeScale(iframe)

  // Account for iframe internal scroll
  let scrollX = 0
  let scrollY = 0
  try {
    const win = iframe.contentWindow
    if (win) {
      scrollX = win.scrollX ?? win.pageXOffset ?? 0
      scrollY = win.scrollY ?? win.pageYOffset ?? 0
    }
  } catch {
    // Cross-origin fallback — no scroll offset
  }

  return rects.map((rect) => {
    const x = iframeRect.left + (rect.x - scrollX) * scale
    const y = iframeRect.top + (rect.y - scrollY) * scale
    const width = rect.width * scale
    const height = rect.height * scale
    return new DOMRect(x, y, width, height)
  })
}

/**
 * Detect scale factor from CSS transform on the iframe element.
 * Parses `matrix(a, b, c, d, tx, ty)` — scale is `a` (assuming uniform).
 */
export function getIframeScale(iframe: HTMLIFrameElement): number {
  try {
    const style = getComputedStyle(iframe)
    const transform = style.transform
    if (!transform || transform === 'none') return 1

    // matrix(a, b, c, d, tx, ty) — a is scaleX
    const match = transform.match(/matrix\(([^,]+)/)
    if (match?.[1]) {
      const scale = parseFloat(match[1])
      if (!Number.isNaN(scale) && scale > 0) return scale
    }
  } catch {
    // getComputedStyle not available
  }
  return 1
}

// ---------------------------------------------------------------------------
// bridgeSelectionEvents
// ---------------------------------------------------------------------------

/**
 * Attach mouseup and selectionchange listeners on the iframe's content
 * document, bridging events to the parent frame. Returns a cleanup function
 * that removes all listeners.
 */
export function bridgeSelectionEvents(
  iframe: HTMLIFrameElement,
  onSelectionChange: () => void,
  onMouseUp: (event: MouseEvent) => void,
): () => void {
  let doc: Document | null = null
  try {
    doc = iframe.contentDocument
  } catch {
    return () => {}
  }
  if (!doc) return () => {}

  const handleSelectionChange = () => {
    onSelectionChange()
  }

  const handleMouseUp = (e: Event) => {
    onMouseUp(e as MouseEvent)
  }

  doc.addEventListener('selectionchange', handleSelectionChange)
  doc.addEventListener('mouseup', handleMouseUp)

  return () => {
    try {
      doc!.removeEventListener('selectionchange', handleSelectionChange)
      doc!.removeEventListener('mouseup', handleMouseUp)
    } catch {
      // iframe may have been removed from DOM
    }
  }
}

// ---------------------------------------------------------------------------
// extractIframeContext
// ---------------------------------------------------------------------------

/**
 * Extract surrounding text from the iframe DOM around a selection.
 * Walks up from the selection anchor to find the nearest heading (h1-h6)
 * for section context.
 */
export function extractIframeContext(
  iframe: HTMLIFrameElement,
  selectedText: string,
  maxContext: number = 500,
): IframeContext {
  let doc: Document | null = null
  try {
    doc = iframe.contentDocument
  } catch {
    return { surrounding: selectedText }
  }
  if (!doc?.body) return { surrounding: selectedText }

  const bodyText = doc.body.textContent ?? ''
  const idx = bodyText.indexOf(selectedText)

  let surrounding = selectedText
  if (idx >= 0) {
    const start = Math.max(0, idx - maxContext)
    const end = Math.min(bodyText.length, idx + selectedText.length + maxContext)
    surrounding = bodyText.slice(start, end)
  }

  // Find nearest heading by walking up from the selection anchor
  const sectionHeading = findNearestHeading(doc, selectedText)

  return { surrounding, sectionHeading: sectionHeading ?? undefined }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Search for the nearest heading element (h1-h6) that precedes or contains
 * the selected text in the document.
 */
function findNearestHeading(doc: Document, selectedText: string): string | null {
  // Get the current selection to find the anchor node
  let anchorNode: Node | null = null
  try {
    const sel = doc.getSelection?.()
    if (sel && sel.anchorNode) {
      anchorNode = sel.anchorNode
    }
  } catch {
    // No selection available
  }

  if (anchorNode) {
    // Walk up from anchor to find a heading ancestor or preceding sibling heading
    let current: Node | null = anchorNode.nodeType === Node.ELEMENT_NODE
      ? anchorNode
      : anchorNode.parentElement
    while (current && current !== doc.body) {
      const el = current as HTMLElement
      if (/^H[1-6]$/i.test(el.tagName)) {
        return el.textContent?.trim() ?? null
      }

      // Check preceding siblings for headings
      let sibling = el.previousElementSibling
      while (sibling) {
        if (/^H[1-6]$/i.test(sibling.tagName)) {
          return sibling.textContent?.trim() ?? null
        }
        sibling = sibling.previousElementSibling
      }

      current = el.parentElement
    }
  }

  // Fallback: find all headings and pick the last one before our text
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6')
  const bodyText = doc.body.textContent ?? ''
  const selIdx = bodyText.indexOf(selectedText)
  if (selIdx < 0) return null

  let bestHeading: string | null = null
  for (const h of headings) {
    const hText = h.textContent ?? ''
    const hIdx = bodyText.indexOf(hText)
    if (hIdx >= 0 && hIdx < selIdx) {
      bestHeading = hText.trim()
    }
  }

  return bestHeading
}
