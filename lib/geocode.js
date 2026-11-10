/**
 * geocode.js — resolve the place *names* carried in a Google link to coordinates.
 *
 * Uses OpenStreetMap Nominatim. Its usage policy asks for at most one request per second,
 * so every lookup goes through a shared throttle here rather than firing in parallel.
 * A same-origin `/api/proxy` (shipped in server.js) is used as a fallback for environments
 * where Nominatim rejects the browser directly.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100;

let queue = Promise.resolve();
let lastAt = 0;

/** Serialise + rate-limit lookups; exported for tests. */
export function schedule(fn) {
  const run = queue.then(async () => {
    const wait = lastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
    return fn();
  });
  // Keep the chain alive even when a lookup rejects.
  queue = run.catch(() => {});
  return run;
}

export function resetThrottleForTests() {
  queue = Promise.resolve();
  lastAt = 0;
}

function candidateQueries(wp) {
  const name = (wp.name || '').trim();
  if (!name) return [];
  const out = [name];
  // "Black Mountain Backpack Camp, Montebello Rd, Los Altos, CA 94022" — the tail is often what
  // Nominatim needs most, so also try dropping the venue name and the trailing country.
  const parts = name.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 2) out.push(parts.slice(-2).join(', '));
  if (parts.length > 1) out.push(parts[0]);
  return [...new Set(out)];
}

function viewboxFrom(viewport) {
  if (!viewport || !Number.isFinite(viewport.lat) || !Number.isFinite(viewport.lng)) return null;
  const span = 0.35; // degrees — biases results towards the map region the link was made in
  return [viewport.lng - span, viewport.lat + span, viewport.lng + span, viewport.lat - span].map((n) => n.toFixed(5)).join(',');
}

/**
 * @param {string} query free-text address/place
 * @returns {Promise<{lat:number,lng:number,displayName:string,rank:number}|null>}
 */
export async function geocodeQuery(query, options = {}) {
  const { fetchImpl = globalThis.fetch, viewport, timeoutMs = 15000, proxyUrl } = options;
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': options.language || 'en' });
  const viewbox = viewboxFrom(viewport);
  if (viewbox) params.set('viewbox', viewbox);
  if (options.countrycodes) params.set('countrycodes', options.countrycodes);

  const directUrl = `${NOMINATIM}?${params}`;
  // Direct first (Nominatim allows cross-origin reads); fall back to the bundled same-origin
  // proxy when the app is served by server.js and Nominatim refuses the browser.
  const proxy = proxyUrl === '' ? null : proxyUrl ?? '/api/proxy?url=';
  const attempts = proxy ? [directUrl, `${proxy}${encodeURIComponent(directUrl)}`] : [directUrl];

  for (const url of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await schedule(() =>
        fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } }),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const results = await response.json();
      if (!Array.isArray(results) || !results.length) continue;
      const best = pickBest(results);
      return { lat: Number(best.lat), lng: Number(best.lon), displayName: best.display_name, rank: best.rank_field ?? best.importance ?? 0 };
    } catch {
      // try the next transport
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function pickBest(results) {
  // OSM POI/address hits rank higher than postal-code or street-level fuzzy matches.
  const scored = results.map((r) => {
    let score = Number(r.rank_field) || 0;
    if (/^(house|street|place|poi)$/i.test(r.category)) score += 1;
    if (r.addresstype && /hamlet|village|suburb|city|town/i.test(r.addresstype)) score -= 0.5;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].r;
}

/**
 * Fill in coordinates for every stop that only has a name.
 * Mutates and returns a fresh array; never throws — failures come back as warnings.
 */
export async function geocodeWaypoints(waypoints, options = {}) {
  const warnings = [];
  const out = waypoints.map((wp) => ({ ...wp }));
  for (const wp of out) {
    if (Number.isFinite(wp.lat) && Number.isFinite(wp.lng)) continue;
    if (!wp.name) {
      wp.geocodeError = 'no name to look up';
      warnings.push(`Stop ${wp.index + 1} has neither coordinates nor a name.`);
      continue;
    }
    let hit = null;
    for (const query of candidateQueries(wp)) {
      hit = await geocodeQuery(query, options);
      if (hit) break;
    }
    if (hit) {
      wp.lat = hit.lat;
      wp.lng = hit.lng;
      wp.geocodedName = hit.displayName;
      wp.source = `${wp.source}+geocoded`;
      wp.precision = 'geocoded';
      if (hit.displayName && hit.displayName !== wp.name) {
        wp.geocodeNote = `Matched "${hit.displayName}"`;
      }
    } else {
      wp.geocodeError = 'no match';
      warnings.push(
        `Could not find "${wp.name}" on OpenStreetMap. Type coordinates for it manually, or use the Google Directions API source, which resolves Google place names itself.`,
      );
    }
  }
  return { waypoints: out, warnings };
}
