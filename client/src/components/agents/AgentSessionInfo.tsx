import type {
  Agent,
  AgentBootstrapState,
  AgentCheckRun,
  AgentPullRequest,
  AgentTokenUsage,
  AgentVerification,
  AgentVerificationAttempt,
} from '../../api/types';
import {
  canCreatePullRequest,
  getAgentMode,
  isAgentActive,
  isReviewAgent,
} from '../../api/types';
import { formatDuration, formatRelativeTime, formatTokenCount, formatCost } from '../../lib/format';
import { IconLink, IconLogs, IconRefresh } from '../icons';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Form';
import { AgentGitStatus } from './AgentGitStatus';
import { Link } from 'react-router-dom';

function bootstrapStatusVariant(
  status: AgentBootstrapState['status'],
): 'running' | 'completed' | 'failed' | 'neutral' {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
    default:
      return 'neutral';
  }
}

const VERIFICATION_STATE_LABELS: Record<AgentVerification['state'], string> = {
  unverified: 'Unverified',
  passed: 'Passed',
  failed: 'Failed',
  machine_failure: 'Machine failure',
};

function verificationStatusVariant(
  state: AgentVerification['state'],
): 'verified' | 'failed' | 'danger' | 'neutral' {
  switch (state) {
    case 'passed':
      return 'verified';
    case 'failed':
      return 'failed';
    case 'machine_failure':
      return 'danger';
    default:
      return 'neutral';
  }
}

function checkResultLabel(run: AgentCheckRun): string {
  if (run.timedOut) return 'timed out';
  if (run.exitCode === 0) return 'passed';
  return `exit ${run.exitCode}`;
}

function formatCheckDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function attemptSummary(attempt: AgentVerificationAttempt): string {
  if (attempt.passed) return 'All checks passed';
  const failed = attempt.checks.at(-1);
  const reason = attempt.failureKind === 'machine'
    ? `machine failure (${attempt.machineReason ?? 'unknown'})`
    : 'check failed';
  return `Stopped at ${failed?.name ?? 'unknown'} — ${reason}`;
}

