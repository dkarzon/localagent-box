import { compactLoopVerbModels, sanitizeLoopVerbModels } from '../../lib/loop-verb-models';
import { validateBranchName, validatePrompt } from '../../lib/validation';
import type { AgentMode } from '../../types';

export interface CreateAgentPayload {
  repoId: string;
  prompt: string;
  systemPrompt?: string;
  baseBranch: string;
  agentBranch: string;
  useExistingBranch?: boolean;
  commitMessage: string;
  push: boolean;
  pushOnFailure: boolean;
  autoApprovePermissions?: boolean;
  model?: string;
  loopVerbModels?: Record<string, string>;
  mode: AgentMode;
  autoCreatePullRequest?: boolean;
  // Review-specific fields (mode: 'review')
  headBranch?: string;
  background?: string;
  parentAgentId?: string;
}

export function parseCreateAgentPayload(
  body: Record<string, unknown>,
  repoContext: { defaultBranch?: string | null },
  agentId: string,
): CreateAgentPayload {
  const mode = (() => {
    const raw = typeof body.mode === 'string' ? (body.mode as AgentMode) : undefined;
    if (raw && ['batch', 'interactive', 'loop', 'review'].includes(raw)) {
      return raw;
    }
    return 'batch';
  })();

  const baseBranch = (() => {
    const val = typeof body.baseBranch === 'string' ? body.baseBranch : repoContext.defaultBranch || 'main';
    return val.trim() || 'main';
  })();

  const agentBranch = validateBranchName(body.agentBranch, agentId);

  const systemPrompt =
    typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
      ? body.systemPrompt.trim()
      : undefined;

  const model = typeof body.model === 'string' ? body.model : undefined;

  const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : undefined;
  const background = typeof body.background === 'string' ? body.background : undefined;
  const parentAgentId = typeof body.parentAgentId === 'string' ? body.parentAgentId.trim() : undefined;

  const isReview = mode === 'review';

  const prompt = isReview
    ? String(typeof body.prompt === 'string' ? body.prompt : '')
    : validatePrompt(body.prompt);

  const loopVerbModels =
    mode === 'loop' && typeof body.loopVerbModels === 'object' && body.loopVerbModels != null
      ? compactLoopVerbModels(sanitizeLoopVerbModels(body.loopVerbModels))
      : undefined;
  const resolvedUseExistingBranch =
    typeof body.useExistingBranch === 'boolean'
      ? body.useExistingBranch
      : isReview
        ? true
        : false;
  const resolvedAgentBranch =
    isReview && headBranch
      ? headBranch
      : resolvedUseExistingBranch
        ? baseBranch
        : agentBranch;

  const commitMessage =
    typeof body.commitMessage === 'string' && body.commitMessage.trim()
      ? body.commitMessage.trim()
      : `Agent: ${resolvedAgentBranch}`;

  return {
    repoId: String(body.repoId || ''),
    prompt,
    systemPrompt,
    baseBranch,
    agentBranch: resolvedAgentBranch,
    useExistingBranch: resolvedUseExistingBranch,
    commitMessage: isReview ? '' : commitMessage,
    push: typeof body.push === 'boolean' ? body.push : isReview ? false : true,
    pushOnFailure: typeof body.pushOnFailure === 'boolean' ? body.pushOnFailure : false,
    autoApprovePermissions:
      typeof body.autoApprovePermissions === 'boolean' ? body.autoApprovePermissions : undefined,
    model,
    loopVerbModels,
    mode,
    autoCreatePullRequest:
      typeof body.autoCreatePullRequest === 'boolean' ? body.autoCreatePullRequest : undefined,
    headBranch,
    background,
    parentAgentId,
  };
}

export function parseMessageText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new Error('text must be a string');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('text cannot be empty');
  }
  return trimmed;
}
