#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Axessia - Azure App Service startup script
# ---------------------------------------------------------------------------
# Configured as the App Service "Startup Command":
#     bash /home/site/wwwroot/startup.sh
#
# Design notes:
#   * Azure App Service Linux containers are EPHEMERAL. Everything outside
#     /home is discarded on every container restart. apt-installed packages
#     don't persist, so we reinstall on every boot. apt is idempotent and
#     takes ~5-15s once packages are already in the base image.
#
#   * We launch the backend under Xvfb (virtual X display). This lets full
#     Chromium (not chrome-headless-shell) run in `headless: false` mode.
#     Full Chromium is much harder for bot detectors like Sky iD, Cloudflare
#     Turnstile, and Akamai Bot Manager to fingerprint.
#
#   * Playwright's Chromium bundle and the SQLite database live on /home
#     (persistent Azure Files) so they survive container restarts.
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

# Delete stale marker from earlier script versions (marker was on /home but
# tracked apt state — a design bug now removed).
rm -f /home/.chromium-libs-installed 2>/dev/null || true

# ---------------------------------------------------------------------------
# [1/7] System libraries required by Chromium + Xvfb virtual display server
# ---------------------------------------------------------------------------
log "[1/7] Ensuring Chromium system libraries + Xvfb are installed..."
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
    fonts-liberation ca-certificates \
    xvfb dbus-x11 xauth 2>&1 | tail -3 \
    || log "  warn: some packages could not be installed."

if ldconfig -p 2>/dev/null | grep -q "libglib-2.0.so.0"; then
    log "[1/7] libglib-2.0.so.0 present in loader cache."
else
    log "[1/7] ERROR: libglib-2.0.so.0 still missing after apt install."
fi

if command -v xvfb-run >/dev/null 2>&1; then
    log "[1/7] Xvfb virtual display server available: $(which xvfb-run)"
else
    log "[1/7] WARNING: xvfb-run not found. Full Chromium will fail to launch."
fi

# ---------------------------------------------------------------------------
# [2/7] Backend node_modules (shipped in the artifact)
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  log "[2/7] node_modules missing - installing production dependencies..."
  npm ci --omit=dev --no-audit --no-fund --prefer-offline 2>&1 | tail -5 \
    || npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
else
  log "[2/7] Backend node_modules already present."
fi

# ---------------------------------------------------------------------------
# [3/7] sqlite3 native binary compatibility
# ---------------------------------------------------------------------------
log "[3/7] Verifying sqlite3 native binary..."

if node -e "require('sqlite3');" 2>/tmp/sqlite3-check.err; then
  log "[3/7] sqlite3 loads successfully."
else
  log "[3/7] sqlite3 failed to load. Error was:"
  sed 's/^/  /' /tmp/sqlite3-check.err | head -5
  log "[3/7] Rebuilding sqlite3 from source (~3 min)..."
  apt-get install -y --no-install-recommends -qq \
      python3 make g++ gcc libsqlite3-dev 2>&1 | tail -3 || true
  npm rebuild sqlite3 --build-from-source 2>&1 | tail -8 \
    || log "[3/7] sqlite3 rebuild failed."
fi

# ---------------------------------------------------------------------------
# [4/7] Backend compiled dist
# ---------------------------------------------------------------------------
if [ ! -f dist/index.js ]; then
  log "[4/7] dist/index.js missing - compiling TypeScript..."
  npm install --no-save --no-audit --no-fund typescript@5.8.3 @types/node@22 \
      @types/express @types/cors @types/compression @types/morgan @types/ws \
      @types/bcryptjs @types/jsonwebtoken @types/uuid 2>&1 | tail -3
  ./node_modules/.bin/tsc -p tsconfig.json
  log "[4/7] TypeScript build finished."
else
  log "[4/7] Backend dist already compiled."
fi

# ---------------------------------------------------------------------------
# [5/7] Playwright Chromium (both full + headless-shell). Scanner uses full.
# ---------------------------------------------------------------------------
export PLAYWRIGHT_BROWSERS_PATH="/home/playwright-browsers"
BUNDLED_BROWSERS_DIR="$APP_DIR/playwright-browsers"

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

if [ -d "$BUNDLED_BROWSERS_DIR" ] && [ -n "$(ls -A "$BUNDLED_BROWSERS_DIR" 2>/dev/null || true)" ]; then
  if ! ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium-* >/dev/null 2>&1 \
     || ! ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium_headless_shell-* >/dev/null 2>&1; then
    log "[5/7] Copying bundled Playwright browsers to $PLAYWRIGHT_BROWSERS_PATH ..."
    cp -a "$BUNDLED_BROWSERS_DIR"/. "$PLAYWRIGHT_BROWSERS_PATH"/
    chmod -R a+rx "$PLAYWRIGHT_BROWSERS_PATH"
  fi
fi

# Find both binaries — scanner uses full Chromium; other tools may fall back
# to headless-shell so we verify both are present.
FULL_CHROMIUM="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -path '*chromium-*' -name 'chrome' 2>/dev/null | head -1)"
HEADLESS_SHELL="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name 'chrome-headless-shell' 2>/dev/null | head -1)"

log "[5/7] Full Chromium binary: ${FULL_CHROMIUM:-<not found>}"
log "[5/7] Headless-shell binary: ${HEADLESS_SHELL:-<not found>}"

if [ -z "$FULL_CHROMIUM" ] || [ ! -x "$FULL_CHROMIUM" ]; then
  log "[5/7] Full Chromium missing — running 'playwright install chromium'..."
  ./node_modules/.bin/playwright install chromium 2>&1 | tail -6
  FULL_CHROMIUM="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -path '*chromium-*' -name 'chrome' 2>/dev/null | head -1)"
fi

# Verify all shared libs resolve for the binary the scanner actually uses.
if [ -n "$FULL_CHROMIUM" ] && [ -x "$FULL_CHROMIUM" ]; then
  MISSING="$(ldd "$FULL_CHROMIUM" 2>/dev/null | grep 'not found' | awk '{print $1}' | sort -u || true)"
  if [ -n "$MISSING" ]; then
    log "[5/7] MISSING SHARED LIBRARIES for full Chromium:"
    echo "$MISSING" | sed 's/^/    /'
    log "[5/7] Attempting playwright install-deps chromium as fallback..."
    ./node_modules/.bin/playwright install-deps chromium 2>&1 | tail -8 || true
  else
    log "[5/7] All shared libraries resolved for full Chromium."
  fi
fi

# ---------------------------------------------------------------------------
# [6/7] Persistent data directory
# ---------------------------------------------------------------------------
mkdir -p /home/data
mkdir -p /home/data/traces
log "[6/7] Persistent data directory ready at /home/data."
log "[6/7] Playwright trace output directory ready at /home/data/traces."

# ---------------------------------------------------------------------------
# [7/7] Launch backend under Xvfb virtual display
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"
log "[7/7] Launching backend on PORT=${PORT:-4000} under Xvfb..."

if command -v xvfb-run >/dev/null 2>&1; then
  # -a  = auto-pick a free display number
  # -e  = write Xvfb errors to a file for debugging
  # --server-args gives Chromium a 1920x1080 24-bit display it can render into.
  exec xvfb-run -a -e /tmp/xvfb.err \
    --server-args="-screen 0 1920x1080x24 -ac -nolisten tcp -dpi 96" \
    node dist/index.js
else
  log "[7/7] WARNING: xvfb-run not available. Launching without virtual display."
  log "[7/7] Full Chromium in headless: false mode WILL fail without a display."
  exec node dist/index.js
fi
