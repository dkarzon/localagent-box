import fs from 'fs';
import path from 'path';
import { CodedError } from '../types';

/** Agent-controlled files the host reads need a size ceiling as well as a path guard. */
export const SAFE_READ_MAX_BYTES = 1_000_000;

function unsafePath(message: string): CodedError {
  return new CodedError(message, 'UNSAFE_PATH');
}

/**
 * Read a file the host trusts only as far as the workspace it came from.
 *
 * Rejects anything resolving outside `rootDir` — including through a symlink — plus
 * non-regular files and files above `maxBytes`. A missing file is `null`; the caller
 * decides whether that is an error. TODO(2.5) routes the other agent-controlled
 * workspace reads (repo config, environment config, review head reads) through here.
 */
export function readFileWithin(
  rootDir: string,
  relPath: string,
  options: { maxBytes?: number } = {},
): string | null {
  const maxBytes = options.maxBytes ?? SAFE_READ_MAX_BYTES;
  const rootReal = fs.realpathSync(rootDir);
  const relative = path.relative(rootReal, path.resolve(rootDir, relPath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw unsafePath(`Refused to read outside the workspace: ${relPath}`);
  }

  // Walk each segment instead of trusting the resolved target, so a symlinked
  // parent directory cannot point the read outside the workspace.
  let current = rootReal;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) {
      throw unsafePath(`Refused to read through a symlink: ${relPath}`);
    }
    if (index === segments.length - 1) {
      if (!stat.isFile()) {
        throw unsafePath(`Refused to read a non-regular file: ${relPath}`);
      }
      if (stat.size > maxBytes) {
        throw unsafePath(`Refused to read a file larger than ${maxBytes} bytes: ${relPath}`);
      }
      return fs.readFileSync(current, 'utf8');
    }
    if (!stat.isDirectory()) {
      throw unsafePath(`Refused to read through a non-directory: ${relPath}`);
    }
  }

  return null;
}
