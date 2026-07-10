import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { apiFetch } from '../api/client';
import type { AgentEvent, LoopStepEventPayload } from '../api/agent-events';
import { fetchAgentMessages, fetchAgentGitStatus, finishAgent, commitOutstandingChanges, sendAgentMessage } from '../api/agent-session';
import {
  formatLoopProgress,
  isAgentActive,
  isInteractiveAgent,
  isLoopAgent,
  type Agent,
  type LoopVerb,
  type StatusVariant,
} from '../api/types';
import {
  buildTranscriptFromHistory,
  messagesToEntries,
  transcriptReducer,
} from '../lib/transcript';
import { useAgentEvents } from './useAgentEvents';

interface UseAgentSessionOptions {
  agentId: string;
  token: string;
}

function parseLoopStepModel(payload: LoopStepEventPayload): string | null {
  if (payload.model === null || payload.model === undefined) return null;
  return typeof payload.model === 'string' ? payload.model : null;
}

function latestLoopStepModel(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'loop.step.start') continue;
    const payload = event.payload as LoopStepEventPayload;
    if (
      typeof payload.iteration !== 'number' ||
      typeof payload.stepIndex !== 'number' ||
      typeof payload.verb !== 'string'
    ) {
      continue;
    }
    return parseLoopStepModel(payload);
  }
  return null;
}

