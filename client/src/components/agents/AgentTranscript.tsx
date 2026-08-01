import { useState } from 'react';
import type { TranscriptEntry } from '../../api/agent-events';
import { MarkdownMessage } from './MarkdownMessage';

interface AgentTranscriptProps {
  entries: TranscriptEntry[];
  emptyMessage?: string;
}

function bubbleClasses(role: TranscriptEntry['role']): string {
  switch (role) {
    case 'user':
      return 'ml-auto max-w-[85%] bg-primary-container text-white';
    case 'assistant':
      return 'mr-auto max-w-[85%] bg-surface-container text-on-surface';
    default:
      return 'bg-surface-container text-on-surface';
  }
}

function roleLabel(role: TranscriptEntry['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    default:
      return role;
  }
}

function ToolDetailBlock({ label, value, error }: { label: string; value: string; error?: boolean }) {
  return (
    <div className="mt-2">
      <p
        className={`text-xs font-medium uppercase tracking-wide ${error ? 'text-error' : 'text-muted'}`}
      >
        {label}
      </p>
      <pre
        className={`mt-1 max-h-48 overflow-auto rounded px-2 py-1.5 text-xs whitespace-pre-wrap break-words ${
          error ? 'bg-error-container/30 text-error' : 'bg-surface-container-low text-on-surface'
        }`}
      >
        {value}
      </pre>
    </div>
  );
}

function toolStatusClass(status: NonNullable<TranscriptEntry['toolCall']>['status']): string {
  switch (status) {
    case 'running':
      return 'text-primary';
    case 'error':
      return 'text-error';
    default:
      return 'text-success';
  }
}

function ToolTranscriptBody({ entry }: { entry: TranscriptEntry }) {
  const tool = entry.toolCall;
  const [expanded, setExpanded] = useState(tool?.status === 'running');

  if (!tool) {
    return <p className="whitespace-pre-wrap break-words">{entry.text}</p>;
  }

  const hasDetails = Boolean(tool.input || tool.output || tool.error);

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left disabled:cursor-default"
          disabled={!hasDetails}
          onClick={() => {
            if (!hasDetails) return;
            setExpanded((value) => !value);
          }}
        >
          <span className="code-md block truncate font-medium text-on-surface">
            {tool.name}
          </span>
          {tool.title ? (
            <span className="mt-0.5 block text-xs text-muted">{tool.title}</span>
          ) : null}
        </button>
        <span className={`shrink-0 text-xs ${toolStatusClass(tool.status)}`}>{tool.status}</span>
      </div>
      {expanded && hasDetails ? (
        <div className="mt-2 border-t border-surface-container-highest pt-2">
          {tool.input ? <ToolDetailBlock label="Input" value={tool.input} /> : null}
          {tool.output ? <ToolDetailBlock label="Output" value={tool.output} /> : null}
          {tool.error ? <ToolDetailBlock label="Error" value={tool.error} error /> : null}
        </div>
      ) : hasDetails ? (
        <p className="mt-1 text-xs text-muted">Click for input / output</p>
      ) : (
        <p className="mt-1 text-xs text-muted">No arguments or output recorded for this call.</p>
      )}
    </div>
  );
}

export function AgentTranscript({
  entries,
  emptyMessage = 'Waiting for the first response…',
}: AgentTranscriptProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-6">
      {entries.map((entry) => {
        if (entry.role === 'tool') {
          return (
            <article
              key={entry.id}
              className="min-w-0 rounded-lg border border-outline-variant bg-background px-3 py-2 text-sm text-on-surface-variant"
            >
              <ToolTranscriptBody entry={entry} />
            </article>
          );
        }

        return (
          <article
            key={entry.id}
            className={`min-w-0 rounded-lg px-4 py-3 text-sm ${bubbleClasses(entry.role)}`}
          >
            <header className="mb-1.5 flex items-center gap-2 text-xs opacity-70">
              <span className="font-medium">{roleLabel(entry.role)}</span>
              {entry.streaming ? (
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 animate-pulse rounded-full bg-current" />
                  streaming
                </span>
              ) : null}
            </header>
            <MarkdownMessage
              text={entry.text}
              streaming={entry.streaming}
              variant={entry.role === 'user' ? 'on-dark' : 'default'}
            />
          </article>
        );
      })}
    </div>
  );
}
