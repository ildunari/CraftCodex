import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelDefinition } from '@craft-agent/shared/config'

export interface FactoryDroidModelConfig {
  models: ModelDefinition[]
  defaultModel?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function customModelId(entry: Record<string, unknown>): string | undefined {
  const explicitId = asString(entry.id)
  if (explicitId?.startsWith('custom:')) return explicitId
  const model = asString(entry.model)
  if (!model) return undefined
  return model.startsWith('custom:') ? model : `custom:${model}`
}

function normalizeFactoryDroidModel(entry: unknown): ModelDefinition | null {
  const raw = asRecord(entry)
  if (!raw) return null
  const id = customModelId(raw)
  if (!id) return null
  const model = asString(raw.model) ?? id.replace(/^custom:/, '')
  const name = asString(raw.displayName) ?? asString(raw.name) ?? model
  const provider = asString(raw.provider)
  const contextWindow = asNumber(raw.maxContextLimit) ?? asNumber(raw.contextWindow) ?? 128_000
  return {
    id,
    name,
    shortName: name,
    description: provider ? `Factory BYOK (${provider})` : 'Factory BYOK custom model',
    provider: 'acp',
    contextWindow,
    supportsThinking: true,
  }
}

export function parseFactoryDroidModelConfig(settings: unknown): FactoryDroidModelConfig {
  const root = asRecord(settings)
  if (!root) return { models: [] }

  const customModels = Array.isArray(root.customModels) ? root.customModels : []
  const models = customModels
    .map(normalizeFactoryDroidModel)
    .filter((model): model is ModelDefinition => !!model)

  return {
    models,
    defaultModel: asString(root.model)
      ?? asString(asRecord(root.sessionDefaultSettings)?.model)
      ?? asString(asRecord(root.missionModelSettings)?.workerModel),
  }
}

export function mergeFactoryDroidModelConfigs(configs: FactoryDroidModelConfig[]): FactoryDroidModelConfig {
  const models: ModelDefinition[] = []
  const seen = new Set<string>()
  let defaultModel: string | undefined

  for (const config of configs) {
    if (config.defaultModel) defaultModel = config.defaultModel
    for (const model of config.models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }

  return { models, defaultModel }
}

export function loadFactoryDroidModelConfig(factoryDir = join(homedir(), '.factory')): FactoryDroidModelConfig {
  const paths = [
    join(factoryDir, 'settings.json'),
    join(factoryDir, 'settings.local.json'),
  ]
  const configs: FactoryDroidModelConfig[] = []

  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      configs.push(parseFactoryDroidModelConfig(JSON.parse(readFileSync(path, 'utf-8'))))
    } catch {
      // Invalid Factory settings should not break Craft agent setup.
    }
  }

  return mergeFactoryDroidModelConfigs(configs)
}

export function mergeDroidModels(
  baseModels: Array<ModelDefinition | string> | undefined,
  localModels: Array<ModelDefinition | string>,
): Array<ModelDefinition | string> {
  const merged: Array<ModelDefinition | string> = []
  const seen = new Set<string>()

  for (const model of baseModels ?? []) {
    const id = typeof model === 'string' ? model : model.id
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(model)
  }

  for (const model of localModels) {
    const id = typeof model === 'string' ? model : model.id
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(model)
  }

  return merged
}
