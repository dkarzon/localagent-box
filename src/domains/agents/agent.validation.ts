import { compactLoopVerbModels, sanitizeLoopVerbModels } from '../../lib/loop-verb-models';
import { validateRepoId } from '../repos/repo.repository';
import {
  validateAgentMode,
  validateBranchName,
  validateMessageText,
  validatePrompt,
} from '../../lib/validation';
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
  const mode = validateAgentMode(body.mode);
  const isReview = mode === 'review';

  const baseBranch = (() => {
    const val = typeof body.baseBranch === 'string' ? body.baseBranch : repoContext.defaultBranch || 'main';
    return val.trim() || 'main';
  })();

  const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : undefined;
  const resolvedUseExistingBranch = isReview
    ? true
    : typeof body.useExistingBranch === 'boolean'
      ? body.useExistingBranch
      : false;
  const agentBranch = resolvedUseExistingBranch
    ? ''
    : validateBranchName(body.agentBranch, agentId);

  const systemPrompt =
    typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
      ? body.systemPrompt.trim()
      : undefined;

  const model = typeof body.model === 'string' ? body.model : undefined;

  const background = typeof body.background === 'string' ? body.background : undefined;
  const parentAgentId = typeof body.parentAgentId === 'string' ? body.parentAgentId.trim() : undefined;

  const prompt = isReview
    ? String(typeof body.prompt === 'string' ? body.prompt : '')
    : validatePrompt(body.prompt);

  const loopVerbModels =
    mode === 'loop' && typeof body.loopVerbModels === 'object' && body.loopVerbModels != null
      ? compactLoopVerbModels(sanitizeLoopVerbModels(body.loopVerbModels))
      : undefined;
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
    repoId: validateRepoId(body.repoId),
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
  return validateMessageText(text);
}
