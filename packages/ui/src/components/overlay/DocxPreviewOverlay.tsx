/**
 * DocxPreviewOverlay - Fullscreen overlay for viewing rendered DOCX content.
 *
 * Uses PreviewOverlay as the base for consistent modal/fullscreen behavior.
 * Renders DOCX binary via docx-preview's renderAsync(), sanitizes the output,
 * and displays it in a sandboxed iframe (no script execution).
 *
 * The iframe auto-sizes to its content height by reading contentDocument.scrollHeight
 * on load (possible because allow-same-origin is set).
 */

import * as React from 'react'
import { FileText } from 'lucide-react'
import { renderAsync } from 'docx-preview'
import type { AnnotationV1 } from '@craft-agent/core'
import { PreviewOverlay } from './PreviewOverlay'
import { sanitizeDocxHtml, wrapInDocxIframe } from '../annotations/docx-sanitizer'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import { DocxAnnotationSurface } from '../annotations/DocxAnnotationSurface'
import { usePreviewAnnotationInteraction } from '../annotations/use-preview-annotation-interaction'
import { useAnnotationToast } from '../annotations/AnnotationToast'
import type { PointerSnapshot } from '../annotations/island-motion'

export interface DocxPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** Pre-loaded DOCX binary data */
  docxData?: Uint8Array
  /** File path for display/title purposes */
  src?: string
  /** Optional title for the overlay header */
  title?: string
  /** Theme mode for dark/light styling */
  theme?: 'light' | 'dark'
  /** Session ID for annotation context */
  sessionId?: string
  /** Annotations attached to this DOCX preview */
  annotations?: AnnotationV1[]
  /** Callback to add an annotation */
  onAddAnnotation?: (annotation: AnnotationV1) => void
  /** Callback to remove an annotation */
  onRemoveAnnotation?: (annotationId: string) => void
  /** Callback to update an annotation */
  onUpdateAnnotation?: (annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback to show a toast */
  onToast?: (message: string) => void
}

