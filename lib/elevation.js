/**
 * elevation.js — fill in `<ele>` heights so a GPX file draws a real elevation profile.
 *
 * Neither OSRM nor the Directions API returns heights, so the heights come from a digital
 * elevation model instead. Two free, key-less sources are tried in order:
 *
 *   open-meteo     Copernicus DEM (90 m). Sends `Access-Control-Allow-Origin: *`, so the browser
 *                  can call it directly. Max 100 coordinates per request.
 *   opentopodata   SRTM (30 m), finer gridding, but it sends no CORS header — it is only
 *                  reachable through the bundled same-origin /api/proxy.
 *
 * Points are *sampled*, not requested one by one: the DEM cannot resolve a height every few
 * metres, so asking for every track point would spend dozens of requests to get values that are
 * all from the same pixel. Instead we ask for an evenly-spaced subset along the route and
 * linearly interpolate the rest, which keeps a route of any length inside a handful of requests
 * while still putting an `<ele>` on every `<trkpt>` — which is what makes a viewer draw the
 * profile at all.
 *
 * Everything here is best-effort and never throws: a route without heights is still a perfectly
 * good route, so failures come back as `null` plus a warning the UI can show.
 */

import { cumulativeDistances } from './geo.js';

export const PROVIDERS = [
  {
    id: 'open-meteo',
    label: 'Open-Meteo · Copernicus DEM 90 m',
    endpoint: 'https://api.open-meteo.com/v1/elevation',
    maxBatch: 100,
    /** Reachable straight from the browser. */
    crossOrigin: true,
    buildUrl(coords) {
      const params = new URLSearchParams({
        latitude: coords.map((c) => round5(c.lat)).join(','),
        longitude: coords.map((c) => round5(c.lng)).join(','),
      });
      return `${this.endpoint}?${params}`;
    },
    parse(payload, count) {
      const values = Array.isArray(payload?.elevation) ? payload.elevation : [];
      return values.length === count ? values.map(toNumber) : pad(toValues(values.map(toNumber)), count);
    },
  },
  {
    id: 'opentopodata',
    label: 'OpenTopoData · SRTM 30 m',
    endpoint: 'https://api.opentopodata.org/v1/srtm30m',
    maxBatch: 100,
    crossOrigin: false,
    buildUrl(coords) {
      const params = new URLSearchParams({ locations: coords.map((c) => `${round5(c.lat)},${round5(c.lng)}`).join('|') });
      return `${this.endpoint}?${params}`;
    },
    parse(payload, count) {
      const results = Array.isArray(payload?.results) ? payload.results : [];
      return pad(toValues(results.map((r) => r?.elevation)), count);
    },
  },
];

const DEFAULT_SAMPLE_SPACING_M = 60;
const DEFAULT_MAX_SAMPLES = 400;

