import { apiFetch } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { utcDate } from '../lib/time';
import type { MetricRow } from '../types';
import { credentialsFor } from './credentials';
import { captionFor } from './meta';
import {
  describedPublish,
  emptyMetric,
  type MediaRef,
  type OrganicAdapter,
  type PlatformContext,
  type VerifyResult,
} from './types';

/**
 * LinkedIn posts as an organization. The account's external_id is the
 * organization URN, for example urn:li:organization:12345678.
 *
 * Docs: learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
 */
const API = 'https://api.linkedin.com/rest';
const VERSION = '202502';

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'linkedin-version': VERSION,
    'x-restli-protocol-version': '2.0.0',
    'content-type': 'application/json',
  };
}

function orgUrn(externalId: string): string {
  return externalId.startsWith('urn:') ? externalId : `urn:li:organization:${externalId}`;
}

export const linkedinOrganic: OrganicAdapter = {
  channel: 'linkedin',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const urn = orgUrn(account.external_id);
    const data = await apiFetch<{ localizedName?: string; id?: number }>(
      `${API}/organizations/${urn.split(':').pop()}`,
      { channel: 'linkedin', headers: headers(token) },
    );
    return {
      ok: Boolean(data.id),
      detail: data.localizedName ? `organization: ${data.localizedName}` : 'organization not found',
    };
  },

  async publish(ctx, account, input) {
    const token = credentialsFor(ctx.env, account).accessToken;
    const author = orgUrn(account.external_id);
    const commentary = captionFor(input, { maxHashtags: 5 }).slice(0, 3000);

    if (ctx.dryRun) {
      return describedPublish('linkedin.publish', {
        author,
        commentary,
        media: input.media.map((m) => m.url),
      });
    }

    const body: Record<string, unknown> = {
      author,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    const image = input.media.find((m) => m.kind === 'image');
    if (image) {
      const imageUrn = await uploadImage(ctx, token, author, image);
      body.content = { media: { id: imageUrn, ...(image.altText ? { altText: image.altText } : {}) } };
    } else if (input.linkUrl) {
      body.content = {
        article: {
          source: input.linkUrl,
          title: (input.title ?? input.hook ?? 'BBA Network').slice(0, 200),
        },
      };
    }

    const res = await fetch(`${API}/posts`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new PlatformError('linkedin', `post failed: ${res.status}`, res.status, {
        body: (await res.text()).slice(0, 800),
      });
    }
    // LinkedIn returns the post URN in a header, not the body.
    const postUrn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id');
    if (!postUrn) throw new PlatformError('linkedin', 'post returned no urn', 502);
    return {
      externalId: postUrn,
      permalink: `https://www.linkedin.com/feed/update/${postUrn}/`,
    };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = credentialsFor(ctx.env, account).accessToken;
    const ids = (opts.externalIds ?? []).filter((v) => v.startsWith('urn:'));
    if (ids.length === 0) return [];

    const data = await apiFetch<{ elements?: LinkedInStat[] }>(
      `${API}/socialActions?ids=List(${ids.map(encodeURIComponent).join(',')})`,
      { channel: 'linkedin', headers: headers(token), tolerate: [400, 404] },
    );
    ctx.log.debug('linkedin insights', { requested: ids.length });

    return (data.elements ?? []).map((el) => {
      const metric = emptyMetric('post', el.urn ?? '', 'linkedin', utcDate(opts.until));
      metric.engagements = (el.likesSummary?.totalLikes ?? 0) + (el.commentsSummary?.count ?? 0);
      metric.raw = el;
      return metric;
    });
  },
};

/** Three-step image upload: register, PUT bytes, then reference the URN. */
async function uploadImage(
  ctx: PlatformContext,
  token: string,
  owner: string,
  image: MediaRef,
): Promise<string> {
  const init = await apiFetch<{ value?: { uploadUrl?: string; image?: string } }>(
    `${API}/images?action=initializeUpload`,
    {
      channel: 'linkedin',
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    },
  );
  const uploadUrl = init.value?.uploadUrl;
  const imageUrn = init.value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new PlatformError('linkedin', 'image upload init returned no url', 502);
  }

  const source = await fetch(image.url);
  if (!source.ok) {
    throw new PlatformError('linkedin', `could not fetch ${image.url}: ${source.status}`, 502);
  }
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': image.mimeType },
    body: await source.arrayBuffer(),
  });
  if (!put.ok) {
    throw new PlatformError('linkedin', `image upload failed: ${put.status}`, put.status);
  }
  ctx.log.debug('linkedin image uploaded', { image_urn: imageUrn });
  return imageUrn;
}

interface LinkedInStat {
  urn?: string;
  likesSummary?: { totalLikes?: number };
  commentsSummary?: { count?: number };
}
