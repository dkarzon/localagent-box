import fs from 'fs';
import path from 'path';
import type { RepoPromptOverrides } from '../../../types';

const repoConfigRelative = path.join('.localagent-box', 'config.json');

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

export function validateRepoConfig(raw: unknown): RepoPromptOverrides {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('.localagent-box/config.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const overrides: RepoPromptOverrides = {};

  const allowedKeys = ['systemPrompt', 'batchContextPrompt', 'interactiveContextPrompt', 'loopContextPrompt'];

  for (const key of allowedKeys) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] !== 'string' || !obj[key].trim()) {
        throw new Error(`.localagent-box/config.json ${key} must be a non-empty string when provided`);
      }
      overrides[key as keyof RepoPromptOverrides] = obj[key];
    }
  }

  return overrides;
}

export function loadRepoConfig(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): RepoPromptOverrides | null {
  const repoPath = path.join(workspaceDir, repoConfigRelative);
  if (!fsImpl.existsSync(repoPath)) {
    return null;
  }
  try {
    return validateRepoConfig(readJsonFile(repoPath));
  } catch (err) {
    throw new Error(`Failed to load ${repoConfigRelative}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
