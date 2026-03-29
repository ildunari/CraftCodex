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

import DOMPurify from 'isomorphic-dompurify'

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
  // Hook: strip dangerous CSS properties from inline styles
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style') {
      data.attrValue = data.attrValue
        .replace(/position\s*:\s*(absolute|fixed)/gi, '')
        .replace(/z-index\s*:/gi, '')
        .replace(/background(-image)?\s*:[^;]*url\s*\([^)]*\)[^;]*/gi, 'background:none/*sanitized*/')
    }
  })

  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    ALLOW_DATA_ATTR: false,
  })

  DOMPurify.removeHook('uponSanitizeAttribute')
  return clean
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
