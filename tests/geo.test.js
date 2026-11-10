import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine,
  pathDistance,
  cumulativeDistances,
  bboxOf,
  padBbox,
  simplify,
  densify,
  dedupe,
  formatDistance,
  formatDuration,
  bearing,
} from '../lib/geo.js';
import { decodePolyline, encodePolyline } from '../lib/polyline.js';

const SF = { lat: 37.7749, lng: -122.4194 };
const LA = { lat: 34.0522, lng: -118.2437 };
const OAK = { lat: 37.8044, lng: -122.2712 };

test('haversine matches the known great-circle distance', () => {
  const d = haversine(SF, LA);
  assert.ok(Math.abs(d - 559000) < 3000, `expected ~559 km, got ${d}`);
  assert.equal(haversine(SF, SF), 0);
  assert.ok(Math.abs(haversine(OAK, SF) - 13700) < 400);
});

test('pathDistance sums the legs', () => {
  const viaOakland = [SF, OAK, LA];
  assert.ok(pathDistance(viaOakland) > haversine(SF, LA), 'a detour must be longer than the direct line');
  assert.equal(pathDistance([SF]), 0);
  assert.equal(pathDistance([]), 0);
});

test('cumulativeDistances is monotonic and ends at the total', () => {
  const cum = cumulativeDistances([SF, OAK, LA]);
  assert.equal(cum[0], 0);
  assert.equal(cum.length, 3);
  assert.ok(cum[1] < cum[2]);
  assert.ok(Math.abs(cum[2] - pathDistance([SF, OAK, LA])) < 1e-6);
});

test('bbox ignores malformed points rather than poisoning the range', () => {
  const bbox = bboxOf([SF, OAK, { lat: NaN, lng: 0 }, { lat: 1000, lng: 0 }]);
  assert.equal(bbox.minLat, SF.lat);
  assert.equal(bbox.maxLat, OAK.lat);
  assert.equal(bboxOf([]), null);
});

test('padBbox always leaves a visible margin, even for a single point', () => {
  const point = bboxOf([SF]);
  const padded = padBbox(point);
  assert.ok(padded.maxLat > padded.minLat && padded.maxLng > padded.minLng);
  assert.ok(padded.minLat >= -90 && padded.maxLat <= 90);
  assert.equal(padBbox(null), null);
});

function makeZigzag(n = 200) {
  // A straight line with a 300 m bump at the middle index.
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ lat: 37 + i * 0.001, lng: -122 });
  const mid = Math.floor(n / 2);
  pts[mid] = { lat: pts[mid].lat, lng: pts[mid].lng + 0.003 };
  return { pts, mid };
}

test('simplify keeps the shape it must and drops what it can', () => {
  const { pts, mid } = makeZigzag();
  const coarse = simplify(pts, 100);
  assert.ok(coarse.length < pts.length, 'collinear points should collapse');
  assert.ok(coarse.some((p) => p.lng !== -122), 'the 300 m bump must survive a 100 m tolerance');
  const fine = simplify(pts, 1000);
  assert.ok(!fine.some((p) => p.lng !== -122), 'the 300 m bump may go at a 1 km tolerance');
});

test('simplify never moves the endpoints and never returns fewer than two points', () => {
  const { pts } = makeZigzag();
  const out = simplify(pts, 500);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  assert.deepEqual(simplify(pts, 1e9).length >= 2, true);
  assert.deepEqual(simplify([SF], 10), [SF]);
  assert.deepEqual(simplify([], 10), []);
  assert.deepEqual(simplify(null, 10), []);
});

