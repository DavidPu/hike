# Cloudflare Worker Architecture Diagram

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        USER BROWSER                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Hike Viewer  │    │Route Planner │    │GPX Analyzer  │  │
│  │  (Frontend)  │───►│   UI         │───►│   UI         │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
└──────────────────────────┬────────────────────────────────┘
                           │
                           │ REST API Calls
                           │ (fetch/json)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Route Planning Endpoint                            │  │
│  │  - AI Query Processing                              │  │
│  │  - Waypoint-to-Route                                │  │
│  │  - OpenRouteService API                              │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  GPX Storage Endpoint                               │  │
│  │  - Upload/R2                                        │  │
│  │  - Download/caching                                 │  │
│  │  - Metadata management                              │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Analysis Endpoint                                   │  │
│  │  - GPX parsing                                      │  │
│  │  - jina.ai API integration                          │  │
│  │  - Insight generation                               │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────┬───────────────────────┬─────────────────────┘
                │                       │
                ▼                       ▼
    ┌─────────────────────┐  ┌───────────────────┐
    │  Cloudflare R2      │  │  jina.ai API     │
    │  - GPX Files        │  │  - Query LLM     │
    │  - Edge locations   │  │  - Route extract │
    │  - Object storage   │  │  - Analysis gen  │
    └─────────────────────┘  └───────────────────┘
```

## Data Flow

### Route Planning Flow

```
User Input: "Find trail in Yosemite"
        │
        ▼
Browser → Worker (POST /api/route/plan)
        │
        ├─► jina.ai API (extract intent)
        │   ├─► Start: "Yosemite"
        │   ├─► Destination: "Half Dome"
        │   ├─► Mode: "hiking"
        │   └─► Preferences: "scenic"
        │
        ├─► OpenRouteService API (calculate route)
        │   ├─► Geocode start/dest
        │   ├─► Get road geometry
        │   └─► Add elevation data
        │
        └─► Return to browser
            └─► Display on map
```

### GPX Upload Flow

```
Browser → Worker (POST /api/gpx/upload)
        │
        ├─► Read file from FormData
        ├─► Generate unique key (timestamp + UUID)
        ├─► Upload to R2 bucket
        │   ├─► Edge location: Tokyo
        │   ├─► Edge location: San Francisco
        │   └─► Edge location: Frankfurt
        │
        └─► Return key to browser
            └─► Use for future operations
```

### GPX Analysis Flow

```
Browser → Worker (POST /api/analyze/gpx)
        │
        ├─► Get GPX from R2
        ├─► Send to jina.ai API
        │   ├─► Parse GPX structure
        │   ├─► Extract metrics:
        │   │   ├─ Distance
        │   │   ├─ Elevation gain
        │   │   ├─ Duration
        │   │   └─ Trail type
        │   ├─► Generate insights
        │   └─► Return structured analysis
        │
        └─► Return to browser
            └─► Display on UI
