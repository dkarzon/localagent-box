import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { updateRepoSettings } from '../api/repos';
import { apiFetch, authHeaders } from '../api/client';
import type { AutofixSeverityThreshold, Repo, StatusVariant } from '../api/types';
import { useApiToken } from '../hooks/useApiToken';
import { PAGE_SUBTITLES, PAGE_TITLES } from '../navigation';
import { IconFolder, IconInfo, IconRefresh } from '../components/icons';
import { Badge } from '../components/ui/Badge';
import { StatCard } from '../components/ui/Card';
import { Button, Field, Select, TextInput } from '../components/ui/Form';
import { StatusMessage } from '../components/ui/StatusMessage';

interface RepositoriesPageProps {
  repos: Repo[];
  onRefreshRepos: () => Promise<void>;
  searchQuery?: string;
}

type RepoActionState = { message: string; variant: StatusVariant };

const AUTOFIX_THRESHOLD_LABELS: Record<AutofixSeverityThreshold, string> = {
  disabled: 'Disabled',
  critical: 'Critical',
  high: 'High and above',
  medium: 'Medium and above',
  low: 'Low and above',
};

const AUTOFIX_BATCH_SIZE_OPTIONS = Array.from({ length: 20 }, (_, index) => index + 1);

export function RepositoriesPage({ repos, onRefreshRepos, searchQuery = '' }: RepositoriesPageProps) {
  const { token } = useApiToken();
  const [registerStatus, setRegisterStatus] = useState('');
  const [registerVariant, setRegisterVariant] = useState<StatusVariant>('');
  const [repoActions, setRepoActions] = useState<Record<string, RepoActionState>>({});
  const [loadError, setLoadError] = useState('');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');

  const refreshRepos = useCallback(async () => {
    setLoadError('');
    try {
      await onRefreshRepos();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load repos');
    }
  }, [onRefreshRepos]);

  useEffect(() => {
    void refreshRepos();
  }, [refreshRepos]);

  const filteredRepos = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter(
      (repo) =>
        repo.owner.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query) ||
        repo.repoId.toLowerCase().includes(query) ||
        repo.cloneUrl.toLowerCase().includes(query),
    );
  }, [repos, searchQuery]);

  const registerRepo = async (event: FormEvent) => {
    event.preventDefault();
    setRegisterStatus('Registering repository…');
    setRegisterVariant('');

    try {
      await apiFetch('/api/v1/repos', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
          owner: owner.trim(),
          name: name.trim(),
          defaultBranch: defaultBranch.trim() || 'main',
        }),
      });
      setRegisterStatus('Repository registered.');
      setRegisterVariant('success');
      setOwner('');
      setName('');
      setDefaultBranch('main');
      await refreshRepos();
    } catch (err) {
      setRegisterStatus(err instanceof Error ? err.message : 'Registration failed');
      setRegisterVariant('error');
    }
  };

  const setRepoAction = (repoId: string, message: string, variant: StatusVariant) => {
    setRepoActions((prev) => ({ ...prev, [repoId]: { message, variant } }));
  };

  const updateAutoReview = async (repoId: string, value: 'inherit' | 'on' | 'off') => {
    const autoReviewPullRequests = value === 'inherit' ? null : value === 'on';
    setRepoAction(repoId, 'Updating review settings…', '');
    try {
      await updateRepoSettings(repoId, { autoReviewPullRequests }, token);
      setRepoAction(repoId, 'Review settings updated.', 'success');
      await refreshRepos();
    } catch (err) {
      setRepoAction(
        repoId,
        err instanceof Error ? err.message : 'Failed to update review settings',
        'error',
      );
    }
  };

  const updateAutofix = async (repoId: string, autofix: { severityThreshold?: AutofixSeverityThreshold; maxFindingsPerBatch?: number }) => {
    setRepoAction(repoId, 'Updating autofix settings…', '');
    try {
      await updateRepoSettings(repoId, { autofix }, token);
      setRepoAction(repoId, 'Autofix settings updated.', 'success');
      await refreshRepos();
    } catch (err) {
      setRepoAction(
        repoId,
        err instanceof Error ? err.message : 'Failed to update autofix settings',
        'error',
      );
    }
  };

  const verifyRepo = async (repoId: string) => {
    setRepoAction(repoId, 'Verifying clone access…', '');
    try {
      const result = await apiFetch<{ message?: string }>(
        `/api/v1/repos/${encodeURIComponent(repoId)}/verify`,
        { method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({}) },
      );
      setRepoAction(repoId, result.message || 'Repository verified.', 'success');
      await refreshRepos();
    } catch (err) {
      setRepoAction(
        repoId,
        err instanceof Error ? err.message : 'Verification failed',
        'error',
      );
      await refreshRepos();
    }
  };

  const deleteRepo = async (repoId: string) => {
    setRepoAction(repoId, 'Removing repository…', '');
    try {
      await apiFetch(`/api/v1/repos/${encodeURIComponent(repoId)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      });
      setRepoActions((prev) => {
        const next = { ...prev };
        delete next[repoId];
        return next;
      });
      await refreshRepos();
    } catch (err) {
      setRepoAction(repoId, err instanceof Error ? err.message : 'Removal failed', 'error');
    }
  };

  const verifiedCount = repos.filter((r) => r.lastVerifyStatus === 'ok').length;

  return (
    <div className="p-6 pb-32">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="headline-lg text-primary">{PAGE_TITLES.repos}</h2>
          <p className="mt-1 body-md text-on-surface-variant">{PAGE_SUBTITLES.repos}</p>
        </div>
        <Button variant="primary" onClick={() => void refreshRepos()}>
          <IconRefresh className="size-4" />
          Refresh All
        </Button>
      </div>

      <div className="mb-10 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Active Connections"
          value={`${String(verifiedCount).padStart(2, '0')} / ${String(repos.length).padStart(2, '0')}`}
        />
        <StatCard label="Registered Repos" value={repos.length} />
        <StatCard label="Verified" value={verifiedCount} accent />
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="card-surface p-6">
          <header className="mb-6 flex items-center gap-2">
            <h3 className="text-base font-medium text-on-surface">Register Repository</h3>
          </header>
          <form onSubmit={registerRepo} className="grid gap-4">
            <Field label="Owner">
              <TextInput
                placeholder="e.g., your-org"
                required
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </Field>
            <Field label="Repository Name">
              <TextInput
                placeholder="e.g., localagent-box"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Default Branch">
              <TextInput value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
            </Field>
            <div className="flex gap-3">
              <Button type="submit" variant="primary" className="flex-1">
                Register
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOwner('');
                  setName('');
                  setDefaultBranch('main');
                }}
              >
                Clear
              </Button>
            </div>
            {registerStatus ? (
              <StatusMessage message={registerStatus} variant={registerVariant} mono />
            ) : null}
          </form>
        </div>

        <div>
          <header className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-base font-medium text-on-surface">Active Inventory</h3>
              <Badge variant="neutral">{filteredRepos.length} repos</Badge>
            </div>
          </header>

          {loadError ? <StatusMessage message={loadError} variant="error" className="mb-4" /> : null}

          <div className="grid gap-4">
            {!loadError && filteredRepos.length === 0 ? (
              <p className="card-surface py-12 text-center text-sm text-muted">
                No repositories registered yet.
              </p>
            ) : null}

            {filteredRepos.map((repo) => {
              const verifyFailed = repo.lastVerifyStatus && repo.lastVerifyStatus !== 'ok';
              const badgeVariant = verifyFailed
                ? 'error'
                : repo.lastVerifiedAt
                  ? 'verified'
                  : 'idle';
              const action = repoActions[repo.repoId];

              return (
                <article key={repo.repoId} className="card-surface p-6">
                  <header className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex gap-3">
                      <IconFolder className="mt-0.5 size-4 shrink-0 text-muted" />
                      <div>
                        <h4 className="code-md font-medium text-on-surface">
                          {repo.owner}/{repo.name}
                        </h4>
                        <Badge variant={badgeVariant} className="mt-2">
                          {verifyFailed ? 'Clone Failed' : repo.lastVerifiedAt ? 'Verified' : 'Idle'}
                        </Badge>
                        <p className="mt-2 text-xs text-muted">ID: {repo.repoId}</p>
                      </div>
                    </div>
                  </header>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <p className="label-md text-muted">Branch</p>
                      <p className="mt-1 code-md text-on-surface-variant">{repo.defaultBranch}</p>
                    </div>
                    <div>
                      <p className="label-md text-muted">Last Verify</p>
                      <p className="mt-1 code-md text-on-surface-variant">
                        {repo.lastVerifiedAt || 'never'}
                      </p>
                    </div>
                    <div>
                      <p className="label-md text-muted">Remote Source</p>
                      <p className="mt-1 truncate code-md text-xs text-on-surface-variant">
                        {repo.cloneUrl}
                      </p>
                    </div>
                    <div>
                      <p className="label-md text-muted">Auto-review PRs</p>
                      <Select
                        className="mt-1"
                        value={
                          repo.autoReviewPullRequests === true
                            ? 'on'
                            : repo.autoReviewPullRequests === false
                              ? 'off'
                              : 'inherit'
                        }
                        onChange={(e) =>
                          void updateAutoReview(
                            repo.repoId,
                            e.target.value as 'inherit' | 'on' | 'off',
                          )
                        }
                      >
                        <option value="inherit">Inherit global</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </Select>
                    </div>
                    <div>
                      <p className="label-md text-muted">Autofix severity</p>
                      <Select
                        className="mt-1"
                        value={repo.autofix?.severityThreshold ?? 'disabled'}
                        onChange={(e) =>
                          void updateAutofix(repo.repoId, {
                            severityThreshold: e.target.value as AutofixSeverityThreshold,
                          })
                        }
                      >
                        {(Object.keys(AUTOFIX_THRESHOLD_LABELS) as AutofixSeverityThreshold[]).map(
                          (threshold) => (
                            <option key={threshold} value={threshold}>
                              {AUTOFIX_THRESHOLD_LABELS[threshold]}
                            </option>
                          ),
                        )}
                      </Select>
                    </div>
                    <div>
                      <p className="label-md text-muted">Max findings per autofix batch</p>
                      <Select
                        className="mt-1"
                        value={String(repo.autofix?.maxFindingsPerBatch ?? 5)}
                        onChange={(e) =>
                          void updateAutofix(repo.repoId, {
                            maxFindingsPerBatch: Number(e.target.value),
                          })
                        }
                      >
                        {AUTOFIX_BATCH_SIZE_OPTIONS.map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>

                  {verifyFailed && repo.lastVerifyMessage ? (
                    <div className="mt-4 rounded border border-error/30 bg-error-container p-3">
                      <p className="label-md text-error">Error Message</p>
                      <p className="mt-1 text-sm text-on-error-container">{repo.lastVerifyMessage}</p>
                    </div>
                  ) : null}

                  {action ? (
                    <StatusMessage message={action.message} variant={action.variant} className="mt-4" mono />
                  ) : null}

                  <footer className="mt-4 flex flex-wrap gap-2 border-t border-surface-low pt-4">
                    <Button variant="ghost" onClick={() => verifyRepo(repo.repoId)}>
                      Verify clone
                    </Button>
                    <Button variant="ghost" onClick={() => deleteRepo(repo.repoId)}>
                      Remove
                    </Button>
                  </footer>
                </article>
              );
            })}
          </div>
        </div>
      </div>

      <section className="card-surface mt-6 p-6">
        <header className="mb-4 flex items-center gap-2">
          <IconInfo className="size-4 text-muted" />
          <h3 className="label-md text-muted">Usage Guidelines</h3>
        </header>
        <ul className="grid gap-2 text-sm leading-relaxed text-on-surface-variant md:grid-cols-2">
          <li>Register repos before starting agent sessions.</li>
          <li>Verify clone access to confirm GitHub App credentials.</li>
          <li>Use owner/name format matching your GitHub repository.</li>
          <li>Default branch is used when agents don&apos;t specify one.</li>
        </ul>
      </section>
    </div>
  );
}
