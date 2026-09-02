import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { cleanupOldWorkspaces } from '../api/agents';
import { apiFetch, authHeaders } from '../api/client';
import {
  CONFIG_FIELDS,
  LOOP_VERB_LABELS,
  LOOP_VERB_MODELS_DEFAULT,
  LOOP_VERBS,
  mergeLoopVerbModels,
  type AppConfig,
  type ConfigField,
  type GithubStatus,
  type LoopVerb,
  type LoopVerbModels,
  type OllamaStatus,
  type StatusVariant,
} from '../api/types';
import { useApiToken } from '../hooks/useApiToken';
import { PAGE_SUBTITLES, PAGE_TITLES } from '../navigation';
import {
  IconCheck,
  IconFolder,
  IconGithub,
  IconKey,
  IconLock,
  IconRefresh,
  IconWebhook,
} from '../components/icons';
import { SectionCard } from '../components/ui/Card';
import { Button, CheckboxField, Field, Select, TextArea, TextInput } from '../components/ui/Form';
import { formatFileSize, formatModelUpdated } from '../lib/format';
import { StatusMessage } from '../components/ui/StatusMessage';

type FormValues = Record<ConfigField, string>;

interface SettingsPageProps {
  searchQuery?: string;
}

function configToFormValues(config: AppConfig): FormValues {
  const values = {} as FormValues;
  for (const field of CONFIG_FIELDS) {
    if (field === 'githubAppPrivateKey') {
      values[field] = config.hasGithubAppPrivateKey ? '***' : '';
      continue;
    }
    values[field] = (config[field] as string) || '';
  }
  return values;
}

function privateKeyPlaceholder(config: AppConfig) {
  return config.hasGithubAppPrivateKey
    ? 'Existing key stored — paste new PEM to replace'
    : 'Paste GitHub App private key PEM';
}

function describeOllama(ollama: OllamaStatus | null | undefined): {
  message: string;
  variant: StatusVariant;
  connected: boolean;
} {
  if (!ollama) return { message: 'No status', variant: '', connected: false };
  if (ollama.status === 'not_configured') {
    return { message: 'Not configured', variant: '', connected: false };
  }
  if (!ollama.reachable) {
    return { message: 'Unreachable', variant: 'error', connected: false };
  }
  return { message: 'Connected', variant: 'success', connected: true };
}

function fieldMatchesSearch(label: string, value: string, query: string) {
  const haystack = `${label} ${value}`.toLowerCase();
  return haystack.includes(query);
}

