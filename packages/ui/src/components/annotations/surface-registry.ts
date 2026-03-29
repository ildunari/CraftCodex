import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api'
import type { AnnotationSurface, SurfaceKind } from './types'
import { PdfAnnotationSurface } from './PdfAnnotationSurface'
import { HtmlAnnotationSurface } from './HtmlAnnotationSurface'

type SurfaceFactory = (...args: unknown[]) => AnnotationSurface

const registry = new Map<SurfaceKind, SurfaceFactory>()

/** Register a factory for a surface kind. Overwrites any previous registration. */
export function registerSurface(kind: SurfaceKind, factory: SurfaceFactory): void {
  registry.set(kind, factory)
}

/** Create a surface instance by kind. Returns null if no factory is registered. */
export function createSurface(kind: SurfaceKind, ...args: unknown[]): AnnotationSurface | null {
  const factory = registry.get(kind)
  return factory ? factory(...args) : null
}

/** List all registered surface kinds. */
export function getSupportedKinds(): SurfaceKind[] {
  return Array.from(registry.keys())
}

/** Remove a surface registration (mainly for testing). */
export function unregisterSurface(kind: SurfaceKind): boolean {
  return registry.delete(kind)
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------

// Register the PDF surface factory.
// Usage: createSurface('pdf', container, getPage, fileName?)
registerSurface('pdf', (container, getPage, fileName) =>
  new PdfAnnotationSurface(
    container as HTMLElement,
    getPage as (pageNumber: number) => Promise<PDFPageProxy>,
    fileName as string | undefined,
  ),
)

// Register the HTML surface factory.
// Usage: createSurface('html', iframe, fileName?)
registerSurface('html', (iframe, fileName) =>
  new HtmlAnnotationSurface(
    iframe as HTMLIFrameElement,
    fileName as string | undefined,
  ),
)
