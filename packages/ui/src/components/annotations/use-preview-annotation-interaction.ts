/**
 * usePreviewAnnotationInteraction — shared annotation interaction hook for
 * preview overlays (PDF, HTML, DOCX, etc.).
 *
 * Extracts the ~250 lines of duplicated annotation interaction logic that was
 * previously copy-pasted across PDFPreviewOverlay and HTMLPreviewOverlay into a
 * single reusable hook. The hook manages:
 *
 * - Interaction controller state machine
 * - Island presentation (anchor, visibility, exit animation)
 * - Island events (outside click, scroll dismiss)
 * - Pointer tracking (mouseDown / mouseUp refs)
 * - Selection menu transitions and nonce
 * - Annotation overlay rect computation
 * - Highlight, copy-as-quote, follow-up, and delete callbacks
 * - AnnotationIslandMenu and AnnotationOverlayLayer props assembly
 */

import * as React from 'react'
import type { AnnotationV1 } from '@craft-agent/core'
import { useAnnotationInteractionController } from './use-annotation-interaction-controller'
import { useAnnotationIslandPresentation } from './use-annotation-island-presentation'
import { useAnnotationIslandEvents } from './use-annotation-island-events'
import { useAnnotationCancelRestore } from './use-annotation-cancel-restore'
import {
  getAnnotationInteractionAnchor,
  getAnnotationInteractionSourceKey,
  hasAnnotationInteraction,
} from './interaction-selectors'
import {
  type PointerSnapshot,
  buildSelectionEntryTransition,
  buildAnnotationChipEntryTransition,
} from './island-motion'
import {
  getAnnotationNoteText,
  formatAnnotationFollowUpTooltipText,
} from './follow-up-state'
import { formatCopyAsQuote } from './follow-up-formatter-registry'
import {
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  createTextSelectionAnnotation,
  type AnnotationOverlayRect,
} from './annotation-core'
import { clearDomSelection } from './selection-restore'
import { shouldIgnoreSelectionMouseUpTarget } from './interaction-policy'
import type { IslandTransitionConfig } from '../ui'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Surface abstraction — callers provide a `getSurface` function returning any
 *  object that satisfies this interface (PdfAnnotationSurface, HtmlAnnotationSurface, etc.) */
export interface AnnotationSurfaceLike {
  captureSelection(): CapturedSelectionLike | null
  resolveAnnotation(annotation: AnnotationV1): ResolvedAnnotationLike | null
  getFollowUpContext(params: {
    selectedText: string
    prefix: string
    suffix: string
    scope: Record<string, unknown>
  }): { surroundingText: string; documentType: string }
  /** Optional: get host-document-relative selection rects (HTML surfaces). */
  getSelectionRects?: (captured: CapturedSelectionLike) => DOMRect[]
}

export interface CapturedSelectionLike {
  selectedText: string
  prefix: string
  suffix: string
  scope: { kind: string; [key: string]: unknown }
}

export interface ResolvedAnnotationLike {
  isValid: boolean
  rects: DOMRect[]
}

/** Document metadata to attach to saved annotations. */
export interface DocumentMeta {
  kind: string
  title?: string
  [key: string]: unknown
}

