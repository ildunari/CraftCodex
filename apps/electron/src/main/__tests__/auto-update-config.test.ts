import { describe, expect, it } from 'bun:test'
import {
  CRAFTCODEX_GITHUB_RELEASE_FEED_URL,
  resolveAutoUpdateFeedDecision,
} from '../auto-update-config'

describe('resolveAutoUpdateFeedDecision', () => {
  it('uses Kosta fork GitHub Releases for CraftCodex builds by default', () => {
    const decision = resolveAutoUpdateFeedDecision({
      appName: 'CraftCodex',
      env: {},
    })

    expect(decision).toEqual({
      enabled: true,
      feedUrl: CRAFTCODEX_GITHUB_RELEASE_FEED_URL,
    })
  })

  it('enables CraftCodex updates when a feed override is configured', () => {
    const decision = resolveAutoUpdateFeedDecision({
      appName: 'CraftCodex',
      env: { CRAFTCODEX_UPDATE_FEED_URL: 'https://updates.example.com/craftcodex/latest' },
    })

    expect(decision).toEqual({
      enabled: true,
      feedUrl: 'https://updates.example.com/craftcodex/latest',
    })
  })

  it('keeps the official feed available for the upstream app name', () => {
    const decision = resolveAutoUpdateFeedDecision({
      appName: 'Craft Agents',
      env: {},
    })

    expect(decision).toEqual({
      enabled: true,
      feedUrl: 'https://agents.craft.do/electron/latest',
    })
  })

  it('keeps CraftCodex off the official feed even when old opt-in env is present', () => {
    const decision = resolveAutoUpdateFeedDecision({
      appName: 'CraftCodex',
      env: { CRAFT_ALLOW_OFFICIAL_UPDATE_FEED: '1' },
    })

    expect(decision).toEqual({
      enabled: true,
      feedUrl: CRAFTCODEX_GITHUB_RELEASE_FEED_URL,
    })
  })
})
