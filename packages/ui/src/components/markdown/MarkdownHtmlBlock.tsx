/**
 * MarkdownHtmlBlock - Renders ```html-preview code blocks as sandboxed HTML previews.
 *
 * Loads HTML from file(s) (via `src` or `items` field) and renders in a sandboxed iframe.
 * Supports multiple items with a tab bar for switching between them.
 *
 * Expected JSON shapes:
 * Single item:
 * {
 *   "src": "/absolute/path/to/file.html",
 *   "title": "Optional title"
 * }
 *
 * Multiple items:
 * {
 *   "title": "Email Thread",
 *   "items": [
 *     { "src": "/path/to/email1.html", "label": "Original" },
 *     { "src": "/path/to/reply.html", "label": "Reply" }
 *   ]
 * }
 *
 * Flash prevention: All cached items are rendered as hidden iframes (display:none/block).
 * Switching tabs toggles CSS visibility — no re-parse, no flash.
 *
 * Annotation support: when annotation callbacks are provided, users can select
 * text inside the HTML iframe and create highlights, follow-ups, or copy-as-quote
 * via the AnnotationIslandMenu. Selection events are bridged from the iframe to
 * the host document.
 *
 * Security: iframe uses `sandbox` attribute without `allow-scripts`,
 * blocking all JavaScript execution. `allow-same-origin` is included
 * so CSS and images resolve correctly.
 */

import * as React from 'react'
import { Globe, Maximize2 } from 'lucide-react'
import type { AnnotationV1 } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip'
import { HTMLPreviewOverlay } from '../overlay/HTMLPreviewOverlay'
import { ItemNavigator } from '../overlay/ItemNavigator'
import { usePlatform } from '../../context/PlatformContext'
import { AnnotationIslandMenu } from '../annotations/AnnotationIslandMenu'
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
import { formatCopyAsQuote } from '../annotations/follow-up-formatter-registry'
import {
  SELECTION_POINTER_MAX_AGE_MS,
  clamp,
  createTextSelectionAnnotation,
} from '../annotations/annotation-core'
import { clearDomSelection } from '../annotations/selection-restore'
import type { IslandTransitionConfig } from '../ui'

// ── Types ────────────────────────────────────────────────────────────────────

interface PreviewItem {
  src: string
  label?: string
}

interface HtmlPreviewSpec {
  src?: string
  title?: string
  items?: PreviewItem[]
}

// ── Error boundary ───────────────────────────────────────────────────────────

class HtmlBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownHtmlBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── HTML preprocessing ───────────────────────────────────────────────────────

/**
 * Inject `<base target="_top">` into HTML so link clicks navigate the top frame
 * instead of the iframe. Combined with `allow-top-navigation-by-user-activation`
 * in the sandbox, this lets Electron's `will-navigate` handler intercept the
 * navigation and open the URL in the system browser.
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

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownHtmlBlockProps {
  code: string
  className?: string
  /** Session ID for annotation context */
  sessionId?: string
  /** Annotations attached to this HTML block */
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

