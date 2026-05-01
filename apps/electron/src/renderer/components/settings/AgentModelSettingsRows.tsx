import type { LlmConnectionWithStatus } from '../../../shared/types'
import { SettingsMenuSelectRow } from './SettingsMenuSelect'
import {
  getAgentDisplayInfo,
  getSettingsModelOptions,
} from '@/lib/agent-model-options'

interface AgentModelSettingsRowsProps {
  connections: LlmConnectionWithStatus[]
  selectedConnection?: LlmConnectionWithStatus
  connectionValue: string
  modelValue: string
  onConnectionChange: (value: string) => void
  onModelChange: (value: string) => void
  includeGlobalOption?: boolean
}

export function AgentModelSettingsRows({
  connections,
  selectedConnection,
  connectionValue,
  modelValue,
  onConnectionChange,
  onModelChange,
  includeGlobalOption = false,
}: AgentModelSettingsRowsProps) {
  const globalOption = includeGlobalOption
    ? [{ value: 'global', label: 'Use default', description: 'Inherit from app settings' }]
    : []
  const modelOptions = getSettingsModelOptions(selectedConnection)
  const modelSelectOptions = [
    ...globalOption,
    ...modelOptions,
  ]
  const modelSelectDisabled = modelSelectOptions.length === 0

  return (
    <>
      <SettingsMenuSelectRow
        label="Agent"
        description="Backend agent for new chats"
        value={connectionValue}
        onValueChange={onConnectionChange}
        options={[
          ...globalOption,
          ...connections.map((connection) => ({
            value: connection.slug,
            label: connection.name,
            description: getAgentDisplayInfo(connection).description,
          })),
        ]}
      />
      <SettingsMenuSelectRow
        label="Model"
        description="Available models for this agent"
        value={modelValue}
        onValueChange={onModelChange}
        options={modelSelectOptions}
        disabled={modelSelectDisabled}
        placeholder={modelSelectDisabled ? 'No models' : 'Select model'}
      />
    </>
  )
}
