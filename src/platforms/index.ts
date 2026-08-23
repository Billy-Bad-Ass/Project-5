import type { Channel } from '../types';
import { facebookOrganic, instagramOrganic, metaAds, threadsOrganic } from './meta';
import { tiktokAds, tiktokOrganic } from './tiktok';
import { xOrganic } from './x';
import { googleAds, youtubeOrganic } from './google';
import { pinterestAds, pinterestOrganic } from './pinterest';
import { linkedinOrganic } from './linkedin';
import { redditOrganic } from './reddit';
import { snapchatAds } from './snapchat';
import type { AdsAdapter, OrganicAdapter } from './types';

/**
 * Which adapter handles which channel. Anything not listed here simply cannot
 * be acted on, which is the intended failure mode: an unknown channel should
 * stop the orchestrator rather than fall through to a default.
 */
export const ORGANIC_ADAPTERS: Partial<Record<Channel, OrganicAdapter>> = {
  tiktok: tiktokOrganic,
  instagram: instagramOrganic,
  threads: threadsOrganic,
  facebook: facebookOrganic,
  x: xOrganic,
  youtube: youtubeOrganic,
  pinterest: pinterestOrganic,
  linkedin: linkedinOrganic,
  reddit: redditOrganic,
};

export const ADS_ADAPTERS: Partial<Record<Channel, AdsAdapter>> = {
  facebook: metaAds, // Facebook and Instagram placements share one ad account
  tiktok: tiktokAds,
  google: googleAds, // Search, Display, YouTube
  pinterest: pinterestAds,
  snapchat: snapchatAds,
};

export function organicFor(channel: Channel): OrganicAdapter | undefined {
  return ORGANIC_ADAPTERS[channel];
}

export function adsFor(channel: Channel): AdsAdapter | undefined {
  return ADS_ADAPTERS[channel];
}

/** Channels the system can post organically to, in a stable order. */
export const ORGANIC_CHANNELS = Object.keys(ORGANIC_ADAPTERS) as Channel[];
export const ADS_CHANNELS = Object.keys(ADS_ADAPTERS) as Channel[];

export * from './types';
