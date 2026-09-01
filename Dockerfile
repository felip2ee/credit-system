FROM node:22.23.2-alpine3.23 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22.23.2-alpine3.23 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-only, non-production placeholders. Runtime secrets are never image env.
ENV DATABASE_URL=postgres://build:placeholder@localhost:5432/build \
    BETTER_AUTH_SECRET=build-only-placeholder-not-a-production-secret \
    BETTER_AUTH_URL=https://build.invalid \
    DOCUMENT_ROOT=/tmp/documents \
    CLAMAV_HOST=localhost \
    CLAMAV_PORT=3310 \
    SMTP_HOST=localhost \
    SMTP_PORT=465 \
    SMTP_SECURE=true \
    SMTP_USER=build \
    SMTP_PASS=build-only-placeholder \
    TRAEFIK_PROXY_CIDR=10.0.0.0/8 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22.23.2-alpine3.23 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs \
 && adduser -S -D -H -u 1001 -G nodejs nextjs \
 && mkdir -p /var/lib/reino/documents \
 && chown 1001:1001 /var/lib/reino/documents

COPY --from=builder --chown=1001:1001 /app/public ./public
COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1001:1001 /app/scripts/db/migrate.mjs ./scripts/db/migrate.mjs
COPY --from=builder --chown=1001:1001 /app/db/migrations ./db/migrations
COPY --from=builder --chown=1001:1001 /app/src/lib/runtime-secrets.mjs ./src/lib/runtime-secrets.mjs
COPY --chown=1001:1001 docker/app-entrypoint.sh ./app-entrypoint.sh
RUN chmod 0555 ./app-entrypoint.sh

USER 1001:1001
EXPOSE 3000
# Applies migrations, then starts the server (see docker/app-entrypoint.sh).
CMD ["./app-entrypoint.sh"]
