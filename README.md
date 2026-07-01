# Axessia — Accessibility Testing Platform

Enterprise WCAG accessibility scanner. Single Azure App Service container
that hosts the React frontend and the Node.js + Express backend running
Playwright-based scans — all under one origin.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Azure App Service · axessia-app  (Linux, Node 20)                  │
│                                                                     │
│   startup.sh                                                        │
│     ├── apt: chromium system libs                                   │
│     ├── copy Playwright browsers → /home/playwright-browsers        │
│     ├── ensure /home/data (SQLite)                                  │
│     └── node backend/dist/index.js                                  │
│                                                                     │
│   Express app:                                                      │
│     /api/*    REST endpoints                                        │
│     /ws       WebSocket (live scan progress)                        │
│     /*        React SPA from frontend/dist                          │
│                                                                     │
│   Persistent storage (Azure Files at /home):                        │
│     /home/data/accessibility.sqlite                                 │
│     /home/playwright-browsers/                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Repository layout

```
.
├── .github/workflows/main_axessia-app.yml   Build & deploy pipeline
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
    │   ├── App.tsx
    │   ├── main.tsx
    │   ├── pages/            Login, Dashboard, NewScan, ScanDetail, ...
    │   ├── components/       Layout, six tab components, UI primitives
    │   ├── services/api.ts
    │   ├── store/auth.ts
    │   └── utils/
    ├── package.json
    ├── tsconfig.json
    └── vite.config.ts
```

---

## Push-to-Azure — step-by-step (layman-friendly)

You have three things already set up on the Azure side:
- The Web App `axessia-app` on Linux with Node 20 LTS
- All environment variables (`AZURE_OPENAI_*`, `JWT_*`, etc.)
- The GitHub → Azure OIDC connection (the three `AZUREAPPSERVICE_*` secrets
  auto-added to your GitHub repo when you clicked *"Deploy from GitHub"*)

Now, from your local machine:

### Step 1 — Open a terminal in this folder

Open **Git Bash** or **PowerShell** and change into the extracted `axessia`
folder:

```bash
cd path/to/axessia
```

### Step 2 — Verify Azure App Service settings

In the Azure Portal, go to **axessia-app → Configuration → General settings**
and confirm:

| Setting            | Value                        |
| ------------------ | ---------------------------- |
| Stack              | Node                         |
| Major version      | Node 20 LTS                  |
| Minor version      | Node 20 LTS                  |
| Startup command    | `bash /home/site/wwwroot/startup.sh` |

If it currently says `bash startup.sh` that also works, but the full path
is more robust. Click **Save** if you change anything.

Then go to **axessia-app → Environment variables** and confirm the app
settings below exist. Anything marked **NEW** may need to be added:

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
| `DEFAULT_ADMIN_EMAIL` **NEW**    | `admin@axessia.local`                                    |
| `DEFAULT_ADMIN_PASSWORD`         | (already set)                                            |
| `AZURE_OPENAI_ENDPOINT`          | e.g. `https://your-resource.openai.azure.com`            |
| `AZURE_OPENAI_KEY`               | (already set)                                            |
| `AZURE_OPENAI_DEPLOYMENT`        | your chat model deployment name (e.g. `gpt-4o`)          |
| `AZURE_OPENAI_API_VERSION`       | `2024-10-21`                                             |
| `AXESSIA_ALLOWED_ORIGINS` **NEW**| `*` (or your custom domain, comma-separated)             |
| `FRONTEND_URL`                   | `*` (already set)                                        |

If you had to add anything new, click **Apply** at the bottom.

### Step 3 — Initialise the local git repo (only the first time)

```bash
git init
git add .
git commit -m "Initial Axessia deployment"
```

### Step 4 — Connect to your GitHub repository (only the first time)

Create an empty GitHub repository at
`https://github.com/YOUR_USERNAME/YOUR_REPO_NAME` (do not add a README or
`.gitignore` — leave it completely empty).

Then, from your local terminal:

```bash
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

You will be prompted for your GitHub username and password. Use a
[GitHub Personal Access Token](https://github.com/settings/tokens) instead of
your account password.

### Step 5 — Watch the deploy

The moment `git push` finishes, GitHub Actions starts:

1. Open your repository on github.com.
2. Click the **Actions** tab.
3. You'll see a workflow named **"Build and deploy Node.js app to Azure Web
   App - axessia-app"** running.
4. Click into it to watch each step. Total run time is ~5–7 minutes on the
   first push (mostly Playwright Chromium download).

When the workflow shows a green check, the app is live at:

```
https://axessia-app.azurewebsites.net
```

First HTTP request may take ~30 seconds while Azure boots the container.
Log in with the credentials in the `DEFAULT_ADMIN_EMAIL` /
`DEFAULT_ADMIN_PASSWORD` App Settings.

### Step 6 — Every subsequent update

Whenever you edit code:

```bash
git add .
git commit -m "describe what you changed"
git push
```

That's it. GitHub Actions rebuilds and redeploys automatically.

---

## Verifying the deploy

Open `https://axessia-app.azurewebsites.net/api/health` — you should see:

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

If you get `502 Bad Gateway` for a minute after deploy, that's normal —
the container is still booting. Check the live boot log at:

```
https://axessia-app.scm.azurewebsites.net/api/logstream
```

Or open **axessia-app → Log stream** in the Azure Portal.

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
| `502 Bad Gateway` for >2 min | Container failing to start | Open `Log stream` in Azure. Look for `axessia-startup` lines. |
| GitHub Action fails at `azure/login` | OIDC secrets missing or wrong | Re-connect Deployment Center in Azure → GitHub. It re-creates the three `AZUREAPPSERVICE_*` GitHub secrets. |
| Login works, scans fail with 500 | Playwright / Chromium not ready | Check `/home/playwright-browsers/` in Kudu (`/newui`). Restart the App Service to trigger a fresh install. |
| AI explanations are the generic fallback | Azure OpenAI env vars missing or wrong deployment name | Verify `AZURE_OPENAI_DEPLOYMENT` matches the deployment name shown in Azure AI Studio. |
| SQLite errors on save | `DATABASE_URL` pointing to a non-writable path | Must be `sqlite:///home/data/accessibility.sqlite` (three slashes — `sqlite://` + `/home/...`). |

---

## What changed from your local repo

If you're comparing this ZIP to your local:

1. `backend/src/services/aiService.ts` — fully rewritten to call **Azure OpenAI**
   (uses `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT`,
   `AZURE_OPENAI_API_VERSION`). Includes a graceful fallback if env vars are
   missing so scans never crash.
2. `backend/src/index.ts` — now also serves the built React SPA under `STATIC_DIR`
   and handles SPA deep-link fallback. No more need for a separate frontend host.
3. `backend/src/utils/db.ts` and `backend/src/routes/auth.ts` — use `bcryptjs`
   (pure JS) instead of `bcrypt` (native), which fails to compile on Azure Linux.
4. `startup.sh` — copies bundled Playwright browsers to `/home` on first boot
   so the app doesn't need to download Chromium at runtime.
5. `.github/workflows/main_axessia-app.yml` — full CI/CD workflow that builds
   frontend, compiles backend, prunes dev deps, and deploys via OIDC.
