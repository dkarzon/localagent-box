export function authHeaders(token: string, includeJson = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }
  const trimmed = token.trim();
  if (trimmed) {
    headers.Authorization = `Bearer ${trimmed}`;
  }
  return headers;
}

export async function apiFetch<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, options);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T & { error?: string; message?: string }) : ({} as T);
  if (!response.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(err.error || err.message || `Request failed (${response.status})`);
  }
  return body;
}
