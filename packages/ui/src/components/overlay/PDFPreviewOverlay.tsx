/**
 * PDFPreviewOverlay - In-app PDF preview using Mozilla's pdf.js via react-pdf.
 *
 * Renders PDFs using the react-pdf library, which wraps pdfjs-dist.
 * Supports multiple items with arrow navigation in the header.
 *
 * The PDF is loaded from a Uint8Array (via IPC) and rendered to canvas.
 * The pdf.js worker handles decoding and rendering in a background thread.
 *
 * Annotation support: when annotation callbacks are provided, users can select
 * text on PDF pages and create highlights, follow-ups, or copy-as-quote via the
 * AnnotationIslandMenu. Cross-page selections are rejected with a toast.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import { FileText } from 'lucide-react'
import type { AnnotationV1 } from '@craft-agent/core'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import { PdfAnnotationSurface } from '../annotations/PdfAnnotationSurface'
import { useAnnotationInteractionController } from '../annotations/use-annotation-interaction-controller'
import { useAnnotationIslandPresentation } from '../annotations/use-annotation-island-presentation'
import { useAnnotationIslandEvents } from '../annotations/use-annotation-island-events'
import { useAnnotationCancelRestore } from '../annotations/use-annotation-cancel-restore'
import {
  getAnnotationInteractionAnchor,
  getAnnotationInteractionSourceKey,
  hasAnnotationInteraction,
} from '../annotations/interaction-selectors'
import {
  type PointerSnapshot,
  buildSelectionEntryTransition,
  buildAnnotationChipEntryTransition,
} from '../annotations/island-motion'
import {
  getAnnotationNoteText,
  formatAnnotationFollowUpTooltipText,
} from '../annotations/follow-up-state'
import { formatCopyAsQuote } from '../annotations/follow-up-formatter-registry'
import {
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  createTextSelectionAnnotation,
  type AnnotationOverlayRect,
} from '../annotations/annotation-core'
import { clearDomSelection } from '../annotations/selection-restore'
import { shouldIgnoreSelectionMouseUpTarget } from '../annotations/interaction-policy'
import type { IslandTransitionConfig } from '../ui'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// Configure pdf.js worker using Vite's ?url import for cross-platform dev/prod compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

interface PreviewItem {
  src: string
  label?: string
}

export interface PDFPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  /** Absolute file path for the PDF (single item / backward compat) */
  filePath: string
  /** Multiple items for arrow navigation */
  items?: PreviewItem[]
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Async loader that returns PDF data as Uint8Array */
  loadPdfData: (path: string) => Promise<Uint8Array>
  theme?: 'light' | 'dark'
  /** Session ID for annotation context */
  sessionId?: string
  /** Annotations attached to this PDF */
  annotations?: AnnotationV1[]
  /** Callback to add an annotation */
  onAddAnnotation?: (annotation: AnnotationV1) => void
  /** Callback to remove an annotation */
  onRemoveAnnotation?: (annotationId: string) => void
  /** Callback to update an annotation */
  onUpdateAnnotation?: (annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback to show a toast (for cross-page selection, scanned page, etc.) */
  onToast?: (message: string) => void
}

