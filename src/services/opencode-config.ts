import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isProviderConfigured,
  providerDisplayName,
  resolveOpenCodeProvider,
  resolveProviderHost,
} from '../lib/llm-provider';
import { hasModelTokenCost, resolveModelTokenCost } from '../lib/model-cost';
import type { AgentJob, AppConfig, LlmProviderId, ModelTokenCost } from '../types';
import { collectLoopModels } from '../domains/agents/worker/loop-model';

/** Legacy workspace filename — excluded from agent commits if still present. */
export const OPENCODE_TOOL_INSTRUCTIONS_FILE = 'opencode-tool-instructions.md';

/** Written beside `opencode.json`; referenced via the `instructions` array (OpenCode rejects inline `systemPrompt`). */
export const LOCALAGENT_INSTRUCTIONS_FILE = 'localagent-instructions.md';

const OPENCODE_TOOL_INSTRUCTIONS = `# Tool calling requirements (Ollama / local models)

Do **not** create or modify \`opencode-tool-instructions.md\` — tool guidance is injected via OpenCode config.


When calling the \`bash\` tool, you **must** include a \`description\` parameter (5–10 words describing what the command does). OpenCode rejects bash calls without it.

Examples:
- \`bash(command="ls -la", description="List files in current directory")\`
- \`bash(command="git status", description="Show working tree status")\`
- \`bash(command="npm install", description="Install package dependencies")\`

Do **not** call bash with only \`command\` — always include \`description\`.

Prefer dedicated tools when available: use **Read** (not \`cat\`), **Grep** (not \`grep\`), **Glob** (not \`find\`/\`ls\`), **Write** (not \`echo >\`).

## Batch (one-shot) runs

Batch agents get a single unattended turn. **You must change repository files** to complete the task — plans, summaries, or \`docs/todo.md\` alone are not enough. Use tools (Read, Write, Edit, bash, etc.) to implement, run focused checks when relevant, then stop only after edits exist.
`;

export const DEFAULT_TEMPLATE = {
  $schema: 'https://opencode.ai/config.json',
  model: 'ollama/llama3.2',
  provider: {
    ollama: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: {
        baseURL: 'http://localhost:11434/v1',
      },
      models: {
        'llama3.2': {
          name: 'llama3.2',
        },
      },
    },
  },
};

export interface OpenCodeModelConfig {
  name: string;
  /** Lets OpenCode compact before overflowing; only set when the server reports a context window. */
  limit?: { context: number; output: number };
  /** Per-million-token rates in USD; emitted only when the model has configured costs. */
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  options?: {
    reasoningEffort?: string;
    extraBody?: Record<string, unknown>;
  };
}

/** OpenCode v2 local MCP server (`mcp.servers.<name>`). */
export interface OpenCodeMcpLocalServer {
  type: 'local';
  command: string[];
  disabled: boolean;
  timeout?: { catalog?: number; execution?: number };
}

export type OpenCodePermissionEffect = 'ask' | 'allow' | 'deny';

/** OpenCode v2 permission rule; rules are ordered and the last match wins (no match = ask). */
export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: OpenCodePermissionEffect;
}

export interface OpenCodeConfigFile {
  $schema: string;
  model: string;
  instructions?: string[];
  permissions?: OpenCodePermissionRule[];
  mcp?: { servers: Record<string, OpenCodeMcpLocalServer> };
  /**
   * v1-format provider block — still accepted by v2. Kept until v2 model support for
   * `limit` / `options.extraBody` is verified (v2 requires a provider's models in one format).
   */
  provider: Record<
    string,
    {
      npm: string;
      name: string;
      options: { baseURL: string; apiKey?: string };
      models: Record<string, OpenCodeModelConfig>;
    }
  >;
}

export interface OpenCodeConfigBuildOptions {
  autoApprovePermissions?: boolean;
  job?: AgentJob;
  /** When true, inject the codegraph MCP server into opencode.json. */
  codegraph?: boolean;
  /** When true, deny the `question` permission so unattended runs cannot block on user input. */
  disableQuestionTool?: boolean;
  /** Context windows by model id (see `resolveModelContextLengths`); adds `limit` to matching models. */
  modelContextLengths?: Record<string, number>;
}

export const CODEGRAPH_BIN = 'codegraph';

/** Cold-start + first connect catch-up can exceed OpenCode's 5s default MCP timeout. */
const CODEGRAPH_MCP_TIMEOUT_MS = 15_000;

export function buildCodegraphMcpServer(): OpenCodeMcpLocalServer {
  return {
    type: 'local',
    command: [CODEGRAPH_BIN, 'serve', '--mcp'],
    disabled: false,
    timeout: { catalog: CODEGRAPH_MCP_TIMEOUT_MS },
  };
}

