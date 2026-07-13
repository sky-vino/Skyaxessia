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

import { Router, Response } from "express";
import { authenticate, AuthRequest } from "../middleware/auth";
import { z } from "zod";
import { startSession, getSession, submitOtp, cancelSession, listActiveSessions } from "../services/authSessionManager";
import { logger } from "../utils/logger";

export const authSessionRouter = Router();
authSessionRouter.use(authenticate);

const startSchema = z.object({
  target_url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  otp_channel: z.enum(["email", "sms"]).optional().default("email"),
  scan_name: z.string().optional(),
  scan_options: z.any().optional(),
  auth_config: z.any().optional(),
  project_id: z.string().uuid().optional(),
});

const otpSchema = z.object({
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
});

// POST /api/auth-sessions
authSessionRouter.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  try {
    const snapshot = await startSession({
      targetUrl: parsed.data.target_url,
      username: parsed.data.username,
      password: parsed.data.password,
      otpChannel: parsed.data.otp_channel,
      scanName: parsed.data.scan_name,
      scanOptions: parsed.data.scan_options,
      authConfig: parsed.data.auth_config,
      projectId: parsed.data.project_id,
      createdBy: req.user!.id,
    });
    res.status(201).json({ session: snapshot });
  } catch (err: any) {
    logger.warn(`auth-sessions POST failed: ${err?.message || err}`);
    res.status(500).json({ error: err?.message || "Could not start auth session" });
  }
});

// GET /api/auth-sessions (admin/debug)
authSessionRouter.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  res.json({ sessions: listActiveSessions() });
});

// GET /api/auth-sessions/:id  (poll)
authSessionRouter.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const snapshot = getSession(String(req.params.id));
  if (!snapshot) {
    res.status(404).json({ error: "Session not found or already expired" });
    return;
  }
  res.json({ session: snapshot });
});

// POST /api/auth-sessions/:id/otp
authSessionRouter.post("/:id/otp", async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = otpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid OTP", details: parsed.error.flatten() });
    return;
  }
  try {
    const snapshot = await submitOtp(String(req.params.id), parsed.data.otp);
    res.json({ session: snapshot });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "OTP submit failed" });
  }
});

// DELETE /api/auth-sessions/:id
authSessionRouter.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  await cancelSession(String(req.params.id));
  res.json({ message: "Session cancelled" });
});
