/**
 * The rule behind `POST /api/posts/:id/resolve`.
 *
 * This is the only path that can mark a post published without any platform
 * having said so, which is exactly why it is small, pure and tested. It exists
 * because the publisher deliberately refuses to guess: when a platform accepts
 * a post but never answers, the post is held as `needs_reconcile` and a person
 * goes and looks at the account.
 *
 * Only a held post can be resolved. A scheduled post is still going out on its
 * own, a failed one never left, and a published one is already recorded — being
 * able to move any of those from here would turn an honest "I checked" into a
 * way to fake a publish.
 */

export interface PostPatch extends Record<string, unknown> {
  status: 'published' | 'cancelled';
  last_error: null;
  published_at?: string;
  external_id?: string;
  permalink?: string;
}

export type Resolution =
  | { patch: PostPatch; warning?: string }
  | { error: string; status: 400 | 409 };

export function resolutionFor(
  currentStatus: string,
  body: Record<string, unknown>,
  now: string,
): Resolution {
  const outcome = body.outcome;
  if (outcome !== 'published' && outcome !== 'cancelled') {
    return { error: "outcome must be 'published' or 'cancelled'", status: 400 };
  }
  if (currentStatus !== 'needs_reconcile') {
    return { error: `post is ${currentStatus}, not held for review`, status: 409 };
  }

  if (outcome === 'cancelled') {
    return { patch: { status: 'cancelled', last_error: null } };
  }

  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : '';
  const permalink = typeof body.permalink === 'string' ? body.permalink.trim() : '';

  return {
    patch: {
      status: 'published',
      last_error: null,
      published_at: now,
      ...(externalId ? { external_id: externalId } : {}),
      ...(permalink ? { permalink } : {}),
    },
    // Insights are fetched by external id, so without one the post is recorded
    // as live but will never gather metrics. Worth saying rather than hiding.
    ...(externalId
      ? {}
      : { warning: 'recorded as published without a platform id, so its metrics will not sync' }),
  };
}
