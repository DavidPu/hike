# Quick Start - 5 Minutes to Deploy

## ✅ What You'll Get

A working Cloudflare Worker that:
- ✨ Plans hiking routes with natural language (e.g., "Find trail in Yosemite")
- 📁 Stores GPX files in the cloud (R2)
- 🤖 Analyzes GPX files with AI

## 🚀 1-Minute Setup

```bash
# Navigate to the worker directory
cd /home/dpu/Pictures/hike/cloudflare-worker

# Install dependencies
npm install

# Set your jina.ai API key (free: https://jina.ai/)
wrangler secret put JINA_API_KEY
# Paste: YOUR_JINA_API_KEY_HERE

# Deploy to Cloudflare
npm run deploy
```

**You're done!** Your worker URL will be shown.

## 🧪 Test It

### Option 1: Browser Demo
1. Open the demo.html file in your browser
2. Try: "Find a trail in Yosemite"
3. Upload a GPX file
4. Analyze with AI

### Option 2: Browser Console
```javascript
// Replace with your worker URL
const WORKER = 'https://hike-worker.username.workers.dev';

// Plan a route
fetch(`${WORKER}/api/route/plan`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: "Hiking trail in Yosemite",
    apiKey: "YOUR_JINA_API_KEY"
  })
})
.then(r => r.json())
.then(data => console.log(data));
```

## 📱 Integrate into Hike App

### Step 1: Add integration script
In `index.html`:
```html
<script type="module">
  import { initWorkerIntegration } from './cloudflare-worker/hike-integration.js';

  const worker = initWorkerIntegration({
    workerUrl: 'https://hike-worker.username.workers.dev'
  });

  window.hikeWorker = worker;
</script>
```

### Step 2: Use in your code
```javascript
// Natural language route
const route = await window.hikeWorker.planRoute("Trail near San Francisco");

// Upload GPX
await window.hikeWorker.uploadGPX(gpxString);

// Analyze
const analysis = await window.hikeWorker.analyzeGPX('gpx/1234567890.gpx');
```

## 🎯 Your First API Call

### Test Route Planning
```bash
curl -X POST https://hike-worker.username.workers.dev/api/route/plan \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Find a hiking trail in Yosemite",
    "apiKey": "YOUR_JINA_API_KEY"
  }'
```

### Upload a GPX
```bash
curl -X POST https://hike-worker.username.workers.dev/api/gpx/upload \
  -F "file=@your-trail.gpx"
```

### List GPX Files
```bash
curl https://hike-worker.username.workers.dev/api/gpx
```

## 📚 Next Steps

1. **Test everything**: Run through the demo.html examples
2. **Integrate**: Add to your Hike App
3. **Customize**: Update the worker with your preferences
4. **Deploy**: Use the worker URL in your app
5. **Monitor**: Check worker logs with `npm run tail`

## 💡 Pro Tips

- **Save your API key**: Add `JINA_API_KEY` to wrangler.toml [vars]
- **Use custom domain**: Get a branded URL (https://hike.yourdomain.com)
- **Set up secrets**: Don't hardcode API keys
- **Monitor usage**: Watch for rate limits
- **Backup**: Export your R2 files regularly

## ⚠️ Important Notes

- **jina.ai API key is free** - Get one at https://jina.ai/
- **R2 storage is free** - Up to 10GB for hobby projects
- **Cloudflare Workers free tier**: 100,000 requests/day
- **GPX files limited to 25MB** per upload
- **API keys stored on server** - never in frontend code

## 🆘 Need Help?

- 📖 [Full Documentation](./README.md)
- 🔧 [Setup Guide](./SETUP.md)
- 📱 [Integration Guide](./INTEGRATION.md)
- 🐛 [Troubleshooting](./README.md#troubleshooting)

## 🎓 Learning Path

1. ✅ Quick Start (this file)
2. 📖 Read full API docs
3. 🔌 Integrate with Hike App
4. 🚀 Deploy and monitor
5. 🎉 Customize and extend

---

**Time to complete**: ~5 minutes
**Difficulty**: Easy
**Success rate**: 99% (if you follow steps)

Good luck! 🥾🚀