/**
 * DocxAnnotationSurface -- AnnotationSurface implementation for DOCX documents.
 *
 * DOCX files are rendered to HTML via docx-preview and displayed in a
 * sandboxed iframe. This surface uses COMPOSITION (not inheritance) over
 * HtmlAnnotationSurface to avoid the kind-incompatibility problem:
 * HtmlAnnotationSurface.kind is 'html' as const, which cannot be overridden
 * to 'docx' via subclassing.
 *
 * All DOM selection/highlight/rect behaviour is delegated to an internal
 * HtmlAnnotationSurface instance. This class overrides:
 * - kind: 'docx'
 * - captureSelection: patches scope.kind to 'docx'
 * - getFollowUpContext: adds DOCX-specific context (documentType, fileName, sectionHeading)
 */

import type { AnnotationV1 } from '@craft-agent/core'
import { HtmlAnnotationSurface } from './HtmlAnnotationSurface'
import type {
  AnnotationSurface,
  SurfaceSelection,
  FollowUpContext,
  ResolvedAnnotation,
} from './types'

export class DocxAnnotationSurface implements AnnotationSurface {
  readonly kind = 'docx' as const

  private inner: HtmlAnnotationSurface
  private iframe: HTMLIFrameElement
  private docxFileName?: string

  constructor(iframe: HTMLIFrameElement, docxFileName?: string) {
    this.iframe = iframe
    this.docxFileName = docxFileName
    this.inner = new HtmlAnnotationSurface(iframe, docxFileName)
  }

  captureSelection(): SurfaceSelection | null {
    const sel = this.inner.captureSelection()
    if (!sel) return null

    // Patch scope kind from 'html' to 'docx'
    return {
      ...sel,
      scope: { kind: 'docx' },
    }
  }

  restoreSelection(sel: SurfaceSelection): void {
    // Delegate with html scope so inner surface recognizes it
    if (sel.scope.kind === 'docx') {
      this.inner.restoreSelection({
        ...sel,
        scope: { kind: 'html' },
      })
    } else {
      this.inner.restoreSelection(sel)
    }
  }

  getSelectionRects(sel: SurfaceSelection): DOMRect[] {
    // Delegate with html scope so inner surface recognizes it
    if (sel.scope.kind === 'docx') {
      return this.inner.getSelectionRects({
        ...sel,
        scope: { kind: 'html' },
      })
    }
    return this.inner.getSelectionRects(sel)
  }

  resolveAnnotation(annotation: AnnotationV1): ResolvedAnnotation | null {
    return this.inner.resolveAnnotation(annotation)
  }

  getFollowUpContext(sel: SurfaceSelection): FollowUpContext {
    // Translate scope for the inner surface
    const innerSel = sel.scope.kind === 'docx'
      ? { ...sel, scope: { kind: 'html' as const } }
      : sel
    const baseContext = this.inner.getFollowUpContext(innerSel)

    return {
      ...baseContext,
      documentType: 'docx',
      fileName: this.docxFileName,
      // DOCX-specific: try to extract section path from document structure.
      // docx-preview generates divs with section classes and h1-h6 headings.
      sectionHeading: this.extractDocxSectionHeading() ?? baseContext.sectionHeading,
    }
  }

  setRenderedAnnotations(annotations: AnnotationV1[]): void {
    this.inner.setRenderedAnnotations(annotations)
  }

  observeGeometryInvalidation(cb: () => void): () => void {
    return this.inner.observeGeometryInvalidation(cb)
  }

  /**
   * Walk up from the current selection in the iframe to find the nearest
   * heading element. docx-preview renders Word headings as h1-h6 elements,
   * so this extends the base HTML heading detection with DOCX-specific
   * structure awareness.
   */
  private extractDocxSectionHeading(): string | undefined {
    try {
      const doc = this.iframe?.contentDocument
      if (!doc) return undefined

      const selection = doc.getSelection()
      if (!selection || selection.rangeCount === 0) return undefined

      let node: Node | null = selection.anchorNode
      while (node && node !== doc.body) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement
          const tag = el.tagName?.toLowerCase()
          if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
            return el.textContent?.trim() || undefined
          }
          // Check previous siblings for headings
          let prev = el.previousElementSibling
          while (prev) {
            const prevTag = prev.tagName?.toLowerCase()
            if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(prevTag)) {
              return prev.textContent?.trim() || undefined
            }
            prev = prev.previousElementSibling
          }
        }
        node = node.parentNode
      }
      return undefined
    } catch {
      return undefined
    }
  }
}
