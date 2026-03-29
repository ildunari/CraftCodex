import type { FollowUpContext, SurfaceKind } from './types'

/** Maximum quote length in assembled follow-up (chars). */
const MAX_QUOTE_LENGTH = 2000
/** Maximum surrounding text length (chars). */
const MAX_SURROUNDING_TEXT_LENGTH = 1000

/** Escape markdown metacharacters to prevent injection. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([>*_`\[\]#~\\|!()\-+])/g, '\\$1')
}

/** Truncate text to max length with ellipsis. */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trimEnd()}…`
}

export interface FollowUpFormatter {
  formatQuote(text: string, context: FollowUpContext): string
  formatAttribution(context: FollowUpContext): string
}

// ---------------------------------------------------------------------------
// Built-in formatters
// ---------------------------------------------------------------------------

const markdownFormatter: FollowUpFormatter = {
  formatQuote(text: string, _context: FollowUpContext): string {
    return truncate(escapeMarkdown(text), MAX_QUOTE_LENGTH)
  },
  formatAttribution(_context: FollowUpContext): string {
    // Markdown annotations have no special attribution (matches current behavior)
    return ''
  },
}

const pdfFormatter: FollowUpFormatter = {
  formatQuote(text: string, _context: FollowUpContext): string {
    return truncate(escapeMarkdown(text), MAX_QUOTE_LENGTH)
  },
  formatAttribution(context: FollowUpContext): string {
    const parts: string[] = []
    if (context.fileName) parts.push(context.fileName)
    if (context.pageOrSlide != null) parts.push(`Page ${context.pageOrSlide}`)
    if (context.sectionHeading) parts.push(`"${context.sectionHeading}"`)
    return parts.length > 0 ? `— ${parts.join(', ')}` : ''
  },
}

const htmlFormatter: FollowUpFormatter = {
  formatQuote(text: string, _context: FollowUpContext): string {
    return truncate(escapeMarkdown(text), MAX_QUOTE_LENGTH)
  },
  formatAttribution(context: FollowUpContext): string {
    const parts: string[] = []
    if (context.fileName) parts.push(context.fileName)
    if (context.sectionHeading) parts.push(`"${context.sectionHeading}"`)
    return parts.length > 0 ? `— ${parts.join(', ')}` : ''
  },
}

const docxFormatter: FollowUpFormatter = {
  formatQuote(text: string, _context: FollowUpContext): string {
    return truncate(escapeMarkdown(text), MAX_QUOTE_LENGTH)
  },
  formatAttribution(context: FollowUpContext): string {
    const parts: string[] = []
    if (context.fileName) parts.push(context.fileName)
    if (context.sectionHeading) parts.push(`Section "${context.sectionHeading}"`)
    if (context.pageOrSlide != null) parts.push(`Page ${context.pageOrSlide}`)
    return parts.length > 0 ? `— ${parts.join(', ')}` : ''
  },
}

const pptxFormatter: FollowUpFormatter = {
  formatQuote(text: string, _context: FollowUpContext): string {
    return truncate(escapeMarkdown(text), MAX_QUOTE_LENGTH)
  },
  formatAttribution(context: FollowUpContext): string {
    const parts: string[] = []
    if (context.fileName) parts.push(context.fileName)
    if (context.pageOrSlide != null) parts.push(`Slide ${context.pageOrSlide}`)
    if (context.sectionHeading) parts.push(`"${context.sectionHeading}"`)
    return parts.length > 0 ? `— ${parts.join(', ')}` : ''
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const formatters = new Map<SurfaceKind, FollowUpFormatter>([
  ['markdown', markdownFormatter],
  ['pdf', pdfFormatter],
  ['html', htmlFormatter],
  ['docx', docxFormatter],
  ['pptx', pptxFormatter],
])

/** Get the formatter for a surface kind. Falls back to markdown formatter. */
export function getFormatter(kind: SurfaceKind | string): FollowUpFormatter {
  return formatters.get(kind as SurfaceKind) ?? markdownFormatter
}

/** Register a custom formatter (for extensibility). */
export function registerFormatter(kind: SurfaceKind, formatter: FollowUpFormatter): void {
  formatters.set(kind, formatter)
}

/** Cap surrounding text to safe length. */
export function capSurroundingText(text: string): string {
  return truncate(text, MAX_SURROUNDING_TEXT_LENGTH)
}

/**
 * Format selected text + attribution as a plain-text quote for clipboard.
 *
 * Output:  "selected text"\n\n— filename, Section "heading", Page N
 */
export function formatCopyAsQuote(
  selectedText: string,
  context: FollowUpContext,
): string {
  const quoted = `\u201c${truncate(selectedText, MAX_QUOTE_LENGTH)}\u201d`
  const formatter = getFormatter(context.documentType)
  const attribution = formatter.formatAttribution(context)
  return attribution ? `${quoted}\n\n${attribution}` : quoted
}
