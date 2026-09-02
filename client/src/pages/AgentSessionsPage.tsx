import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { deleteAgentSession } from '../api/agents';
import { apiFetch, authHeaders } from '../api/client';
import {
  getAgentMode,
  hasNonEmptyLoopVerbModel,
  hasResolvableLoopModel,
  isAgentActive,
  LOOP_VERB_LABELS,
  LOOP_VERB_MODELS_DEFAULT,
  LOOP_VERBS,
  mergeLoopVerbModels,
  queueOnBranchPrefill,
  type Agent,
  type AgentMode,
  type AgentsListResponse,
  type AppConfig,
  type LoopVerbModels,
  type OllamaStatus,
  type QueueOnBranchPrefill,
  type Repo,
  type StatusVariant,
} from '../api/types';
import { useApiToken } from '../hooks/useApiToken';
import { usePolling } from '../hooks/usePolling';
import { PAGE_SUBTITLES, PAGE_TITLES } from '../navigation';
import { formatDuration, formatRelativeTime, formatTokenCount, formatCost } from '../lib/format';
import { agentTokenTotal, computeGlobalTokenStats } from '../lib/token-stats';
import { IconEye } from '../components/icons';
import { Badge, agentStatusPulse, agentStatusVariant } from '../components/ui/Badge';
import { SectionCard, StatCard } from '../components/ui/Card';
import { FilterTabs } from '../components/ui/FilterTabs';
import {
  Button,
  CheckboxField,
  Field,
  FormActions,
  FormGrid,
  Select,
  TextArea,
  TextInput,
} from '../components/ui/Form';
import { Modal } from '../components/ui/Modal';
import { StatusMessage } from '../components/ui/StatusMessage';

type SessionFilter = 'all' | 'running' | 'completed';

interface AgentSessionsPageProps {
  repos: Repo[];
  searchQuery?: string;
  openNewOnMount?: boolean;
  onNewOrchestrationOpened?: () => void;
  queuePrefill?: QueueOnBranchPrefill | null;
  onQueuePrefillConsumed?: () => void;
  onRegisterNewOrchestration?: (open: () => void) => void;
  onSessionOpen: (agentId: string) => void;
}

