/**
 * Process-wide registry of cleanup callbacks for child processes the current
 * process owns (OpenCode serve, workspace bootstrap commands). The agent
 * worker runs these on SIGTERM/SIGINT so killing a worker does not orphan
 * children that keep writing into the workspace directory.
 */
type Cleanup = () => void | Promise<void>;

const cleanups = new Set<Cleanup>();

/** Register a cleanup; returns a function that unregisters it. */
export function registerChildCleanup(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/**
 * Run every registered cleanup concurrently (errors are swallowed), bounded
 * by `timeoutMs` so a stuck cleanup cannot keep the process alive.
 */
export async function runChildCleanups(timeoutMs = 7_000): Promise<void> {
  const pending = [...cleanups];
  cleanups.clear();
  if (pending.length === 0) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(pending.map(async (cleanup) => cleanup())),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/** @internal Test helper */
export function childCleanupCountForTests(): number {
  return cleanups.size;
}
