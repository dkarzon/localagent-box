import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createAgentPullRequest,
  deleteAgentSession,
  refreshAgentPullRequest,
  retryAgentSession,
  allowAgentSuccessors,
} from '../api/agents';
import {
  fetchAgentReviewResult,
  type AgentReviewResultResponse,
} from '../api/agent-session';
import { apiFetch, authHeaders } from '../api/client';
import {
  agentModeBadgeVariant,
  canCreatePullRequest,
  canReviewBranches,
  getAgentMode,
  isAgentActive,
  isReviewAgent,
  queueOnBranchPrefill,
  type Agent,
  type AppConfig,
  type QueueOnBranchPrefill,
  type Repo,
  type StatusVariant,
} from '../api/types';
import type { TranscriptEntry } from '../api/agent-events';
import { AgentComposer } from '../components/agents/AgentComposer';
import { AgentLogPanel } from '../components/agents/AgentLogPanel';
import { AgentSessionInfo } from '../components/agents/AgentSessionInfo';
import { AgentTranscript } from '../components/agents/AgentTranscript';
import { IconGithub, IconInfo, IconLink, IconRefresh } from '../components/icons';
import { Badge, agentStatusPulse, agentStatusVariant } from '../components/ui/Badge';
import { FlyoutPanel } from '../components/ui/FlyoutPanel';
import { Button, FormActions } from '../components/ui/Form';
import { StatusMessage } from '../components/ui/StatusMessage';
import { useApiToken } from '../hooks/useApiToken';
import { useAgentSession } from '../hooks/useAgentSession';
import { usePolling } from '../hooks/usePolling';

interface AgentSessionPageProps {
  agentId: string;
  repos: Repo[];
  onQueueAnother?: (prefill: QueueOnBranchPrefill) => void;
}

const LOG_TAIL = 500;

function buildReviewTranscriptEntries(
  review: AgentReviewResultResponse,
  agent: Agent,
  finishedAt?: string | null,
): TranscriptEntry[] {
  const ts = finishedAt || new Date().toISOString();
  const entries: TranscriptEntry[] = [];

  const baseBranch = agent.review?.baseBranch || agent.baseBranch;
  const headBranch = agent.review?.headBranch || agent.agentBranch || agent.branch;
  const backgroundParts: string[] = [];
  if (baseBranch && headBranch) {
    backgroundParts.push(`Review branches \`${baseBranch}\` → \`${headBranch}\`.`);
  } else if (headBranch) {
    backgroundParts.push(`Review branch \`${headBranch}\`.`);
  }
  const background = agent.review?.background?.trim();
  if (background) {
    backgroundParts.push('', '**Review context**', '', background);
  }
  if (backgroundParts.length > 0) {
    entries.push({
      id: 'review-context',
      role: 'user',
      text: backgroundParts.join('\n').trim(),
      ts: agent.createdAt || ts,
    });
  }

  entries.push({
    id: 'review-summary',
    role: 'assistant',
    text: review.markdown,
    ts,
  });

  if (review.sessionMarkdown) {
    entries.push({
      id: 'review-session',
      role: 'assistant',
      text: review.sessionMarkdown,
      ts,
    });
  }

  entries.push({
    id: 'review-raw-json',
    role: 'assistant',
    text: [
      '<details>',
      '<summary>Raw OCR output</summary>',
      '',
      '```json',
      JSON.stringify(review.result, null, 2),
      '```',
      '',
      '</details>',
    ].join('\n'),
    ts,
  });

  return entries;
}

function composerDisabledReason(agent: Agent): string | undefined {
  if (agent.status === 'queued' && agent.queue?.reason) return agent.queue.reason;
  if (agent.status === 'processing') return 'The agent is processing your request…';
  if (agent.status === 'running' || agent.status === 'queued') return 'Session is starting…';
  if (agent.status === 'completing') return 'Finishing session — commit in progress…';
  if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
    return 'Session has ended.';
  }
  return undefined;
}

