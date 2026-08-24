import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../services/config-store';
import { maybePopulateBotGitIdentity } from './github-bot-identity';
import type { AppConfig } from '../types';
import type { GithubAppService } from '../services/github-app';

const appConfig: AppConfig = {
  ...DEFAULT_CONFIG,
  githubAppId: '1',
  githubAppInstallationId: '2',
  githubAppPrivateKey: 'test-key',
};

describe('maybePopulateBotGitIdentity', () => {
  it('returns config unchanged when git author is already set', async () => {
    const config = {
      ...appConfig,
      gitUserName: 'custom[bot]',
      gitUserEmail: '1+custom[bot]@users.noreply.github.com',
    };
    const githubApp = {
      resolveBotGitIdentity: async () => {
        throw new Error('should not be called');
      },
    } as unknown as GithubAppService;

    const result = await maybePopulateBotGitIdentity(config, githubApp);
    assert.equal(result, config);
  });

  it('populates git author when app credentials exist and fields are blank', async () => {
    const githubApp = {
      resolveBotGitIdentity: async () => ({
        gitUserName: 'localagent-box[bot]',
        gitUserEmail: '123+localagent-box[bot]@users.noreply.github.com',
      }),
    } as unknown as GithubAppService;

    const result = await maybePopulateBotGitIdentity(appConfig, githubApp);
    assert.deepEqual(result, {
      ...appConfig,
      gitUserName: 'localagent-box[bot]',
      gitUserEmail: '123+localagent-box[bot]@users.noreply.github.com',
    });
  });

  it('returns original config when resolution fails', async () => {
    const failures: unknown[] = [];
    const githubApp = {
      resolveBotGitIdentity: async () => {
        throw new Error('GitHub API unavailable');
      },
    } as unknown as GithubAppService;

    const result = await maybePopulateBotGitIdentity(appConfig, githubApp, {
      onFailure: (err) => failures.push(err),
    });

    assert.equal(result, appConfig);
    assert.equal(failures.length, 1);
  });
});
