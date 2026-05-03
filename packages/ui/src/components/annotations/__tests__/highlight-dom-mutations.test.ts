import { describe, expect, it } from 'bun:test'
import {
  clearAnnotationMarks,
  createAnnotationIndexBadge,
  applyTextHighlightRange,
} from '../highlight-dom-mutations'

describe('highlight-dom-mutations', () => {
  describe('exports', () => {
    it('exports clearAnnotationMarks as a function', () => {
      expect(typeof clearAnnotationMarks).toBe('function')
    })

    it('exports createAnnotationIndexBadge as a function', () => {
      expect(typeof createAnnotationIndexBadge).toBe('function')
    })

    it('exports applyTextHighlightRange as a function', () => {
      expect(typeof applyTextHighlightRange).toBe('function')
    })
  })

  // NOTE: These functions perform direct DOM mutations (document.createElement,
  // querySelectorAll, splitText, getBoundingClientRect, etc.) and are best
  // verified through browser-based / integration tests with a real DOM.
  // The export-existence checks above confirm the extraction is wired correctly.
  // Full behavioral coverage belongs in a jsdom or Playwright test suite.
})
