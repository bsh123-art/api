#!/bin/sh
set -e

echo "[entrypoint] Applying database migrations..."
npx prisma migrate deploy || {
  echo "[entrypoint] No migrations found — pushing schema instead."
  npx prisma db push --skip-generate
}

if [ "${RUN_SEED:-true}" = "true" ]; then
  echo "[entrypoint] Seeding baseline data (idempotent)..."
  node dist/prisma/seed.js || echo "[entrypoint] Seed skipped."
fi

echo "[entrypoint] Starting API..."
exec "$@"
