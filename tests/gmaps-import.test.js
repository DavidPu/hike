/**
 * gmaps-import.test.js — the bridge between a pasted Google Maps link and the Route Planner.
 *
 * The modules under lib/ carry their own tests. What is tested here is only the glue, which is
 * where the two codebases meet and therefore where they can disagree without anything throwing:
 * gmaps2gpx writes coordinates as {lat, lng} and this app reads {lat, lon}, the Route Planner's
 * dropdown speaks ORS profile names while the routers speak travel modes, and a routing server
 * that is down must produce a labelled straight line rather than an empty map.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importGoogleMapsLink, routeWaypoints, profileForMode, modeForProfile } from '../gmaps-import.js';
import { resetThrottleForTests } from '../lib/geocode.js';

/** Two stops with exact coordinates baked into the URL — no network needed to locate them. */
const FULL_LINK = 'https://www.google.com/maps/dir/Black+Mountain+Backpack+Camp,+Montebello+Rd,+Los+Altos,+CA+94022/'
  + 'Los+Gatos+Library,+219+E+Main+St,+Los+Gatos,+CA+95030/@37.2446911,-122.1129273,20047m/am=t/data=!3m1!1e3!4m14!4m13'
  + '!1m5!1m1!1s0x808fb1f56dd4b3ff:0xb38f6c4f64242502!2m2!1d-122.1540561!2d37.3185923'
  + '!1m5!1m1!1s0x808e343394a0fcb1:0xf50ac3c8e44a0fe1!2m2!1d-121.9431403!2d37.2405404!3e2';

/** Names only, `?api=1` share form: every stop has to be geocoded before it can be routed. */
const NAMED_LINK = 'https://www.google.com/maps/dir/?api=1&origin=Piedmont+Park,+Oakland'
  + '&destination=Lake+Merritt,+Oakland&travelmode=walking';

/** Same thing in the path form, which is the one that carries the map region (`@lat,lng,zoom`). */
const NAMED_LINK_WITH_VIEWPORT = 'https://www.google.com/maps/dir/'
  + 'Black+Mountain+Backpack+Camp,+Montebello+Rd,+Los+Altos,+CA+94022/'
  + 'Los+Gatos+Library,+219+E+Main+St,+Los+Gatos,+CA+95030/@37.2446911,-122.1129273,20047m/am=t';

const SHORT_LINK = 'https://maps.app.goo.gl/b6gTmohyKRhPR77X7';

function stubFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const [pattern, reply] of handlers) {
      if (!pattern.test(url)) continue;
      const r = typeof reply === 'function' ? reply(url, calls.length - 1) : reply;
      if (r instanceof Error) throw r;
      if (r.abort) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const osrmOk = (n = 4) => ({
  body: {
    code: 'Ok',
    routes: [{
      distance: 32066.1,
      duration: 26013.7,
      geometry: { coordinates: Array.from({ length: n }, (_, i) => [-122.15 + i * 0.01, 37.31 - i * 0.01]) },
      legs: [{ distance: 16000, duration: 13000, summary: 'Cañada Road' }],
    }],
  },
});

const nominatimHit = (lat, lon) => [{ lat: String(lat), lon: String(lon), display_name: 'Somewhere, California', rank_field: 30 }];

/** Open-Meteo answers one elevation per coordinate it was sent. */
const openMeteoOk = (value = 120) => (url) => {
  const count = (new URL(url).searchParams.get('latitude') || '').split(',').length;
  return { body: { elevation: Array.from({ length: count }, (_, i) => value + i) } };
};

const WP = [
  { lat: 37.3185923, lon: -122.1540561 },
  { lat: 37.2405404, lon: -121.9431403 },
];

// ---------------------------------------------------------- importing ----

test('import: a directions link yields waypoints in this app\'s {lat, lon} shape', async () => {
  const result = await importGoogleMapsLink(FULL_LINK, { fetchImpl: stubFetch([]) });

  assert.equal(result.waypoints.length, 2);
  for (const wp of result.waypoints) {
    assert.ok(Number.isFinite(wp.lat) && Number.isFinite(wp.lon), `bad coordinates: ${JSON.stringify(wp)}`);
    // The imported library calls the longitude `lng`. If that spelling ever leaks into app.js,
    // `lon` becomes undefined and a marker lands in the ocean — so assert it cannot.
    assert.equal('lng' in wp, false, 'waypoints must not carry the lng spelling');
  }
  assert.match(result.title, /Black Mountain/);
  assert.match(result.title, /Library/);
});

test('import: the travel mode in the link selects the matching routing profile', async () => {
  const walking = await importGoogleMapsLink(FULL_LINK, { fetchImpl: stubFetch([]) });
  assert.equal(walking.mode, 'walking');
  assert.equal(walking.profile, 'foot-walking');

  const cycling = await importGoogleMapsLink(
    'https://www.google.com/maps/dir/?api=1&origin=37.8044,-122.2712&destination=37.7955,-122.2675&travelmode=cycling',
    { fetchImpl: stubFetch([]) },
  );
  assert.equal(cycling.profile, 'cycling-regular');
});

test('import: transit has no router here and must fall to walking, not driving', async () => {
  assert.equal(profileForMode('transit'), 'foot-walking');
  assert.equal(profileForMode('nonsense'), 'driving-car');
});

test('import: the profile map cannot drift from the dropdown in index.html', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const options = [...html.matchAll(/<select id="route-profile">([\s\S]*?)<\/select>/g)][0][1];
  const values = [...options.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 4, 'expected the profile dropdown to still have its four entries');

  // Every dropdown entry must be routable, and every mode the parser can produce must name an
  // entry that actually exists — otherwise the select silently shows nothing after an import.
  for (const value of values) {
    assert.ok(['driving', 'cycling', 'walking', 'transit'].includes(modeForProfile(value)), `${value} maps to no known mode`);
  }
  for (const mode of ['driving', 'cycling', 'walking', 'transit']) {
    assert.ok(values.includes(profileForMode(mode)), `${mode} selects ${profileForMode(mode)}, which is not in the dropdown`);
  }
});

