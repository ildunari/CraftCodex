import { describe, it, expect } from 'bun:test'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import {
  isTextItem,
  extractTextItems,
  getPageText,
  extractContext,
  detectHeadings,
  isTextAvailable,
  computeItemRunHash,
} from '../pdf-text-utils'

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeTextItem(overrides: Partial<TextItem> = {}): TextItem {
  return {
    str: 'hello',
    dir: 'ltr',
    transform: [12, 0, 0, 12, 72, 720],
    width: 30,
    height: 12,
    fontName: 'g_d0_f1',
    hasEOL: false,
    ...overrides,
  }
}

function makeTextContent(items: Array<TextItem | { type: string; id: string }>, lang?: string): TextContent {
  return {
    items: items as TextContent['items'],
    styles: {
      g_d0_f1: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'sans-serif' },
    },
    lang: lang ?? null,
  }
}

// ---------------------------------------------------------------------------
// isTextItem
// ---------------------------------------------------------------------------

describe('isTextItem', () => {
  it('returns true for TextItem objects', () => {
    expect(isTextItem(makeTextItem())).toBe(true)
  })

  it('returns false for TextMarkedContent objects', () => {
    const marked = { type: 'beginMarkedContent', id: 'mc0' }
    expect(isTextItem(marked as any)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractTextItems
// ---------------------------------------------------------------------------

describe('extractTextItems', () => {
  it('filters out marked content items', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'real text' }),
      { type: 'beginMarkedContent', id: 'mc0' },
      makeTextItem({ str: 'more text' }),
      { type: 'endMarkedContent', id: 'mc0' },
    ])
    const items = extractTextItems(tc)
    expect(items).toHaveLength(2)
    expect(items[0].str).toBe('real text')
    expect(items[1].str).toBe('more text')
  })

  it('returns empty array for empty content', () => {
    const tc = makeTextContent([])
    expect(extractTextItems(tc)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getPageText
// ---------------------------------------------------------------------------

describe('getPageText', () => {
  it('joins items with spaces', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'Hello' }),
      makeTextItem({ str: 'world' }),
    ])
    expect(getPageText(tc)).toBe('Hello world')
  })

  it('uses newlines for items with hasEOL', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'Line one', hasEOL: true }),
      makeTextItem({ str: 'Line two' }),
    ])
    expect(getPageText(tc)).toBe('Line one\nLine two')
  })

  it('returns empty string for no items', () => {
    expect(getPageText(makeTextContent([]))).toBe('')
  })

  it('handles mixed marked content and text items', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'A' }),
      { type: 'beginMarkedContent', id: 'mc0' },
      makeTextItem({ str: 'B' }),
    ])
    expect(getPageText(tc)).toBe('A B')
  })
})

// ---------------------------------------------------------------------------
// extractContext
// ---------------------------------------------------------------------------

describe('extractContext', () => {
  const pageText = 'The quick brown fox jumps over the lazy dog. This is the second sentence.'

  it('extracts prefix, suffix, and surrounding for a found selection', () => {
    const result = extractContext(pageText, 'brown fox', 10)
    expect(result.prefix).toBe('The quick ')
    expect(result.suffix).toBe(' jumps ove')
    expect(result.surrounding).toContain('brown fox')
  })

  it('returns full surrounding when maxContext covers entire text', () => {
    const result = extractContext(pageText, 'brown fox', 1000)
    expect(result.surrounding).toBe(pageText)
  })

  it('returns empty prefix/suffix when text not found', () => {
    const result = extractContext(pageText, 'nonexistent text')
    expect(result.prefix).toBe('')
    expect(result.suffix).toBe('')
    expect(result.surrounding).toBe('nonexistent text')
  })

  it('handles selection at the start of text', () => {
    const result = extractContext(pageText, 'The quick', 5)
    expect(result.prefix).toBe('')
    expect(result.suffix).toBe(' brow')
  })

  it('handles selection at the end of text', () => {
    const result = extractContext(pageText, 'second sentence.', 5)
    expect(result.suffix).toBe('')
    expect(result.prefix).toBe(' the ')
  })
})

// ---------------------------------------------------------------------------
// detectHeadings
// ---------------------------------------------------------------------------

