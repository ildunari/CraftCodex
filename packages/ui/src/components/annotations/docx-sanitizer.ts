/**
 * docx-sanitizer - Security-critical HTML sanitization for DOCX preview output.
 *
 * docx-preview renders .docx files into raw HTML. That HTML may contain
 * scripts, iframes, forms, or dangerous CSS injected via the document.
 * This module strips everything except a safe allowlist of tags, attributes,
 * and CSS properties using DOMPurify.
 *
 * The sanitized HTML is then wrapped in a minimal HTML document with a
 * strict Content-Security-Policy meta tag for iframe srcDoc rendering.
 *
 * Uses isomorphic-dompurify so the module works in both browser (Electron
 * renderer) and server/test environments (bun test, Node).
 */

import DOMPurifyDefault from 'isomorphic-dompurify'

/**
 * Create a dedicated DOMPurify instance to avoid hook race conditions
 * on the global singleton. isomorphic-dompurify's default export is a
 * Proxy that acts both as the singleton AND as a factory: calling it
 * with a Window argument returns a fresh, isolated DOMPurify instance.
 *
 * In browser/Electron: we use the real `window`.
 * In Node/bun test: we create a JSDOM window.
 *
 * Fallback: if instance creation fails, use the singleton with try/finally
 * around hook manipulation.
 */
let purify: typeof DOMPurifyDefault

function createDedicatedInstance(): typeof DOMPurifyDefault | null {
  const factory = DOMPurifyDefault as unknown as (win: unknown) => typeof DOMPurifyDefault
  try {
    // Browser environment
    if (typeof window !== 'undefined' && window.document) {
      const inst = factory(window)
      if (typeof inst?.addHook === 'function') return inst
    }
  } catch { /* not in browser */ }

  try {
    // Node/test environment — use JSDOM
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require('jsdom')
    const win = new JSDOM('').window
    const inst = factory(win)
    if (typeof inst?.addHook === 'function') return inst
  } catch { /* jsdom not available */ }

  return null
}

purify = createDedicatedInstance() ?? DOMPurifyDefault

const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'strong', 'em',
  'u', 's', 'ol', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'th',
  'td', 'img', 'a', 'blockquote', 'pre', 'code', 'sup', 'sub', 'span',
  'div', 'section', 'header', 'footer', 'figure', 'figcaption',
]

const FORBID_TAGS = ['form', 'iframe', 'object', 'embed', 'meta', 'link', 'script', 'style']

const ALLOWED_ATTR = ['href', 'src', 'alt', 'class', 'colspan', 'rowspan', 'style']

/** CSP meta tag for iframe srcDoc — blocks all external resources except inline styles and data URIs. */
export const DOCX_CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:; form-action \'none\';">'

/**
 * Sanitize HTML produced by docx-preview, stripping dangerous elements and CSS.
 *
 * Hooks are added and removed around the sanitize call so they don't leak
 * into other DOMPurify consumers in the same process.
 */
export function sanitizeDocxHtml(html: string): string {
  // Hook: strip dangerous CSS properties from inline styles.
  // Wrapped in try/finally so the hook is always removed even if sanitize throws.
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style') {
      data.attrValue = data.attrValue
        .replace(/position\s*:\s*(absolute|fixed)/gi, '')
        .replace(/z-index\s*:/gi, '')
        .replace(/background(-image)?\s*:[^;]*url\s*\([^)]*\)[^;]*/gi, 'background:none/*sanitized*/')
    }
  })

  try {
    return purify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      FORBID_TAGS,
      ALLOW_DATA_ATTR: false,
    })
  } finally {
    purify.removeHook('uponSanitizeAttribute')
  }
}

/**
 * Generic HTML sanitization using the same allowlist as DOCX.
 * Suitable for any untrusted HTML content (email previews, HTML blocks, etc.).
 */
export function sanitizeHtml(html: string): string {
  return sanitizeDocxHtml(html)
}

/**
 * Wrap sanitized HTML in a full HTML document suitable for iframe srcDoc.
 * Includes CSP meta tag and optional inline styles (e.g. from docx-preview).
 */
export function wrapInDocxIframe(sanitizedHtml: string, styles?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
${DOCX_CSP_META}
<style>${styles ?? ''}</style>
</head>
<body>${sanitizedHtml}</body>
</html>`
}
