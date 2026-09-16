import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { apiFetch, authHeaders } from '../api/client';
import {
  mergeLoopVerbModels,
  type AppConfig,
  type GithubStatus,
  type HealthResponse,
  type LoopVerbModels,
  type LlmProviderId,
  type StatusVariant,
} from '../api/types';
import { useApiToken } from '../hooks/useApiToken';
import { getSettingsSection } from '../navigation';
import { GeneralSettingsSection } from './settings/GeneralSettingsSection';
import { GithubSettingsSection } from './settings/GithubSettingsSection';
import { ModelsSettingsSection } from './settings/ModelsSettingsSection';
import { OcrSettingsSection } from './settings/OcrSettingsSection';
import { OpenCodeSettingsSection } from './settings/OpenCodeSettingsSection';
import { SettingsLayout } from './settings/SettingsLayout';

interface SettingsPageProps {
  searchQuery?: string;
}

export function SettingsPage({ searchQuery = '' }: SettingsPageProps) {
  const { token, setToken } = useApiToken();
  const location = useLocation();
  const section = getSettingsSection(location.pathname);
  const formId = `settings-form-${section}`;

  const [config, setConfig] = useState<AppConfig>({});
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [showCloudKey, setShowCloudKey] = useState(false);

  const [webhookUrl, setWebhookUrl] = useState('');
  const [autoCreatePullRequest, setAutoCreatePullRequest] = useState(true);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('');
  const [ollamaCloudApiKey, setOllamaCloudApiKey] = useState('');
  const [ollamaCloudBaseUrl, setOllamaCloudBaseUrl] = useState('');
  const [githubAppId, setGithubAppId] = useState('');
  const [githubAppInstallationId, setGithubAppInstallationId] = useState('');
  const [githubAppPrivateKey, setGithubAppPrivateKey] = useState('');
  const [gitUserName, setGitUserName] = useState('');
  const [gitUserEmail, setGitUserEmail] = useState('');
  const [opencodeProvider, setOpencodeProvider] = useState<LlmProviderId>('ollama');
  const [opencodeModel, setOpencodeModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [reviewProvider, setReviewProvider] = useState<LlmProviderId | ''>('');
  const [reviewModel, setReviewModel] = useState('');
  const [autoReviewPullRequests, setAutoReviewPullRequests] = useState(false);
  const [batchAutoApprovePermissions, setBatchAutoApprovePermissions] = useState(true);
  const [loopAutoApprovePermissions, setLoopAutoApprovePermissions] = useState(true);
  const [interactiveAutoApprovePermissions, setInteractiveAutoApprovePermissions] = useState(false);
  const [interactiveAgentTimeoutSeconds, setInteractiveAgentTimeoutSeconds] = useState(3600);
  const [loopAgentTimeoutSeconds, setLoopAgentTimeoutSeconds] = useState(3600);
  const [loopVerbModels, setLoopVerbModels] = useState<LoopVerbModels>({
    INITIAL_PLAN: '',
    ORIENT: '',
    ACT: '',
    REFLECT: '',
  });

  const [githubStatus, setGithubStatus] = useState('');
  const [configLoaded, setConfigLoaded] = useState(false);
  const configEverLoadedRef = useRef(false);
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState<StatusVariant>('');

  const applyConfig = useCallback((next: AppConfig) => {
    setConfig(next);
    setWebhookUrl(next.webhookUrl || '');
    setAutoCreatePullRequest(next.autoCreatePullRequest !== false);
    setOllamaBaseUrl(next.ollamaBaseUrl || '');
    setOllamaCloudApiKey(next.ollamaCloudApiKey || '');
    setOllamaCloudBaseUrl(next.ollamaCloudBaseUrl || '');
    setGithubAppId(next.githubAppId || '');
    setGithubAppInstallationId(next.githubAppInstallationId || '');
    setGithubAppPrivateKey(next.hasGithubAppPrivateKey ? '***' : '');
    setHasExistingKey(Boolean(next.hasGithubAppPrivateKey));
    setGitUserName(next.gitUserName || '');
    setGitUserEmail(next.gitUserEmail || '');
    setOpencodeProvider(next.opencodeProvider || 'ollama');
    setOpencodeModel(next.opencodeModel || '');
    setSystemPrompt(next.systemPrompt || '');
    setReviewProvider(next.reviewProvider || '');
    setReviewModel(next.reviewModel || '');
    setAutoReviewPullRequests(next.autoReviewPullRequests === true);
    setBatchAutoApprovePermissions(next.batchAutoApprovePermissions !== false);
    setLoopAutoApprovePermissions(next.loopAutoApprovePermissions !== false);
    setInteractiveAutoApprovePermissions(next.interactiveAutoApprovePermissions === true);
    setInteractiveAgentTimeoutSeconds(next.interactiveAgentTimeoutSeconds ?? 3600);
    setLoopAgentTimeoutSeconds(next.loopAgentTimeoutSeconds ?? 3600);
    setLoopVerbModels(mergeLoopVerbModels(next.loopVerbModels));
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const next = await apiFetch<HealthResponse>('/health');
      setHealth(next);
    } catch {
      setHealth(null);
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
      const next = await apiFetch<AppConfig>('/api/v1/config');
      applyConfig(next);
      configEverLoadedRef.current = true;
      setConfigLoaded(true);
      setStatus('All settings loaded successfully');
      setStatusVariant('success');
    } catch (err) {
      setConfigLoaded(configEverLoadedRef.current);
      setStatus(err instanceof Error ? err.message : 'Failed to load settings');
      setStatusVariant('error');
    }
  }, [applyConfig]);

  useEffect(() => {
    void loadConfig();
    void loadHealth();
    void loadGithubStatus();
  }, [loadConfig, loadHealth, loadGithubStatus]);

  const buildPayload = () => {
    switch (section) {
      case 'general':
        return {
          webhookUrl: webhookUrl.trim(),
          autoCreatePullRequest,
        };
      case 'models':
        return {
          ollamaBaseUrl: ollamaBaseUrl.trim(),
          ollamaCloudApiKey: ollamaCloudApiKey.trim(),
          ollamaCloudBaseUrl: ollamaCloudBaseUrl.trim(),
        };
      case 'github':
        return {
          githubAppId: githubAppId.trim(),
          githubAppInstallationId: githubAppInstallationId.trim(),
          githubAppPrivateKey: githubAppPrivateKey.trim(),
          gitUserName: gitUserName.trim(),
          gitUserEmail: gitUserEmail.trim(),
        };
      case 'opencode':
        return {
          opencodeProvider,
          opencodeModel: opencodeModel.trim(),
          systemPrompt: systemPrompt.trim(),
          batchAutoApprovePermissions,
          loopAutoApprovePermissions,
          interactiveAutoApprovePermissions,
          interactiveAgentTimeoutSeconds,
          loopAgentTimeoutSeconds,
          loopVerbModels,
        };
      case 'ocr':
        return {
          reviewProvider,
          reviewModel: reviewModel.trim(),
          autoReviewPullRequests,
        };
      default:
        return {};
    }
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

    try {
      const saved = await apiFetch<AppConfig>('/api/v1/config', {
        method: 'PUT',
        headers: authHeaders(token, true),
        body: JSON.stringify(buildPayload()),
      });
      applyConfig(saved);

      let message = 'Settings saved.';
      if (saved.opencode?.path) {
        message += ` OpenCode config written to ${saved.opencode.path}.`;
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

  const refreshLocalHealth = () => void loadHealth();
  const refreshCloudHealth = () => void loadHealth();

  return (
    <SettingsLayout
      formId={formId}
      status={status}
      statusVariant={statusVariant}
      configLoaded={configLoaded}
      onDiscard={loadConfig}
    >
      <form id={formId} onSubmit={saveConfig}>
        {section === 'general' ? (
          <GeneralSettingsSection
            token={token}
            setToken={setToken}
            webhookUrl={webhookUrl}
            setWebhookUrl={setWebhookUrl}
            autoCreatePullRequest={autoCreatePullRequest}
            setAutoCreatePullRequest={setAutoCreatePullRequest}
            searchQuery={searchQuery}
          />
        ) : null}

        {section === 'models' ? (
          <ModelsSettingsSection
            config={config}
            ollamaLocal={health?.providers?.ollama ?? health?.ollama ?? null}
            ollamaCloud={health?.providers?.['ollama-cloud'] ?? null}
            ollamaBaseUrl={ollamaBaseUrl}
            setOllamaBaseUrl={setOllamaBaseUrl}
            ollamaCloudApiKey={ollamaCloudApiKey}
            setOllamaCloudApiKey={setOllamaCloudApiKey}
            ollamaCloudBaseUrl={ollamaCloudBaseUrl}
            setOllamaCloudBaseUrl={setOllamaCloudBaseUrl}
            showCloudKey={showCloudKey}
            setShowCloudKey={setShowCloudKey}
            onRefreshLocal={refreshLocalHealth}
            onRefreshCloud={refreshCloudHealth}
            searchQuery={searchQuery}
          />
        ) : null}

        {section === 'github' ? (
          <GithubSettingsSection
            githubStatus={githubStatus}
            githubAppId={githubAppId}
            setGithubAppId={setGithubAppId}
            githubAppInstallationId={githubAppInstallationId}
            setGithubAppInstallationId={setGithubAppInstallationId}
            githubAppPrivateKey={githubAppPrivateKey}
            setGithubAppPrivateKey={setGithubAppPrivateKey}
            hasExistingKey={hasExistingKey}
            gitUserName={gitUserName}
            setGitUserName={setGitUserName}
            gitUserEmail={gitUserEmail}
            setGitUserEmail={setGitUserEmail}
            searchQuery={searchQuery}
          />
        ) : null}

        {section === 'opencode' ? (
          <OpenCodeSettingsSection
            config={config}
            health={health}
            opencodeProvider={opencodeProvider}
            setOpencodeProvider={setOpencodeProvider}
            opencodeModel={opencodeModel}
            setOpencodeModel={setOpencodeModel}
            systemPrompt={systemPrompt}
            setSystemPrompt={setSystemPrompt}
            batchAutoApprovePermissions={batchAutoApprovePermissions}
            setBatchAutoApprovePermissions={setBatchAutoApprovePermissions}
            loopAutoApprovePermissions={loopAutoApprovePermissions}
            setLoopAutoApprovePermissions={setLoopAutoApprovePermissions}
            interactiveAutoApprovePermissions={interactiveAutoApprovePermissions}
            setInteractiveAutoApprovePermissions={setInteractiveAutoApprovePermissions}
            interactiveAgentTimeoutSeconds={interactiveAgentTimeoutSeconds}
            setInteractiveAgentTimeoutSeconds={setInteractiveAgentTimeoutSeconds}
            loopAgentTimeoutSeconds={loopAgentTimeoutSeconds}
            setLoopAgentTimeoutSeconds={setLoopAgentTimeoutSeconds}
            loopVerbModels={loopVerbModels}
            setLoopVerbModels={setLoopVerbModels}
            searchQuery={searchQuery}
          />
        ) : null}

        {section === 'ocr' ? (
          <OcrSettingsSection
            config={config}
            health={health}
            reviewProvider={reviewProvider}
            setReviewProvider={setReviewProvider}
            reviewModel={reviewModel}
            setReviewModel={setReviewModel}
            autoReviewPullRequests={autoReviewPullRequests}
            setAutoReviewPullRequests={setAutoReviewPullRequests}
            searchQuery={searchQuery}
          />
        ) : null}
      </form>
    </SettingsLayout>
  );
}
