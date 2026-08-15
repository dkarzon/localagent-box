import { CodedError } from '../types';

export function validationError(message: string): CodedError {
  return new CodedError(message, 'VALIDATION_ERROR');
}

export function validateOwner(owner: unknown): string {
  if (!owner || typeof owner !== 'string') {
    throw validationError('Owner is required and must be a string');
  }

  const sanitized = owner.trim();
  const validPattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

  if (!validPattern.test(sanitized) || sanitized.length > 100) {
    throw validationError('Owner contains invalid characters');
  }

  return sanitized;
}

export function validateRepoName(repoName: unknown): string {
  if (!repoName || typeof repoName !== 'string') {
    throw validationError('Repository name is required and must be a string');
  }

  const sanitized = repoName.trim();
  const validPattern = /^[a-zA-Z0-9._-]+$/;

  if (!validPattern.test(sanitized)) {
    throw validationError('Repository name contains invalid characters');
  }

  if (sanitized.includes('..') || sanitized.startsWith('.')) {
    throw validationError('Invalid repository name format');
  }

  if (sanitized.length > 100) {
    throw validationError('Repository name too long');
  }

  return sanitized;
}

export function validateBranchName(branchName: unknown, sessionId?: string): string {
  if (typeof branchName !== 'string') {
    if (!sessionId) {
      throw validationError('Branch name is required and must be a string');
    }
    return validateBranchName(`localagent-${sessionId}`);
  }

  const sanitized = branchName.trim();
  if (!sanitized) {
    if (!sessionId) {
      throw validationError('Branch name is required and must be a string');
    }
    return validateBranchName(`localagent-${sessionId}`);
  }
  const invalidChars = /[;&|`$(){}\[\]<>~^:?*\\\s]/;

  if (invalidChars.test(sanitized)) {
    throw validationError('Branch name contains invalid characters');
  }

  if (sanitized.startsWith('-') || sanitized.endsWith('.') || sanitized.includes('..')) {
    throw validationError('Invalid branch name format');
  }

  if (sanitized.length > 250) {
    throw validationError('Branch name too long');
  }

  return sanitized;
}

export function validateRepositoryUrl(repoUrl: unknown): string {
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw validationError('Repository URL is required and must be a string');
  }

  const sanitized = repoUrl.trim();
  const dangerousChars = /[;&|`$(){}[\]<>]/;

  if (dangerousChars.test(sanitized)) {
    throw validationError('Repository URL contains invalid characters');
  }

  try {
    const parsedUrl = new URL(sanitized);

    if (parsedUrl.protocol !== 'https:') {
      throw validationError('Only HTTPS GitHub URLs are allowed');
    }

    if (parsedUrl.hostname !== 'github.com') {
      throw validationError('Only github.com repositories are allowed');
    }

    return sanitized;
  } catch (err) {
    if (err instanceof CodedError) {
      throw err;
    }
    throw validationError('Invalid repository URL format');
  }
}

export function validatePrompt(prompt: unknown): string {
  if (!prompt || typeof prompt !== 'string') {
    throw validationError('Prompt is required and must be a string');
  }

  const sanitized = prompt.trim();
  if (!sanitized) {
    throw validationError('Prompt cannot be empty');
  }

  if (sanitized.length > 50000) {
    throw validationError('Prompt is too long');
  }

  return sanitized;
}

export type AgentMode = 'batch' | 'interactive' | 'loop' | 'review';

export function validateAgentMode(mode: unknown): AgentMode {
  if (mode == null || mode === '') {
    return 'batch';
  }

  if (
    mode === 'batch' ||
    mode === 'interactive' ||
    mode === 'loop' ||
    mode === 'review'
  ) {
    return mode;
  }

  throw validationError('mode must be "batch", "interactive", "loop", or "review"');
}

export function validateMessageText(text: unknown): string {
  if (!text || typeof text !== 'string') {
    throw validationError('text is required and must be a string');
  }

  const sanitized = text.trim();
  if (!sanitized) {
    throw validationError('text cannot be empty');
  }

  if (sanitized.length > 50000) {
    throw validationError('text is too long');
  }

  return sanitized;
}

export function validateModel(model: unknown): string | null {
  if (model == null || model === '') {
    return null;
  }

  if (typeof model !== 'string') {
    throw validationError('Model must be a string');
  }

  const sanitized = model.trim();
  if (!sanitized) {
    throw validationError('Model cannot be empty');
  }

  if (sanitized.length > 200) {
    throw validationError('Model name is too long');
  }

  return sanitized;
}

export function validateSystemPrompt(systemPrompt: unknown): string | undefined {
  if (systemPrompt == null || systemPrompt === '') {
    return undefined;
  }

  if (typeof systemPrompt !== 'string') {
    throw validationError('System prompt must be a string');
  }

  const sanitized = systemPrompt.trim();
  if (!sanitized) {
    throw validationError('System prompt cannot be empty');
  }

  if (sanitized.length > 50000) {
    throw validationError('System prompt is too long');
  }

  return sanitized;
}

export function validateOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw validationError(`${fieldName} must be a boolean`);
  }
  return value;
}

export function buildRepoId(owner: unknown, name: unknown): string {
  return `${validateOwner(owner)}-${validateRepoName(name)}`;
}
