import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDockerRunArgs,
  collectForwardedEnv,
  findLoopbackUrls,
  parseDockerSmokeArgs,
  type DockerSmokeArgs,
} from './smoke-docker';

describe('parseDockerSmokeArgs', () => {
  it('separates docker options from forwarded smoke options', () => {
    assert.deepEqual(parseDockerSmokeArgs(['--no-build', '--model', 'qwen3', '--data', 'agent-data', '--server-only']), {
      image: 'localagent-box:smoke',
      build: false,
      data: 'agent-data',
      forwarded: ['--model', 'qwen3', '--server-only'],
    });
  });

  it('supports running in an existing container', () => {
    const parsed = parseDockerSmokeArgs(['--container', 'localagent-box', '--json']) as DockerSmokeArgs;
    assert.equal(parsed.container, 'localagent-box');
    assert.deepEqual(parsed.forwarded, ['--json']);
  });

  it('rejects missing values and --data with --container', () => {
    assert.ok('error' in (parseDockerSmokeArgs(['--image']) as object));
    assert.ok('error' in (parseDockerSmokeArgs(['--container', 'x', '--data', 'v']) as object));
    assert.equal(parseDockerSmokeArgs(['--help']), 'help');
  });
});

describe('collectForwardedEnv', () => {
  it('takes provider keys from the shell first, then .env, and nothing else', () => {
    const env = collectForwardedEnv(
      { OPENCODE_MODEL: 'from-shell', HOME: '/home/me' },
      { OPENCODE_MODEL: 'from-dotenv', OPENAI_COMPATIBLE_API_KEY: 'sk', API_TOKEN: 'secret' },
    );
    assert.deepEqual(env, { OPENCODE_MODEL: 'from-shell', OPENAI_COMPATIBLE_API_KEY: 'sk' });
  });
});

describe('findLoopbackUrls', () => {
  it('flags localhost URLs that would point at the container itself', () => {
    assert.deepEqual(
      findLoopbackUrls({
        OLLAMA_BASE_URL: 'http://localhost:11434',
        OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.5:8080',
        OLLAMA_CLOUD_BASE_URL: 'http://127.0.0.1/v1',
      }),
      ['OLLAMA_BASE_URL', 'OLLAMA_CLOUD_BASE_URL'],
    );
  });
});

describe('buildDockerRunArgs', () => {
  it('passes env by name only so secret values never appear on the command line', () => {
    const args = buildDockerRunArgs(
      { image: 'img:smoke', build: true, data: 'agent-data', forwarded: ['--model', 'm'] },
      ['OPENAI_COMPATIBLE_API_KEY'],
    );
    assert.deepEqual(args.slice(-4), ['img:smoke', '/app/dist/entrypoints/smoke.js', '--model', 'm']);
    assert.ok(args.includes('OPENAI_COMPATIBLE_API_KEY'));
    assert.ok(!args.some((a) => a.includes('=') && a.startsWith('OPENAI_COMPATIBLE_API_KEY')));
    assert.ok(args.includes('agent-data:/data:ro'));
    assert.deepEqual(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2), ['--entrypoint', 'node']);
  });
});
