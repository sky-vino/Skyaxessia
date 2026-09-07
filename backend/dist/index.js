"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const http_1 = require("http");
const ws_1 = require("ws");
const db_1 = require("./utils/db");
const logger_1 = require("./utils/logger");
const errorHandler_1 = require("./middleware/errorHandler");
const auth_1 = require("./routes/auth");
const scans_1 = require("./routes/scans");
const issues_1 = require("./routes/issues");
const projects_1 = require("./routes/projects");
const users_1 = require("./routes/users");
const wcagGovernance_1 = require("./routes/wcagGovernance");
const extensionSessions_1 = require("./routes/extensionSessions");
const authSessions_1 = require("./routes/authSessions");
const wsManager_1 = require("./utils/wsManager");
const scanQueue_1 = require("./services/scanQueue");
const wcagGovernanceService_1 = require("./services/wcagGovernanceService");
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
// ─── CORS ───────────────────────────────────────────────────────────────────
// When the SPA is served from the same origin (Azure single-container), the
// browser does not send an Origin header for same-origin requests, so this
// is essentially permissive by design. Set AXESSIA_ALLOWED_ORIGINS to a
// comma-separated allow-list to lock it down, or FRONTEND_URL for a single
// origin. Bearer-token auth is still required on every protected endpoint.
const allowedOrigins = (process.env.AXESSIA_ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    "*")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
// ─── WebSocket ──────────────────────────────────────────────────────────────
const wss = new ws_1.WebSocketServer({ server: httpServer, path: "/ws" });
wsManager_1.wsManager.init(wss);
// ─── Middleware ─────────────────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use((0, helmet_1.default)({ contentSecurityPolicy: false }));
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    credentials: true
}));
app.use((0, compression_1.default)());
app.use(express_1.default.json({ limit: "10mb" }));
app.use((0, morgan_1.default)("combined", { stream: { write: msg => logger_1.logger.info(msg.trim()) } }));
// ─── API routes ─────────────────────────────────────────────────────────────
app.use("/api/auth", auth_1.authRouter);
app.use("/api/scans", scans_1.scanRouter);
app.use("/api/issues", issues_1.issueRouter);
app.use("/api/projects", projects_1.projectRouter);
app.use("/api/users", users_1.userRouter);
app.use("/api/wcag-governance", wcagGovernance_1.wcagGovernanceRouter);
app.use("/api/extension-sessions", extensionSessions_1.extensionSessionRouter);
app.use("/api/auth-sessions", authSessions_1.authSessionRouter);
app.get("/api/health", (_req, res) => {
    res.json({
        status: "ok",
        name: "Axessia",
        version: "1.0.0",
        environment: process.env.NODE_ENV || "development",
        queue: process.env.REDIS_URL && process.env.SCAN_QUEUE_DRIVER !== "memory"
            ? "redis"
            : "memory",
        ai_provider: "azure-openai",
        timestamp: new Date().toISOString()
    });
});
// ─── Static frontend (single-container deploy) ──────────────────────────────
// The React SPA is served from the same Node process. Default location is
// /home/site/wwwroot/frontend/dist. Override with STATIC_DIR if needed.
const staticDir = process.env.STATIC_DIR ||
    path_1.default.resolve(__dirname, "..", "..", "frontend", "dist");
const indexHtmlPath = path_1.default.join(staticDir, "index.html");
if (fs_1.default.existsSync(indexHtmlPath)) {
    logger_1.logger.info(`Serving frontend from ${staticDir}`);
    // Long cache on immutable hashed assets, no cache on the entry point.
    app.use("/assets", express_1.default.static(path_1.default.join(staticDir, "assets"), {
        maxAge: "365d",
        immutable: true
    }));
    app.use(express_1.default.static(staticDir, {
        index: false,
        setHeaders: (res, filePath) => {
            if (filePath.endsWith("index.html")) {
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            }
        }
    }));
    // SPA fallback: any non-/api, non-/ws path returns index.html so React
    // Router can handle deep-link routes like /scans/<id>.
    app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.sendFile(indexHtmlPath);
    });
}
else {
    logger_1.logger.warn(`Static frontend not mounted: ${indexHtmlPath} does not exist`);
}
// ─── Error handler (must be after routes) ───────────────────────────────────
app.use(errorHandler_1.errorHandler);
// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;
const GOVERNANCE_CHECK_MS = 60 * 60 * 1000;
async function start() {
    try {
        await db_1.db.query("SELECT 1");
        logger_1.logger.info("Database connected");
        scanQueue_1.scanQueue.init();
        logger_1.logger.info("Scan queue initialized");
        (0, wcagGovernanceService_1.ensureWcagGovernanceReady)().catch(error => logger_1.logger.warn("WCAG governance startup check failed:", error));
        setInterval(() => {
            (0, wcagGovernanceService_1.ensureWcagGovernanceReady)().catch(error => logger_1.logger.warn("WCAG governance scheduled check failed:", error));
        }, GOVERNANCE_CHECK_MS).unref?.();
        httpServer.listen(PORT, () => {
            logger_1.logger.info(`Axessia backend running on port ${PORT}`);
        });
    }
    catch (err) {
        logger_1.logger.error("Failed to start server:", err);
        process.exit(1);
    }
}
start();
function shutdown(signal) {
    logger_1.logger.info(`${signal} received. Closing HTTP server.`);
    httpServer.close(() => {
        logger_1.logger.info("HTTP server closed.");
        process.exit(0);
    });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
