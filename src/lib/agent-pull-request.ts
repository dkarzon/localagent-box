import type {
  Agent,
  AgentCheckRun,
  AgentPullRequest,
  AgentStatus,
  AgentVerification,
  CheckName,
} from '../types';

export interface GitHubPullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  title: string;
  created_at: string;
  merged_at: string | null;
  updated_at: string;
  head?: { sha?: string; ref?: string };
}

export function mapGitHubPullRequest(pr: GitHubPullRequestResponse): AgentPullRequest {
  const state: AgentPullRequest['state'] =
    pr.merged_at != null ? 'merged' : pr.state === 'open' ? 'open' : 'closed';

  return {
    number: pr.number,
    url: pr.html_url,
    state,
    title: pr.title,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    updatedAt: pr.updated_at,
  };
}

export function canCreatePullRequest(agent: Agent): boolean {
  if (!agent.pushed || agent.pullRequest) {
    return false;
  }
  // A run that completed on its no-change explanation has no branch work to review.
  if (agent.result?.noChange) {
    return false;
  }
  if (agent.status === 'completed') {
    return agent.result?.opencodeSuccess === true;
  }
  // Checks still failing: a draft PR is opened only when the repo asked for one (v1 1.2).
  return agent.status === 'needs_attention' && agent.verification?.draftPrOnFailure === true;
}

export function buildDefaultPullRequestTitle(agent: Agent): string {
  if (agent.commitMessage?.trim()) {
    return agent.commitMessage.trim();
  }
  const branch = agent.agentBranch || agent.branch;
  if (branch) {
    return `Agent: ${branch}`;
  }
  return `Agent session ${agent.agentId}`;
}

export function buildPullRequestMetadataSection(agent: Agent, base?: string): string {
  const lines = ['Created from a Local Agent Box session.', ''];

  const branch = agent.agentBranch || agent.branch;
  if (branch) {
    lines.push(`**Branch:** \`${branch}\``);
  }
  const mergeBase = base ?? agent.baseBranch;
  if (mergeBase) {
    lines.push(`**Base:** \`${mergeBase}\``);
  }
  if (agent.commitSha) {
    lines.push(`**Commit:** \`${agent.commitSha.slice(0, 7)}\``);
  }
  lines.push(`**Session:** \`${agent.agentId}\``);
  const models = agent.modelsUsed && agent.modelsUsed.length > 0
    ? agent.modelsUsed.filter((m): m is string => !!m)
    : [];

  if (models.length > 0) {
    const formatted = models.map((m) => `\`${m}\``).join(', ');
    lines.push(`**Models:** ${formatted}`);
  } else if (agent.model) {
    lines.push(`**Model:** \`${agent.model}\``);
  }

  return lines.join('\n');
}

export function buildDefaultPullRequestBody(agent: Agent, base?: string): string {
  const parts: string[] = [];

  if (agent.prompt?.trim()) {
    parts.push(`## Prompt\n\n${agent.prompt.trim()}`);
  }

  // The `---` rule is the separator the host test plan is inserted before.
  parts.push('---');
  parts.push(buildPullRequestMetadataSection(agent, base));

  return parts.join('\n\n');
}

/** The `## Test plan` note for a run the host could not verify (v1 1.4). */
function buildUnverifiedTestPlan(reason: string): string {
  return `## Test plan\n\n⚠️ Unverified — ${reason}`;
}

function formatCheckResultCell(run: AgentCheckRun): string {
  if (run.timedOut) {
    return '⏱ timed out';
  }
  if (run.exitCode === 0) {
    return '✅ passed';
  }
  return `❌ exit ${run.exitCode}`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/**
 * The test plan the host writes from the checks it actually ran (v1 1.4). A model
 * cannot claim what was tested, so this replaces whatever the model wrote.
 *
 * `status` is optional: when omitted, a `failed` verification is read as needing
 * attention, which is the status `resolveBatchCompletionStatus` reports for it.
 */
export function buildHostTestPlanSection(
  verification: AgentVerification | null | undefined,
  status?: AgentStatus,
): string {
  if (!verification || verification.configSource === 'none') {
    return buildUnverifiedTestPlan(
      'no build/lint/test checks are configured for this repo (`.localagent-box/environment.json` on the base branch).',
    );
  }

  const attempts = verification.attempts;
  if (attempts.length === 0) {
    return buildUnverifiedTestPlan('the configured checks did not run.');
  }

  const lastAttempt = attempts[attempts.length - 1];
  const ranInAttempts = (name: CheckName): number =>
    attempts.filter((attempt) => attempt.checks.some((check) => check.name === name)).length;

  const lines = [
    '## Test plan',
    '',
    '| Check | Command | Result | Attempts |',
    '| --- | --- | --- | --- |',
  ];

  for (const run of lastAttempt.checks) {
    lines.push(
      `| ${run.name} | \`${escapeTableCell(run.command)}\` | ${formatCheckResultCell(run)} | ${ranInAttempts(run.name)} |`,
    );
  }

  // Attempt 0 is the task turn, so repairs are the attempts after it.
  lines.push('', `Repair attempts: ${Math.max(attempts.length - 1, 0)} of ${verification.maxRepairAttempts}`);

  const stillFailing = status === 'needs_attention' || verification.state === 'failed';
  if (stillFailing) {
    lines.push('', '**Checks still failing — this draft PR needs attention.**');
  }

  return lines.join('\n');
}

/**
 * Drop a `## Test plan` section the model wrote, from the heading to the next
 * `## ` heading or `---` rule (v1 1.4). The host section replaces it.
 */
export function stripModelTestPlanSection(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^##[ \t]+test plan\b/i.test(line.trim()));
  if (start === -1) {
    return body;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##[ \t]/.test(line) || /^---\s*$/.test(line.trim())) {
      end = index;
      break;
    }
  }

  const head = lines.slice(0, start).join('\n').trimEnd();
  const tail = lines.slice(end).join('\n').trimStart();

  return [head, tail].filter((part) => part.length > 0).join('\n\n');
}

/**
 * Final PR body: the model content with its test plan removed, the host test plan,
 * then the session metadata `---` block (v1 1.4).
 */
export function buildPullRequestBodyWithHostTestPlan(agent: Agent, body: string): string {
  const content = stripModelTestPlanSection(body).trim();
  const lines = content.split('\n');

  let footerIndex = -1;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (/^---\s*$/.test(lines[index].trim())) {
      footerIndex = index;
      break;
    }
  }

  const head = footerIndex === -1
    ? content.trimEnd()
    : lines.slice(0, footerIndex).join('\n').trimEnd();
  const footer = footerIndex === -1 ? '' : lines.slice(footerIndex).join('\n').trimStart();

  return [head, buildHostTestPlanSection(agent.verification, agent.status), footer]
    .filter((part) => part.length > 0)
    .join('\n\n');
}
