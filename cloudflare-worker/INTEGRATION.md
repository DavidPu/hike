# Hike App - Cloudflare Worker Integration Guide

This guide shows how to integrate the Cloudflare Worker with your existing GPX Hike Viewer application.

## Overview

### Before (Client-Side Only)
```
User → Browser → Geocoding/Routing (heavy operations) → Results
```

### After (Decoupled Architecture)
```
User → Browser → Cloudflare Worker → R2 + jina.ai → Results
                         ↓
                   Lighter client
```

## Files Created

```
cloudflare-worker/
├── worker.js                    # Main Cloudflare Worker code
├── wrangler.toml                # Cloudflare configuration
├── package.json                 # Dependencies
├── .gitignore                   # Git ignore file
├── demo.html                    # Interactive demo page
├── dev-server.js                # Local development server
├── frontend-integration.js      # Browser API wrappers
├── hike-integration.js          # Hike app integration module
├── README.md                    # Complete documentation
├── SETUP.md                     # Quick setup guide
└── INTEGRATION.md               # This file
```

## Step 1: Deploy the Worker

```bash
cd cloudflare-worker
npm install
npm run deploy
```

Note the worker URL from the deployment output.

## Step 2: Configure jina.ai API Key

```bash
cd cloudflare-worker
wrangler secret put JINA_API_KEY
# Enter your jina.ai API key when prompted
```

## Step 3: Update Hike App Configuration

### Option A: Use Global Integration (Simple)

Add to your `index.html`:

```html
<script type="module">
  import { initWorkerIntegration } from './cloudflare-worker/hike-integration.js';

  // Initialize with your worker URL
  window.hikeWorkerAPI = initWorkerIntegration({
    workerUrl: 'https://hike-worker.your-name.workers.dev',
    jinaApiKey: localStorage.getItem('jina_api_key'),
    useAI: true,
  });
</script>
```

### Option B: Import in app.js (More Control)

```javascript
// In your app.js, add:

// At the top of the file
import { initWorkerIntegration } from './cloudflare-worker/hike-integration.js';

// In your App class constructor or after initialization:
const workerAPI = initWorkerIntegration({
  workerUrl: 'https://hike-worker.your-name.workers.dev',
  jinaApiKey: localStorage.getItem('jina_api_key'),
  useAI: true,
});

// Use it in your components:
// const route = await workerAPI.planRoute("Find a trail in Yosemite");
```

### Option C: Use Browser API Wrappers (Lightweight)

```javascript
// In your app.js
import {
  planRouteWithAI,
  uploadGPX,
  analyzeGPX
} from './cloudflare-worker/frontend-integration.js';

// Use in your route planning component
document.getElementById('planRouteBtn').addEventListener('click', async () => {
  const query = document.getElementById('route-query').value;

  // AI-powered route planning
  const result = await planRouteWithAI(query, {
    mode: 'hiking',
    profile: 'foot-hiking',
    apiKey: 'your-jina-api-key'
  });

  // Process result...
});
```

## Step 4: Update Route Planner UI

### Add Natural Language Input Field

In your HTML, add a new input field for natural language queries:

```html
<div id="route-ai-section">
  <label>Natural Language Query</label>
  <input type="text" id="route-query" placeholder="e.g., Find a hiking trail from San Francisco to Mt. Tamalpais">
  <button id="plan-route-ai-btn" class="btn">Plan Route</button>
</div>
```

### Update JavaScript in app.js

In your `RoutePlanner` class, add this:

```javascript
// Add to your RoutePlanner class
this.aiQueryInput = document.getElementById('route-query');
this.aiPlanBtn = document.getElementById('plan-route-ai-btn');

// Add event listener in constructor or initialization
this.aiPlanBtn.addEventListener('click', () => {
  this._planWithAI(this.aiQueryInput.value);
});

// Add method
async _planWithAI(query) {
  try {
    const response = await workerAPI.planRoute(query, 'hiking');

    // Clear existing waypoints
    this.clear();
    this.btnDownload.classList.add('hidden');

    // Add waypoints from AI response
    response.route.waypoints?.forEach(wp => {
      this._addWaypoint(wp.lat, wp.lon, false);
    });

    // Re-route
    this._reroute();

    // Fit map to waypoints
    this._fitToWaypoints();

    // Show analysis
    if (response.analysis) {
      console.log('Trail analysis:', response.analysis);
    }
  } catch (error) {
    console.error('AI route planning failed:', error);
    alert('Failed to plan route: ' + error.message);
  }
}
```

## Step 5: Add GPX Storage to Hike App

In your `App` class, add GPX storage:

```javascript
// In your App class constructor
this.workerAPI = null;
this.gpxStorageEnabled = false;

// In _initUI or after initialization
async _initWorker() {
  try {
    // Initialize worker with environment URL
    const workerUrl = 'https://hike-worker.your-name.workers.dev';
    const jinaKey = localStorage.getItem('jina_api_key');

    this.workerAPI = initWorkerIntegration({
      workerUrl,
      jinaApiKey: jinaKey,
      useAI: true,
    });

    this.gpxStorageEnabled = true;

    // Load existing files
    const files = await this.workerAPI.listGPXFiles();
    console.log('Stored GPX files:', files);

  } catch (error) {
    console.warn('Cloudflare Worker integration not available:', error);
  }
}

// In _exportGPX, add storage option
_exportGPX(shouldStore = false) {
  if (!this.parsedTracks || this.parsedTracks.length === 0) {
    alert('No track loaded to export');
    return;
  }

  const trackName = this.trackSelect.selectedOptions[0]?.textContent || 'Track';
  const gpxContent = GPXExporter.export(this.parsedTracks, this.pois, trackName);
  const filename = trackName.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_') + '_export.gpx';
  GPXExporter.download(gpxContent, filename);

  // Store in Cloudflare R2
  if (shouldStore && this.gpxStorageEnabled && this.workerAPI) {
    this.workerAPI.uploadGPX(gpxContent)
      .then(result => {
        console.log('GPX uploaded to:', result.key);

        // Optionally analyze it
        this.workerAPI.analyzeGPX(result.key)
          .then(analysis => {
            console.log('AI Analysis:', analysis);
          });
      })
      .catch(error => console.error('GPX upload failed:', error));
  }
}
```