export function PDFPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  items,
  initialIndex = 0,
  loadPdfData,
  theme = 'light',
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onToast,
}: PDFPreviewOverlayProps) {
  // Normalize: items array or single filePath
  const resolvedItems = useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    return [{ src: filePath }]
  }, [items, filePath])

  const [activeIdx, setActiveIdx] = useState(initialIndex)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const activeItem = resolvedItems[activeIdx]

  // Refs for annotation system
  const pdfContentRef = useRef<HTMLDivElement>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const surfaceRef = useRef<PdfAnnotationSurface | null>(null)
  const lastPointerRef = useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = useRef<PointerSnapshot | null>(null)

  // ---------------------------------------------------------------------------
  // Annotation interaction state
  // ---------------------------------------------------------------------------

  const canAnnotate = Boolean(onAddAnnotation)

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

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )

  // Annotation overlay rects for highlight rendering
  const [annotationOverlayRects, setAnnotationOverlayRects] = useState<AnnotationOverlayRect[]>([])

  // Island presentation (anchor, visibility, exit animation)
  const selectionMenuAnchor = getAnnotationInteractionAnchor(interactionState)
  const selectionMenuSourceKey = getAnnotationInteractionSourceKey(interactionState, `pdf:${activeItem?.src}`)

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

  // ---------------------------------------------------------------------------
  // Surface management
  // ---------------------------------------------------------------------------

  const getSurface = useCallback((): PdfAnnotationSurface | null => {
    const container = pdfContentRef.current
    const doc = pdfDocRef.current
    if (!container || !doc) {
      surfaceRef.current = null
      return null
    }
    // Re-create if container changed or doc changed
    if (!surfaceRef.current) {
      const getPage = (pageNumber: number) => doc.getPage(pageNumber)
      const fileName = activeItem?.label || activeItem?.src?.split('/').pop()
      surfaceRef.current = new PdfAnnotationSurface(container, getPage, fileName)
    }
    return surfaceRef.current
  }, [activeItem?.src, activeItem?.label])

  // ---------------------------------------------------------------------------
  // Close / cleanup
  // ---------------------------------------------------------------------------

  const closeSelectionMenu = useCallback(() => {
    closeAll()
  }, [closeAll])

  const isTargetInsideAnnotationIsland = useCallback((target: Node | null): boolean => {
    if (!target) return false
    const element = target instanceof Element ? target : target.parentElement
    if (!element) return false
    return !!element.closest('[data-ca-annotation-island="true"]')
  }, [])

  const triggerSelectionMenuEntryReplay = useCallback(() => {
    setSelectionMenuShowNonce((prev) => prev + 1)
  }, [])

  // Reset annotation state when overlay closes or active item changes
  useEffect(() => {
    closeSelectionMenu()
    surfaceRef.current = null
    if (!isOpen) {
      pdfDocRef.current = null
    }
  }, [isOpen, activeIdx, closeSelectionMenu])

  // Reset index when overlay opens
  useEffect(() => {
    if (isOpen) {
      setActiveIdx(initialIndex)
    }
  }, [isOpen, initialIndex])

  // Load PDF data when overlay opens or active item changes
  useEffect(() => {
    if (!isOpen || !activeItem?.src) return

    let cancelled = false
    setIsLoading(true)
    setError(null)
    setPdfData(null)
    setNumPages(0)

    loadPdfData(activeItem.src)
      .then((data) => {
        if (!cancelled) {
          setPdfData(data)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF')
          setIsLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [isOpen, activeItem?.src, loadPdfData])

  const onDocumentLoadSuccess = useCallback((pdf: { numPages: number } & PDFDocumentProxy) => {
    setNumPages(pdf.numPages)
    pdfDocRef.current = pdf
    surfaceRef.current = null // Reset surface so it picks up new doc
  }, [])

  const onDocumentLoadError = useCallback((error: Error) => {
    setError(`Failed to load PDF: ${error.message}`)
  }, [])

  // Memoize file object to prevent unnecessary re-renders (react-pdf uses === equality)
  const fileObj = useMemo(() =>
    pdfData ? { data: pdfData } : null,
    [pdfData]
  )

  // ---------------------------------------------------------------------------
  // Annotation overlay geometry
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!annotations?.length || !pdfContentRef.current) {
      setAnnotationOverlayRects([])
      return
    }

    const surface = getSurface()
    if (!surface) {
      setAnnotationOverlayRects([])
      return
    }

    const containerRect = pdfContentRef.current.getBoundingClientRect()
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
  }, [annotations, numPages, getSurface])

  // ---------------------------------------------------------------------------
  // Selection handling
  // ---------------------------------------------------------------------------

  const handleSelectionPointerDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const snapshot: PointerSnapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }
    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

  const showSelectionMenuFromCurrentSelection = useCallback(() => {
    if (!canAnnotate) return

    const surface = getSurface()
    if (!surface) return

    requestAnimationFrame(() => {
      const captured = surface.captureSelection()

      if (!captured) {
        // Check if we're on a page without text layer (scanned page)
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0)
          const pageEl = (range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer as HTMLElement
            : range.startContainer.parentElement
          )?.closest('.react-pdf__Page')

          if (pageEl) {
            const textLayer = pageEl.querySelector('.react-pdf__Page__textContent')
            if (!textLayer || !textLayer.textContent?.trim()) {
              onToast?.('Text selection unavailable for this page')
            }
          }
        }

        closeSelectionMenu()
        return
      }

      if (captured.scope.kind !== 'pdf') {
        closeSelectionMenu()
        return
      }

      // Compute anchor position from browser selection rects
      const selection = window.getSelection()
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const rects = range
        ? Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
        : []

      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null

      let anchorRect: DOMRect
      if (rects.length > 0) {
        anchorRect = rects.reduce((best, rect) => (rect.top < best.top ? rect : best))
      } else if (range) {
        anchorRect = range.getBoundingClientRect()
      } else {
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
        start: 0, // PDF selections use quote-based anchoring, not offsets
        end: 0,
        selectedText: captured.selectedText,
        prefix: captured.prefix,
        suffix: captured.suffix,
        anchorX,
        anchorY,
      })
      dragStartPointerRef.current = null
    })
  }, [canAnnotate, getSurface, closeSelectionMenu, triggerSelectionMenuEntryReplay, openFromSelection, onToast])

  const handleTextSelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate) return

    if (shouldIgnoreSelectionMouseUpTarget(event.target)) return

    lastPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }

    // Detect cross-page selection
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      const startPage = (range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as HTMLElement
        : range.startContainer.parentElement
      )?.closest('.react-pdf__Page')
      const endPage = (range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer as HTMLElement
        : range.endContainer.parentElement
      )?.closest('.react-pdf__Page')

      if (startPage && endPage && startPage !== endPage) {
        onToast?.('Select text within a single page')
        closeSelectionMenu()
        return
      }
    }

    showSelectionMenuFromCurrentSelection()
  }, [canAnnotate, showSelectionMenuFromCurrentSelection, closeSelectionMenu, onToast])

  // Handle mouseup outside PDF content (drag started inside, ended outside)
  useEffect(() => {
    if (!canAnnotate || !isOpen) return

    const handleDocumentMouseUp = (event: MouseEvent) => {
      const root = pdfContentRef.current
      if (!root) return

      const target = event.target as Node | null
      if (target && root.contains(target)) return // handled by onMouseUp

      showSelectionMenuFromCurrentSelection()
    }

    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [canAnnotate, isOpen, showSelectionMenuFromCurrentSelection])

  // ---------------------------------------------------------------------------
  // Annotation handlers (highlight, follow-up, copy-as-quote)
  // ---------------------------------------------------------------------------

  const saveAnnotation = useCallback(async (note: string) => {
    if (!pendingSelection || !onAddAnnotation) return

    const annotation = createTextSelectionAnnotation(
      `pdf:${activeItem?.src || filePath}`,
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

    // Attach PDF-specific document metadata
    const surface = getSurface()
    const captured = surface?.captureSelection()
    const pageNumber = captured?.scope.kind === 'pdf' ? captured.scope.pageNumber : undefined

    ;(annotation as AnnotationV1 & { meta: Record<string, unknown> }).meta = {
      ...annotation.meta,
      document: {
        kind: 'pdf',
        title: (activeItem?.label || activeItem?.src?.split('/').pop()) ?? undefined,
        page: pageNumber ?? 1,
      },
    }

    onAddAnnotation(annotation)
    clearDomSelection()
    markSubmitSuccess()
  }, [pendingSelection, onAddAnnotation, activeItem, filePath, sessionId, getSurface, markSubmitSuccess])

  const handleHighlight = useCallback(() => {
    if (!pendingSelection) return
    void saveAnnotation('')
  }, [pendingSelection, saveAnnotation])

  const handleOpenFollowUpView = useCallback(() => {
    if (!pendingSelection) return
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

  const handleRequestFollowUpEdit = useCallback(() => {
    requestEdit()
  }, [requestEdit])

  const handleSubmitFollowUp = useCallback((note: string) => {
    void saveAnnotation(note)
  }, [saveAnnotation])

  const handleCopyAsQuote = useCallback(async () => {
    if (!pendingSelection) return

    const surface = getSurface()
    const context = surface
      ? surface.getFollowUpContext({
          selectedText: pendingSelection.selectedText,
          prefix: pendingSelection.prefix,
          suffix: pendingSelection.suffix,
          scope: { kind: 'pdf', pageNumber: 1 },
        })
      : { surroundingText: pendingSelection.selectedText, documentType: 'pdf' }

    try {
      await navigator.clipboard.writeText(formatCopyAsQuote(pendingSelection.selectedText, context))
    } catch {
      // Clipboard API may be blocked
    }

    clearDomSelection()
    closeSelectionMenu()
  }, [pendingSelection, getSurface, closeSelectionMenu])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: pdfContentRef,
    cancelFollowUp,
  })

  const handleDeleteActiveAnnotation = useCallback(() => {
    if (!onRemoveAnnotation || !activeAnnotationDetail) return
    onRemoveAnnotation(activeAnnotationDetail.annotationId)
    markDeleteSuccess()
  }, [onRemoveAnnotation, activeAnnotationDetail, markDeleteSuccess])

  const handleSelectionMenuRequestBack = useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }
    return false
  }, [selectionMenuView, handleCancelFollowUp])

  // ---------------------------------------------------------------------------
  // Island events (outside click, scroll dismiss)
  // ---------------------------------------------------------------------------

  useAnnotationIslandEvents({
    enabled: canAnnotate && hasAnnotationInteraction(interactionState) && isSelectionMenuVisible,
    openedAtRef: selectionMenuOpenedAtRef,
    isCompactView: selectionMenuView === 'compact',
    isTargetInsideAnnotationIsland,
    onBack: handleSelectionMenuRequestBack,
    onClose: closeSelectionMenu,
  })

  // ---------------------------------------------------------------------------
  // Annotation chip interaction (clicking existing highlights)
  // ---------------------------------------------------------------------------

  const handleOpenAnnotationDetail = useCallback((
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

  // Header actions: item navigation + copy button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeItem?.src || filePath} title="Copy path" className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: FileText,
        label: 'PDF',
        variant: 'orange',
      }}
      filePath={activeItem?.src || filePath}
      error={error ? { label: 'Load Failed', message: error } : undefined}
      headerActions={headerActions}
    >
      <div
        ref={pdfContentRef}
        className="h-full flex flex-col items-center overflow-auto relative"
        onMouseDown={canAnnotate ? handleSelectionPointerDown : undefined}
        onMouseUp={canAnnotate ? handleTextSelection : undefined}
      >
        {isLoading && (
          <div className="text-muted-foreground text-sm">Loading PDF...</div>
        )}
        {fileObj && (
          <Document
            file={fileObj}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<div className="text-muted-foreground text-sm">Rendering...</div>}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <Page
                key={i + 1}
                pageNumber={i + 1}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="pdf-page"
              />
            ))}
          </Document>
        )}

        {/* Annotation highlight overlay */}
        {annotationOverlayRects.length > 0 && (
          <AnnotationOverlayLayer
            rects={annotationOverlayRects}
            chips={[]}
            annotations={annotations ?? []}
            getTooltipText={(annotation) => formatAnnotationFollowUpTooltipText(annotation)}
            allowChipOpen={canAnnotate}
            onChipOpen={({ annotationId, index, anchorX, anchorY, mode }) => {
              handleOpenAnnotationDetail(annotationId, index, anchorX, anchorY, mode)
            }}
          />
        )}
      </div>

      {/* Annotation Island Menu */}
      {canAnnotate && (
        <AnnotationIslandMenu
          anchor={selectionMenuRenderAnchor}
          sourceKey={selectionMenuRenderSourceKey}
          replayNonce={selectionMenuShowNonce}
          isVisible={isSelectionMenuVisible}
          activeView={selectionMenuView}
          mode={followUpMode}
          draft={followUpDraft}
          onDraftChange={setFollowUpDraft}
          onOpenFollowUp={handleOpenFollowUpView}
          onHighlight={handleHighlight}
          onCopyAsQuote={handleCopyAsQuote}
          onCancel={handleCancelFollowUp}
          onRequestBack={handleSelectionMenuRequestBack}
          onRequestEdit={handleRequestFollowUpEdit}
          onSubmit={handleSubmitFollowUp}
          onDelete={activeAnnotationDetail ? handleDeleteActiveAnnotation : undefined}
          sendMessageKey={sendMessageKey}
          transitionConfig={selectionMenuTransitionConfig}
          onExitComplete={handleSelectionMenuExitComplete}
          usePortal={false}
        />
      )}
    </PreviewOverlay>
  )
}
