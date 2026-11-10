/**
 * parser.js — turn any Google Maps directions URL into a structured route request.
 *
 * Pure module: no DOM, no fetch. Everything here is unit-tested in tests/parser.test.js.
 *
 * Supported URL shapes (observed in the wild, incl. links shared from Android/iOS):
 *   /maps/dir/<name>/<name>/@lat,lng,z/data=!3m1!1e3!4m..!1m5!1m1!1s<id>!2m2!1d<lon>!2d<lat>!3e2
 *   /maps/dir/?api=1&origin=..&destination=..&waypoints=a|b&travelmode=driving
 *   /maps?saddr=..&daddr=..&dirflg=d
 *   /maps/dir/40.1,-105.2/40.2,-105.1/
 *   /maps/place/.. or /maps/search/..            (single point)
 *   maps.app.goo.gl/xxxx, goo.gl/xxxx            (short link — resolved elsewhere)
 */

const TRAVEL_MODES = ['driving', 'walking', 'cycling', 'transit'];

/** Google's `!3e<N>` travel-mode enum, as it appears in the `data=` block. */
const DATA_MODE = { 0: 'driving', 1: 'transit', 2: 'walking', 3: 'cycling' };

/** Legacy `dirflg` letters. `m`/`h`/`T` are transit flavours, `t`=tram, `s`=subway. */
const DIRFLG_MODE = {
  d: 'driving',
  w: 'walking',
  b: 'cycling',
  r: 'transit',
  m: 'transit',
  t: 'transit',
  s: 'transit',
  h: 'transit',
  T: 'transit',
};

/** Hosts that only ever carry a redirect to a full /maps/ URL. */
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.co']);

/** Path segments that terminate the waypoint list in a /maps/dir/ URL. */
function isTerminalSegment(seg) {
  if (seg === '') return false; // an empty segment means "your location" — see parseDirPath
  if (seg.startsWith('@')) return true;
  if (/^(data|am|time|hl|t|source|echo|output|sensor|ie|oe)=/i.test(seg)) return true;
  if (seg.startsWith('!')) return true;
  return /^(search|place|preview|review|dir|maps|dirnavi|lite)$/i.test(seg);
}

export function isShortLink(rawUrl) {
  const url = normalizeUrlString(rawUrl);
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return SHORT_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** Accepts sloppy input: surrounding prose, missing scheme, HTML-escaped ampersands. */
export function normalizeUrlString(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/&amp;/gi, '&');
  s = s.replace(/^["'<(\[]+|["'>)\]]+$/g, '').trim();
  s = s.replace(/[).,;:!?]+$/g, '');
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return `https:${s}`;
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s)) return `https://${s}`;
  return null;
}