/**
 * Ordered v2 permission rules (last match wins). Without auto-approve, keep v1's `ask` for
 * `external_directory` — v2 allows it by default, which would let agents leave their clone.
 */
export function buildPermissionRules(options: {
  autoApprovePermissions?: boolean;
  disableQuestionTool?: boolean;
}): OpenCodePermissionRule[] {
  const rules: OpenCodePermissionRule[] = options.autoApprovePermissions
    ? [{ action: '*', resource: '*', effect: 'allow' }]
    : [{ action: 'external_directory', resource: '*', effect: 'ask' }];
  if (options.disableQuestionTool) {
    // Must follow the wildcard allow so last-match evaluation keeps the deny.
    rules.push({ action: 'question', resource: '*', effect: 'deny' });
  }
  return rules;
}

/** Gemma 4 streams thinking in a non-standard `reasoning` field that OpenCode's AI SDK ignores. */
export function isGemmaThinkingModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return /gemma[-_]?4|gemma4/.test(normalized);
}

export function buildGemmaReasoningWorkaroundOptions(): OpenCodeModelConfig['options'] {
  return {
    reasoningEffort: 'none',
    extraBody: { reasoning_effort: 'none' },
  };
}

const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 32_768;

/** Reserve a quarter of the window for output, clamped to a sane range (matches strata-coder). */
export function buildModelLimit(contextLength: number): { context: number; output: number } {
  const output = Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.floor(contextLength / 4)),
  );
  return { context: contextLength, output };
}

/** OpenCode v1 model `cost` shape (USD per million tokens); null when no rates are configured. */
export function buildModelCost(cost: ModelTokenCost | null): OpenCodeModelConfig['cost'] | null {
  if (!hasModelTokenCost(cost)) return null;
  const rate = (value?: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    input: rate(cost?.input),
    output: rate(cost?.output),
    ...(typeof cost?.cacheRead === 'number' ? { cache_read: cost.cacheRead } : {}),
    ...(typeof cost?.cacheWrite === 'number' ? { cache_write: cost.cacheWrite } : {}),
  };
}

export function buildModelConfig(
  modelId: string,
  contextLength?: number,
  modelCost?: ModelTokenCost | null,
): OpenCodeModelConfig {
  const entry: OpenCodeModelConfig = { name: modelId };
  if (contextLength && contextLength > 0) {
    entry.limit = buildModelLimit(contextLength);
  }
  const cost = buildModelCost(modelCost ?? null);
  if (cost) {
    entry.cost = cost;
  }
  if (isGemmaThinkingModel(modelId)) {
    entry.options = buildGemmaReasoningWorkaroundOptions();
  }
  return entry;
}

export interface OpenCodeConfigService {
  configDir: string;
  configPath: string;
  buildOpenCodeConfig: (
    config: AppConfig,
    options?: OpenCodeConfigBuildOptions,
  ) => OpenCodeConfigFile;
  writeOpenCodeConfig: (
    config: AppConfig,
    options?: OpenCodeConfigBuildOptions,
  ) => { path: string; config: OpenCodeConfigFile } | null;
  normalizeOpenCodeBaseUrl: (baseUrl: string) => string;
  normalizeProbeBaseUrl: (baseUrl: string) => string;
}

export function normalizeProbeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function normalizeOpenCodeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function buildMergedInstructionsContent(config: AppConfig): string | null {
  const userSystemPrompt = config.systemPrompt?.trim();
  const toolGuidance = loadBundledToolInstructions().trim();
  const merged = [userSystemPrompt, toolGuidance].filter(Boolean).join('\n\n');
  return merged || null;
}

function buildProviderEntry(
  providerId: LlmProviderId,
  config: AppConfig,
  registeredModelIds: string[],
  modelContextLengths: Record<string, number> = {},
): OpenCodeConfigFile['provider'][string] {
  const host = resolveProviderHost(config, providerId);
  const baseURL = normalizeOpenCodeBaseUrl(host.baseUrl);
  const providerOptions: { baseURL: string; apiKey?: string } = { baseURL };
  if (host.apiKey) {
    providerOptions.apiKey = host.apiKey;
  }

  const name = providerId === 'ollama' ? 'Ollama (local)' : providerDisplayName(providerId);

  return {
    npm: '@ai-sdk/openai-compatible',
    name,
    options: providerOptions,
    models: Object.fromEntries(
      registeredModelIds.map((id) => [
        id,
        buildModelConfig(id, modelContextLengths[id], resolveModelTokenCost(config.modelTokenCosts ?? {}, id)),
      ]),
    ),
  };
}

