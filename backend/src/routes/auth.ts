import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../utils/db";
import { authenticate, AuthRequest } from "../middleware/auth";
import { z } from "zod";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().min(2),
  password: z.string().min(6)
});

const registerSchema = z.object({
  email: z.string().min(2),
  password: z.string().min(8),
  full_name: z.string().min(2),
  role: z.enum(["admin", "analyst", "viewer"]).optional().default("analyst")
});

function signAccess(user: { id: string; email: string; role: string }) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: "15m" }
  );
}

function signRefresh(userId: string) {
  return jwt.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET!, { expiresIn: "7d" });
}

// POST /api/auth/login
authRouter.post("/login", async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;
  const result = await db.query(
    "SELECT * FROM users WHERE email = $1 AND is_active = true",
    [email]
  );
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const accessToken = signAccess(user);
  const refreshToken = signRefresh(user.id);
  const refreshHash = await bcrypt.hash(refreshToken, 10);

  await db.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [user.id, refreshHash]
  );

  res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      avatar_url: user.avatar_url
    }
  });
});

// POST /api/auth/register (admin only)
authRouter.post("/register", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Only admins can register users" });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const { email, password, full_name, role } = parsed.data;
  const hash = await bcrypt.hash(password, 12);

  try {
    const result = await db.query(
      "INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, role",
      [email, hash, full_name, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505" || err.code === "SQLITE_CONSTRAINT") {
      res.status(409).json({ error: "Email already exists" });
    } else {
      throw err;
    }
  }
});

// POST /api/auth/refresh
authRouter.post("/refresh", async (req: Request, res: Response): Promise<void> => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    res.status(400).json({ error: "Refresh token required" });
    return;
  }

  let payload: any;
  try {
    payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET!);
  } catch {
    res.status(401).json({ error: "Invalid refresh token" });
    return;
  }

  const tokens = await db.query(
    "SELECT * FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()",
    [payload.sub]
  );

  let valid = false;
  for (const row of tokens.rows) {
    if (await bcrypt.compare(refresh_token, row.token_hash)) {
      valid = true;
      break;
    }
  }

  if (!valid) {
    res.status(401).json({ error: "Refresh token not found" });
    return;
  }

  const userResult = await db.query(
    "SELECT * FROM users WHERE id = $1 AND is_active = true",
    [payload.sub]
  );
  const user = userResult.rows[0];
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const newAccess = signAccess(user);
  res.json({ access_token: newAccess });
});

// POST /api/auth/logout
authRouter.post("/logout", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  await db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [req.user!.id]);
  res.json({ message: "Logged out" });
});

// GET /api/auth/me
authRouter.get("/me", authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    "SELECT id, email, full_name, role, avatar_url, created_at FROM users WHERE id = $1",
    [req.user!.id]
  );
  res.json({ user: result.rows[0] });
});
