import { describe, it, expect } from 'bun:test'
import {
  captureIframeSelection,
  mapIframeRectsToParent,
  bridgeSelectionEvents,
  extractIframeContext,
  getIframeScale,
} from '../iframe-selection-bridge'

// ---------------------------------------------------------------------------
// DOMRect polyfill for bun:test
// ---------------------------------------------------------------------------

if (typeof globalThis.DOMRect === 'undefined') {
  ;(globalThis as Record<string, unknown>).DOMRect = class DOMRect {
    x: number; y: number; width: number; height: number
    top: number; right: number; bottom: number; left: number
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x; this.y = y; this.width = width; this.height = height
      this.left = x; this.top = y; this.right = x + width; this.bottom = y + height
    }
    toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height } }
  }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockIframe(overrides: Partial<HTMLIFrameElement> = {}): HTMLIFrameElement {
  return {
    contentDocument: null,
    contentWindow: null,
    getBoundingClientRect: () => new DOMRect(0, 0, 800, 600),
    ...overrides,
  } as unknown as HTMLIFrameElement
}

// ---------------------------------------------------------------------------
// captureIframeSelection
// ---------------------------------------------------------------------------

describe('captureIframeSelection', () => {
  it('returns null when iframe.contentDocument is null', () => {
    const iframe = mockIframe({ contentDocument: null })
    expect(captureIframeSelection(iframe)).toBeNull()
  })

  it('returns null when contentDocument access throws', () => {
    const iframe = mockIframe()
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new DOMException('cross-origin') },
    })
    expect(captureIframeSelection(iframe)).toBeNull()
  })

  it('returns null when there is no selection in the document', () => {
    const mockDoc = {
      getSelection: () => null,
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })
    expect(captureIframeSelection(iframe)).toBeNull()
  })

  it('returns null when selection is collapsed', () => {
    const mockDoc = {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: true,
        getRangeAt: () => ({ toString: () => '' }),
      }),
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })
    expect(captureIframeSelection(iframe)).toBeNull()
  })

  it('returns null when selection text is only whitespace', () => {
    const mockDoc = {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => ({ toString: () => '   \n  ' }),
      }),
      body: { textContent: 'some body text' },
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })
    expect(captureIframeSelection(iframe)).toBeNull()
  })

  it('returns selection data with prefix and suffix when text is found', () => {
    const selectedText = 'hello world'
    const bodyText = 'prefix text hello world suffix text'
    const mockRange = {
      toString: () => selectedText,
    }
    const mockDoc = {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => mockRange,
      }),
      body: { textContent: bodyText },
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })
    const result = captureIframeSelection(iframe)

    expect(result).not.toBeNull()
    expect(result!.selectedText).toBe('hello world')
    expect(result!.prefix).toBe('prefix text ')
    expect(result!.suffix).toBe(' suffix text')
    expect(result!.range).toBe(mockRange)
  })
})

// ---------------------------------------------------------------------------
// mapIframeRectsToParent
// ---------------------------------------------------------------------------

