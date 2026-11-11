/**
 * Cloudflare Worker for hike app
 * Handles:
 * - GPX file upload and storage in R2
 * - AI-powered route planning with jina.ai
 * - Geocoding and routing decoupling
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route handling
    if (path.startsWith('/api/gpx')) {
      return handleGPX(request, env, ctx);
    } else if (path.startsWith('/api/route')) {
      return handleRoute(request, env, ctx);
    } else if (path.startsWith('/api/analyze')) {
      return handleAnalyze(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Handle GPX file operations
 */
async function handleGPX(request, env, ctx) {
  const url = new URL(request.url);

  // GET /api/gpx - List GPX files
  if (request.method === 'GET' && url.pathname === '/api/gpx') {
    const list = await listGPXFiles(env);
    return Response.json({ files: list });
  }

  // POST /api/gpx/upload - Upload GPX file
  if (request.method === 'POST' && url.pathname === '/api/gpx/upload') {
    return handleGPXUpload(request, env, ctx);
  }

  // GET /api/gpx/:key - Download GPX file
  if (request.method === 'GET' && url.pathname.match(/\/api\/gpx\/[^/]+$/)) {
    return handleGPXDownload(request, env, ctx);
  }

  // DELETE /api/gpx/:key - Delete GPX file
  if (request.method === 'DELETE' && url.pathname.match(/\/api\/gpx\/[^/]+$/)) {
    return handleGPXDelete(request, env, ctx);
  }

  return new Response('Method not allowed', { status: 405 });
}

/**
 * Handle route planning with AI
 */
async function handleRoute(request, env, ctx) {
  // POST /api/route/plan - AI-powered route planning
  if (request.method === 'POST' && url.pathname === '/api/route/plan') {
    return handleRoutePlan(request, env, ctx);
  }

  return new Response('Method not allowed', { status: 405 });
}

/**
 * Handle GPX analysis with AI
 */
async function handleAnalyze(request, env, ctx) {
  // POST /api/analyze/gpx - Analyze GPX file with AI
  if (request.method === 'POST' && url.pathname === '/api/analyze/gpx') {
    return handleGPXAnalyze(request, env, ctx);
  }

  return new Response('Method not allowed', { status: 405 });
}

/**
 * List all GPX files from R2
 */
async function listGPXFiles(env) {
  const list = await env.GPX_BUCKET.list();

  return list.objects.map(obj => ({
    key: obj.key,
    uploaded: obj.uploaded.toISOString(),
    size: obj.size,
    etag: obj.etag,
  }));
}

/**
 * Upload GPX file to R2
 */