/** Perpendicular distance from p to segment a-b, in metres (independent of geo.js internals). */
function deviation(p, a, b) {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const [ax, ay, bx, by, px, py] = [a.lng * mLng, a.lat * mLat, b.lng * mLng, b.lat * mLat, p.lng * mLng, p.lat * mLat];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

test('every dropped point stays within tolerance of the line that replaced it', () => {
  const { pts } = makeZigzag(400);
  const tolerance = 150;
  const out = simplify(pts, tolerance);
  const kept = pts.map((p, i) => out.some((q) => q.lat === p.lat && q.lng === p.lng)).filter(Boolean).length;
  assert.ok(kept >= 2);
  // Walk the original indices, measuring each point against the simplified segment spanning it.
  let seg = 0;
  for (const p of pts) {
    while (seg < out.length - 2 && !(out[seg].lat <= p.lat && p.lat <= out[seg + 1].lat)) seg++;
    const d = deviation(p, out[seg], out[seg + 1]);
    assert.ok(d <= tolerance + 1, `a point sat ${d.toFixed(1)} m from its replacement line`);
  }
});

test('densify caps the gap between consecutive points', () => {
  const out = densify([SF, LA], 1000);
  let worst = 0;
  for (let i = 1; i < out.length; i++) worst = Math.max(worst, haversine(out[i - 1], out[i]));
  assert.ok(worst <= 1050, `largest gap was ${worst} m`);
  assert.deepEqual(out[0], SF);
  assert.deepEqual(out[out.length - 1], LA);
  assert.equal(densify([SF], 100).length, 1);
});

test('dedupe removes repeated router join points', () => {
  const dupes = [SF, { ...SF }, OAK, OAK, LA];
  assert.equal(dedupe(dupes).length, 3);
  assert.equal(dedupe([]).length, 0);
});

test('formatters read like a human wrote them', () => {
  assert.equal(formatDistance(812), '812 m');
  assert.equal(formatDistance(32066), '32.1 km');
  assert.equal(formatDistance(123456), '123 km');
  assert.equal(formatDistance(NaN), '—');
  assert.equal(formatDuration(26013), '7 h 14 min');
  assert.equal(formatDuration(180), '3 min');
  assert.equal(formatDuration(7200), '2 h');
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(undefined), '—');
});

test('bearing points east for a due-east hop', () => {
  // Due east at 37.8°N is not exactly 90°: a great circle heads poleward, so it starts
  // slightly north of east. Only on the equator is it exactly 90°.
  assert.ok(Math.abs(bearing(SF, { lat: 37.7749, lng: -121 }) - 90) < 0.5);
  assert.ok(Math.abs(bearing(SF, { lat: 38, lng: -122.4194 }) - 0) < 0.001);
  assert.ok(Math.abs(bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 90) < 1e-9);
});

test('decodePolyline reproduces Google’s documented example', () => {
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(points, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('polyline round-trips through encode and decode', () => {
  const original = [SF, OAK, LA, { lat: 0, lng: 0 }, { lat: -33.8688, lng: 151.2093 }];
  const encoded = encodePolyline(original);
  assert.equal(typeof encoded, 'string');
  assert.ok(!/[^ -~]/.test(encoded), 'polyline must stay printable ASCII');
  const back = decodePolyline(encoded);
  assert.equal(back.length, original.length);
  original.forEach((p, i) => {
    assert.ok(Math.abs(back[i].lat - p.lat) < 1e-5, `lat ${i}`);
    assert.ok(Math.abs(back[i].lng - p.lng) < 1e-5, `lng ${i}`);
  });
});

test('a real OSRM-scale geometry survives the codec', () => {
  const line = Array.from({ length: 1500 }, (_, i) => ({ lat: 37 + i * 0.0002, lng: -122 + i * 0.00015 }));
  const back = decodePolyline(encodePolyline(line));
  assert.equal(back.length, line.length);
  assert.ok(Math.abs(back[1499].lat - line[1499].lat) < 1e-5);
});

test('polyline precision 6 is supported', () => {
  const line = [{ lat: 37.31859234, lng: -122.15405612 }];
  const back = decodePolyline(encodePolyline(line, 6), 6);
  assert.ok(Math.abs(back[0].lat - line[0].lat) < 1e-6);
});

test('malformed polylines fail loudly instead of returning nonsense', () => {
  assert.deepEqual(decodePolyline(''), []);
  assert.deepEqual(decodePolyline(null), []);
  assert.throws(() => decodePolyline('_p~iF'), /Truncated polyline/);
  assert.throws(() => decodePolyline('!!!'), /Invalid polyline character/);
});
