import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { childCleanupCountForTests, registerChildCleanup, runChildCleanups } from './child-cleanup';

describe('child-cleanup', () => {
  afterEach(async () => {
    await runChildCleanups(10);
  });

  it('runs registered cleanups once and clears them', async () => {
    let calls = 0;
    registerChildCleanup(() => {
      calls += 1;
    });
    await runChildCleanups();
    await runChildCleanups();
    assert.equal(calls, 1);
    assert.equal(childCleanupCountForTests(), 0);
  });

  it('skips unregistered cleanups and tolerates failures', async () => {
    let ran = false;
    const unregister = registerChildCleanup(() => {
      throw new Error('should not run');
    });
    unregister();
    registerChildCleanup(async () => {
      throw new Error('boom');
    });
    registerChildCleanup(() => {
      ran = true;
    });
    await runChildCleanups();
    assert.equal(ran, true);
  });

  it('does not wait past the timeout for a stuck cleanup', async () => {
    registerChildCleanup(() => new Promise<void>(() => {}));
    const startedAt = Date.now();
    await runChildCleanups(50);
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
