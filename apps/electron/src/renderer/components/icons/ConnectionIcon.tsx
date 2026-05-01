/**
 * ConnectionIcon
 *
 * Displays the provider logo for an LLM connection.
 * Falls back to the first letter of the connection name if no icon is available.
 *
 * Used in:
 * - AI Settings (connections list)
 * - FreeFormInput (model display)
 * - Session List (connection badge)
 * - New Session (model selector group names)
 */

import { Brain, Terminal } from 'lucide-react'
import { getProviderIcon, providerIcons } from '@/lib/provider-icons'
import { getModelDisplayName } from '@config/models'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import type { LlmConnectionWithStatus } from '../../../shared/types'

interface ConnectionIconProps {
  /** The connection to display an icon for */
  connection: Pick<LlmConnectionWithStatus, 'name' | 'providerType' | 'baseUrl' | 'piAuthProvider'> & { type?: string; defaultModel?: string; agentId?: string }
  /** Size in pixels (default: 16) */
  size?: number
  /** Additional CSS classes */
  className?: string
  /** Show tooltip with connection name + model on hover (default: false) */
  showTooltip?: boolean
}

export function ConnectionIcon({ connection, size = 16, className = '', showTooltip = false }: ConnectionIconProps) {
  const providerType = connection.providerType || connection.type || ''
  const providerIcon = getProviderIcon(
    providerType,
    connection.baseUrl,
    connection.piAuthProvider,
    connection.name,
    connection.agentId,
  )

  const FallbackIcon = providerType === 'acp' || providerType === 'codex' ? Terminal : Brain
  const useLogoTile = providerIcon === providerIcons.codex ||
    providerIcon === providerIcons.pi_agent ||
    providerIcon === providerIcons.acp

  const iconElement = providerIcon ? (
    <span
      className={`inline-flex items-center justify-center rounded-[3px] flex-shrink-0 ${useLogoTile ? 'bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]' : ''} ${className}`}
      style={{ width: size, height: size }}
    >
      <img
        src={providerIcon}
        alt=""
        width={size}
        height={size}
        className="rounded-[3px] flex-shrink-0"
        style={{ width: size, height: size }}
      />
    </span>
  ) : (
    <div
      className={`rounded-[3px] bg-foreground/10 flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <FallbackIcon
        className="text-foreground/50 flex-shrink-0"
        style={{ width: Math.round(size * 0.7), height: Math.round(size * 0.7) }}
      />
    </div>
  )

  if (!showTooltip) return iconElement

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {iconElement}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        <div className="text-center">
          <div>{connection.name}</div>
          {connection.defaultModel && <div className="text-[10px] opacity-60">{getModelDisplayName(connection.defaultModel)}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
