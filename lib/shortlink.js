/**
 * shortlink.js — expand maps.app.goo.gl links that people paste from their phone.
 *
 * A browser cannot follow such a redirect itself: the 302 target is not exposed cross-origin.
 * So the app tries, in order:
 *   1. /api/resolve — on the bundled server when the page is served by it, or on the helper API
 *      base URL set in Advanced when the page is hosted on a static host apart from its resolver
 *   2. the public r.jina.ai reader, which echoes the redirect chain in "Final URL:"
 *   3. a user-supplied proxy
 * If all fail the UI explains how to copy the long URL from the address bar instead.
 */

import { isShortLink, normalizeUrlString, extractUrls } from './parser.js';

export class ResolveError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'ResolveError';
    this.hint = hint;
  }
}

const GMAPS_URL = /https:\/\/(?:www\.google\.[a-z.]{2,}|maps\.google\.[a-z.]{2,})\/maps\/[^\s"'<>\\]+/i;

export function extractFinalUrl(text) {
  if (typeof text !== 'string') return null;
  const labelled = text.match(/^\s*(?:Final URL|URL Source|Original URL)\s*:\s*(\S+)/im);
  if (labelled) {
    const url = normalizeUrlString(labelled[1]);
    if (url && GMAPS_URL.test(url)) return url;
  }
  // Some responders embed the destination in a meta refresh or anchor instead.
  const embedded = text.match(GMAPS_URL);
  return embedded ? embedded[0] : null;
}

async function fetchText(url, { fetchImpl, timeoutMs, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: headers || {} });
    if (!response.ok) throw new ResolveError(`HTTP ${response.status}`, {});
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function defaultResolvers(proxyUrl, apiBase) {
  // Same-origin when the page and its resolver share a host; absolute when the page is on a
  // static host and the resolver lives elsewhere (Advanced → helper API base URL).
  const base = String(apiBase || '').replace(/\/+$/, '');
  const resolvers = [
    {
      label: base ? 'helper API' : 'built-in resolver',
      run: async (target, opts) => {
        const text = await fetchText(`${base}/api/resolve?url=${encodeURIComponent(target)}`, opts);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ResolveError('resolver replied with non-JSON');
        }
        if (!payload?.url) throw new ResolveError(payload?.error || 'resolver returned no URL');
        return payload.url;
      },
    },
    {
      label: 'r.jina.ai reader',
      run: async (target, opts) => {
        const text = await fetchText(`https://r.jina.ai/${target}`, opts);
        const found = extractFinalUrl(text);
        if (!found) throw new ResolveError('the reader could not find a Google Maps URL in its response');
        return found;
      },
    },
  ];
  if (proxyUrl) {
    resolvers.push({
      label: 'custom proxy',
      run: async (target, opts) => {
        const text = await fetchText(`${proxyUrl}${encodeURIComponent(target)}`, opts);
        const found = extractFinalUrl(text);
        if (!found) throw new ResolveError('the proxy response contained no Google Maps URL');
        return found;
      },
    });
  }
  return resolvers;
}

/**
 * @param {string} input the short link (or any link) to expand
 * @returns {Promise<{url:string, via:string, alreadyFull:boolean}>}
 */
export async function resolveShortLink(input, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 15000, proxyUrl, apiBase, resolvers = defaultResolvers(proxyUrl, apiBase) } = options;
  // Accept a whole message containing the link, the way the parser does.
  const url = normalizeUrlString(input) || extractUrls(input ?? '')[0] || null;
  if (!url) throw new ResolveError('Nothing to resolve — paste a link first.');
  if (!isShortLink(url)) return { url, via: 'none', alreadyFull: true };

  const failures = [];
  for (const resolver of resolvers) {
    try {
      const finalUrl = await resolver.run(url, { fetchImpl, timeoutMs });
      if (finalUrl && /google\.[a-z.]{2,}\/maps/i.test(finalUrl)) return { url: finalUrl, via: resolver.label, alreadyFull: false };
      failures.push(`${resolver.label}: no Google Maps URL`);
    } catch (error) {
      failures.push(`${resolver.label}: ${error.message}`);
    }
  }
  throw new ResolveError(
    `Could not expand that short link (${failures.join('; ')}).`,
    {
      hint: 'Open the link in a browser, wait for the map to load, then copy the address-bar URL — it starts with https://www.google.com/maps/dir/ — and paste that here.',
    },
  );
}
