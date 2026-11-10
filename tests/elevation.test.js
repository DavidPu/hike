/**
 * elevation.test.js — the terrain lookup and the profile maths.
 *
 * The load-bearing properties are: every track point ends up with an <ele> (that is what makes a
 * viewer draw a profile), the number of requests stays bounded no matter how long the route is,
 * a source without CORS is never called cross-origin, and a dead terrain service degrades to a
 * route without heights rather than a failed conversion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planSamples, interpolateHeights, elevationProfile, addElevation, PROVIDERS, providerById } from '../lib/elevation.js';

/** A straight line of `count` points about `spacingMeters` apart, heading north. */
function linePoints(count, spacingMeters = 100) {
  const stepDeg = spacingMeters / 111_320;
  return Array.from({ length: count }, (_, i) => ({ lat: 46.94 + i * stepDeg, lng: 7.44 }));
}

const json = (body) => ({ ok: true, status: 200, json: async () => body });

test('planSamples caps the request count however long the route is', () => {
  const idx = planSamples(linePoints(5000), { spacingMeters: 60, maxSamples: 400 });
  assert.ok(idx.length <= 400, `got ${idx.length}`);
  assert.equal(idx[0], 0, 'starts at the first point');
  assert.equal(idx.at(-1), 4999, 'ends at the last point');
  assert.ok(idx.every((v, i) => i === 0 || v > idx[i - 1]), 'strictly increasing');
  assert.ok(idx.every((v) => v >= 0 && v < 5000), 'in range');
});

