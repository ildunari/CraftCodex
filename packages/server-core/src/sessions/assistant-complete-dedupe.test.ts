import { describe, expect, it } from 'bun:test'
import type { AgentEvent, Message } from '@craft-agent/core/types'

import { shouldSkipDuplicateAssistantComplete } from './SessionManager.ts'

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Final answer',
    timestamp: 1,
    ...overrides,
  }
}

function textComplete(overrides: Partial<Extract<AgentEvent, { type: 'text_complete' }>> = {}): Extract<AgentEvent, { type: 'text_complete' }> {
  return {
    type: 'text_complete',
    text: 'Final answer',
    ...overrides,
  }
}

describe('shouldSkipDuplicateAssistantComplete', () => {
  it('skips duplicate final output for the same turn', () => {
    const messages = [assistantMessage({ turnId: 'turn-1', isIntermediate: false })]

    expect(shouldSkipDuplicateAssistantComplete(
      messages,
      textComplete({ turnId: 'turn-1', isIntermediate: false }),
    )).toBe(true)
  })

  it('keeps intermediate and final messages separate', () => {
    const messages = [assistantMessage({ turnId: 'turn-1', isIntermediate: true })]

    expect(shouldSkipDuplicateAssistantComplete(
      messages,
      textComplete({ turnId: 'turn-1', isIntermediate: false }),
    )).toBe(false)
  })

  it('allows the same final text in a different explicit turn', () => {
    const messages = [assistantMessage({ turnId: 'turn-1', isIntermediate: false })]

    expect(shouldSkipDuplicateAssistantComplete(
      messages,
      textComplete({ turnId: 'turn-2', isIntermediate: false }),
    )).toBe(false)
  })

  it('skips adjacent duplicate final output when no turn id is available', () => {
    const messages = [assistantMessage({ content: 'Final   answer', isIntermediate: false })]

    expect(shouldSkipDuplicateAssistantComplete(
      messages,
      textComplete({ text: 'Final answer', isIntermediate: false }),
    )).toBe(true)
  })
})
