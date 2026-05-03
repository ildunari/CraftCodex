/**
 * AnnotationToast — Lightweight toast for annotation overlays.
 *
 * Each overlay manages its own toast state via the useAnnotationToast() hook.
 * No global provider needed. The toast renders fixed at the bottom of its
 * nearest positioned ancestor (the overlay container) and auto-dismisses
 * after 3 seconds with a fade animation.
 */

import * as React from 'react'

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAnnotationToastReturn {
  message: string | null
  showToast: (message: string) => void
  ToastElement: React.ReactNode
}

/**
 * Provides per-overlay toast state. Call `showToast(msg)` to display a
 * message; it auto-dismisses after 3 s. Render `ToastElement` inside
 * your overlay's positioned container.
 */
export function useAnnotationToast(): UseAnnotationToastReturn {
  const [message, setMessage] = React.useState<string | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = React.useCallback((msg: string) => {
    // Clear any existing timer so rapid calls restart the countdown
    if (timerRef.current) clearTimeout(timerRef.current)
    setMessage(msg)
    timerRef.current = setTimeout(() => {
      setMessage(null)
      timerRef.current = null
    }, 3000)
  }, [])

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const ToastElement = message ? <AnnotationToast message={message} /> : null

  return { message, showToast, ToastElement }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AnnotationToastProps {
  message: string
}

export function AnnotationToast({ message }: AnnotationToastProps) {
  const [visible, setVisible] = React.useState(false)

  // Trigger enter animation on mount
  React.useEffect(() => {
    // rAF ensures the initial opacity:0 is painted before we transition to 1
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none"
      style={{
        opacity: visible ? 1 : 0,
        transform: `translateX(-50%) translateY(${visible ? '0' : '8px'})`,
        transition: 'opacity 200ms ease-out, transform 200ms ease-out',
      }}
    >
      <div className="px-4 py-2 rounded-lg bg-foreground/10 backdrop-blur-xl text-sm text-foreground/80 shadow-minimal whitespace-nowrap">
        {message}
      </div>
    </div>
  )
}
