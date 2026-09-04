import { compactLoopVerbModels, sanitizeLoopVerbModels } from '../../lib/loop-verb-models';
import { assertPositiveInteger, validationError } from '../../lib/validation';
import { validateRepoId } from '../repos/repo.repository';
import {
  validateAgentMode,
  validateBranchName,
  validateMessageText,
  validatePrompt,
} from '../../lib/validation';
import type { AgentAutofixMetadata, AgentMode } from '../../types';

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
  loopMaxIterations?: number;
  mode: AgentMode;
  autoCreatePullRequest?: boolean;
  // Review-specific fields (mode: 'review')
  headBranch?: string;
  background?: string;
  parentAgentId?: string;
  // Autofix orchestration metadata (batch agents that fix review findings)
  autofix?: AgentAutofixMetadata;
}

function parseAutofixMetadata(value: unknown): AgentAutofixMetadata | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('autofix must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'automatic' && raw.kind !== 'manual') {
    throw validationError('autofix.kind must be "automatic" or "manual"');
  }
  if (typeof raw.sourceReviewAgentId !== 'string' || !raw.sourceReviewAgentId.trim()) {
    throw validationError('autofix.sourceReviewAgentId is required and must be a string');
  }
  if (Array.isArray(raw.findingIds)) {
    for (const findingId of raw.findingIds) {
      if (typeof findingId !== 'string' || !findingId.trim()) {
        throw validationError('autofix.findingIds entries must be non-empty strings');
      }
    }
  } else {
    throw validationError('autofix.findingIds must be an array of strings');
  }
  if (
    raw.batchIndex !== undefined &&
    (typeof raw.batchIndex !== 'number' ||
      !Number.isInteger(raw.batchIndex) ||
      raw.batchIndex < 0)
  ) {
    throw validationError('autofix.batchIndex must be a non-negative integer');
  }
  return {
    kind: raw.kind,
    sourceReviewAgentId: raw.sourceReviewAgentId.trim(),
    findingIds: (raw.findingIds as unknown[]).map((findingId) => findingId as string),
    batchIndex: typeof raw.batchIndex === 'number' ? raw.batchIndex : undefined,
  };
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
  let loopMaxIterations: number | undefined;
  if (mode === 'loop') {
    if (body.loopMaxIterations !== undefined) {
      loopMaxIterations = assertPositiveInteger(body.loopMaxIterations, 'loopMaxIterations');
    }
  }
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

  const autofix = parseAutofixMetadata(body.autofix);

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
    loopMaxIterations,
    mode,
    autoCreatePullRequest:
      typeof body.autoCreatePullRequest === 'boolean' ? body.autoCreatePullRequest : undefined,
    headBranch,
    background,
    parentAgentId,
    autofix,
  };
}

export function parseMessageText(text: unknown): string {
  return validateMessageText(text);
}