export function MarkdownHtmlBlock({
  code,
  className,
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onToast,
}: MarkdownHtmlBlockProps) {
  const { onReadFile } = usePlatform()

  // Parse the JSON spec — supports single src or items array
  const spec = React.useMemo<HtmlPreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.items && Array.isArray(raw.items) && raw.items.length > 0) {
        return raw as HtmlPreviewSpec
      }
      if (raw.src && typeof raw.src === 'string') {
        return raw as HtmlPreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // Normalize to items array (backward compat)
  const items = React.useMemo<PreviewItem[]>(() => {
    if (!spec) return []
    if (spec.items && spec.items.length > 0) return spec.items
    if (spec.src) return [{ src: spec.src }]
    return []
  }, [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  // Content cache: src path → loaded HTML string
  const [contentCache, setContentCache] = React.useState<Record<string, string>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const activeItem = items[activeIndex]
  const activeHtml = activeItem ? contentCache[activeItem.src] : undefined

  // Refs for inline annotation
  const contentAreaRef = React.useRef<HTMLDivElement>(null)
  const iframeRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map())
  const surfaceRef = React.useRef<HtmlAnnotationSurface | null>(null)
  const lastPointerRef = React.useRef<PointerSnapshot | null>(null)
  const dragStartPointerRef = React.useRef<PointerSnapshot | null>(null)

  // Load active item's content when it changes
  React.useEffect(() => {
    if (!activeItem?.src || !onReadFile) return
    if (contentCache[activeItem.src]) {
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    onReadFile(activeItem.src)
      .then((content) => {
        setContentCache((prev) => ({ ...prev, [activeItem.src]: content }))
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to read HTML file')
      })
      .finally(() => setLoading(false))
  }, [activeItem?.src, onReadFile, contentCache])

  // Preprocess all cached HTML (inject base target for links)
  const processedCache = React.useMemo(() => {
    const result: Record<string, string> = {}
    for (const [src, html] of Object.entries(contentCache)) {
      result[src] = injectBaseTarget(html)
    }
    return result
  }, [contentCache])

  const hasCachedContent = Object.keys(contentCache).length > 0
  const hasMultiple = items.length > 1

  // Stable onLoadContent callback for the overlay
  const handleLoadContent = React.useCallback(async (src: string) => {
    if (contentCache[src]) return contentCache[src]
    if (!onReadFile) throw new Error('Cannot load content')
    const content = await onReadFile(src)
    setContentCache((prev) => ({ ...prev, [src]: content }))
    return content
  }, [contentCache, onReadFile])

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
    requestEdit,
    cancelFollowUp,
    closeAll,
    markSubmitSuccess,
  } = interaction

  const pendingSelection = interactionState.pendingSelection
  const selectionMenuView = interactionState.selectionMenuView
  const followUpDraft = interactionState.followUpDraft
  const followUpMode = interactionState.followUpMode

  const [selectionMenuShowNonce, setSelectionMenuShowNonce] = React.useState(0)
  const [selectionMenuTransitionConfig, setSelectionMenuTransitionConfig] = React.useState<IslandTransitionConfig>(
    buildAnnotationChipEntryTransition()
  )

  const selectionMenuAnchor = getAnnotationInteractionAnchor(interactionState)
  const selectionMenuSourceKey = getAnnotationInteractionSourceKey(interactionState, `html-inline:${activeItem?.src}`)

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
    if (!activeItem) {
      surfaceRef.current = null
      return null
    }
    const iframe = iframeRefs.current.get(activeItem.src)
    if (!iframe) {
      surfaceRef.current = null
      return null
    }
    if (!surfaceRef.current) {
      const label = activeItem.label || spec?.title || activeItem.src
      surfaceRef.current = new HtmlAnnotationSurface(iframe, label)
    }
    return surfaceRef.current
  }, [activeItem, spec?.title])

  // Reset surface when active item changes
  React.useEffect(() => {
    surfaceRef.current = null
    closeAll()
  }, [activeIndex, closeAll])

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

  // ---------------------------------------------------------------------------
  // Selection handling
  // ---------------------------------------------------------------------------

  const showSelectionMenuFromCurrentSelection = React.useCallback(() => {
    if (!canAnnotate) return

    const surface = getSurface()
    if (!surface) return

    requestAnimationFrame(() => {
      const captured = surface.captureSelection()

      if (!captured || captured.scope.kind !== 'html') {
        closeSelectionMenu()
        return
      }

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

  // ---------------------------------------------------------------------------
  // Iframe event bridging
  // ---------------------------------------------------------------------------

  React.useEffect(() => {
    if (!canAnnotate || !activeItem) return

    const iframe = iframeRefs.current.get(activeItem.src)
    if (!iframe) return

    let doc: Document | null = null
    try {
      doc = iframe.contentDocument
    } catch {
      return
    }
    if (!doc) return

    const handleIframeMouseUp = (event: MouseEvent) => {
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
      return
    }

    return () => {
      try {
        doc!.removeEventListener('mouseup', handleIframeMouseUp)
        doc!.removeEventListener('mousedown', handleIframeMouseDown)
      } catch {
        // iframe may be gone
      }
    }
  // Re-attach when content loads for active item
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAnnotate, activeItem?.src, activeHtml])

  // ---------------------------------------------------------------------------
  // Annotation handlers
  // ---------------------------------------------------------------------------

  const saveAnnotation = React.useCallback(async (note: string) => {
    if (!pendingSelection || !onAddAnnotation || !activeItem) return

    const annotation = createTextSelectionAnnotation(
      `html:${activeItem.src}`,
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

    ;(annotation as AnnotationV1 & { meta: Record<string, unknown> }).meta = {
      ...annotation.meta,
      document: {
        kind: 'html',
        title: (activeItem.label || spec?.title) ?? undefined,
      },
    }

    onAddAnnotation(annotation)

    // Clear selection inside the iframe
    try {
      iframeRefs.current.get(activeItem.src)?.contentDocument?.getSelection()?.removeAllRanges()
    } catch { /* cross-origin */ }
    clearDomSelection()
    markSubmitSuccess()
  }, [pendingSelection, onAddAnnotation, activeItem, spec?.title, sessionId, markSubmitSuccess])

  const handleHighlight = React.useCallback(() => {
    if (!pendingSelection) return
    void saveAnnotation('')
  }, [pendingSelection, saveAnnotation])

  const handleOpenFollowUpView = React.useCallback(() => {
    if (!pendingSelection) return
    try {
      if (activeItem) {
        iframeRefs.current.get(activeItem.src)?.contentDocument?.getSelection()?.removeAllRanges()
      }
    } catch { /* cross-origin */ }
    clearDomSelection()
    openFollowUpFromSelection()
  }, [pendingSelection, openFollowUpFromSelection, activeItem])

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
    } catch { /* Clipboard API blocked */ }

    try {
      if (activeItem) {
        iframeRefs.current.get(activeItem.src)?.contentDocument?.getSelection()?.removeAllRanges()
      }
    } catch { /* cross-origin */ }
    clearDomSelection()
    closeSelectionMenu()
  }, [pendingSelection, getSurface, closeSelectionMenu, activeItem])

  const handleCancelFollowUp = useAnnotationCancelRestore({
    contentRootRef: contentAreaRef,
    cancelFollowUp,
  })

  const handleSelectionMenuRequestBack = React.useCallback((): boolean => {
    if (selectionMenuView !== 'compact') {
      handleCancelFollowUp()
      return true
    }
    return false
  }, [selectionMenuView, handleCancelFollowUp])

  // ---------------------------------------------------------------------------
  // Island events
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
  // Iframe ref callback
  // ---------------------------------------------------------------------------

  const setIframeRef = React.useCallback((src: string) => (el: HTMLIFrameElement | null) => {
    if (el) {
      iframeRefs.current.set(src, el)
    } else {
      iframeRefs.current.delete(src)
    }
  }, [])

  // Invalid spec → fall back to code block
  if (!spec || items.length === 0) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <HtmlBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <Globe className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1">
            {spec.title || 'HTML Preview'}
          </span>
          <div className="flex items-center gap-1">
            <ItemNavigator items={items} activeIndex={activeIndex} onSelect={setActiveIndex} />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setIsFullscreen(true)}
                  className={cn(
                    "p-1 rounded-[6px] transition-all select-none",
                    "bg-background shadow-minimal",
                    "text-muted-foreground/50 hover:text-foreground",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
                    hasMultiple ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Open fullscreen to annotate
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content area: hidden iframes for cached items + loading/error for uncached active */}
        <div ref={contentAreaRef} className="relative max-h-[400px] overflow-hidden">
          {/* Render all cached items as hidden iframes — prevents flash on tab switch */}
          {items.map((item, i) => {
            const processed = processedCache[item.src]
            if (!processed) return null
            return (
              <iframe
                key={item.src}
                ref={setIframeRef(item.src)}
                sandbox="allow-same-origin allow-top-navigation-by-user-activation"
                srcDoc={processed}
                title={item.label || spec.title || 'HTML Preview'}
                className="w-full border-0 bg-white"
                style={{
                  height: '400px',
                  display: i === activeIndex ? 'block' : 'none',
                }}
              />
            )
          })}

          {/* Loading state for uncached active item */}
          {!activeHtml && loading && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">Loading...</div>
          )}

          {/* Error state for uncached active item */}
          {!activeHtml && !loading && error && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

          {/* Bottom fade gradient */}
          {hasCachedContent && (
            <div
              className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
              style={{
                background: 'linear-gradient(to bottom, transparent, var(--muted))',
              }}
            />
          )}
        </div>

        {/* Inline Annotation Island Menu */}
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
            sendMessageKey={sendMessageKey}
            transitionConfig={selectionMenuTransitionConfig}
            onExitComplete={handleSelectionMenuExitComplete}
            usePortal={true}
          />
        )}
      </div>

      {/* Fullscreen overlay — passes items for multi-item navigation + annotation props */}
      <HTMLPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        items={items}
        contentCache={contentCache}
        onLoadContent={handleLoadContent}
        initialIndex={activeIndex}
        title={spec.title}
        sessionId={sessionId}
        annotations={annotations}
        onAddAnnotation={onAddAnnotation}
        onRemoveAnnotation={onRemoveAnnotation}
        onUpdateAnnotation={onUpdateAnnotation}
        sendMessageKey={sendMessageKey}
        onToast={onToast}
      />
    </HtmlBlockErrorBoundary>
  )
}
