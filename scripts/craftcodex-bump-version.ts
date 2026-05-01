import { existsSync, readFileSync, writeFileSync } from 'fs'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: bun scripts/craftcodex-bump-version.ts <semver>')
  process.exit(1)
}

for (const path of ['package.json', 'apps/electron/package.json']) {
  if (!existsSync(path)) continue
  const json = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
  json.version = version
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
  console.log(`set ${path} version to ${version}`)
}
