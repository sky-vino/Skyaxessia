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

# ── sqlite3 native binary ────────────────────────────────────────────────────
# The CI zip intentionally ships WITHOUT a pre-built sqlite3 .node binary
# because the GitHub runner's glibc differs from Azure's. We rebuild once
# and cache the result under /home (persistent across restarts/redeploys).
#
# Cache key = deploy SHA so a new deploy always rebuilds.
DEPLOY_SHA=$(grep '^commit=' /home/site/wwwroot/.deploy-sha 2>/dev/null | cut -d= -f2 || echo "unknown")
SQLITE_CACHE_DIR="/home/site/sqlite3-cache"
SQLITE_CACHE_MARKER="$SQLITE_CACHE_DIR/.built-for-$DEPLOY_SHA"
SQLITE3_BUILD_DIR="/home/site/wwwroot/backend/node_modules/sqlite3"

if [ -f "$SQLITE_CACHE_MARKER" ] && [ -d "$SQLITE_CACHE_DIR/build" ]; then
  echo "==> sqlite3: cache hit for $DEPLOY_SHA — copying from cache"
  cp -r "$SQLITE_CACHE_DIR/build" "$SQLITE3_BUILD_DIR/"
else
  echo "==> sqlite3: no cache for $DEPLOY_SHA — rebuilding from source (~60s)"
  cd "$SQLITE3_BUILD_DIR"
  # Install build tools if missing (they are present on Azure App Service Linux)
  npm rebuild sqlite3 --build-from-source 2>&1 | tail -5
  cd /home/site/wwwroot

  # Cache the result
  mkdir -p "$SQLITE_CACHE_DIR"
  rm -f "$SQLITE_CACHE_DIR"/.built-for-*   # remove old markers
  cp -r "$SQLITE3_BUILD_DIR/build" "$SQLITE_CACHE_DIR/"
  touch "$SQLITE_CACHE_MARKER"
  echo "==> sqlite3: rebuild complete and cached"
fi

# ── Verify sqlite3 loads ─────────────────────────────────────────────────────
node -e "require('sqlite3'); console.log('sqlite3 OK')" \
  --require /home/site/wwwroot/backend/node_modules/sqlite3/lib/sqlite3.js \
  2>/dev/null || \
node -e "require('/home/site/wwwroot/backend/node_modules/sqlite3'); console.log('sqlite3 OK')"

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
