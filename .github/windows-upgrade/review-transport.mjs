import { request as publicRequest, upgradeRoute } from './verify.mjs';
import { request as draftRequest } from '../windows-smoke/download.mjs';

/** The ephemeral token exists only in the draft downloader, never in the app. */
export function packageRequest(channel, expected, url, token, fetcher = fetch) {
  if (!['stable', 'nightly'].includes(channel)) throw new Error('Invalid package channel.');
  if (!upgradeRoute(expected).review || channel !== 'stable') return publicRequest(url, fetcher);
  if (!token) throw new Error('Explicit draft access is required for the review payload.');
  const parsed = new URL(url);
  if (parsed.origin !== 'https://api.github.com' || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Unapproved review API URL.');
  return draftRequest(parsed.pathname, token,
    parsed.pathname.includes('/assets/') ? 'application/octet-stream' : 'application/vnd.github+json', fetcher);
}
