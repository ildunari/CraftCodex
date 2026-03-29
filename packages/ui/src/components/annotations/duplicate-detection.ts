import type { AnnotationV1 } from '@craft-agent/core'
import type { SurfaceSelection, AnnotationDocumentMeta } from './types'

/** Normalize text for comparison: collapse whitespace, lowercase, trim. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Surface-aware duplicate detection.
 *
 * Replaces the legacy hasExistingTextRangeAnnotation which only checked
 * exact text-position start/end pairs. This version works across surface
 * types by checking: surface kind, page/slide scope, attachmentId, and
 * normalized quote match.
 */
export function isDuplicateAnnotation(
  existing: AnnotationV1[] | undefined,
  newSelection: SurfaceSelection,
  surfaceKind: string,
  sourceFile?: string,
): boolean {
  if (!existing?.length) return false

  const normalizedNew = normalize(newSelection.selectedText)
  if (!normalizedNew) return false

  return existing.some(ann => {
    // Skip deleted annotations
    if (ann.deletedAt) return false

    const docMeta = ann.meta?.document as AnnotationDocumentMeta | undefined

    // For markdown annotations without document meta, fall back to legacy comparison
    if (!docMeta && surfaceKind === 'markdown' && newSelection.scope.kind === 'markdown') {
      const pos = ann.target.selectors.find(s => s.type === 'text-position') as
        | { type: 'text-position'; start: number; end: number }
        | undefined
      if (pos && pos.start === newSelection.scope.start && pos.end === newSelection.scope.end) {
        return true
      }
    }

    // Surface kind must match
    if (docMeta?.kind !== surfaceKind) return false

    // Attachment scope must match (if provided)
    if (sourceFile && (ann.meta?.attachmentId as string | undefined) !== sourceFile) return false

    // Page/slide scope must match
    if (docMeta.kind === 'pdf' && newSelection.scope.kind === 'pdf') {
      if (docMeta.page !== newSelection.scope.pageNumber) return false
    } else if (docMeta.kind === 'pptx' && newSelection.scope.kind === 'pptx') {
      if (docMeta.slide !== newSelection.scope.slideNumber) return false
    }

    // Normalized quote match
    const existingQuote = ann.target.selectors.find(s => s.type === 'text-quote') as
      | { type: 'text-quote'; exact: string }
      | undefined
    if (!existingQuote) return false

    return normalize(existingQuote.exact) === normalizedNew
  })
}
