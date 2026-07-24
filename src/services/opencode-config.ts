import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AgentJob, AppConfig } from '../types';
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
  options?: {
    reasoningEffort?: string;
    extraBody?: Record<string, unknown>;
  };
}

export interface OpenCodeMcpLocalServer {
  type: 'local';
  command: string[];
  enabled: boolean;
  timeout?: number;
}

export interface OpenCodeConfigFile {
  $schema: string;
  model: string;
  instructions?: string[];
  permission?: Record<string, Record<string, string>>;
  mcp?: Record<string, OpenCodeMcpLocalServer>;
  provider: Record<
    string,
    {
      npm: string;
      name: string;
      options: { baseURL: string };
      models: Record<string, OpenCodeModelConfig>;
    }
  >;
}

export interface CodeReviewGraphMcpOptions {
  /** Repository the graph server should index (the agent's workspace clone). */
  repoDir: string;
  /** Tool allowlist for `serve --tools`; empty = expose all 30 tools. */
  tools: string[];
}

export interface OpenCodeConfigBuildOptions {
  autoApprovePermissions?: boolean;
  job?: AgentJob;
  codeReviewGraph?: CodeReviewGraphMcpOptions;
}

export const CODE_REVIEW_GRAPH_BIN = 'code-review-graph';

/** Python process cold-start + SQLite open can exceed OpenCode's 5s default MCP timeout. */
const CODE_REVIEW_GRAPH_MCP_TIMEOUT_MS = 15_000;

export function buildCodeReviewGraphMcpServer(
  options: CodeReviewGraphMcpOptions,
): OpenCodeMcpLocalServer {
  const command = [CODE_REVIEW_GRAPH_BIN, 'serve', '--repo', options.repoDir];
  if (options.tools.length > 0) {
    command.push('--tools', options.tools.join(','));
  }
  return {
    type: 'local',
    command,
    enabled: true,
    timeout: CODE_REVIEW_GRAPH_MCP_TIMEOUT_MS,
  };
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

export function buildModelConfig(modelId: string): OpenCodeModelConfig {
  const entry: OpenCodeModelConfig = { name: modelId };
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

export function buildOpenCodeConfig(
  config: AppConfig,
  options?: OpenCodeConfigBuildOptions,
): OpenCodeConfigFile {
  const providerId = config.opencodeProvider || 'ollama';
  const modelId = config.opencodeModel || 'llama3.2';
  const baseURL = normalizeOpenCodeBaseUrl(config.ollamaBaseUrl);
  const instructionsContent = buildMergedInstructionsContent(config);
  const modelIds = collectLoopModels(config, options?.job);
  const registeredModelIds = Array.from(new Set([modelId, ...modelIds]));

  const file: OpenCodeConfigFile = {
    $schema: 'https://opencode.ai/config.json',
    model: `${providerId}/${modelId}`,
    ...(instructionsContent ? { instructions: [LOCALAGENT_INSTRUCTIONS_FILE] } : {}),
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL },
        models: Object.fromEntries(
          registeredModelIds.map((id) => [id, buildModelConfig(id)]),
        ),
      },
    },
  };

  if (options?.autoApprovePermissions) {
    file.permission = { '*': { '*': 'allow' } };
  }

  if (options?.codeReviewGraph) {
    file.mcp = {
      'code-review-graph': buildCodeReviewGraphMcpServer(options.codeReviewGraph),
    };
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

/** Written into the workspace by `code-review-graph build`; must never land in agent commits. */
export const CODE_REVIEW_GRAPH_DATA_DIR = '.code-review-graph/';

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
  const missing = [OPENCODE_TOOL_INSTRUCTIONS_FILE, CODE_REVIEW_GRAPH_DATA_DIR].filter(
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
  fs?: FsLike;
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
    if (!config.ollamaBaseUrl) {
      return null;
    }

    const opencodeConfig = buildOpenCodeConfig(config, options);
    fsImpl.mkdirSync(configDir, { recursive: true });

    const instructionsContent = buildMergedInstructionsContent(config);
    if (instructionsContent) {
      const instructionsPath = pathImpl.join(configDir, LOCALAGENT_INSTRUCTIONS_FILE);
      fsImpl.writeFileSync(instructionsPath, `${instructionsContent}\n`, 'utf8');
    }

    fsImpl.writeFileSync(configPath, `${JSON.stringify(opencodeConfig, null, 2)}\n`, 'utf8');
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
