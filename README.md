# Axessia - Accessibility Testing Platform

Enterprise WCAG accessibility scanner. Single Azure App Service container
that hosts the React frontend and the Node.js + Express backend running
Playwright-based scans - all under one origin.

```
+---------------------------------------------------------------------+
|  Azure App Service - axessia-app  (Linux, Node 22 LTS, Debian 12)   |
|                                                                     |
|   startup.sh                                                        |
|     +-- apt: chromium system libs                                   |
|     +-- verify + auto-rebuild sqlite3 if GLIBC mismatch             |
|     +-- copy Playwright browsers -> /home/playwright-browsers       |
|     +-- ensure /home/data (SQLite)                                  |
|     +-- node backend/dist/index.js                                  |
|                                                                     |
|   Express app:                                                      |
|     /api/*    REST endpoints                                        |
|     /ws       WebSocket (live scan progress)                        |
|     /*        React SPA from frontend/dist                          |
|                                                                     |
|   Persistent storage (Azure Files at /home):                        |
|     /home/data/accessibility.sqlite                                 |
|     /home/playwright-browsers/                                      |
+---------------------------------------------------------------------+
```

---

## Repository layout

```
.
├── .github/workflows/main_axessia-app.yml   Build (in Debian 12 container) & deploy
├── startup.sh                               Azure App Service startup command
├── .gitignore
├── .env.example
├── README.md
│
├── backend/                  Node.js + TypeScript + Express
│   ├── src/
│   │   ├── index.ts          App entry: API, /ws, static SPA, SPA fallback
│   │   ├── routes/           auth, scans, issues, projects, users, ...
│   │   ├── scanner/          Playwright + axe-core + heuristics
│   │   ├── services/         aiService (Azure OpenAI), scanQueue, reportService
│   │   ├── middleware/       auth (JWT), error handler
│   │   └── utils/            db (SQLite + bcryptjs), wsManager, logger
│   ├── migrations/init.sqlite.sql
│   ├── package.json
│   └── tsconfig.json
│
└── frontend/                 React 18 + Vite + Tailwind
    ├── src/
    │   ├── App.tsx, main.tsx
    │   ├── pages/            Login, Dashboard, NewScan, ScanDetail, ...
    │   ├── components/       Layout, six tab components, UI primitives
    │   ├── services/api.ts
    │   ├── store/            auth (zustand), theme
    │   └── utils/
    ├── package.json
    ├── tsconfig.json
    └── vite.config.ts
```

---

## Why this repo builds inside a Debian 12 container

Azure App Service Linux Node 22 uses **Debian 12 (bookworm)** with **GLIBC 2.36**.

The default GitHub Actions runner (`ubuntu-latest`) is **Ubuntu 24.04** with
**GLIBC 2.39**. If you `npm install` a native module like `sqlite3` on the
default runner and ship the resulting `.node` binary to Azure, it fails with:

```
Error: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
(required by ...sqlite3/build/Release/node_sqlite3.node)
```

The workflow in this repo pins the build to `node:22-bookworm` and force-
rebuilds sqlite3 from source, so the shipped binary works on Azure.

`startup.sh` also has a runtime safety net: if sqlite3 ever fails to load,
it installs `python3 make g++` on Azure and rebuilds sqlite3 in place, so
the app self-heals on the next boot.

---

## Push-to-Azure - step-by-step (layman-friendly)

You have three things already set up on the Azure side:
- The Web App `axessia-app` on Linux with Node 22 LTS
- All environment variables (`AZURE_OPENAI_*`, `JWT_*`, etc.)
- The GitHub -> Azure OIDC connection (the three `AZUREAPPSERVICE_*` secrets
  auto-added to your GitHub repo when you clicked *"Deploy from GitHub"*)

Now, from your local machine:

### Step 1 - Open a terminal in this folder

Open **Git Bash** or **PowerShell** and change into the extracted `axessia`
folder:

```bash
cd path/to/axessia
```

### Step 2 - Verify Azure App Service settings

In the Azure Portal, go to **axessia-app -> Configuration -> General settings**
and confirm:

| Setting            | Value                                        |
| ------------------ | -------------------------------------------- |
| Stack              | Node                                         |
| Major version      | Node 22 LTS                                  |
| Minor version      | Node 22 LTS                                  |
| Startup command    | `bash /home/site/wwwroot/startup.sh`         |

Then go to **axessia-app -> Environment variables** and confirm the app
settings below exist:

| Setting                          | Value                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `WEBSITES_PORT`                  | `4000`                                                   |
| `PORT`                           | `4000`                                                   |
| `NODE_ENV`                       | `production`                                             |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false`                                                  |
| `ENABLE_ORYX_BUILD`              | `false`                                                  |
| `PLAYWRIGHT_BROWSERS_PATH`       | `/home/playwright-browsers`                              |
| `DATABASE_URL`                   | `sqlite:///home/data/accessibility.sqlite`               |
| `STATIC_DIR`                     | `/home/site/wwwroot/frontend/dist`                       |
| `SCAN_QUEUE_DRIVER`              | `memory`                                                 |
| `SCAN_QUEUE_CONCURRENCY`         | `2`                                                      |
| `JWT_SECRET`                     | (already set)                                            |
| `JWT_REFRESH_SECRET`             | (already set)                                            |
| `DEFAULT_ADMIN_EMAIL`            | `admin@axessia.local`                                    |
| `DEFAULT_ADMIN_PASSWORD`         | (already set)                                            |
| `AZURE_OPENAI_ENDPOINT`          | e.g. `https://your-resource.openai.azure.com`            |
| `AZURE_OPENAI_KEY`               | (already set)                                            |
| `AZURE_OPENAI_DEPLOYMENT`        | your chat model deployment name (e.g. `gpt-4o`)          |
| `AZURE_OPENAI_API_VERSION`       | `2024-10-21`                                             |
| `AXESSIA_ALLOWED_ORIGINS`        | `*` (or your custom domain, comma-separated)             |

