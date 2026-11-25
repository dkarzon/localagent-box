import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { apiFetch } from '../api/client';
import type { AgentEvent } from '../api/agent-events';
import { fetchAgentMessages } from '../api/agent-session';
import { isAgentActive, type Agent, type StatusVariant } from '../api/types';
import { buildTranscriptFromHistory, messagesToEntries, transcriptReducer } from '../lib/transcript';
import { useAgentEvents } from './useAgentEvents';

interface UseAgentSessionOptions {
  agentId: string;
}

export function useAgentSession({ agentId }: UseAgentSessionOptions) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [statusVariant, setStatusVariant] = useState<StatusVariant>('');
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, []);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [initialEventSince, setInitialEventSince] = useState(0);
  /** Bumped on every loadMessages so SSE since cursor resyncs even when lastEventSeq is unchanged. */
  const [eventCursorRevision, setEventCursorRevision] = useState(0);
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
      const entries = buildTranscriptFromHistory(messages, loadedEventsRef.current);
      setInitialEventSince(lastEventSeq);
      setEventCursorRevision((revision) => revision + 1);
      setMessagesLoaded(true);
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
    loadedEventsRef.current = [];
    prevActiveRef.current = null;
  }, [agentId]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  useEffect(() => {
    if (agent && agent.agentId === agentId && !messagesLoaded) {
      loadMessages();
    }
  }, [agent, agentId, loadMessages, messagesLoaded]);

  const handleEvent = useCallback((event: AgentEvent) => {
    dispatchTranscript({ type: 'event', event });
  }, []);

  const active = agent ? isAgentActive(agent) : false;

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
    active,
  };
}

// Re-export for tests or pages that need message-only entries
export { messagesToEntries };
