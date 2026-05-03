import { describe, it, expect, beforeEach } from 'bun:test'
import type { AnnotationSurface } from '../types'
import {
  registerSurface,
  createSurface,
  getSupportedKinds,
  unregisterSurface,
} from '../surface-registry'

function makeMockSurface(kind: AnnotationSurface['kind']): AnnotationSurface {
  return {
    kind,
    captureSelection: () => null,
    restoreSelection: () => {},
    getSelectionRects: () => [],
    resolveAnnotation: () => null,
    getFollowUpContext: () => ({ surroundingText: '', documentType: kind }),
    setRenderedAnnotations: () => {},
    observeGeometryInvalidation: () => () => {},
  }
}

describe('surface-registry', () => {
  beforeEach(() => {
    // Clean up between tests
    for (const kind of getSupportedKinds()) {
      unregisterSurface(kind)
    }
  })

  it('creates a registered surface', () => {
    registerSurface('markdown', () => makeMockSurface('markdown'))
    const surface = createSurface('markdown')
    expect(surface).not.toBeNull()
    expect(surface!.kind).toBe('markdown')
  })

  it('returns null for unregistered kind', () => {
    const surface = createSurface('pdf')
    expect(surface).toBeNull()
  })

  it('lists registered kinds', () => {
    registerSurface('markdown', () => makeMockSurface('markdown'))
    registerSurface('pdf', () => makeMockSurface('pdf'))
    const kinds = getSupportedKinds()
    expect(kinds).toContain('markdown')
    expect(kinds).toContain('pdf')
    expect(kinds).toHaveLength(2)
  })

  it('overwrites previous registration for same kind', () => {
    let callCount = 0
    registerSurface('markdown', () => { callCount = 1; return makeMockSurface('markdown') })
    registerSurface('markdown', () => { callCount = 2; return makeMockSurface('markdown') })
    createSurface('markdown')
    expect(callCount).toBe(2)
  })

  it('passes arguments to factory', () => {
    let receivedArgs: unknown[] = []
    registerSurface('html', (...args) => {
      receivedArgs = args
      return makeMockSurface('html')
    })
    const root = { id: 'test-root' }
    createSurface('html', root)
    expect(receivedArgs).toEqual([root])
  })

  it('unregisters a surface', () => {
    registerSurface('markdown', () => makeMockSurface('markdown'))
    expect(unregisterSurface('markdown')).toBe(true)
    expect(createSurface('markdown')).toBeNull()
    expect(getSupportedKinds()).not.toContain('markdown')
  })

  it('unregister returns false for unknown kind', () => {
    expect(unregisterSurface('pptx')).toBe(false)
  })
})