export function DocxPreviewOverlay({
  isOpen,
  onClose,
  docxData,
  src,
  title,
  theme,
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onToast,
}: DocxPreviewOverlayProps) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const contentRootRef = React.useRef<HTMLDivElement>(null)
  const [renderedHtml, setRenderedHtml] = React.useState<string | null>(null)
  const [contentSize, setContentSize] = React.useState<{ width: number; height: number } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // -- Annotation toast -------------------------------------------------------

  const { showToast, ToastElement } = useAnnotationToast()

  // Forward onToast from props, or use local toast
  const handleToast = React.useCallback((message: string) => {
    onToast?.(message)
    showToast(message)
  }, [onToast, showToast])

  // -- Annotation surface management ------------------------------------------

  const surfaceRef = React.useRef<DocxAnnotationSurface | null>(null)

  const getSurface = React.useCallback((): DocxAnnotationSurface | null => {
    const iframe = iframeRef.current
    if (!iframe) {
      surfaceRef.current = null
      return null
    }
    if (!surfaceRef.current) {
      const label = title || src
      surfaceRef.current = new DocxAnnotationSurface(iframe, label)
    }
    return surfaceRef.current
  }, [title, src])

  // -- Annotation interaction (shared hook) -----------------------------------

  const buildDocumentMeta = React.useCallback(() => ({
    kind: 'docx',
    title: title ?? undefined,
    fileName: src ?? undefined,
  }), [title, src])

  const clearSurfaceSelection = React.useCallback(() => {
    try {
      iframeRef.current?.contentDocument?.getSelection()?.removeAllRanges()
    } catch {
      // Cross-origin
    }
  }, [])

  const annotationInteraction = usePreviewAnnotationInteraction({
    isOpen,
    onAddAnnotation,
    onRemoveAnnotation,
    annotations,
    sourceId: `docx:${src || '__single__'}`,
    sourceKeySegment: `docx:${src}`,
    sessionId,
    sendMessageKey,
    contentRootRef,
    getSurface,
    buildDocumentMeta,
    expectedScopeKind: 'docx',
    clearSurfaceSelection,
    overlayRectDeps: [contentSize],
  })

  const {
    canAnnotate,
    handleSelectionPointerDown,
    handleTextSelection,
    showSelectionMenuFromCurrentSelection,
    closeSelectionMenu,
    annotationOverlayRects,
    islandMenuProps,
    overlayLayerProps,
  } = annotationInteraction

  // -- Reset annotation state on close ----------------------------------------

  React.useEffect(() => {
    closeSelectionMenu()
    surfaceRef.current = null
  }, [isOpen, closeSelectionMenu])

  // Render DOCX to HTML when overlay opens with data
  React.useEffect(() => {
    if (!isOpen || !docxData) {
      setRenderedHtml(null)
      setContentSize(null)
      return
    }

    setLoading(true)
    setError(null)

    const container = document.createElement('div')
    renderAsync(new Uint8Array(docxData), container, undefined, {
      className: 'docx-preview',
      inWrapper: false,
      ignoreWidth: true,
      ignoreHeight: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    })
      .then(() => {
        const rawHtml = container.innerHTML
        const sanitized = sanitizeDocxHtml(rawHtml)
        const wrapped = wrapInDocxIframe(sanitized, `
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            line-height: 1.6;
            color: #1a1a1a;
            padding: 24px 64px 36px;
            margin: 0;
          }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #ddd; padding: 8px; }
          img { max-width: 100%; height: auto; }
        `)
        setRenderedHtml(wrapped)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to render DOCX')
      })
      .finally(() => setLoading(false))
  }, [isOpen, docxData])

  // Read iframe content dimensions after it loads
  const handleLoad = React.useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    try {
      const doc = iframe.contentDocument
      if (!doc?.body) return
      doc.documentElement.style.overflow = 'hidden'
      doc.body.style.overflow = 'hidden'
      const origWidth = doc.body.style.width
      doc.body.style.width = 'fit-content'
      const naturalWidth = doc.body.scrollWidth
      doc.body.style.width = origWidth
      const height = doc.body.scrollHeight
      setContentSize({ width: naturalWidth, height })
    } catch {
      // Cross-origin access denied
    }

    // Reset surface when iframe reloads (new content)
    surfaceRef.current = null
  }, [])

  // ---------------------------------------------------------------------------
  // Iframe mouseup bridging — capture selections from inside the iframe
  // ---------------------------------------------------------------------------

  React.useEffect(() => {
    if (!canAnnotate || !isOpen) return

    const iframe = iframeRef.current
    if (!iframe) return

    const doc = iframe.contentDocument
    if (!doc) return

    const handleIframeMouseUp = (event: MouseEvent) => {
      const iframeRect = iframe.getBoundingClientRect()
      const hostX = event.clientX + iframeRect.left
      const hostY = event.clientY + iframeRect.top

      annotationInteraction.lastPointerRef.current = { x: hostX, y: hostY, ts: Date.now() }
      showSelectionMenuFromCurrentSelection()
    }

    const handleIframeMouseDown = (event: MouseEvent) => {
      const iframeRect = iframe.getBoundingClientRect()
      const hostX = event.clientX + iframeRect.left
      const hostY = event.clientY + iframeRect.top

      const snapshot: PointerSnapshot = { x: hostX, y: hostY, ts: Date.now() }
      annotationInteraction.dragStartPointerRef.current = snapshot
      annotationInteraction.lastPointerRef.current = snapshot
    }

    try {
      doc.addEventListener('mouseup', handleIframeMouseUp)
      doc.addEventListener('mousedown', handleIframeMouseDown)
    } catch {
      return // Cross-origin
    }

    return () => {
      try {
        doc.removeEventListener('mouseup', handleIframeMouseUp)
        doc.removeEventListener('mousedown', handleIframeMouseDown)
      } catch {
        // Cross-origin
      }
    }
  // Re-attach when iframe content changes (renderedHtml triggers reload)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAnnotate, isOpen, renderedHtml, contentSize])

  const iframeHeight = contentSize
    ? `${contentSize.height}px`
    : 'calc(100vh - 200px)'

  const measured = contentSize !== null

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: FileText,
        label: 'DOCX',
        variant: 'blue',
      }}
      title={title || src || 'DOCX Preview'}
    >
      <div
        ref={contentRootRef}
        className="px-6 pb-6 relative"
        onMouseDown={canAnnotate ? handleSelectionPointerDown : undefined}
        onMouseUp={canAnnotate ? handleTextSelection : undefined}
      >
        {loading && !renderedHtml && (
          <div className="py-12 text-center text-muted-foreground text-sm">Rendering DOCX...</div>
        )}
        {error && !renderedHtml && (
          <div className="py-12 text-center text-destructive/70 text-sm">{error}</div>
        )}
        {renderedHtml && (
          <div
            className="bg-white rounded-[12px] overflow-hidden shadow-minimal mx-auto"
            style={{
              maxWidth: contentSize?.width ? `${contentSize.width + 128}px` : undefined,
              opacity: measured ? 1 : 0,
              transition: 'opacity 200ms ease-in',
            }}
          >
            <iframe
              ref={iframeRef}
              sandbox="allow-same-origin"
              srcDoc={renderedHtml}
              onLoad={handleLoad}
              title={title || 'DOCX Preview'}
              className="w-full border-0"
              style={{ height: iframeHeight, minHeight: '400px' }}
            />
          </div>
        )}

        {/* Annotation highlight overlay */}
        {annotationOverlayRects.length > 0 && (
          <AnnotationOverlayLayer {...overlayLayerProps} />
        )}

        {/* Toast messages */}
        {ToastElement}
      </div>

      {/* Annotation Island Menu */}
      {canAnnotate && (
        <AnnotationIslandMenu {...islandMenuProps} />
      )}
    </PreviewOverlay>
  )
}
