# Cloudflare Worker Dockerfile
# Based on official Cloudflare Docker images

FROM node:22-alpine AS builder

WORKDIR /app

# Install Node.js dependencies
COPY package.json ./
RUN npm install

# Copy worker code
COPY worker.js .
COPY wrangler.toml ./

# Install wrangler globally
RUN npm install -g wrangler@4.0.0

# Create config directory
RUN mkdir -p .wrangler

# Build image
FROM node:22-alpine

WORKDIR /app

# Copy from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/wrangler.toml ./
COPY --from=builder /app/worker.js ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.wrangler ./ .wrangler

# Set environment variables if provided
ARG CLOUDFLARE_API_TOKEN
ARG CLOUDFLARE_ACCOUNT_ID
ENV CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}
ENV CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}

# Install wrangler
RUN npm install -g wrangler@4.0.0

# Expose port (optional for some Workers)
# EXPOSE 8787

# Command to deploy
CMD ["npx", "wrangler", "deploy"]