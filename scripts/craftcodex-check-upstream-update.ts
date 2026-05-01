const OFFICIAL_FEED_URL = 'https://agents.craft.do/electron/latest/latest-mac.yml'
const CRAFTCODEX_FEED_URL =
  'https://github.com/ildunari/craft-agents-oss/releases/download/craftcodex-latest/latest-mac.yml'

function parseVersion(yaml: string): string | null {
  const match = yaml.match(/^version:\s*['"]?([^'"\n\r]+)['"]?/m)
  return match?.[1]?.trim() ?? null
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(part => Number.parseInt(part, 10) || 0)
  const bParts = b.split('.').map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (aParts[index] ?? 0) - (bParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CraftCodex-Upstream-Monitor' },
  })
  if (!response.ok) return null
  return response.text()
}

async function main(): Promise<void> {
  const officialYaml = await fetchText(process.env.CRAFT_OFFICIAL_FEED_URL ?? OFFICIAL_FEED_URL)
  if (!officialYaml) throw new Error('Could not fetch official Craft Agents update feed')

  const officialVersion = parseVersion(officialYaml)
  if (!officialVersion) throw new Error('Could not parse official Craft Agents version')

  const craftCodexYaml = await fetchText(process.env.CRAFTCODEX_FEED_URL ?? CRAFTCODEX_FEED_URL)
  const craftCodexVersion = craftCodexYaml ? parseVersion(craftCodexYaml) : '0.0.0'
  const updateAvailable = compareVersions(officialVersion, craftCodexVersion ?? '0.0.0') > 0

  const outputs = {
    official_version: officialVersion,
    craftcodex_version: craftCodexVersion ?? '0.0.0',
    update_available: String(updateAvailable),
    upstream_tag: `v${officialVersion}`,
  }

  for (const [key, value] of Object.entries(outputs)) {
    console.log(`${key}=${value}`)
  }

  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    await Bun.write(
      githubOutput,
      Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
    )
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
