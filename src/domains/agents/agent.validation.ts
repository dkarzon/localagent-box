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

  const agentBranch =
    typeof body.agentBranch === 'string' && body.agentBranch.trim()
      ? body.agentBranch.trim()
      : `agent/${agentId}`;

  const commitMessage =
    typeof body.commitMessage === 'string' && body.commitMessage.trim()
      ? body.commitMessage.trim()
      : '';

  const systemPrompt =
    typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
      ? body.systemPrompt.trim()
      : undefined;

  const model = typeof body.model === 'string' ? body.model : undefined;

  const loopVerbModels =
    typeof body.loopVerbModels === 'object' && body.loopVerbModels != null
      ? (body.loopVerbModels as Record<string, string>)
      : undefined;

  const headBranch = typeof body.headBranch === 'string' ? body.headBranch.trim() : undefined;
  const background = typeof body.background === 'string' ? body.background : undefined;
  const parentAgentId = typeof body.parentAgentId === 'string' ? body.parentAgentId.trim() : undefined;

  return {
    repoId: String(body.repoId || ''),
    prompt: String(typeof body.prompt === 'string' ? body.prompt : ''),
    systemPrompt,
    baseBranch,
    agentBranch,
    useExistingBranch: typeof body.useExistingBranch === 'boolean' ? body.useExistingBranch : undefined,
    commitMessage,
    push: typeof body.push === 'boolean' ? body.push : true,
    pushOnFailure: typeof body.pushOnFailure === 'boolean' ? body.pushOnFailure : false,
    autoApprovePermissions:
      typeof body.autoApprovePermissions === 'boolean' ? body.autoApprovePermissions : undefined,
    model,
    loopVerbModels,
    mode,
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
