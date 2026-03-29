import type { AnnotationSurface, SurfaceKind } from './types'

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
