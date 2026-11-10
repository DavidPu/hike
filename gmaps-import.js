/**
 * gmaps-import.js — the bridge between a pasted Google Maps directions link and the Route Planner.
 *
 * This is the only file that is allowed to know about both `lib/` (imported from gmaps2gpx, see
 * lib/PROVENANCE.md) and `app.js`. `app.js` is a classic script and cannot `import`, so the
 * modules are loaded here and handed over on `globalThis.gmapsImport`; if this file ever fails to
 * load, RoutePlanner notices the missing global and behaves exactly as it did before this feature
 * existed.
 *
 * It does two jobs and nothing else:
 *   importGoogleMapsLink()  link → geocoded waypoints + a travel mode   (no routing)
 *   routeWaypoints()        waypoints + mode → road geometry, no API key needed
 * Routing stays inside RoutePlanner._reroute() so that a route drawn from a pasted link and a
 * route drawn from map clicks are produced by the same code and cannot drift apart.
 */

import { parseDirectionsUrl, isShortLink } from './lib/parser.js';
import { resolveShortLink } from './lib/shortlink.js';
import { geocodeWaypoints } from './lib/geocode.js';
import { routeOsrm, OsrmError } from './lib/routers/osrm.js';
import { routeStraight } from './lib/routers/straight.js';
import { addElevation } from './lib/elevation.js';

/** An error the route panel can show to the user as-is. */
export class ImportError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ImportError';
    this.hint = hint || null;
  }
}

/**
 * This app's routing profiles are ORS profile names; the imported routers speak gmaps2gpx modes.
 * Hiking has no OSRM pedestrian sub-profile, so foot-hiking routes on the pedestrian graph and
 * keeps its own name in the UI.
 */
export const PROFILE_FOR_MODE = {
  driving: 'driving-car',
  cycling: 'cycling-regular',
  walking: 'foot-walking',
  transit: 'foot-walking',
};

export const MODE_FOR_PROFILE = {
  'driving-car': 'driving',
  'cycling-regular': 'cycling',
  'foot-walking': 'walking',
  'foot-hiking': 'walking',
};

/**
 * Which entry the Route Planner's dropdown should show for a parsed travel mode. Transit has no
 * OSRM router and no ORS profile, so it lands on walking rather than quietly driving somewhere.
 */
export function profileForMode(mode) {
  return PROFILE_FOR_MODE[mode] || 'driving-car';
}

/** The mode to route a dropdown selection with — the inverse of profileForMode(). */
export function modeForProfile(profile) {
  return MODE_FOR_PROFILE[profile] || 'driving';
}

/**
 * Parse a Google Maps directions link into waypoints ready to drop on the map.
 *
 * Never routes anything. Resolves short links, parses, then geocodes whatever names came without
 * coordinates — that last step is the slow one (Nominatim asks for 1 request/second), so the
 * caller shows progress and passes an AbortSignal.
 *
 * @returns {Promise<{url:string,title:string,mode:string,profile:string,waypoints:Array,
 *                    via:string,warnings:string[]}>}
 */
export async function importGoogleMapsLink(text, options = {}) {
  const { signal, fetchImpl = globalThis.fetch } = options;
  const raw = String(text ?? '').trim();
  if (!raw) throw new ImportError('Paste a Google Maps directions link first.');

  if (!/maps\.google\.|google\.[a-z.]{2,}\/maps|maps\.app\.goo\.gl/i.test(raw)) {
    throw new ImportError(
      'That does not look like a Google Maps link.',
      'Share from Google Maps, or paste the address-bar URL — it starts with https://www.google.com/maps/dir/.',
    );
  }

  const warnings = [];

  // A `maps.app.goo.gl` short link has to be expanded before it can be parsed: a browser cannot
  // read the Location header of a cross-origin 302, so this goes through a public reader unless
  // a helper endpoint is configured.
  let url = raw;
  let via = 'pasted URL';
  if (isShortLink(raw)) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    let resolved;
    try {
      resolved = await resolveShortLink(raw, {
        fetchImpl,
        // No same-origin helper on a static host: an empty string means "do not try one", which
        // is different from null, and the difference is a request that 404s on every import.
        proxyUrl: '',
        apiBase: options.apiBase || '',
      });
    } catch (error) {
      throw new ImportError(error.message, error.hint);
    }
    url = resolved.url;
    via = resolved.via;
    warnings.push(`Expanded the short link via ${resolved.via}.`);
  }

  const parsed = parseDirectionsUrl(url);
  if (parsed.errors?.length) throw new ImportError(parsed.errors[0], parsed.hint);
  if (parsed.warnings?.length) warnings.push(...parsed.warnings);

  let waypoints = parsed.waypoints || [];
  if (parsed.needsGeocode) {
    options.onProgress?.('Looking up place names…');
    const geocoded = await geocodeWaypoints(waypoints, {
      viewport: parsed.viewport,
      signal,
      fetchImpl,
      proxyUrl: '',
    });
    waypoints = geocoded.waypoints;
    warnings.push(...geocoded.warnings);
  }

  // gmaps2gpx uses `lng`, this app uses `lon` everywhere (markers, stats, GPX). Convert at the
  // border rather than letting both spellings leak into app.js, where one of them would
  // silently become undefined and put a marker in the ocean off Africa.
  const usable = waypoints
    .filter((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lng))
    .map((wp) => ({
      lat: wp.lat,
      lon: wp.lng,
      name: wp.name || '',
      precision: wp.precision || 'from-url',
      role: wp.role || 'waypoint',
    }));

  const dropped = waypoints.length - usable.length;
  if (dropped > 0) {
    warnings.push(`${dropped} stop${dropped > 1 ? 's were' : ' was'} skipped — no coordinates and no name that OpenStreetMap could find.`);
  }
  if (usable.length < 2) {
    throw new ImportError(
      'No route in that link: fewer than two stops have coordinates.',
      'Open the link in a browser and copy the full address-bar URL, or add the missing stops by clicking the map.',
    );
  }

  const mode = parsed.travelMode || 'driving';
  const named = usable.filter((wp) => wp.name);
  const title = named.length >= 2
    ? `${named[0].name} → ${named[named.length - 1].name}`
    : 'Route from Google Maps';

  return {
    url,
    title,
    mode,
    profile: PROFILE_FOR_MODE[mode] || 'driving-car',
    waypoints: usable,
    via,
    warnings,
  };
}

