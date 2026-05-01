export interface AutoUpdateFeedDecision {
  enabled: boolean
  feedUrl?: string
  reason?: string
}

interface ResolveAutoUpdateFeedOptions {
  appName: string
  env?: NodeJS.ProcessEnv
}

const OFFICIAL_CRAFT_AGENTS_FEED_URL = 'https://agents.craft.do/electron/latest'
export const CRAFTCODEX_GITHUB_RELEASE_FEED_URL =
  'https://github.com/ildunari/craft-agents-oss/releases/download/craftcodex-latest'

/**
 * CraftCodex keeps the updater path, but local/forked builds must not consume
 * the upstream Craft Agents feed. By default it reads a fixed GitHub Release on
 * Kosta's fork, where composed CraftCodex builds are published.
 */
export function resolveAutoUpdateFeedDecision({
  appName,
  env = process.env,
}: ResolveAutoUpdateFeedOptions): AutoUpdateFeedDecision {
  const explicitFeedUrl = env.CRAFTCODEX_UPDATE_FEED_URL || env.CRAFT_UPDATE_FEED_URL
  if (explicitFeedUrl) {
    return { enabled: true, feedUrl: explicitFeedUrl }
  }

  const isCraftCodex = appName.toLowerCase().replace(/\s+/g, '').includes('craftcodex')

  if (isCraftCodex) {
    return { enabled: true, feedUrl: CRAFTCODEX_GITHUB_RELEASE_FEED_URL }
  }

  return { enabled: true, feedUrl: OFFICIAL_CRAFT_AGENTS_FEED_URL }
}
