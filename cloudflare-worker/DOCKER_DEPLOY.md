# Docker Deployment Guide for Cloudflare Worker

This guide explains how to deploy the Hike Cloudflare Worker using Docker.

## Quick Start (Docker)

### 1. Prepare Environment Variables

```bash
cd /home/dpu/Pictures/hike/cloudflare-worker

# Copy the example file
cp .env.example .env

# Edit .env and add your credentials
nano .env
```

**Required in .env**:
- `CLOUDFLARE_API_TOKEN` - From https://dash.cloudflare.com/profile/api-tokens
- `CLOUDFLARE_ACCOUNT_ID` - Find at bottom of dashboard

**Optional**:
- `JINA_API_KEY` - From https://jina.ai/
- `JINA_API_URL` - API endpoint (default: https://api.jina.ai/v1)

### 2. Build Docker Image

```bash
# Using simple Dockerfile
docker build -f Dockerfile.simple -t hike-worker:latest .

# Or using the full Dockerfile
docker build -t hike-worker:latest .
```

### 3. Deploy with Docker

```bash
# Using the deployment script
./deploy-docker.sh
```

Or manually:

```bash
docker run --rm \
    --env CLOUDFLARE_API_TOKEN=your_token \
    --env CLOUDFLARE_ACCOUNT_ID=your_account_id \
    --env JINA_API_KEY=your_jina_key \
    hike-worker:latest
```

## Alternative: Manual Docker Deployment

### Option 1: Using docker-compose

```bash
# Build and deploy
docker-compose up --build

# Or deploy only
docker-compose up --build deploy
```

### Option 2: One-Liner

```bash
docker run --rm \
  -e CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN \
  -e CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID \
  -e JINA_API_KEY=$JINA_API_KEY \
  -v $(pwd):/app \
  -w /app \
  node:22-alpine \
  npx wrangler deploy
```

## Dockerfile Options

### 1. Simple Dockerfile (`Dockerfile.simple`)
- Minimal setup
- Fast builds
- Good for quick testing

### 2. Full Dockerfile (`Dockerfile`)
- Includes wrangler installation
- Full dependency setup
- Production-ready

## Verification

After deployment, verify:

```bash
# Check worker logs
docker run --rm \
    --env CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN \
    --env CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID \
    hike-worker:latest npm run tail
```

Or access from Cloudflare dashboard:
https://dash.cloudflare.com/workers

## Troubleshooting

### Authentication Errors

Make sure your API token has these permissions:
- **Workers: Edit**
- **Account: Cloudflare Workers: Edit**
- **Account: R2: Edit** (for GPX storage)

### Build Errors

```bash
# Clean build
docker system prune -a
docker build --no-cache -t hike-worker:latest .
```

### Permission Errors

```bash
# Fix permissions
sudo chown -R $USER:$USER /home/dpu/Pictures/hike/cloudflare-worker
```

## Pushing to Docker Hub (Optional)

```bash
# Login to Docker Hub
docker login

# Tag image
docker tag hike-worker:latest yourusername/hike-worker:latest

# Push
docker push yourusername/hike-worker:latest
```

## Multi-Stage Build (Advanced)

For production, consider using a multi-stage build:

```dockerfile
# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY worker.js . wrangler.toml ./
RUN npm install -g wrangler@4.0.0 && \
    npm install

# Production stage
FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/worker.js ./
COPY --from=builder /app/wrangler.toml ./

CMD ["npx", "wrangler", "deploy"]
```

## Performance Tips

1. **Use .dockerignore** to exclude unnecessary files:
   ```
   node_modules
   .git
   *.md
   tests
   ```

2. **Cache npm dependencies**:
   ```dockerfile
   COPY package*.json ./
   RUN npm ci --prefer-offline
   COPY . .
   ```

3. **Use BuildKit** for faster builds:
   ```bash
   DOCKER_BUILDKIT=1 docker build -t hike-worker:latest .
   ```

## Security Notes

1. **Never commit .env** - Add to .gitignore
2. **Use secrets management** in production
3. **Rotate API tokens** regularly
4. **Limit Docker resource usage** if running multiple workers

---

**Last Updated**: 2026-11-10
**Version**: 1.0.0
**Docker Version**: 20.10+