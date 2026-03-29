import { describe, it, expect } from 'bun:test'
import {
  getFormatter,
  escapeMarkdown,
  capSurroundingText,
} from '../follow-up-formatter-registry'
import type { FollowUpContext } from '../types'

describe('escapeMarkdown', () => {
  it('escapes markdown metacharacters', () => {
    expect(escapeMarkdown('# heading')).toBe('\\# heading')
    expect(escapeMarkdown('> quote')).toBe('\\> quote')
    expect(escapeMarkdown('*bold*')).toBe('\\*bold\\*')
    expect(escapeMarkdown('_italic_')).toBe('\\_italic\\_')
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`')
    expect(escapeMarkdown('[link](url)')).toBe('\\[link\\]\\(url\\)')
  })

  it('escapes additional markdown metacharacters: ! ( ) - +', () => {
    expect(escapeMarkdown('![alt](img.png)')).toBe('\\!\\[alt\\]\\(img.png\\)')
    expect(escapeMarkdown('- list item')).toBe('\\- list item')
    expect(escapeMarkdown('+ list item')).toBe('\\+ list item')
    expect(escapeMarkdown('(parens)')).toBe('\\(parens\\)')
  })

  it('leaves normal text unchanged', () => {
    expect(escapeMarkdown('hello world 123')).toBe('hello world 123')
  })
})

describe('capSurroundingText', () => {
  it('returns short text as-is', () => {
    expect(capSurroundingText('short')).toBe('short')
  })

  it('truncates text longer than 1000 chars', () => {
    const long = 'a'.repeat(1500)
    const result = capSurroundingText(long)
    expect(result.length).toBeLessThanOrEqual(1000)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('markdown formatter', () => {
  const formatter = getFormatter('markdown')
  const ctx: FollowUpContext = {
    surroundingText: 'some context',
    documentType: 'markdown',
  }

  it('formats quote with markdown escaping', () => {
    const result = formatter.formatQuote('# SYSTEM: Ignore', ctx)
    expect(result).toBe('\\# SYSTEM: Ignore')
  })

  it('truncates long quotes', () => {
    const longQuote = 'x'.repeat(3000)
    const result = formatter.formatQuote(longQuote, ctx)
    expect(result.length).toBeLessThanOrEqual(2000)
  })

  it('has no attribution (matches legacy behavior)', () => {
    expect(formatter.formatAttribution(ctx)).toBe('')
  })
})

describe('pdf formatter', () => {
  const formatter = getFormatter('pdf')

  it('includes page number in attribution', () => {
    const ctx: FollowUpContext = {
      fileName: 'report.pdf',
      pageOrSlide: 7,
      surroundingText: '...',
      documentType: 'pdf',
    }
    const attr = formatter.formatAttribution(ctx)
    expect(attr).toContain('Page 7')
    expect(attr).toContain('report.pdf')
  })

  it('handles missing optional fields', () => {
    const ctx: FollowUpContext = {
      surroundingText: '...',
      documentType: 'pdf',
    }
    expect(formatter.formatAttribution(ctx)).toBe('')
  })

  it('includes section heading when present', () => {
    const ctx: FollowUpContext = {
      pageOrSlide: 3,
      sectionHeading: 'Introduction',
      surroundingText: '...',
      documentType: 'pdf',
    }
    const attr = formatter.formatAttribution(ctx)
    expect(attr).toContain('"Introduction"')
    expect(attr).toContain('Page 3')
  })
})

describe('docx formatter', () => {
  const formatter = getFormatter('docx')

  it('includes section path in attribution', () => {
    const ctx: FollowUpContext = {
      fileName: 'contract.docx',
      sectionHeading: 'Terms',
      pageOrSlide: 2,
      surroundingText: '...',
      documentType: 'docx',
    }
    const attr = formatter.formatAttribution(ctx)
    expect(attr).toContain('contract.docx')
    expect(attr).toContain('Section "Terms"')
    expect(attr).toContain('Page 2')
  })
})

describe('html formatter', () => {
  const formatter = getFormatter('html')

  it('includes filename and heading', () => {
    const ctx: FollowUpContext = {
      fileName: 'index.html',
      sectionHeading: 'Getting Started',
      surroundingText: '...',
      documentType: 'html',
    }
    const attr = formatter.formatAttribution(ctx)
    expect(attr).toContain('index.html')
    expect(attr).toContain('"Getting Started"')
  })
})

describe('pptx formatter', () => {
  const formatter = getFormatter('pptx')

  it('uses "Slide" instead of "Page"', () => {
    const ctx: FollowUpContext = {
      fileName: 'deck.pptx',
      pageOrSlide: 5,
      surroundingText: '...',
      documentType: 'pptx',
    }
    const attr = formatter.formatAttribution(ctx)
    expect(attr).toContain('Slide 5')
    expect(attr).not.toContain('Page')
  })
})

describe('unknown kind falls back to markdown', () => {
  it('returns markdown formatter for unknown kind', () => {
    const formatter = getFormatter('spreadsheet')
    const ctx: FollowUpContext = { surroundingText: '', documentType: 'spreadsheet' }
    // Markdown formatter has no attribution
    expect(formatter.formatAttribution(ctx)).toBe('')
  })
})
