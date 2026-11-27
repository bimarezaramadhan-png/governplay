# Multi-stage build for client and server
FROM node:22-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-slim AS server-builder
WORKDIR /app/server
RUN apt-get update && apt-get install -y python3 make g++ gcc openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN node prisma/setup.js && npx prisma generate
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/bimarezaramadhan-png/governplay"
LABEL org.opencontainers.image.description="The People's Assembly (TPA) - Real-time Governance Simulation"

RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy built server code, schema, and node_modules
COPY --from=server-builder /app/server/package*.json ./server/
COPY --from=server-builder /app/server/dist ./server/dist
COPY --from=server-builder /app/server/prisma ./server/prisma
COPY --from=server-builder /app/server/node_modules ./server/node_modules
COPY --from=server-builder /app/server/prisma.config.ts ./server/
COPY --from=server-builder /app/server/tsconfig.json ./server/

# Copy built client static assets
COPY --from=client-builder /app/client/dist ./client/dist

WORKDIR /app/server

# Expose game port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV OFFLINE_MODE=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

# Prepare db schema and launch server conditionally (only push DB schema automatically in offline mode)
CMD ["sh", "-c", "node prisma/setup.js && npx prisma generate && { if [ \"$OFFLINE_MODE\" != \"false\" ]; then npx prisma db push; else echo '[Prisma Setup] Skipping automatic db push in online mode'; fi; } && node dist/index.js"]