**Important:** `WEBSITES_PORT` should match the port your app listens on.
Azure sets `PORT=8080` by default at container runtime. If your logs show
`Launching backend on PORT=8080`, either set `WEBSITES_PORT=8080` or add
`PORT=4000` as an app setting to override.

### Step 3 - Initialise the local git repo (only the first time)

```bash
git init
git add .
git commit -m "Initial Axessia deployment"
```

### Step 4 - Connect to your GitHub repository (only the first time)

Create an empty GitHub repository at
`https://github.com/YOUR_USERNAME/YOUR_REPO_NAME` (do not add a README or
`.gitignore` - leave it completely empty).

Then, from your local terminal:

```bash
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

Use a [GitHub Personal Access Token](https://github.com/settings/tokens) as
the password.

### Step 5 - Watch the deploy

Open your repository on github.com -> **Actions** tab. You'll see the workflow
run. Click into it to watch each step. Total time is ~7-10 minutes on the
first push (Playwright Chromium download + native module compile).

Success indicators to look for in the log:
- `OK: sqlite3 loaded successfully`
- `no GLIBC lines found` (or all GLIBC deps <= 2.36)
- `OK: production sqlite3 loads`

When the workflow shows a green check, the app is live at:
```
https://axessia-app.azurewebsites.net
```

First HTTP request may take ~30 seconds while Azure boots the container.

### Step 6 - Every subsequent update

```bash
git add .
git commit -m "describe what you changed"
git push
```

---

## Verifying the deploy

Open `https://axessia-app.azurewebsites.net/api/health` - you should see:

```json
{
  "status": "ok",
  "name": "Axessia",
  "version": "1.0.0",
  "environment": "production",
  "queue": "memory",
  "ai_provider": "azure-openai",
  "timestamp": "..."
}
```

Check the live boot log at:
```
https://axessia-app.scm.azurewebsites.net/api/logstream
```

You should see the `[axessia-startup]` prefix lines running steps 1/6 through
6/6, then `Axessia backend running on port 4000` (or 8080, depending on
config).

---

## Local development

```bash
# --- Backend ---
cd backend
npm install
cp ../.env.example .env
# edit .env: set your Azure OpenAI values (or leave blank to skip AI features)
npx playwright install chromium
npm run dev            # runs on :4000

# --- Frontend (separate terminal) ---
cd frontend
npm install
npm run dev            # opens http://localhost:3000, proxies /api and /ws to :4000
```

Default login: `admin@axessia.local` / `Admin@123`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GLIBC_2.38 not found` for sqlite3 | Native binary was built on Ubuntu 24.04 for GLIBC 2.39; Azure Debian 12 has 2.36 | Already fixed: workflow builds inside `node:22-bookworm` container. If it recurs, `startup.sh` auto-rebuilds sqlite3 at boot. |
| `502 Bad Gateway` for >2 min | Container failing to start | Open Log stream in Azure. Look for `[axessia-startup]` lines. |
| GitHub Action fails at `azure/login` | OIDC secrets missing or wrong | Re-connect Deployment Center in Azure -> GitHub. It re-creates the three `AZUREAPPSERVICE_*` GitHub secrets. |
| Login works, scans fail with 500 | Playwright / Chromium not ready | Check `/home/playwright-browsers/` in Kudu (`/newui`). Restart the App Service to trigger a fresh install. |
| AI explanations are the generic fallback | Azure OpenAI env vars missing or wrong deployment name | Verify `AZURE_OPENAI_DEPLOYMENT` matches the deployment name shown in Azure AI Studio. |
| SQLite errors on save | `DATABASE_URL` pointing to a non-writable path | Must be `sqlite:///home/data/accessibility.sqlite` (three slashes total). |
| Boot shows `Launching backend on PORT=8080` but WEBSITES_PORT=4000 | Azure sets PORT=8080 for the container; the app listens on 8080 but WEBSITES_PORT probes 4000 | Either set `WEBSITES_PORT=8080` in app settings, or set `PORT=4000` app setting to override Azure's default. |

---

## What changed from your local repo

1. `backend/src/services/aiService.ts` - rewritten for **Azure OpenAI**
   (uses `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT`,
   `AZURE_OPENAI_API_VERSION`). Falls back gracefully if env vars are missing.
2. `backend/src/index.ts` - now serves the built React SPA under `STATIC_DIR`
   and handles SPA deep-link fallback.
3. `backend/src/utils/db.ts` and `backend/src/routes/auth.ts` and
   `backend/src/routes/projects.ts` - use `bcryptjs` (pure JS) instead of
   `bcrypt` (native), which fails to compile on Azure Linux.
4. `startup.sh` - copies bundled Playwright browsers to `/home` on first boot,
   AND auto-rebuilds sqlite3 from source if the shipped binary is incompatible
   with runtime GLIBC.
5. `.github/workflows/main_axessia-app.yml` - builds inside `node:22-bookworm`
   (Debian 12) so native modules produce Azure-compatible binaries. Also
   force-rebuilds sqlite3 from source as belt-and-braces.