describe('mapIframeRectsToParent', () => {
  it('translates rects by iframe position', () => {
    const iframe = mockIframe()
    iframe.getBoundingClientRect = () => new DOMRect(100, 50, 800, 600)

    // Mock contentWindow with no scroll
    Object.defineProperty(iframe, 'contentWindow', {
      get: () => ({ scrollX: 0, scrollY: 0 }),
    })

    const rects = [new DOMRect(10, 20, 100, 30)]
    const mapped = mapIframeRectsToParent(iframe, rects)

    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.x).toBe(110) // 100 + 10
    expect(mapped[0]!.y).toBe(70)  // 50 + 20
    expect(mapped[0]!.width).toBe(100)
    expect(mapped[0]!.height).toBe(30)
  })

  it('accounts for iframe internal scroll', () => {
    const iframe = mockIframe()
    iframe.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)

    Object.defineProperty(iframe, 'contentWindow', {
      get: () => ({ scrollX: 0, scrollY: 200 }),
    })

    const rects = [new DOMRect(10, 50, 100, 30)]
    const mapped = mapIframeRectsToParent(iframe, rects)

    // y should be: 0 + (50 - 200) * 1 = -150
    expect(mapped[0]!.y).toBe(-150)
  })

  it('handles empty rects array', () => {
    const iframe = mockIframe()
    expect(mapIframeRectsToParent(iframe, [])).toEqual([])
  })

  it('handles multiple rects', () => {
    const iframe = mockIframe()
    iframe.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
    Object.defineProperty(iframe, 'contentWindow', {
      get: () => ({ scrollX: 0, scrollY: 0 }),
    })

    const rects = [
      new DOMRect(10, 20, 100, 15),
      new DOMRect(10, 40, 80, 15),
    ]
    const mapped = mapIframeRectsToParent(iframe, rects)
    expect(mapped).toHaveLength(2)
    expect(mapped[0]!.y).toBe(20)
    expect(mapped[1]!.y).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// getIframeScale
// ---------------------------------------------------------------------------

describe('getIframeScale', () => {
  it('returns 1 when getComputedStyle is not available', () => {
    const iframe = mockIframe()
    // In bun:test, getComputedStyle won't work on a mock
    expect(getIframeScale(iframe)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// bridgeSelectionEvents
// ---------------------------------------------------------------------------

describe('bridgeSelectionEvents', () => {
  it('returns a cleanup function when contentDocument is null', () => {
    const iframe = mockIframe({ contentDocument: null })
    const cleanup = bridgeSelectionEvents(iframe, () => {}, () => {})
    expect(typeof cleanup).toBe('function')
    cleanup() // Should not throw
  })

  it('returns a cleanup function when contentDocument throws', () => {
    const iframe = mockIframe()
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new DOMException('cross-origin') },
    })
    const cleanup = bridgeSelectionEvents(iframe, () => {}, () => {})
    expect(typeof cleanup).toBe('function')
    cleanup()
  })

  it('attaches listeners to contentDocument and returns cleanup', () => {
    const listeners: Record<string, Function> = {}
    const mockDoc = {
      addEventListener: (type: string, handler: Function) => {
        listeners[type] = handler
      },
      removeEventListener: (type: string, _handler: Function) => {
        delete listeners[type]
      },
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })

    let selectionChangeCalled = false
    let mouseUpCalled = false

    const cleanup = bridgeSelectionEvents(
      iframe,
      () => { selectionChangeCalled = true },
      () => { mouseUpCalled = true },
    )

    expect(listeners['selectionchange']).toBeDefined()
    expect(listeners['mouseup']).toBeDefined()

    // Trigger the listeners
    listeners['selectionchange']!()
    expect(selectionChangeCalled).toBe(true)

    listeners['mouseup']!({ type: 'mouseup' })
    expect(mouseUpCalled).toBe(true)

    // Cleanup
    cleanup()
    expect(listeners['selectionchange']).toBeUndefined()
    expect(listeners['mouseup']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// extractIframeContext
// ---------------------------------------------------------------------------

describe('extractIframeContext', () => {
  it('returns selected text as surrounding when iframe is inaccessible', () => {
    const iframe = mockIframe({ contentDocument: null })
    const ctx = extractIframeContext(iframe, 'hello')
    expect(ctx.surrounding).toBe('hello')
    expect(ctx.sectionHeading).toBeUndefined()
  })

  it('returns selected text when contentDocument access throws', () => {
    const iframe = mockIframe()
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new DOMException('cross-origin') },
    })
    const ctx = extractIframeContext(iframe, 'test')
    expect(ctx.surrounding).toBe('test')
  })

  it('extracts surrounding context when text is found in body', () => {
    const bodyText = 'Some leading text. Here is the selected portion. And some trailing text.'
    const mockDoc = {
      body: { textContent: bodyText },
      getSelection: () => null,
      querySelectorAll: () => [],
    }
    const iframe = mockIframe({ contentDocument: mockDoc as unknown as Document })

    const ctx = extractIframeContext(iframe, 'selected portion', 20)
    expect(ctx.surrounding).toContain('selected portion')
    // Should include some context around it
    expect(ctx.surrounding.length).toBeGreaterThan('selected portion'.length)
  })
})
