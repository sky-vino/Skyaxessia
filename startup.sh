#!/bin/bash
# -----------------------------------------------------------------------------
# Axessia — Azure App Service startup script
# Set as Azure Startup Command: bash /home/site/wwwroot/startup.sh
# -----------------------------------------------------------------------------
set -e

echo "==> Axessia startup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat /home/site/wwwroot/.deploy-sha 2>/dev/null || echo "(no deploy stamp)"

# App Service mounts our deploy artifact under /home/site/wwwroot
cd /home/site/wwwroot

# Point Playwright at the browsers we packaged during CI.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/site/wwwroot/playwright-browsers}"
echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"

# Static frontend dir — backend/src/index.ts already looks here by default,
# but STATIC_DIR overrides so we set it explicitly.
export STATIC_DIR="${STATIC_DIR:-/home/site/wwwroot/frontend/dist}"
echo "STATIC_DIR=$STATIC_DIR"

# Give the writable data dir a home under /home so it persists across restarts.
mkdir -p /home/site/data
export SQLITE_PATH="${SQLITE_PATH:-/home/site/data/accessibility.sqlite}"
export DATABASE_URL="${DATABASE_URL:-sqlite://$SQLITE_PATH}"

# Sanity checks
echo "==> Deploy contents:"
ls -la /home/site/wwwroot | head -30
echo "==> Backend dist:"
ls -la /home/site/wwwroot/backend/dist | head -5 || echo "(missing)"
echo "==> Frontend dist:"
ls -la /home/site/wwwroot/frontend/dist | head -5 || echo "(missing)"

# Boot the compiled backend. Azure sets $PORT dynamically.
cd /home/site/wwwroot/backend
echo "==> Launching: node dist/index.js on port $PORT"
exec node dist/index.js
