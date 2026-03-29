/**
 * HTMLPreviewOverlay - Fullscreen overlay for viewing rendered HTML content.
 *
 * Uses PreviewOverlay as the base for consistent modal/fullscreen behavior.
 * Renders HTML in a sandboxed iframe (no script execution).
 * Links open in the system browser via Electron's will-navigate handler.
 *
 * Supports multiple items with arrow navigation in the header.
 * The iframe auto-sizes to its content height by reading contentDocument.scrollHeight
 * on load (possible because allow-same-origin is set).
 *
 * Annotation support: when annotation callbacks are provided, users can select
 * text inside the HTML iframe and create highlights, follow-ups, or copy-as-quote
 * via the AnnotationIslandMenu. Selection events are bridged from the iframe to
 * the host document via mouseup forwarding.
 */

import * as React from 'react'
import { Globe } from 'lucide-react'
import type { AnnotationV1 } from '@craft-agent/core'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
import { AnnotationOverlayLayer } from '../annotations/AnnotationOverlayLayer'
import { HtmlAnnotationSurface } from '../annotations/HtmlAnnotationSurface'
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

/**
 * Inject `<base target="_top">` so link clicks navigate the top frame,
 * which Electron's will-navigate handler intercepts → system browser.
 */
function injectBaseTarget(html: string): string {
  if (/<base\s/i.test(html)) return html
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, '$1<base target="_top">')
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, '$1<head><base target="_top"></head>')
  }
  return `<head><base target="_top"></head>${html}`
}

interface PreviewItem {
  src: string
  label?: string
}

export interface HTMLPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** Single HTML content (backward compat for link interceptor usage) */
  html?: string
  /** Multiple items for tabbed navigation */
  items?: PreviewItem[]
  /** Pre-loaded content cache (src → html string) */
  contentCache?: Record<string, string>
  /** Callback to load content for uncached items */
  onLoadContent?: (src: string) => Promise<string>
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Optional title for the overlay header */
  title?: string
  /** Theme mode for dark/light styling */
  theme?: 'light' | 'dark'
  /** Session ID for annotation context */
  sessionId?: string
  /** Annotations attached to this HTML preview */
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