export function SettingsPage({ searchQuery = '' }: SettingsPageProps) {
  const { token, setToken } = useApiToken();
  const [showToken, setShowToken] = useState(false);
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(CONFIG_FIELDS.map((f) => [f, ''])) as FormValues,
  );
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [batchAutoApprovePermissions, setBatchAutoApprovePermissions] = useState(true);
  const [loopAutoApprovePermissions, setLoopAutoApprovePermissions] = useState(true);
  const [interactiveAutoApprovePermissions, setInteractiveAutoApprovePermissions] = useState(false);
  const [interactiveAgentTimeoutSeconds, setInteractiveAgentTimeoutSeconds] = useState(3600);
  const [loopAgentTimeoutSeconds, setLoopAgentTimeoutSeconds] = useState(3600);
  const [loopVerbModels, setLoopVerbModels] = useState<LoopVerbModels>(LOOP_VERB_MODELS_DEFAULT);
  const [autoCreatePullRequest, setAutoCreatePullRequest] = useState(true);
  const [autoReviewPullRequests, setAutoReviewPullRequests] = useState(false);
  const [reviewModel, setReviewModel] = useState('');
  const [workspaceRetentionDays, setWorkspaceRetentionDays] = useState(30);
  const [cleanupStatus, setCleanupStatus] = useState('');
  const [cleanupStatusVariant, setCleanupStatusVariant] = useState<StatusVariant>('');
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const configEverLoadedRef = useRef(false);
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState<StatusVariant>('');
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [githubStatus, setGithubStatus] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const query = searchQuery.trim().toLowerCase();
  const showSection = (labels: string[]) =>
    !query || labels.some((label) => label.toLowerCase().includes(query));

  const loadHealth = useCallback(async () => {
    try {
      const health = await apiFetch<{ ollama?: OllamaStatus }>('/health');
      setOllama(health.ollama ?? null);
    } catch {
      setOllama(null);
    }
  }, []);

  const loadGithubStatus = useCallback(async () => {
    try {
      const gh = await apiFetch<GithubStatus>('/api/v1/github/status');
      if (!gh.configured) {
        setGithubStatus('Credentials incomplete');
        return;
      }
      setGithubStatus(
        gh.gitUserConfigured ? 'GitHub App configured' : 'Configured — git author not set',
      );
    } catch {
      setGithubStatus('Failed to load status');
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setConfigLoaded(false);
    setStatus('Loading settings…');
    setStatusVariant('');
    try {
      const config = await apiFetch<AppConfig>('/api/v1/config');
      setValues(configToFormValues(config));
      setHasExistingKey(Boolean(config.hasGithubAppPrivateKey));
      setBatchAutoApprovePermissions(config.batchAutoApprovePermissions !== false);
      setLoopAutoApprovePermissions(config.loopAutoApprovePermissions !== false);
      setInteractiveAutoApprovePermissions(config.interactiveAutoApprovePermissions === true);
      setInteractiveAgentTimeoutSeconds(config.interactiveAgentTimeoutSeconds ?? 3600);
      setLoopAgentTimeoutSeconds(config.loopAgentTimeoutSeconds ?? 3600);
      setLoopVerbModels(mergeLoopVerbModels(config.loopVerbModels));
      setAutoCreatePullRequest(config.autoCreatePullRequest !== false);
      setAutoReviewPullRequests(config.autoReviewPullRequests === true);
      setReviewModel(config.reviewModel || '');
      configEverLoadedRef.current = true;
      setConfigLoaded(true);
      setStatus('All settings loaded successfully');
      setStatusVariant('success');
    } catch (err) {
      setConfigLoaded(configEverLoadedRef.current);
      setStatus(err instanceof Error ? err.message : 'Failed to load settings');
      setStatusVariant('error');
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadHealth();
    loadGithubStatus();
  }, [loadConfig, loadHealth, loadGithubStatus]);

  const updateField = (field: ConfigField, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const updateLoopVerbModel = (verb: LoopVerb, model: string) => {
    setLoopVerbModels((prev) => ({ ...prev, [verb]: model }));
  };

  const copyGlobalModelToAllLoopVerbs = () => {
    const globalModel = values.opencodeModel.trim();
    if (!globalModel) return;
    setLoopVerbModels({
      INITIAL_PLAN: globalModel,
      ORIENT: globalModel,
      ACT: globalModel,
      REFLECT: globalModel,
    });
  };

  const applyOrientReflectPreset = () => {
    const source =
      loopVerbModels.ORIENT?.trim() ||
      loopVerbModels.REFLECT?.trim() ||
      values.opencodeModel.trim();
    if (!source) return;
    setLoopVerbModels((prev) => ({
      ...prev,
      ORIENT: source,
      REFLECT: source,
    }));
  };

  const saveConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!configLoaded) {
      setStatus('Settings are still loading. Wait for load to finish before saving.');
      setStatusVariant('error');
      return;
    }
    setStatus('Saving settings…');
    setStatusVariant('');

    const payload = {
      ...Object.fromEntries(CONFIG_FIELDS.map((field) => [field, values[field].trim()])),
      batchAutoApprovePermissions,
      loopAutoApprovePermissions,
      interactiveAutoApprovePermissions,
      interactiveAgentTimeoutSeconds,
      loopAgentTimeoutSeconds,
      loopVerbModels,
      autoCreatePullRequest,
      autoReviewPullRequests,
      reviewModel: reviewModel.trim(),
    };

    try {
      const config = await apiFetch<AppConfig>('/api/v1/config', {
        method: 'PUT',
        headers: authHeaders(token, true),
        body: JSON.stringify(payload),
      });
      setValues(configToFormValues(config));
      setHasExistingKey(Boolean(config.hasGithubAppPrivateKey));
      setBatchAutoApprovePermissions(config.batchAutoApprovePermissions !== false);
      setLoopAutoApprovePermissions(config.loopAutoApprovePermissions !== false);
      setInteractiveAutoApprovePermissions(config.interactiveAutoApprovePermissions === true);
      setInteractiveAgentTimeoutSeconds(config.interactiveAgentTimeoutSeconds ?? 3600);
      setLoopAgentTimeoutSeconds(config.loopAgentTimeoutSeconds ?? 3600);
      setLoopVerbModels(mergeLoopVerbModels(config.loopVerbModels));
      setAutoCreatePullRequest(config.autoCreatePullRequest !== false);
      setAutoReviewPullRequests(config.autoReviewPullRequests === true);
      setReviewModel(config.reviewModel || '');

      let message = 'Settings saved.';
      if (config.opencode?.path) {
        message += ` OpenCode config written to ${config.opencode.path}.`;
      }
      setStatus(message);
      setStatusVariant('success');
      await loadHealth();
      await loadGithubStatus();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to save settings');
      setStatusVariant('error');
    }
  };

  const runWorkspaceCleanup = async () => {
    if (!Number.isFinite(workspaceRetentionDays) || workspaceRetentionDays < 1) {
      setCleanupStatus('Enter at least 1 day to keep.');
      setCleanupStatusVariant('error');
      return;
    }

    const confirmed = window.confirm(
      `Permanently delete all finished agent sessions and workspaces older than ${workspaceRetentionDays} day${workspaceRetentionDays === 1 ? '' : 's'}? Active sessions are never removed.`,
    );
    if (!confirmed) {
      return;
    }

    setCleanupBusy(true);
    setCleanupStatus('Cleaning up old workspaces…');
    setCleanupStatusVariant('');

    try {
      const result = await cleanupOldWorkspaces(workspaceRetentionDays, token);
      const parts: string[] = [];
      if (result.deleted.length > 0) {
        parts.push(
          `Deleted ${result.deleted.length} session${result.deleted.length === 1 ? '' : 's'}`,
        );
      } else {
        parts.push('No sessions matched the retention window');
      }
      if (result.orphanWorkspacesRemoved.length > 0) {
        parts.push(
          `removed ${result.orphanWorkspacesRemoved.length} orphan workspace${result.orphanWorkspacesRemoved.length === 1 ? '' : 's'}`,
        );
      }
      if (result.skippedActive.length > 0) {
        parts.push(`skipped ${result.skippedActive.length} active session${result.skippedActive.length === 1 ? '' : 's'}`);
      }
      setCleanupStatus(parts.join('; ') + '.');
      setCleanupStatusVariant('success');
    } catch (err) {
      setCleanupStatus(err instanceof Error ? err.message : 'Failed to clean up workspaces');
      setCleanupStatusVariant('error');
    } finally {
      setCleanupBusy(false);
    }
  };

  const ollamaInfo = describeOllama(ollama);
  const availableModels = useMemo(
    () =>
      [...(ollama?.models ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((model) => model.name),
    [ollama?.models],
  );
  const filteredModels =
    query && ollama?.models
      ? ollama.models
          .filter((model) => fieldMatchesSearch(model.name, model.name, query))
          .sort((a, b) => a.name.localeCompare(b.name))
      : ollama?.models
          ? [...ollama.models].sort((a, b) => a.name.localeCompare(b.name))
          : null;

  return (
    <>
      <div ref={scrollRef} className="mx-auto max-w-5xl overflow-x-hidden px-6 py-6 pb-32">
        <header className="mb-10">
          <h2 className="headline-lg text-primary">{PAGE_TITLES.settings}</h2>
          <p className="mt-1 max-w-2xl body-md text-on-surface-variant">{PAGE_SUBTITLES.settings}</p>
        </header>

        <form id="settings-form" onSubmit={saveConfig} className="grid gap-6 lg:grid-cols-2">
          {showSection(['api', 'token', 'bearer']) ? (
            <SectionCard title="API Access" icon={<IconKey className="size-4" />}>
              <Field label="Bearer Token" className="mb-2">
                <div className="relative">
                  <TextInput
                    type={showToken ? 'text' : 'password'}
                    placeholder="API_TOKEN"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="pr-14"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-on-surface cursor-pointer"
                  >
                    {showToken ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>
              <p className="text-sm text-muted">
                Default token for local operations. Override via{' '}
                <code className="code-md text-on-surface-variant">API_TOKEN</code> env var if
                necessary.
              </p>
            </SectionCard>
          ) : null}

          {showSection(['ollama', 'model', 'provider']) ? (
            <SectionCard
              title="Ollama Status"
              icon={<span className="size-2 rounded-full bg-success" />}
              action={
                ollamaInfo.connected ? (
                  <span className="flex items-center gap-1.5 text-xs text-success">
                    <span className="size-1.5 rounded-full bg-success" />
                    {ollamaInfo.message}
                  </span>
                ) : (
                  <StatusMessage message={ollamaInfo.message} variant={ollamaInfo.variant} mono />
                )
              }
            >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row">
                <div className="flex-1">
                  <TextInput
                    type="url"
                    name="ollamaBaseUrl"
                    placeholder="http://192.168.1.50:11434"
                    value={values.ollamaBaseUrl}
                    onChange={(e) => updateField('ollamaBaseUrl', e.target.value)}
                    className="mb-2 sm:mb-0"
                  />
                  <Button type="button" variant="ghost" onClick={loadHealth} className="w-full">
                    <IconRefresh className="size-4" />
                    Refresh Status
                  </Button>
                </div>
              </div>
              {filteredModels?.length ? (
                <div className="divide-y divide-surface-low rounded border border-outline-variant">
                  {filteredModels.map((model) => (
                    <div
                      key={model.name}
                      className="flex items-start justify-between gap-4 px-4 py-2.5 code-md"
                    >
                      <span className="text-on-surface-variant">{model.name}</span>
                      <div className="shrink-0 text-right text-muted">
                        {model.size != null ? (
                          <p className="text-on-surface-variant">{formatFileSize(model.size)}</p>
                        ) : null}
                        {model.modifiedAt ? (
                          <p className="mt-0.5">{formatModelUpdated(model.modifiedAt)}</p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="code-md text-muted">No models reported.</p>
              )}
            </SectionCard>
          ) : null}

          {showSection(['github', 'git', 'app', 'private key']) ? (
            <SectionCard title="GitHub Integration" icon={<IconGithub className="size-4" />} className="lg:col-span-2">
              <StatusMessage message={githubStatus} variant="" className="mb-4" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="App ID">
                  <TextInput
                    name="githubAppId"
                    value={values.githubAppId}
                    onChange={(e) => updateField('githubAppId', e.target.value)}
                  />
                </Field>
                <Field label="Installation ID">
                  <TextInput
                    name="githubAppInstallationId"
                    value={values.githubAppInstallationId}
                    onChange={(e) => updateField('githubAppInstallationId', e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Private Key (PEM)" className="mt-4">
                <TextArea
                  name="githubAppPrivateKey"
                  rows={4}
                  placeholder={privateKeyPlaceholder({ hasGithubAppPrivateKey: hasExistingKey })}
                  value={values.githubAppPrivateKey === '***' ? '' : values.githubAppPrivateKey}
                  onChange={(e) => updateField('githubAppPrivateKey', e.target.value)}
                />
              </Field>
              <p className="mt-2 text-sm text-muted">
                Paste your PEM private key generated in GitHub App settings.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Git User Name">
                  <TextInput
                    name="gitUserName"
                    value={values.gitUserName}
                    onChange={(e) => updateField('gitUserName', e.target.value)}
                  />
                </Field>
                <Field label="Git User Email">
                  <TextInput
                    name="gitUserEmail"
                    type="text"
                    inputMode="email"
                    value={values.gitUserEmail}
                    onChange={(e) => updateField('gitUserEmail', e.target.value)}
                  />
                </Field>
              </div>
              <p className="mt-2 text-sm text-muted">
                Leave blank to auto-fill from your GitHub App&apos;s <code className="code-md">[bot]</code>{' '}
                identity when you save. Set manually only if you need a custom commit author.
              </p>
            </SectionCard>
          ) : null}

          {showSection(['webhook', 'url', 'hook']) ? (
            <SectionCard title="Webhooks" icon={<IconWebhook className="size-4" />}>
              <Field label="Webhook Target URL">
                <TextInput
                  name="webhookUrl"
                  type="url"
                  placeholder="https://example.com/hooks/agent"
                  value={values.webhookUrl}
                  onChange={(e) => updateField('webhookUrl', e.target.value)}
                />
              </Field>
              <p className="mt-2 text-sm text-muted">
                Enter the URL where webhook events will be sent.
              </p>
            </SectionCard>
          ) : null}

          {showSection(['opencode', 'model', 'provider', 'system prompt']) ? (
            <SectionCard
              title="OpenCode"
              icon={<span className="code-md text-secondary">OC</span>}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Model">
                  <TextInput
                    name="opencodeModel"
                    placeholder="qwen2.5-coder:7b"
                    value={values.opencodeModel}
                    onChange={(e) => updateField('opencodeModel', e.target.value)}
                  />
                </Field>
                <Field label="Provider">
                  <TextInput
                    name="opencodeProvider"
                    value={values.opencodeProvider || 'ollama'}
                    onChange={(e) => updateField('opencodeProvider', e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Default System Prompt" className="mt-4">
                <TextArea
                  name="systemPrompt"
                  rows={3}
                  placeholder="Optional default system prompt prepended for every agent"
                  value={values.systemPrompt}
                  onChange={(e) => updateField('systemPrompt', e.target.value)}
                />
              </Field>
              <p className="mt-2 text-sm text-muted">
                Applies to batch, interactive, and loop agents when neither the create-agent request
                nor a repo's <code className="code-md text-on-surface-variant">.localagent-box/config.json</code>{' '}
                sets their own <code className="code-md text-on-surface-variant">systemPrompt</code>. Leave blank
                to use OpenCode's own default.
              </p>
            </SectionCard>
          ) : null}

          {showSection(['review', 'code review', 'ocr', 'pull request', 'auto-review', 'auto-create']) ? (
            <SectionCard
              title="Pull requests & review"
              icon={<span className="code-md text-secondary">CR</span>}
              className="lg:col-span-2"
            >
              <CheckboxField
                label="Auto-create pull request when an agent completes"
                checked={autoCreatePullRequest}
                onChange={(e) => setAutoCreatePullRequest(e.target.checked)}
              />
              <p className="mt-2 text-sm text-muted">
                When enabled (default), a draft PR is opened automatically once an agent finishes and
                pushes its branch. Disable to only create PRs manually via the session page. A given
                agent's create request can override this default.
              </p>
              <hr className="my-4 border-surface-container-highest" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Review model">
                  <TextInput
                    name="reviewModel"
                    placeholder="Leave empty to use OpenCode model"
                    value={reviewModel}
                    onChange={(e) => setReviewModel(e.target.value)}
                  />
                </Field>
              </div>
              <div className="mt-4">
                <CheckboxField
                  label="Auto-review pull requests after agent-created PRs"
                  checked={autoReviewPullRequests}
                  onChange={(e) => setAutoReviewPullRequests(e.target.checked)}
                />
                <p className="mt-2 text-sm text-muted">
                  When enabled, a review agent is queued automatically after a coding agent creates a
                  pull request. Per-repo settings can override this default.
                </p>
              </div>
            </SectionCard>
          ) : null}

          {showSection(['workspace', 'cleanup', 'retention', 'delete', 'session']) ? (
            <SectionCard
              title="Workspace Cleanup"
              icon={<IconFolder className="size-4" />}
              className="lg:col-span-2"
            >
              <Field label="Days of data to keep">
                <TextInput
                  type="number"
                  name="workspaceRetentionDays"
                  min={1}
                  max={3650}
                  value={workspaceRetentionDays}
                  onChange={(e) => setWorkspaceRetentionDays(Number(e.target.value))}
                />
                <p className="mt-1 text-sm text-muted">
                  Finished agent sessions and their git workspaces older than this many days will be
                  removed. Active sessions are always kept.
                </p>
              </Field>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="primary"
                  onClick={runWorkspaceCleanup}
                  disabled={cleanupBusy}
                >
                  {cleanupBusy ? 'Cleaning up…' : 'Delete older workspaces'}
                </Button>
                {cleanupStatus ? (
                  <StatusMessage message={cleanupStatus} variant={cleanupStatusVariant} />
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          {showSection(['opencode', 'permissions', 'auto-approve', 'tool', 'timeout', 'interactive', 'loop', 'observe', 'plan', 'act', 'reflect', 'initial plan']) ? (
            <SectionCard
              title="OpenCode permissions"
              icon={<span className="code-md text-secondary">OC</span>}
              className="lg:col-span-2"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:gap-8">
                <CheckboxField
                  label="Batch — auto-approve tool permissions"
                  checked={batchAutoApprovePermissions}
                  onChange={(e) => setBatchAutoApprovePermissions(e.target.checked)}
                />
                <CheckboxField
                  label="Loop — auto-approve tool permissions"
                  checked={loopAutoApprovePermissions}
                  onChange={(e) => setLoopAutoApprovePermissions(e.target.checked)}
                />
                <CheckboxField
                  label="Interactive — auto-approve tool permissions"
                  checked={interactiveAutoApprovePermissions}
                  onChange={(e) => setInteractiveAutoApprovePermissions(e.target.checked)}
                />
              </div>
              <p className="mt-3 text-sm text-muted">
                When enabled, OpenCode tool permission prompts are auto-approved via per-agent{' '}
                <code className="code-md text-on-surface-variant">opencode.json</code>. Batch and loop
                default to on; interactive defaults to off. Per-agent overrides on create take
                precedence.
              </p>
              <hr className="my-4 border-surface-container-highest" />
              <Field label="Interactive Agent Timeout (seconds)">
                <TextInput
                  type="number"
                  name="interactiveAgentTimeoutSeconds"
                  min={60}
                  max={86400}
                  value={interactiveAgentTimeoutSeconds}
                  onChange={(e) => setInteractiveAgentTimeoutSeconds(Number(e.target.value))}
                />
                <p className="mt-1 text-sm text-muted">
                  Max duration (in seconds) of running time before an interactive session
                  auto-terminates. Queue wait does not count. Default: 3600 (1 hour). Min: 60,
                  Max: 86400 (24h).
                </p>
              </Field>
              <Field label="Loop Agent Timeout (seconds)">
                <TextInput
                  type="number"
                  name="loopAgentTimeoutSeconds"
                  min={60}
                  max={86400}
                  value={loopAgentTimeoutSeconds}
                  onChange={(e) => setLoopAgentTimeoutSeconds(Number(e.target.value))}
                />
                <p className="mt-1 text-sm text-muted">
                  Max duration (in seconds) of running time before a loop session auto-terminates.
                  Queue wait does not count. Default: 3600 (1 hour). Min: 60, Max: 86400 (24h).
                </p>
              </Field>
              <hr className="my-4 border-surface-container-highest" />
              <div>
                <h3 className="label-md text-on-surface">Loop mode — models per step</h3>
                <p className="mt-1 text-sm text-muted">
                  Leave blank to use the global OpenCode model (or the per-agent model override on
                  create). Loop step prompts still come from{' '}
                  <code className="code-md text-on-surface-variant">config/loop.default.json</code>{' '}
                  or repo{' '}
                  <code className="code-md text-on-surface-variant">.localagent-box/loop.json</code>
                  .
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={copyGlobalModelToAllLoopVerbs}
                    disabled={!values.opencodeModel.trim()}
                  >
                    Copy global model to all verbs
                  </Button>
                  <Button type="button" variant="ghost" onClick={applyOrientReflectPreset}>
                    Same model for Orient / Reflect
                  </Button>
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {LOOP_VERBS.map((verb) => {
                    const { label, hint } = LOOP_VERB_LABELS[verb];
                    const selectedModel = loopVerbModels[verb] ?? '';
                    if (
                      query &&
                      !fieldMatchesSearch(label, selectedModel, query) &&
                      !fieldMatchesSearch(hint, verb, query)
                    ) {
                      return null;
                    }
                    const modelOptions =
                      selectedModel && !availableModels.includes(selectedModel)
                        ? [selectedModel, ...availableModels]
                        : availableModels;
                    return (
                      <Field key={verb} label={label}>
                        <Select
                          value={selectedModel}
                          onChange={(e) => updateLoopVerbModel(verb, e.target.value)}
                        >
                          <option value="">Default (use global model)</option>
                          {!modelOptions.length ? (
                            <option value="" disabled>
                              {ollama?.reachable === false
                                ? '— Ollama unreachable —'
                                : '— no models available —'}
                            </option>
                          ) : (
                            modelOptions.map((entry) => (
                              <option key={entry} value={entry}>
                                {entry}
                                {entry === values.opencodeModel.trim() ? ' (global default)' : ''}
                                {selectedModel === entry && !availableModels.includes(entry)
                                  ? ' (not in Ollama list)'
                                  : ''}
                              </option>
                            ))
                          )}
                        </Select>
                        <p className="mt-1 text-xs text-muted">{hint}</p>
                      </Field>
                    );
                  })}
                </div>
              </div>
            </SectionCard>
          ) : null}

          {status && statusVariant !== 'success' ? (
            <StatusMessage message={status} variant={statusVariant} className="lg:col-span-2" mono />
          ) : null}
        </form>

        <footer className="fixed bottom-16 left-0 right-0 z-20 flex flex-col gap-3 border-t border-surface-container-highest bg-surface-low/95 px-4 py-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-4 md:bottom-0 md:ml-60">
          <div className="flex min-w-0 items-center gap-2">
            {statusVariant === 'success' && status ? (
              <>
                <IconCheck className="size-3.5 shrink-0 text-success" />
                <span className="min-w-0 flex-1 code-md text-success line-clamp-2 sm:truncate" title={status}>
                  {status}
                </span>
              </>
            ) : status ? (
              <StatusMessage message={status} variant={statusVariant} mono className="min-w-0 truncate" />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-4">
            <Button type="button" variant="ghost" onClick={loadConfig}>
              <span className="sm:hidden">Discard</span>
              <span className="hidden sm:inline">Discard Changes</span>
            </Button>
            <Button type="submit" variant="primary" form="settings-form" disabled={!configLoaded}>
              <IconLock className="size-3.5" />
              <span className="sm:hidden">Save</span>
              <span className="hidden sm:inline">Commit System Changes</span>
            </Button>
          </div>
        </footer>
      </div>
    </>
  );
}
