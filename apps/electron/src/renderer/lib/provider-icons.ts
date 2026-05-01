/**
 * Provider Icons
 *
 * Maps LLM provider types and base URLs to their respective brand icons.
 * Used in AI Settings page and anywhere connection logos are needed.
 */

import awsIcon from '@/assets/provider-icons/aws.svg'
import azureIcon from '@/assets/provider-icons/azure.svg'
import acpIcon from '@/assets/provider-icons/acp.svg'
import claudeIcon from '@/assets/provider-icons/claude.svg'
import codexIcon from '@/assets/provider-icons/codex.svg'
import copilotIcon from '@/assets/provider-icons/copilot.svg'
import droidIcon from '@/assets/provider-icons/droid.svg'
import googleIcon from '@/assets/provider-icons/google.svg'
import hermesIcon from '@/assets/provider-icons/hermes.svg'
import huggingfaceIcon from '@/assets/provider-icons/huggingface.svg'
import kimiIcon from '@/assets/provider-icons/kimi.svg'
import minimaxIcon from '@/assets/provider-icons/minimax.svg'
import mistralIcon from '@/assets/provider-icons/mistral.svg'
import ollamaIcon from '@/assets/provider-icons/ollama.svg'
import openaiIcon from '@/assets/provider-icons/openai.svg'
import openclawIcon from '@/assets/provider-icons/openclaw.svg'
import openrouterIcon from '@/assets/provider-icons/openrouter.svg'
import piAgentIcon from '@/assets/provider-icons/pi-agent.svg'
import piIcon from '@/assets/provider-icons/pi.svg'
import vercelIcon from '@/assets/provider-icons/vercel.svg'

import type { LlmProviderType } from '@craft-agent/shared/config/llm-connections'

/**
 * Icon URLs for each provider
 */
export const providerIcons = {
  anthropic: claudeIcon,
  acp: acpIcon,
  aws: awsIcon,
  azure: azureIcon,
  codex: codexIcon,
  copilot: copilotIcon,
  droid: droidIcon,
  factory: droidIcon,
  google: googleIcon,
  hermes: hermesIcon,
  huggingface: huggingfaceIcon,
  kimi: kimiIcon,
  minimax: minimaxIcon,
  mistral: mistralIcon,
  ollama: ollamaIcon,
  openai: openaiIcon,
  openclaw: openclawIcon,
  openrouter: openrouterIcon,
  pi: piIcon,
  pi_agent: piAgentIcon,
  vercel: vercelIcon,
} as const

export type ProviderIconKey = keyof typeof providerIcons

/** Human-readable provider names */
const providerDisplayNames: Record<string, string> = {
  anthropic: 'Anthropic',
  anthropic_compat: 'Anthropic',
  openai: 'OpenAI',
  openai_compat: 'OpenAI',
  copilot: 'GitHub Copilot',
  kimi: 'Kimi',
  minimax: 'Minimax',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  pi: 'Craft Agents Backend',
  pi_compat: 'Craft Agents Backend',
  codex: 'Codex App Server',
  droid: 'Factory Droid',
  factory: 'Factory Droid',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  acp: 'ACP Gateway',
  vercel: 'Vercel',
}

/** Get a human-readable provider name from provider type and optional base URL */
export function getProviderDisplayName(providerType: string, baseUrl?: string | null): string {
  // Try URL detection first for compat providers
  if (baseUrl) {
    const url = baseUrl.toLowerCase()
    if (url.includes('openrouter.ai')) return 'OpenRouter'
    if (url.includes('ollama')) return 'Ollama'
    if (url.includes('kimi.com')) return 'Kimi'
    if (url.includes('minimax.io') || url.includes('minimaxi.com')) return 'Minimax'
    if (url.includes('v0.dev') || url.includes('vercel')) return 'Vercel'
  }
  return providerDisplayNames[providerType] || providerType
}

/**
 * Detect provider from base URL
 */
function detectProviderFromUrl(baseUrl: string): ProviderIconKey | null {
  const url = baseUrl.toLowerCase()

  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('ollama')) return 'ollama'
  if (url.includes('api.anthropic.com')) return 'anthropic'
  if (url.includes('api.openai.com')) return 'openai'
  if (url.includes('v0.dev') || url.includes('vercel')) return 'vercel'
  if (url.includes('generativelanguage.googleapis.com') || url.includes('ai.google')) return 'google'
  if (url.includes('kimi.com')) return 'kimi'
  if (url.includes('minimax.io') || url.includes('minimaxi.com')) return 'minimax'
  if (url.includes('mistral.ai')) return 'mistral'
  if (url.includes('bedrock')) return 'aws'
  if (url.includes('huggingface.co')) return 'huggingface'

  return null
}

function detectAgentIconFromName(name?: string | null): ProviderIconKey | null {
  const normalized = name?.toLowerCase() ?? ''
  if (!normalized) return null
  if (normalized.includes('droid') || normalized.includes('factory')) return 'droid'
  if (normalized.includes('hermes')) return 'hermes'
  if (normalized.includes('openclaw') || normalized.includes('open claw')) return 'openclaw'
  return null
}