export interface UsePreviewAnnotationInteractionOptions {
  /** Whether the overlay is currently open. */
  isOpen: boolean
  /** Whether annotation callbacks are provided (controls canAnnotate). */
  onAddAnnotation?: (annotation: AnnotationV1) => void
  onRemoveAnnotation?: (annotationId: string) => void
  /** Current annotations array for this document. */
  annotations?: AnnotationV1[]
  /** Source identifier prefix, e.g. `"pdf:path/to/file"` or `"html:__single__"`. */
  sourceId: string
  /** Unique key segment for island source key (e.g. `"pdf:path"` or `"html:src"`). */
  sourceKeySegment: string
  /** Session ID for annotation context. */
  sessionId?: string
  /** Input send-key behavior used by follow-up editor. */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Ref to the content root element (used for cancel-restore and overlay rect computation). */
  contentRootRef: React.RefObject<HTMLElement | null>
  /** Lazily get or create the current annotation surface. */
  getSurface: () => AnnotationSurfaceLike | null
  /** Build document metadata for saved annotations. */
  buildDocumentMeta: () => DocumentMeta
  /** Scope kind the surface should report (used to validate captured selections). */
  expectedScopeKind: string
  /** Optional: custom logic to compute anchor rects for selection menu.
   *  If not provided, falls back to `window.getSelection()` rects. */
  getSelectionAnchorRects?: (captured: CapturedSelectionLike) => DOMRect[]
  /** Optional: called when captureSelection returns null (e.g. to detect scanned pages). */
  onEmptyCapture?: () => void
  /** Optional: called before saveAnnotation to clear surface-specific selection (e.g. iframe). */
  clearSurfaceSelection?: () => void
  /** Extra deps that should re-trigger overlay rect computation (e.g. numPages, contentSize). */
  overlayRectDeps?: unknown[]
}

export interface PreviewAnnotationInteractionResult {
  /** Whether the user can annotate (onAddAnnotation is defined). */
  canAnnotate: boolean
  /** Pointer-tracking refs — attach to onMouseDown / onMouseUp on the content root. */
  lastPointerRef: React.MutableRefObject<PointerSnapshot | null>
  dragStartPointerRef: React.MutableRefObject<PointerSnapshot | null>
  /** Handler for onMouseDown on content root. */
  handleSelectionPointerDown: (event: React.MouseEvent<HTMLDivElement>) => void
  /** Handler for onMouseUp on content root (validates selection, shows menu). */
  handleTextSelection: (event: React.MouseEvent<HTMLDivElement>) => void
  /** Imperatively trigger the selection menu from the current DOM selection. */
  showSelectionMenuFromCurrentSelection: () => void
  /** Computed overlay rects for AnnotationOverlayLayer. */
  annotationOverlayRects: AnnotationOverlayRect[]
  /** Close the selection menu (wraps interaction.closeAll). */
  closeSelectionMenu: () => void
  /** Open annotation detail view from a highlight chip click. */
  handleOpenAnnotationDetail: (
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: 'view' | 'edit',
  ) => void
  /** Props ready to spread on AnnotationIslandMenu. */
  islandMenuProps: {
    anchor: { x: number; y: number } | null
    sourceKey: string
    replayNonce: number
    isVisible: boolean
    activeView: string
    mode: string
    draft: string
    onDraftChange: (next: string) => void
    onOpenFollowUp: () => void
    onHighlight: () => void
    onCopyAsQuote: () => Promise<void>
    onCancel: () => void
    onRequestBack: () => boolean
    onRequestEdit: () => void
    onSubmit: (value: string) => void
    onDelete: (() => void) | undefined
    sendMessageKey: 'enter' | 'cmd-enter'
    transitionConfig: IslandTransitionConfig
    onExitComplete: () => void
    usePortal: false
  }
  /** Props ready to spread on AnnotationOverlayLayer. */
  overlayLayerProps: {
    rects: AnnotationOverlayRect[]
    chips: never[]
    annotations: AnnotationV1[]
    getTooltipText: (annotation: AnnotationV1) => string
    allowChipOpen: boolean
    onChipOpen: (params: { annotationId: string; index: number; anchorX: number; anchorY: number; mode: 'view' | 'edit' }) => void
  }
  /** The full interaction controller (escape hatch for surface-specific needs). */
  interaction: ReturnType<typeof useAnnotationInteractionController>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePreviewAnnotationInteraction(
  options: UsePreviewAnnotationInteractionOptions,
): PreviewAnnotationInteractionResult {
  const {
    isOpen,
    onAddAnnotation,
    onRemoveAnnotation,
    annotations,
    sourceId,
    sourceKeySegment,
    sessionId,
    sendMessageKey = 'enter',
    contentRootRef,
    getSurface,
    buildDocumentMeta,
    expectedScopeKind,
    getSelectionAnchorRects,
    onEmptyCapture,
    clearSurfaceSelection,
    overlayRectDeps = [],
  } = options

  const canAnnotate = Boolean(onAddAnnotation)

  // -- Interaction controller -----------------------------------------------

  const interaction = useAnnotationInteractionController()
  const {
    state: interactionState,
    setDraft: setFollowUpDraft,
    openFromSelection,
    openFollowUpFromSelection,
    openFromAnnotation,
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
    markDeleteSuccess,
  } = interaction

  const pendingSelection = interactionState.pendingSelection
  const selectionMenuView = interactionState.selectionMenuView
  const followUpDraft = interactionState.followUpDraft
  const followUpMode = interactionState.followUpMode
  const activeAnnotationDetail = interactionState.activeAnnotationDetail

  // -- Transition state -----------------------------------------------------

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = React.useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = React.useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )

