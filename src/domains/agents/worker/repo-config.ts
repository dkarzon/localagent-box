import fs from 'fs';
import path from 'path';
import type {
  RepoPromptOverrides,
  RepoReviewConfig,
  RepoReviewEffort,
  RepoReviewRiskArea,
  RepoReviewRiskLevel,
} from '../../../types';

export const REPO_CONFIG_RELATIVE_PATH = '.localagent-box/config.json';

const repoConfigRelative = path.join('.localagent-box', 'config.json');

const RISK_LEVELS: readonly RepoReviewRiskLevel[] = ['critical', 'high', 'medium', 'low'];
const EFFORT_LEVELS: readonly RepoReviewEffort[] = ['low', 'medium', 'high'];
const MAX_RISK_AREAS = 50;

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateGlobList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isNonEmptyString)) {
    throw new Error(`.localagent-box/config.json ${field} must be a non-empty array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function validateRiskArea(raw: unknown, index: number): RepoReviewRiskArea {
  const field = `review.riskAreas[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`.localagent-box/config.json ${field} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.description)) {
    throw new Error(`.localagent-box/config.json ${field}.description must be a non-empty string`);
  }
  const area: RepoReviewRiskArea = { description: obj.description.trim() };
  if (obj.paths !== undefined) {
    area.paths = validateGlobList(obj.paths, `${field}.paths`);
  }
  if (obj.risk !== undefined) {
    if (!RISK_LEVELS.includes(obj.risk as RepoReviewRiskLevel)) {
      throw new Error(`.localagent-box/config.json ${field}.risk must be one of ${RISK_LEVELS.join(', ')}`);
    }
    area.risk = obj.risk as RepoReviewRiskLevel;
  }
  return area;
}

function validateReviewConfig(raw: unknown): RepoReviewConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('.localagent-box/config.json review must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const review: RepoReviewConfig = {};

  if (obj.background !== undefined) {
    if (!isNonEmptyString(obj.background)) {
      throw new Error('.localagent-box/config.json review.background must be a non-empty string when provided');
    }
    review.background = obj.background;
  }

  if (obj.riskAreas !== undefined) {
    if (!Array.isArray(obj.riskAreas) || obj.riskAreas.length === 0) {
      throw new Error('.localagent-box/config.json review.riskAreas must be a non-empty array');
    }
    if (obj.riskAreas.length > MAX_RISK_AREAS) {
      throw new Error(`.localagent-box/config.json review.riskAreas may list at most ${MAX_RISK_AREAS} entries`);
    }
    review.riskAreas = obj.riskAreas.map(validateRiskArea);
  }

  if (obj.exclude !== undefined) {
    const exclude = validateGlobList(obj.exclude, 'review.exclude');
    // OCR takes --exclude as one comma-separated list, so a comma would split a glob.
    if (exclude.some((pattern) => pattern.includes(','))) {
      throw new Error('.localagent-box/config.json review.exclude patterns must not contain commas');
    }
    review.exclude = exclude;
  }

  if (obj.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(obj.effort as RepoReviewEffort)) {
      throw new Error(`.localagent-box/config.json review.effort must be one of ${EFFORT_LEVELS.join(', ')}`);
    }
    review.effort = obj.effort as RepoReviewEffort;
  }

  if (obj.replaceDefaultRules !== undefined) {
    if (typeof obj.replaceDefaultRules !== 'boolean') {
      throw new Error('.localagent-box/config.json review.replaceDefaultRules must be a boolean');
    }
    review.replaceDefaultRules = obj.replaceDefaultRules;
  }

  return review;
}

export function validateRepoConfig(raw: unknown): RepoPromptOverrides {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('.localagent-box/config.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const overrides: RepoPromptOverrides = {};

  const allowedKeys = ['systemPrompt', 'batchContextPrompt', 'reviewBackground'] as const;

  for (const key of allowedKeys) {
    if (obj[key] !== undefined) {
      const value = obj[key];
      if (!isNonEmptyString(value)) {
        throw new Error(`.localagent-box/config.json ${key} must be a non-empty string when provided`);
      }
      overrides[key] = value;
    }
  }

  if (obj.review !== undefined) {
    overrides.review = validateReviewConfig(obj.review);
  }

  if (overrides.reviewBackground) {
    if (overrides.review?.background) {
      throw new Error(
        '.localagent-box/config.json sets both reviewBackground and review.background; keep only review.background',
      );
    }
    overrides.review = { ...overrides.review, background: overrides.reviewBackground };
  }

  return overrides;
}

/** Parses and validates config file text; the error names the file. */
export function parseRepoConfig(raw: string): RepoPromptOverrides {
  try {
    return validateRepoConfig(JSON.parse(raw) as unknown);
  } catch (err) {
    throw new Error(`Failed to load ${repoConfigRelative}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
