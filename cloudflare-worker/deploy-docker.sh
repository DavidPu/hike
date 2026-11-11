#!/bin/bash

# Docker Deployment Script for Cloudflare Worker
set -e

echo "🚀 Deploying Hike Cloudflare Worker with Docker..."
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠ .env file not found${NC}"
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo -e "${YELLOW}⚠ Please edit .env and add your API tokens${NC}"
    exit 1
fi

# Load environment variables
echo -e "${BLUE}📂 Loading environment variables...${NC}"
set -a
source .env
set +a

# Check for required credentials
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo -e "${YELLOW}⚠ CLOUDFLARE_API_TOKEN not set${NC}"
    exit 1
fi

if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    echo -e "${YELLOW}⚠ CLOUDFLARE_ACCOUNT_ID not set${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Environment variables loaded${NC}"

# Build Docker image
echo -e "${BLUE}📦 Building Docker image...${NC}"
docker build -t hike-worker:latest .

# Deploy
echo -e "${BLUE}☁️ Deploying to Cloudflare Workers...${NC}"

docker run --rm \
    --env CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN \
    --env CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID \
    --env JINA_API_KEY=$JINA_API_KEY \
    --env JINA_API_URL=$JINA_API_URL \
    hike-worker:latest

echo ""
echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "Check your worker at: https://dash.cloudflare.com/workers"

# Show worker URL
echo ""
echo -e "${BLUE}📋 Your Worker URL:${NC}"
curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | \
    grep -o '"name":"[^"]*"' | head -1