export function AgentSessionPage({ agentId, repos, onQueueAnother }: AgentSessionPageProps) {
  const navigate = useNavigate();
  const { token } = useApiToken();
  const session = useAgentSession({ agentId, token });

  const [logs, setLogs] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [followTail, setFollowTail] = useState(true);
  const [prBusy, setPrBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [relatedSessions, setRelatedSessions] = useState<Agent[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [allAgentsLoaded, setAllAgentsLoaded] = useState(false);
  const [showDebugLogs, setShowDebugLogs] = useState(false);
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const [pageStatus, setPageStatus] = useState('');
  const [pageStatusVariant, setPageStatusVariant] = useState<StatusVariant>('');
  const [reviewResult, setReviewResult] = useState<AgentReviewResultResponse | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const desktopHeaderRef = useRef<HTMLDivElement>(null);
  const mobileHeaderRef = useRef<HTMLElement>(null);
  const [desktopHeaderHeight, setDesktopHeaderHeight] = useState(0);
  const [mobileHeaderHeight, setMobileHeaderHeight] = useState(0);

  const agent = session.agent;
  const interactive = session.interactive;
  const loop = session.loop;
  const review = agent ? isReviewAgent(agent) : false;
  const isActive = agent ? isAgentActive(agent) : false;
  const showCreatePr = agent ? canCreatePullRequest(agent) : false;
  const hasOpenPullRequest = agent?.pullRequest?.state === 'open';

  const loadLogs = useCallback(async () => {
    try {
      const data = await apiFetch<{ logs?: string }>(
        `/api/v1/agents/${encodeURIComponent(agentId)}/logs?tail=${LOG_TAIL}`,
      );
      setLogs(data.logs || '(no logs yet)');
    } catch (err) {
      setLogs(err instanceof Error ? err.message : 'Failed to load logs');
    }
  }, [agentId]);

  const loadConfig = useCallback(async () => {
    try {
      const config = await apiFetch<AppConfig>('/api/v1/config');
      setDefaultModel(config.opencodeModel || '');
    } catch {
      setDefaultModel('');
    }
  }, []);

  const loadRelatedSessions = useCallback(async () => {
    try {
      const data = await apiFetch<{ agents: Agent[] }>('/api/v1/agents');
      setAllAgents(data.agents);
      setAllAgentsLoaded(true);
      const parentAgentId = agent?.parentAgentId;
      const related = data.agents.filter(
        (entry) =>
          entry.parentAgentId === agentId ||
          (parentAgentId && entry.agentId === parentAgentId) ||
          (parentAgentId &&
            entry.parentAgentId === parentAgentId &&
            entry.agentId !== agentId),
      );
      setRelatedSessions(related);
    } catch {
      setAllAgents([]);
      setAllAgentsLoaded(false);
      setRelatedSessions([]);
    }
  }, [agentId, agent?.parentAgentId]);

  const loadReviewResult = useCallback(async () => {
    if (!review) {
      setReviewResult(null);
      return;
    }
    try {
      const data = await fetchAgentReviewResult(agentId);
      if (data) {
        setReviewResult(data);
      }
    } catch {
      /* review output may not be written yet */
    }
  }, [agentId, review]);

  useEffect(() => {
    loadLogs();
    loadConfig();
    void loadRelatedSessions();
  }, [loadLogs, loadConfig, loadRelatedSessions]);

  useEffect(() => {
    setReviewResult(null);
    void loadReviewResult();
  }, [agentId, loadReviewResult]);

  usePolling(
    () => {
      void loadReviewResult();
    },
    3000,
    review && isActive && !reviewResult,
  );

  usePolling(
    () => {
      session.loadAgent();
      loadLogs();
      void loadRelatedSessions();
      if (review) {
        void loadReviewResult();
      }
      if (!session.messagesLoaded || !session.eventsConnected) {
        void session.loadMessages();
      }
    },
    session.eventsConnected ? 10000 : 2000,
    isActive,
  );

  usePolling(
    async () => {
      try {
        const data = await refreshAgentPullRequest(agentId);
        session.loadAgent();
        void loadRelatedSessions();
        void data;
      } catch {
        /* ignore refresh errors during polling */
      }
    },
    15000,
    Boolean(hasOpenPullRequest),
  );

  useEffect(() => {
    if (!followTail || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, followTail]);

  useLayoutEffect(() => {
    const nodes = [desktopHeaderRef.current, mobileHeaderRef.current].filter(
      Boolean,
    ) as HTMLElement[];
    if (nodes.length === 0) return;
    const update = () => {
      setDesktopHeaderHeight(desktopHeaderRef.current?.offsetHeight ?? 0);
      setMobileHeaderHeight(mobileHeaderRef.current?.offsetHeight ?? 0);
    };
    update();
    const observer = new ResizeObserver(update);
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setFollowTail(atBottom);
  };

  const cancelAgent = async () => {
    setPageStatus('Cancelling session…');
    setPageStatusVariant('');
    try {
      await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      setPageStatus('Session cancelled.');
      setPageStatusVariant('success');
      await session.loadAgent();
      await loadLogs();
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to cancel session');
      setPageStatusVariant('error');
    }
  };

  const deleteSession = async () => {
    const confirmed = window.confirm(
      isActive
        ? 'Stop this agent and permanently delete its logs and workspace?'
        : 'Permanently delete this session, including logs and workspace?',
    );
    if (!confirmed) return;

    setPageStatus('Deleting session…');
    setPageStatusVariant('');
    try {
      await deleteAgentSession(agentId, token);
      navigate('/agents');
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to delete session');
      setPageStatusVariant('error');
    }
  };

  const refresh = async () => {
    await session.loadAgent();
    await loadLogs();
    await session.loadMessages();
  };

  const createPullRequest = async () => {
    setPrBusy(true);
    setPageStatus('Creating pull request…');
    setPageStatusVariant('');
    try {
      const data = await createAgentPullRequest(agentId, token);
      await session.loadAgent();
      void loadRelatedSessions();
      setPageStatus(`Pull request #${data.pullRequest.number} created.`);
      setPageStatusVariant('success');
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to create pull request');
      setPageStatusVariant('error');
    } finally {
      setPrBusy(false);
    }
  };

  const refreshPullRequest = async () => {
    if (!agent?.pullRequest) return;
    setPrBusy(true);
    setPageStatus('Refreshing pull request…');
    setPageStatusVariant('');
    try {
      const data = await refreshAgentPullRequest(agentId);
      await session.loadAgent();
      setPageStatus(`Pull request #${data.pullRequest.number} is ${data.pullRequest.state}.`);
      setPageStatusVariant('success');
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to refresh pull request');
      setPageStatusVariant('error');
    } finally {
      setPrBusy(false);
    }
  };

  const startBranchReview = async () => {
    if (!agent) return;
    const headBranch = agent.agentBranch || agent.branch;
    if (!headBranch) return;

    const agentRepo = repos.find((r) => r.repoId === agent.repoId);
    const baseBranch = agent.useExistingBranch
      ? agentRepo?.defaultBranch || 'main'
      : agent.baseBranch || agentRepo?.defaultBranch || 'main';

    setReviewBusy(true);
    setPageStatus('Starting branch review…');
    setPageStatusVariant('');
    try {
      const result = await apiFetch<{ agentId: string }>('/api/v1/agents', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
          mode: 'review',
          repoId: agent.repoId,
          baseBranch,
          headBranch,
          parentAgentId: agent.agentId,
        }),
      });
      navigate(`/agents/${result.agentId}`);
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to start review');
      setPageStatusVariant('error');
    } finally {
      setReviewBusy(false);
    }
  };

  const retrySession = async () => {
    setQueueBusy(true);
    setPageStatus('Re-queueing session…');
    setPageStatusVariant('');
    try {
      await retryAgentSession(agentId, token);
      setPageStatus('Session re-queued.');
      setPageStatusVariant('success');
      await session.loadAgent();
      await loadLogs();
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to retry session');
      setPageStatusVariant('error');
    } finally {
      setQueueBusy(false);
    }
  };

  const startNextQueued = async () => {
    if (agent && agent.pushed !== true) {
      const confirmed = window.confirm(
        "This session did not push. The next queued session will start without this session's work. Continue?",
      );
      if (!confirmed) return;
    }

    setQueueBusy(true);
    setPageStatus('Starting the next queued session…');
    setPageStatusVariant('');
    try {
      const result = await allowAgentSuccessors(agentId, token);
      setPageStatus(result.warning || 'Later sessions on this branch can start.');
      setPageStatusVariant('success');
      await session.loadAgent();
      void loadRelatedSessions();
    } catch (err) {
      setPageStatus(err instanceof Error ? err.message : 'Failed to start the next session');
      setPageStatusVariant('error');
    } finally {
      setQueueBusy(false);
    }
  };

  const queueAnotherOnBranch = () => {
    if (!agent) return;
    const prefill = queueOnBranchPrefill(agent);
    if (!prefill) return;
    onQueueAnother?.(prefill);
  };

  const repo = agent ? repos.find((r) => r.repoId === agent.repoId) : null;
  const repoLabel = repo ? `${repo.owner}/${repo.name}` : agent?.repoId ?? '—';
  const statusMessage = session.status || pageStatus;
  const statusVariant = session.status ? session.statusVariant : pageStatusVariant;
  const canFinish = session.canFinish;
  const canCommitOutstanding = session.canCommitOutstanding;
  const canSend = Boolean(agent?.interactive?.canSendMessage);
  const loopProgress = session.loopProgress;
  const agentMode = agent ? getAgentMode(agent) : 'batch';
  const sessionId = agentId.toUpperCase();

  const reviewBaseBranch = agent
    ? agent.useExistingBranch
      ? repos.find((r) => r.repoId === agent.repoId)?.defaultBranch || 'main'
      : agent.baseBranch || repos.find((r) => r.repoId === agent.repoId)?.defaultBranch || 'main'
    : 'main';
  const showReviewBranches = agent
    ? canReviewBranches(agent, {
        relatedAgents: allAgents,
        baseBranch: reviewBaseBranch,
        agentsLoaded: allAgentsLoaded,
      })
    : false;

  const reviewTranscript = useMemo(() => {
    if (!reviewResult || !agent) {
      return [];
    }
    return buildReviewTranscriptEntries(reviewResult, agent, agent?.finishedAt);
  }, [reviewResult, agent]);

  const displayTranscript = useMemo(() => {
    if (reviewTranscript.length === 0) {
      return session.transcript;
    }
    return [...reviewTranscript, ...session.transcript];
  }, [reviewTranscript, session.transcript]);

  const transcriptEmptyMessage = review
    ? isActive
      ? 'Running OCR review… results will appear here when complete.'
      : 'No review output was captured for this session.'
    : 'Waiting for the first response…';

  const renderPrAndReviewActions = (compact: boolean) => {
    const buttonClass = compact ? '!gap-1.5 !px-2.5 !py-1.5 text-xs' : '!gap-2';
    const reviewButtonClass = compact ? '!px-3 !py-1.5 text-xs' : '!gap-2';
    const iconClass = compact ? 'size-3.5' : 'size-4';

    return (
      <>
        {agent?.pullRequest ? (
          <Button
            variant="primary"
            className={buttonClass}
            onClick={() => window.open(agent.pullRequest!.url, '_blank', 'noopener,noreferrer')}
          >
            <IconLink className={iconClass} />
            Open PR
          </Button>
        ) : showCreatePr ? (
          <Button
            variant="primary"
            className={buttonClass}
            disabled={prBusy}
            onClick={() => createPullRequest()}
          >
            <IconGithub className={iconClass} />
            Create PR
          </Button>
        ) : null}
        {showReviewBranches ? (
          <Button
            variant="primary"
            className={reviewButtonClass}
            disabled={reviewBusy}
            onClick={() => startBranchReview()}
          >
            Review branches
          </Button>
        ) : null}
      </>
    );
  };

  const sessionInfoProps = {
    agent,
    agentId,
    repoLabel,
    defaultModel,
    loopProgress,
    eventsConnected: session.eventsConnected,
    loadError: session.loadError,
    prBusy,
    relatedSessions,
    onRefreshPullRequest: refreshPullRequest,
  };

  const sessionActions = (
    <>
      <Button variant="ghost" className="!gap-2" onClick={() => refresh()}>
        <IconRefresh className="size-4" />
        Refresh
      </Button>
      {(interactive || loop) && canFinish ? (
        <Button variant="primary" onClick={() => session.finish()}>
          Finish
        </Button>
      ) : null}
      {loop && canCommitOutstanding ? (
        <Button variant="primary" onClick={() => session.commitOutstanding()}>
          Commit and push changes
        </Button>
      ) : null}
      {renderPrAndReviewActions(false)}
      {agent?.queue?.canRetry ? (
        <Button variant="primary" disabled={queueBusy} onClick={() => retrySession()}>
          Retry
        </Button>
      ) : null}
      {agent?.queue?.canAllowSuccessors ? (
        <Button variant="ghost" disabled={queueBusy} onClick={() => startNextQueued()}>
          Start next queued
        </Button>
      ) : null}
      {agent && queueOnBranchPrefill(agent) ? (
        <Button variant="ghost" onClick={() => queueAnotherOnBranch()}>
          Queue another on this branch
        </Button>
      ) : null}
      {isActive ? (
        <Button variant="ghost" onClick={() => cancelAgent()}>
          Cancel session
        </Button>
      ) : (
        <Button variant="ghost" className="text-error" onClick={() => deleteSession()}>
          Delete session
        </Button>
      )}
    </>
  );

  const mobileSessionActions = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="ghost"
        className="!px-2.5 !py-1.5"
        onClick={() => refresh()}
        aria-label="Refresh session"
      >
        <IconRefresh className="size-4" />
      </Button>
      {(interactive || loop) && canFinish ? (
        <Button variant="primary" className="!px-3 !py-1.5 text-xs" onClick={() => session.finish()}>
          Finish
        </Button>
      ) : null}
      {loop && canCommitOutstanding ? (
        <Button
          variant="primary"
          className="!px-3 !py-1.5 text-xs"
          onClick={() => session.commitOutstanding()}
        >
          Commit changes
        </Button>
      ) : null}
      {renderPrAndReviewActions(true)}
      {agent?.queue?.canRetry ? (
        <Button
          variant="primary"
          className="!px-3 !py-1.5 text-xs"
          disabled={queueBusy}
          onClick={() => retrySession()}
        >
          Retry
        </Button>
      ) : null}
      {agent?.queue?.canAllowSuccessors ? (
        <Button
          variant="ghost"
          className="!px-2.5 !py-1.5 text-xs"
          disabled={queueBusy}
          onClick={() => startNextQueued()}
        >
          Start next
        </Button>
      ) : null}
      {agent && queueOnBranchPrefill(agent) ? (
        <Button
          variant="ghost"
          className="!px-2.5 !py-1.5 text-xs"
          onClick={() => queueAnotherOnBranch()}
        >
          Queue another
        </Button>
      ) : null}
      {isActive ? (
        <Button variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => cancelAgent()}>
          Cancel
        </Button>
      ) : (
        <Button
          variant="ghost"
          className="!px-2.5 !py-1.5 text-xs text-error"
          onClick={() => deleteSession()}
        >
          Delete
        </Button>
      )}
    </div>
  );

  return (
    <div
      className="relative flex max-w-[100vw] w-full min-h-screen flex-col p-6 pb-32 md:pb-6 overflow-x-hidden"
      style={
        {
          '--session-sticky-header-height': `${desktopHeaderHeight}px`,
          '--session-mobile-header-height': `${mobileHeaderHeight}px`,
        } as React.CSSProperties
      }
    >
      <header
        ref={mobileHeaderRef}
        className="sticky top-0 z-10 -mx-6 mb-4 border-b border-surface-container-highest bg-surface/95 px-4 py-3 backdrop-blur-sm lg:hidden"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to="/agents"
              className="mb-1 inline-flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary-container"
            >
              ← All sessions
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-medium text-primary">Session #{sessionId}</h2>
              {agent ? (
                <>
                  <Badge
                    variant={agentStatusVariant(agent.status)}
                    pulse={agentStatusPulse(agent.status)}
                  >
                    {agent.status}
                  </Badge>
                  <Badge variant={agentModeBadgeVariant(agentMode)}>{agentMode}</Badge>
                </>
              ) : null}
            </div>
            {agent ? (
              <p className="mt-0.5 truncate text-xs text-on-surface-variant">
                {repoLabel}
                {' · '}
                {agent.agentBranch || agent.branch || '—'}
                {interactive && agent.turnCount != null ? ` · ${agent.turnCount} turn(s)` : ''}
                {loop && loopProgress ? ` · ${loopProgress}` : ''}
              </p>
            ) : null}
            {agent?.queue?.reason ? (
              <p className="mt-1 text-xs text-muted">{agent.queue.reason}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            className="!p-2"
            onClick={() => setShowSessionInfo(true)}
            aria-label="Open session info"
          >
            <IconInfo className="size-4" />
          </Button>
        </div>
        <div className="mt-2">{mobileSessionActions}</div>
      </header>

      <FlyoutPanel
        open={showSessionInfo}
        onClose={() => setShowSessionInfo(false)}
        title="Session info"
      >
        <AgentSessionInfo {...sessionInfoProps} />
      </FlyoutPanel>

      <div
        ref={desktopHeaderRef}
        className="mb-6 hidden flex-wrap items-start justify-between gap-4 border-b border-surface-container-highest bg-surface/95 px-6 pb-4 backdrop-blur-sm lg:-mx-6 lg:flex lg:sticky lg:top-0 lg:z-[100]"
      >
        <div>
          <Link
            to="/agents"
            className="mb-3 inline-flex items-center gap-1 text-sm text-primary transition-colors hover:text-primary-container"
          >
            ← All sessions
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="headline-lg text-primary">Session #{sessionId}</h2>
            {agent ? (
              <>
                <Badge
                  variant={agentStatusVariant(agent.status)}
                  pulse={agentStatusPulse(agent.status)}
                >
                  {agent.status}
                </Badge>
                <Badge variant={agentModeBadgeVariant(agentMode)}>{agentMode}</Badge>
              </>
            ) : null}
          </div>
          {agent ? (
            <p className="mt-1 body-md text-on-surface-variant">
              {repoLabel}
              {' · '}
              {agent.agentBranch || agent.branch || '—'}
              {interactive && agent.turnCount != null ? ` · ${agent.turnCount} turn(s)` : ''}
            </p>
          ) : null}
          {agent?.queue?.reason ? (
            <p className="mt-1 text-sm text-muted">{agent.queue.reason}</p>
          ) : null}
          {loop && loopProgress ? (
            <p className="mt-1 text-sm text-on-surface-variant">
              {loopProgress}
              {agent?.loop?.finishRequested ? ' · finish after current step' : ''}
            </p>
          ) : null}
        </div>

        <FormActions className="mt-0 shrink-0">{sessionActions}</FormActions>
      </div>

      {session.loadError ? (
        <StatusMessage message={session.loadError} variant="error" className="mb-4" />
      ) : null}
      {statusMessage ? (
        <StatusMessage message={statusMessage} variant={statusVariant} className="mb-4" mono />
      ) : null}

      <div className="grid min-w-0 flex-1 gap-5 lg:grid-cols-[280px_1fr] lg:items-stretch">
        <aside className="card-surface hidden h-fit space-y-6 p-6 lg:sticky lg:top-[calc(var(--session-sticky-header-height,0px)+1.5rem)] lg:block">
          <AgentSessionInfo {...sessionInfoProps} />
        </aside>

        <section className="card-surface flex min-h-[min(70vh,640px)] min-w-0 flex-col overflow-clip">
          <header className="card-header-rule sticky top-[var(--session-mobile-header-height,0px)] z-[1] flex items-center justify-between gap-4 bg-surface/80 px-6 py-4 backdrop-blur-sm lg:top-[var(--session-sticky-header-height,0px)]">
            <div className="min-w-0 flex flex-col gap-1 text-primary sm:flex-row sm:items-center sm:gap-3">
              <h3 className="text-lg">Conversation</h3>
              {loop && loopProgress ? (
                <span className="hidden text-xs text-on-surface-variant sm:inline">{loopProgress}</span>
              ) : null}
            </div>
            <div className="shrink-0 flex items-center gap-3">
              {isActive ? (
                <span className="hidden items-center gap-2 text-xs text-on-surface-variant lg:flex">
                  <span
                    className={`size-2 rounded-full ${session.eventsConnected ? 'bg-success animate-pulse' : 'bg-warning'}`}
                  />
                  {session.eventsConnected ? 'Live · SSE' : 'Polling fallback · 2s'}
                </span>
              ) : null}
              <Button
                variant="ghost"
                className="!px-2 !py-1.5 shrink-0 text-xs whitespace-nowrap"
                onClick={() => setShowDebugLogs((v) => !v)}
              >
                {showDebugLogs ? 'Hide logs' : 'Debug logs'}
              </Button>
            </div>
          </header>

          <AgentTranscript entries={displayTranscript} emptyMessage={transcriptEmptyMessage} />
          {interactive ? (
            <AgentComposer
              canSend={canSend}
              disabledReason={agent ? composerDisabledReason(agent) : undefined}
              onSend={session.sendMessage}
            />
          ) : null}

          {showDebugLogs ? (
            <div className="min-w-0 shrink-0 border-t border-surface-container-highest">
              <AgentLogPanel
                text={logs || 'Loading logs…'}
                logRef={logRef}
                onScroll={handleLogScroll}
                className="max-h-48 overflow-auto bg-background p-4 code-md text-xs leading-relaxed text-on-surface-variant"
              />
            </div>
          ) : null}
        </section>
      </div>

      {!session.loadError && !agent ? (
        <div className="mt-6 text-center">
          <Button variant="ghost" onClick={() => navigate('/agents')}>
            Back to sessions
          </Button>
        </div>
      ) : null}
    </div>
  );
}
