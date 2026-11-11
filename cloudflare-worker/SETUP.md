# Quick Setup Guide for Cloudflare Worker

## 1. Prerequisites

- Node.js 18+ installed
- Cloudflare account with Workers access
- jina.ai API key (free at https://jina.ai/)
- OpenRouteService API key (free at https://openrouteservice.org/dev/#/signup)

## 2. Install Dependencies

```bash
cd cloudflare-worker
npm install
```

## 3. Configure Credentials

### 3.1 Edit wrangler.toml

Replace the placeholder API keys with your real ones:

```toml
[vars]
JINA_API_URL = "https://api.jina.ai/v1"
OPENROUTESERVICE_API_KEY = "your-ors-api-key-here"
```

### 3.2 Set jina.ai API Key as Secret

```bash
wrangler secret put JINA_API_KEY
# Enter your jina.ai API key when prompted
```

### 3.3 Set OpenRouteService API Key as Secret (Optional)

If you want to use OpenRouteService without jina.ai:

```bash
wrangler secret put OPENROUTESERVICE_API_KEY
# Enter your ORS API key when prompted
```

## 4. Deploy to Cloudflare Workers

```bash
npm run deploy
```

This will output your worker URL, e.g.:
```
✨ Successfully deployed
https://hike-worker.username.workers.dev
```

## 5. Test the Worker

### Option A: Using the Demo Page

1. Open your worker URL in a browser
2. You'll be redirected to the demo page
3. Try the examples:
   - Enter "Find a hiking trail from San Francisco to Mt. Tamalpais" and click "Plan Route"
   - Upload a GPX file to test storage
   - Analyze a GPX file with AI

### Option B: Using curl

```bash
# Test route planning with AI
curl -X POST https://hike-worker.username.workers.dev/api/route/plan \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Find a hiking trail from San Francisco to Mt. Tamalpais",
    "apiKey": "your-jina-api-key"
  }'

# List GPX files
curl https://hike-worker.username.workers.dev/api/gpx

# Upload a GPX file (use -F for multipart)
curl -X POST https://hike-worker.username.workers.dev/api/gpx/upload \
  -F "file=@/path/to/your-trail.gpx"
```

### Option C: Using JavaScript in Browser

```javascript
import { planRouteWithAI, uploadGPX, analyzeGPX } from './cloudflare-worker/frontend-integration.js';

// Natural language route planning
const result = await planRouteWithAI("Find a scenic hiking trail near Yosemite");

// Upload GPX
await uploadGPX(gpxString);

// Analyze GPX
const analysis = await analyzeGPX('gpx/1234567890-uuid.gpx');
```

## 6. Local Development

### Run the Demo Page Locally

```bash
node dev-server.js
```

Open http://localhost:3000 in your browser.

### Monitor Worker Logs

```bash
npm run tail
```

This shows real-time logs from your deployed worker.

## 7. Environment Variables Reference

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `JINA_API_KEY` | secret | Yes | Your jina.ai API key |
| `JINA_API_URL` | string | No | jina.ai API endpoint (default: https://api.jina.ai/v1) |
| `OPENROUTESERVICE_API_KEY` | secret | No | OpenRouteService API key |
| `R2_BUCKET_NAME` | string | No | R2 bucket name (default: hike-gpx-files) |

## 8. Troubleshooting

### Worker won't deploy

- Check that wrangler.toml has the correct account_id
- Verify your Cloudflare account has Workers access
- Try `wrangler whoami` to check authentication

### Route planning not working

- Verify jina.ai API key is set correctly
- Check that the key has not expired
- Ensure jina.ai API is accessible from your region

### GPX uploads failing

- Check R2 bucket exists (create if needed in Cloudflare dashboard)
- Verify file size is under R2's size limit (default: 25MB per object)
- Check CORS settings in R2 (should be fine with public bucket)

### API returns 401 Unauthorized

- Secret was not set correctly
- Try `wrangler secret delete JINA_API_KEY` and re-add it

## 9. Next Steps

- Add custom domain to your worker
- Set up custom domain with SSL certificate
- Add authentication (e.g., Cloudflare Access)
- Implement rate limiting
- Add analytics tracking
- Configure R2 lifecycle rules for auto-archiving old files

## 10. Support

For issues:
1. Check the main README.md for detailed API documentation
2. Review Cloudflare Workers documentation
3. Check jina.ai API documentation
4. Review the Hike App GitHub repository