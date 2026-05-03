import type { LlmConnection } from './llm-connections.ts';

export type AgentCatalogId = 'claude' | 'pi' | 'codex' | 'droid' | 'hermes';

export type AgentCatalogStatusKind =
  | 'ready'
  | 'needs_setup'
  | 'not_installed'
  | 'broken';

export interface AgentCatalogCommandProbe {
  command: string;
  args?: string[];
  label?: string;
}

export interface AgentCatalogEntry {
  id: AgentCatalogId;
  name: string;
  description: string;
  iconKey: string;
  installLabel: string;
  setupLabel: string;
  setupCommand?: string;
  docsUrl?: string;
  setupUrl?: string;
  providerType: LlmConnection['providerType'];
  authType: LlmConnection['authType'];
  piAuthProvider?: LlmConnection['piAuthProvider'];
  defaultSlug: string;
  defaultCommand?: string;
  preferredCommandCandidates?: string[];
  defaultArgs?: string[];
  requiredCommands: string[];
  commandProbes?: AgentCatalogCommandProbe[];
  models?: NonNullable<LlmConnection['models']>;
  defaultModel?: string;
  showInAgentManager?: boolean;
}

export interface AgentCatalogStatus extends AgentCatalogEntry {
  status: AgentCatalogStatusKind;
  connectionSlug?: string;
  installed: boolean;
  configured: boolean;
  ready: boolean;
  message?: string;
}

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: 'claude',
    name: 'Claude',
    description: 'Anthropic Claude through Craft credentials',
    iconKey: 'anthropic',
    installLabel: 'Add connection',
    setupLabel: 'Configure Claude',
    providerType: 'anthropic',
    authType: 'oauth',
    defaultSlug: 'claude-max',
    requiredCommands: [],
    showInAgentManager: false,
  },
  {
    id: 'pi',
    name: 'Craft Agents Backend',
    description: 'Craft-hosted multi-provider agent runtime using the default Craft auth method',
    iconKey: 'pi_agent',
    installLabel: 'Add connection',
    setupLabel: 'Configure backend',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'openai-codex',
    defaultSlug: 'craft-agents-backend',
    requiredCommands: [],
    showInAgentManager: true,
    defaultModel: 'pi/gpt-5.2',
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Local Codex app-server using your Codex sign-in',
    iconKey: 'codex',
    installLabel: 'Install Codex',
    setupLabel: 'Enable Codex',
    setupCommand: 'codex login',
    docsUrl: 'https://developers.openai.com/codex/cli',
    setupUrl: 'https://developers.openai.com/codex/cli',
    providerType: 'codex',
    authType: 'none',
    defaultSlug: 'codex-native',
    defaultCommand: 'codex',
    defaultArgs: ['app-server', '--listen', 'stdio://'],
    requiredCommands: ['codex'],
    commandProbes: [{ command: 'codex', args: ['app-server', '--help'], label: 'Codex app-server' }],
    showInAgentManager: true,
    models: [{ id: 'gpt-5.5', name: 'GPT-5.5', shortName: 'GPT-5.5', description: 'Codex app-server default model', provider: 'codex', contextWindow: 272_000 }],
    defaultModel: 'gpt-5.5',
  },
  {
    id: 'droid',
    name: 'Droid',
    description: "Factory Droid through Craft's curated Droid integration",
    iconKey: 'droid',
    installLabel: 'Install Droid',
    setupLabel: 'Set up Droid',
    setupCommand: 'droid',
    docsUrl: 'https://docs.factory.ai/cli/getting-started/overview',
    setupUrl: 'https://docs.factory.ai/cli/getting-started/overview',
    providerType: 'acp',
    authType: 'none',
    defaultSlug: 'droid',
    defaultCommand: 'droid',
    preferredCommandCandidates: ['/Users/Kosta/.npm-global/bin/droid', '/opt/homebrew/bin/droid', 'droid'],
    defaultArgs: ['exec', '--output-format', 'acp'],
    requiredCommands: ['droid'],
    commandProbes: [{ command: 'droid', args: ['exec', '--help'], label: 'Droid direct ACP mode' }],
    showInAgentManager: true,
    models: ['claude-opus-4-7', 'gpt-5.4', 'gpt-5.3-codex', 'glm-5.1'],
    defaultModel: 'claude-opus-4-7',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'Hermes Agent through its first-party ACP mode',
    iconKey: 'hermes',
    installLabel: 'Install Hermes',
    setupLabel: 'Enable Hermes',
    setupCommand: 'hermes model',
    providerType: 'acp',
    authType: 'none',
    defaultSlug: 'hermes',
    defaultCommand: 'hermes',
    defaultArgs: ['acp', '--accept-hooks'],
    requiredCommands: ['hermes'],
    commandProbes: [{ command: 'hermes', args: ['acp', '--help'], label: 'Hermes ACP mode' }],
    showInAgentManager: true,
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/',
    setupUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/quickstart',
    models: ['gpt-5.5'],
    defaultModel: 'gpt-5.5',
  },
];

export function getAgentCatalogEntry(agentId: string | undefined): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find(entry => entry.id === agentId);
}

export function createConnectionForAgent(entry: AgentCatalogEntry): LlmConnection {
  const now = Date.now();
  return {
    slug: entry.defaultSlug,
    name: entry.name,
    agentId: entry.id,
    providerType: entry.providerType,
    authType: entry.authType,
    piAuthProvider: entry.providerType === 'pi' ? entry.piAuthProvider : undefined,
    createdAt: now,
    models: entry.models,
    defaultModel: entry.defaultModel,
    modelSelectionMode: 'automaticallySyncedFromProvider',
    acpCommand: entry.providerType === 'acp' ? entry.defaultCommand : undefined,
    acpArgs: entry.providerType === 'acp' ? entry.defaultArgs : undefined,
    codexCommand: entry.providerType === 'codex' ? entry.defaultCommand : undefined,
    codexArgs: entry.providerType === 'codex' ? entry.defaultArgs : undefined,
  };
}