export function HTMLPreviewOverlay({
  isOpen,
  onClose,
  html,
  items,
  contentCache: externalCache,
  onLoadContent,
  initialIndex = 0,
  title,
  theme,
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onToast,
}: HTMLPreviewOverlayProps) {
  // Normalize: single html prop → single item, or use items array
  const resolvedItems = React.useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    if (html) return [{ src: '__single__' }]
    return []
  }, [items, html])

  const [activeIdx, setActiveIdx] = React.useState(initialIndex)
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const htmlContentRef = React.useRef<HTMLDivElement>(null)
  const [contentSize, setContentSize] = React.useState<{ width: number; height: number } | null>(null)

  // Internal content cache (merges external + locally loaded)
  const [internalCache, setInternalCache] = React.useState<Record<string, string>>({})
  const [loadingItem, setLoadingItem] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  // Merge caches — external takes precedence, plus single html prop
  const mergedCache = React.useMemo(() => {
    const merged: Record<string, string> = { ...internalCache }
    if (externalCache) Object.assign(merged, externalCache)
    if (html) merged['__single__'] = html
    return merged
  }, [internalCache, externalCache, html])

  const activeItem = resolvedItems[activeIdx]
  const activeContent = activeItem ? mergedCache[activeItem.src] : undefined

  // Refs for annotation system
  const surfaceRef = React.useRef<HtmlAnnotationSurface | null>(null)
  const lastPointerRef = React.useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = React.useRef<PointerSnapshot | null>(null)

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

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = React.useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = React.useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )

  // Annotation overlay rects for highlight rendering
  const [annotationOverlayRects, setAnnotationOverlayRects] = React.useState<AnnotationOverlayRect[]>([])

  // Island presentation (anchor, visibility, exit animation)
  const selectionMenuAnchor = getAnnotationInteractionAnchor(interactionState)
  const selectionMenuSourceKey = getAnnotationInteractionSourceKey(interactionState, `html:${activeItem?.src}`)

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

  const getSurface = React.useCallback((): HtmlAnnotationSurface | null => {
    const iframe = iframeRef.current
    if (!iframe) {
      surfaceRef.current = null
      return null
    }
    if (!surfaceRef.current) {
      const label = activeItem?.label || title || activeItem?.src
      surfaceRef.current = new HtmlAnnotationSurface(iframe, label)
    }
    return surfaceRef.current
  }, [activeItem?.src, activeItem?.label, title])

  // ---------------------------------------------------------------------------
  // Close / cleanup
  // ---------------------------------------------------------------------------

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

  // Reset annotation state when overlay closes or active item changes
  React.useEffect(() => {
    closeSelectionMenu()
    surfaceRef.current = null
  }, [isOpen, activeIdx, closeSelectionMenu])

  // Reset index when overlay opens
  React.useEffect(() => {
    if (isOpen) {
      setActiveIdx(initialIndex)
      setContentSize(null)
    }
  }, [isOpen, initialIndex])

  // Reset size when active item changes
  React.useEffect(() => {
    setContentSize(null)
    setLoadError(null)
  }, [activeIdx])

  // Load content for active item if not cached
  React.useEffect(() => {
    if (!isOpen || !activeItem?.src) return
    if (mergedCache[activeItem.src]) return
    if (!onLoadContent) return

    setLoadingItem(true)
    setLoadError(null)
    onLoadContent(activeItem.src)
      .then((content) => {
        setInternalCache((prev) => ({ ...prev, [activeItem.src]: content }))
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load content')
      })
      .finally(() => setLoadingItem(false))
  }, [isOpen, activeItem?.src, mergedCache, onLoadContent])

  // Preprocess active HTML
  const processedHtml = React.useMemo(
    () => activeContent ? injectBaseTarget(activeContent) : null,
    [activeContent]
  )

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

  const iframeHeight = contentSize
    ? `${contentSize.height}px`
    : 'calc(100vh - 200px)'

  const measured = contentSize !== null

  // ---------------------------------------------------------------------------
  // Annotation overlay geometry
  // ---------------------------------------------------------------------------

  React.useEffect(() => {
    if (!annotations?.length || !htmlContentRef.current) {
      setAnnotationOverlayRects([])
      return
    }

    const surface = getSurface()
    if (!surface) {
      setAnnotationOverlayRects([])
      return
    }

    const containerRect = htmlContentRef.current.getBoundingClientRect()
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
  }, [annotations, contentSize, getSurface])

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
      // Translate iframe-local coords to host-document coords
      const iframeRect = iframe.getBoundingClientRect()
      const hostX = event.clientX + iframeRect.left
      const hostY = event.clientY + iframeRect.top

      lastPointerRef.current = { x: hostX, y: hostY, ts: Date.now() }
      showSelectionMenuFromCurrentSelection()
    }

    const handleIframeMouseDown = (event: MouseEvent) => {
      const iframeRect = iframe.getBoundingClientRect()
      const hostX = event.clientX + iframeRect.left
      const hostY = event.clientY + iframeRect.top

      const snapshot: PointerSnapshot = { x: hostX, y: hostY, ts: Date.now() }
      dragStartPointerRef.current = snapshot
      lastPointerRef.current = snapshot
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
  // Re-attach when iframe content changes (processedHtml triggers reload)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAnnotate, isOpen, processedHtml, contentSize])

  // ---------------------------------------------------------------------------
  // Selection handling
  // ---------------------------------------------------------------------------

  const showSelectionMenuFromCurrentSelection = React.useCallback(() => {
    if (!canAnnotate) return

    const surface = getSurface()
    if (!surface) return

    requestAnimationFrame(() => {
      const captured = surface.captureSelection()

      if (!captured) {
        closeSelectionMenu()
        return
      }

      if (captured.scope.kind !== 'html') {
        closeSelectionMenu()
        return
      }

      // Compute anchor from selection rects (already in host coordinates via surface)
      const selRects = surface.getSelectionRects(captured)
      const pointer = lastPointerRef.current
      const hasRecentPointer = Boolean(pointer && (Date.now() - pointer.ts) <= SELECTION_POINTER_MAX_AGE_MS)
      const pointerX = hasRecentPointer && pointer ? pointer.x : null

      let anchorRect: DOMRect | undefined
      if (selRects.length > 0) {
        anchorRect = selRects.reduce((best, rect) => (rect.top < best.top ? rect : best))
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
  }, [canAnnotate, getSurface, closeSelectionMenu, triggerSelectionMenuEntryReplay, openFromSelection])

  // Handle mouseup on the host document area (outside the iframe)
  const handleSelectionPointerDown = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const snapshot: PointerSnapshot = {
      x: event.clientX,
      y: event.clientY,
      ts: Date.now(),
    }
    dragStartPointerRef.current = snapshot
    lastPointerRef.current = snapshot
  }, [])

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

  // ---------------------------------------------------------------------------
  // Annotation handlers (highlight, follow-up, copy-as-quote)
  // ---------------------------------------------------------------------------

  const saveAnnotation = React.useCallback(async (note: string) => {
    if (!pendingSelection || !onAddAnnotation) return

    const annotation = createTextSelectionAnnotation(
      `html:${activeItem?.src || '__single__'}`,
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

    // Attach HTML-specific document metadata
    ;(annotation as AnnotationV1 & { meta: Record<string, unknown> }).meta = {
      ...annotation.meta,
      document: {
        kind: 'html',
        title: (activeItem?.label || title) ?? undefined,
      },
    }

    onAddAnnotation(annotation)

    // Clear selection inside the iframe
    try {
      iframeRef.current?.contentDocument?.getSelection()?.removeAllRanges()
    } catch {
      // Cross-origin
    }
    clearDomSelection()
    markSubmitSuccess()
  }, [pendingSelection, onAddAnnotation, activeItem, title, sessionId, markSubmitSuccess])

  const handleHighlight = React.useCallback(() => {
    if (!pendingSelection) return
    void saveAnnotation('')
  }, [pendingSelection, saveAnnotation])

  const handleOpenFollowUpView = React.useCallback(() => {
    if (!pendingSelection) return
    try {
      iframeRef.current?.contentDocument?.getSelection()?.removeAllRanges()
    } catch { /* cross-origin */ }
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection])

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
          scope: { kind: 'html' },
        })
      : { surroundingText: pendingSelection.selectedText, documentType: 'html' }

    try {
      await navigator.clipboard.writeText(formatCopyAsQuote(pendingSelection.selectedText, context))
    } catch {
      // Clipboard API may be blocked
    }

    try {
      iframeRef.current?.contentDocument?.getSelection()?.removeAllRanges()
    } catch { /* cross-origin */ }
    clearDomSelection()
    closeSelectionMenu()
  }, [pendingSelection, getSurface, closeSelectionMenu])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: htmlContentRef,
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

  // Header actions: item navigation + copy button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeContent || ''} label="Copy HTML" className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Globe,
        label: 'HTML',
        variant: 'blue',
      }}
      title={title || activeItem?.label || 'HTML Preview'}
      headerActions={headerActions}
    >
      <div
        ref={htmlContentRef}
        className="px-6 pb-6 relative"
        onMouseDown={canAnnotate ? handleSelectionPointerDown : undefined}
        onMouseUp={canAnnotate ? handleTextSelection : undefined}
      >
        {loadingItem && !activeContent && (
          <div className="py-12 text-center text-muted-foreground text-sm">Loading...</div>
        )}
        {loadError && !activeContent && (
          <div className="py-12 text-center text-destructive/70 text-sm">{loadError}</div>
        )}
        {processedHtml && (
          <div
            className="bg-white rounded-[12px] overflow-hidden shadow-minimal mx-auto"
            style={{
              maxWidth: contentSize?.width ? `${contentSize.width + 128}px` : undefined,
              padding: '24px 64px 36px',
              opacity: measured ? 1 : 0,
              transition: 'opacity 200ms ease-in',
            }}
          >
            <iframe
              ref={iframeRef}
              sandbox="allow-same-origin allow-top-navigation-by-user-activation"
              srcDoc={processedHtml}
              onLoad={handleLoad}
              title={activeItem?.label || title || 'HTML Preview'}
              className="w-full border-0"
              style={{ height: iframeHeight, minHeight: '400px' }}
            />
          </div>
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