  // -- Overlay rects --------------------------------------------------------

  const [annotationOverlayRects, setAnnotationOverlayRects] = React.useState<AnnotationOverlayRect[]>([])

  // -- Island presentation --------------------------------------------------

  const selectionMenuAnchor = getAnnotationInteractionAnchor(interactionState)
  const selectionMenuSourceKey = getAnnotationInteractionSourceKey(interactionState, sourceKeySegment)

  const {
    renderAnchor: selectionMenuRenderAnchor,
    renderSourceKey: selectionMenuRenderSourceKey,
    isVisible: isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    handleExitComplete: handleSelectionMenuExitComplete,
  } = useAnnotationIslandPresentation({
    anchor: selectionMenuAnchor,
    sourceKey: selectionMenuSourceKey,
  })

  // -- Pointer refs ---------------------------------------------------------

  const lastPointerRef = React.useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = React.useRef<PointerSnapshot | null>(null)

  // -- Close / cleanup ------------------------------------------------------

  const closeSelectionMenu = React.useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = React.useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = React.useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  // -- Overlay rect computation ---------------------------------------------

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const overlayRectDepsMemo = React.useMemo(() => overlayRectDeps, overlayRectDeps)

  React.useEffect(() => {
    if (!annotations?.length || !contentRootRef.current) {
      setAnnotationOverlayRects([])
      return
    }

    const surface = getSurface()
    if (!surface) {
      setAnnotationOverlayRects([])
      return
    }

    const containerRect = contentRootRef.current.getBoundingClientRect()
    const rects: AnnotationOverlayRect[] = []

    for (const annotation of annotations) {
      const resolved = surface.resolveAnnotation(annotation)
      if (!resolved?.isValid || resolved.rects.length === 0) continue

      for (const rect of resolved.rects) {
        rects.push({
          id: annotation.id,
          left: rect.left - containerRect.left,
          top: rect.top - containerRect.top,
          width: rect.width,
          height: rect.height,
          color: (annotation.style as Record<string, string> | undefined)?.color ?? 'yellow',
        })
      }
    }

    setAnnotationOverlayRects(rects)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, getSurface, overlayRectDepsMemo])

  // -- Selection handling ---------------------------------------------------

