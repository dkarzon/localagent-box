export type GitFileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'unknown';

export interface GitChangedFile {
  path: string;
  kind: GitFileChangeKind;
  statusCode: string;
}