async function handleGPXUpload(request, env, ctx) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/gpx+xml')) {
      return Response.json({ error: 'Invalid content type. Expected application/gpx+xml' }, { status: 400 });
    }

    const key = `gpx/${Date.now()}-${crypto.randomUUID()}.gpx`;
    const arrayBuffer = await request.arrayBuffer();

    await env.GPX_BUCKET.put(key, arrayBuffer, {
      httpMetadata: { contentType: 'application/gpx+xml' },
      customMetadata: {
        uploadedAt: new Date().toISOString(),
      },
    });

    return Response.json({
      success: true,
      key,
      size: arrayBuffer.byteLength,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Download GPX file from R2
 */
async function handleGPXDownload(request, env, ctx) {
  try {
    const match = url.pathname.match(/\/api\/gpx\/(.+)$/);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    const key = match[1];
    const object = await env.GPX_BUCKET.get(key);

    if (!object) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/gpx+xml');
    headers.set('Content-Disposition', `attachment; filename="${key}"`);

    return new Response(object.body, { headers });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Delete GPX file from R2
 */
async function handleGPXDelete(request, env, ctx) {
  try {
    const match = url.pathname.match(/\/api\/gpx\/(.+)$/);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    const key = match[1];
    await env.GPX_BUCKET.delete(key);

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * AI-powered route planning using jina.ai
 */
async function handleRoutePlan(request, env, ctx) {
  try {
    const body = await request.json();
    const { waypoints, mode, profile, query, apiKey } = body;

    // If query is provided, use jina.ai for intelligent route planning
    if (query) {
      return await aiRoutePlanWithQuery(query, apiKey || env.JINA_API_KEY, env);
    }

    // Traditional waypoint-based routing
    const route = await fetchORSRoute(waypoints, mode, env);
    return Response.json(route);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Use jina.ai for intelligent route planning
 */
async function aiRoutePlanWithQuery(query, apiKey, env) {
  // Analyze the natural language query with jina.ai
  const completion = await fetch(`${env.JINA_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'jina-embeddings',
      messages: [
        {
          role: 'system',
          content: `You are a route planning assistant for hikers. Extract key route parameters from user queries:
            - Start location (city, landmark, or address)
            - Destination location
            - Travel mode (hiking, cycling, driving)
            - Preferences (elevation gain, scenic routes, etc.)

            Return a JSON object with keys:
            {
              "start": string,
              "destination": string,
              "mode": "hiking"|"cycling"|"driving",
              "preferences": {
                "elevation": "low"|"medium"|"high"|"scenic",
                "duration": "short"|"medium"|"long"|"all-day"
              }
            }`
        },
        {
          role: 'user',
          content: query
        }
      ],
      temperature: 0.3,
    }),
  });

  const aiResponse = await completion.json();
  const routeParams = JSON.parse(aiResponse.choices[0].message.content);

  // Use OpenRouteService API for route calculation
  const route = await fetchORSRouteFromParams(routeParams, env);

  return Response.json({
    success: true,
    route,
    parsed: routeParams,
    aiQuery: query,
  });
}

/**
 * Fetch route from OpenRouteService
 */
async function fetchORSRoute(waypoints, mode, env) {
  const profile = mode === 'hiking' ? 'foot-hiking' : mode === 'cycling' ? 'cycling-regular' : 'driving-car';

  const response = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'YOUR_OPENROUTESERVICE_API_KEY', // Need to add this to env
    },
    body: JSON.stringify({
      coordinates: waypoints.map(wp => [wp.lon, wp.lat]),
      elevation: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`ORS API error: ${response.status}`);
  }

  const data = await response.json();
  const feature = data.features?.[0];

  return {
    points: feature.geometry.coordinates.map(c => ({
      lat: c[1],
      lon: c[0],
      ele: c[2] ?? null,
      time: null,
    })),
    distance: feature.properties?.summary?.distance || 0,
    duration: feature.properties?.summary?.duration || 0,
    provider: 'ors',
    profile,
  };
}

/**
 * Fetch route from OpenRouteService with parsed parameters
 */
async function fetchORSRouteFromParams(params, env) {
  const profile = params.mode === 'hiking' ? 'foot-hiking' :
                 params.mode === 'cycling' ? 'cycling-regular' : 'driving-car';

  // Get coordinates for start and destination using geocoding
  const startCoords = await geocode(params.start, env);
  const destCoords = await geocode(params.destination, env);

  const response = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'YOUR_OPENROUTESERVICE_API_KEY',
    },
    body: JSON.stringify({
      coordinates: [[startCoords.lng, startCoords.lat], [destCoords.lng, destCoords.lat]],
      elevation: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`ORS API error: ${response.status}`);
  }

  const data = await response.json();
  const feature = data.features?.[0];

  return {
    points: feature.geometry.coordinates.map(c => ({
      lat: c[1],
      lon: c[0],
      ele: c[2] ?? null,
      time: null,
    })),
    distance: feature.properties?.summary?.distance || 0,
    duration: feature.properties?.summary?.duration || 0,
    provider: 'ors',
    profile,
    mode: params.mode,
  };
}

/**
 * Geocode location name to coordinates
 */
async function geocode(location, env) {
  const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`, {
    headers: {
      'User-Agent': 'hike-worker/1.0',
    },
  });

  const results = await response.json();
  if (!results || results.length === 0) {
    throw new Error(`Could not geocode: ${location}`);
  }

  return {
    lat: parseFloat(results[0].lat),
    lng: parseFloat(results[0].lon),
  };
}

/**
 * Analyze GPX file with AI
 */
async function handleGPXAnalyze(request, env, ctx) {
  try {
    const body = await request.json();
    const { gpxKey, apiKey } = body;

    const object = await env.GPX_BUCKET.get(gpxKey);
    if (!object) {
      return Response.json({ error: 'GPX file not found' }, { status: 404 });
    }

    const gpxText = await object.text();

    // Use jina.ai to analyze the GPX
    const analysis = await fetch(`${env.JINA_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey || env.JINA_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'jina-embeddings',
        messages: [
          {
            role: 'system',
            content: `You are a hiking trail analyst. Analyze GPX files and provide:
              - Trail name and description
              - Total distance (miles)
              - Total elevation gain (feet)
              - Estimated time (hours)
              - Trail type (out-and-back, loop, point-to-point)
              - Key highlights or notes
              - Difficulty level (easy, moderate, challenging)

              Return a JSON object with these keys. Keep analysis concise and actionable.`
          },
          {
            role: 'user',
            content: `Analyze this GPX file:\n\n${gpxText.substring(0, 50000)}`, // First 50k chars
          },
        ],
        temperature: 0.3,
      }),
    });

    const analysisResponse = await analysis.json();

    return Response.json({
      success: true,
      analysis: JSON.parse(analysisResponse.choices[0].message.content),
      key: gpxKey,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}