const BOOTSTRAP_STATUS_LABELS: Record<AgentBootstrapState['status'], string> = {
  skipped: 'Skipped',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

function truncateCommand(command: string, max = 80): string {
  return command.length > max ? `${command.slice(0, max)}…` : command;
}

function pullRequestStateVariant(state: string): 'running' | 'completed' | 'failed' | 'neutral' {
  switch (state) {
    case 'open':
      return 'running';
    case 'merged':
      return 'completed';
    case 'closed':
      return 'failed';
    default:
      return 'neutral';
  }
}

export interface AgentSessionInfoProps {
  agent: Agent | null;
  agentId: string;
  repoLabel: string;
  defaultModel: string;
  defaultReviewModel?: string;
  eventsConnected: boolean;
  loadError: string | null;
  prBusy: boolean;
  relatedSessions?: Agent[];
  linkedPullRequest?: AgentPullRequest | null;
  linkedPullRequestUrl?: string | null;
  tokenUsage?: AgentTokenUsage | null;
  onRefreshPullRequest: () => void;
}

export function AgentSessionInfo({
  agent,
  agentId,
  repoLabel,
  defaultModel,
  defaultReviewModel = '',
  eventsConnected,
  loadError,
  prBusy,
  relatedSessions = [],
  linkedPullRequest = null,
  linkedPullRequestUrl = null,
  tokenUsage: tokenUsageOverride = null,
  onRefreshPullRequest,
}: AgentSessionInfoProps) {
  const tokenUsage = tokenUsageOverride ?? agent?.tokenUsage ?? null;
  const review = agent ? isReviewAgent(agent) : false;
  const isActive = agent ? isAgentActive(agent) : false;
  const showCreatePr = agent ? canCreatePullRequest(agent) : false;
  const bootstrap = agent?.bootstrap ?? null;
  const showBootstrap = Boolean(bootstrap && bootstrap.status !== 'skipped');
  // Set only by batch runs: review runs are not verified by host checks.
  const verification = agent?.verification ?? null;
  const showChecks = Boolean(verification);

  const resolveModelLabel = () => {
    if (agent?.model) return agent.model;
    if (review) return defaultReviewModel || defaultModel || 'Settings default';
    return defaultModel || '—';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded bg-primary-container">
          <IconLogs className="size-5 text-on-primary-container" />
        </div>
        <div>
          <p className="text-sm text-on-surface-variant">Repository</p>
          <p className="text-base text-on-surface">{repoLabel}</p>
        </div>
      </div>

      {agent ? (
        <>
          <dl className="space-y-3 text-sm">
            {[
              ['Mode', getAgentMode(agent)],
              ['Model', resolveModelLabel()],
              ...(review
                ? ([
                    ['Base branch', agent.review?.baseBranch || agent.baseBranch || '—'] as const,
                    ['Head branch', agent.review?.headBranch || agent.agentBranch || '—'] as const,
                    ...(agent.review?.prNumber || linkedPullRequestUrl
                      ? ([
                          [
                            'Linked PR',
                            agent.review?.prNumber
                              ? `#${agent.review.prNumber}`
                              : linkedPullRequest
                                ? `#${linkedPullRequest.number}`
                                : 'Open on GitHub',
                          ] as const,
                        ] as const)
                      : []),
                  ] as const)
                : agent.useExistingBranch
                ? ([
                    ['Branch mode', 'Existing branch (push directly)'] as const,
                    [
                      'Branch',
                      agent.baseBranch || agent.agentBranch || agent.branch || '—',
                    ] as const,
                    ...(linkedPullRequest && !agent.pullRequest
                      ? ([['Linked PR', `#${linkedPullRequest.number}`] as const] as const)
                      : []),
                  ] as const)
                : ([
                    ['Base branch', agent.baseBranch || '—'] as const,
                    ['Agent branch', agent.agentBranch || agent.branch || '—'] as const,
                    ...(linkedPullRequest && !agent.pullRequest
                      ? ([['Linked PR', `#${linkedPullRequest.number}`] as const] as const)
                      : []),
                  ] as const)),
              ['Duration', formatDuration(agent.startedAt, agent.finishedAt)],
              ['Started', formatRelativeTime(agent.startedAt || agent.createdAt)],
              ['Workspace', agent.workspaceId || '—'],
              ['Session ID', agent.agentId || agentId],
              ...(agent.queue?.reason ? ([['Queue', agent.queue.reason] as const] as const) : []),
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex flex-col gap-0.5 border-b border-surface-low pb-3 last:border-0 last:pb-0"
              >
                <dt className="text-on-surface-variant">{label}</dt>
                <dd className="code-md break-all text-on-surface">
                  {label === 'Linked PR' && linkedPullRequestUrl ? (
                    <a
                      href={linkedPullRequestUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-primary hover:text-primary-container"
                    >
                      <IconLink className="size-3.5 shrink-0" />
                      {value}
                    </a>
                  ) : (
                    value
                  )}
                </dd>
              </div>
            ))}
          </dl>

          {showBootstrap && bootstrap ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-on-surface">Workspace bootstrap</p>
                <Badge
                  variant={bootstrapStatusVariant(bootstrap.status)}
                  pulse={bootstrap.status === 'running'}
                >
                  {BOOTSTRAP_STATUS_LABELS[bootstrap.status]}
                </Badge>
              </div>
              <dl className="space-y-1.5 text-sm">
                {bootstrap.command ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Command</dt>
                    <dd className="code-md max-w-[50%] truncate text-on-surface" title={bootstrap.command}>
                      {truncateCommand(bootstrap.command)}
                    </dd>
                  </div>
                ) : null}
                {bootstrap.profiles && bootstrap.profiles.length > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Profiles</dt>
                    <dd className="code-md text-on-surface">{bootstrap.profiles.join(', ')}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4">
                  <dt className="text-on-surface-variant">Duration</dt>
                    <dd className="code-md text-on-surface">{bootstrap.durationMs != null ? `${(Math.max(0, bootstrap.durationMs) / 1000).toFixed(1)}s` : '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-on-surface-variant">Exit code</dt>
                  <dd className="code-md text-on-surface">{bootstrap.exitCode ?? '—'}</dd>
                </div>
              </dl>
              {bootstrap.status === 'failed' && bootstrap.error ? (
                <p className="mt-2 text-xs text-error">{bootstrap.error}</p>
              ) : null}
            </div>
          ) : null}

          {showChecks && verification ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-on-surface">Checks</p>
                <Badge variant={verificationStatusVariant(verification.state)}>
                  {VERIFICATION_STATE_LABELS[verification.state]}
                </Badge>
              </div>
              <p className="mb-3 text-xs text-muted">
                {verification.configSource === 'base'
                  ? 'Config from the base branch'
                  : 'No checks configured'}
                {verification.maxRepairAttempts > 0
                  ? ` · up to ${verification.maxRepairAttempts} repair attempt(s)`
                  : ''}
              </p>

              {verification.attempts.length === 0 ? (
                <p className="text-xs text-muted">No checks have run yet.</p>
              ) : null}

              <ul className="space-y-3">
                {verification.attempts.map((attempt) => (
                  <li
                    key={attempt.attempt}
                    className="rounded border border-surface-low bg-surface-low p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-sm text-on-surface">
                        Attempt {attempt.attempt === 0 ? 'after the task' : attempt.attempt}
                      </p>
                      <span
                        className={`code-md text-xs ${attempt.passed ? 'text-success' : 'text-error'}`}
                      >
                        {attemptSummary(attempt)}
                      </span>
                    </div>
                    <ul className="space-y-2">
                      {attempt.checks.map((run) => (
                        <li key={`${attempt.attempt}-${run.name}`} className="text-sm">
                          <div className="flex justify-between gap-4">
                            <dt className="text-on-surface-variant">{run.name}</dt>
                            <dd className="code-md text-on-surface">
                              <span
                                className={
                                  run.timedOut || run.exitCode !== 0 ? 'text-error' : 'text-success'
                                }
                              >
                                {checkResultLabel(run)}
                              </span>
                              {' · '}
                              {formatCheckDuration(run.durationMs)}
                            </dd>
                          </div>
                          <p className="code-md mt-1 break-all text-on-surface-variant">
                            {run.command}
                          </p>
                          {run.outputTail ? (
                            <details className="mt-1">
                              <summary className="label-md normal-case tracking-wide text-muted">
                                Output
                              </summary>
                              <pre className="code-md mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-on-surface-variant">
                                {run.outputTail}
                              </pre>
                            </details>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {tokenUsage ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <p className="mb-2 text-sm font-medium text-on-surface">Token usage</p>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-on-surface-variant">Input</dt>
                  <dd className="code-md text-on-surface">{formatTokenCount(tokenUsage.inputTokens)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-on-surface-variant">Output</dt>
                  <dd className="code-md text-on-surface">{formatTokenCount(tokenUsage.outputTokens)}</dd>
                </div>
                {tokenUsage.cacheReadTokens != null && tokenUsage.cacheReadTokens > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Cache read</dt>
                    <dd className="code-md text-on-surface">{formatTokenCount(tokenUsage.cacheReadTokens)}</dd>
                  </div>
                ) : null}
                {tokenUsage.cacheWriteTokens != null && tokenUsage.cacheWriteTokens > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Cache write</dt>
                    <dd className="code-md text-on-surface">{formatTokenCount(tokenUsage.cacheWriteTokens)}</dd>
                  </div>
                ) : null}
                {tokenUsage.cost != null ? (
                  <div className="flex justify-between gap-4 border-t border-surface-low pt-1.5">
                    <dt
                      className="text-on-surface-variant"
                      title={tokenUsage.costEstimated ? 'Computed from configured token rates' : undefined}
                    >
                      {tokenUsage.costEstimated ? 'Cost (est.)' : 'Cost'}
                    </dt>
                    <dd className="code-md text-on-surface">{formatCost(tokenUsage.cost)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}

          {agent.review?.background ? (
            <div>
              <p className="mb-2 text-sm text-on-surface-variant">Review context</p>
              <p className="rounded bg-background p-3 text-sm text-on-surface whitespace-pre-wrap">
                {agent.review.background}
              </p>
            </div>
          ) : null}

          {relatedSessions.length > 0 ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <p className="mb-2 text-sm font-medium text-on-surface">Related sessions</p>
              <ul className="space-y-2 text-sm">
                {relatedSessions.map((entry) => (
                  <li key={entry.agentId}>
                    <Link
                      to={`/agents/${entry.agentId}`}
                      className="text-primary hover:text-primary-container"
                    >
                      {isReviewAgent(entry) ? 'Review' : getAgentMode(entry)} #{entry.agentId}
                    </Link>
                    <span className="ml-2 text-xs text-muted">{entry.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {agent.prompt ? (
            <div>
              <p className="mb-2 text-sm text-on-surface-variant">Initial prompt</p>
              <p className="rounded bg-background p-3 text-sm text-on-surface whitespace-pre-wrap">
                {agent.prompt}
              </p>
            </div>
          ) : null}

          {agent.gitStatus ? <AgentGitStatus status={agent.gitStatus} /> : null}

          <p className="text-xs text-muted">
            {eventsConnected
              ? 'Live events connected'
              : isActive
                ? 'Reconnecting to live events…'
                : 'Session ended'}
          </p>

          {agent.error ? (
            <p className="text-sm text-error">{agent.error}</p>
          ) : agent.result?.warning ? (
            <p className="text-sm text-warning">{agent.result.warning}</p>
          ) : null}

          {agent.status === 'completed' && agent.commitSha ? (
            <p className="code-md text-xs text-muted">
              Commit {agent.commitSha.slice(0, 7)}
              {agent.filesChanged != null ? ` · ${agent.filesChanged} files` : ''}
              {agent.pushed ? ' · pushed' : ''}
            </p>
          ) : null}

          {agent.pullRequest ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-on-surface">Pull request</p>
                <Badge variant={pullRequestStateVariant(agent.pullRequest.state)}>
                  {agent.pullRequest.state}
                </Badge>
              </div>
              <a
                href={agent.pullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-container"
              >
                <IconLink className="size-3.5 shrink-0" />
                #{agent.pullRequest.number} — {agent.pullRequest.title}
              </a>
              <p className="mt-2 text-xs text-muted">
                Opened {formatRelativeTime(agent.pullRequest.createdAt)}
                {agent.pullRequest.mergedAt
                  ? ` · merged ${formatRelativeTime(agent.pullRequest.mergedAt)}`
                  : ''}
              </p>
              <Button
                variant="ghost"
                className="mt-3 !gap-2 !px-0"
                disabled={prBusy}
                onClick={onRefreshPullRequest}
              >
                <IconRefresh className="size-3.5" />
                Refresh status
              </Button>
            </div>
          ) : linkedPullRequest ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-on-surface">Pull request</p>
                <Badge variant={pullRequestStateVariant(linkedPullRequest.state)}>
                  {linkedPullRequest.state}
                </Badge>
              </div>
              <a
                href={linkedPullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-container"
              >
                <IconLink className="size-3.5 shrink-0" />
                #{linkedPullRequest.number} — {linkedPullRequest.title}
              </a>
              <p className="mt-2 text-xs text-muted">
                Open on this branch from another session in the chain.
                {linkedPullRequest.createdAt
                  ? ` Opened ${formatRelativeTime(linkedPullRequest.createdAt)}`
                  : ''}
              </p>
            </div>
          ) : showCreatePr ? (
            <p className="text-sm text-on-surface-variant">
              OpenCode finished and the branch was pushed. Create a pull request to merge these
              changes.
            </p>
          ) : agent.status === 'completed' && agent.result?.opencodeSuccess && !agent.pushed ? (
            <p className="text-sm text-on-surface-variant">
              OpenCode completed but the branch was not pushed. Enable push on future sessions to
              create a pull request.
            </p>
          ) : review && agent.status === 'completed' ? (
            <p className="text-sm text-on-surface-variant">
              Review completed. Results are shown in the conversation panel
              {agent.review?.prNumber ? (
                <>
                  {' '}
                  and posted to{' '}
                  {linkedPullRequestUrl ? (
                    <a
                      href={linkedPullRequestUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary-container"
                    >
                      PR #{agent.review.prNumber} on GitHub
                    </a>
                  ) : (
                    `PR #${agent.review.prNumber} on GitHub`
                  )}
                </>
              ) : null}
              .
            </p>
          ) : null}
        </>
      ) : loadError ? null : (
        <p className="text-sm text-muted">Loading session…</p>
      )}
    </div>
  );
}
