# ========================================
# Base Stage: Alpine Linux with Node
# ========================================
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# ========================================
# Builder Stage: Build the Application
# ========================================
FROM base AS builder
WORKDIR /app

RUN npm install -g pnpm wrangler

# Copy workspace configuration and source code
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY . .

ENV CI=true

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Set environment variables for build
# VITE_PUBLIC_* vars use placeholder URLs that get replaced at runtime by entrypoint.sh
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    DOCKER_BUILD=true \
    VITE_PUBLIC_BACKEND_URL=http://REPLACE-BACKEND-URL.com \
    VITE_PUBLIC_APP_URL=http://REPLACE-APP-URL.com

# Build the application
RUN cd apps/mail && NODE_OPTIONS="--max-old-space-size=1536" pnpm run build

# ========================================
# Runner Stage: Production Environment
# ========================================
FROM base AS runner
WORKDIR /app

RUN addgroup -S -g 1001 pnpm && \
    adduser -S -u 1001 nextjs -G pnpm

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME="0.0.0.0"

# Copy entrypoint scripts
COPY scripts/docker/ /app/scripts
RUN chmod -R +x /app/scripts/*

# Copy static server
COPY docker/app/server.js /app/server.js

# Copy only the built client assets (SPA)
COPY --from=builder --chown=nextjs:pnpm /app/apps/mail/build/client /app/apps/mail/build/client

# Switch to non-root user
USER nextjs

# Set server port and host
EXPOSE 3000

# Start the server
CMD ["/app/scripts/entrypoint.sh"]
