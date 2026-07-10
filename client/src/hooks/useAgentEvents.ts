import { useCallback, useEffect, useRef, useState } from 'react';
import { buildEventsUrl } from '../api/agent-session';
import type { AgentEvent } from '../api/agent-events';

interface UseAgentEventsOptions {
  agentId: string;
  enabled: boolean;
  initialSince?: number;
  /** Incremented when the transcript is rebuilt from persisted events (e.g. polling fallback). */
  cursorRevision?: number;
  onEvent?: (event: AgentEvent) => void;
}

export function useAgentEvents({
  agentId,
  enabled,
  initialSince,
  cursorRevision,
  onEvent,
}: UseAgentEventsOptions) {
  const sinceRef = useRef(0);
  const appliedCursorRevisionRef = useRef<number | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  const [connected, setConnected] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);

  useEffect(() => {
    sinceRef.current = 0;
    appliedCursorRevisionRef.current = undefined;
    setLastSeq(0);
  }, [agentId]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const handleEvent = useCallback((event: AgentEvent) => {
    sinceRef.current = event.seq;
    setLastSeq(event.seq);
    onEventRef.current?.(event);
  }, []);

  useEffect(() => {
    if (!enabled || !agentId) {
      setConnected(false);
      return;
    }

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const syncSinceFromSnapshot = () => {
      if (
        cursorRevision !== undefined &&
        cursorRevision !== appliedCursorRevisionRef.current &&
        initialSince !== undefined
      ) {
        appliedCursorRevisionRef.current = cursorRevision;
        sinceRef.current = initialSince;
        return;
      }

      if (initialSince !== undefined && initialSince > sinceRef.current) {
        sinceRef.current = initialSince;
      }
    };

    const connect = () => {
      if (closed) return;

      syncSinceFromSnapshot();

      es?.close();
      es = new EventSource(buildEventsUrl(agentId, sinceRef.current));

      es.onopen = () => {
        setConnected(true);
      };

      es.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as AgentEvent;
          handleEvent(event);
        } catch {
          /* ignore malformed events */
        }
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setConnected(false);
    };
  }, [agentId, enabled, initialSince, cursorRevision, handleEvent]);

  return { connected, lastSeq };
}
