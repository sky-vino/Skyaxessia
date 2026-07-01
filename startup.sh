#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Axessia - Azure App Service startup script
#
# Configured as the App Service "Startup Command":
#     bash /home/site/wwwroot/startup.sh
#
# IMPORTANT DESIGN NOTE
#   Azure App Service Linux containers are EPHEMERAL. Everything outside
#   /home is discarded on every container restart, including anything you
#   installed via apt. That means we MUST reinstall Chromium's system
#   libraries on every boot, not just the first one. apt-get install is
#   idempotent and takes ~5-15s on subsequent boots because packages are
#   already downloaded in the base image or apt cache.
#
#   The one thing we DO cache on /home is heavy binary content that isn't
#   part of a system package: Playwright's Chromium bundle and the SQLite
#   database. Those persist correctly.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/home/site/wwwroot
LOG_PREFIX="[axessia-startup]"

log() { echo "$LOG_PREFIX $*"; }

log "Starting Axessia at $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
log "Working directory: $APP_DIR"
log "Node version: $(node --version 2>&1)"
log "GLIBC version: $(ldd --version 2>&1 | head -1 || echo unknown)"

cd "$APP_DIR"

if [ -f ".deploy-sha" ]; then
  log "Deployment stamp:"
  sed 's/^/  /' .deploy-sha || true
fi

# Delete the stale marker from earlier versions of this script; it was on
# /home (persistent) but tracked apt installs (ephemeral) - a design bug.
rm -f /home/.chromium-libs-installed 2>/dev/null || true

# ---------------------------------------------------------------------------
# [1/6] Chromium system libraries (INSTALLED ON EVERY BOOT).
# Fast (5-15s) on subsequent boots because packages are already present in
# the base image / apt cache. Do NOT gate this behind a marker on /home -
# the container is ephemeral, the marker would lie.
# ---------------------------------------------------------------------------
log "[1/6] Ensuring Chromium system libraries are installed..."
apt-get update -qq 2>&1 | tail -2 || log "  warn: apt-get update failed; continuing."

apt-get install -y --no-install-recommends -qq \
    libglib2.0-0 \
    libnss3 libnspr4 \
    libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libcups2 libdrm2 libdbus-1-3 \
    libxcb1 libxkbcommon0 libx11-6 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxrandr2 libxrender1 libxtst6 \
    libgbm1 libgtk-3-0 libgdk-pixbuf-2.0-0 \
    libpango-1.0-0 libpangocairo-1.0-0 libcairo2 \
    libasound2 \
    fonts-liberation ca-certificates 2>&1 | tail -3 \
    || log "  warn: some Chromium libraries could not be installed."

# Verify libglib specifically — this was the missing lib on the previous
# failed boot. If it's still not in the loader cache, log loudly so it's
# easy to catch during a live log-stream review.
if ldconfig -p 2>/dev/null | grep -q "libglib-2.0.so.0"; then
    log "[1/6] libglib-2.0.so.0 present in loader cache."
else
    log "[1/6] ERROR: libglib-2.0.so.0 still missing after apt install."
    log "[1/6] apt policy libglib2.0-0:"
    apt-cache policy libglib2.0-0 2>&1 | head -8 | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# [2/6] Backend node_modules (shipped in the artifact, verified here)
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  log "[2/6] node_modules missing - installing production dependencies..."
  npm ci --omit=dev --no-audit --no-fund --prefer-offline 2>&1 | tail -5 \
    || npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
else
  log "[2/6] Backend node_modules already present."
fi

# ---------------------------------------------------------------------------
# [3/6] Verify sqlite3 native binary is compatible with this GLIBC.
#       If it fails to load, install build tools and rebuild from source.
# ---------------------------------------------------------------------------
log "[3/6] Verifying sqlite3 native binary..."

if node -e "require('sqlite3');" 2>/tmp/sqlite3-check.err; then
  log "[3/6] sqlite3 loads successfully."
else
  log "[3/6] sqlite3 failed to load. Error was:"
  sed 's/^/  /' /tmp/sqlite3-check.err | head -5
  log "[3/6] Rebuilding sqlite3 from source (one-time, ~3 min)..."

  apt-get install -y --no-install-recommends -qq \
      python3 make g++ gcc libsqlite3-dev 2>&1 | tail -3 \
      || log "  warn: some build tools could not be installed."

  npm rebuild sqlite3 --build-from-source 2>&1 | tail -8 \
    || log "[3/6] sqlite3 rebuild failed. Backend will crash on DB access."

  if node -e "require('sqlite3'); console.log('sqlite3 OK');" 2>&1; then
    log "[3/6] sqlite3 rebuild verified."
  else
    log "[3/6] ERROR: sqlite3 still fails to load after rebuild."
  fi