/**
 * Road geometry for a list of waypoints without an API key: public OSRM routers first, then
 * great-circle lines that say so. Returns this app's point shape so the caller can hand it
 * straight to ElevationProfile, StatsCalculator and GPXExporter.
 *
 * @param {Array<{lat:number,lon:number}>} waypoints
 * @param {'driving'|'cycling'|'walking'|'transit'} mode
 * @param {{heights?:boolean,signal?:AbortSignal,fetchImpl?:Function,endpointOverride?:string}} [options]
 */
export async function routeWaypoints(waypoints, mode, options = {}) {
  const { heights = false, signal, fetchImpl = globalThis.fetch, endpointOverride } = options;
  const points = (waypoints || [])
    .filter((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lon))
    .map((wp) => ({ lat: wp.lat, lng: wp.lon }));
  if (points.length < 2) throw new ImportError('At least two waypoints are needed.', null);

  const warnings = [];
  let route;
  let approximate = false;

  try {
    route = await routeOsrm(points, mode, { signal, fetchImpl, endpointOverride });
  } catch (error) {
    if (signal?.aborted) throw error;
    // Transit has no OSM router, and a public router can be down or refuse the request. Both
    // are survivable: straight lines are better than nothing as long as they are labelled.
    approximate = true;
    warnings.push(
      error instanceof OsrmError
        ? `OpenStreetMap routing unavailable (${error.message}) — showing straight lines between stops.`
        : 'OpenStreetMap routing failed — showing straight lines between stops.',
    );
    route = await routeStraight(points, mode);
  }

  let shaped = route.points.map((p) => ({ lat: p.lat, lon: p.lng, ele: null, time: null }));

  if (heights && shaped.length >= 2) {
    options.onProgress?.('Looking up heights…');
    // Best-effort by design: a DEM outage must not cost the user the route they can already see.
    const elevated = await addElevation(
      shaped.map((p) => ({ lat: p.lat, lng: p.lon })),
      { provider: 'auto', signal, fetchImpl, proxyUrl: '' },
    );
    if (elevated?.points?.length) {
      shaped = elevated.points.map((p) => ({ lat: p.lat, lon: p.lng, ele: p.ele ?? null, time: null }));
      if (elevated.warning) warnings.push(`Heights unavailable: ${elevated.warning}`);
    } else {
      warnings.push('Heights unavailable from the terrain service.');
    }
  }

  return {
    points: shaped,
    distance: route.distance,
    duration: route.duration,
    provider: approximate ? 'straight' : route.provider,
    providerLabel: approximate ? 'straight lines (no road data)' : route.providerLabel,
    approximate: approximate || Boolean(route.approximate),
    durationEstimated: Boolean(route.durationEstimated),
    mode,
    warnings,
  };
}

// The handover to the classic script. Also useful from the browser console when debugging a link.
globalThis.gmapsImport = {
  importGoogleMapsLink,
  routeWaypoints,
  profileForMode,
  modeForProfile,
  isShortLink,
  PROFILE_FOR_MODE,
  MODE_FOR_PROFILE,
  ImportError,
};