function round5(n) {
  return Number(n).toFixed(5);
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Keep only the leading run of usable values — a partial answer is not a partial profile. */
function toValues(list) {
  return list.map(toNumber);
}

function pad(list, count) {
  const out = list.slice(0, count);
  while (out.length < count) out.push(null);
  return out;
}

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * Pick the track-point indices to ask the DEM about: evenly spaced along the route by distance,
 * always including the first and last point, and never more than `maxSamples`.
 */
export function planSamples(points, { spacingMeters = DEFAULT_SAMPLE_SPACING_M, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const cum = cumulativeDistances(points);
  const total = cum[cum.length - 1] || 0;
  if (total <= 0) return points.map((_, i) => i);

  const wanted = Math.max(2, Math.min(maxSamples, Math.round(total / spacingMeters) + 1));
  if (wanted >= points.length) return points.map((_, i) => i);

  const step = total / (wanted - 1);
  const picked = [];
  let cursor = 0;
  for (let k = 0; k < wanted; k++) {
    const target = k * step;
    while (cursor < points.length - 2 && cum[cursor + 1] < target) cursor += 1;
    if (picked[picked.length - 1] !== cursor) picked.push(cursor);
  }
  if (picked[0] !== 0) picked.unshift(0);
  if (picked[picked.length - 1] !== points.length - 1) picked.push(points.length - 1);

  // Adding the two endpoints can push one or two past the budget, so thin the list to fit while
  // keeping the ends — the request count is the whole point of sampling.
  if (picked.length > maxSamples) {
    const spread = (picked.length - 1) / (maxSamples - 1);
    const thinned = [];
    for (let k = 0; k < maxSamples; k++) thinned.push(picked[Math.round(k * spread)]);
    return [...new Set(thinned)];
  }
  return picked;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Ask one provider for the heights of `coords`, in batches it will accept.
 * @returns {Promise<number[]|null>} heights aligned to `coords`, or null if the answer is unusable
 */
async function fetchHeightsFrom(provider, coords, { fetchImpl, proxyUrl, timeoutMs, signal }) {
  const batches = chunk(coords, provider.maxBatch);
  const heights = [];
  for (const batch of batches) {
    const directUrl = provider.buildUrl(batch);
    // A provider without CORS is only usable via the same-origin proxy; skip the doomed
    // cross-origin attempt rather than logging a spurious failure.
    const transports = provider.crossOrigin
      ? [directUrl, proxyUrl ? `${proxyUrl}${encodeURIComponent(directUrl)}` : null].filter(Boolean)
      : proxyUrl
        ? [`${proxyUrl}${encodeURIComponent(directUrl)}`]
        : [];
    if (!transports.length) return null;

    let batchHeights = null;
    for (const url of transports) {
      if (signal?.aborted) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort);
      try {
        const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const parsed = provider.parse(payload, batch.length);
        if (parsed.some((h) => h === null)) throw new Error('incomplete answer');
        batchHeights = parsed;
        break;
      } catch {
        /* try the next transport */
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
    if (!batchHeights) return null; // one unusable batch spoils the profile — fail the provider
    heights.push(...batchHeights);
  }
  return heights;
}

/**
 * Spread sampled heights across every track point by linear interpolation in distance space,
 * then fill any remaining gaps from the nearest known value.
 */
export function interpolateHeights(points, sampleIndices, sampleHeights) {
  if (!Array.isArray(points) || !points.length) return [];
  const known = [];
  sampleIndices.forEach((idx, k) => {
    const h = sampleHeights[k];
    if (Number.isFinite(h)) known.push({ idx, height: h });
  });
  if (!known.length) return points.map((p) => ({ ...p }));

  const cum = cumulativeDistances(points);
  const out = points.map((p) => ({ ...p }));

  for (let i = 0; i < points.length; i++) {
    if (i <= known[0].idx) {
      out[i].ele = known[0].height;
      continue;
    }
    const last = known[known.length - 1];
    if (i >= last.idx) {
      out[i].ele = last.height;
      continue;
    }
    let seg = 0;
    while (seg < known.length - 2 && known[seg + 1].idx < i) seg += 1;
    const a = known[seg];
    const b = known[seg + 1];
    const span = cum[b.idx] - cum[a.idx];
    out[i].ele = span > 0 ? a.height + ((b.height - a.height) * (cum[i] - cum[a.idx])) / span : b.height;
  }
  return out;
}

/** Ascent, descent and extremes over the points that carry a height. */
export function elevationProfile(points) {
  const heights = (points || []).map((p) => toNumber(p?.ele)).filter((h) => h !== null);
  if (heights.length < 2) return null;
  let ascent = 0;
  let descent = 0;
  for (let i = 1; i < heights.length; i++) {
    const delta = heights[i] - heights[i - 1];
    if (delta > 0) ascent += delta;
    else descent -= delta;
  }
  return {
    ascent,
    descent,
    min: Math.min(...heights),
    max: Math.max(...heights),
    counted: heights.length,
    total: points.length,
  };
}

/**
 * Add heights to a route's points.
 *
 * @param {Array<{lat:number,lng:number}>} points
 * @param {object} [options] { provider = 'auto', fetchImpl, proxyUrl, timeoutMs, signal,
 *                             spacingMeters, maxSamples }
 * @returns {Promise<{points:Array, profile:object|null, provider:string|null, label:string|null,
 *                     sampled:number, warning:string|null}>}
 */
export async function addElevation(points, options = {}) {
  const {
    provider = 'auto',
    fetchImpl = globalThis.fetch,
    proxyUrl = '/api/proxy?url=',
    timeoutMs = 20000,
    signal,
    spacingMeters,
    maxSamples,
  } = options;

  const noop = { points: points || [], profile: null, provider: null, label: null, sampled: 0, warning: null };
  if (!Array.isArray(points) || points.length < 2) return noop;
  if (typeof fetchImpl !== 'function') return { ...noop, warning: 'No network available to look up heights.' };

  const order = provider === 'auto' ? PROVIDERS : [providerById(provider)].filter(Boolean);
  if (!order.length) return { ...noop, warning: `Unknown elevation source "${provider}".` };

  const sampleIndices = planSamples(points, { spacingMeters, maxSamples });
  const coords = sampleIndices.map((i) => points[i]);

  const tried = [];
  for (const candidate of order) {
    tried.push(candidate.id);
    const heights = await fetchHeightsFrom(candidate, coords, { fetchImpl, proxyUrl, timeoutMs, signal });
    if (!heights) continue;
    if (signal?.aborted) return { ...noop, warning: 'Cancelled.' };

    const withHeights = interpolateHeights(points, sampleIndices, heights);
    const profile = elevationProfile(withHeights);
    if (!profile) continue;
    return { points: withHeights, profile, provider: candidate.id, label: candidate.label, sampled: sampleIndices.length, warning: null };
  }

  return {
    ...noop,
    warning: `Could not get heights from ${tried.join(' or ')} — the route was exported without elevation.`,
  };
}