export function useAgentSession({ agentId, token }: UseAgentSessionOptions) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState<StatusVariant>('');
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, []);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [initialEventSince, setInitialEventSince] = useState(0);
  /** Bumped on every loadMessages so SSE since cursor resyncs even when lastEventSeq is unchanged. */
  const [eventCursorRevision, setEventCursorRevision] = useState(0);
  const [loopStepModel, setLoopStepModel] = useState<string | null>(null);
  const pendingUserMessageRef = useRef<string | null>(null);
  const loadedEventsRef = useRef<AgentEvent[]>([]);
  const loadGenerationRef = useRef(0);
  /** Monotonic id so only the latest in-flight loadMessages applies for a session. */
  const loadMessagesSeqRef = useRef(0);
  const prevActiveRef = useRef<boolean | null>(null);

  const loadAgent = useCallback(async () => {
    const generation = loadGenerationRef.current;
    try {
      const data = await apiFetch<{ agent?: Agent }>(
        `/api/v1/agents/${encodeURIComponent(agentId)}`,
      );
      if (generation !== loadGenerationRef.current) return null;
      if (!data.agent) {
        setLoadError('Session not found');
        setAgent(null);
        return null;
      }
      setAgent(data.agent);
      setLoadError('');
      return data.agent;
    } catch (err) {
      if (generation !== loadGenerationRef.current) return null;
      setLoadError(err instanceof Error ? err.message : 'Failed to load session');
      setAgent(null);
      return null;
    }
  }, [agentId]);

  const loadMessages = useCallback(async () => {
    const generation = loadGenerationRef.current;
    const seq = ++loadMessagesSeqRef.current;
    try {
      const cachedEvents = loadedEventsRef.current;
      const since =
        cachedEvents.length > 0 ? cachedEvents[cachedEvents.length - 1]!.seq : 0;
      const { messages, lastEventSeq, events } = await fetchAgentMessages(agentId, since);
      if (generation !== loadGenerationRef.current || seq !== loadMessagesSeqRef.current) return;
      loadedEventsRef.current = since === 0 ? events : [...cachedEvents, ...events];
      setLoopStepModel(latestLoopStepModel(loadedEventsRef.current));
      let entries = buildTranscriptFromHistory(messages, loadedEventsRef.current);
      setInitialEventSince(lastEventSeq);
      setEventCursorRevision((revision) => revision + 1);
      setMessagesLoaded(true);

      const pending = pendingUserMessageRef.current;
      if (pending) {
        pendingUserMessageRef.current = null;
        entries = [
          ...entries,
          {
            id: `pending-${Date.now()}`,
            role: 'user',
            text: pending,
            ts: new Date().toISOString(),
          },
        ];
      }

      dispatchTranscript({ type: 'reset', entries });
    } catch {
      if (generation !== loadGenerationRef.current || seq !== loadMessagesSeqRef.current) return;
      /* messages may not exist yet for brand-new sessions */
      setMessagesLoaded(true);
    }
  }, [agentId]);

  useEffect(() => {
    loadGenerationRef.current += 1;
    loadMessagesSeqRef.current = 0;
    setAgent(null);
    setLoadError('');
    setStatus('');
    setStatusVariant('');
    setMessagesLoaded(false);
    setInitialEventSince(0);
    setEventCursorRevision(0);
    dispatchTranscript({ type: 'reset', entries: [] });
    pendingUserMessageRef.current = null;
    loadedEventsRef.current = [];
    prevActiveRef.current = null;
    setLoopStepModel(null);
  }, [agentId]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  useEffect(() => {
    if (agent && agent.agentId === agentId && !messagesLoaded) {
      loadMessages();
    }
  }, [agent, agentId, loadMessages, messagesLoaded]);

  const refreshGitStatus = useCallback(async () => {
    const generation = loadGenerationRef.current;
    try {
      const gitStatus = await fetchAgentGitStatus(agentId);
      if (generation !== loadGenerationRef.current) return;
      if (!gitStatus.updatedAt) return;
      setAgent((prev) =>
        prev
          ? {
              ...prev,
              gitStatus: {
                filesChanged: gitStatus.filesChanged,
                files: gitStatus.files,
                updatedAt: gitStatus.updatedAt!,
              },
            }
          : prev,
      );
    } catch {
      /* git status may not be available yet for brand-new sessions */
    }
  }, [agentId]);

  const handleEvent = useCallback((event: AgentEvent) => {
    dispatchTranscript({ type: 'event', event });

    if (event.type === 'loop.step.start' || event.type === 'loop.step.end') {
      const payload = event.payload as LoopStepEventPayload;
      if (
        typeof payload.iteration !== 'number' ||
        typeof payload.stepIndex !== 'number' ||
        typeof payload.verb !== 'string'
      ) {
        return;
      }
      if (event.type === 'loop.step.start') {
        setLoopStepModel(parseLoopStepModel(payload));
      }
      setAgent((prev) => {
        if (!prev?.loop) return prev;
        return {
          ...prev,
          loop: {
            ...prev.loop,
            iteration: payload.iteration,
            stepIndex: payload.stepIndex,
            currentVerb: payload.verb as LoopVerb,
          },
        };
      });
    }

    if (event.type === 'loop.step.end') {
      void refreshGitStatus();
      return;
    }

    if (event.type === 'session.status') {
      const nextStatus = event.payload.status;
      if (typeof nextStatus === 'string' && nextStatus === 'awaiting_input') {
        void refreshGitStatus();
      }
    }
  }, [refreshGitStatus]);

  const interactive = agent ? isInteractiveAgent(agent) : false;
  const loop = agent ? isLoopAgent(agent) : false;
  const active = agent ? isAgentActive(agent) : false;
  const canFinish = Boolean(agent?.interactive?.canFinish || agent?.loop?.canFinish);
  const canCommitOutstanding = Boolean(agent?.loop?.canCommitOutstanding);
  const loopProgress =
    agent?.loop && loop ? formatLoopProgress(agent.loop, loopStepModel) : null;

  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (prev === true && !active && agent?.agentId === agentId) {
      void loadMessages();
    }
  }, [active, agent, agentId, loadMessages]);

  const { connected: eventsConnected } = useAgentEvents({
    agentId,
    enabled: messagesLoaded && active,
    initialSince: initialEventSince,
    cursorRevision: eventCursorRevision,
    onEvent: handleEvent,
  });

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setStatus('');
    pendingUserMessageRef.current = trimmed;
    dispatchTranscript({
      type: 'append_user',
      text: trimmed,
      ts: new Date().toISOString(),
    });

    try {
      const updated = await sendAgentMessage(agentId, trimmed, token);
      setAgent(updated);
      pendingUserMessageRef.current = null;
    } catch (err) {
      pendingUserMessageRef.current = null;
      setStatus(err instanceof Error ? err.message : 'Failed to send message');
      setStatusVariant('error');
      await loadMessages();
    }
  };

  const finish = async () => {
    setStatus('Finishing session — committing changes…');
    setStatusVariant('');
    try {
      const updated = await finishAgent(agentId, token);
      setAgent(updated);
      setStatus('Finish requested. Waiting for git finalize…');
      setStatusVariant('success');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to finish session');
      setStatusVariant('error');
    }
  };

  const commitOutstanding = async () => {
    setStatus('Committing outstanding changes…');
    setStatusVariant('');
    try {
      const updated = await commitOutstandingChanges(agentId, token);
      setAgent(updated);
      setStatus(
        updated.pushed
          ? 'Changes committed and pushed.'
          : 'Changes committed locally (push was disabled for this session).',
      );
      setStatusVariant('success');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to commit outstanding changes');
      setStatusVariant('error');
    }
  };

  return {
    agent,
    loadError,
    status,
    statusVariant,
    setStatus,
    setStatusVariant,
    transcript,
    messagesLoaded,
    eventsConnected,
    loadAgent,
    loadMessages,
    sendMessage,
    finish,
    commitOutstanding,
    interactive,
    loop,
    active,
    canFinish,
    canCommitOutstanding,
    loopProgress,
  };
}

// Re-export for tests or pages that need message-only entries
export { messagesToEntries };