fi

# ---------------------------------------------------------------------------
# [4/6] Backend compiled dist (shipped in the artifact; rebuild if missing)
# ---------------------------------------------------------------------------
if [ ! -f dist/index.js ]; then
  log "[4/6] dist/index.js missing - compiling TypeScript..."
  npm install --no-save --no-audit --no-fund typescript@5.8.3 @types/node@22 \
      @types/express @types/cors @types/compression @types/morgan @types/ws \
      @types/bcryptjs @types/jsonwebtoken @types/uuid 2>&1 | tail -3
  ./node_modules/.bin/tsc -p tsconfig.json
  log "[4/6] TypeScript build finished."
else
  log "[4/6] Backend dist already compiled."
fi

# ---------------------------------------------------------------------------
# [5/6] Playwright Chromium (persistent under /home).
# Both 'chromium' and 'chrome-headless-shell' binaries are needed - Playwright
# picks headless-shell for headless: true launches (which is what we do).
# We also do a smoke-test on chrome-headless-shell so we catch missing libs
# BEFORE the first scan tries to use it.
# ---------------------------------------------------------------------------
export PLAYWRIGHT_BROWSERS_PATH="/home/playwright-browsers"
BUNDLED_BROWSERS_DIR="$APP_DIR/playwright-browsers"

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

if [ -d "$BUNDLED_BROWSERS_DIR" ] && [ -n "$(ls -A "$BUNDLED_BROWSERS_DIR" 2>/dev/null || true)" ]; then
  # Copy bundled browsers into persistent location on first boot (or if we
  # somehow ended up with an empty persistent dir).
  if ! ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium-* >/dev/null 2>&1 \
     || ! ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-* >/dev/null 2>&1; then
    log "[5/6] Copying bundled Playwright browsers to $PLAYWRIGHT_BROWSERS_PATH ..."
    cp -a "$BUNDLED_BROWSERS_DIR"/. "$PLAYWRIGHT_BROWSERS_PATH"/
    chmod -R a+rx "$PLAYWRIGHT_BROWSERS_PATH"
    log "[5/6] Bundled Playwright browsers copied."
  fi
fi

EXPECTED_BROWSER="$(node -e "process.stdout.write(require('playwright').chromium.executablePath())" 2>/dev/null || echo "")"
log "[5/6] Playwright expects Chromium at: ${EXPECTED_BROWSER:-<unknown>}"

if [ -z "$EXPECTED_BROWSER" ] || [ ! -x "$EXPECTED_BROWSER" ]; then
  log "[5/6] Chromium not found at expected path - running 'playwright install chromium'..."
  ./node_modules/.bin/playwright install chromium 2>&1 | tail -6
fi

# Also verify chrome-headless-shell (used for headless launches). Find it,
# then ldd it to make sure all shared libraries can be resolved.
HEADLESS_SHELL="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name 'chrome-headless-shell' 2>/dev/null | head -1)"
if [ -n "$HEADLESS_SHELL" ] && [ -x "$HEADLESS_SHELL" ]; then
  log "[5/6] Verifying shared libraries for chrome-headless-shell..."
  MISSING_LIBS="$(ldd "$HEADLESS_SHELL" 2>/dev/null | grep 'not found' | awk '{print $1}' | sort -u || true)"
  if [ -n "$MISSING_LIBS" ]; then
    log "[5/6] MISSING SHARED LIBRARIES for chrome-headless-shell:"
    echo "$MISSING_LIBS" | sed 's/^/    /'
    log "[5/6] Attempting playwright install-deps as a fallback..."
    ./node_modules/.bin/playwright install-deps chromium 2>&1 | tail -8 \
      || log "  warn: playwright install-deps failed."
    # Re-check
    MISSING_AFTER="$(ldd "$HEADLESS_SHELL" 2>/dev/null | grep 'not found' | awk '{print $1}' | sort -u || true)"
    if [ -n "$MISSING_AFTER" ]; then
      log "[5/6] Still missing after install-deps: $MISSING_AFTER"
    else
      log "[5/6] All shared libraries now resolved."
    fi
  else
    log "[5/6] All shared libraries resolved for chrome-headless-shell."
  fi
else
  log "[5/6] WARNING: chrome-headless-shell binary not found. Headless scans will fail."
fi

# ---------------------------------------------------------------------------
# [6/6] Persistent data directory + launch
# ---------------------------------------------------------------------------
mkdir -p /home/data
log "[6/6] Persistent data directory ready at /home/data."

cd "$APP_DIR/backend"
log "Launching backend on PORT=${PORT:-4000} ..."
exec node dist/index.js
