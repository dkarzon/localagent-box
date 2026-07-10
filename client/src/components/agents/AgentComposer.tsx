import { useState, type FormEvent } from 'react';
import { Button, TextArea } from '../ui/Form';

interface AgentComposerProps {
  canSend: boolean;
  disabledReason?: string;
  onSend: (text: string) => Promise<void>;
}

export function AgentComposer({ canSend, disabledReason, onSend }: AgentComposerProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !canSend || busy) return;

    setBusy(true);
    try {
      await onSend(trimmed);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="min-w-0 shrink-0 border-t border-surface-container-highest bg-surface-low p-4"
    >
      <TextArea
        rows={3}
        placeholder={
          canSend
            ? 'Send a follow-up message…'
            : disabledReason || 'Waiting for the agent to finish the current turn…'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canSend || busy}
        className="resize-none"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted">
          {canSend
            ? 'Enter to send is disabled — use the Send button.'
            : disabledReason || 'Composer disabled while the agent is working.'}
        </p>
        <Button type="submit" variant="primary" disabled={!canSend || busy || !text.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
