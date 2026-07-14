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

# ─── INSTALL CHROMIUM SYSTEM LIBRARIES + XVFB + XAUTH ──────────────────────
# xauth is required by xvfb-run to allocate the display.
if ldconfig -p 2>/dev/null | grep -q "libglib-2.0.so.0" \
   && command -v Xvfb >/dev/null 2>&1 \
   && command -v xauth >/dev/null 2>&1; then
  echo "==> Chromium libs + Xvfb + xauth already present (warm start)"
else
  echo "==> Installing Chromium system libs + xvfb + xauth (~30-60s)..."
  apt-get update -qq 2>&1 | tail -3
  apt-get install -y --no-install-recommends \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libxshmfence1 libx11-xcb1 libxcb1 \
    libxext6 libxi6 libxtst6 fonts-liberation \
    xvfb xauth 2>&1 | tail -5
  if command -v Xvfb >/dev/null 2>&1 && command -v xauth >/dev/null 2>&1; then
    echo "==> Chromium libs + Xvfb + xauth installed successfully"
  else
    echo "WARNING: Xvfb or xauth missing — scans will fail"
  fi
fi
# ────────────────────────────────────────────────────────────────────────────

echo "==> Deploy contents:"
ls -la /home/site/wwwroot | head -20
echo "==> Backend dist:"
ls -la /home/site/wwwroot/backend/dist | head -5 || echo "(missing)"
echo "==> Frontend dist:"
ls -la /home/site/wwwroot/frontend/dist | head -5 || echo "(missing)"

# ─── START XVFB IN BACKGROUND, POINT DISPLAY AT IT ─────────────────────────
# Directly starting Xvfb sidesteps xvfb-run entirely (which needs xauth).
# Any Chromium child process inherits DISPLAY=:99 and renders into the
# virtual framebuffer with no real GUI.
echo "==> Starting Xvfb on :99..."
Xvfb :99 -screen 0 1366x768x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:99

# Give Xvfb ~2s to initialise
sleep 2
if kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "==> Xvfb running as PID $XVFB_PID on DISPLAY=$DISPLAY"
else
  echo "WARNING: Xvfb failed to start. Xvfb log:"
  cat /tmp/xvfb.log || true
  echo "Continuing without virtual display — scans will fail but app will boot."
fi

cd /home/site/wwwroot/backend
echo "==> Launching: node dist/index.js on port $PORT"
exec node dist/index.js