function detectAgentIconFromId(agentId?: string | null): ProviderIconKey | null {
  switch (agentId) {
    case 'codex':
      return 'codex'
    case 'droid':
      return 'droid'
    case 'hermes':
      return 'hermes'
    case 'pi':
      return 'pi_agent'
    case 'claude':
      return 'anthropic'
    default:
      return null
  }
}

/**
 * Map Pi SDK auth provider names to icon keys.
 * Kept for setup/onboarding flows that need upstream provider artwork.
 */
function piAuthProviderToIcon(piAuthProvider: string): ProviderIconKey | null {
  switch (piAuthProvider) {
    case 'openai':
    case 'openai-codex':
      return 'openai'
    case 'anthropic':
      return 'anthropic'
    case 'github-copilot':
      return 'copilot'
    case 'openrouter':
      return 'openrouter'
    case 'google':
      return 'google'
    case 'kimi-coding':
      return 'kimi'
    case 'minimax':
    case 'minimax-global':
    case 'minimax-cn':
      return 'minimax'
    case 'mistral':
      return 'mistral'
    case 'amazon-bedrock':
      return 'aws'
    case 'azure-openai-responses':
      return 'azure'
    case 'huggingface':
      return 'huggingface'
    case 'vercel-ai-gateway':
      return 'vercel'
    default:
      return null
  }
}

/**
 * Domain map for providers without static SVG icons.
 * Used to generate Google Favicon V2 URLs as fallback.
 */
const PI_AUTH_PROVIDER_DOMAINS: Record<string, string> = {
  groq: 'groq.com',
  xai: 'x.ai',
  cerebras: 'cerebras.ai',
  zai: 'z.ai',
}

/**
 * Get provider icon URL for a given provider type and optional base URL.
 * Base URL detection takes precedence for compatible providers (openai_compat, anthropic_compat).
 * Agent backends use agent identity icons; model/provider detail stays in text.
 *
 * @param providerType - The LLM provider type
 * @param baseUrl - Optional custom base URL for detection
 * @param piAuthProvider - Optional Pi SDK auth provider (e.g. 'openai-codex', 'github-copilot')
 * @param connectionName - Optional connection name used to identify ACP-backed agents
 * @returns Icon URL string or null if no matching icon
 */
export function getProviderIcon(
  providerType: LlmProviderType | string,
  baseUrl?: string | null,
  piAuthProvider?: string | null,
  connectionName?: string | null,
  agentId?: string | null,
): string | null {
  if (agentId === 'pi' || providerType === 'pi' || providerType === 'pi_compat') {
    const upstreamIconKey = piAuthProvider ? piAuthProviderToIcon(piAuthProvider) : null
    if (upstreamIconKey) return providerIcons[upstreamIconKey]
  }

  const agentIconKey = detectAgentIconFromId(agentId)
  if (agentIconKey) return providerIcons[agentIconKey]

  // For compatible providers, try to detect from URL first
  if (baseUrl && (providerType === 'openai_compat' || providerType === 'anthropic_compat')) {
    const detectedProvider = detectProviderFromUrl(baseUrl)
    if (detectedProvider) {
      return providerIcons[detectedProvider]
    }
  }

  // Map provider type to icon
  switch (providerType) {
    case 'anthropic':
    case 'anthropic_compat':
      return providerIcons.anthropic
    case 'openai':
    case 'openai_compat':
      return providerIcons.openai
    case 'copilot':
      return providerIcons.copilot
    case 'pi':
    case 'pi_compat': {
      const iconKey = piAuthProvider ? piAuthProviderToIcon(piAuthProvider) : null
      if (iconKey) return providerIcons[iconKey]
      return providerIcons.pi_agent
    }
    case 'codex':
      return providerIcons.codex
    case 'droid':
    case 'factory':
      return providerIcons.droid
    case 'hermes':
      return providerIcons.hermes
    case 'openclaw':
      return providerIcons.openclaw
    case 'acp': {
      const iconKey = detectAgentIconFromName(connectionName)
      return iconKey ? providerIcons[iconKey] : providerIcons.acp
    }
    default:
      // Try URL detection as fallback
      if (baseUrl) {
        const detectedProvider = detectProviderFromUrl(baseUrl)
        if (detectedProvider) {
          return providerIcons[detectedProvider]
        }
      }
      return null
  }
}

export function getPiUpstreamProviderIcon(piAuthProvider?: string | null): string | null {
  if (!piAuthProvider) return null
  const iconKey = piAuthProviderToIcon(piAuthProvider)
  if (iconKey) return providerIcons[iconKey]
  const domain = PI_AUTH_PROVIDER_DOMAINS[piAuthProvider]
  if (!domain) return null
  return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://${domain}`
}
