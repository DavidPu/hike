/**
 * Frontend integration for Cloudflare Worker
 * Use this file to communicate with the Worker API
 */

const WORKER_URL = 'https://hike-worker.your-worker-name.workers.dev';

/**
 * Upload GPX file to Cloudflare R2
 */
export async function uploadGPX(gpxContent) {
  const formData = new FormData();
  formData.append('file', new Blob([gpxContent], { type: 'application/gpx+xml' }));

  const response = await fetch(`${WORKER_URL}/api/gpx/upload`, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to upload GPX');
  }

  return data;
}

/**
 * List all uploaded GPX files
 */
export async function listGPXFiles() {
  const response = await fetch(`${WORKER_URL}/api/gpx`, {
    method: 'GET',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to list GPX files');
  }

  return data.files;
}

/**
 * Download GPX file by key
 */
export async function downloadGPX(key) {
  const response = await fetch(`${WORKER_URL}/api/gpx/${key}`, {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error('Failed to download GPX');
  }

  return response.blob();
}

/**
 * AI-powered route planning from natural language query
 */
export async function planRouteWithAI(query, options = {}) {
  const response = await fetch(`${WORKER_URL}/api/route/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: options.mode,
      profile: options.profile,
      apiKey: options.apiKey,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to plan route');
  }

  return data;
}

/**
 * Traditional route planning with waypoints
 */
export async function planRouteWithWaypoints(waypoints, mode = 'hiking') {
  const response = await fetch(`${WORKER_URL}/api/route/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      waypoints,
      mode,
      apiKey: null,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to plan route');
  }

  return data;
}

/**
 * Analyze GPX file with AI
 */
export async function analyzeGPX(gpxKey, apiKey = null) {
  const response = await fetch(`${WORKER_URL}/api/analyze/gpx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gpxKey,
      apiKey,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to analyze GPX');
  }

  return data;
}

/**
 * Delete GPX file from Cloudflare R2
 */
export async function deleteGPX(key) {
  const response = await fetch(`${WORKER_URL}/api/gpx/${key}`, {
    method: 'DELETE',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to delete GPX');
  }

  return data;
}