## Use Cases

### Use Case 1: Natural Language Route Planning

```javascript
// User: "Find a trail in Yosemite"
const result = await workerAPI.planRoute("Find a trail in Yosemite, moderate difficulty");
// Returns: route points, distance, duration, AI analysis
```

### Use Case 2: GPX Upload and Analysis

```javascript
// Upload a new trail
const gpx = `<?xml version="1.0" encoding="UTF-8"?>...`;
const uploadResult = await workerAPI.uploadGPX(gpx);

// Get AI analysis
const analysis = await workerAPI.analyzeGPX(uploadResult.key);
// Returns: trail name, elevation, difficulty, highlights
```

### Use Case 3: Traditional Waypoint Planning (Fallback)

```javascript
// When AI is not available, use traditional waypoints
const waypoints = [
  { lat: 37.78, lon: -122.4 },
  { lat: 37.78, lon: -122.5 }
];
const result = await workerAPI.planRouteWithWaypoints(waypoints, 'hiking');
```

## Benefits

### For Users
- **Faster** - Route planning done server-side
- **More accurate** - AI understands natural language queries
- **Better analysis** - AI generates trail insights
- **Persistent storage** - Trail history saved in the cloud

### For Developers
- **Decoupled** - Heavy operations not in browser
- **Scalable** - Server handles requests
- **Maintainable** - Updates only in worker
- **Secure** - API keys stored on server

## Performance Impact

- **Before**: Browser processes geocoding/routing (slow on mobile)
- **After**: Worker handles requests (fast, cached)
- **Network**: Minimal additional latency for well-configured workers

## Security Notes

1. **API Keys**: Store jina.ai API key on server (wrangler.toml secrets), not in frontend
2. **CORS**: Configure R2 bucket to allow CORS for your domain
3. **Authentication**: Consider adding auth for private GPX storage
4. **Rate Limiting**: Implement rate limiting in worker for public API

## Testing

### Test Route Planning
```javascript
// In browser console
const result = await window.hikeWorkerAPI.planRoute("Hiking trail in Yosemite");
console.log(result);
```

### Test GPX Upload
```javascript
// Upload a sample GPX
const sampleGPX = `<?xml version="1.0"?>...`;
const result = await window.hikeWorkerAPI.uploadGPX(sampleGPX);
console.log('Uploaded to:', result.key);
```

### Test Analysis
```javascript
const analysis = await window.hikeWorkerAPI.analyzeGPX('gpx/1234567890-uuid.gpx');
console.log(analysis);
```

## Debugging

### Check Worker Status
```bash
# Monitor worker logs
npm run tail

# Test worker directly
curl https://hike-worker.your-name.workers.dev/api/gpx
```

### Browser Console
```javascript
// Check if worker is loaded
console.log(window.hikeWorkerAPI);

// Test integration
window.hikeWorkerAPI.planRoute("Test query")
  .then(r => console.log(r))
  .catch(e => console.error(e));
```

## Migration from gmaps-import.js

The `gmaps-import.js` module is still useful for direct Google Maps link parsing. The Cloudflare Worker adds:

1. **AI Understanding** - Natural language queries
2. **Server-Side Processing** - Faster operations
3. **GPX Storage** - Save trails for later
4. **Analysis** - Get insights from GPX files

You can use both:
- For quick link parsing: Use `gmaps-import.js` directly in browser
- For complex queries and storage: Use `workerAPI`

## Troubleshooting

### Worker Not Responding
- Check if worker is deployed
- Verify URL is correct
- Check worker logs: `npm run tail`

### API Key Errors
- Verify secret is set: `wrangler secret list`
- Check key hasn't expired
- Try re-adding: `wrangler secret delete JINA_API_KEY && wrangler secret put JINA_API_KEY`

### GPX Upload Failures
- Check R2 bucket permissions
- Verify file size < 25MB
- Check browser console for CORS errors

## Next Steps

1. ✅ Deploy worker
2. ✅ Configure secrets
3. ✅ Update hike app configuration
4. ✅ Test integration
5. 🔄 Add authentication
6. 🔄 Implement analytics
7. 🔄 Add custom domain
8. 🔄 Set up monitoring

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [jina.ai API](https://jina.ai/)
- [OpenRouteService](https://openrouteservice.org/)
- [R2 Storage](https://developers.cloudflare.com/r2/)

## Support

For issues:
1. Check the worker logs: `npm run tail`
2. Review worker code in `worker.js`
3. Test API endpoints with curl
4. Check browser console for errors
5. Review Cloudflare status page

---

**Last Updated**: 2026-11-10
**Version**: 1.0.0
**Compatible with**: Hike GPX Viewer (app.js)