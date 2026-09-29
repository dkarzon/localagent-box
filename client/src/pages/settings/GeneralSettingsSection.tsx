import { useState } from 'react';
import { cleanupOldWorkspaces } from '../../api/agents';
import { IconFolder, IconKey } from '../../components/icons';
import { SectionCard } from '../../components/ui/Card';
import { Button, CheckboxField, Field, TextInput } from '../../components/ui/Form';
import { StatusMessage } from '../../components/ui/StatusMessage';
import type { StatusVariant } from '../../api/types';
import { SETTINGS_SEARCH_KEYWORDS, makeShowSection } from './helpers';

interface GeneralSettingsSectionProps {
  token: string;
  setToken: (value: string) => void;
  webhookUrl: string;
  setWebhookUrl: (value: string) => void;
  autoCreatePullRequest: boolean;
  setAutoCreatePullRequest: (value: boolean) => void;
  searchQuery: string;
}

export function GeneralSettingsSection({
  token,
  setToken,
  webhookUrl,
  setWebhookUrl,
  autoCreatePullRequest,
  setAutoCreatePullRequest,
  searchQuery,
}: GeneralSettingsSectionProps) {
  const [showToken, setShowToken] = useState(false);
  const [workspaceRetentionDays, setWorkspaceRetentionDays] = useState(30);
  const [cleanupStatus, setCleanupStatus] = useState('');
  const [cleanupStatusVariant, setCleanupStatusVariant] = useState<StatusVariant>('');
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const showSection = makeShowSection(searchQuery);
  const keywords = SETTINGS_SEARCH_KEYWORDS.general;

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
        parts.push(
          `skipped ${result.skippedActive.length} active session${result.skippedActive.length === 1 ? '' : 's'}`,
        );
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

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {showSection(keywords.apiToken) ? (
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
            <code className="code-md text-on-surface-variant">API_TOKEN</code> env var if necessary.
          </p>
        </SectionCard>
      ) : null}

      {showSection(keywords.webhook) ? (
        <SectionCard title="Webhooks" icon={<span className="code-md text-secondary">WH</span>}>
          <Field label="Webhook Target URL">
            <TextInput
              name="webhookUrl"
              type="url"
              placeholder="https://example.com/hooks/agent"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </Field>
          <p className="mt-2 text-sm text-muted">
            Enter the URL where webhook events will be sent.
          </p>
        </SectionCard>
      ) : null}

      {showSection(keywords.pullRequest) ? (
        <SectionCard
          title="Pull requests"
          icon={<span className="code-md text-secondary">PR</span>}
          className="lg:col-span-2"
        >
          <CheckboxField
            label="Auto-create pull request when an agent completes"
            checked={autoCreatePullRequest}
            onChange={(e) => setAutoCreatePullRequest(e.target.checked)}
          />
          <p className="mt-2 text-sm text-muted">
            When enabled (default), a draft PR is opened automatically once an agent finishes and
            pushes its branch. Disable to only create PRs manually via the session page.
          </p>
        </SectionCard>
      ) : null}

      {showSection(keywords.workspace) ? (
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
    </div>
  );
}
