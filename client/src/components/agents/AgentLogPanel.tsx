import { useMemo, type RefObject } from 'react';
import { parseAnsi } from '../../lib/ansi';

interface AgentLogPanelProps {
  text: string;
  logRef?: RefObject<HTMLPreElement | null>;
  onScroll?: () => void;
  className?: string;
}

function segmentClassName(segment: ReturnType<typeof parseAnsi>[number]): string | undefined {
  const classes = [
    segment.bold ? 'font-semibold' : '',
    segment.dim ? 'text-muted' : '',
    segment.error ? 'text-error' : '',
  ].filter(Boolean);

  return classes.length > 0 ? classes.join(' ') : undefined;
}

export function AgentLogPanel({ text, logRef, onScroll, className }: AgentLogPanelProps) {
  const segments = useMemo(() => parseAnsi(text), [text]);

  return (
    <pre
      ref={logRef}
      onScroll={onScroll}
      className={`min-w-0 whitespace-pre-wrap break-words ${className ?? ''}`.trim()}
    >
      {segments.map((segment, index) => (
        <span key={index} className={segmentClassName(segment)}>
          {segment.text}
        </span>
      ))}
    </pre>
  );
}
