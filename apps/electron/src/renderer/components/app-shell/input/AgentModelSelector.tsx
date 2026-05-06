import * as React from 'react'
import { AlertCircle, Check, ChevronDown, Image as ImageIcon } from 'lucide-react'

import * as storage from '@/lib/local-storage'
import { Button } from '@/components/ui/button'
import { Spinner, Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { getModelDisplayName } from '@config/models'
import { resolveEffectiveConnectionSlug, isCompatProvider, modelSupportsImages } from '@config/llm-connections'
import { type ThinkingLevel, THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels'
import type { AgentBackendCapabilities, LlmConnectionWithStatus, NativeCapabilitySyncManifest } from '../../../../shared/types'
import {
  getModelEntriesForConnection,
  getModelId,
  getModelName,
  getModelDescription,
  groupConnectionsByAgent,
  isConnectionReady,
} from '@/lib/agent-model-options'

function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, { name: string; description: string }> = {
  off: { name: 'Off', description: 'No extended reasoning' },
  low: { name: 'Low', description: 'Light reasoning, faster responses' },
  medium: { name: 'Medium', description: 'Balanced reasoning depth' },
  high: { name: 'High', description: 'Deep reasoning for complex tasks' },
  xhigh: { name: 'XHigh', description: 'Extra-high reasoning depth' },
  max: { name: 'Max', description: 'Maximum reasoning effort' },
}

function getThinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level]?.name ?? level
}

interface AgentModelSelectorProps {
  currentModel: string
  onModelChange: (model: string, connection?: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  currentConnection?: string
  onConnectionChange?: (connectionSlug: string) => void
  connectionUnavailable?: boolean
  isEmptySession?: boolean
  llmConnections: LlmConnectionWithStatus[]
  workspaceDefaultConnection?: string
  contextStatus?: {
    isCompacting?: boolean
    inputTokens?: number
    contextWindow?: number
  }
  backendCapabilities?: AgentBackendCapabilities
  nativeCapabilityManifest?: NativeCapabilitySyncManifest
  onToggleModelVision?: (connectionSlug: string, modelId: string, enabled: boolean) => void
}

function capabilitySummary(capabilities: AgentBackendCapabilities | undefined): string | null {
  if (!capabilities) return null
  const missing: string[] = []
  if (!capabilities.supportsBranching) missing.push('branching')
  if (!capabilities.supportsSteering) missing.push('steering')
  if (!capabilities.supportsUsageUpdates) missing.push('live context')
  if (missing.length === 0) return 'Full first-party session controls'
  return `Limited: no ${missing.join(', ')}`
}

function nativeCapabilitySummary(manifest: NativeCapabilitySyncManifest | undefined): string | null {
  if (!manifest) return null
  const enabled = manifest.decisions.filter(d => d.action === 'enable').length
  const shadowed = Math.max(
    manifest.decisions.filter(d => d.action === 'shadow').length,
    manifest.shadowedMcpServerNames?.length ?? 0,
  )
  const warningCount = manifest.warnings?.length ?? 0
  const parts: string[] = []
  if (enabled > 0) parts.push(`${enabled} native extras`)
  if (shadowed > 0) parts.push(`${shadowed} duplicates shadowed`)
  if (warningCount > 0) parts.push(`${warningCount} warnings`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function AgentModelSelector({
  currentModel,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  currentConnection,
  onConnectionChange,
  connectionUnavailable = false,
  isEmptySession = false,
  llmConnections,
  workspaceDefaultConnection,
  contextStatus,
  backendCapabilities,
  nativeCapabilityManifest,
  onToggleModelVision,
}: AgentModelSelectorProps) {
  const [open, setOpen] = React.useState(false)
  const triggerLabel = connectionUnavailable
    ? 'Agent unavailable. Create a new session to continue.'
    : 'Change agent and model'

  const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)

  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])