  const handleSelectionPointerDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const snapshot: PointerSnapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }
    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

  const showSelectionMenuFromCurrentSelection = React.useCallback(() => {
    if (!canAnnotate) return

    const surface = getSurface()
    if (!surface) return

    requestAnimationFrame(() => {
      const captured = surface.captureSelection()

      if (!captured) {
        onEmptyCapture?.()
        closeSelectionMenu()
        return
      }

      if (captured.scope.kind !== expectedScopeKind) {
        closeSelectionMenu()
        return
      }

      // Compute anchor from selection rects — surface-specific or browser default
      let rects: DOMRect[]
      if (getSelectionAnchorRects) {
        rects = getSelectionAnchorRects(captured)
      } else if (surface.getSelectionRects) {
        rects = surface.getSelectionRects(captured)
      } else {
        const selection = window.getSelection()
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
        rects = range
          ? Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
          : []
      }

      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null

      let anchorRect: DOMRect | undefined
      if (rects.length > 0) {
        anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
      } else {
        // Fallback: try getting range bounding rect
        const selection = window.getSelection()
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
        if (range) {
          const bounding = range.getBoundingClientRect()
          if (bounding.width > 0 || bounding.height > 0) {
            anchorRect = bounding
          }
        }
      }

      if (!anchorRect) {
        closeSelectionMenu()
        return
      }

      const anchorX = pointerX != null
        ? clamp(pointerX, anchorRect.left, anchorRect.right)
        : (anchorRect.left + anchorRect.width / 2)
      const anchorY = anchorRect.top - 8

      const transition = buildSelectionEntryTransition(dragStartPointerRef.current, pointer)
      setSelectionMenuTransitionConfig(transition)
      triggerSelectionMenuEntryReplay()

      openFromSelection({
        start: 0,
        end: 0,
        selectedText: captured.selectedText,
        prefix: captured.prefix,
        suffix: captured.suffix,
        anchorX,
        anchorY,
      })
      dragStartPointerRef.current = null
    })
  }, [canAnnotate, getSurface, closeSelectionMenu, triggerSelectionMenuEntryReplay, openFromSelection, expectedScopeKind, getSelectionAnchorRects, onEmptyCapture])

  const handleTextSelection = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate) return
    if (shouldIgnoreSelectionMouseUpTarget(event.target)) return

    lastPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }

    showSelectionMenuFromCurrentSelection()
  }, [canAnnotate, showSelectionMenuFromCurrentSelection])

  // -- Annotation CRUD callbacks -------------------------------------------

  const saveAnnotation = React.useCallback(async (note: string) => {
    if (!pendingSelection || !onAddAnnotation) return

    const annotation = createTextSelectionAnnotation(
      sourceId,
      {
        start: pendingSelection.start,
        end: pendingSelection.end,
        selectedText: pendingSelection.selectedText,
        prefix: pendingSelection.prefix,
        suffix: pendingSelection.suffix,
      },
      note || undefined,
      sessionId,
    )

    // Attach document metadata
    const docMeta = buildDocumentMeta()
    ;(annotation as AnnotationV1 & { meta: Record<string, unknown> }).meta = {
      ...annotation.meta,
      document: docMeta,
    }

    onAddAnnotation(annotation)

    // Clear surface-specific selection if needed
    clearSurfaceSelection?.()
    clearDomSelection()
    markSubmitSuccess()
  }, [pendingSelection, onAddAnnotation, sourceId, sessionId, buildDocumentMeta, clearSurfaceSelection, markSubmitSuccess])

  const handleHighlight = React.useCallback(() => {
    if (!pendingSelection) return
    void saveAnnotation('')
  }, [pendingSelection, saveAnnotation])

  const handleOpenFollowUpView = React.useCallback(() => {
    if (!pendingSelection) return
    clearSurfaceSelection?.()
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, clearSurfaceSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = React.useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const handleSubmitFollowUp = React.useCallback((note: string) => {
    void saveAnnotation(note)
  }, [saveAnnotation])

  const handleCopyAsQuote = React.useCallback(async () => {
    if (!pendingSelection) return

    const surface = getSurface()
    const context = surface
      ? surface.getFollowUpContext({
          selectedText: pendingSelection.selectedText,
          prefix: pendingSelection.prefix,
          suffix: pendingSelection.suffix,
          scope: { kind: expectedScopeKind },
        })
      : { surroundingText: pendingSelection.selectedText, documentType: expectedScopeKind }

    try {
      await navigator.clipboard.writeText(formatCopyAsQuote(pendingSelection.selectedText, context))
    } catch {
      // Clipboard API may be blocked
    }

    clearSurfaceSelection?.()
    clearDomSelection()
    closeSelectionMenu()
  }, [pendingSelection, getSurface, expectedScopeKind, clearSurfaceSelection, closeSelectionMenu])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef,
    cancelFollowUp,
  })

  const handleDeleteActiveAnnotation = React.useCallback(() => {
    if (!onRemoveAnnotation || !activeAnnotationDetail) return
    onRemoveAnnotation(activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, activeAnnotationDetail, markDeleteSuccess])

  const handleSelectionMenuRequestBack = React.useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }
    return false
  }, [selectionMenuView, handleCancelFollowUp])

  // -- Island events (outside click, scroll dismiss) ------------------------

  useAnnotationIslandEvents({
    enabled: canAnnotate && hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  // -- Annotation chip interaction ------------------------------------------

  const handleOpenAnnotationDetail = React.useCallback((
    annotationId: string,
    index: number,
    anchorX: number,
    anchorY: number,
    mode: 'view' | 'edit',
  ) => {
    if (!annotations?.length) return

    const annotation = annotations.find(a => a.id === annotationId)
    if (!annotation) return

    const noteText = getAnnotationNoteText(annotation)
    const transition = buildAnnotationChipEntryTransition()
    setSelectionMenuTransitionConfig(transition)
    triggerSelectionMenuEntryReplay()
    openFromAnnotation({ annotationId, index, anchorX, anchorY }, noteText, mode)
  }, [annotations, triggerSelectionMenuEntryReplay, openFromAnnotation])

  // -- Assembled props ------------------------------------------------------

  const islandMenuProps = React.useMemo(() => ({
    anchor: selectionMenuRenderAnchor,
    sourceKey: selectionMenuRenderSourceKey,
    replayNonce: selectionMenuShowNonce,
    isVisible: isSelectionMenuVisible,
    activeView: selectionMenuView,
    mode: followUpMode,
    draft: followUpDraft,
    onDraftChange: setFollowUpDraft,
    onOpenFollowUp: handleOpenFollowUpView,
    onHighlight: handleHighlight,
    onCopyAsQuote: handleCopyAsQuote,
    onCancel: handleCancelFollowUp,
    onRequestBack: handleSelectionMenuRequestBack,
    onRequestEdit: handleRequestFollowUpEdit,
    onSubmit: handleSubmitFollowUp,
    onDelete: activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined,
    sendMessageKey,
    transitionConfig: selectionMenuTransitionConfig,
    onExitComplete: handleSelectionMenuExitComplete,
    usePortal: false as const,
  }), [
    selectionMenuRenderAnchor,
    selectionMenuRenderSourceKey,
    selectionMenuShowNonce,
    isSelectionMenuVisible,
    selectionMenuView,
    followUpMode,
    followUpDraft,
    setFollowUpDraft,
    handleOpenFollowUpView,
    handleHighlight,
    handleCopyAsQuote,
    handleCancelFollowUp,
    handleSelectionMenuRequestBack,
    handleRequestFollowUpEdit,
    handleSubmitFollowUp,
    activeAnnotationDetail,
    handleDeleteActiveAnnotation,
    sendMessageKey,
    selectionMenuTransitionConfig,
    handleSelectionMenuExitComplete,
  ])

  const overlayLayerProps = React.useMemo(() => ({
    rects: annotationOverlayRects,
    chips: [] as never[],
    annotations: annotations ?? [],
    getTooltipText: (annotation: AnnotationV1) => formatAnnotationFollowUpTooltipText(annotation),
    allowChipOpen: canAnnotate,
    onChipOpen: ({ annotationId, index, anchorX, anchorY, mode }: { annotationId: string; index: number; anchorX: number; anchorY: number; mode: 'view' | 'edit' }) => {
      handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
    },
  }), [annotationOverlayRects, annotations, canAnnotate, handleOpenAnnotationDetail])

  return {
    canAnnotate,
    lastPointerRef,
    dragStartPointerRef,
    handleSelectionPointerDown,
    handleTextSelection,
    showSelectionMenuFromCurrentSelection,
    annotationOverlayRects,
    closeSelectionMenu,
    handleOpenAnnotationDetail,
    islandMenuProps,
    overlayLayerProps,
    interaction,
  }
}
