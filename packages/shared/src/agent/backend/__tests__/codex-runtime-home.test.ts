import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_DIR } from '../../../config/paths.ts';
import { prepareCodexRuntimeHome } from '../codex-runtime-home.ts';

const runtimeHome = join(CONFIG_DIR, 'runtime', 'codex', 'runtime-home-test');
const previousRootHome = process.env.CRAFT_ROOT_CODEX_HOME;

afterEach(async () => {
  if (previousRootHome == null) {
    delete process.env.CRAFT_ROOT_CODEX_HOME;
  } else {
    process.env.CRAFT_ROOT_CODEX_HOME = previousRootHome;
  }
  await rm(runtimeHome, { recursive: true, force: true });
});

describe('prepareCodexRuntimeHome', () => {
  it('copies native passthrough config without leaking conflicting agent or shadowed MCP config', async () => {
    const rootHome = await mkdtemp(join(tmpdir(), 'craft-root-codex-'));
    process.env.CRAFT_ROOT_CODEX_HOME = rootHome;
    await writeFile(join(rootHome, 'config.toml'), [
      'model = "gpt-5.5"',
      'developer_instructions = """',
      'root prompt should not leak',
      '"""',
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      'project_doc_fallback_filenames = [',
      '  "AGENTS.md",',
      '  "README.md",',
      ']',
      'features.apps = false',
      '',
      '[features]',
      'apps = false',
      'plugins = false',
      '',
      '[developer]',
      'instructions = "also should not leak"',
      '',
      '[agents.example]',
      'path = "/tmp/native-agent.toml"',
      '',
      '[mcp_servers."word-swift-kosta"]',
      'command = "word"',
      '',
      '[mcp_servers.native-only]',
      'command = "native"',
      '',
      '[marketplaces.openai-bundled]',
      'source_type = "local"',
    ].join('\n'), 'utf8');

    const result = await prepareCodexRuntimeHome({
      connectionSlug: 'runtime-home-test',
      craftInventory: {
        generatedAt: Date.now(),
        items: [{
          id: 'craft:mcp-server:word-swift-kosta',
          kind: 'mcp-server',
          source: 'craft',
          name: 'word-swift-kosta',
          enabled: true,
        }],
      },
    });
    const generated = await readFile(join(result.runtimeHome, 'config.toml'), 'utf8');

    expect(generated).toContain('model = "gpt-5.5"');
    expect(generated).toContain('approval_policy = "on-request"');
    expect(generated).toContain('sandbox_mode = "workspace-write"');
    expect(generated).toContain('[features]');
    expect(generated).toContain('apps = true');
    expect(generated).toContain('plugins = true');
    expect(generated).not.toContain('root prompt should not leak');
    expect(generated).not.toContain('project_doc_fallback_filenames');
    expect(generated).not.toContain('features.apps = false');
    expect(generated).not.toContain('[developer]');
    expect(generated).not.toContain('also should not leak');
    expect(generated).not.toContain('[agents.example]');
    expect(generated).not.toContain('native-agent.toml');
    expect(generated).not.toContain('[mcp_servers."word-swift-kosta"]');
    expect(generated).not.toContain('enabled = false');
    expect(generated).toContain('[mcp_servers.native-only]');
    expect(generated).toContain('[marketplaces.openai-bundled]');
    expect(generated.indexOf('[features]')).toBeLessThan(generated.indexOf('[mcp_servers.native-only]'));

    await rm(rootHome, { recursive: true, force: true });
  });

  it('adds the catalog model provider for custom Codex models', async () => {
    const rootHome = await mkdtemp(join(tmpdir(), 'craft-root-codex-'));
    process.env.CRAFT_ROOT_CODEX_HOME = rootHome;
    const catalogPath = join(rootHome, 'model-catalog.json');
    await writeFile(catalogPath, JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
        { slug: 'glm-5.1', display_name: 'GLM-5.1', model_provider: 'go-llm-proxy-vibe' },
      ],
    }), 'utf8');
    await writeFile(join(rootHome, 'config.toml'), [
      'model = "gpt-5.5"',
      `model_catalog_json = "${catalogPath}"`,
    ].join('\n'), 'utf8');

    const result = await prepareCodexRuntimeHome({
      connectionSlug: 'runtime-home-test',
      model: 'glm-5.1',
    });
    const generated = await readFile(join(result.runtimeHome, 'config.toml'), 'utf8');

    expect(generated).toContain('model_provider = "go-llm-proxy-vibe"');
    expect(generated.indexOf('model_provider = "go-llm-proxy-vibe"')).toBeLessThan(generated.indexOf('[features]'));
    expect(result.configOverrides.model_provider).toBe('go-llm-proxy-vibe');

    await rm(rootHome, { recursive: true, force: true });
  });
});
