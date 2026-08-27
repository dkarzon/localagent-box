import fs from 'fs';
import path from 'path';
import type {
  AgentMode,
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

  if (obj.profiles !== undefined) {
    config.profiles = validateProfiles(obj.profiles);
  }

  if (obj.autoDetect !== undefined) {
    if (typeof obj.autoDetect !== 'boolean') {
      throw new Error(`${environmentConfigRelative} autoDetect must be a boolean when provided`);
    }
    config.autoDetect = obj.autoDetect;
  }

  if (obj.cacheKey !== undefined) {
    const cacheKey = obj.cacheKey;
    if (typeof cacheKey !== 'string' || cacheKey.trim() === '') {
      throw new Error(`${environmentConfigRelative} cacheKey must be a non-empty string when provided`);
    }
    config.cacheKey = cacheKey;
  }

  if (obj.verifyCommand !== undefined) {
    if (typeof obj.verifyCommand !== 'string' || obj.verifyCommand.trim() === '') {
      throw new Error(
        `${environmentConfigRelative} verifyCommand must be a non-empty string when provided`,
      );
    }
    config.verifyCommand = obj.verifyCommand;
  }

  if (obj.verifyTimeoutMs !== undefined) {
    const verifyTimeoutMs = obj.verifyTimeoutMs;
    if (
      typeof verifyTimeoutMs !== 'number' ||
      !Number.isInteger(verifyTimeoutMs) ||
      verifyTimeoutMs <= 0 ||
      verifyTimeoutMs > MAX_SETUP_TIMEOUT_MS
    ) {
      throw new Error(
        `${environmentConfigRelative} verifyTimeoutMs must be a positive integer no greater than ${MAX_SETUP_TIMEOUT_MS} when provided`,
      );
    }
    config.verifyTimeoutMs = verifyTimeoutMs;
  }

  return config;
}

function validateProfiles(raw: unknown): string[] {
  const location = `${environmentConfigRelative} profiles`;
  if (!Array.isArray(raw)) {
    throw new Error(`${location} must be an array of strings when provided`);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${location}[${index}] must be a non-empty string`);
    }
    return entry;
  });
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

  if (setup.runOnModes !== undefined) {
    setupConfig.runOnModes = validateRunOnModes(setup.runOnModes);
  }

  return setupConfig;
}

const VALID_MODES: readonly AgentMode[] = ['batch', 'interactive', 'loop', 'review'];

function assertValidMode(value: unknown, index: number): asserts value is AgentMode {
  if (!VALID_MODES.includes(value as AgentMode)) {
    throw new Error(
      `${environmentConfigRelative} setup runOnModes[${index}] must be one of ${VALID_MODES.join(', ')}`,
    );
  }
}

function validateRunOnModes(raw: unknown): AgentMode[] {
  const location = `${environmentConfigRelative} setup runOnModes`;
  if (!Array.isArray(raw)) {
    throw new Error(`${location} must be an array of agent modes when provided`);
  }
  return raw.map((entry, index) => {
    assertValidMode(entry, index);
    return entry as AgentMode;
  });
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
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new Error(
      `Failed to load ${environmentConfigRelative}: ${cause.message}`,
      { cause },
    );
  }
}
