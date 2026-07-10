import type { AgentGitStatus as AgentGitStatusData, GitFileChangeKind } from '../../api/types';
import { formatRelativeTime } from '../../lib/format';
import { Badge } from '../ui/Badge';

const KIND_LABELS: Record<GitFileChangeKind, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  untracked: 'new',
  unknown: 'changed',
};

function kindVariant(kind: GitFileChangeKind): 'running' | 'processing' | 'error' | 'neutral' {
  switch (kind) {
    case 'added':
      return 'running';
    case 'modified':
      return 'processing';
    case 'deleted':
      return 'error';
    default:
      return 'neutral';
  }
}

export function AgentGitStatus({ status }: { status: AgentGitStatusData }) {
  const files = status.files ?? [];
  const filesChanged = status.filesChanged ?? files.length;
  const hasChanges = filesChanged > 0;

  const primaryKind = files.find((file) => file.kind !== 'unknown')?.kind;

  return (
    <div className="rounded-md border border-surface-container-highest bg-background">
      <div className="flex items-center justify-between border-b border-surface px-4 py-3">
        <div className="flex items-center gap-2">
          {hasChanges && primaryKind ? (
            <Badge variant={kindVariant(primaryKind)} className="!text-xs !px-2 !py-0.5">
              {KIND_LABELS[primaryKind]}
            </Badge>
          ) : null}
          <p className="text-sm ml-2 text-on-surface">Git status</p>
        </div>
        {status.updatedAt ? (
          <p className="text-xs text-muted">{formatRelativeTime(status.updatedAt)}</p>
        ) : null}
      </div>

      {hasChanges ? (
        <ul className="max-h-48 overflow-y-auto px-4 py-3 text-xs">
          {files.map((file) => (
            <li key={`${file.kind}:${file.path}`} className="flex gap-2 py-0.5">
              <span className="shrink-0 text-muted">{KIND_LABELS[file.kind]}</span>
              <span className="break-all text-on-surface">{file.path}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-xs text-muted">No changes in working tree</p>
      )}

      <div className="border-t border-surface px-4 py-2 text-xs text-muted">
        {hasChanges
          ? `${filesChanged} changed file${filesChanged === 1 ? '' : 's'}`
          : 'No changes'}
      </div>
    </div>
  );
}