export function AgentSessionsPage({
  repos,
  searchQuery = '',
  openNewOnMount = false,
  onNewOrchestrationOpened,
  queuePrefill = null,
  onQueuePrefillConsumed,
  onRegisterNewOrchestration,
  onSessionOpen,
}: AgentSessionsPageProps) {
  const { token } = useApiToken();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState<StatusVariant>('');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [modalOpen, setModalOpen] = useState(false);

  const [repoId, setRepoId] = useState('');
  const [customRepo, setCustomRepo] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [agentBranch, setAgentBranch] = useState('');
  const [useExistingBranch, setUseExistingBranch] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultReviewModel, setDefaultReviewModel] = useState('');
  const [push, setPush] = useState(true);
  const [pushOnFailure, setPushOnFailure] = useState(false);
  const [mode, setMode] = useState<AgentMode>('batch');
  const [autoApproveExplicit, setAutoApproveExplicit] = useState(false);
  const [autoApprovePermissions, setAutoApprovePermissions] = useState(true);
  const [batchAutoApproveDefault, setBatchAutoApproveDefault] = useState(true);
  const [loopAutoApproveDefault, setLoopAutoApproveDefault] = useState(true);
  const [interactiveAutoApproveDefault, setInteractiveAutoApproveDefault] = useState(false);
  const [settingsLoopVerbModels, setSettingsLoopVerbModels] =
    useState<LoopVerbModels>(LOOP_VERB_MODELS_DEFAULT);
  const [loopRunVerbModels, setLoopRunVerbModels] =
    useState<LoopVerbModels>(LOOP_VERB_MODELS_DEFAULT);
  const [loopMaxIterationsOverride, setLoopMaxIterationsOverride] = useState('');
  const [loopDefaultMaxIterations, setLoopDefaultMaxIterations] = useState<number | null>(null);
  const [loopOverridesOpen, setLoopOverridesOpen] = useState(false);
  const [reviewHeadBranch, setReviewHeadBranch] = useState('');
  const [reviewBackground, setReviewBackground] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.repoId === repoId) ?? null,
    [repos, repoId],
  );

  useEffect(() => {
    onRegisterNewOrchestration?.(() => setModalOpen(true));
  }, [onRegisterNewOrchestration]);

  const openQueueOnBranch = useCallback((prefill: QueueOnBranchPrefill) => {
    setRepoId(prefill.repoId);
    setBaseBranch(prefill.baseBranch);
    setAgentBranch(prefill.agentBranch);
    setUseExistingBranch(false);
    setPrompt('');
    setMode((current) => (current === 'review' ? 'batch' : current));
    setAutoApproveExplicit(false);
    setModalOpen(true);
  }, []);

  useEffect(() => {
    if (openNewOnMount) {
      setModalOpen(true);
      setAutoApproveExplicit(false);
      onNewOrchestrationOpened?.();
    }
  }, [openNewOnMount, onNewOrchestrationOpened]);

  useEffect(() => {
    if (!queuePrefill) return;
    openQueueOnBranch(queuePrefill);
  }, [queuePrefill, openQueueOnBranch]);

  const modeAutoApproveDefault =
    mode === 'batch'
      ? batchAutoApproveDefault
      : mode === 'loop'
        ? loopAutoApproveDefault
        : interactiveAutoApproveDefault;
  const displayedAutoApprove = autoApproveExplicit ? autoApprovePermissions : modeAutoApproveDefault;

  useEffect(() => {
    if (!repos.length) {
      setRepoId('');
      return;
    }
    setRepoId((current) => {
      if (current && repos.some((r) => r.repoId === current)) return current;
      const first = repos[0];
      if (first?.defaultBranch) setBaseBranch(first.defaultBranch);
      return first?.repoId || '';
    });
  }, [repos]);

  const loadAgents = useCallback(async (silent = false) => {
    if (!silent) setStatus('');
    setLoadError('');
    try {
      const data = await apiFetch<AgentsListResponse>('/api/v1/agents');
      setAgents(data.agents || []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load agents');
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const health = await apiFetch<{ ollama?: OllamaStatus }>('/health');
      setOllama(health.ollama ?? null);
    } catch {
      setOllama(null);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setConfigLoaded(false);
    try {
      const config = await apiFetch<AppConfig>('/api/v1/config');
      setDefaultModel(config.opencodeModel || '');
      setDefaultReviewModel(config.reviewModel || '');
      setBatchAutoApproveDefault(config.batchAutoApprovePermissions !== false);
      setLoopAutoApproveDefault(config.loopAutoApprovePermissions !== false);
      setInteractiveAutoApproveDefault(config.interactiveAutoApprovePermissions === true);
      setSettingsLoopVerbModels(mergeLoopVerbModels(config.loopVerbModels));
      setLoopDefaultMaxIterations(
        typeof config.loopDefaultMaxIterations === 'number' ? config.loopDefaultMaxIterations : null,
      );
      setConfigLoaded(true);
    } catch {
      setDefaultModel('');
    }
  }, []);

  useEffect(() => {
    if (!configLoaded || autoApproveExplicit) return;
    setAutoApprovePermissions(
      mode === 'batch'
        ? batchAutoApproveDefault
        : mode === 'loop'
          ? loopAutoApproveDefault
          : interactiveAutoApproveDefault,
    );
  }, [
    configLoaded,
    autoApproveExplicit,
    mode,
    batchAutoApproveDefault,
    loopAutoApproveDefault,
    interactiveAutoApproveDefault,
  ]);

  const availableModels = useMemo(
    () => [...(ollama?.models ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.name),
    [ollama?.models],
  );

  useEffect(() => {
    if (!availableModels.length) return;

    if (mode === 'loop') return;

    const preferredDefault =
      mode === 'review'
        ? defaultReviewModel && availableModels.includes(defaultReviewModel)
          ? defaultReviewModel
          : defaultModel && availableModels.includes(defaultModel)
            ? defaultModel
            : availableModels[0]
        : defaultModel && availableModels.includes(defaultModel)
          ? defaultModel
          : availableModels[0];

    setModel((current) => {
      if (current && availableModels.includes(current)) return current;
      return preferredDefault;
    });
  }, [availableModels, defaultModel, defaultReviewModel, mode]);

  useEffect(() => {
    loadAgents();
    loadHealth();
    loadConfig();
  }, [loadAgents, loadHealth, loadConfig]);

  const hasActiveAgents = agents.some((a) => isAgentActive(a));

  usePolling(() => loadAgents(true), 3000, hasActiveAgents);

  const handleRepoChange = (nextRepoId: string) => {
    setRepoId(nextRepoId);
    const repo = repos.find((r) => r.repoId === nextRepoId);
    if (repo?.defaultBranch) setBaseBranch(repo.defaultBranch);
  };

  const loadBranches = useCallback(async () => {
    if (!selectedRepo) {
      setAvailableBranches([]);
      return;
    }

    setBranchesLoading(true);
    try {
      const params = new URLSearchParams({
        owner: selectedRepo.owner,
        name: selectedRepo.name,
      });
      const data = await apiFetch<{ branches?: string[] }>(
        `/api/v1/github/branches?${params.toString()}`,
        { headers: authHeaders(token) },
      );
      setAvailableBranches(data.branches ?? []);
    } catch {
      setAvailableBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  }, [selectedRepo, token]);

  useEffect(() => {
    if (!modalOpen || !selectedRepo) {
      if (!modalOpen) {
        setAvailableBranches([]);
      }
      return;
    }
    void loadBranches();
  }, [modalOpen, selectedRepo, loadBranches]);

  useEffect(() => {
    if (!availableBranches.length) return;
    setBaseBranch((current) => {
      if (current && availableBranches.includes(current)) return current;
      const preferred = selectedRepo?.defaultBranch;
      if (preferred && availableBranches.includes(preferred)) return preferred;
      return availableBranches[0];
    });
  }, [availableBranches, selectedRepo?.defaultBranch]);

  const loopCanStart = useMemo(
    () =>
      hasResolvableLoopModel({
        settingsVerbModels: settingsLoopVerbModels,
        runVerbModels: loopRunVerbModels,
        fallbackModel: model,
        globalModel: defaultModel,
      }),
    [settingsLoopVerbModels, loopRunVerbModels, model, defaultModel],
  );

  const compactRunLoopVerbModels = useCallback((): LoopVerbModels | undefined => {
    const compact: LoopVerbModels = {};
    for (const verb of LOOP_VERBS) {
      const value = loopRunVerbModels[verb]?.trim();
      if (value) compact[verb] = value;
    }
    return Object.keys(compact).length > 0 ? compact : undefined;
  }, [loopRunVerbModels]);

  const resetLoopRunVerbModels = () => {
    setLoopRunVerbModels(LOOP_VERB_MODELS_DEFAULT);
    setLoopMaxIterationsOverride('');
    setLoopOverridesOpen(false);
  };

  const copyLoopModelsFromSettings = () => {
    setLoopRunVerbModels(mergeLoopVerbModels(settingsLoopVerbModels));
    setLoopOverridesOpen(true);
  };

  const useFallbackForAllLoopVerbs = () => {
    setLoopRunVerbModels(LOOP_VERB_MODELS_DEFAULT);
  };

  const closeCreateModal = () => {
    setModalOpen(false);
    resetLoopRunVerbModels();
    setAutoApproveExplicit(false);
    onQueuePrefillConsumed?.();
  };

  const startDisabled =
    !repos.length ||
    !configLoaded ||
    (mode === 'review'
      ? !reviewHeadBranch.trim()
      : !availableModels.length || (mode === 'loop' ? !loopCanStart : !model.trim()));

  const startAgent = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('Starting agent…');
    setStatusVariant('');

    const trimmedCustomRepo = customRepo.trim();
    let effectiveRepoId = repoId;
    if (trimmedCustomRepo) {
      const slashIndex = trimmedCustomRepo.indexOf('/');
      const ownerPart = slashIndex === -1 ? '' : trimmedCustomRepo.slice(0, slashIndex).trim();
      const namePart = slashIndex === -1 ? '' : trimmedCustomRepo.slice(slashIndex + 1).trim();

      if (slashIndex <= 0 || !ownerPart || !namePart) {
        setStatus(
          'Enter the repository as owner/name with a slash in the middle (for example your-org/your-repo).',
        );
        setStatusVariant('error');
        return;
      }
      if (namePart.includes('/')) {
        setStatus('Use a single slash between owner and repository name.');
        setStatusVariant('error');
        return;
      }

      effectiveRepoId = `${ownerPart}-${namePart}`;
    }

    try {
      const runLoopVerbModels = mode === 'loop' ? compactRunLoopVerbModels() : undefined;
      let loopMaxIterations: number | undefined;
      if (mode === 'loop') {
        const trimmedOverride = loopMaxIterationsOverride.trim();
        if (trimmedOverride) {
          const parsed = Number(trimmedOverride);
          if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
            setStatus('Max iterations must be a positive whole number.');
            setStatusVariant('error');
            return;
          }
          loopMaxIterations = parsed;
        }
      }

      const result = await apiFetch<{ agentId: string; workspaceId?: string }>('/api/v1/agents', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify(
          mode === 'review'
            ? {
                repoId: effectiveRepoId,
                mode: 'review',
                baseBranch: baseBranch.trim() || 'main',
                headBranch: reviewHeadBranch.trim(),
                ...(reviewBackground.trim() ? { background: reviewBackground.trim() } : {}),
                ...(model.trim() ? { model: model.trim() } : {}),
              }
            : {
                repoId: effectiveRepoId,
                ...(mode !== 'batch' ? { mode } : {}),
                prompt: prompt.trim(),
                baseBranch: baseBranch.trim() || 'main',
                ...(agentBranch.trim() ? { agentBranch: agentBranch.trim() } : {}),
                ...(useExistingBranch ? { useExistingBranch: true } : {}),
                commitMessage: commitMessage.trim(),
                ...(model.trim() ? { model: model.trim() } : {}),
                ...(runLoopVerbModels ? { loopVerbModels: runLoopVerbModels } : {}),
                ...(loopMaxIterations !== undefined ? { loopMaxIterations } : {}),
                push,
                pushOnFailure,
                ...(autoApproveExplicit ? { autoApprovePermissions } : {}),
              },
        ),
      });
      setStatus(`Agent ${result.agentId} queued.`);
      setStatusVariant('success');
      setPrompt('');
      setAgentBranch('');
      setUseExistingBranch(false);
      setReviewHeadBranch('');
      setReviewBackground('');
      setCustomRepo('');
      resetLoopRunVerbModels();
      setAutoApproveExplicit(false);
      setModalOpen(false);
      onQueuePrefillConsumed?.();
      await loadAgents();
      onSessionOpen(result.agentId);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to start agent');
      setStatusVariant('error');
    }
  };

  const cancelAgent = async (agentId: string) => {
    setStatus(`Cancelling ${agentId}…`);
    setStatusVariant('');
    try {
      await apiFetch(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      setStatus('Agent cancelled.');
      setStatusVariant('success');
      await loadAgents();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to cancel agent');
      setStatusVariant('error');
    }
  };

  const deleteSession = async (agentId: string, active: boolean) => {
    const confirmed = window.confirm(
      active
        ? 'Stop this agent and permanently delete its logs and workspace?'
        : 'Permanently delete this session, including logs and workspace?',
    );
    if (!confirmed) return;

    setStatus(`Deleting ${agentId}…`);
    setStatusVariant('');
    try {
      await deleteAgentSession(agentId, token);
      setStatus('Session deleted.');
      setStatusVariant('success');
      await loadAgents();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to delete session');
      setStatusVariant('error');
    }
  };

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    [agents],
  );

  const filteredAgents = useMemo(() => {
    let list = sortedAgents;
    if (filter === 'running') {
      list = list.filter((a) => isAgentActive(a));
    } else if (filter === 'completed') {
      list = list.filter((a) => a.status === 'completed');
    }
    const query = searchQuery.trim().toLowerCase();
    if (!query) return list;
    return list.filter((agent) => {
      const repo = repos.find((r) => r.repoId === agent.repoId);
      const repoLabel = repo ? `${repo.owner}/${repo.name}` : agent.repoId;
      return (
        agent.agentId.toLowerCase().includes(query) ||
        repoLabel.toLowerCase().includes(query) ||
        (agent.agentBranch || agent.branch || '').toLowerCase().includes(query) ||
        agent.status.toLowerCase().includes(query)
      );
    });
  }, [sortedAgents, filter, searchQuery, repos]);

  const tokenStats = useMemo(() => computeGlobalTokenStats(agents), [agents]);
  const totalTokens = agentTokenTotal(tokenStats.overall);
  const totalCost = tokenStats.overall.cost ?? 0;

  const systemOnline = ollama?.reachable !== false;

  return (
    <div className="p-6 pb-32 md:p-6">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="headline-lg text-primary">{PAGE_TITLES.agents}</h2>
          <p className="mt-1 body-md text-on-surface-variant">{PAGE_SUBTITLES.agents}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 body-sm text-on-surface-variant">
            <span
              className={`size-2 rounded-full ${systemOnline ? 'bg-success' : 'bg-error'}`}
            />
            {systemOnline ? 'System Online' : 'System Offline'}
          </span>
          <FilterTabs
            tabs={[
              { id: 'all', label: 'All' },
              { id: 'running', label: 'Running' },
              { id: 'completed', label: 'Completed' },
            ]}
            active={filter}
            onChange={setFilter}
          />
        </div>
      </div>

      <div className="mb-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Sessions" value={agents.length} />
        <StatCard
          label="Total Tokens"
          value={formatTokenCount(totalTokens)}
          meta={
            totalCost > 0 ? (
              <span className="text-xs text-on-surface-variant">{formatCost(totalCost)}</span>
            ) : null
          }
        />
        <StatCard
          label="Avg Tokens / Session"
          value={formatTokenCount(Math.round(tokenStats.averageTokensPerSession))}
          meta={
            tokenStats.sessionsWithUsage > 0 ? (
              <span className="text-xs text-on-surface-variant">
                {tokenStats.sessionsWithUsage} session{tokenStats.sessionsWithUsage === 1 ? '' : 's'} tracked
              </span>
            ) : null
          }
        />
        <StatCard
          label="Models Loaded"
          value={ollama?.modelCount ?? 0}
          meta={
            ollama?.reachable ? (
              <span className="flex items-center gap-1.5 text-xs text-success">
                <span className="size-1.5 rounded-full bg-success" />
                Connected
              </span>
            ) : null
          }
        />
      </div>

      {tokenStats.byRepo.length > 0 ? (
        <SectionCard title="Token usage by repository" className="mb-10">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="border-b border-surface-container-highest">
                  {['Repository', 'Sessions', 'Total tokens', 'Avg / session', 'Cost'].map((col) => (
                    <th
                      key={col}
                      className="px-2 py-2 label-md font-normal text-on-surface-variant first:pl-0 last:pr-0"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokenStats.byRepo.map((entry) => {
                  const repo = repos.find((r) => r.repoId === entry.repoId);
                  const repoLabel = repo ? `${repo.owner}/${repo.name}` : entry.repoId;
                  const repoTotal = agentTokenTotal(entry.usage);
                  const repoAverage =
                    entry.sessionsWithUsage > 0 ? repoTotal / entry.sessionsWithUsage : 0;
                  const repoCost = entry.usage.cost ?? 0;

                  return (
                    <tr key={entry.repoId} className="border-t border-surface-low">
                      <td className="px-2 py-3 text-on-surface first:pl-0">{repoLabel}</td>
                      <td className="px-2 py-3 text-on-surface-variant">
                        {entry.sessionsWithUsage}/{entry.sessionCount}
                      </td>
                      <td className="px-2 py-3 code-md text-on-surface">
                        {formatTokenCount(repoTotal)}
                      </td>
                      <td className="px-2 py-3 code-md text-on-surface-variant">
                        {entry.sessionsWithUsage > 0
                          ? formatTokenCount(Math.round(repoAverage))
                          : '—'}
                      </td>
                      <td className="px-2 py-3 text-on-surface-variant last:pr-0">
                        {repoCost > 0 ? formatCost(repoCost) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {loadError ? <StatusMessage message={loadError} variant="error" className="mb-4" /> : null}
      {status ? (
        <StatusMessage message={status} variant={statusVariant} className="mb-4" mono />
      ) : null}

      <section className="card-surface overflow-hidden">
        <header className="card-header-rule flex items-center justify-between px-6 py-4">
          <h3 className="text-lg text-primary">Active &amp; Recent Sessions</h3>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-surface-container-highest bg-surface-low">
                {['Session ID', 'Agent Class', 'Status', 'Duration', 'Actions'].map((col) => (
                  <th
                    key={col}
                    className="px-6 py-3 label-md font-normal text-on-surface-variant"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredAgents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted">
                    No agents yet. Start one to begin orchestration.
                  </td>
                </tr>
              ) : (
                filteredAgents.map((agent, index) => {
                  const repo = repos.find((r) => r.repoId === agent.repoId);
                  const repoLabel = repo ? `${repo.owner}/${repo.name}` : agent.repoId;
                  const branchPrefill = queueOnBranchPrefill(agent);
                  return (
                    <tr
                      key={agent.agentId}
                      className="cursor-pointer border-t border-surface-low transition-colors hover:bg-surface-low"
                      onClick={() => onSessionOpen(agent.agentId)}
                    >
                      <td className="px-6 py-4">
                        <p className="code-md text-on-surface">#{agent.agentId.toUpperCase()}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {index === 0 ? formatRelativeTime(agent.createdAt) : formatRelativeTime(agent.finishedAt || agent.createdAt)}
                        </p>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-on-surface">{repoLabel}</p>
                        <p className="mt-0.5 code-md text-xs text-muted">
                          {agent.agentBranch || agent.branch || '—'}
                        </p>
                        <p className="mt-0.5 text-xs capitalize text-muted">
                          {getAgentMode(agent)}
                        </p>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={agentStatusVariant(agent.status)} pulse={agentStatusPulse(agent.status)}>
                          {agent.status}
                        </Badge>
                        {agent.queue?.reason ? (
                          <p className="mt-1 max-w-xs text-xs text-muted">{agent.queue.reason}</p>
                        ) : null}
                        {agent.pullRequest ? (
                          <a
                            href={agent.pullRequest.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 block text-xs text-primary hover:text-primary-container"
                            onClick={(e) => e.stopPropagation()}
                          >
                            PR #{agent.pullRequest.number} · {agent.pullRequest.state}
                          </a>
                        ) : null}
                      </td>
                      <td className="px-6 py-4 code-md text-on-surface-variant">
                        {formatDuration(agent.startedAt, agent.finishedAt)}
                        {agent.tokenUsage ? (
                          <p className="mt-0.5 text-xs text-muted">
                            {formatTokenCount(agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens)} tokens
                            {agent.tokenUsage.cost != null ? ` · ${formatCost(agent.tokenUsage.cost)}` : ''}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            className="!px-2 !py-1.5"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSessionOpen(agent.agentId);
                            }}
                            aria-label="View session log"
                          >
                            <IconEye className="size-4" />
                          </Button>
                          {branchPrefill ? (
                            <Button
                              variant="ghost"
                              className="!px-2 !py-1.5 text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                openQueueOnBranch(branchPrefill);
                              }}
                            >
                              Queue another
                            </Button>
                          ) : null}
                          {isAgentActive(agent) ? (
                            <Button
                              variant="ghost"
                              className="!px-2 !py-1.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                cancelAgent(agent.agentId);
                              }}
                            >
                              Cancel
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              className="!px-2 !py-1.5 text-error"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSession(agent.agentId, false);
                              }}
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={modalOpen}
        onClose={closeCreateModal}
        title={mode === 'review' ? 'New Review' : 'New Agent'}
        className="sm:max-w-2xl"
      >
        <form onSubmit={startAgent}>
          <FormGrid className="gap-4 sm:gap-6">
            <div className="flex flex-col gap-4 sm:flex-row">
              <Field className="flex-1" label="Repository">
                <Select
                  required
                  value={repoId}
                  onChange={(e) => handleRepoChange(e.target.value)}
                  disabled={!repos.length}
                >
                  {!repos.length ? (
                    <option value="">— register a repo first —</option>
                  ) : (
                    repos.map((repo) => (
                      <option key={repo.repoId} value={repo.repoId}>
                        {repo.owner}/{repo.name}
                      </option>
                    ))
                  )}
                </Select>
              </Field>
            </div>
            <Field label="Mode">
              <Select
                value={mode}
                onChange={(e) => {
                  const nextMode = e.target.value as AgentMode;
                  setMode(nextMode);
                  if (!autoApproveExplicit) {
                    setAutoApprovePermissions(
                      nextMode === 'batch'
                        ? batchAutoApproveDefault
                        : nextMode === 'loop'
                          ? loopAutoApproveDefault
                          : interactiveAutoApproveDefault,
                    );
                  }
                }}
              >
                <option value="batch">Batch — run once and auto-commit</option>
                <option value="interactive">Interactive — multi-turn with Finish</option>
                <option value="loop">Loop — config-driven observe/plan/act/reflect</option>
                <option value="review">Review — OCR branch diff review</option>
              </Select>
            </Field>
            {mode === 'review' ? (
              <>
                <Field label="Base branch">
                  <Select
                    required
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    disabled={!repoId || branchesLoading || !availableBranches.length}
                  >
                    {!repoId ? (
                      <option value="">Select a repository first</option>
                    ) : branchesLoading ? (
                      <option value="">Loading branches…</option>
                    ) : availableBranches.length > 0 ? (
                      availableBranches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))
                    ) : (
                      <option value="">No branches found</option>
                    )}
                  </Select>
                </Field>
                <Field label="Head branch">
                  <Select
                    required
                    value={reviewHeadBranch}
                    onChange={(e) => setReviewHeadBranch(e.target.value)}
                    disabled={!repoId || branchesLoading || !availableBranches.length}
                  >
                    <option value="">Select head branch</option>
                    {availableBranches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Background context (optional)">
                  <TextArea
                    rows={3}
                    placeholder="Extra review requirements or focus areas…"
                    value={reviewBackground}
                    onChange={(e) => setReviewBackground(e.target.value)}
                  />
                </Field>
                <Field label="Model">
                  <Select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={!availableModels.length}
                  >
                    {!availableModels.length ? (
                      <option value="">
                        {ollama?.reachable === false
                          ? '— Ollama unreachable (uses Settings default) —'
                          : '— no models available (uses Settings default) —'}
                      </option>
                    ) : (
                      availableModels.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                          {entry === defaultReviewModel && ' (review default)'}
                          {entry === defaultModel &&
                            entry !== defaultReviewModel &&
                            ' (global default)'}
                        </option>
                      ))
                    )}
                  </Select>
                  <p className="mt-1 text-xs text-muted">
                    Override the review model for this run. Leave unset when Ollama is
                    unavailable to use the Settings review model.
                  </p>
                </Field>
              </>
            ) : (
              <>
            <Field label={useExistingBranch ? 'Branch' : 'Base branch'}>
              <Select
                required
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={!repoId || branchesLoading || !availableBranches.length}
              >
                {!repoId ? (
                  <option value="">Select a repository first</option>
                ) : branchesLoading ? (
                  <option value="">Loading branches…</option>
                ) : availableBranches.length > 0 ? (
                  availableBranches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))
                ) : (
                  <option value="">No branches found</option>
                )}
              </Select>
            </Field>
            <CheckboxField
              label="Push to existing branch"
              checked={useExistingBranch}
              onChange={(e) => setUseExistingBranch(e.target.checked)}
            />
            {useExistingBranch ? (
              <p className="-mt-2 text-xs text-muted">
                Checks out and pushes to the branch above directly instead of creating a new agent
                branch.
              </p>
            ) : null}
            {!useExistingBranch ? (
              <Field label="Agent branch (optional)">
                <TextInput
                  placeholder="Leave empty for localagent-{sessionId}"
                  value={agentBranch}
                  onChange={(e) => setAgentBranch(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted">
                  Sessions that share this branch run one at a time. Later sessions start after the
                  current one finishes and pushes.
                </p>
              </Field>
            ) : null}
              </>
            )}
            {mode === 'loop' ? (
              <div className="space-y-4">
                <Field label="Fallback model (unset steps)">
                  <Select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={!availableModels.length}
                  >
                    <option value="">Settings / global default</option>
                    {!availableModels.length ? (
                      <option value="" disabled>
                        {ollama?.reachable === false
                          ? '— Ollama unreachable —'
                          : '— no models available —'}
                      </option>
                    ) : (
                      availableModels.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                          {entry === defaultModel ? ' (global default)' : ''}
                        </option>
                      ))
                    )}
                  </Select>
                  <p className="mt-1 text-xs text-muted">
                    Used when this run and Settings both leave a verb blank.
                  </p>
                </Field>
                <Field label="Max iterations">
                  <TextInput
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    placeholder={
                      loopDefaultMaxIterations != null
                        ? `Default (${loopDefaultMaxIterations})`
                        : 'Default (server / repo)'
                    }
                    value={loopMaxIterationsOverride}
                    onChange={(e) => setLoopMaxIterationsOverride(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Leave blank to use the server default
                    {loopDefaultMaxIterations != null ? ` (${loopDefaultMaxIterations})` : ''} or a
                    repo override from <code className="code-md">.localagent-box/loop.json</code>.
                    Set a value here to cap this session only.
                  </p>
                </Field>
                <div className="rounded border border-surface-container-highest bg-background p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-on-surface">Override step models</p>
                    <Button
                      type="button"
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      onClick={() => setLoopOverridesOpen((open) => !open)}
                    >
                      {loopOverridesOpen ? 'Collapse' : 'Expand'}
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Loop step models come from Settings unless you override them here. Leave
                    overrides blank to use Settings; leave both blank to use the fallback model
                    or global OpenCode model.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      onClick={copyLoopModelsFromSettings}
                    >
                      Copy from Settings
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      onClick={useFallbackForAllLoopVerbs}
                    >
                      Use fallback for all
                    </Button>
                  </div>
                  {loopOverridesOpen ? (
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      {LOOP_VERBS.map((verb) => {
                        const { label, hint } = LOOP_VERB_LABELS[verb];
                        const selectedModel = loopRunVerbModels[verb] ?? '';
                        return (
                          <Field key={verb} label={label}>
                            <Select
                              value={selectedModel}
                              onChange={(e) =>
                                setLoopRunVerbModels((prev) => ({
                                  ...prev,
                                  [verb]: e.target.value,
                                }))
                              }
                              disabled={!availableModels.length}
                            >
                              <option value="">Settings default</option>
                              {availableModels.map((entry) => (
                                <option key={entry} value={entry}>
                                  {entry}
                                </option>
                              ))}
                            </Select>
                            <p className="mt-1 text-xs text-muted">{hint}</p>
                          </Field>
                        );
                      })}
                    </div>
                  ) : hasNonEmptyLoopVerbModel(loopRunVerbModels) ? (
                    <p className="mt-3 text-xs text-on-surface-variant">
                      {LOOP_VERBS.filter((verb) => loopRunVerbModels[verb]?.trim())
                        .map(
                          (verb) =>
                            `${LOOP_VERB_LABELS[verb].label}: ${loopRunVerbModels[verb]}`
                        )
                        .join(' · ')}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : mode !== 'review' ? (
              <Field label="Model">
                <Select
                  required
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!availableModels.length}
                >
                  {!availableModels.length ? (
                    <option value="">
                      {ollama?.reachable === false
                        ? '— Ollama unreachable —'
                        : '— no models available —'}
                    </option>
                  ) : (
                    availableModels.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                        {entry === defaultModel && ' (default)'}
                      </option>
                    ))
                  )}
                </Select>
              </Field>
            ) : null}
            {mode !== 'review' ? (
              <>
            <Field label="Commit message">
              <TextInput
                placeholder="Agent: task description"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-4 sm:flex-row">
              <CheckboxField
                label="Push branch on completion"
                checked={push}
                onChange={(e) => setPush(e.target.checked)}
              />
              <CheckboxField
                label="Commit/push even if OpenCode fails"
                checked={pushOnFailure}
                onChange={(e) => setPushOnFailure(e.target.checked)}
              />
            </div>
            <div>
              <CheckboxField
                label="Auto-approve permissions"
                checked={displayedAutoApprove}
                onChange={(e) => {
                  const next = e.target.checked;
                  setAutoApproveExplicit(true);
                  setAutoApprovePermissions(next);
                }}
              />
              <p className="mt-1.5 text-xs text-muted">
                {autoApproveExplicit
                  ? 'Explicit override for this agent.'
                  : `Uses Settings default (${modeAutoApproveDefault ? 'on' : 'off'}) when not set.`}
              </p>
            </div>
            <Field label={mode === 'loop' ? 'Goal' : 'Prompt'}>
              <TextArea
                rows={4}
                placeholder={
                  mode === 'loop'
                    ? 'Describe what the harness should achieve across iterations…'
                    : 'Describe the change for the agent…'
                }
                required
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
              </>
            ) : null}
            <FormActions className="justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={closeCreateModal}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={startDisabled}
              >
                {mode === 'review' ? 'Start review' : 'Start agent'}
              </Button>
            </FormActions>
          </FormGrid>
        </form>
      </Modal>
    </div>
  );
}