```

## Component Relationships

```
┌─────────────────────────────────────────────────────────────┐
│                    APP COMPONENTS                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ GPXParser    │  │MapManager    │  │Elevation     │     │
│  │ (existing)   │  │              │  │Profile       │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                  │             │
│         └─────────────────┼──────────────────┘             │
│                           │                                │
│              ┌────────────┴────────────┐                   │
│              │  RoutePlanner           │                   │
│              │  (new features)         │                   │
│              └────────────┬────────────┘                   │
│                           │                                │
└───────────────────────────┼────────────────────────────────┘
                            │
                            │ Uses:
                            │ - workerAPI.planRoute()
                            │ - workerAPI.uploadGPX()
                            │ - workerAPI.analyzeGPX()
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│               Hike Worker Integration Module                │
│  - Provides clean API                                     │
│  - Handles errors                                          │
│  - Manages state                                           │
└─────────────────────────────────────────────────────────────┘
```

## API Layer Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     API LAYER                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  /api/gpx/*                                          │  │
│  │  ├── POST /api/gpx/upload                             │  │
│  │  ├── GET    /api/gpx                                  │  │
│  │  ├── GET    /api/gpx/:key                             │  │
│  │  └── DELETE  /api/gpx/:key                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  /api/route/plan                                     │  │
│  │  ├── POST (AI query)                                  │  │
│  │  └── POST (waypoints)                                 │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  /api/analyze/gpx                                    │  │
│  │  └── POST                                            │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema

### R2 Object Structure

```json
{
  "key": "gpx/1234567890-uuid.gpx",
  "uploaded": "2026-11-10T12:00:00.000Z",
  "size": 12345,
  "httpMetadata": {
    "contentType": "application/gpx+xml"
  },
  "customMetadata": {
    "uploadedAt": "2026-11-10T12:00:00.000Z"
  }
}
```

### Response Schema

#### Route Planning Response
```json
{
  "success": true,
  "route": {
    "points": [
      {
        "lat": 37.8,
        "lon": -119.5,
        "ele": 2000,
        "time": null
      }
    ],
    "distance": 25000,
    "duration": 7200,
    "provider": "ors",
    "profile": "foot-hiking"
  },
  "parsed": {
    "start": "Yosemite Valley",
    "destination": "Half Dome",
    "mode": "hiking"
  }
}
```

#### GPX Analysis Response
```json
{
  "success": true,
  "analysis": {
    "name": "Yosemite Trail",
    "distance": "10.5 mi",
    "elevation_gain": "4200 ft",
    "estimated_time": "4.5 hours",
    "trail_type": "loop",
    "key_highlights": [
      "Stunning granite cliffs",
      "Meadow views"
    ],
    "difficulty": "moderate"
  }
}
```

## Technology Stack

### Frontend (Hike App)
- **Language**: JavaScript (ES6+)
- **Maps**: Leaflet.js
- **Charts**: Chart.js
- **Storage**: Browser localStorage

### Backend (Cloudflare Worker)
- **Runtime**: Cloudflare Workers JavaScript API
- **Storage**: Cloudflare R2 (S3-compatible)
- **AI**: jina.ai API (LLM)
- **Routing**: OpenRouteService API

### Infrastructure
- **Compute**: Serverless (Cloudflare Workers)
- **Storage**: Object storage (R2)
- **CDN**: Automatic edge caching
- **Database**: No SQL (R2 metadata)
- **API Gateway**: Cloudflare Workers Routes

## Security Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SECURITY                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐  │
│  │ API Keys     │────►│ Secrets      │────►│ Encrypted    │  │
│  │ (in code)    │     │ (wrangler)   │     │ Secrets      │  │
│  └──────────────┘     └──────────────┘     └──────────────┘  │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐  │
│  │ CORS         │────►│ Rate Limit   │────►│ File Size    │  │
│  │ Configured   │     │              │     │ Validation   │  │
│  └──────────────┘     └──────────────┘     └──────────────┘  │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐  │
│  │ HTTPS Only   │────►│ Authentication│────►│ Monitoring   │  │
│  │              │     │ (optional)    │     │              │  │
│  └──────────────┘     └──────────────┘     └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Performance Characteristics

### Response Times (Typical)
- **Route Planning**: 2-5 seconds
- **GPX Upload**: 1-2 seconds
- **GPX Analysis**: 3-7 seconds
- **GPX Download**: <100ms

### Scalability
- **Free Tier**: 100,000 requests/day
- **Concurrent Requests**: Limited by function time (CPU)
- **Auto-scaling**: Yes (cloudflare handles)
- **Edge Caching**: Yes (automatic)

### Cost (Free Tier)
- **Requests**: 100,000/day
- **Storage**: 10GB free
- **Bandwidth**: Unlimited (R2)
- **CPU Time**: 10ms per request

## Monitoring

### Key Metrics
- API request count
- Error rate
- Response time
- GPX file count
- Storage usage

### Logs
- Worker execution logs
- Error logs
- API response logs
- R2 access logs

---

**Architecture Version**: 1.0.0
**Last Updated**: 2026-11-10
**Status**: Production Ready