test('import: anything that is not a Google Maps link is refused with advice', async () => {
  const fetchImpl = stubFetch([]);
  await assert.rejects(() => importGoogleMapsLink('https://example.com/routes', { fetchImpl }), /Google Maps/);
  await assert.rejects(() => importGoogleMapsLink('   ', { fetchImpl }), /Paste/);
  assert.equal(fetchImpl.calls.length, 0, 'must reject locally, without a network call');
});

test('import: named stops are geocoded, and the link viewport biases the search', async () => {
  resetThrottleForTests();
  const fetchImpl = stubFetch([[/nominatim|openstreetmap\.org/, () => ({ body: nominatimHit(37.2405, -121.9431) })]]);

  const result = await importGoogleMapsLink(NAMED_LINK_WITH_VIEWPORT, { fetchImpl });

  assert.equal(result.waypoints.length, 2);
  assert.ok(result.waypoints.every((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lon)));
  const urls = fetchImpl.calls.map((c) => c.url).join('\n');
  assert.match(urls, /nominatim|openstreetmap\.org/, 'should have asked Nominatim');
  assert.match(urls, /viewbox=/, 'the link viewport should bias the lookup');
});

test('import: stops that cannot be located are reported, not silently dropped', async () => {
  resetThrottleForTests();
  const fetchImpl = stubFetch([[/nominatim|openstreetmap\.org/, { body: [] }]]);

  await assert.rejects(
    () => importGoogleMapsLink(NAMED_LINK, { fetchImpl }),
    /fewer than two stops/i,
  );
});

test('import: a short link is expanded before it can be parsed', async () => {
  const reader = `Final URL: ${FULL_LINK}\nTitle: Google Maps\n`;
  const fetchImpl = stubFetch([[/r\.jina\.ai/, { body: reader }]]);

  const result = await importGoogleMapsLink(SHORT_LINK, { fetchImpl });

  assert.equal(result.waypoints.length, 2);
  assert.match(result.via, /jina/, 'should say which reader expanded it');
  assert.ok(fetchImpl.calls.some((c) => /r\.jina\.ai/.test(c.url)));
});

test('import: a short link no reader can expand comes back with the manual escape hatch', async () => {
  const fetchImpl = stubFetch([[/r\.jina\.ai/, { status: 429, body: 'rate limited' }]]);

  await assert.rejects(
    () => importGoogleMapsLink(SHORT_LINK, { fetchImpl }),
    (error) => {
      assert.match(error.message, /Could not expand/);
      assert.match(error.hint, /address-bar/, 'must tell the user what to do instead');
      return true;
    },
  );
});

