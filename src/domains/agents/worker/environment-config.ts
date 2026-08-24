import fs from 'fs';
import path from 'path';
import type {
  RepoEnvironmentConfig,
  RepoEnvironmentSetupConfig,
} from '../../../types';

export const environmentConfigRelative = path.join(
  '.localagent-box',
  'environment.json',
);

const MAX_SETUP_TIMEOUT_MS = 1_800_000; // 30 min

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

function assertObject(raw: unknown, location: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${location} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

export function validateEnvironmentConfig(raw: unknown): RepoEnvironmentConfig {
  const obj = assertObject(raw, environmentConfigRelative);

  if (obj.version !== 1) {
    throw new Error(`${environmentConfigRelative} version must be exactly 1`);
  }

  const config: RepoEnvironmentConfig = { version: 1 };

  if (obj.setup !== undefined) {
    const setup = validateSetup(obj.setup);
    config.setup = setup;
  }

  return config;
}

function validateSetup(raw: unknown): RepoEnvironmentSetupConfig {
  const location = `${environmentConfigRelative} setup`;
  const setup = assertObject(raw, location);

  if (typeof setup.command !== 'string' || !setup.command.trim()) {
    throw new Error(`${location} command must be a non-empty string when provided`);
  }
  const setupConfig: RepoEnvironmentSetupConfig = { command: setup.command };

  if (setup.timeoutMs !== undefined) {
    const timeoutMs = setup.timeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_SETUP_TIMEOUT_MS
    ) {
      throw new Error(
        `${location} timeoutMs must be a positive integer no greater than ${MAX_SETUP_TIMEOUT_MS} when provided`,
      );
    }
    setupConfig.timeoutMs = timeoutMs;
  }

  if (setup.failOnError !== undefined) {
    if (typeof setup.failOnError !== 'boolean') {
      throw new Error(`${location} failOnError must be a boolean when provided`);
    }
    setupConfig.failOnError = setup.failOnError;
  }

  return setupConfig;
}

export function loadEnvironmentConfig(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): RepoEnvironmentConfig | null {
  const repoPath = path.join(workspaceDir, environmentConfigRelative);
  if (!fsImpl.existsSync(repoPath)) {
    return null;
  }
  try {
    return validateEnvironmentConfig(readJsonFile(repoPath));
  } catch (err) {
    throw new Error(
      `Failed to load ${environmentConfigRelative}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
