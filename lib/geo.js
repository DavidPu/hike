/**
 * geo.js — geometry helpers. Pure, no dependencies.
 * Distances are metres; points are {lat, lng}.
 */

const EARTH_RADIUS_M = 6371008.8;
const DEG2RAD = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
  return total;
}

/** Cumulative distance at each point — used to spread timestamps along a track. */
export function cumulativeDistances(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + haversine(points[i - 1], points[i]));
  return out;
}

export function bboxOf(points) {
  if (!points.length) return null;
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const p of points) {
    // Out-of-range values would write an invalid <bounds>, so they are ignored, not clamped.
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  if (minLat > maxLat) return null;
  return { minLat, maxLat, minLng, maxLng };
}

/** Grow a bbox by a fraction of its extent so map fitting never clips the edges. */
export function padBbox(bbox, fraction = 0.08) {
  if (!bbox) return bbox;
  const latPad = Math.max((bbox.maxLat - bbox.minLat) * fraction, 0.002);
  const lngPad = Math.max((bbox.maxLng - bbox.minLng) * fraction, 0.002);
  return {
    minLat: Math.max(-90, bbox.minLat - latPad),
    maxLat: Math.min(90, bbox.maxLat + latPad),
    minLng: Math.max(-180, bbox.minLng - lngPad),
    maxLng: Math.min(180, bbox.maxLng + lngPad),
  };
}

/**
 * Point-to-segment distance in metres, via an equirectangular projection anchored at `a`.
 * Accurate enough for simplification tolerances (the whole route fits in a few degrees).
 */
function perpendicularDistance(p, a, b) {
  const lat0 = (a.lat + b.lat) / 2 * DEG2RAD;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(lat0);
  const ax = a.lng * mPerDegLng;
  const ay = a.lat * mPerDegLat;
  const bx = b.lng * mPerDegLng;
  const by = b.lat * mPerDegLat;
  const px = p.lng * mPerDegLng;
  const py = p.lat * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer–Douglas–Peucker line simplification.
 * @param {Array<{lat:number,lng:number}>} points
 * @param {number} toleranceMeters maximum allowed deviation from the original line
 */
export function simplify(points, toleranceMeters) {
  if (!Array.isArray(points) || points.length < 3 || !(toleranceMeters > 0)) {
    return Array.isArray(points) ? points.slice() : [];
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    let maxDist = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > toleranceMeters && index !== -1) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Insert intermediate points so no gap exceeds `maxSpacingMeters` (straight-line mode). */
export function densify(points, maxSpacingMeters) {
  if (points.length < 2 || !(maxSpacingMeters > 0)) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = haversine(a, b);
    const steps = Math.min(5000, Math.max(1, Math.floor(dist / maxSpacingMeters)));
    for (let s = 1; s <= steps; s++) {
      out.push({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lng: a.lng + ((b.lng - a.lng) * s) / steps });
    }
  }
  return out;
}

/** Drop consecutive duplicates (routers and geocoders emit them at leg joins). */
export function dedupe(points, epsilonMeters = 0.1) {
  const out = [];
  for (const p of points) {
    if (!out.length || haversine(out[out.length - 1], p) > epsilonMeters) out.push(p);
  }
  return out;
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 100 ? km.toFixed(km < 10 ? 2 : 1) : Math.round(km)} km`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Great-circle initial bearing in degrees, for map marker arrows. */
export function bearing(a, b) {
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
}
