import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentQueue } from './agent-queue';
import type { QueueDecision } from './queue-eligibility';

describe('createAgentQueue', () => {
  it('starts the first eligible agent and leaves deferred agents in the queue', () => {
    const started: string[] = [];
    const decisions: Record<string, QueueDecision> = {
      blocked: 'defer',
      ready: 'start',
    };
    let active = 0;

    const queue = createAgentQueue({
      maxConcurrent: 1,
      getActiveWorkerCount: () => active,
      decide: (id) => decisions[id] ?? 'drop',
      onStartAgent: (id) => {
        started.push(id);
        active += 1;
      },
    });

    queue.enqueue('blocked');
    queue.enqueue('ready');

    assert.deepEqual(started, ['ready']);
    assert.equal(queue.length, 1);

    active = 0;
    decisions.blocked = 'start';
    queue.process();

    assert.deepEqual(started, ['ready', 'blocked']);
    assert.equal(queue.length, 0);
  });

  it('starts a later eligible agent when the head is blocked (does not starve other branches)', () => {
    const started: string[] = [];
    let active = 1;

    const queue = createAgentQueue({
      maxConcurrent: 2,
      getActiveWorkerCount: () => active,
      decide: (id) => (id === 'branch-x-2' ? 'defer' : 'start'),
      onStartAgent: (id) => {
        started.push(id);
        active += 1;
      },
    });

    queue.enqueue('branch-x-2');
    queue.enqueue('branch-y-1');

    assert.deepEqual(started, ['branch-y-1']);
    assert.equal(queue.length, 1);
  });

  it('drops vanished or terminal ids without starting them', () => {
    const started: string[] = [];
    const queue = createAgentQueue({
      maxConcurrent: 3,
      getActiveWorkerCount: () => 0,
      decide: (id) => (id === 'gone' ? 'drop' : 'start'),
      onStartAgent: (id) => started.push(id),
    });

    queue.enqueue('gone');
    queue.enqueue('keep');

    assert.deepEqual(started, ['keep']);
    assert.equal(queue.length, 0);
  });

  it('does not start more workers than maxConcurrent', () => {
    const started: string[] = [];
    let active = 0;
    const queue = createAgentQueue({
      maxConcurrent: 1,
      getActiveWorkerCount: () => active,
      decide: () => 'start',
      onStartAgent: (id) => {
        started.push(id);
        active += 1;
      },
    });

    queue.enqueue('a');
    queue.enqueue('b');

    assert.deepEqual(started, ['a']);
    assert.equal(queue.length, 1);
  });
});