export function buildOpenCodeConfig(
  config: AppConfig,
  options?: OpenCodeConfigBuildOptions,
): OpenCodeConfigFile {
  const providerId = resolveOpenCodeProvider(config);
  const modelId = config.opencodeModel || 'llama3.2';
  const instructionsContent = buildMergedInstructionsContent(config);
  const modelIds = collectLoopModels(config, options?.job);
  const registeredModelIds = Array.from(new Set([modelId, ...modelIds]));

  const file: OpenCodeConfigFile = {
    $schema: 'https://opencode.ai/config.json',
    model: `${providerId}/${modelId}`,
    ...(instructionsContent ? { instructions: [LOCALAGENT_INSTRUCTIONS_FILE] } : {}),
    provider: {
      [providerId]: buildProviderEntry(
        providerId,
        config,
        registeredModelIds,
        options?.modelContextLengths,
      ),
    },
  };

  file.permissions = buildPermissionRules({
    autoApprovePermissions: options?.autoApprovePermissions,
    disableQuestionTool: options?.disableQuestionTool,
  });

  if (options?.codegraph) {
    file.mcp = { servers: { codegraph: buildCodegraphMcpServer() } };
  }

  return file;
}

type FsLike = Pick<
  typeof fs,
  'existsSync' | 'readFileSync' | 'appendFileSync' | 'mkdirSync' | 'writeFileSync'
>;

const bundledInstructionsPath = path.join(__dirname, '..', '..', 'config', OPENCODE_TOOL_INSTRUCTIONS_FILE);

function loadBundledToolInstructions(fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs): string {
  if (fsImpl.existsSync(bundledInstructionsPath)) {
    return fsImpl.readFileSync(bundledInstructionsPath, 'utf8');
  }
  return OPENCODE_TOOL_INSTRUCTIONS;
}

/** Written into the workspace by `codegraph init`; must never land in agent commits. */
export const CODEGRAPH_DATA_DIR = '.codegraph/';

/** Keep infrastructure files (legacy instructions copies, MCP graph data) out of agent commits. */
export function excludeWorkspaceInfrastructureFromGit(
  workspaceDir: string,
  fsImpl: FsLike = fs,
  pathImpl: typeof path = path,
): void {
  const gitDir = pathImpl.join(workspaceDir, '.git');
  if (!fsImpl.existsSync(gitDir)) {
    return;
  }
  const excludePath = pathImpl.join(gitDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = fsImpl.readFileSync(excludePath, 'utf8');
  } catch {
    existing = '';
  }
  const missing = [OPENCODE_TOOL_INSTRUCTIONS_FILE, CODEGRAPH_DATA_DIR].filter(
    (entry) => !existing.includes(entry),
  );
  if (missing.length === 0) {
    return;
  }
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fsImpl.appendFileSync(
    excludePath,
    `${prefix}# localagent-box infrastructure\n${missing.join('\n')}\n`,
    'utf8',
  );
}

export function createOpenCodeConfigService(options: {
  fs?: FsLike & Partial<Pick<typeof fs, 'chmodSync'>>;
  path?: typeof path;
  os?: typeof os;
  configDir?: string;
} = {}): OpenCodeConfigService {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const osImpl = options.os || os;
  const configDir =
    options.configDir || pathImpl.join(osImpl.homedir(), '.config', 'opencode');
  const configPath = pathImpl.join(configDir, 'opencode.json');

  function writeOpenCodeConfig(
    config: AppConfig,
    options?: OpenCodeConfigBuildOptions,
  ): { path: string; config: OpenCodeConfigFile } | null {
    if (!isProviderConfigured(config, resolveOpenCodeProvider(config))) {
      return null;
    }

    const opencodeConfig = buildOpenCodeConfig(config, options);
    fsImpl.mkdirSync(configDir, { recursive: true });

    const instructionsContent = buildMergedInstructionsContent(config);
    if (instructionsContent) {
      const instructionsPath = pathImpl.join(configDir, LOCALAGENT_INSTRUCTIONS_FILE);
      fsImpl.writeFileSync(instructionsPath, `${instructionsContent}\n`, 'utf8');
      // OpenCode v2 does not resolve relative `instructions` against the config dir.
      opencodeConfig.instructions = [instructionsPath];
    }

    // May embed a provider API key — keep it owner-only (mode applies on create; chmod
    // tightens files written by earlier versions).
    fsImpl.writeFileSync(configPath, `${JSON.stringify(opencodeConfig, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fsImpl.chmodSync?.(configPath, 0o600);
    return { path: configPath, config: opencodeConfig };
  }

  return {
    configDir,
    configPath,
    buildOpenCodeConfig,
    writeOpenCodeConfig,
    normalizeOpenCodeBaseUrl,
    normalizeProbeBaseUrl,
  };
}
