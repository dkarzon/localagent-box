import type { Agent, AgentEvent, AgentMessage, AppConfig } from '../types';
import type { OllamaChatService } from '../services/ollama-client';
import { enrichMessagesWithAssistantFromEvents } from './assistant-text';
import { buildPullRequestMetadataSection } from './agent-pull-request';
import { getLogger } from './logger';

const MAX_TITLE_LENGTH = 256;
const MAX_DIFF_PATCH_CHARS = 12_000;
const MAX_LOG_CHARS = 4_000;
const MAX_CONVERSATION_CHARS = 6_000;

export interface PullRequestGenerationContext {
  agent: Agent;
  base: string;
  repoOwner: string;
  repoName: string;
  messages: AgentMessage[];
  diffStat: string | null;
  diffPatch: string | null;
  logExcerpt: string | null;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function formatConversationExcerpt(messages: AgentMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  const lines = messages.map((message) => {
    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    return `${role}: ${message.text.trim()}`;
  });

  return truncateText(lines.join('\n\n'), MAX_CONVERSATION_CHARS);
}

export function extractAssistantSummary(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.text.trim()) {
      return message.text.trim();
    }
  }
  return null;
}

export function resolvePullRequestMessages(
  messages: AgentMessage[],
  events: AgentEvent[],
): AgentMessage[] {
  return enrichMessagesWithAssistantFromEvents(messages, events);
}

export function buildPullRequestGenerationPrompt(ctx: PullRequestGenerationContext): string {
  const branch = ctx.agent.agentBranch || ctx.agent.branch;
  const lines = [
    'Write a GitHub pull request title and markdown description for the code changes below.',
    'Use an imperative, specific title (max 72 characters when possible).',
    'The description must include ## Summary and ## Test plan sections with concrete bullets.',
    'Base the content on the task, agent summary, commit message, and diff — not generic filler.',
    'Respond with JSON only: {"title":"...","body":"..."}',
    '',
    `Repository: ${ctx.repoOwner}/${ctx.repoName}`,
  ];

  if (branch) {
    lines.push(`Head branch: ${branch}`);
  }
  lines.push(`Base branch: ${ctx.base}`);

  if (ctx.agent.prompt?.trim()) {
    lines.push('', '## Task', ctx.agent.prompt.trim());
  }

  if (ctx.agent.commitMessage?.trim()) {
    lines.push('', '## Commit message', ctx.agent.commitMessage.trim());
  }

  const assistantSummary = extractAssistantSummary(ctx.messages);
  if (assistantSummary) {
    lines.push('', '## Agent summary', truncateText(assistantSummary, 3_000));
  }

  const conversation = formatConversationExcerpt(ctx.messages);
  if (conversation) {
    lines.push('', '## Conversation', conversation);
  }

  if (ctx.diffStat?.trim()) {
    lines.push('', '## Diff stat', ctx.diffStat.trim());
  }

  if (ctx.diffPatch?.trim()) {
    lines.push('', '## Diff patch', ctx.diffPatch.trim());
  }

  if (ctx.logExcerpt?.trim()) {
    lines.push('', '## Agent log excerpt', ctx.logExcerpt.trim());
  }

  if (ctx.agent.filesChanged != null) {
    lines.push('', `Files changed: ${ctx.agent.filesChanged}`);
  }

  return lines.join('\n');
}

export function parsePullRequestGenerationResponse(
  text: string,
): { title: string; body: string } | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const body = typeof record.body === 'string' ? record.body.trim() : '';

  if (!title || !body) {
    return null;
  }

  return {
    title: title.slice(0, MAX_TITLE_LENGTH),
    body,
  };
}

export function enrichGeneratedPullRequestBody(body: string, agent: Agent, base: string): string {
  const metadata = buildPullRequestMetadataSection(agent, base);
  return `${body.trim()}\n\n---\n\n${metadata}`;
}

function normalizeOllamaModelId(model: string): string {
  return model.trim().replace(/^ollama\//i, '');
}

/** Prefer the model that actually ran the agent over the global Settings default. */
export function resolvePullRequestModel(agent: Agent, config: AppConfig): string {
  if (agent.model?.trim()) {
    return normalizeOllamaModelId(agent.model);
  }

  const modelsUsed = agent.modelsUsed?.filter((model): model is string => !!model?.trim()) ?? [];
  if (modelsUsed.length > 0) {
    return normalizeOllamaModelId(modelsUsed[modelsUsed.length - 1]);
  }

  if (config.opencodeModel?.trim()) {
    return normalizeOllamaModelId(config.opencodeModel);
  }

  return '';
}

export async function generatePullRequestContent(
  ollamaChat: OllamaChatService,
  config: AppConfig,
  ctx: PullRequestGenerationContext,
): Promise<{ title: string; body: string } | null> {
  const log = getLogger();
  const agentId = ctx.agent.agentId;

  if (!config.ollamaBaseUrl?.trim()) {
    log.debug(
      { agentId },
      'Skipping PR LLM generation: ollamaBaseUrl is not configured',
    );
    return null;
  }

  const model = resolvePullRequestModel(ctx.agent, config);
  if (!model) {
    log.warn(
      { agentId },
      'Skipping PR LLM generation: no model configured (set opencodeModel in Settings or model on the agent)',
    );
    return null;
  }

  const systemPrompt =
    'You write concise, accurate GitHub pull request titles and markdown descriptions for software changes. Output valid JSON only.';

  try {
    log.debug(
      { agentId, model, ollamaBaseUrl: config.ollamaBaseUrl },
      'Generating PR title and body with local LLM',
    );

    const result = await ollamaChat.generateText(
      config,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildPullRequestGenerationPrompt(ctx) },
      ],
      model,
    );

    if (!result.text.trim()) {
      log.warn(
        { agentId, model },
        'PR LLM generation returned empty text',
      );
      return null;
    }

    const parsed = parsePullRequestGenerationResponse(result.text);
    if (!parsed) {
      log.warn(
        {
          agentId,
          model,
          responsePreview: result.text.slice(0, 500),
          responseLength: result.text.length,
        },
        'PR LLM response could not be parsed as JSON title/body',
      );
      return null;
    }

    return {
      title: parsed.title,
      body: enrichGeneratedPullRequestBody(parsed.body, ctx.agent, ctx.base),
    };
  } catch (err) {
    log.warn(
      { err, agentId, model, ollamaBaseUrl: config.ollamaBaseUrl },
      'PR LLM generation request failed',
    );
    return null;
  }
}

export { MAX_DIFF_PATCH_CHARS, MAX_LOG_CHARS };
