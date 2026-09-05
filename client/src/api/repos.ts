import { apiFetch, authHeaders } from './client';
import type { Repo, RepoAutofixSettings } from './types';

export interface RepoSettingsUpdates {
  autoReviewPullRequests?: boolean | null;
  autofix?: Partial<RepoAutofixSettings>;
}

export async function updateRepoSettings(
  repoId: string,
  updates: RepoSettingsUpdates,
  token: string,
): Promise<Repo> {
  const data = await apiFetch<{ repo: Repo }>(`/api/v1/repos/${encodeURIComponent(repoId)}`, {
    method: 'PUT',
    headers: authHeaders(token, true),
    body: JSON.stringify(updates),
  });
  return data.repo;
}
