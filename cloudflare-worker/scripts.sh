#!/bin/bash

# Cloudflare Worker Helper Script
# Common tasks for the Hike Worker project

set -e

WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKER_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
print_usage() {
    echo "Hike Cloudflare Worker Helper"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  install    Install dependencies"
    echo "  dev        Run development server"
    echo "  deploy     Deploy to Cloudflare"
    echo "  tail       View worker logs"
    echo "  test       Run tests"
    echo "  clean      Clean up files"
    echo ""
    exit 1
}

install_deps() {
    echo -e "${BLUE}Installing dependencies...${NC}"
    npm install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
}

start_dev() {
    echo -e "${BLUE}Starting development server...${NC}"
    echo -e "${YELLOW}Demo available at: http://localhost:3000${NC}"
    node dev-server.js
}

deploy() {
    echo -e "${BLUE}Deploying to Cloudflare Workers...${NC}"

    # Check if wrangler is installed
    if ! command -v wrangler &> /dev/null; then
        echo -e "${RED}Error: wrangler CLI not found${NC}"
        echo "Install with: npm install -g wrangler"
        exit 1
    fi

    # Check if secrets are set
    echo -e "${BLUE}Checking secrets...${NC}"
    wrangler secret list | grep -q "JINA_API_KEY" || {
        echo -e "${YELLOW}Warning: JINA_API_KEY secret not found${NC}"
        echo "Run: wrangler secret put JINA_API_KEY"
        echo "Then re-run this command."
        exit 1
    }

    # Deploy
    npm run deploy
}

view_logs() {
    echo -e "${BLUE}Viewing worker logs...${NC}"
    echo "Press Ctrl+C to exit"
    npm run tail
}

test_integration() {
    echo -e "${BLUE}Testing worker integration...${NC}"

    if [ ! -f "wrangler.toml" ]; then
        echo -e "${RED}Error: wrangler.toml not found${NC}"
        exit 1
    fi

    echo -e "${YELLOW}Step 1: Install dependencies${NC}"
    npm install

    echo -e "${YELLOW}Step 2: Set JINA_API_KEY secret${NC}"
    echo "Enter your jina.ai API key:"
    wrangler secret put JINA_API_KEY

    echo -e "${YELLOW}Step 3: Deploy${NC}"
    npm run deploy

    echo -e "${GREEN}✓ Deployment complete!${NC}"
    echo -e "${BLUE}Test your worker at the URL shown above${NC}"
}

clean_files() {
    echo -e "${BLUE}Cleaning up files...${NC}"

    # Remove node_modules
    if [ -d "node_modules" ]; then
        echo "Removing node_modules..."
        rm -rf node_modules
    fi

    # Remove .wrangler directory
    if [ -d ".wrangler" ]; then
        echo "Removing .wrangler..."
        rm -rf .wrangler
    fi

    # Remove package-lock.json (optional)
    if [ -f "package-lock.json" ]; then
        echo "Removing package-lock.json..."
        rm package-lock.json
    fi

    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

# Main script
case "${1:-}" in
    install)
        install_deps
        ;;
    dev)
        start_dev
        ;;
    deploy)
        deploy
        ;;
    tail)
        view_logs
        ;;
    test)
        test_integration
        ;;
    clean)
        clean_files
        ;;
    help|--help|-h)
        print_usage
        ;;
    *)
        print_usage
        ;;
esac