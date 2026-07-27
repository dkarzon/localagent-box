import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent } from '../types';
import {
  enrichMessagesWithAssistantFromEvents,
  extractAssistantSummaryFromEvents,
  extractAssistantTextFromPayload,
  mergeAssistantText,
} from './assistant-text';

describe('extractAssistantTextFromPayload', () => {
  it('reads text and reasoning parts', () => {
    const text = extractAssistantTextFromPayload({
      info: { role: 'assistant' },
      parts: [
        { type: 'reasoning', text: 'Thinking…' },
        { type: 'text', text: 'Implemented retries.' },
      ],
    });

    assert.equal(text, 'Thinking…\nImplemented retries.');
  });

  it('ignores non-assistant message updates', () => {
    const text = extractAssistantTextFromPayload({
      info: { role: 'user' },
      parts: [{ type: 'text', text: 'Add retry logic' }],
    });

    assert.equal(text, '');
  });
});

describe('mergeAssistantText', () => {
  it('prefers the longer coherent streamed text', () => {
    assert.equal(
      mergeAssistantText('Implemented exponential backoff with jitter.', 'Implemented'),
      'Implemented exponential backoff with jitter.',
    );
  });

  it('collapses exact snapshot duplication from double-emitted deltas', () => {
    const snapshot = 'Implemented exponential backoff with jitter.';
    assert.equal(mergeAssistantText(snapshot + snapshot, snapshot), snapshot);
  });
});

describe('extractAssistantSummaryFromEvents', () => {
  it('returns the latest assistant message from events', () => {
    const events: AgentEvent[] = [
      {
        seq: 1,
        ts: '2026-06-09T00:00:01.000Z',
        type: 'assistant.delta',
        payload: { text: 'First ' },
      },
      {
        seq: 2,
        ts: '2026-06-09T00:00:02.000Z',
        type: 'assistant.message',
        payload: {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'First reply' }],
        },
      },
      {
        seq: 3,
        ts: '2026-06-09T00:05:00.000Z',
        type: 'assistant.message',
        payload: {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'Final summary of changes' }],
        },
      },
    ];

    assert.equal(extractAssistantSummaryFromEvents(events), 'Final summary of changes');
  });
});

describe('enrichMessagesWithAssistantFromEvents', () => {
  it('appends assistant messages when conversation only has user turns', () => {
    const messages = enrichMessagesWithAssistantFromEvents(
      [{ ts: '1', role: 'user', text: 'Add retries' }],
      [
        {
          seq: 1,
          ts: '2',
          type: 'assistant.message',
          payload: {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Added retry logic.' }],
          },
        },
      ],
    );

    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(messages[1]?.text, 'Added retry logic.');
  });

  it('keeps existing assistant messages unchanged', () => {
    const messages = enrichMessagesWithAssistantFromEvents(
      [
        { ts: '1', role: 'user', text: 'Add retries' },
        { ts: '2', role: 'assistant', text: 'Already saved summary' },
      ],
      [
        {
          seq: 1,
          ts: '3',
          type: 'assistant.message',
          payload: {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Event-only summary' }],
          },
        },
      ],
    );

    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.text, 'Already saved summary');
  });

  it('appends missing assistant turns from events when conversation ends on a user message', () => {
    const messages = enrichMessagesWithAssistantFromEvents(
      [
        { ts: '1', role: 'user', text: 'Add retries' },
        { ts: '2', role: 'assistant', text: 'First turn summary' },
        { ts: '3', role: 'user', text: 'Also add tests' },
      ],
      [
        {
          seq: 1,
          ts: '2',
          type: 'assistant.message',
          payload: {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'First turn summary' }],
          },
        },
        {
          seq: 2,
          ts: '4',
          type: 'assistant.message',
          payload: {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Added tests for retry logic.' }],
          },
        },
      ],
    );

    assert.equal(messages.length, 4);
    assert.equal(messages[3]?.role, 'assistant');
    assert.equal(messages[3]?.text, 'Added tests for retry logic.');
  });
});
