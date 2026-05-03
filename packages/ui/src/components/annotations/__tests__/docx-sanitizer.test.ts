import { describe, it, expect } from 'vitest'
import { sanitizeDocxHtml, wrapInDocxIframe, DOCX_CSP_META } from '../docx-sanitizer'

describe('sanitizeDocxHtml', () => {
  it('preserves safe structural tags', () => {
    const html = '<p>Hello <strong>world</strong></p><h1>Title</h1>'
    const result = sanitizeDocxHtml(html)
    expect(result).toContain('<p>')
    expect(result).toContain('<strong>')
    expect(result).toContain('<h1>')
  })

  it('preserves tables', () => {
    const html = '<table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>'
    const result = sanitizeDocxHtml(html)
    expect(result).toContain('<table>')
    expect(result).toContain('<th>')
    expect(result).toContain('<td>')
  })

  it('preserves allowed attributes', () => {
    const html = '<a href="https://example.com">Link</a><img src="data:image/png;base64,abc" alt="pic">'
    const result = sanitizeDocxHtml(html)
    expect(result).toContain('href="https://example.com"')
    expect(result).toContain('alt="pic"')
  })

  it('preserves colspan and rowspan', () => {
    const html = '<table><tbody><tr><td colspan="2" rowspan="3">Merged</td></tr></tbody></table>'
    const result = sanitizeDocxHtml(html)
    expect(result).toContain('colspan="2"')
    expect(result).toContain('rowspan="3"')
  })

  it('strips script tags', () => {
    const html = '<p>Safe</p><script>alert("xss")</script>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('<script')
    expect(result).not.toContain('alert')
    expect(result).toContain('<p>Safe</p>')
  })

  it('strips iframe tags', () => {
    const html = '<p>Content</p><iframe src="https://evil.com"></iframe>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('<iframe')
  })

  it('strips form tags', () => {
    const html = '<form action="https://evil.com"><input type="text"></form>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('<form')
    expect(result).not.toContain('<input')
  })

  it('strips object and embed tags', () => {
    const html = '<object data="exploit.swf"></object><embed src="exploit.swf">'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('<object')
    expect(result).not.toContain('<embed')
  })

  it('strips style tags', () => {
    const html = '<style>body { background: red; }</style><p>Content</p>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('<style')
    expect(result).toContain('<p>Content</p>')
  })

  it('strips meta and link tags', () => {
    const html = '<meta http-equiv="refresh" content="0;url=evil.com"><link rel="stylesheet" href="evil.css"><p>OK</p>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('<meta')
    expect(result).not.toContain('<link')
    expect(result).toContain('<p>OK</p>')
  })

  it('strips data-* attributes', () => {
    const html = '<div data-evil="payload" class="safe">Content</div>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('data-evil')
    expect(result).toContain('class="safe"')
  })

  it('strips position:absolute and position:fixed from inline styles', () => {
    const html = '<div style="position: absolute; color: red;">Content</div>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('position')
    expect(result).toContain('color: red')
  })

  it('strips z-index from inline styles', () => {
    const html = '<div style="z-index: 9999; color: blue;">Content</div>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('z-index')
    expect(result).toContain('color: blue')
  })

  it('sanitizes background-image url() in inline styles', () => {
    const html = '<div style="background-image: url(https://evil.com/track.png); color: green;">Content</div>'
    const result = sanitizeDocxHtml(html)
    expect(result).not.toContain('evil.com')
    expect(result).toContain('background:none/*sanitized*/')
  })

  it('handles empty input', () => {
    expect(sanitizeDocxHtml('')).toBe('')
  })

  it('handles input with only forbidden tags', () => {
    const html = '<script>alert(1)</script><style>.x{}</style>'
    const result = sanitizeDocxHtml(html)
    expect(result).toBe('')
  })
})

describe('wrapInDocxIframe', () => {
  it('wraps HTML in a full document with CSP', () => {
    const result = wrapInDocxIframe('<p>Hello</p>')
    expect(result).toContain('<!DOCTYPE html>')
    expect(result).toContain(DOCX_CSP_META)
    expect(result).toContain('<body><p>Hello</p></body>')
  })

  it('includes custom styles when provided', () => {
    const result = wrapInDocxIframe('<p>Hello</p>', 'body { font-size: 14px; }')
    expect(result).toContain('body { font-size: 14px; }')
  })

  it('handles empty styles gracefully', () => {
    const result = wrapInDocxIframe('<p>Hello</p>', '')
    expect(result).toContain('<style></style>')
  })

  it('handles undefined styles', () => {
    const result = wrapInDocxIframe('<p>Hello</p>')
    expect(result).toContain('<style></style>')
  })
})

describe('DOCX_CSP_META', () => {
  it('blocks default-src', () => {
    expect(DOCX_CSP_META).toContain("default-src 'none'")
  })

  it('allows data: and blob: images', () => {
    expect(DOCX_CSP_META).toContain('img-src data: blob:')
  })

  it('allows unsafe-inline styles', () => {
    expect(DOCX_CSP_META).toContain("style-src 'unsafe-inline'")
  })

  it('blocks form submissions', () => {
    expect(DOCX_CSP_META).toContain("form-action 'none'")
  })
})
