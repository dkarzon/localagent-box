import type { Agent } from '../../api/types';
import {
  canCreatePullRequest,
  getAgentMode,
  isAgentActive,
  isInteractiveAgent,
  isLoopAgent,
  LOOP_VERB_LABELS,
  LOOP_VERBS,
} from '../../api/types';
import { formatDuration, formatRelativeTime, formatTokenCount, formatCost } from '../../lib/format';
import { IconLink, IconLogs, IconRefresh } from '../icons';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Form';
import { AgentGitStatus } from './AgentGitStatus';

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
  loopProgress: string | null;
  eventsConnected: boolean;
  loadError: string | null;
  prBusy: boolean;
  onRefreshPullRequest: () => void;
}

export function AgentSessionInfo({
  agent,
  agentId,
  repoLabel,
  defaultModel,
  loopProgress,
  eventsConnected,
  loadError,
  prBusy,
  onRefreshPullRequest,
}: AgentSessionInfoProps) {
  const interactive = agent ? isInteractiveAgent(agent) : false;
  const loop = agent ? isLoopAgent(agent) : false;
  const isActive = agent ? isAgentActive(agent) : false;
  const showCreatePr = agent ? canCreatePullRequest(agent) : false;

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
              [
                'Model',
                loop
                  ? agent.model || 'Settings / global default'
                  : agent.model || defaultModel || '—',
              ],
              ...(agent.useExistingBranch
                ? ([
                    ['Branch mode', 'Existing branch (push directly)'] as const,
                    [
                      'Branch',
                      agent.baseBranch || agent.agentBranch || agent.branch || '—',
                    ] as const,
                  ] as const)
                : ([
                    ['Base branch', agent.baseBranch || '—'] as const,
                    ['Agent branch', agent.agentBranch || agent.branch || '—'] as const,
                  ] as const)),
              ['Duration', formatDuration(agent.createdAt, agent.finishedAt)],
              ['Started', formatRelativeTime(agent.createdAt)],
              ['Workspace', agent.workspaceId || '—'],
              ['Session ID', agent.agentId || agentId],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex flex-col gap-0.5 border-b border-surface-low pb-3 last:border-0 last:pb-0"
              >
                <dt className="text-on-surface-variant">{label}</dt>
                <dd className="code-md break-all text-on-surface">{value}</dd>
              </div>
            ))}
          </dl>

          {agent.tokenUsage ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <p className="mb-2 text-sm font-medium text-on-surface">Token usage</p>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-on-surface-variant">Input</dt>
                  <dd className="code-md text-on-surface">{formatTokenCount(agent.tokenUsage.inputTokens)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-on-surface-variant">Output</dt>
                  <dd className="code-md text-on-surface">{formatTokenCount(agent.tokenUsage.outputTokens)}</dd>
                </div>
                {agent.tokenUsage.cacheReadTokens != null && agent.tokenUsage.cacheReadTokens > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Cache read</dt>
                    <dd className="code-md text-on-surface">{formatTokenCount(agent.tokenUsage.cacheReadTokens)}</dd>
                  </div>
                ) : null}
                {agent.tokenUsage.cacheWriteTokens != null && agent.tokenUsage.cacheWriteTokens > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">Cache write</dt>
                    <dd className="code-md text-on-surface">{formatTokenCount(agent.tokenUsage.cacheWriteTokens)}</dd>
                  </div>
                ) : null}
                {agent.tokenUsage.cost != null ? (
                  <div className="flex justify-between gap-4 border-t border-surface-low pt-1.5">
                    <dt className="text-on-surface-variant">Cost</dt>
                    <dd className="code-md text-on-surface">{formatCost(agent.tokenUsage.cost)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}

          {agent.prompt ? (
            <div>
              <p className="mb-2 text-sm text-on-surface-variant">
                {loop ? 'Goal' : 'Initial prompt'}
              </p>
              <p className="rounded bg-background p-3 text-sm text-on-surface whitespace-pre-wrap">
                {agent.prompt}
              </p>
            </div>
          ) : null}

          {loop && agent.loopVerbModels && Object.keys(agent.loopVerbModels).length > 0 ? (
            <details className="rounded border border-surface-container-highest bg-background p-4">
              <summary className="cursor-pointer text-sm font-medium text-on-surface">
                Models for this run
              </summary>
              <dl className="mt-3 space-y-2 text-sm">
                {LOOP_VERBS.filter((verb) => agent.loopVerbModels?.[verb]?.trim()).map((verb) => (
                  <div key={verb} className="flex justify-between gap-4">
                    <dt className="text-on-surface-variant">{LOOP_VERB_LABELS[verb].label}</dt>
                    <dd className="code-md text-right text-on-surface">{agent.loopVerbModels?.[verb]}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-muted">
                Run overrides only; other steps use Settings or the fallback model.
              </p>
            </details>
          ) : null}

          {loop && agent.loop ? (
            <div className="rounded border border-surface-container-highest bg-background p-4">
              <p className="mb-2 text-sm font-medium text-on-surface">Loop progress</p>
              <p className="text-sm text-on-surface-variant">{loopProgress}</p>
              {agent.loop.finishRequested ? (
                <p className="mt-2 text-xs text-muted">Finish requested — completing current step</p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                Harness: {agent.loop.configSource === 'repo-override' ? 'repo override' : 'server default'}
                {agent.loop.stepsInIteration > 0 ? (
                  <>
                    {' · '}
                    {agent.loop.stepsInIteration} step(s) per iteration
                  </>
                ) : null}
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
          ) : loop && isActive ? (
            <p className="text-sm text-on-surface-variant">
              Loop mode runs observe → plan → act → reflect cycles until the model signals completion
              or caps are hit. Use Finish to commit partial progress after the current step.
            </p>
          ) : interactive && isActive ? (
            <p className="text-sm text-on-surface-variant">
              Use Finish when you are ready to commit and push changes. Interactive sessions do not
              auto-commit after each turn.
            </p>
          ) : null}
        </>
      ) : loadError ? null : (
        <p className="text-sm text-muted">Loading session…</p>
      )}
    </div>
  );
}
