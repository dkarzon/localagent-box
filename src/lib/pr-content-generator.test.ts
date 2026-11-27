import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent, AgentVerification } from '../types';
import {
  buildDefaultPullRequestBody,
  buildPullRequestBodyWithHostTestPlan,
  buildPullRequestMetadataSection,
} from './agent-pull-request';
import {
  buildPullRequestGenerationPrompt,
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

  it('strips ollama-cloud/ prefix from model ids', () => {
    assert.equal(
      resolvePullRequestModel(baseAgent({ model: 'ollama-cloud/gemma4:31b' }), config),
      'gemma4:31b',
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

describe('buildPullRequestGenerationPrompt', () => {
  it('asks for a summary and never for a test plan', () => {
    const prompt = buildPullRequestGenerationPrompt({
      agent: baseAgent(),
      base: 'main',
      repoOwner: 'acme',
      repoName: 'demo',
      messages: [{ ts: '2026-06-09T00:00:00.000Z', role: 'user', text: 'Add retry logic' }],
      diffStat: null,
      diffPatch: null,
      logExcerpt: null,
    });

    assert.match(prompt, /Include a ## Summary section/);
    assert.match(prompt, /Never include a test plan/);
    assert.doesNotMatch(prompt, /Include ## Summary and ## Test plan/);
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

describe('buildPullRequestBodyWithHostTestPlan', () => {
  const verification: AgentVerification = {
    state: 'passed',
    configSource: 'base',
    maxRepairAttempts: 2,
    attempts: [
      {
        attempt: 0,
        startedAt: '2026-06-09T00:04:00.000Z',
        finishedAt: '2026-06-09T00:04:30.000Z',
        checks: [
          {
            name: 'test',
            command: 'npm test',
            exitCode: 1,
            signal: null,
            timedOut: false,
            durationMs: 30_000,
            outputTail: '1 test failed',
          },
        ],
        passed: false,
        failureKind: 'code',
      },
      {
        attempt: 1,
        startedAt: '2026-06-09T00:05:00.000Z',
        finishedAt: '2026-06-09T00:05:30.000Z',
        checks: [
          {
            name: 'test',
            command: 'npm test',
            exitCode: 0,
            signal: null,
            timedOut: false,
            durationMs: 29_000,
            outputTail: 'all tests passed',
          },
        ],
        passed: true,
      },
    ],
  };

  const sources: Array<{ name: string; body: string; hasFooter: boolean }> = [
    {
      name: 'llm',
      body: enrichGeneratedPullRequestBody(
        '## Summary\n\n- Added retries.\n\n## Test plan\n\n- [ ] Run the webhook tests',
        baseAgent(),
        'main',
      ),
      hasFooter: true,
    },
    {
      name: 'assistant summary',
      body: enrichGeneratedPullRequestBody(
        'Implemented retries.\n\n## Test plan\n\n- [ ] Manual check',
        baseAgent(),
        'main',
      ),
      hasFooter: true,
    },
    { name: 'default', body: buildDefaultPullRequestBody(baseAgent(), 'main'), hasFooter: true },
    { name: 'explicit override', body: 'Manual notes for the reviewer.', hasFooter: false },
  ];

  for (const source of sources) {
    it(`writes the host test plan into the ${source} body and drops the model one`, () => {
      const body = buildPullRequestBodyWithHostTestPlan(baseAgent({ verification }), source.body);

      assert.match(body, /^## Test plan$/m);
      assert.match(body, /\| Check \| Command \| Result \| Attempts \|/);
      assert.match(body, /\| test \| `npm test` \| ✅ passed \| 2 \|/);
      assert.match(body, /Repair attempts: 1 of 2/);
      assert.doesNotMatch(body, /- \[ \]/);

      if (source.hasFooter) {
        assert.ok(
          body.indexOf('## Test plan') < body.indexOf('Local Agent Box session'),
          'the host section goes before the metadata block',
        );
      }
    });
  }
});

describe('truncateText', () => {
  it('truncates long strings', () => {
    const truncated = truncateText('abcdefghij', 5);
    assert.equal(truncated, 'abcde\n\n[truncated]');
  });
});