  const connectionDefaultModel = React.useMemo(() => {
    const conn = effectiveConnectionDetails
    if (!conn) return null
    if (!isCompatProvider(conn.providerType)) return null
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [effectiveConnectionDetails])

  const availableModels = React.useMemo(() => {
    if (connectionUnavailable) return []
    return getModelEntriesForConnection(effectiveConnectionDetails ?? undefined)
  }, [connectionUnavailable, effectiveConnectionDetails])

  const thinkingDisabled = React.useMemo(() => {
    const model = availableModels.find(m => typeof m !== 'string' && m.id === currentModel)
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [availableModels, currentModel])

  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    return typeof model === 'string' ? stripPiPrefixForDisplay(model) : model.name
  }, [availableModels, currentModel, connectionDefaultModel])

  const readyConnectionsByAgent = React.useMemo(
    () => groupConnectionsByAgent(llmConnections.filter(isConnectionReady)),
    [llmConnections],
  )
  const capabilityText = React.useMemo(() => capabilitySummary(backendCapabilities), [backendCapabilities])
  const nativeCapabilityText = React.useMemo(
    () => nativeCapabilitySummary(nativeCapabilityManifest),
    [nativeCapabilityManifest],
  )

  const renderEmptyModels = () => (
    <StyledDropdownMenuItem disabled className="px-2 py-2 rounded-lg">
      <div className="text-left">
        <div className="font-medium text-sm">No models configured</div>
        <div className="text-xs text-muted-foreground">Refresh or edit this agent connection</div>
      </div>
    </StyledDropdownMenuItem>
  )