test('import: an aborted import stops without reporting an error to the caller', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => importGoogleMapsLink(SHORT_LINK, { fetchImpl: stubFetch([[/r\.jina\.ai/, { body: 'x' }]]), signal: controller.signal }),
    (error) => error.name === 'AbortError' || /Cancel/i.test(error.message),
  );
});

// ----------------------------------------------------------- routing ----

test('route: OSRM geometry arrives as {lat, lon} with a named provider', async () => {
  const fetchImpl = stubFetch([[/route\/v1/, osrmOk()]]);
  const result = await routeWaypoints(WP, 'driving', { fetchImpl, heights: false });

  assert.equal(result.approximate, false);
  assert.equal(result.provider, 'osrm');
  assert.ok(result.providerLabel.length > 0);
  assert.equal(result.points.length, 4);
  for (const p of result.points) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `bad point: ${JSON.stringify(p)}`);
    assert.equal(p.ele, null, 'OSRM sends no heights; nothing may invent them here');
  }
  assert.equal(result.distance, 32066.1);
  assert.equal(result.duration, 26013.7);
  assert.equal(result.durationEstimated, false);
});

test('route: a router that cannot answer degrades to straight lines and says so', async () => {
  const fetchImpl = stubFetch([[/route\/v1/, { body: { code: 'NoRoute' } }]]);
  const result = await routeWaypoints(WP, 'walking', { fetchImpl, heights: false });

  assert.equal(result.approximate, true);
  assert.match(result.provider, /straight/);
  assert.equal(result.durationEstimated, true, 'an average-speed duration must be flagged');
  assert.ok(result.warnings.some((w) => /straight lines/i.test(w)), 'the user must be told why');
  assert.ok(result.points.length > 2, 'straight lines are densified so the profile has something to draw');
});

test('route: transit never comes back as a car route', async () => {
  const fetchImpl = stubFetch([]);
  const result = await routeWaypoints(WP, 'transit', { fetchImpl, heights: false });

  assert.equal(result.approximate, true);
  assert.equal(fetchImpl.calls.length, 0, 'no OSM server serves transit, so none should be asked');
});

test('route: every public server failing still produces a route', async () => {
  const fetchImpl = stubFetch([[/routing\.openstreetmap\.de|project-osrm/, new Error('connection refused')]]);
  const result = await routeWaypoints(WP, 'cycling', { fetchImpl, heights: false });

  assert.equal(result.approximate, true);
  assert.ok(result.distance > 0);
});

test('route: heights come from the terrain service when asked for', async () => {
  const fetchImpl = stubFetch([[/open-meteo\.com/, openMeteoOk(200)]]);
  const result = await routeWaypoints(WP, 'driving', { fetchImpl, heights: true });

  const withHeight = result.points.filter((p) => Number.isFinite(p.ele));
  assert.ok(withHeight.length >= 2, `expected heights, got ${JSON.stringify(result.points.slice(0, 3))}`);
  assert.ok(fetchImpl.calls.some((c) => /open-meteo\.com/.test(c.url)));
});

test('route: a terrain outage costs the heights, never the route', async () => {
  const fetchImpl = stubFetch([
    [/route\/v1/, osrmOk()],
    [/open-meteo\.com/, { status: 503, body: 'down' }],
    [/opentopodata/, { status: 503, body: 'down' }],
  ]);
  const result = await routeWaypoints(WP, 'driving', { fetchImpl, heights: true });

  assert.equal(result.points.length, 4, 'the route the user can already see must survive');
  assert.ok(result.points.every((p) => p.ele === null || p.ele === undefined));
  assert.ok(result.warnings.some((w) => /height/i.test(w)), 'and the missing heights must be admitted');
});

test('route: fewer than two usable waypoints is refused before any request', async () => {
  const fetchImpl = stubFetch([]);
  await assert.rejects(() => routeWaypoints([WP[0]], 'driving', { fetchImpl }), /two waypoints/i);
  await assert.rejects(() => routeWaypoints([{ lat: NaN, lon: 0 }, WP[1]], 'driving', { fetchImpl }), /two waypoints/i);
  assert.equal(fetchImpl.calls.length, 0);
});
