/** Prefixed identifiers. The prefix keeps ids readable in logs and decisions. */
export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Deterministic key that makes retried work idempotent. */
export async function idempotencyKey(...parts: (string | number)[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join(' '));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 40);
}
