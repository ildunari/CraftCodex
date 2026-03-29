/**
 * MarkdownDocxBlock - Renders ```docx-preview code blocks as rich DOCX previews.
 *
 * Loads a .docx file as binary via the platform's onReadFileBinary handler,
 * renders it to HTML using docx-preview's renderAsync(), sanitizes the output
 * with DOMPurify, and displays it in a sandboxed iframe.
 *
 * Expected JSON shape:
 * {
 *   "src": "/absolute/path/to/file.docx",
 *   "title": "Optional title"
 * }
 *
 * Security: The HTML produced by docx-preview is sanitized to strip scripts,
 * forms, iframes, and dangerous CSS. The result is wrapped with a strict CSP
 * meta tag and rendered in a sandboxed iframe (allow-same-origin only).
 */

import * as React from 'react'
import { FileText, Maximize2 } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '../tooltip'
import { renderAsync } from 'docx-preview'
import type { AnnotationV1 } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { DocxPreviewOverlay } from '../overlay/DocxPreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { sanitizeDocxHtml, wrapInDocxIframe } from '../annotations/docx-sanitizer'

// ── Types ────────────────────────────────────────────────────────────────────

interface DocxPreviewSpec {
  src: string
  title?: string
}

// ── Error boundary ───────────────────────────────────────────────────────────

class DocxBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownDocxBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export interface MarkdownDocxBlockProps {
  code: string
  className?: string
  /** Session ID for annotation context */
  sessionId?: string
  /** Annotations attached to this DOCX block */
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

export function MarkdownDocxBlock({
  code,
  className,
  sessionId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey,
  onToast,
}: MarkdownDocxBlockProps) {
  const { onReadFileBinary } = usePlatform()

  // Parse the JSON spec
  const spec = React.useMemo<DocxPreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.src && typeof raw.src === 'string') {
        return raw as DocxPreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Rendered HTML from docx-preview (already sanitized)
  const [renderedHtml, setRenderedHtml] = React.useState<string | null>(null)
  // Raw binary for passing to overlay
  const [docxData, setDocxData] = React.useState<Uint8Array | null>(null)

  // Load and render DOCX
  React.useEffect(() => {
    if (!spec?.src || !onReadFileBinary) return
    if (renderedHtml) return // already rendered

    setLoading(true)
    setError(null)

    onReadFileBinary(spec.src)
      .then(async (data) => {
        setDocxData(new Uint8Array(data))

        // Render DOCX to HTML using a temporary container
        const container = document.createElement('div')
        await renderAsync(data, container, undefined, {
          className: 'docx-preview',
          inWrapper: false,
          ignoreWidth: true,
          ignoreHeight: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        })

        // Extract and sanitize the HTML
        const rawHtml = container.innerHTML
        const sanitized = sanitizeDocxHtml(rawHtml)
        const wrapped = wrapInDocxIframe(sanitized, `
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            line-height: 1.6;
            color: #1a1a1a;
            padding: 16px;
            margin: 0;
          }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #ddd; padding: 8px; }
          img { max-width: 100%; height: auto; }
        `)

        setRenderedHtml(wrapped)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to read DOCX file')
      })
      .finally(() => setLoading(false))
  }, [spec?.src, onReadFileBinary, renderedHtml])

  // Invalid spec → fall back to code block
  if (!spec) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  return (
    <DocxBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1">
            {spec.title || 'DOCX Preview'}
          </span>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setIsFullscreen(true)}
                  className={cn(
                    "p-1 rounded-[6px] transition-all select-none",
                    "bg-background shadow-minimal",
                    "text-muted-foreground/50 hover:text-foreground",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100",
                    "opacity-0 group-hover:opacity-100"
                  )}
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                View fullscreen
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content area */}
        <div className="relative max-h-[400px] overflow-hidden">
          {renderedHtml && (
            <iframe
              sandbox="allow-same-origin"
              srcDoc={renderedHtml}
              title={spec.title || 'DOCX Preview'}
              className="w-full border-0 bg-white"
              style={{ height: '400px' }}
            />
          )}

          {/* Loading state */}
          {!renderedHtml && loading && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">Loading DOCX...</div>
          )}

          {/* Error state */}
          {!renderedHtml && !loading && error && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

          {/* Bottom fade gradient */}
          {renderedHtml && (
            <div
              className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
              style={{
                background: 'linear-gradient(to bottom, transparent, var(--muted))',
              }}
            />
          )}
        </div>
      </div>

      {/* Fullscreen overlay */}
      <DocxPreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        docxData={docxData ?? undefined}
        title={spec.title}
        src={spec.src}
        sessionId={sessionId}
        annotations={annotations}
        onAddAnnotation={onAddAnnotation}
        onRemoveAnnotation={onRemoveAnnotation}
        onUpdateAnnotation={onUpdateAnnotation}
        sendMessageKey={sendMessageKey}
        onToast={onToast}
      />
    </DocxBlockErrorBoundary>
  )
}
