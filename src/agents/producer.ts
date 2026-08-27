import { all, first, insert, parseJson, update } from '../lib/db';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';
import type { Creative } from '../types';
import { type Agent, failed, num, ok, str, strList } from './agent';

/**
 * The producer manages media: what is in the R2 bucket, and which creative it
 * belongs to.
 *
 * It does not render video. A Worker has neither the CPU time nor ffmpeg, and
 * pretending otherwise would produce a broken pipeline. Rendering happens
 * outside (a render box, a shoot, or a generation service), the result is
 * uploaded through POST /api/media, and this agent files it and attaches it.
 * The `render_request` task is the handoff: it records what is needed and
 * leaves a job an external worker can claim.
 */
export const producer: Agent = {
  id: 'producer',
  describe: 'Files uploaded media into R2 and attaches it to the right creative.',

  tasks: {
    /** Attach existing media assets to a creative. */
    async attach_media(ctx, payload) {
      const creativeId = str(payload, 'creativeId');
      const assetIds = strList(payload, 'assetIds');
      if (!creativeId || assetIds.length === 0) {
        return failed('attach_media needs creativeId and assetIds');
      }

      const creativeRow = await first<Creative>(
        ctx.env,
        'SELECT * FROM creatives WHERE id = ?',
        creativeId,
      );
      if (!creativeRow) return failed(`creative ${creativeId} not found`);

      const placeholders = assetIds.map(() => '?').join(',');
      const found = await all<{ id: string }>(
        ctx.env,
        `SELECT id FROM media_assets WHERE id IN (${placeholders})`,
        ...assetIds,
      );
      const valid = found.map((r) => r.id);
      if (valid.length === 0) return failed('none of those asset ids exist');

      const existing = parseJson<string[]>(creativeRow.media, []);
      const merged = [...new Set([...existing, ...valid])];
      await update(ctx.env, 'creatives', creativeId, { media: JSON.stringify(merged) });

      await ctx.decide({
        agent: 'producer',
        action: 'attach_media',
        targetType: 'creative',
        targetId: creativeId,
        rationale: `attached ${valid.length} assets`,
        proposed: { media: merged },
      });
      return ok(`attached ${valid.length} assets to ${creativeId}`, { data: { media: merged } });
    },

    /**
     * Record that a creative needs media rendered. An external render worker
     * polls GET /api/render-queue, does the work, and uploads the result.
     */
    async render_request(ctx, payload) {
      const creativeId = str(payload, 'creativeId');
      if (!creativeId) return failed('render_request needs a creativeId');
      const creativeRow = await first<Creative>(
        ctx.env,
        'SELECT * FROM creatives WHERE id = ?',
        creativeId,
      );
      if (!creativeRow) return failed(`creative ${creativeId} not found`);

      const spec = {
        creative_id: creativeId,
        channel: creativeRow.channel,
        kind: creativeRow.kind,
        hook: creativeRow.hook,
        body: creativeRow.body,
        aspect: creativeRow.channel === 'tiktok' || creativeRow.channel === 'youtube' ? '9:16' : '4:5',
        max_duration_ms: creativeRow.channel === 'tiktok' ? 45_000 : 60_000,
        requested_at: nowIso(),
      };

      await insert(ctx.env, 'settings', {
        key: `render:${creativeId}`,
        value: JSON.stringify(spec),
        updated_at: nowIso(),
      }, { orIgnore: true });

      await ctx.decide({
        agent: 'producer',
        action: 'request_render',
        targetType: 'creative',
        targetId: creativeId,
        rationale: 'creative has copy but no media',
        proposed: spec,
      });
      return ok('render request recorded', { data: spec });
    },

    /** Approved copy with no media cannot publish on a visual channel. */
    async find_missing_media(ctx, payload) {
      const limit = num(payload, 'limit') ?? 20;
      const visual = ['tiktok', 'instagram', 'youtube', 'pinterest'];
      const rows = await all<Creative>(
        ctx.env,
        `SELECT * FROM creatives
          WHERE status IN ('approved','pending_approval')
            AND channel IN (${visual.map(() => '?').join(',')})
            AND (media = '[]' OR media IS NULL)
          ORDER BY created_at DESC LIMIT ?`,
        ...visual,
        limit,
      );
      // Says which of the two zero states this is, for the same reason as
      // strategist.plan_organic: an empty catalogue and a fully-served one both
      // return no rows here, and only one of them is good news.
      if (rows.length === 0) {
        const total = await first<{ n: number }>(
          ctx.env,
          `SELECT COUNT(*) AS n FROM creatives WHERE status IN ('approved','pending_approval')`,
        );
        if ((total?.n ?? 0) === 0) return ok('no approved or pending creatives exist yet');
        return ok('every visual creative has media');
      }

      let enqueued = 0;
      for (const row of rows) {
        const jobId = await ctx.enqueue({
          agent: 'producer',
          task: 'render_request',
          payload: { creativeId: row.id },
          priority: 6,
          dedupe: ['render_request', row.id],
        });
        if (jobId) enqueued++;
      }
      return ok(`${rows.length} creatives need media, ${enqueued} render requests queued`, {
        enqueued,
      });
    },
  },
};

/** Store an uploaded file in R2 and register it. Used by the media API route. */
export async function storeMedia(
  env: import('../env').Env,
  input: { bytes: ArrayBuffer; mimeType: string; filename?: string; altText?: string },
): Promise<{ assetId: string; key: string }> {
  const digest = await crypto.subtle.digest('SHA-256', input.bytes);
  const checksum = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const extension = extensionFor(input.mimeType, input.filename);
  const key = `${checksum.slice(0, 16)}${extension}`;

  await env.MEDIA.put(key, input.bytes, {
    httpMetadata: { contentType: input.mimeType, cacheControl: 'public, max-age=31536000' },
  });

  const existing = await first<{ id: string }>(
    env,
    'SELECT id FROM media_assets WHERE r2_key = ?',
    key,
  );
  if (existing) return { assetId: existing.id, key };

  const assetId = id('mda');
  await insert(env, 'media_assets', {
    id: assetId,
    r2_key: key,
    mime_type: input.mimeType,
    bytes: input.bytes.byteLength,
    checksum_sha256: checksum,
    source: 'upload',
    alt_text: input.altText ?? null,
    meta: JSON.stringify({ filename: input.filename ?? null }),
    created_at: nowIso(),
  });
  return { assetId, key };
}

function extensionFor(mimeType: string, filename?: string): string {
  const fromName = filename?.match(/\.[a-z0-9]{2,5}$/i)?.[0];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
  };
  return map[mimeType] ?? '.bin';
}
