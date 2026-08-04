# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS web-runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/asteria/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

FROM node:24-bookworm-slim AS worker-dependencies
WORKDIR /app
COPY worker-runtime/package.json worker-runtime/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS worker-runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=worker-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/config ./config
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/scripts/build-traffic-snapshot.ts /app/scripts/run-traffic-snapshot-worker.ts /app/scripts/check-snapshot-worker-health.ts ./scripts/

USER node
CMD ["node", "--import", "tsx", "scripts/run-traffic-snapshot-worker.ts"]
