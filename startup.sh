#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Axessia — Azure App Service startup script
#
# Configured as the App Service "Startup Command":
#     bash /home/site/wwwroot/startup.sh
#
# On first boot this script installs Chromium system libraries and puts the
# Playwright Chromium bundle under /home/playwright-browsers (persistent).
# Subsequent boots take ~30 seconds because everything heavy is cached
# on the /home mount (Azure Files).
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/home/site/wwwroot
LOG_PREFIX="[axessia-startup]"

log() { echo "$LOG_PREFIX $*"; }

log "Starting Axessia at $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
log "Working directory: $APP_DIR"
log "Node version: $(node --version 2>&1)"

cd "$APP_DIR"

if [ -f ".deploy-sha" ]; then
  log "Deployment stamp:"
  sed 's/^/  /' .deploy-sha || true
fi

# ---------------------------------------------------------------------------
# [1/5] System libraries required by Chromium
# ---------------------------------------------------------------------------
CHROMIUM_MARKER=/home/.chromium-libs-installed
if [ ! -f "$CHROMIUM_MARKER" ]; then
  log "[1/5] Installing Chromium system libraries (first boot only, ~2 min)..."
  apt-get update -qq 2>&1 | tail -2 || log "  warn: apt-get update failed; continuing."
  apt-get install -y --no-install-recommends -qq \
      libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 libx11-6 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
      libgtk-3-0 fonts-liberation 2>&1 | tail -3 \
      || log "  warn: some Chromium libraries could not be installed."
  touch "$CHROMIUM_MARKER"
  log "[1/5] Chromium system libraries installed."
else
  log "[1/5] Chromium system libraries already present."
fi

# ---------------------------------------------------------------------------
# [2/5] Backend node_modules (shipped in the artifact, verified here)
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  log "[2/5] node_modules missing — installing production dependencies..."
  npm ci --omit=dev --no-audit --no-fund --prefer-offline 2>&1 | tail -5 \
    || npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
else
  log "[2/5] Backend node_modules already present."
fi

# ---------------------------------------------------------------------------
# [3/5] Backend compiled dist (shipped in the artifact; rebuild if missing)
# ---------------------------------------------------------------------------
if [ ! -f dist/index.js ]; then
  log "[3/5] dist/index.js missing — compiling TypeScript..."
  npm install --no-save --no-audit --no-fund typescript@5.8.3 @types/node@22 \
      @types/express @types/cors @types/compression @types/morgan @types/ws \
      @types/bcryptjs @types/jsonwebtoken @types/uuid 2>&1 | tail -3
  ./node_modules/.bin/tsc -p tsconfig.json
  log "[3/5] TypeScript build finished."
else
  log "[3/5] Backend dist already compiled."
fi

# ---------------------------------------------------------------------------
# [4/5] Playwright Chromium (persistent under /home)
# ---------------------------------------------------------------------------
export PLAYWRIGHT_BROWSERS_PATH="/home/playwright-browsers"
BUNDLED_BROWSERS_DIR="$APP_DIR/playwright-browsers"

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

# Fast path: copy Chromium from the deploy artifact into the persistent
# mount so we never have to download it at boot.
if [ -d "$BUNDLED_BROWSERS_DIR" ] && [ -n "$(ls -A "$BUNDLED_BROWSERS_DIR" 2>/dev/null || true)" ]; then
  # Only copy anything that isn't already under /home/playwright-browsers.
  if ! ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium-* >/dev/null 2>&1; then
    log "[4/5] Copying bundled Playwright browsers to $PLAYWRIGHT_BROWSERS_PATH ..."
    cp -a "$BUNDLED_BROWSERS_DIR"/. "$PLAYWRIGHT_BROWSERS_PATH"/
    chmod -R a+rx "$PLAYWRIGHT_BROWSERS_PATH"
    log "[4/5] Bundled Playwright browsers copied."
  fi
fi

# Ask the installed Playwright package for the exact Chromium build it needs.
EXPECTED_BROWSER="$(node -e "process.stdout.write(require('playwright').chromium.executablePath())" 2>/dev/null || echo "")"

log "[4/5] Playwright expects Chromium at: ${EXPECTED_BROWSER:-<unknown>}"

if [ -z "$EXPECTED_BROWSER" ] || [ ! -x "$EXPECTED_BROWSER" ]; then
  log "[4/5] Chromium not found at expected path — running 'playwright install chromium'..."
  ./node_modules/.bin/playwright install chromium 2>&1 | tail -6
  log "[4/5] Playwright install finished."
else
  log "[4/5] Playwright Chromium already present."
fi

# ---------------------------------------------------------------------------
# [5/5] Persistent data directory + launch
# ---------------------------------------------------------------------------
mkdir -p /home/data
log "[5/5] Persistent data directory ready at /home/data."

cd "$APP_DIR/backend"
log "Launching backend on PORT=${PORT:-4000} ..."
exec node dist/index.js
