import "dotenv/config";
import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { createServer } from "http";
import { WebSocketServer } from "ws";

import { db } from "./utils/db";
import { logger } from "./utils/logger";
import { errorHandler } from "./middleware/errorHandler";
import { authRouter } from "./routes/auth";
import { scanRouter } from "./routes/scans";
import { issueRouter } from "./routes/issues";
import { projectRouter } from "./routes/projects";
import { userRouter } from "./routes/users";
import { wcagGovernanceRouter } from "./routes/wcagGovernance";
import { extensionSessionRouter } from "./routes/extensionSessions";
import { authSessionRouter } from "./routes/authSessions";
import { wsManager } from "./utils/wsManager";
import { scanQueue } from "./services/scanQueue";
import { ensureWcagGovernanceReady } from "./services/wcagGovernanceService";

const app = express();
const httpServer = createServer(app);

// ─── CORS ───────────────────────────────────────────────────────────────────
// When the SPA is served from the same origin (Azure single-container), the
// browser does not send an Origin header for same-origin requests, so this
// is essentially permissive by design. Set AXESSIA_ALLOWED_ORIGINS to a
// comma-separated allow-list to lock it down, or FRONTEND_URL for a single
// origin. Bearer-token auth is still required on every protected endpoint.
const allowedOrigins = (
  process.env.AXESSIA_ALLOWED_ORIGINS ||
  process.env.FRONTEND_URL ||
  "*"
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

// ─── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wsManager.init(wss);

// ─── Middleware ─────────────────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    credentials: true
  })
);
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(
  morgan("combined", { stream: { write: msg => logger.info(msg.trim()) } })
);

// ─── API routes ─────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/scans", scanRouter);
app.use("/api/issues", issueRouter);
app.use("/api/projects", projectRouter);
app.use("/api/users", userRouter);
app.use("/api/wcag-governance", wcagGovernanceRouter);
app.use("/api/extension-sessions", extensionSessionRouter);
app.use("/api/auth-sessions", authSessionRouter);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "Axessia",
    version: "1.0.0",
    environment: process.env.NODE_ENV || "development",
    queue:
      process.env.REDIS_URL && process.env.SCAN_QUEUE_DRIVER !== "memory"
        ? "redis"
        : "memory",
    ai_provider: "azure-openai",
    timestamp: new Date().toISOString()
  });
});

// ─── Static frontend (single-container deploy) ──────────────────────────────
// The React SPA is served from the same Node process. Default location is
// /home/site/wwwroot/frontend/dist. Override with STATIC_DIR if needed.
const staticDir =
  process.env.STATIC_DIR ||
  path.resolve(__dirname, "..", "..", "frontend", "dist");

const indexHtmlPath = path.join(staticDir, "index.html");

if (fs.existsSync(indexHtmlPath)) {
  logger.info(`Serving frontend from ${staticDir}`);

  // Long cache on immutable hashed assets, no cache on the entry point.
  app.use(
    "/assets",
    express.static(path.join(staticDir, "assets"), {
      maxAge: "365d",
      immutable: true
    })
  );

  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      }
    })
  );

  // SPA fallback: any non-/api, non-/ws path returns index.html so React
  // Router can handle deep-link routes like /scans/<id>.
  app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(indexHtmlPath);
  });
} else {
  logger.warn(`Static frontend not mounted: ${indexHtmlPath} does not exist`);
}

// ─── Error handler (must be after routes) ───────────────────────────────────
app.use(errorHandler);

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;
const GOVERNANCE_CHECK_MS = 60 * 60 * 1000;

async function start() {
  try {
    await db.query("SELECT 1");
    logger.info("Database connected");

    scanQueue.init();
    logger.info("Scan queue initialized");

    ensureWcagGovernanceReady().catch(error =>
      logger.warn("WCAG governance startup check failed:", error)
    );
    setInterval(() => {
      ensureWcagGovernanceReady().catch(error =>
        logger.warn("WCAG governance scheduled check failed:", error)
      );
    }, GOVERNANCE_CHECK_MS).unref?.();

    httpServer.listen(PORT, () => {
      logger.info(`Axessia backend running on port ${PORT}`);
    });
  } catch (err) {
    logger.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();

function shutdown(signal: string) {
  logger.info(`${signal} received. Closing HTTP server.`);
  httpServer.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
