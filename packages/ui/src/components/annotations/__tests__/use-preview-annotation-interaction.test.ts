import { describe, expect, it } from 'bun:test'
import type {
  AnnotationSurfaceLike,
  CapturedSelectionLike,
  ResolvedAnnotationLike,
  DocumentMeta,
  UsePreviewAnnotationInteractionOptions,
  PreviewAnnotationInteractionResult,
} from '../use-preview-annotation-interaction'

/**
 * Type-level tests for the usePreviewAnnotationInteraction hook.
 *
 * Since the hook composes React hooks (useReducer, useState, useEffect, useCallback)
 * it cannot be invoked outside a React component. We test the exported types and
 * interface contracts here, and rely on the overlay-level integration tests to
 * verify behavioral correctness.
 */

describe('usePreviewAnnotationInteraction types', () => {
  describe('AnnotationSurfaceLike', () => {
    it('requires captureSelection, resolveAnnotation, and getFollowUpContext', () => {
      const surface: AnnotationSurfaceLike = {
        captureSelection: () => null,
        resolveAnnotation: () => null,
        getFollowUpContext: () => ({ surroundingText: '', documentType: 'test' }),
      }
      expect(surface.captureSelection()).toBe(null)
      expect(surface.resolveAnnotation({} as never)).toBe(null)
      expect(surface.getFollowUpContext({
        selectedText: '',
        prefix: '',
        suffix: '',
        scope: { kind: 'test' },
      })).toEqual({ surroundingText: '', documentType: 'test' })
    })

    it('allows optional getSelectionRects method', () => {
      const surface: AnnotationSurfaceLike = {
        captureSelection: () => null,
        resolveAnnotation: () => null,
        getFollowUpContext: () => ({ surroundingText: '', documentType: 'html' }),
        getSelectionRects: () => [],
      }
      expect(surface.getSelectionRects!(null as unknown as CapturedSelectionLike)).toEqual([])
    })
  })

  describe('CapturedSelectionLike', () => {
    it('requires selectedText, prefix, suffix, and scope with kind', () => {
      const captured: CapturedSelectionLike = {
        selectedText: 'hello world',
        prefix: 'say ',
        suffix: ' now',
        scope: { kind: 'pdf', pageNumber: 3 },
      }
      expect(captured.scope.kind).toBe('pdf')
      expect(captured.selectedText).toBe('hello world')
    })
  })

  describe('ResolvedAnnotationLike', () => {
    it('has isValid boolean and rects array', () => {
      const resolved: ResolvedAnnotationLike = {
        isValid: true,
        rects: [],
      }
      expect(resolved.isValid).toBe(true)
      expect(resolved.rects).toEqual([])
    })
  })

  describe('DocumentMeta', () => {
    it('requires kind and optional title', () => {
      const meta: DocumentMeta = { kind: 'pdf', title: 'Test.pdf', page: 1 }
      expect(meta.kind).toBe('pdf')
      expect(meta.title).toBe('Test.pdf')
    })

    it('allows extra properties', () => {
      const meta: DocumentMeta = { kind: 'html' }
      expect(meta.kind).toBe('html')
      expect(meta.title).toBeUndefined()
    })
  })

  describe('UsePreviewAnnotationInteractionOptions', () => {
    it('can construct a minimal options object', () => {
      const options: UsePreviewAnnotationInteractionOptions = {
        isOpen: true,
        sourceId: 'pdf:/test.pdf',
        sourceKeySegment: 'pdf:/test.pdf',
        contentRootRef: { current: null },
        getSurface: () => null,
        buildDocumentMeta: () => ({ kind: 'pdf' }),
        expectedScopeKind: 'pdf',
      }
      expect(options.isOpen).toBe(true)
      expect(options.canAnnotate).toBeUndefined()
    })

    it('accepts all optional properties', () => {
      const options: UsePreviewAnnotationInteractionOptions = {
        isOpen: false,
        onAddAnnotation: () => {},
        onRemoveAnnotation: () => {},
        annotations: [],
        sourceId: 'html:__single__',
        sourceKeySegment: 'html:__single__',
        sessionId: 'sess-1',
        sendMessageKey: 'cmd-enter',
        contentRootRef: { current: null },
        getSurface: () => null,
        buildDocumentMeta: () => ({ kind: 'html', title: 'Test' }),
        expectedScopeKind: 'html',
        getSelectionAnchorRects: () => [],
        onEmptyCapture: () => {},
        clearSurfaceSelection: () => {},
        overlayRectDeps: [42, 'foo'],
      }
      expect(options.sessionId).toBe('sess-1')
    })
  })

  describe('PreviewAnnotationInteractionResult shape', () => {
    it('type-checks expected keys on the result interface', () => {
      // This test verifies the result interface at the type level.
      // We cannot call the hook, but we can assert the shape compiles.
      type ExpectedKeys =
        | 'canAnnotate'
        | 'lastPointerRef'
        | 'dragStartPointerRef'
        | 'handleSelectionPointerDown'
        | 'handleTextSelection'
        | 'showSelectionMenuFromCurrentSelection'
        | 'annotationOverlayRects'
        | 'closeSelectionMenu'
        | 'handleOpenAnnotationDetail'
        | 'islandMenuProps'
        | 'overlayLayerProps'
        | 'interaction'

      // If PreviewAnnotationInteractionResult doesn't include all these keys,
      // this assignment would fail at compile time.
      type Check = ExpectedKeys extends keyof PreviewAnnotationInteractionResult ? true : false
      const valid: Check = true
      expect(valid).toBe(true)
    })
  })
})
