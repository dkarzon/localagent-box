import {
  validateBranchName,
  validatePrompt,
  validateModel,
  validateSystemPrompt,
  validateAgentMode,
  validateMessageText,
  validateOptionalBoolean,
} from '../../lib/validation';
import { compactLoopVerbModels, sanitizeLoopVerbModels } from '../../lib/loop-verb-models';
import { validateRepoId } from '../repos/repo.repository';
import type { AgentMode, LoopVerbModels, Repo } from '../../types';

export interface CreateAgentPayload {
  repoId: string;
  prompt: string;
  systemPrompt: string | undefined;
  baseBranch: string;
  agentBranch: string;
  useExistingBranch: boolean;
  commitMessage: string;
  push: boolean;
  pushOnFailure: boolean;
  autoApprovePermissions: boolean | undefined;
  autoCreatePullRequest:
    | boolean
    | undefined;
  model: string | null;
  mode: AgentMode;
  loopVerbModels?: LoopVerbModels;
}

export function parseCreateAgentPayload(
  body: Record<string, unknown>,
  repo: Repo,
  defaultSessionId?: string,
): CreateAgentPayload {
  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim()
      : defaultSessionId;
  const repoId = validateRepoId(body.repoId);
  const prompt = validatePrompt(body.prompt);
  const systemPrompt = validateSystemPrompt(body.systemPrompt);
  const baseBranch = validateBranchName(body.baseBranch || repo.defaultBranch || 'main');
  const useExistingBranch = body.useExistingBranch === true;
  const agentBranch = useExistingBranch
    ? baseBranch
    : validateBranchName(body.agentBranch, sessionId);
  const commitMessage =
    typeof body.commitMessage === 'string' && body.commitMessage.trim()
      ? body.commitMessage.trim()
      : `Agent: ${agentBranch}`;
  const push = body.push !== false;
  const pushOnFailure = body.pushOnFailure === true;
  const autoApprovePermissions = validateOptionalBoolean(body.autoApprovePermissions, 'autoApprovePermissions');
  const autoCreatePullRequest = validateOptionalBoolean(body.autoCreatePullRequest, 'autoCreatePullRequest');
  const model = validateModel(body.model);
  const mode = validateAgentMode(body.mode);
  const loopVerbModels =
    mode === 'loop' && body.loopVerbModels != null
      ? compactLoopVerbModels(sanitizeLoopVerbModels(body.loopVerbModels))
      : undefined;

  return {
    repoId,
    prompt,
    systemPrompt,
    baseBranch,
    agentBranch,
    useExistingBranch,
    commitMessage,
    push,
    pushOnFailure,
    autoApprovePermissions,
    autoCreatePullRequest,
    model,
    mode,
    loopVerbModels,
  };
}

export function parseMessageText(text: unknown): string {
  return validateMessageText(text);
}
