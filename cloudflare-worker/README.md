# Cloudflare Worker for Hike App

A Cloudflare Workers service that decouples AI-powered features from the hike GPX viewer application.

## Features

- **GPX File Storage**: Upload, download, and manage GPX files in Cloudflare R2
- **AI Route Planning**: Use jina.ai for natural language route queries
- **Route Analysis**: Extract insights from GPX files with AI
- **Decoupled Architecture**: Heavy operations run on the server, reducing browser load

## Architecture

```
┌─────────────┐
│   Browser    │
│  (Hike App)  │
└──────┬──────┘
       │
       │ REST API
       ▼
┌─────────────────────────┐
│  Cloudflare Worker      │
│  /api/gpx/*             │
│  /api/route/plan        │
│  /api/analyze/gpx       │
└───────────┬─────────────┘
            │
            ├─────────────┐
            │             │
            ▼             ▼
    ┌─────────────┐  ┌──────────────┐
    │   R2 Bucket  │  │ jina.ai API  │
    │  (GPX Store) │  │  (AI Routes) │
    └─────────────┘  └──────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd cloudflare-worker
npm install
```

### 2. Configure Credentials

Set your OpenRouteService API key in `wrangler.toml`:

```toml
[vars]
OPENROUTESERVICE_API_KEY = "your-ors-api-key-here"
```

Set your jina.ai API key (for route planning and analysis):

```bash
wrangler secret put JINA_API_KEY
# Enter your jina.ai API key when prompted
```

### 3. Deploy to Cloudflare Workers

```bash
npm run deploy
```

This will deploy the worker and output the URL.

## API Endpoints

### GPX Management

#### POST /api/gpx/upload
Upload a GPX file to R2.

**Request:**
- `Content-Type: multipart/form-data`
- File body with GPX data

**Response:**
```json
{
  "success": true,
  "key": "gpx/1234567890-uuid.gpx",
  "size": 12345
}
```

#### GET /api/gpx
List all uploaded GPX files.

**Response:**
```json
{
  "files": [
    {
      "key": "gpx/1234567890-uuid.gpx",
      "uploaded": "2026-11-10T12:00:00.000Z",
      "size": 12345,
      "etag": "abc123"
    }
  ]
}
```

#### GET /api/gpx/:key
Download a GPX file.

**Response:**
- `Content-Type: application/gpx+xml`

#### DELETE /api/gpx/:key
Delete a GPX file.

### Route Planning

#### POST /api/route/plan

**Option 1: Natural Language Query**
```json
{
  "query": "Find a hiking trail from Yosemite Valley to Half Dome, moderate difficulty, scenic"
}
```

**Option 2: Waypoints (Traditional)**
```json
{
  "waypoints": [
    {"lat": 37.7, "lon": -119.5},
    {"lat": 37.75, "lon": -119.7}
  ],
  "mode": "hiking",
  "profile": "foot-hiking"
}
```

**Response:**
```json
{
  "success": true,
  "route": {
    "points": [
      {"lat": 37.7, "lon": -119.5, "ele": 2000, "time": null}
    ],
    "distance": 25000,
    "duration": 7200,
    "provider": "ors",
    "profile": "foot-hiking"
  },
  "parsed": {
    "start": "Yosemite Valley",
    "destination": "Half Dome",
    "mode": "hiking",
    "preferences": {
      "elevation": "medium",
      "duration": "all-day"
    }
  }
}
```

### GPX Analysis

#### POST /api/analyze/gpx
Analyze a GPX file with AI.

**Request:**
```json
{
  "gpxKey": "gpx/1234567890-uuid.gpx",
  "apiKey": "your-jina-api-key"
}
```

**Response:**
```json
{
  "success": true,
  "analysis": {
    "name": "Yosemite Valley to Half Dome",
    "distance": "10.5 mi",
    "elevation_gain": "4200 ft",
    "estimated_time": "4.5 hours",
    "trail_type": "point-to-point",
    "key_highlights": ["Stunning granite cliffs", "Meadow views", "Wildlife spotting"],
    "difficulty": "challenging"
  },
  "key": "gpx/1234567890-uuid.gpx"
}
```

## Usage in Hike App

### Using the Worker for Route Planning

```javascript
import { planRouteWithAI, planRouteWithWaypoints } from './cloudflare-worker/frontend-integration.js';

// Natural language query
const result = await planRouteWithAI("Find a hiking trail from San Francisco to Mt. Tamalpais, scenic route");

// Traditional waypoint-based
const result = await planRouteWithWaypoints([
  {lat: 37.78, lon: -122.4},
  {lat: 37.78, lon: -122.5}
], 'hiking');
```

### Using the Worker for GPX Storage

```javascript
import { uploadGPX, listGPXFiles, downloadGPX, deleteGPX } from './cloudflare-worker/frontend-integration.js';

// Upload GPX
const uploadResult = await uploadGPX(gpxString);

// List files
const files = await listGPXFiles();

// Download specific file
const gpxBlob = await downloadGPX('gpx/1234567890-uuid.gpx');

// Delete file
await deleteGPX('gpx/1234567890-uuid.gpx');
```

## Development

### Running Locally

```bash
npm run dev
```

This starts a local dev server compatible with wrangler.

### Viewing Logs

```bash
npm run tail
```

## Configuration

### wrangler.toml

```toml
name = "hike-worker"
main = "worker.js"
compatibility_date = "2026-11-10"

account_id = "1a5ee5d294a81e17cb7a24b72e5a6d39"

[[r2_buckets]]
binding = "GPX_BUCKET"
bucket_name = "hike-gpx-files"

[vars]
JINA_API_URL = "https://api.jina.ai/v1"
OPENROUTESERVICE_API_KEY = "your-key-here"
```

### Secrets

Set secrets in the Cloudflare dashboard or with wrangler:

```bash
wrangler secret put JINA_API_KEY
wrangler secret put OPENROUTESERVICE_API_KEY
```

## Integrating with jina.ai

The worker uses jina.ai for:
- **Route Query Understanding**: Extract start, destination, mode, and preferences from natural language
- **GPX Analysis**: Generate human-readable summaries and insights from trail data

### jina.ai API Key

Get a free API key from [jina.ai](https://jina.ai/).

## Performance Considerations

- **R2 Storage**: GPX files are stored in edge locations for fast access
- **Route Planning**: AI processing happens server-side, not in browser
- **Caching**: Consider adding R2 object cache for frequently accessed GPX files

## Limitations

- **File Size**: GPX files limited by R2 and Cloudflare Workers memory (default: 25MB per object)
- **API Keys**: Store sensitive keys in secrets, not in plain config
- **Rate Limits**: jina.ai and OpenRouteService have their own rate limits

## Future Enhancements

- [ ] Add file metadata (trail name, difficulty, tags)
- [ ] Implement route comparison and recommendations
- [ ] Add weather forecasts for trail locations
- [ ] Support for multiple route profiles (elevation profiles, scenic routes)
- [ ] Real-time GPX file editing via worker
- [ ] Analytics and usage tracking

## License

Same as the parent hike project (MIT).

## Contributing

This is part of the hike GPX viewer project. For issues and contributions, see the main project repository.

## Support

For issues with the Cloudflare Worker, please check the Cloudflare Workers documentation and this project's main repository.