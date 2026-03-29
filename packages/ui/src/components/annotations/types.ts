import type { AnnotationV1 } from '@craft-agent/core'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Selection scope — discriminated union per surface kind
// ---------------------------------------------------------------------------

export type SelectionScope =
  | { kind: 'markdown'; start: number; end: number }
  | { kind: 'pdf'; pageNumber: number; itemRunHash?: string }
  | { kind: 'docx'; pageNumber?: number; sectionPath?: string[] }
  | { kind: 'html'; cssSelector?: string }
  | { kind: 'pptx'; slideNumber: number }

// ---------------------------------------------------------------------------
// Surface selection — what the user selected in a document surface
// ---------------------------------------------------------------------------

export interface SurfaceSelection {
  selectedText: string
  prefix: string
  suffix: string
  scope: SelectionScope
}

// ---------------------------------------------------------------------------
// Follow-up context — contextual info sent alongside a follow-up question
// ---------------------------------------------------------------------------

export interface FollowUpContext {
  fileName?: string
  pageOrSlide?: number
  sectionHeading?: string
  /** ~500 chars around the selection for grounding */
  surroundingText: string
  documentType: string
}

// ---------------------------------------------------------------------------
// Resolved annotation — result of anchoring an annotation to the DOM
// ---------------------------------------------------------------------------

export interface ResolvedAnnotation {
  rects: DOMRect[]
  isValid: boolean
  failureReason?: 'quote-not-found' | 'page-missing' | 'surface-unavailable'
}

// ---------------------------------------------------------------------------
// Core interface — every annotation surface implements this
// ---------------------------------------------------------------------------

export interface AnnotationSurface {
  readonly kind: SurfaceKind
  captureSelection(): SurfaceSelection | null
  restoreSelection(sel: SurfaceSelection): void
  getSelectionRects(sel: SurfaceSelection): DOMRect[]
  resolveAnnotation(annotation: AnnotationV1): ResolvedAnnotation | null
  getFollowUpContext(sel: SurfaceSelection): FollowUpContext
  setRenderedAnnotations(annotations: AnnotationV1[]): void
  /** Subscribe to geometry changes (resize, scroll, reflow). Returns cleanup fn. */
  observeGeometryInvalidation(cb: () => void): () => void
}

// ---------------------------------------------------------------------------
// Surface kind — extracted from the interface for use in registries
// ---------------------------------------------------------------------------

export type SurfaceKind = 'markdown' | 'html' | 'pdf' | 'docx' | 'pptx'

// ---------------------------------------------------------------------------
// Zod schema for annotation.meta.document validation
// ---------------------------------------------------------------------------

export const AnnotationDocumentMetaSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('markdown'),
    title: z.string().optional(),
    sectionPath: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('pdf'),
    title: z.string().optional(),
    page: z.number(),
    pageLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal('docx'),
    title: z.string().optional(),
    page: z.number().optional(),
    sectionPath: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('pptx'),
    title: z.string().optional(),
    slide: z.number(),
    slideTitle: z.string().optional(),
  }),
  z.object({
    kind: z.literal('html'),
    title: z.string().optional(),
    sectionPath: z.array(z.string()).optional(),
  }),
])

export type AnnotationDocumentMeta = z.infer<typeof AnnotationDocumentMetaSchema>
