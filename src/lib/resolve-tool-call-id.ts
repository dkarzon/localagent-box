/** Resolve a stable tool call id from an OpenCode tool message part. */
export function resolveToolCallId(part: Record<string, unknown>): string {
  const name = String(part.tool ?? part.name ?? 'tool');
  const explicit = part.callID ?? part.callId;
  const partId =
    part.id != null && String(part.id) !== '' ? String(part.id) : undefined;

  if (explicit != null && String(explicit) !== '') {
    const id = String(explicit);
    // OpenCode may echo the tool name as callID; that is not unique per invocation.
    if (id !== name && id !== String(part.tool ?? '')) {
      return id;
    }
  }

  if (partId) {
    return partId;
  }

  if (explicit != null && String(explicit) !== '') {
    return String(explicit);
  }

  return name;
}
