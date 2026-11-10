/**
 * polyline.js — Google's encoded-polyline codec.
 * Used to read the `overview_polyline` returned by the Directions API, and to let users
 * paste an encoded polyline straight into the app.
 */

/**
 * @param {string} encoded Google polyline (precision 5 by default)
 * @param {number} precision digits after the decimal in the encoding (5 or 6)
 * @returns {Array<{lat:number,lng:number}>}
 */
export function decodePolyline(encoded, precision = 5) {
  if (typeof encoded !== 'string') return [];
  const factor = 10 ** precision;
  const points = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  const n = encoded.length;

  while (i < n) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      if (i >= n) throw new Error('Truncated polyline: ran out of characters reading latitude');
      byte = encoded.charCodeAt(i++) - 63;
      if (byte < 0) throw new Error(`Invalid polyline character "${encoded[i - 1]}"`);
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      if (i >= n) throw new Error('Truncated polyline: ran out of characters reading longitude');
      byte = encoded.charCodeAt(i++) - 63;
      if (byte < 0) throw new Error(`Invalid polyline character "${encoded[i - 1]}"`);
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

function encodeSigned(value) {
  const v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  let rest = v;
  while (rest >= 0x20) {
    out += String.fromCharCode((0x20 | (rest & 0x1f)) + 63);
    rest >>= 5;
  }
  return out + String.fromCharCode(rest + 63);
}

/** Inverse of decodePolyline; used by the round-trip test and by "copy polyline". */
export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += encodeSigned(lat - prevLat) + encodeSigned(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}
