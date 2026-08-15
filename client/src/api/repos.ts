import { apiFetch, authHeaders } from './client';
import type { Repo } from './types';

export async function updateRepoSettings(
  repoId: string,
  updates: { autoReviewPullRequests?: boolean | null },
  token: string,
): Promise<Repo> {
  const data = await apiFetch<{ repo: Repo }>(`/api/v1/repos/${encodeURIComponent(repoId)}`, {
    method: 'PUT',
    headers: authHeaders(token, true),
    body: JSON.stringify(updates),
  });
  return data.repo;
}
