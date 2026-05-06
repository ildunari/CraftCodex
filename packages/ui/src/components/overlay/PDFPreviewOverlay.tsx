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
import { useTranslation } from 'react-i18next'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import type { DocumentCallback } from 'react-pdf/dist/shared/types.js'
import { FileText } from 'lucide-react'
import type { AnnotationV1 } from '@craft-agent/core'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import { PdfAnnotationSurface } from '../annotations/PdfAnnotationSurface'
import { usePreviewAnnotationInteraction } from '../annotations/use-preview-annotation-interaction'
import type { PointerSnapshot } from '../annotations/island-motion'
import { shouldIgnoreSelectionMouseUpTarget } from '../annotations/interaction-policy'
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
  const { t } = useTranslation()

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
  const pdfDocRef = useRef<DocumentCallback | null>(null)
  const surfaceRef = useRef<PdfAnnotationSurface | null>(null)

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
      const getPage = (pageNumber: number) => doc.getPage(pageNumber) as unknown as ReturnType<PDFDocumentProxy['getPage']>
      const fileName = activeItem?.label || activeItem?.src?.split('/').pop()
      surfaceRef.current = new PdfAnnotationSurface(container, getPage, fileName)
    }
    return surfaceRef.current
  }, [activeItem?.src, activeItem?.label])

  // ---------------------------------------------------------------------------
  // Annotation interaction (shared hook)
  // ---------------------------------------------------------------------------

  const buildDocumentMeta = useCallback(() => {
    const surface = getSurface()
    const captured = surface?.captureSelection()
    const pageNumber = captured?.scope.kind === 'pdf' ? (captured.scope as { pageNumber?: number }).pageNumber : undefined

    return {
      kind: 'pdf',
      title: (activeItem?.label || activeItem?.src?.split('/').pop()) ?? undefined,
      page: pageNumber ?? 1,
    }
  }, [getSurface, activeItem?.label, activeItem?.src])

  const onEmptyCapture = useCallback(() => {
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
  }, [onToast])

  const getSelectionAnchorRects = useCallback(() => {
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    return range
      ? Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
      : []
  }, [])

  const annotationInteraction = usePreviewAnnotationInteraction({
    isOpen,
    onAddAnnotation,
    onRemoveAnnotation,
    annotations,
    sourceId: `pdf:${activeItem?.src || filePath}`,
    sourceKeySegment: `pdf:${activeItem?.src}`,
    sessionId,
    sendMessageKey,
    contentRootRef: pdfContentRef,
    getSurface,
    buildDocumentMeta,
    expectedScopeKind: 'pdf',
    getSelectionAnchorRects,
    onEmptyCapture,
    overlayRectDeps: [numPages],
  })

  const {
    canAnnotate,
    handleSelectionPointerDown,
    showSelectionMenuFromCurrentSelection,
    closeSelectionMenu,
    annotationOverlayRects,
    islandMenuProps,
    overlayLayerProps,
  } = annotationInteraction

  // ---------------------------------------------------------------------------
  // PDF-specific: cross-page selection detection on mouseup
  // ---------------------------------------------------------------------------

  const handleTextSelection = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAnnotate) return
    if (shouldIgnoreSelectionMouseUpTarget(event.target)) return

    annotationInteraction.lastPointerRef.current = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    } satisfies PointerSnapshot

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
  }, [canAnnotate, annotationInteraction.lastPointerRef, showSelectionMenuFromCurrentSelection, closeSelectionMenu, onToast])

  // ---------------------------------------------------------------------------
  // Close / cleanup
  // ---------------------------------------------------------------------------

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

  const onDocumentLoadSuccess = useCallback((pdf: DocumentCallback) => {
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

  // Header actions: item navigation + copy button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeItem?.src || filePath} title={t('common.copyPath')} className="bg-background shadow-minimal" />
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
          <div className="text-muted-foreground text-sm">{t('preview.loadingPdf')}</div>
        )}
        {fileObj && (
          <Document
            file={fileObj}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={<div className="text-muted-foreground text-sm">{t('common.rendering')}</div>}
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
          <AnnotationOverlayLayer {...overlayLayerProps} />
        )}
      </div>

      {/* Annotation Island Menu */}
      {canAnnotate && (
        <AnnotationIslandMenu {...islandMenuProps} />
      )}
    </PreviewOverlay>
  )
}
