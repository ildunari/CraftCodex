import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

/**
 * Tests for useAnnotationToast logic.
 *
 * Since bun:test doesn't provide a DOM or React rendering, we test the
 * core timer/state logic by reimplementing the hook's algorithm in plain TS.
 * The React component itself is thin enough to be covered by integration tests.
 */

// ---------------------------------------------------------------------------
// Minimal hook-logic mirror (no React dependency)
// ---------------------------------------------------------------------------

/** Configurable duration so tests can use short timeouts */
class ToastState {
  message: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly duration: number

  constructor(duration = 3000) {
    this.duration = duration
  }

  showToast(msg: string) {
    if (this.timer) clearTimeout(this.timer)
    this.message = msg
    this.timer = setTimeout(() => {
      this.message = null
      this.timer = null
    }, this.duration)
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAnnotationToast (logic)', () => {
  let state: ToastState

  beforeEach(() => {
    // Use 500ms duration for fast tests (real hook uses 3000ms)
    state = new ToastState(500)
  })

  afterEach(() => {
    state.destroy()
  })

  it('starts with null message', () => {
    expect(state.message).toBeNull()
  })

  it('sets message after showToast', () => {
    state.showToast('Copied!')
    expect(state.message).toBe('Copied!')
  })

  it('replaces message on rapid successive calls', () => {
    state.showToast('First')
    state.showToast('Second')
    expect(state.message).toBe('Second')
  })

  it('auto-clears after timeout', async () => {
    state.showToast('Will vanish')
    expect(state.message).toBe('Will vanish')

    // Wait for the 500ms timeout + buffer
    await new Promise((r) => setTimeout(r, 650))
    expect(state.message).toBeNull()
  })

  it('resets timer when showToast called again before expiry', async () => {
    state.showToast('First')

    // Wait 300ms (before 500ms expiry), then show again — timer resets
    await new Promise((r) => setTimeout(r, 300))
    state.showToast('Second')
    expect(state.message).toBe('Second')

    // After another 300ms (600ms total), should still be visible because timer was reset at 300ms
    await new Promise((r) => setTimeout(r, 300))
    expect(state.message).toBe('Second')

    // After 550ms from second call (850ms total), should be cleared
    await new Promise((r) => setTimeout(r, 250))
    expect(state.message).toBeNull()
  })
})
