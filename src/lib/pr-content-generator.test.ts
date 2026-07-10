import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '../types';
import { buildDefaultPullRequestBody, buildPullRequestMetadataSection } from './agent-pull-request';
import {
  enrichGeneratedPullRequestBody,
  extractAssistantSummary,
  parsePullRequestGenerationResponse,
  resolvePullRequestModel,
  truncateText,
} from './pr-content-generator';

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: 'agent-12345678',
    workspaceId: 'ws-1',
    repoId: 'acme-demo',
    prompt: 'Add retry logic to the webhook sender',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'localagent/retry-webhook',
    commitMessage: 'Add exponential backoff to webhook delivery',
    push: true,
    pushOnFailure: false,
    model: 'qwen2.5-coder:7b',
    status: 'completed',
    commitSha: 'deadbeef1234567890abcdef1234567890abcdef',
    pushed: true,
    filesChanged: 2,
    createdAt: '2026-06-09T00:00:00.000Z',
    startedAt: '2026-06-09T00:00:01.000Z',
    finishedAt: '2026-06-09T00:05:00.000Z',
    branch: 'localagent/retry-webhook',
    error: null,
    result: null,
    pullRequest: null,
    ...overrides,
  };
}

describe('resolvePullRequestModel', () => {
  const config = { opencodeModel: 'llama3.2' } as import('../types').AppConfig;

  it('prefers agent.model over global opencodeModel', () => {
    assert.equal(
      resolvePullRequestModel(baseAgent({ model: 'qwen2.5-coder:7b' }), config),
      'qwen2.5-coder:7b',
    );
  });

  it('strips ollama/ prefix from model ids', () => {
    assert.equal(
      resolvePullRequestModel(baseAgent({ model: 'ollama/mistral:7b' }), config),
      'mistral:7b',
    );
  });

  it('uses the last modelsUsed entry when agent.model is absent', () => {
    assert.equal(
      resolvePullRequestModel(baseAgent({ model: null, modelsUsed: ['gemma:2b', 'coder:7b'] }), config),
      'coder:7b',
    );
  });

  it('falls back to opencodeModel', () => {
    assert.equal(resolvePullRequestModel(baseAgent({ model: null }), config), 'llama3.2');
  });
});

describe('parsePullRequestGenerationResponse', () => {
  it('parses JSON title and body', () => {
    const parsed = parsePullRequestGenerationResponse(
      '{"title":"Add webhook retry backoff","body":"## Summary\\n- Added retries\\n\\n## Test plan\\n- [ ] Unit tests"}',
    );

    assert.deepEqual(parsed, {
      title: 'Add webhook retry backoff',
      body: '## Summary\n- Added retries\n\n## Test plan\n- [ ] Unit tests',
    });
  });

  it('extracts JSON from fenced or surrounding text', () => {
    const parsed = parsePullRequestGenerationResponse(
      'Here is the PR:\n```json\n{"title":"Fix auth timeout","body":"## Summary\\nFixes timeout\\n\\n## Test plan\\n- [ ] Login"}\n```',
    );

    assert.equal(parsed?.title, 'Fix auth timeout');
    assert.match(parsed?.body || '', /Fixes timeout/);
  });

  it('returns null for invalid payloads', () => {
    assert.equal(parsePullRequestGenerationResponse('not json'), null);
    assert.equal(parsePullRequestGenerationResponse('{"title":"","body":"x"}'), null);
  });
});

describe('buildPullRequestMetadataSection', () => {
  it('shows single model when only model field is set', () => {
    const meta = buildPullRequestMetadataSection(baseAgent());
    assert.match(meta, /\*\*Model:\*\* `qwen2\.5-coder:7b`/);
  });

  it('shows multi-model line when modelsUsed has multiple entries', () => {
    const meta = buildPullRequestMetadataSection(
      baseAgent({ modelsUsed: ['gemma:2b', 'mistral:7b'] }),
    );
    assert.match(meta, /\*\*Models:\*\* `gemma:2b`, `mistral:7b`/);
  });

  it('shows multi-model line for single-entry modelsUsed', () => {
    const meta = buildPullRequestMetadataSection(
      baseAgent({ modelsUsed: ['qwen2.5-coder:7b'] }),
    );
    assert.match(meta, /\*\*Models:\*\* `qwen2\.5-coder:7b`/);
  });

  it('falls back to model field when modelsUsed is empty array', () => {
    const meta = buildPullRequestMetadataSection(baseAgent({ modelsUsed: [] }));
    assert.match(meta, /\*\*Model:\*\* `qwen2\.5-coder:7b`/);
  });

  it('omits model lines when both are absent', () => {
    const meta = buildPullRequestMetadataSection(baseAgent({ model: null, modelsUsed: [] }));
    assert.doesNotMatch(meta, /\*\*Model/);
  });
});

describe('extractAssistantSummary', () => {
  it('returns the latest assistant message', () => {
    const summary = extractAssistantSummary([
      { ts: '1', role: 'user', text: 'Do the thing' },
      { ts: '2', role: 'assistant', text: 'First reply' },
      { ts: '3', role: 'assistant', text: 'Final summary of changes' },
    ]);

    assert.equal(summary, 'Final summary of changes');
  });
});

describe('enrichGeneratedPullRequestBody', () => {
  it('appends session metadata footer', () => {
    const body = enrichGeneratedPullRequestBody(
      '## Summary\n- Changed webhook retries\n\n## Test plan\n- [ ] Run tests',
      baseAgent(),
      'main',
    );

    assert.match(body, /## Summary/);
    assert.match(body, /Local Agent Box session/);
  });
});

describe('buildDefaultPullRequestBody', () => {
  it('still includes prompt and metadata', () => {
    const body = buildDefaultPullRequestBody(baseAgent(), 'main');
    assert.match(body, /## Prompt/);
    assert.match(body, /Local Agent Box session/);
  });
});

describe('truncateText', () => {
  it('truncates long strings', () => {
    const truncated = truncateText('abcdefghij', 5);
    assert.equal(truncated, 'abcde\n\n[truncated]');
  });
});