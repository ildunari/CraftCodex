/**
 * DocxAnnotationSurface — extends HtmlAnnotationSurface with DOCX-specific
 * context extraction.
 *
 * DOCX files are rendered to HTML via docx-preview and displayed in a
 * sandboxed iframe, so all selection/highlight/rect behaviour is inherited
 * from HtmlAnnotationSurface. This subclass only overrides follow-up
 * context to tag the document as DOCX and extract section headings from
 * the rendered structure.
 */

import { HtmlAnnotationSurface } from './HtmlAnnotationSurface'
import type { FollowUpContext, SurfaceSelection } from './types'

export class DocxAnnotationSurface extends HtmlAnnotationSurface {
  readonly kind = 'docx' as const

  constructor(iframe: HTMLIFrameElement, private docxFileName?: string) {
    super(iframe, docxFileName)
  }

  override getFollowUpContext(sel: SurfaceSelection): FollowUpContext {
    const baseContext = super.getFollowUpContext(sel)
    return {
      ...baseContext,
      documentType: 'docx',
      fileName: this.docxFileName,
      // DOCX-specific: try to extract section path from document structure.
      // docx-preview generates divs with section classes and h1-h6 headings.
      sectionHeading: this.extractDocxSectionHeading() ?? baseContext.sectionHeading,
    }
  }

  /**
   * Walk up from the current selection in the iframe to find the nearest
   * heading element. docx-preview renders Word headings as h1–h6 elements,
   * so this extends the base HTML heading detection with DOCX-specific
   * structure awareness.
   */
  private extractDocxSectionHeading(): string | undefined {
    try {
      const doc = (this as unknown as { iframe: HTMLIFrameElement }).iframe?.contentDocument
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
