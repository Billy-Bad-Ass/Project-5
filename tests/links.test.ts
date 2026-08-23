import { describe, expect, it } from 'vitest';
import { applyTracking, buildTrackedLink, offerLink } from '../src/api/links';

const offer = { slug: 'starter', landing_url: 'https://bbanetwork.org/starter' };

describe('tracked links', () => {
  it('builds a link on the link domain', () => {
    const link = buildTrackedLink('https://go.bbanetwork.org', 'starter', {
      channel: 'tiktok',
      campaignId: 'cmp_1',
      medium: 'paid',
    });
    const url = new URL(link);
    expect(url.origin).toBe('https://go.bbanetwork.org');
    expect(url.pathname).toBe('/go/starter');
    expect(url.searchParams.get('ch')).toBe('tiktok');
    expect(url.searchParams.get('c')).toBe('cmp_1');
  });

  it('accepts a base without a scheme', () => {
    expect(buildTrackedLink('go.bbanetwork.org', 'starter').startsWith('https://go.bbanetwork.org/'))
      .toBe(true);
  });

  it('omits parameters that were not supplied', () => {
    const url = new URL(buildTrackedLink('https://go.bbanetwork.org', 'starter'));
    expect(url.search).toBe('');
  });

  it('stamps the parameters the analyst keys attribution on', () => {
    const url = new URL(
      applyTracking('https://bbanetwork.org/starter', {
        channel: 'instagram',
        campaignId: 'cmp_9',
        campaignName: 'spring push',
        medium: 'social',
        variant: 'crv_3',
      }),
    );
    expect(url.searchParams.get('bba_campaign_id')).toBe('cmp_9');
    expect(url.searchParams.get('bba_channel')).toBe('instagram');
    expect(url.searchParams.get('utm_source')).toBe('instagram');
    expect(url.searchParams.get('utm_medium')).toBe('social');
    expect(url.searchParams.get('utm_campaign')).toBe('spring push');
    expect(url.searchParams.get('utm_content')).toBe('crv_3');
  });

  it('preserves query parameters already on the landing page', () => {
    const url = new URL(
      applyTracking('https://bbanetwork.org/starter?plan=pro', { channel: 'x', campaignId: 'c1' }),
    );
    expect(url.searchParams.get('plan')).toBe('pro');
    expect(url.searchParams.get('bba_campaign_id')).toBe('c1');
  });

  it('defaults to paid medium', () => {
    const url = new URL(applyTracking('https://bbanetwork.org/x', { channel: 'tiktok' }));
    expect(url.searchParams.get('utm_medium')).toBe('paid');
  });

  it('falls back to the landing page when no link domain is configured', () => {
    const link = offerLink({ LINK_BASE_URL: '', PUBLIC_BASE_URL: '' } as never, offer, {
      channel: 'tiktok',
      campaignId: 'cmp_1',
    });
    // Still tracked, just not shortened.
    expect(link.startsWith('https://bbanetwork.org/starter?')).toBe(true);
    expect(new URL(link).searchParams.get('bba_campaign_id')).toBe('cmp_1');
  });

  it('uses the link domain when one is configured', () => {
    const link = offerLink(
      { LINK_BASE_URL: 'https://go.bbanetwork.org', PUBLIC_BASE_URL: 'https://ops.bbanetwork.org' } as never,
      offer,
      { channel: 'tiktok', campaignId: 'cmp_1' },
    );
    expect(new URL(link).origin).toBe('https://go.bbanetwork.org');
  });

  it('falls back to the worker origin when only PUBLIC_BASE_URL is set', () => {
    const link = offerLink(
      { LINK_BASE_URL: '', PUBLIC_BASE_URL: 'https://ops.bbanetwork.org' } as never,
      offer,
      { channel: 'x' },
    );
    expect(new URL(link).origin).toBe('https://ops.bbanetwork.org');
  });
});
