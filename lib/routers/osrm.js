/**
 * routers/osrm.js — road-accurate geometry from OpenStreetMap-based OSRM servers.
 *
 * Endpoint choice matters: the public router.project-osrm.org demo serves a *car* graph for
 * every profile name it is given, so asking it for "foot" silently returns driving geometry.
 * Walking and cycling therefore only ever go to the FOSSGIS servers, which host real
 * pedestrian and bicycle graphs. If they are unreachable we fail loudly and let the caller
 * fall back to straight lines with a warning, rather than lying about the route.
 */

export const OSRM_ENDPOINTS = {
  driving: [
    { url: 'https://router.project-osrm.org/route/v1/driving', label: 'OSRM demo (car)' },
    { url: 'https://routing.openstreetmap.de/routed-car/route/v1/driving', label: 'FOSSGIS (car)' },
  ],
  cycling: [{ url: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike', label: 'FOSSGIS (bicycle)' }],
  walking: [{ url: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot', label: 'FOSSGIS (pedestrian)' }],
  transit: [],
};

const MAX_WAYPOINTS = 20;

export class OsrmError extends Error {
  constructor(message, { code, endpoint, status, retryable = false } = {}) {
    super(message);
    this.name = 'OsrmError';
    this.code = code || 'unknown';
    this.endpoint = endpoint;
    this.status = status;
    this.retryable = retryable;
  }
}

function buildUrl(endpoint, waypoints, params) {
  const coords = waypoints.map((wp) => `${wp.lng.toFixed(6)},${wp.lat.toFixed(6)}`).join(';');
  const qs = new URLSearchParams({ overview: 'full', geometries: 'geojson', alternatives: 'false', ...params });
  return `${endpoint.url}/${coords}?${qs}`;
}

function mapOsrmFailure(body, endpoint) {
  const code = body?.code;
  // "Ok" with no routes is a real OSRM answer (e.g. everything filtered out) and would
  // otherwise read as a success.
  if (code === 'Ok') {
    return new OsrmError(`${endpoint.label} reported success but returned no routes.`, { code: 'EmptyResult', endpoint: endpoint.label, retryable: true });
  }
  const hints = {
    NoRoute: 'No route exists between those points on the road network (they may be islands, or separated by water).',
    InvalidInput: 'The routing server rejected the coordinates.',
    NoTile: 'The routing server has no map data for that area.',
    QueryTooLarge: 'Too many waypoints for one request.',
  };
  return new OsrmError(hints[code] || `Routing server returned "${code || 'an unknown error'}".`, {
    code,
    endpoint: endpoint.label,
    retryable: false,
  });
}

/**
 * @param {Array<{lat:number,lng:number}>} waypoints at least two
 * @param {'driving'|'cycling'|'walking'|'transit'} mode
 * @param {object} [options] { fetchImpl, signal, timeoutMs, params, endpointOverride }
 */
export async function routeOsrm(waypoints, mode, options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 20000, params = {}, endpointOverride } = options;
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new OsrmError('At least two points are needed to route.', { code: 'InvalidInput' });
  }
  if (waypoints.some((wp) => !Number.isFinite(wp.lat) || !Number.isFinite(wp.lng))) {
    throw new OsrmError('Every stop needs coordinates before routing.', { code: 'InvalidInput' });
  }
  if (mode === 'transit') {
    throw new OsrmError('OpenStreetMap routers do not compute public-transport routes.', { code: 'UnsupportedMode' });
  }

  const endpoints = endpointOverride
    ? [{ url: endpointOverride.replace(/\/$/, ''), label: `custom (${endpointOverride})` }]
    : OSRM_ENDPOINTS[mode] || [];
  if (!endpoints.length) {
    throw new OsrmError(`No routing server configured for ${mode}.`, { code: 'UnsupportedMode' });
  }

  const coords = waypoints.slice(0, MAX_WAYPOINTS);
  if (waypoints.length > MAX_WAYPOINTS) {
    // OSRM's public instances reject long requests; split into chains and stitch them.
    return routeOsrmInChunks(waypoints, mode, options);
  }

  let lastError;
  for (const endpoint of endpoints) {
    // Never send a request the caller has already given up on — not even to the next server.
    if (options.signal?.aborted) {
      lastError = new OsrmError('Routing was cancelled.', { code: 'Cancelled', endpoint: endpoint.label, retryable: false });
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    // An abort listener never fires for a signal that is already aborted, so check it directly.
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort);
    try {
      const response = await fetchImpl(buildUrl(endpoint, coords, params), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        referrerPolicy: 'unsafe-url',
      });
      let body;
      const text = await response.text();
      try {
        body = JSON.parse(text);
      } catch {
        throw new OsrmError(`${endpoint.label} replied with something that is not JSON.`, {
          code: 'BadResponse',
          endpoint: endpoint.label,
          status: response.status,
          retryable: true,
        });
      }
      if (body.code !== 'Ok' || !body.routes?.length) {
        // A JSON body with a code is an OSRM-level answer; anything else is a transport failure.
        if (body?.code) throw mapOsrmFailure(body, endpoint);
        throw new OsrmError(`${endpoint.label} replied HTTP ${response.status}.`, {
          code: `HTTP ${response.status}`,
          endpoint: endpoint.label,
          status: response.status,
          retryable: response.status >= 500,
        });
      }

      const route = body.routes[0];
      const geometry = route.geometry?.coordinates;
      if (!Array.isArray(geometry) || geometry.length === 0) {
        throw new OsrmError('The routing server returned an empty geometry.', { code: 'EmptyGeometry', endpoint: endpoint.label });
      }
      return {
        provider: 'osrm',
        providerLabel: endpoint.label,
        endpoint: endpoint.url,
        mode,
        points: geometry.map(([lng, lat]) => ({ lat, lng })),
        distance: route.distance,
        duration: route.duration,
        legs: (body.routes[0].legs || []).map((leg) => ({ distance: leg.distance, duration: leg.duration, summary: leg.summary || '' })),
        warnings: waypoints.length > coords.length ? [`Only the first ${MAX_WAYPOINTS} stops were routed.`] : [],
      };
    } catch (error) {
      if (error instanceof OsrmError) {
        lastError = error;
        if (!error.retryable && error.code !== 'HTTP 503' && error.code !== 'HTTP 502') continue;
        continue;
      }
      const cancelled = Boolean(options.signal?.aborted);
      const timedOut = !cancelled && error?.name === 'AbortError';
      lastError = new OsrmError(
        cancelled
          ? 'Routing was cancelled.'
          : timedOut
            ? `${endpoint.label} timed out after ${timeoutMs / 1000}s.`
            : `${endpoint.label} could not be reached (${error.message}).`,
        {
          code: cancelled ? 'Cancelled' : timedOut ? 'Timeout' : 'Network',
          endpoint: endpoint.label,
          retryable: !cancelled,
        },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError || new OsrmError('Routing failed.', { code: 'unknown' });
}

async function routeOsrmInChunks(waypoints, mode, options) {
  const all = [];
  let distance = 0;
  let duration = 0;
  let providerLabel;
  for (let start = 0; start + 1 < waypoints.length; start += MAX_WAYPOINTS - 1) {
    const end = Math.min(start + MAX_WAYPOINTS, waypoints.length);
    const part = await routeOsrm(waypoints.slice(start, end), mode, options);
    if (all.length) part.points.shift(); // avoid duplicating the join point
    all.push(...part.points);
    distance += part.distance;
    duration += part.duration;
    providerLabel = part.providerLabel;
  }
  return {
    provider: 'osrm',
    providerLabel,
    mode,
    points: all,
    distance,
    duration,
    legs: [],
    warnings: [`Route split into segments of ${MAX_WAYPOINTS} stops each. Leg summaries are unavailable.`],
  };
}
