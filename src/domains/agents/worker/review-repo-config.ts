import fs from 'fs';
import path from 'path';
import type { RepoPromptOverrides } from '../../../types';
import { parseRepoConfig, REPO_CONFIG_RELATIVE_PATH } from './repo-config';
import { readFileAtRef, resolveBaseRef } from './git-ref-files';

/** OCR's repository-level rule file, read from the working tree. */
export const OCR_PROJECT_RULE_RELATIVE_PATH = '.opencodereview/rule.json';

export interface ReviewRepoConfigResult {
  overrides: RepoPromptOverrides | null;
  /** Human-readable notes for the worker log. */
  notes: string[];
}

/**
 * Loads review configuration from the base branch, not the head checkout, so
 * a pull request cannot rewrite the instructions it is reviewed under:
 *
 * - `.localagent-box/config.json` is parsed from the base branch.
 * - `.opencodereview/rule.json` in the working tree (which OCR reads) is
 *   replaced with the base branch version, or removed when the base branch
 *   has none.
 *
 * Fails closed: when the base branch cannot be read, no repo config is used
 * and the head's OCR rule file is removed. An invalid config file on the base
 * branch throws, the same as an invalid file for coding agents.
 */
export async function loadReviewRepoConfigFromBase(
  workspaceDir: string,
  baseBranch: string,
): Promise<ReviewRepoConfigResult> {
  const notes: string[] = [];
  const ruleFilePath = path.join(workspaceDir, ...OCR_PROJECT_RULE_RELATIVE_PATH.split('/'));
  const baseRef = await resolveBaseRef(workspaceDir, baseBranch);

  if (!baseRef) {
    if (fs.existsSync(ruleFilePath)) {
      fs.rmSync(ruleFilePath, { force: true });
    }
    notes.push(
      `Warning: base branch ${baseBranch} is not available in the workspace; reviewing without repository review config`,
    );
    return { overrides: null, notes };
  }

  const configText = await readFileAtRef(workspaceDir, baseRef, REPO_CONFIG_RELATIVE_PATH);
  const parsed = configText === null ? null : parseRepoConfig(configText);
  const overrides = parsed?.overrides ?? null;
  if (parsed) {
    notes.push(...parsed.notes);
    if (overrides) {
      notes.push(`Loaded ${REPO_CONFIG_RELATIVE_PATH} from base branch ${baseBranch}`);
    }
  }

  const baseRules = await readFileAtRef(workspaceDir, baseRef, OCR_PROJECT_RULE_RELATIVE_PATH);
  const headRules = fs.existsSync(ruleFilePath) ? fs.readFileSync(ruleFilePath, 'utf8') : null;
  if (baseRules !== null) {
    if (headRules !== baseRules) {
      fs.mkdirSync(path.dirname(ruleFilePath), { recursive: true });
      fs.writeFileSync(ruleFilePath, baseRules, 'utf8');
      notes.push(
        `Using ${OCR_PROJECT_RULE_RELATIVE_PATH} from base branch ${baseBranch}; head branch changes to it are ignored`,
      );
    } else {
      notes.push(`Using ${OCR_PROJECT_RULE_RELATIVE_PATH} from base branch ${baseBranch}`);
    }
  } else if (headRules !== null) {
    fs.rmSync(ruleFilePath, { force: true });
    notes.push(
      `Ignoring ${OCR_PROJECT_RULE_RELATIVE_PATH} from the head branch; base branch ${baseBranch} has none`,
    );
  }

  return { overrides, notes };
}
