/**
 * PDF text extraction utilities.
 *
 * Helpers for working with pdfjs TextContent objects — extracting text,
 * detecting headings, computing disambiguation hashes, etc.
 *
 * All functions are pure and operate on the TextContent/TextItem types
 * from pdfjs-dist so they can be unit-tested without a browser.
 */

import type { TextContent, TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api'

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** Narrow a TextContent item to TextItem (excludes TextMarkedContent). */
export function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return 'str' in item
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Extract only the TextItem entries from a TextContent result. */
export function extractTextItems(textContent: TextContent): TextItem[] {
  return textContent.items.filter(isTextItem)
}

/**
 * Get the full plain text of a page by joining all text items.
 * Items ending with EOL get a newline; others are joined with a space
 * (unless the previous item already ends with whitespace).
 */
export function getPageText(textContent: TextContent): string {
  const items = extractTextItems(textContent)
  if (items.length === 0) return ''

  const parts: string[] = []
  for (const item of items) {
    parts.push(item.str)
    if (item.hasEOL) {
      parts.push('\n')
    } else {
      parts.push(' ')
    }
  }

  // Trim trailing whitespace that the last separator adds
  return parts.join('').trimEnd()
}

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

/**
 * Extract surrounding context around a selection within the page text.
 *
 * @param pageText  Full page text (from getPageText)
 * @param selectedText  The user's selected text
 * @param maxContext  Max chars of context on each side (default 500)
 * @returns prefix, suffix, and the full surrounding window
 */
export function extractContext(
  pageText: string,
  selectedText: string,
  maxContext = 500,
): { prefix: string; suffix: string; surrounding: string } {
  const idx = pageText.indexOf(selectedText)
  if (idx === -1) {
    // Fallback: return what we can
    return { prefix: '', suffix: '', surrounding: selectedText }
  }

  const start = Math.max(0, idx - maxContext)
  const end = Math.min(pageText.length, idx + selectedText.length + maxContext)

  const prefix = pageText.slice(start, idx)
  const suffix = pageText.slice(idx + selectedText.length, end)
  const surrounding = pageText.slice(start, end)

  return { prefix, suffix, surrounding }
}

// ---------------------------------------------------------------------------
// Heading detection
// ---------------------------------------------------------------------------

/**
 * Detect probable headings by font-size heuristic.
 *
 * Text items whose height is > 1.3x the median height of all items
 * are considered headings. The height field on TextItem corresponds to
 * the font size in device-space units.
 */
export function detectHeadings(
  textContent: TextContent,
): Array<{ text: string; fontSize: number }> {
  const items = extractTextItems(textContent)
  if (items.length === 0) return []

  // Collect heights, ignoring zero-height items (whitespace-only)
  const heights = items
    .map((item) => item.height)
    .filter((h) => h > 0)

  if (heights.length === 0) return []

  // Median height
  const sorted = [...heights].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)

  const threshold = median * 1.3

  const headings: Array<{ text: string; fontSize: number }> = []
  for (const item of items) {
    if (item.height > threshold && item.str.trim()) {
      headings.push({ text: item.str.trim(), fontSize: item.height })
    }
  }

  return headings
}

// ---------------------------------------------------------------------------
// Text availability check
// ---------------------------------------------------------------------------

/**
 * Check whether a page has extractable text (vs scanned/image-only).
 * A page is considered text-available if it has at least one non-empty TextItem.
 */
export function isTextAvailable(textContent: TextContent): boolean {
  return extractTextItems(textContent).some((item) => item.str.trim().length > 0)
}

// ---------------------------------------------------------------------------
// Disambiguation hash
// ---------------------------------------------------------------------------

/**
 * Compute a simple hash of surrounding text items for disambiguating
 * repeated text on the same page.
 *
 * Takes a window of items around the given start index and hashes their
 * concatenated strings.
 *
 * @param items  Array of TextItems (from extractTextItems)
 * @param startIndex  Index of the item to center the window on
 * @param windowSize  Number of items on each side (default 3)
 */
export function computeItemRunHash(
  items: TextItem[],
  startIndex: number,
  windowSize = 3,
): string {
  const lo = Math.max(0, startIndex - windowSize)
  const hi = Math.min(items.length, startIndex + windowSize + 1)
  const slice = items.slice(lo, hi).map((it) => it.str).join('|')

  // Simple djb2 hash — deterministic and fast
  let hash = 5381
  for (let i = 0; i < slice.length; i++) {
    hash = ((hash << 5) + hash + slice.charCodeAt(i)) | 0
  }

  // Return unsigned hex
  return (hash >>> 0).toString(16)
}
