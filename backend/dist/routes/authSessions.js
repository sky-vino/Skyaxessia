"use strict";
/**
 * authSessions.ts (routes)
 * -----------------------------------------------------------------------------
 * REST surface for production authenticated scans with manual OTP entry.
 *
 *   POST   /api/auth-sessions            Start a new session (launch browser,
 *                                        fill credentials, request OTP)
 *   GET    /api/auth-sessions/:id        Poll status - UI polls every 2s
 *   POST   /api/auth-sessions/:id/otp    Submit the OTP the user typed in
 *   DELETE /api/auth-sessions/:id        User cancelled
 *   GET    /api/auth-sessions            (admin) list all active sessions
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.authSessionRouter = void 0;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const zod_1 = require("zod");
const authSessionManager_1 = require("../services/authSessionManager");
const logger_1 = require("../utils/logger");
exports.authSessionRouter = (0, express_1.Router)();
exports.authSessionRouter.use(auth_1.authenticate);
const startSchema = zod_1.z.object({
    target_url: zod_1.z.string().url(),
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
    otp_channel: zod_1.z.enum(["email", "sms"]).optional().default("email"),
    scan_name: zod_1.z.string().optional(),
    scan_options: zod_1.z.any().optional(),
    auth_config: zod_1.z.any().optional(),
    project_id: zod_1.z.string().uuid().optional(),
});
const otpSchema = zod_1.z.object({
    otp: zod_1.z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
});
// POST /api/auth-sessions
exports.authSessionRouter.post("/", async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
        return;
    }
    try {
        const snapshot = await (0, authSessionManager_1.startSession)({
            targetUrl: parsed.data.target_url,
            username: parsed.data.username,
            password: parsed.data.password,
            otpChannel: parsed.data.otp_channel,
            scanName: parsed.data.scan_name,
            scanOptions: parsed.data.scan_options,
            authConfig: parsed.data.auth_config,
            projectId: parsed.data.project_id,
            createdBy: req.user.id,
        });
        res.status(201).json({ session: snapshot });
    }
    catch (err) {
        logger_1.logger.warn(`auth-sessions POST failed: ${err?.message || err}`);
        res.status(500).json({ error: err?.message || "Could not start auth session" });
    }
});
// GET /api/auth-sessions (admin/debug)
exports.authSessionRouter.get("/", async (req, res) => {
    if (req.user?.role !== "admin") {
        res.status(403).json({ error: "Admin only" });
        return;
    }
    res.json({ sessions: (0, authSessionManager_1.listActiveSessions)() });
});
// GET /api/auth-sessions/:id  (poll)
exports.authSessionRouter.get("/:id", async (req, res) => {
    const snapshot = (0, authSessionManager_1.getSession)(String(req.params.id));
    if (!snapshot) {
        res.status(404).json({ error: "Session not found or already expired" });
        return;
    }
    res.json({ session: snapshot });
});
// POST /api/auth-sessions/:id/otp
exports.authSessionRouter.post("/:id/otp", async (req, res) => {
    const parsed = otpSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid OTP", details: parsed.error.flatten() });
        return;
    }
    try {
        const snapshot = await (0, authSessionManager_1.submitOtp)(String(req.params.id), parsed.data.otp);
        res.json({ session: snapshot });
    }
    catch (err) {
        res.status(400).json({ error: err?.message || "OTP submit failed" });
    }
});
// DELETE /api/auth-sessions/:id
exports.authSessionRouter.delete("/:id", async (req, res) => {
    await (0, authSessionManager_1.cancelSession)(String(req.params.id));
    res.json({ message: "Session cancelled" });
});
