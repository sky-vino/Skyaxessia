#!/bin/bash
# -----------------------------------------------------------------------------
# Axessia — Azure App Service startup script
# Set as Azure Startup Command: bash /home/site/wwwroot/startup.sh
# -----------------------------------------------------------------------------
set -e
echo "==> Axessia startup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat /home/site/wwwroot/.deploy-sha 2>/dev/null || echo "(no deploy stamp)"

cd /home/site/wwwroot

# ── Playwright browsers ──────────────────────────────────────────────────────
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/site/wwwroot/playwright-browsers}"
echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"

# ── Static frontend ──────────────────────────────────────────────────────────
export STATIC_DIR="${STATIC_DIR:-/home/site/wwwroot/frontend/dist}"
echo "STATIC_DIR=$STATIC_DIR"

# ── Persistent data dir ──────────────────────────────────────────────────────
mkdir -p /home/site/data
export SQLITE_PATH="${SQLITE_PATH:-/home/site/data/accessibility.sqlite}"
export DATABASE_URL="${DATABASE_URL:-sqlite://$SQLITE_PATH}"

# ── Verify sqlite3 loads ─────────────────────────────────────────────────────
# sqlite3 was compiled inside node:22-bookworm (Debian 12, GLIBC 2.36) during
# CI, which matches this Azure runtime exactly — so it must load cleanly here.
# If it doesn't, something is wrong with the artifact.
echo "==> Verifying sqlite3 binary..."
cd /home/site/wwwroot/backend
node -e "require('sqlite3'); console.log('sqlite3 OK')" || {
  echo "ERROR: sqlite3 failed to load. The CI artifact may have been built on"
  echo "the wrong runner. Check that the workflow uses container: node:22-bookworm"
  exit 1
}

# ── Sanity checks ────────────────────────────────────────────────────────────
echo "==> Deploy contents:"
ls -la /home/site/wwwroot | head -20
echo "==> Backend dist:"
ls -la /home/site/wwwroot/backend/dist | head -5 || echo "(missing)"
echo "==> Frontend dist:"
ls -la /home/site/wwwroot/frontend/dist | head -5 || echo "(missing)"

# ── Launch ───────────────────────────────────────────────────────────────────
cd /home/site/wwwroot/backend
echo "==> Launching: node dist/index.js on port $PORT"
exec node dist/index.js
