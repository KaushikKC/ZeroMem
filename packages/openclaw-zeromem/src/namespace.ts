/**
 * Resolve OpenClaw session key → memory namespace.
 *
 * Examples (matching MemWal plugin):
 *   "main:uuid-123"            → "default"
 *   "agent:researcher:uuid-x"  → "researcher"
 *   "agent:coder:uuid-y"       → "coder"
 *   undefined                  → "default"
 */
export function namespaceFromSessionKey(
  sessionKey: string | undefined,
  fallback = 'default',
): string {
  if (!sessionKey) return fallback;
  const parts = sessionKey.split(':');
  if (parts[0] === 'agent' && parts[1]) return parts[1];
  return fallback;
}
