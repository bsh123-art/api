# syntax=docker/dockerfile:1

# --- Stage 1: install dependencies ------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm install --workspace @kopi-pos/api --include-workspace-root

# --- Stage 2: build ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json ./
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npx prisma generate && npm run build

# --- Stage 3: runtime -------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl postgresql16-client tini \
  && addgroup -g 1001 -S nodejs \
  && adduser -S -u 1001 -G nodejs kopi

COPY --from=deps    --chown=kopi:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=kopi:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=kopi:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=kopi:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=kopi:nodejs /app/apps/api/package.json ./apps/api/package.json
COPY --chown=kopi:nodejs apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/storage/backups && chown -R kopi:nodejs /app/storage

USER kopi
WORKDIR /app/apps/api
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
