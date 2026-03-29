import { describe, it, expect } from 'bun:test'
import { formatCopyAsQuote } from '../follow-up-formatter-registry'
import type { FollowUpContext } from '../types'

describe('formatCopyAsQuote', () => {
  it('wraps selected text in curly quotes', () => {
    const ctx: FollowUpContext = {
      surroundingText: 'some context',
      documentType: 'markdown',
    }
    const result = formatCopyAsQuote('hello world', ctx)
    expect(result).toBe('\u201chello world\u201d')
  })

  it('includes attribution for PDF context', () => {
    const ctx: FollowUpContext = {
      fileName: 'report.pdf',
      pageOrSlide: 3,
      sectionHeading: 'Introduction',
      surroundingText: '...',
      documentType: 'pdf',
    }
    const result = formatCopyAsQuote('some text', ctx)
    expect(result).toContain('\u201csome text\u201d')
    expect(result).toContain('\n\n')
    expect(result).toContain('report.pdf')
    expect(result).toContain('Page 3')
    expect(result).toContain('"Introduction"')
  })

  it('includes attribution for docx context', () => {
    const ctx: FollowUpContext = {
      fileName: 'contract.docx',
      sectionHeading: 'Terms',
      pageOrSlide: 2,
      surroundingText: '...',
      documentType: 'docx',
    }
    const result = formatCopyAsQuote('clause text', ctx)
    expect(result).toContain('\u201cclause text\u201d')
    expect(result).toContain('contract.docx')
    expect(result).toContain('Section "Terms"')
    expect(result).toContain('Page 2')
  })

  it('omits attribution when no context fields are present', () => {
    const ctx: FollowUpContext = {
      surroundingText: '...',
      documentType: 'pdf',
    }
    const result = formatCopyAsQuote('bare text', ctx)
    // No attribution line — just the quoted text
    expect(result).toBe('\u201cbare text\u201d')
    expect(result).not.toContain('\n')
  })

  it('truncates very long selected text', () => {
    const ctx: FollowUpContext = {
      surroundingText: '...',
      documentType: 'markdown',
    }
    const longText = 'x'.repeat(3000)
    const result = formatCopyAsQuote(longText, ctx)
    // Should be truncated to MAX_QUOTE_LENGTH (2000) including the quotes
    expect(result.length).toBeLessThan(3010)
    expect(result.startsWith('\u201c')).toBe(true)
    expect(result.endsWith('\u201d')).toBe(true)
  })

  it('uses slide attribution for pptx', () => {
    const ctx: FollowUpContext = {
      fileName: 'deck.pptx',
      pageOrSlide: 5,
      surroundingText: '...',
      documentType: 'pptx',
    }
    const result = formatCopyAsQuote('slide content', ctx)
    expect(result).toContain('Slide 5')
    expect(result).not.toContain('Page')
  })
})
