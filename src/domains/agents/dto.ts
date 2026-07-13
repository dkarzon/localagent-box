import type { AgentMode } from '../../types';
import z from 'zod';

export interface CreateAgentRequest {
  repoId: string;
  prompt: string;
  systemPrompt?: string;
  baseBranch?: string;
  agentBranch?: string;
  useExistingBranch?: boolean;
  commitMessage?: string;
  push?: boolean;
  pushOnFailure?: boolean;
  model?: string | null;
  loopVerbModels?: Record<string, string>;
  mode?: 'batch' | 'interactive' | 'loop';
  sessionId?: string;
}

export const createAgentRequestSchema = z.object({
  repoId: z.string().min(1),
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  baseBranch: z.string().optional(),
  agentBranch: z.string().optional(),
  useExistingBranch: z.boolean().optional(),
  commitMessage: z.string().optional(),
  push: z.boolean().optional(),
  pushOnFailure: z.boolean().optional(),
  model: z.union([z.string(), z.null()]).optional(),
  loopVerbModels: z.record(z.string()).optional(),
  mode: z.enum(['batch', 'interactive', 'loop']).optional(),
  sessionId: z.string().optional(),
});

export const LOOP_VERB_KEYS = ['INITIAL_PLAN', 'OBSERVE', 'PLAN', 'ACT', 'REFLECT'] as const;

export type ZodParsed = z.infer<typeof createAgentRequestSchema>;

export function validateCreateAgentRequest(raw: unknown): CreateAgentRequest {
  const result = createAgentRequestSchema.parse(raw);
  // Zod-parse output structurally matches CreateAgentRequest; narrow via exhaustive assignment
  return {
    repoId: result.repoId,
    prompt: result.prompt,
    systemPrompt: result.systemPrompt,
    baseBranch: result.baseBranch,
    agentBranch: result.agentBranch,
    useExistingBranch: result.useExistingBranch,
    commitMessage: result.commitMessage,
    push: result.push,
    pushOnFailure: result.pushOnFailure,
    model: result.model,
    loopVerbModels: result.loopVerbModels ?? undefined,
    mode: result.mode ,
    sessionId: result.sessionId,
  };
}

export interface CreateAgentResponse {
  agentId: string;
  workspaceId: string;
  repoId: string;
  mode: AgentMode;
  status: string;
  createdAt: string;
  baseBranch: string;
  agentBranch: string;
}

export interface SendMessageRequest {
  text: unknown;
}

export interface CreatePullRequestRequest {
  title?: unknown;
  body?: unknown;
}

export interface ListAgentsQuery {
  repoId?: string | null;
  status?: string | null;
}

export function toCreateAgentResponse(agent: {
  agentId: string;
  workspaceId: string;
  repoId: string;
  mode?: AgentMode;
  status: string;
  createdAt: string;
  baseBranch: string;
  agentBranch: string;
}): CreateAgentResponse {
  return {
    agentId: agent.agentId,
    workspaceId: agent.workspaceId,
    repoId: agent.repoId,
    mode: agent.mode || 'batch',
    status: agent.status,
    createdAt: agent.createdAt,
    baseBranch: agent.baseBranch,
    agentBranch: agent.agentBranch,
  };
}

export function parseCreatePullRequestOptions(body: Record<string, unknown>): {
  title?: string;
  body?: string;
} {
  return {
    title: typeof body.title === 'string' ? body.title : undefined,
    body: typeof body.body === 'string' ? body.body : undefined,
  };
}
