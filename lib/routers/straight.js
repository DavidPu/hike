/**
 * routers/straight.js — last-resort geometry: great-circle lines between the stops.
 *
 * This never lies about streets: the returned object is flagged `approximate: true` and the
 * UI says so on the track name, in the stats strip and in the GPX description, so a route
 * exported this way can never be mistaken for a drivable path.
 */

import { densify, pathDistance } from '../geo.js';

/** Rough average door-to-door speeds, used only to estimate a duration. */
export const MODE_SPEED_KMH = { driving: 45, cycling: 18, walking: 4.8, transit: 25 };

export async function routeStraight(waypoints, mode, options = {}) {
  const { spacingMeters = 250 } = options;
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return { provider: 'straight', providerLabel: 'straight lines', mode, points: [], distance: 0, duration: 0, approximate: true, legs: [], warnings: ['At least two points are needed.'] };
  }
  const points = densify(
    waypoints.map((wp) => ({ lat: wp.lat, lng: wp.lng })),
    spacingMeters,
  );
  const distance = pathDistance(points);
  const speed = (MODE_SPEED_KMH[mode] || 45) / 3.6; // m/s
  return {
    provider: 'straight',
    providerLabel: 'straight lines (no road data)',
    mode,
    points,
    distance,
    duration: distance / speed,
    durationEstimated: true,
    approximate: true,
    legs: [],
    warnings: [
      'Distances are straight-line ("as the crow flies") and the duration is an estimate from an average speed — the GPX has no real street geometry.',
    ],
  };
}