/** Pull every plausible URL out of arbitrary pasted text (chat logs, emails). */
export function extractUrls(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out = [];
  const re = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[\w-]+\.)+(?:goo\.gl|gl|com|net|org)[^\s<>"'`]*/gi;
  for (const match of text.matchAll(re)) {
    const url = normalizeUrlString(match[0]);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Split "40.0,-105.2" / "@40.0,-105.2,14z" / "40.0 -105.2" into validated degrees. */
export function parseLatLng(text) {
  if (text == null) return null;
  let s = String(text).trim().replace(/^@+/, '');
  const parts = s.split(/[,;\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  if (Math.abs(first) > 180 || Math.abs(second) > 180) return null;
  // Google writes path coordinates as lat,lng. Some exports carry lng,lat; a pair is only
  // ever swapped when the first value cannot possibly be a latitude, so legitimate points
  // such as 51.5,150 are left alone.
  let lat;
  let lng;
  if (Math.abs(first) <= 90) {
    lat = first;
    lng = second;
  } else if (Math.abs(second) <= 90) {
    lat = second;
    lng = first;
  } else {
    return null;
  }
  if (Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function looksLikeCoordinates(segment) {
  // Three numbers with a trailing zoom ("40.0,-105.2,14z") is still a coordinate pair.
  const pair = parseLatLng(segment);
  if (pair) return pair;
  const m = String(segment).match(/^(-?\d+(?:\.\d+)?)[,; ](-?\d+(?:\.\d+)?)[,; ](\d+(?:\.\d+)?)(?:z|m)$/i);
  return m ? parseLatLng(`${m[1]},${m[2]}`) : null;
}

function cleanName(segment) {
  let s = String(segment);
  try {
    s = decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    s = s.replace(/\+/g, ' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  // Strip view-mode decorations Google injects into path segments.
  s = s.replace(/^!?\d+m=/i, '');
  return s;
}

/** "@37.2446911,-122.1129273,20047m" or "@37.24,-122.11,17z" → viewport centre + zoom. */
function parseViewport(segment) {
  if (!segment.startsWith('@')) return null;
  const body = segment.slice(1);
  const parts = body.split(',');
  const pair = parseLatLng(parts.slice(0, 2).join(','));
  if (!pair) return null;
  let zoom = null;
  if (parts[2]) {
    const z = parseFloat(parts[2].replace(/[a-z]+$/i, ''));
    if (Number.isFinite(z)) zoom = z;
  }
  return { lat: pair.lat, lng: pair.lng, zoom };
}

/**
 * Precise coordinates hide in the `data=` block:
 *   !1m5!1m1!1s0x808fb1f5..:0xb38f..!2m2!1d<lon>!2d<lat>
 * Note the order: `!1d` is longitude, `!2d` is latitude (the reverse of the path form).
 * Fallback shapes: `!2m2!1d<lon>!2d<lat>` without a place id, and the place-detail
 * `!8m2!3d<lat>!4d<lng>`.
 */
export function parseDataBlocks(urlString) {
  const points = [];
  const decoded = safeDecode(urlString);

  const placeRe = /!1m5!1m1!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)!2m2!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g;
  for (const m of decoded.matchAll(placeRe)) {
    const lng = Number(m[2]);
    const lat = Number(m[3]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      points.push({ lat, lng, placeId: m[1], source: 'data' });
    }
  }
  if (points.length === 0) {
    const looseRe = /!2m2!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g;
    for (const m of decoded.matchAll(looseRe)) {
      const lng = Number(m[1]);
      const lat = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) points.push({ lat, lng, source: 'data' });
    }
    // Place links carry their point as !8m2!3d<lat>!4d<lng>.
    const placeDetailRe = /!8m2!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g;
    for (const m of decoded.matchAll(placeDetailRe)) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) points.push({ lat, lng, source: 'data' });
    }
  }
  return points;
}

function parseDataTravelMode(urlString) {
  const decoded = safeDecode(urlString);
  const modes = [];
  for (const m of decoded.matchAll(/!3e(\d)/g)) {
    const mode = DATA_MODE[Number(m[1])];
    if (mode) modes.push(mode);
  }
  if (!modes.length) return { mode: null, mixed: false };
  const first = modes[0];
  return { mode: first, mixed: modes.some((m) => m !== first) };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

/** Query-string forms: modern `api=1` plus the legacy `saddr`/`daddr`/`dirflg`. */
function fromQuery(params, warnings) {
  const get = (k) => {
    const v = params.get(k);
    return v == null || v.trim() === '' ? null : v.trim();
  };
  const raw = [];
  const origin = get('origin') || get('saddr') || get('sll');
  const destination = get('destination') || get('daddr') || get('ll') && null;
  const waypointsRaw = get('waypoints');

  if (origin) raw.push(origin);
  if (waypointsRaw) {
    // `waypoints=a|b` in api=1 links, `a;b` in some legacy exports.
    for (const wp of waypointsRaw.split(/[|;]/)) if (wp.trim()) raw.push(wp.trim());
  }
  if (destination) raw.push(destination);

  if (!raw.length) return null;

  const waypoints = raw.map((entry, index) => {
    const coords = looksLikeCoordinates(entry);
    return {
      name: coords ? null : cleanName(entry),
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      source: coords ? 'query-coords' : 'query-name',
      index,
    };
  });

  let travelMode = null;
  const tm = get('travelmode') || get('dirflg') || get('dir') ;
  if (tm) {
    const key = tm.toLowerCase();
    travelMode = TRAVEL_MODES.includes(key) ? key : DIRFLG_MODE[tm] || DIRFLG_MODE[key] || null;
    if (!travelMode) warnings.push(`Unrecognised travel mode "${tm}" in the URL — assuming driving.`);
  }

  const isPlaceOnly = !origin && !get('saddr') && waypoints.length === 1;
  return { waypoints, travelMode, travelModeSource: travelMode ? 'query' : null, kind: isPlaceOnly ? 'place' : 'directions' };
}

/** Waypoints carried in the path: /maps/dir/A/B/C */
function fromPath(segments, warnings) {
  const raw = [];
  for (const seg of segments) {
    if (isTerminalSegment(seg)) break;
    if (seg.startsWith('@')) break;
    if (seg === '') {
      raw.push('');
      continue;
    }
    raw.push(seg);
  }
  if (!raw.length) return null;

  const waypoints = raw.map((entry, index) => {
    if (entry.trim() === '') {
      warnings.push(`Leg ${index + 1} was "your location" — the URL carries no coordinates for it. Enter them manually or geocode a place name.`);
      return { name: 'Your location', lat: null, lng: null, source: 'unknown', index };
    }
    const coords = looksLikeCoordinates(entry);
    if (coords) return { name: null, lat: coords.lat, lng: coords.lng, source: 'path-coords', index };
    return { name: cleanName(entry), lat: null, lng: null, source: 'path-name', index };
  });
  return { waypoints, kind: waypoints.length > 1 ? 'directions' : 'place' };
}

/**
 * Main entry point.
 * @param {string} input raw pasted text or URL
 * @returns parsed result object (never throws)
 */
export function parseDirectionsUrl(input) {
  const warnings = [];
  const errors = [];
  // People paste chat messages and emails, not just bare URLs — hunt for a link in the text.
  const url = normalizeUrlString(input) || extractUrls(input ?? '')[0] || null;

  const result = {
    ok: false,
    input: typeof input === 'string' ? input.trim() : '',
    url: url || null,
    kind: 'unknown',
    waypoints: [],
    travelMode: null,
    travelModeSource: null,
    viewport: null,
    needsGeocode: false,
    needsResolution: false,
    warnings,
    errors,
  };

  if (!url) {
    errors.push('That does not look like a link. Paste a full Google Maps directions URL.');
    return result;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    errors.push('The link could not be parsed as a URL.');
    return result;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (SHORT_HOSTS.has(host)) {
    result.needsResolution = true;
    result.kind = 'shortlink';
    return result;
  }

  // ---- path -------------------------------------------------------------
  // Keep interior empty segments: `/maps/dir//Destination` means "start at your location",
  // which is information the user needs to be told about, not something to silently drop.
  const segments = parsed.pathname.split('/');
  if (segments[0] === '') segments.shift();
  while (segments.length && segments[segments.length - 1] === '') segments.pop();
  const dirIndex = segments.findIndex((s) => /^dir$/i.test(s));
  const uiSegments = segments.filter((s) => !/^u\/\d+$/i.test(s));

  let viewport = null;
  for (const seg of segments) {
    if (seg.startsWith('@')) {
      const vp = parseViewport(seg);
      if (vp && !viewport) viewport = vp;
    }
  }
  result.viewport = viewport;

  let fromUrl = null;
  const isGoogleMaps = /(^|\.)google\.[a-z.]{2,}$|maps\.google/i.test(host);
  if (!isGoogleMaps) {
    errors.push(
      `"${host}" is not a Google Maps link. Paste a link from Google Maps (it starts with https://www.google.com/maps/dir/ or https://maps.app.goo.gl/).`,
    );
    return result;
  }

  // Query params win when present: they are what Google's own share dialog writes.
  fromUrl = fromQuery(parsed.searchParams, warnings);

  if (!fromUrl && dirIndex !== -1) {
    fromUrl = fromPath(segments.slice(dirIndex + 1), warnings);
  }
  if (!fromUrl) {
    // Fall back to /maps/place/ or /maps/search/ — a single point is still convertible.
    const placeIndex = uiSegments.findIndex((s) => /^(place|search|q)$/i.test(s));
    if (placeIndex !== -1) {
      fromUrl = fromPath(uiSegments.slice(placeIndex + 1), warnings);
      if (fromUrl) {
        fromUrl.kind = 'place';
        warnings.push('This looks like a single place rather than a route, so the GPX will contain one waypoint and no track.');
      }
    }
  }

  if (!fromUrl) {
    errors.push('No origin or destination found in that link. Google share links usually contain "/dir/" or an "origin"/"destination" parameter.');
    return result;
  }

  // ---- data= block: exact coordinates + travel mode --------------------
  const dataPoints = parseDataBlocks(parsed.pathname + parsed.search);
  const dataMode = parseDataTravelMode(parsed.search + parsed.pathname);

  const namedSlots = fromUrl.waypoints;
  if (dataPoints.length) {
    if (dataPoints.length === namedSlots.length) {
      dataPoints.forEach((dp, i) => {
        namedSlots[i].lat = dp.lat;
        namedSlots[i].lng = dp.lng;
        if (dp.placeId) namedSlots[i].placeId = dp.placeId;
        namedSlots[i].source = namedSlots[i].name ? 'path-name+data-coords' : namedSlots[i].source;
        namedSlots[i].precision = 'exact';
      });
    } else if (dataPoints.length === 1 && namedSlots.length >= 1) {
      const target = namedSlots[namedSlots.length - 1];
      if (target.lat == null) {
        target.lat = dataPoints[0].lat;
        target.lng = dataPoints[0].lng;
        target.precision = 'exact';
        target.source = `${target.source}+data-coords`;
      }
    } else {
      warnings.push(
        `The link lists ${namedSlots.length} stops but ${dataPoints.length} embedded coordinates, so they could not be matched up. Unmatched stops will be geocoded.`,
      );
      dataPoints.slice(0, namedSlots.length).forEach((dp, i) => {
        if (namedSlots[i].lat == null) {
          namedSlots[i].lat = dp.lat;
          namedSlots[i].lng = dp.lng;
          namedSlots[i].precision = 'exact';
        }
      });
    }
  }

  if (fromUrl.travelMode) {
    result.travelMode = fromUrl.travelMode;
    result.travelModeSource = fromUrl.travelModeSource;
  } else if (dataMode.mode) {
    result.travelMode = dataMode.mode;
    result.travelModeSource = 'data block (inferred)';
    if (dataMode.mixed) {
      warnings.push('The link mixes travel modes across legs; the first one is used.');
    }
  }

  result.kind = fromUrl.kind || 'directions';
  result.waypoints = namedSlots.map((wp, i) => ({
    ...wp,
    index: i,
    role: result.kind === 'place' ? 'place' : i === 0 ? 'start' : i === namedSlots.length - 1 ? 'end' : 'waypoint',
  }));

  // ---- final checks -----------------------------------------------------
  for (const wp of result.waypoints) {
    const hasCoords = wp.lat != null && wp.lng != null;
    if (!hasCoords && !wp.name) {
      errors.push(`Stop ${wp.index + 1} has neither coordinates nor a place name.`);
    }
    if (hasCoords && wp.name) wp.precision = wp.precision || 'exact';
    if (hasCoords) wp.precision = wp.precision || 'from-url';
  }

  result.needsGeocode = result.waypoints.some((wp) => wp.lat == null && wp.name);

  if (result.kind === 'directions' && result.waypoints.length < 2) {
    warnings.push('Only one stop was found. Add a second one to generate a route.');
  }

  result.ok = result.errors.length === 0 && result.waypoints.length > 0 && !result.needsResolution;
  return result;
}

/** True when every stop is geocoded, i.e. the route can be sent to a router as-is. */
export function hasFullCoordinates(parsed) {
  return parsed.waypoints.length > 0 && parsed.waypoints.every((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lng));
}

/** Human label for a stop's coordinate provenance, shown in the UI. */
export function describeSource(wp) {
  if (wp.lat != null && wp.precision === 'exact') return 'exact (from link)';
  if (wp.lat != null && String(wp.source).includes('geocod')) return 'geocoded';
  if (wp.lat != null) return 'from link';
  if (wp.name) return 'needs geocoding';
  return 'unknown';
}

export const TEST_ONLY = { looksLikeCoordinates, cleanName, parseDataTravelMode };