  const renderModelsForConnection = (conn: LlmConnectionWithStatus, isCurrentConnection: boolean) => {
    const models = getModelEntriesForConnection(conn)
    if (models.length === 0) return renderEmptyModels()

    return models.map((model) => {
      const modelId = getModelId(model)
      const modelName = stripPiPrefixForDisplay(getModelName(model))
      const description = getModelDescription(model)
      const isSelectedModel = isCurrentConnection && currentModel === modelId
      const showVisionToggle = isCompatProvider(conn.providerType)
      const visionOn = showVisionToggle && modelSupportsImages(conn, modelId)
      return (
        <StyledDropdownMenuItem
          key={modelId}
          onSelect={() => {
            if (!isCurrentConnection && onConnectionChange) {
              onConnectionChange(conn.slug)
            }
            onModelChange(modelId, conn.slug)
          }}
          className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
        >
          <div className="text-left flex-1 min-w-0">
            <div className="font-medium text-sm truncate">{modelName}</div>
            {description && (
              <div className="text-xs text-muted-foreground truncate">{description}</div>
            )}
          </div>
          <div className="flex items-center gap-1 ml-3 shrink-0">
            {showVisionToggle && onToggleModelVision && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={visionOn ? 'Image support enabled' : 'Image support disabled'}
                    className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onToggleModelVision(conn.slug, modelId, !visionOn)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        onToggleModelVision(conn.slug, modelId, !visionOn)
                      }
                    }}
                  >
                    <ImageIcon className={cn('h-3.5 w-3.5', visionOn ? 'text-foreground/70' : 'text-foreground/30')} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{visionOn ? 'Image support enabled' : 'Image support disabled'}</TooltipContent>
              </Tooltip>
            )}
            {isSelectedModel && (
              <Check className="h-3 w-3 text-foreground shrink-0" />
            )}
          </div>
        </StyledDropdownMenuItem>
      )
    })
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={triggerLabel}
              title={triggerLabel}
              className={cn(
                'input-toolbar-btn inline-flex items-center h-7 px-1.5 gap-0.5 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none max-w-[220px]',
                open && 'bg-foreground/5',
                connectionUnavailable && 'text-destructive',
              )}
            >
              {connectionUnavailable ? (
                <>
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  Unavailable
                </>
              ) : (
                <>
                  {effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && (
                    <ConnectionIcon connection={effectiveConnectionDetails} size={14} />
                  )}
                  <span className="truncate">{currentModelDisplayName}</span>
                  <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{triggerLabel}</TooltipContent>
      </Tooltip>

      <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[280px] max-w-[420px]">
        {connectionUnavailable ? (
          <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
            <AlertCircle className="h-8 w-8 text-destructive mb-2" />
            <div className="font-medium text-sm mb-1">Agent Unavailable</div>
            <div className="text-xs text-muted-foreground">
              The agent used by this session has been removed. Create a new session to continue.
            </div>
          </div>
        ) : isEmptySession && readyConnectionsByAgent.length > 0 ? (
          readyConnectionsByAgent.map(([agentName, connections], index) => (
            <React.Fragment key={agentName}>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide select-none">
                {agentName}
              </div>
              {connections.map((conn) => {
                const isCurrentConnection = effectiveConnection === conn.slug
                const isAuthenticated = conn.isAuthenticated
                return (
                  <DropdownMenuSub key={conn.slug}>
                    <StyledDropdownMenuSubTrigger
                      disabled={!isAuthenticated}
                      className={cn(
                        'flex items-center justify-between px-2 py-2 rounded-lg',
                        isCurrentConnection && 'bg-foreground/5',
                      )}
                    >
                      <div className="text-left flex-1 min-w-0">
                        <div className="font-medium text-sm flex items-center gap-1.5">
                          <ConnectionIcon connection={conn} size={14} />
                          <span className="truncate">{conn.name}</span>
                        </div>
                        {!isAuthenticated && (
                          <div className="text-xs text-muted-foreground">Not authenticated</div>
                        )}
                      </div>
                    </StyledDropdownMenuSubTrigger>
                    {isAuthenticated && (
                      <StyledDropdownMenuSubContent
                        className="min-w-[240px] max-w-[320px] max-h-[420px] overflow-y-auto"
                        style={{ maxHeight: 420, overflowY: 'auto' }}
                      >
                        {renderModelsForConnection(conn, isCurrentConnection)}
                      </StyledDropdownMenuSubContent>
                    )}
                  </DropdownMenuSub>
                )
              })}
              {index < readyConnectionsByAgent.length - 1 && (
                <StyledDropdownMenuSeparator className="my-1" />
              )}
            </React.Fragment>
          ))
        ) : connectionDefaultModel ? (
          <StyledDropdownMenuItem disabled className="flex items-center justify-between px-2 py-2 rounded-lg">
            <div className="text-left min-w-0">
              <div className="font-medium text-sm truncate">{stripPiPrefixForDisplay(connectionDefaultModel)}</div>
              <div className="text-xs text-muted-foreground">Agent default</div>
            </div>
            <div className="flex items-center gap-1 ml-3 shrink-0">
              {effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType) && onToggleModelVision && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={modelSupportsImages(effectiveConnectionDetails, connectionDefaultModel) ? 'Image support enabled' : 'Image support disabled'}
                      className="inline-flex items-center justify-center p-1 rounded pointer-events-auto opacity-100 hover:bg-foreground/5 cursor-pointer"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onToggleModelVision(effectiveConnectionDetails.slug, connectionDefaultModel, !modelSupportsImages(effectiveConnectionDetails, connectionDefaultModel))
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          event.stopPropagation()
                          onToggleModelVision(effectiveConnectionDetails.slug, connectionDefaultModel, !modelSupportsImages(effectiveConnectionDetails, connectionDefaultModel))
                        }
                      }}
                    >
                      <ImageIcon className={cn('h-3.5 w-3.5', modelSupportsImages(effectiveConnectionDetails, connectionDefaultModel) ? 'text-foreground/70' : 'text-foreground/30')} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{modelSupportsImages(effectiveConnectionDetails, connectionDefaultModel) ? 'Image support enabled' : 'Image support disabled'}</TooltipContent>
                </Tooltip>
              )}
              <Check className="h-3 w-3 text-foreground shrink-0" />
            </div>
          </StyledDropdownMenuItem>
        ) : (
          <>
            {!isEmptySession && effectiveConnectionDetails && llmConnections.length > 1 && (
              <>
                <div className="flex flex-col gap-0.5 px-2 py-1.5 text-xs select-none text-muted-foreground">
                  <span className="truncate" title={`Agent locked to ${effectiveConnectionDetails.name}`}>Agent locked to {effectiveConnectionDetails.name}</span>
                  {capabilityText && (
                    <span className="truncate" title={capabilityText}>{capabilityText}</span>
                  )}
                  {nativeCapabilityText && (
                    <span className="truncate" title={nativeCapabilityText}>{nativeCapabilityText}</span>
                  )}
                </div>
                <StyledDropdownMenuSeparator className="my-1" />
              </>
            )}
            {availableModels.length === 0 ? renderEmptyModels() : availableModels.map((model) => {
              const modelId = getModelId(model)
              const modelName = stripPiPrefixForDisplay(getModelName(model))
              const isSelected = currentModel === modelId
              const description = getModelDescription(model)
              const showVisionToggle =
                !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
              const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, modelId)
              return (
                <StyledDropdownMenuItem
                  key={modelId}
                  onSelect={() => onModelChange(modelId, effectiveConnection)}
                  className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                >
                  <div className="text-left flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{modelName}</div>
                    {description && (
                      <div className="text-xs text-muted-foreground truncate">{description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-3 shrink-0">
                    {showVisionToggle && effectiveConnectionDetails && onToggleModelVision && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={visionOn ? 'Image support enabled' : 'Image support disabled'}
                            className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              onToggleModelVision(effectiveConnectionDetails.slug, modelId, !visionOn)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                event.stopPropagation()
                                onToggleModelVision(effectiveConnectionDetails.slug, modelId, !visionOn)
                              }
                            }}
                          >
                            <ImageIcon className={cn('h-3.5 w-3.5', visionOn ? 'text-foreground/70' : 'text-foreground/30')} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{visionOn ? 'Image support enabled' : 'Image support disabled'}</TooltipContent>
                      </Tooltip>
                    )}
                    {isSelected && (
                      <Check className="h-3 w-3 text-foreground shrink-0" />
                    )}
                  </div>
                </StyledDropdownMenuItem>
              )
            })}
          </>
        )}

        {THINKING_LEVELS.length > 0 && (
          <>
            <StyledDropdownMenuSeparator className="my-1" />
            <DropdownMenuSub>
              <StyledDropdownMenuSubTrigger disabled={thinkingDisabled} className={cn('flex items-center justify-between px-2 py-2 rounded-lg', thinkingDisabled && 'opacity-50 cursor-not-allowed')}>
                <div className="text-left flex-1">
                  <div className="font-medium text-sm">{getThinkingLevelLabel(thinkingLevel)}</div>
                  <div className="text-xs text-muted-foreground">{thinkingDisabled ? 'Not supported by this model' : 'Extended reasoning depth'}</div>
                </div>
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent className="min-w-[220px]">
                {THINKING_LEVELS.map(({ id }) => {
                  const isSelected = thinkingLevel === id
                  const copy = THINKING_LEVEL_LABELS[id]
                  return (
                    <StyledDropdownMenuItem
                      key={id}
                      onSelect={() => onThinkingLevelChange?.(id)}
                      className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                    >
                      <div className="text-left">
                        <div className="font-medium text-sm">{copy.name}</div>
                        <div className="text-xs text-muted-foreground">{copy.description}</div>
                      </div>
                      {isSelected && (
                        <Check className="h-3 w-3 text-foreground shrink-0 ml-3" />
                      )}
                    </StyledDropdownMenuItem>
                  )
                })}
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
          <>
            <StyledDropdownMenuSeparator className="my-1" />
            <div className="px-2 py-1.5 select-none">
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span>Context</span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  {contextStatus.isCompacting && (
                    <Spinner className="h-3 w-3" />
                  )}
                  {contextStatus.contextWindow
                    ? `${formatTokenCount(contextStatus.inputTokens)} / ${formatTokenCount(contextStatus.contextWindow)} tokens`
                    : `${formatTokenCount(contextStatus.inputTokens)} tokens used`}
                </span>
              </div>
            </div>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
