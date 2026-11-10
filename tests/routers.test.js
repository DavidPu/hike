import test from 'node:test';
import assert from 'node:assert/strict';
import { routeOsrm, OsrmError } from '../lib/routers/osrm.js';
import { routeStraight } from '../lib/routers/straight.js';
import { resolveShortLink, extractFinalUrl } from '../lib/shortlink.js';
import { geocodeQuery, resetThrottleForTests } from '../lib/geocode.js';

const START = { lat: 37.3185923, lng: -122.1540561 };
const MID = { lat: 37.28, lng: -122.05 };
const END = { lat: 37.2405404, lng: -121.9431403 };

/** Minimal fetch double: matches a regex against the URL and replies with a canned response. */
function stubFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const [pattern, reply] of handlers) {
      if (!pattern.test(url)) continue;
      const r = typeof reply === 'function' ? reply(url, calls.length - 1) : reply;
      if (r instanceof Error) throw r;
      if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
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
    routes: [
      {
        distance: 32066.1,
        duration: 26013.7,
        geometry: { coordinates: Array.from({ length: n }, (_, i) => [-122.15 + i * 0.01, 37.31 - i * 0.01]) },
        legs: [{ distance: 16000, duration: 13000, summary: 'Cañada Road' }],
      },
    ],
  },
});

// ---------------------------------------------------------------- osrm ----

test('osrm: driving uses the demo server with lng,lat coordinate order', async () => {
  const fetchImpl = stubFetch([[/project-osrm\.org/, osrmOk()]]);
  const result = await routeOsrm([START, END], 'driving', { fetchImpl });
  assert.equal(result.provider, 'osrm');
  assert.match(fetchImpl.calls[0].url, /router\.project-osrm\.org\/route\/v1\/driving\/-122\.154056,37\.318592;-121\.943140,37\.240540\?/);
  assert.match(fetchImpl.calls[0].url, /overview=full&geometries=geojson/);
  assert.equal(result.points.length, 4);
  assert.deepEqual(result.points[0], { lat: 37.31, lng: -122.15 }, 'GeoJSON [lng,lat] must become {lat,lng}');
  assert.equal(result.distance, 32066.1);
  assert.equal(result.legs[0].summary, 'Cañada Road');
});

test('osrm: walking and cycling must NOT use the car-only demo server', async () => {
  for (const [mode, expect] of [['walking', 'routed-foot'], ['cycling', 'routed-bike']]) {
    const fetchImpl = stubFetch([[/openstreetmap\.de/, osrmOk()]]);
    await routeOsrm([START, END], mode, { fetchImpl });
    assert.match(fetchImpl.calls[0].url, new RegExp(expect), `${mode} should use ${expect}`);
    assert.doesNotMatch(fetchImpl.calls[0].url, /project-osrm/, `${mode} on the car-only demo server would return driving geometry`);
  }
});

test('osrm: transit is refused rather than answered with a car route', async () => {
  await assert.rejects(() => routeOsrm([START, END], 'transit', { fetchImpl: stubFetch([]) }), (error) => {
    assert.ok(error instanceof OsrmError);
    assert.equal(error.code, 'UnsupportedMode');
    return true;
  });
});

test('osrm: NoRoute becomes a human explanation', async () => {
  const fetchImpl = stubFetch([[/.*/, { body: { code: 'NoRoute' } }]]);
  await assert.rejects(() => routeOsrm([START, END], 'driving', { fetchImpl }), /No route exists/);
});

test('osrm: a 5xx on the first server falls through to the next', async () => {
  const fetchImpl = stubFetch([
    [/project-osrm\.org/, { status: 502, body: '<html>bad gateway</html>' }],
    [/openstreetmap\.de/, osrmOk()],
  ]);
  const result = await routeOsrm([START, END], 'driving', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2, 'both servers were tried');
  assert.match(result.providerLabel, /FOSSGIS/);
});

test('osrm: garbage and empty geometries are reported, not swallowed', async () => {
  await assert.rejects(
    () => routeOsrm([START, END], 'driving', { fetchImpl: stubFetch([[/project-osrm/, { status: 200, body: 'not json' }], [/openstreetmap/, { status: 200, body: 'nope' }]]) }),
    /not JSON/,
  );
  await assert.rejects(
    () => routeOsrm([START, END], 'driving', { fetchImpl: stubFetch([[/project-osrm/, { body: { code: 'Ok', routes: [] } }], [/openstreetmap/, { body: { code: 'Ok', routes: [] } }]]) }),
    /reported success but returned no routes/,
  );
});

