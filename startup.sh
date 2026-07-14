#!/bin/bash
# -----------------------------------------------------------------------------
# Axessia — Azure App Service startup script
# -----------------------------------------------------------------------------
set -e
echo "==> Axessia startup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat /home/site/wwwroot/.deploy-sha 2>/dev/null || echo "(no deploy stamp)"

cd /home/site/wwwroot

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/home/site/wwwroot/playwright-browsers}"
echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"

export STATIC_DIR="${STATIC_DIR:-/home/site/wwwroot/frontend/dist}"
echo "STATIC_DIR=$STATIC_DIR"

mkdir -p /home/site/data
export SQLITE_PATH="${SQLITE_PATH:-/home/site/data/accessibility.sqlite}"
export DATABASE_URL="${DATABASE_URL:-sqlite://$SQLITE_PATH}"

echo "==> Verifying sqlite3 binary..."
cd /home/site/wwwroot/backend
node -e "require('sqlite3'); console.log('sqlite3 OK')" || {
  echo "ERROR: sqlite3 failed to load."
  exit 1
}

# ─── INSTALL CHROMIUM SYSTEM LIBRARIES + XVFB ──────────────────────────────
# Chromium needs libglib etc. AND xvfb (virtual display) because the app
# launches the browser in HEADED mode for anti-bot-detection stealth.
# Azure App Service has no real display, so xvfb-run provides a fake one.
if ldconfig -p 2>/dev/null | grep -q "libglib-2.0.so.0" && command -v xvfb-run >/dev/null 2>&1; then
  echo "==> Chromium libs + xvfb already present (warm start)"
else
  echo "==> Installing Chromium system libs + xvfb (~30-60s, one-time per cold start)..."
  apt-get update -qq 2>&1 | tail -3
  apt-get install -y --no-install-recommends \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 libxcb1 \
    libxext6 libxi6 libxtst6 fonts-liberation \
    xvfb 2>&1 | tail -5
  if command -v xvfb-run >/dev/null 2>&1; then
    echo "==> Chromium libs + xvfb installed successfully"
  else
    echo "WARNING: xvfb install may have failed — scans will fail"
  fi
fi
# ────────────────────────────────────────────────────────────────────────────

echo "==> Deploy contents:"
ls -la /home/site/wwwroot | head -20
echo "==> Backend dist:"
ls -la /home/site/wwwroot/backend/dist | head -5 || echo "(missing)"
echo "==> Frontend dist:"
ls -la /home/site/wwwroot/frontend/dist | head -5 || echo "(missing)"

cd /home/site/wwwroot/backend
echo "==> Launching: xvfb-run node dist/index.js on port $PORT"

# ─── LAUNCH INSIDE XVFB VIRTUAL DISPLAY ────────────────────────────────────
# xvfb-run -a: auto-pick an available display number
# --server-args: set virtual screen resolution matching what the app uses
# The node process runs normally, but every Chromium child process it
# launches will see DISPLAY=:99 and render into the virtual framebuffer.
exec xvfb-run -a --server-args="-screen 0 1366x768x24 -ac +extension GLX +render -noreset" \
  node dist/index.js