test('planSamples asks for every point when the route is already short', () => {
  assert.deepEqual(planSamples(linePoints(8)), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(planSamples([]), []);
  assert.deepEqual(planSamples([{ lat: 1, lng: 1 }]), []);
});

test('interpolateHeights covers every point and pins the sampled ones', () => {
  const points = linePoints(10);
  const idx = [0, 5, 9];
  const out = interpolateHeights(points, idx, [100, 200, 150]);
  assert.equal(out.length, 10);
  assert.ok(out.every((p) => Number.isFinite(p.ele)), 'every point carries a height');
  assert.equal(out[0].ele, 100, 'sampled point keeps its own height');
  assert.equal(out[5].ele, 200);
  assert.equal(out[9].ele, 150);
  assert.ok(out[2].ele > 100 && out[2].ele < 200, 'between samples it is between them');
  assert.ok(Math.abs(out[2].ele - 140) < 12, `roughly proportional to distance, got ${out[2].ele}`);
  assert.deepEqual(out.map((p, i) => p.lat), points.map((p) => p.lat), 'coordinates are untouched');
});

test('interpolateHeights leaves points alone when nothing came back', () => {
  const out = interpolateHeights(linePoints(4), [0, 3], [null, null]);
  assert.ok(out.every((p) => !('ele' in p)), 'no heights invented out of thin air');
});

test('elevationProfile counts climb and drop, ignoring points without a height', () => {
  const p = elevationProfile([{ ele: 100 }, { ele: 150 }, { ele: 120 }, { ele: 180 }, {}]);
  assert.equal(p.ascent, 110, 'up 50 then up 60');
  assert.equal(p.descent, 30);
  assert.equal(p.min, 100);
  assert.equal(p.max, 180);
  assert.equal(p.counted, 4);
});

test('elevationProfile refuses to summarise fewer than two heights', () => {
  assert.equal(elevationProfile([{ ele: 10 }]), null);
  assert.equal(elevationProfile([]), null);
  assert.equal(elevationProfile(null), null);
});

test('addElevation puts a height on every track point via Open-Meteo', async () => {
  const calls = [];
  const result = await addElevation(linePoints(30), {
    proxyUrl: null,
    fetchImpl: async (url) => {
      calls.push(url);
      const params = new URLSearchParams(url.split('?')[1]);
      return json({ elevation: params.get('latitude').split(',').map(() => 512) });
    },
  });
  assert.equal(result.provider, 'open-meteo');
  assert.equal(calls.length, 1, 'one batched request for a short route');
  assert.equal(result.points.length, 30);
  assert.ok(result.points.every((p) => p.ele === 512), 'every point carries the height');
  assert.equal(result.profile.ascent, 0);
  assert.equal(result.warning, null);
});

test('addElevation batches to what the provider accepts, whatever the route length', async () => {
  const sizes = [];
  const result = await addElevation(linePoints(250, 100), {
    proxyUrl: null,
    fetchImpl: async (url) => {
      const params = new URLSearchParams(url.split('?')[1]);
      const n = params.get('latitude').split(',').length;
      sizes.push(n);
      assert.ok(n <= 100, `Open-Meteo accepts at most 100 coordinates, asked for ${n}`);
      return json({ elevation: Array.from({ length: n }, (_, i) => 200 + i) });
    },
  });
  assert.ok(sizes.length >= 2, `expected several batches, got ${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 250, 'every point is asked about exactly once');
  assert.ok(result.points.every((p) => Number.isFinite(p.ele)));
});

test('a source with no CORS header is never called cross-origin — only through the proxy', async () => {
  assert.equal(providerById('opentopodata').crossOrigin, false, 'the premise: OpenTopoData sends no ACAO');
  const direct = [];
  const viaProxy = [];
  await addElevation(linePoints(10), {
    provider: 'opentopodata',
    proxyUrl: null,
    fetchImpl: async (url) => {
      direct.push(url);
      throw new Error('should not be reached');
    },
  });
  assert.equal(direct.length, 0, 'no doomed cross-origin attempt');

  const result = await addElevation(linePoints(10), {
    provider: 'opentopodata',
    proxyUrl: '/api/proxy?url=',
    fetchImpl: async (url) => {
      viaProxy.push(url);
      const inner = decodeURIComponent(/[?&]url=([^&]+)/.exec(url)[1]);
      const n = new URLSearchParams(inner.split('?')[1]).get('locations').split('|').length;
      return json({ results: Array.from({ length: n }, () => ({ elevation: 300 })) });
    },
  });
  assert.equal(result.provider, 'opentopodata');
  assert.ok(viaProxy.every((u) => u.startsWith('/api/proxy?url=')), 'same-origin proxy only');
});

test('addElevation falls through to the second source when the first is down', async () => {
  const attempted = [];
  const result = await addElevation(linePoints(12), {
    provider: 'auto',
    proxyUrl: '/api/proxy?url=',
    fetchImpl: async (url) => {
      attempted.push(url);
      if (url.includes('open-meteo')) throw new Error('service unavailable');
      const inner = decodeURIComponent(/[?&]url=([^&]+)/.exec(url)[1]);
      const n = new URLSearchParams(inner.split('?')[1]).get('locations').split('|').length;
      return json({ results: Array.from({ length: n }, () => ({ elevation: 77 })) });
    },
  });
  assert.equal(result.provider, 'opentopodata', 'the backup answered');
  assert.ok(attempted.some((u) => u.includes('open-meteo')), 'the primary was tried first');
  assert.ok(result.points.every((p) => p.ele === 77));
});

test('a short answer from the provider is treated as failure, not half a profile', async () => {
  const attempted = [];
  const result = await addElevation(linePoints(12), {
    proxyUrl: null,
    fetchImpl: async (url) => {
      attempted.push(url);
      return json({ elevation: [1, 2, 3] }); // fewer than asked for
    },
  });
  assert.equal(result.profile, null, 'no profile invented from a partial answer');
  assert.ok(result.warning, 'the user is told the lookup failed');
  assert.ok(result.points.every((p) => !('ele' in p)), 'points come back exactly as they were');
});

test('addElevation never throws: a dead internet yields a route without heights', async () => {
  const result = await addElevation(linePoints(12), {
    proxyUrl: '/api/proxy?url=',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(result.profile, null);
  assert.ok(result.warning && /without elevation/.test(result.warning), 'the user is told, not left guessing');
  assert.equal(result.points.length, 12, 'the route itself survives');
});

test('an aborted conversion stops asking', async () => {
  const controller = new AbortController();
  controller.abort();
  let asked = 0;
  const result = await addElevation(linePoints(12), {
    proxyUrl: null,
    signal: controller.signal,
    fetchImpl: async () => {
      asked += 1;
      return json({ elevation: [1] });
    },
  });
  assert.equal(asked, 0);
  assert.equal(result.profile, null);
});

test('an unknown provider name is reported, not swallowed', async () => {
  const result = await addElevation(linePoints(6), { provider: 'nope', proxyUrl: null, fetchImpl: async () => json({}) });
  assert.match(result.warning, /Unknown elevation source/);
});

test('the two providers are the documented free ones and are tried in the right order', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['open-meteo', 'opentopodata']);
  assert.equal(PROVIDERS[0].crossOrigin, true, 'Open-Meteo is the one the browser can reach directly');
  assert.ok(PROVIDERS.every((p) => p.maxBatch <= 100), 'within the 100-coordinate limit');
});
