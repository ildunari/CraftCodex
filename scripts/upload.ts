import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_RELEASE_DIR = join(ROOT_DIR, 'apps/electron/release')
const INSTALL_SCRIPT = join(ROOT_DIR, 'scripts/install-app.sh')
const DEFAULT_GITHUB_REPO = 'ildunari/craft-agents-oss'
const DEFAULT_GITHUB_TAG = 'craftcodex-latest'
const DEFAULT_GITHUB_FEED =
  `https://github.com/${DEFAULT_GITHUB_REPO}/releases/download/${DEFAULT_GITHUB_TAG}`

type Provider = 'github' | 's3'

interface UploadOptions {
  electron: boolean
  script: boolean
  dryRun: boolean
  provider: Provider
  prefix: string
  githubRepo: string
  githubTag: string
}

function parseArgs(): UploadOptions {
  const args = new Set(process.argv.slice(2))
  const prefixArg = process.argv.find(arg => arg.startsWith('--prefix='))
  const repoArg = process.argv.find(arg => arg.startsWith('--repo='))
  const tagArg = process.argv.find(arg => arg.startsWith('--tag='))
  const providerArg = process.argv.find(arg => arg.startsWith('--provider='))
  const provider = (providerArg?.slice('--provider='.length) ?? process.env.CRAFTCODEX_UPDATE_PROVIDER ?? 'github') as Provider

  if (provider !== 'github' && provider !== 's3') {
    throw new Error(`Unsupported provider "${provider}". Use "github" or "s3".`)
  }

  return {
    electron: args.has('--electron'),
    script: args.has('--script'),
    dryRun: args.has('--dry-run'),
    provider,
    prefix: prefixArg?.slice('--prefix='.length)
      ?? process.env.CRAFTCODEX_UPDATE_UPLOAD_PREFIX
      ?? 'electron/craftcodex/latest',
    githubRepo: repoArg?.slice('--repo='.length)
      ?? process.env.CRAFTCODEX_GITHUB_REPO
      ?? DEFAULT_GITHUB_REPO,
    githubTag: tagArg?.slice('--tag='.length)
      ?? process.env.CRAFTCODEX_GITHUB_TAG
      ?? DEFAULT_GITHUB_TAG,
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function contentTypeFor(fileName: string): string {
  if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) return 'application/yaml'
  if (fileName.endsWith('.json')) return 'application/json'
  if (fileName.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (fileName.endsWith('.zip')) return 'application/zip'
  if (fileName.endsWith('.blockmap')) return 'application/octet-stream'
  if (fileName.endsWith('.sh')) return 'text/x-shellscript'
  return 'application/octet-stream'
}

function candidateElectronFiles(): string[] {
  return [
    'latest-mac.yml',
    'latest.yml',
    'latest-linux.yml',
    'CraftCodex-arm64.dmg',
    'CraftCodex-arm64.dmg.blockmap',
    'CraftCodex-arm64.zip',
    'CraftCodex-arm64.zip.blockmap',
    'CraftCodex-x64.dmg',
    'CraftCodex-x64.dmg.blockmap',
    'CraftCodex-x64.zip',
    'CraftCodex-x64.zip.blockmap',
    'CraftCodex-x64.exe',
    'CraftCodex-x64.exe.blockmap',
    'CraftCodex-x64.AppImage',
    'CraftCodex-x64.AppImage.blockmap',
  ].map(file => join(ELECTRON_RELEASE_DIR, file)).filter(existsSync)
}

async function run(cmd: string[], dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] ${cmd.map(part => JSON.stringify(part)).join(' ')}`)
    return
  }

  const proc = Bun.spawn({ cmd, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}`)
  }
}

async function ensureGithubRelease(repo: string, tag: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] ensure GitHub release ${repo}@${tag}`)
    return
  }

  const view = Bun.spawn({
    cmd: ['gh', 'release', 'view', tag, '--repo', repo],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await view.exited
  if (code === 0) return

  await run([
    'gh',
    'release',
    'create',
    tag,
    '--repo',
    repo,
    '--title',
    'CraftCodex Latest',
    '--notes',
    'Mutable Electron update feed for composed CraftCodex builds.',
    '--latest=false',
  ], false)
}

async function uploadGithub(files: Array<{ path: string; keyName: string }>, options: UploadOptions): Promise<void> {
  await ensureGithubRelease(options.githubRepo, options.githubTag, options.dryRun)

  const paths = files.map(file => file.path)
  await run([
    'gh',
    'release',
    'upload',
    options.githubTag,
    ...paths,
    '--repo',
    options.githubRepo,
    '--clobber',
  ], options.dryRun)

  const feedUrl = `https://github.com/${options.githubRepo}/releases/download/${options.githubTag}`
  console.log(`\nCraftCodex update feed: ${feedUrl}`)
  console.log('This feed is used by the app default and can also be baked as CRAFTCODEX_UPDATE_FEED_URL.')
}

async function uploadS3File(client: S3Client, bucket: string, filePath: string, key: string, dryRun: boolean): Promise<void> {
  const body = readFileSync(filePath)
  const contentType = contentTypeFor(filePath)
  if (dryRun) {
    console.log(`[dry-run] ${filePath} -> s3://${bucket}/${key} (${contentType}, ${body.length} bytes)`)
    return
  }

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }))
  console.log(`uploaded ${key}`)
}

async function uploadS3(files: Array<{ path: string; keyName: string }>, options: UploadOptions): Promise<void> {
  const bucket = process.env.S3_VERSIONS_BUCKET_NAME || process.env.S3_VERSIONS_BUCKET
  if (!bucket) {
    throw new Error('Missing required environment variable: S3_VERSIONS_BUCKET_NAME or S3_VERSIONS_BUCKET')
  }

  const endpoint = requireEnv('S3_VERSIONS_BUCKET_ENDPOINT')
  const accessKeyId = requireEnv('S3_VERSIONS_BUCKET_ACCESS_KEY_ID')
  const secretAccessKey = requireEnv('S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY')
  const region = process.env.S3_VERSIONS_BUCKET_REGION || 'auto'
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '')

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })

  for (const file of files) {
    await uploadS3File(client, bucket, file.path, `${prefix}/${file.keyName}`, options.dryRun)
  }

  const publicBase = (process.env.S3_VERSIONS_PUBLIC_BASE_URL || 'https://updates.example.com').replace(/\/+$/g, '')
  console.log(`\nCraftCodex update feed: ${publicBase}/${prefix}`)
  console.log('Bake or export it as CRAFTCODEX_UPDATE_FEED_URL for S3-backed update-enabled builds.')
}

async function main(): Promise<void> {
  const options = parseArgs()
  if (!options.electron && !options.script) {
    throw new Error('Nothing to upload. Pass --electron and/or --script.')
  }

  const files: Array<{ path: string; keyName: string }> = []
  if (options.electron) {
    for (const path of candidateElectronFiles()) {
      files.push({ path, keyName: basename(path) })
    }
  }
  if (options.script) {
    files.push({ path: INSTALL_SCRIPT, keyName: 'install-app.sh' })
  }
  if (files.length === 0) {
    throw new Error(`No upload artifacts found in ${ELECTRON_RELEASE_DIR}`)
  }

  if (options.provider === 'github') {
    await uploadGithub(files, options)
  } else {
    await uploadS3(files, options)
  }

  if (options.provider === 'github' && options.githubRepo === DEFAULT_GITHUB_REPO && options.githubTag === DEFAULT_GITHUB_TAG) {
    console.log(`Default app feed: ${DEFAULT_GITHUB_FEED}`)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