describe('detectHeadings', () => {
  it('detects items with font size > 1.3x median', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'Chapter 1', height: 24 }),
      makeTextItem({ str: 'Body text line 1.', height: 12 }),
      makeTextItem({ str: 'Body text line 2.', height: 12 }),
      makeTextItem({ str: 'Body text line 3.', height: 12 }),
      makeTextItem({ str: 'Body text line 4.', height: 12 }),
    ])
    const headings = detectHeadings(tc)
    expect(headings).toHaveLength(1)
    expect(headings[0].text).toBe('Chapter 1')
    expect(headings[0].fontSize).toBe(24)
  })

  it('returns empty array when all items are same size', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'Same size A', height: 12 }),
      makeTextItem({ str: 'Same size B', height: 12 }),
    ])
    expect(detectHeadings(tc)).toHaveLength(0)
  })

  it('ignores whitespace-only items for heading detection', () => {
    const tc = makeTextContent([
      makeTextItem({ str: 'Heading', height: 24 }),
      makeTextItem({ str: '   ', height: 24 }),
      makeTextItem({ str: 'Body', height: 12 }),
      makeTextItem({ str: 'Body', height: 12 }),
      makeTextItem({ str: 'Body', height: 12 }),
    ])
    const headings = detectHeadings(tc)
    expect(headings).toHaveLength(1)
    expect(headings[0].text).toBe('Heading')
  })

  it('returns empty for empty content', () => {
    expect(detectHeadings(makeTextContent([]))).toHaveLength(0)
  })

  it('ignores zero-height items in median calculation', () => {
    const tc = makeTextContent([
      makeTextItem({ str: '', height: 0 }),
      makeTextItem({ str: 'Heading', height: 20 }),
      makeTextItem({ str: 'Body', height: 10 }),
      makeTextItem({ str: 'Body', height: 10 }),
      makeTextItem({ str: 'Body', height: 10 }),
    ])
    const headings = detectHeadings(tc)
    expect(headings).toHaveLength(1)
    expect(headings[0].text).toBe('Heading')
  })
})

// ---------------------------------------------------------------------------
// isTextAvailable
// ---------------------------------------------------------------------------

describe('isTextAvailable', () => {
  it('returns true when items contain non-empty text', () => {
    const tc = makeTextContent([makeTextItem({ str: 'Some text' })])
    expect(isTextAvailable(tc)).toBe(true)
  })

  it('returns false for empty items array', () => {
    expect(isTextAvailable(makeTextContent([]))).toBe(false)
  })

  it('returns false when all items are whitespace-only', () => {
    const tc = makeTextContent([
      makeTextItem({ str: '   ' }),
      makeTextItem({ str: '\n' }),
    ])
    expect(isTextAvailable(tc)).toBe(false)
  })

  it('returns false when only marked content is present', () => {
    const tc = makeTextContent([
      { type: 'beginMarkedContent', id: 'mc0' },
      { type: 'endMarkedContent', id: 'mc0' },
    ])
    expect(isTextAvailable(tc)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeItemRunHash
// ---------------------------------------------------------------------------

describe('computeItemRunHash', () => {
  const items = [
    makeTextItem({ str: 'A' }),
    makeTextItem({ str: 'B' }),
    makeTextItem({ str: 'C' }),
    makeTextItem({ str: 'D' }),
    makeTextItem({ str: 'E' }),
    makeTextItem({ str: 'F' }),
    makeTextItem({ str: 'G' }),
  ]

  it('produces a hex string', () => {
    const hash = computeItemRunHash(items, 3)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('returns deterministic output for same input', () => {
    const h1 = computeItemRunHash(items, 3)
    const h2 = computeItemRunHash(items, 3)
    expect(h1).toBe(h2)
  })

  it('returns different hash for different positions', () => {
    const h1 = computeItemRunHash(items, 1)
    const h2 = computeItemRunHash(items, 5)
    expect(h1).not.toBe(h2)
  })

  it('clamps window to array bounds at start', () => {
    const hash = computeItemRunHash(items, 0, 5)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('clamps window to array bounds at end', () => {
    const hash = computeItemRunHash(items, items.length - 1, 5)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('respects custom window size', () => {
    const h1 = computeItemRunHash(items, 3, 1)
    const h2 = computeItemRunHash(items, 3, 5)
    // Different window sizes produce different hashes (different input)
    expect(h1).not.toBe(h2)
  })
})