test('osrm: input validation happens before any request', async () => {
  const fetchImpl = stubFetch([]);
  await assert.rejects(() => routeOsrm([START], 'driving', { fetchImpl }), /At least two points/);
  await assert.rejects(() => routeOsrm([{ lat: NaN, lng: 0 }, END], 'driving', { fetchImpl }), /needs coordinates/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('osrm: a timeout surfaces as a timeout, not a mystery failure', async () => {
  const fetchImpl = stubFetch([[/project-osrm/, { abort: true }], [/openstreetmap/, { abort: true }]]);
  await assert.rejects(() => routeOsrm([START, END], 'driving', { fetchImpl, timeoutMs: 25 }), /timed out after 0\.025s/);
});

test('osrm: an external abort signal stops the request', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = stubFetch([[/project-osrm/, { abort: true }], [/openstreetmap/, { abort: true }]]);
  await assert.rejects(() => routeOsrm([START, END], 'driving', { fetchImpl, signal: controller.signal }), (error) => {
    assert.match(error.message, /cancelled/i);
    assert.equal(error.code, 'Cancelled');
    assert.equal(error.retryable, false, 'a cancelled request must not be retried');
    assert.equal(fetchImpl.calls.length, 0, 'the request must never be sent');
    return true;
  });
});

test('osrm: routes with many stops are chunked and stitched without duplicates', async () => {
  const stops = Array.from({ length: 25 }, (_, i) => ({ lat: 37 + i * 0.001, lng: -122 + i * 0.001 }));
  const fetchImpl = stubFetch([
    [/.*/, () => ({ body: { code: 'Ok', routes: [{ distance: 100, duration: 100, geometry: { coordinates: [[-122, 37], [-122.01, 37.01], [-122.02, 37.02]] }, legs: [] }] } })],
  ]);
  const result = await routeOsrm(stops, 'driving', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2, '25 stops need two requests');
  assert.equal(result.points[0].lat, 37);
  assert.ok(result.points.length < 6, 'the shared join point must not be duplicated');
  assert.ok(result.warnings.length > 0);
});

test('osrm: a custom endpoint overrides the public servers', async () => {
  const fetchImpl = stubFetch([[/localhost:5000/, osrmOk()]]);
  const result = await routeOsrm([START, END], 'walking', { fetchImpl, endpointOverride: 'http://localhost:5000/route/v1/foot/' });
  assert.match(fetchImpl.calls[0].url, /^http:\/\/localhost:5000\/route\/v1\/foot\/-122/);
  assert.match(result.providerLabel, /custom/);
});

// -------------------------------------------------------------- straight ----

test('straight: distance is great-circle and the duration is flagged as an estimate', async () => {
  const result = await routeStraight([START, END], 'walking');
  assert.equal(result.approximate, true);
  assert.equal(result.durationEstimated, true);
  assert.ok(Math.abs(result.distance - 20500) < 400, `expected ~20.5 km, got ${result.distance}`);
  assert.ok(result.points.length > 40, 'the line is densified so apps draw it correctly');
  assert.ok(result.warnings.some((w) => /straight-line/i.test(w)), 'the user must be warned');
});

// ------------------------------------------------------------- shortlink ----

const GMAPS = 'https://www.google.com/maps/dir/Alpha/Beta/@37.2,-122.1,14z/data=!3m1!1e3';

test('shortlink: r.jina.ai style output is parsed for the final URL', () => {
  const text = `Title: Google Maps\n\nURL Source: https://maps.app.goo.gl/xxx\n\nFinal URL: ${GMAPS}\n\nMarkdown Content:\nfrom Alpha`;
  assert.equal(extractFinalUrl(text), GMAPS);
});

test('shortlink: an embedded URL in a redirect body is found too', () => {
  assert.equal(extractFinalUrl(`<html><head><META HTTP-EQUIV="refresh" content="0;URL='${GMAPS}'"></head>`), GMAPS);
});

test('shortlink: non-short links pass straight through', async () => {
  const result = await resolveShortLink(GMAPS, { fetchImpl: stubFetch([]) });
  assert.equal(result.alreadyFull, true);
  assert.equal(result.url, GMAPS);
});

test('shortlink: resolvers are tried in order until one yields a Maps URL', async () => {
  const fetchImpl = stubFetch([
    [/\/api\/resolve/, { status: 404, body: 'nope' }],
    [/r\.jina\.ai/, { body: `Final URL: ${GMAPS}` }],
  ]);
  const result = await resolveShortLink('https://maps.app.goo.gl/abc', { fetchImpl });
  assert.equal(result.url, GMAPS);
  assert.equal(result.via, 'r.jina.ai reader');
  assert.equal(fetchImpl.calls.length, 2);
});

test('shortlink: every failure produces the manual escape hatch', async () => {
  const fetchImpl = stubFetch([[/\/api\/resolve/, new Error('offline')], [/r\.jina\.ai/, new Error('429')]]);
  await assert.rejects(() => resolveShortLink('https://maps.app.goo.gl/abc', { fetchImpl }), (error) => {
    assert.match(error.message, /built-in resolver: offline/);
    assert.match(error.message, /r\.jina\.ai reader: 429/);
    assert.match(error.hint, /address-bar URL/);
    return true;
  });
});

test('shortlink: a resolver that returns a non-Maps URL is rejected', async () => {
  const fetchImpl = stubFetch([[/\/api\/resolve/, { body: JSON.stringify({ url: 'https://evil.example.com/phish' }) }], [/r\.jina\.ai/, new Error('down')]]);
  await assert.rejects(() => resolveShortLink('https://maps.app.goo.gl/abc', { fetchImpl }), /Could not expand/);
});

// --------------------------------------------------------------- geocode ----

test('geocode: returns the best-ranked Nominatim hit', async () => {
  resetThrottleForTests();
  const fetchImpl = stubFetch([
    [/nominatim/, { body: [
      { lat: '37.3186', lon: '-122.1541', display_name: 'Black Mountain Backpack Camp, Los Altos', rank_field: 30, category: 'poi' },
      { lat: '37.0', lon: '-122.0', display_name: 'Los Altos, CA', rank_field: 16, addresstype: 'city' },
    ] }],
  ]);
  const hit = await geocodeQuery('Black Mountain Backpack Camp, Los Altos', { fetchImpl });
  assert.equal(hit.lat, 37.3186);
  assert.match(hit.displayName, /Black Mountain/);
  assert.match(fetchImpl.calls[0].url, /q=Black\+Mountain/);
  assert.match(fetchImpl.calls[0].url, /format=jsonv2/);
});

test('geocode: the link viewport biases the search towards the right region', async () => {
  resetThrottleForTests();
  const fetchImpl = stubFetch([[/nominatim/, { body: [{ lat: '1', lon: '2', display_name: 'x' }] }]]);
  await geocodeQuery('Springfield', { fetchImpl, viewport: { lat: 37.2, lng: -122.1 } });
  assert.match(fetchImpl.calls[0].url, /viewbox=/);
});

test('geocode: no result and network failure both resolve to null', async () => {
  resetThrottleForTests();
  assert.equal(await geocodeQuery('zzz', { fetchImpl: stubFetch([[/nominatim/, { body: [] }], [/api\/proxy/, new Error('off')]]) }), null);
  resetThrottleForTests();
  assert.equal(await geocodeQuery('zzz', { fetchImpl: stubFetch([[/nominatim/, new Error('down')], [/api\/proxy/, new Error('off')]]) }), null);
});

test('geocode: lookups are throttled to one per second as Nominatim requires', async () => {
  resetThrottleForTests();
  const fetchImpl = stubFetch([[/nominatim/, { body: [{ lat: '1', lon: '2', display_name: 'x' }] }]]);
  const started = Date.now();
  await Promise.all([geocodeQuery('a', { fetchImpl }), geocodeQuery('b', { fetchImpl }), geocodeQuery('c', { fetchImpl })]);
  const elapsed = Date.now() - started;
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(elapsed >= 2000, `three lookups should take ≥2 s, took ${elapsed} ms`);
});
