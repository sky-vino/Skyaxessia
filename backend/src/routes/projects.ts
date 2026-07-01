import { Router, Response } from "express";
import bcrypt from "bcryptjs";
import { authenticate, AuthRequest, requireRole } from "../middleware/auth";
import { db } from "../utils/db";

export const projectRouter = Router();
projectRouter.use(authenticate);

projectRouter.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    "SELECT p.*, u.full_name as owner_name FROM projects p JOIN users u ON u.id = p.owner_id ORDER BY p.created_at DESC"
  );
  res.json({ projects: result.rows });
});

projectRouter.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, description } = req.body;
  if (!name) { res.status(400).json({ error: "Name required" }); return; }
  const result = await db.query(
    "INSERT INTO projects (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *",
    [name, description, req.user!.id]
  );
  res.status(201).json({ project: result.rows[0] });
});

projectRouter.delete("/:id", requireRole("admin"), async (req: AuthRequest, res: Response): Promise<void> => {
  await db.query("DELETE FROM projects WHERE id = $1", [req.params.id]);
  res.json({ message: "Project deleted" });
});

// ─── Users Router ────────────────────────────────────────────────────────────
export const userRouter = Router();
userRouter.use(authenticate);

userRouter.get("/", requireRole("admin"), async (_req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    "SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at DESC"
  );
  res.json({ users: result.rows });
});

userRouter.get("/audit-events", requireRole("admin"), async (_req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    `SELECT ae.*, u.full_name AS actor_name, u.email AS actor_email
     FROM audit_events ae
     LEFT JOIN users u ON u.id = ae.actor_id
     WHERE ae.action IN ('scan.delete', 'scan.rerun')
     ORDER BY ae.created_at DESC
     LIMIT 50`
  );
  res.json({ events: result.rows });
});

userRouter.post("/", requireRole("admin"), async (req: AuthRequest, res: Response): Promise<void> => {
  const { email, password, full_name, role } = req.body;
  const userRole = role || "analyst";
  if (!email || !password || !full_name) {
    res.status(400).json({ error: "Username/email, password, and full name are required" });
    return;
  }
  if (!["admin", "analyst", "viewer"].includes(userRole)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }
  if (String(password).length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, email, full_name, role, is_active, created_at`,
      [email, hash, full_name, userRole]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505" || err.code === "SQLITE_CONSTRAINT") {
      res.status(409).json({ error: "User already exists" });
      return;
    }
    throw err;
  }
});

userRouter.patch("/:id", requireRole("admin"), async (req: AuthRequest, res: Response): Promise<void> => {
  const { role, is_active, password } = req.body;
  const targetResult = await db.query("SELECT id, role FROM users WHERE id = $1", [req.params.id]);
  const target = targetResult.rows[0];
  if (!target) { res.status(404).json({ error: "User not found" }); return; }
  if (target.role === "admin" && is_active === false) {
    res.status(400).json({ error: "Admin users cannot be deactivated" });
    return;
  }

  const sets: string[] = [];
  const params: any[] = [];

  if (role) { params.push(role); sets.push(`role = $${params.length}`); }
  if (typeof is_active === "boolean") { params.push(is_active); sets.push(`is_active = $${params.length}`); }
  if (password !== undefined) {
    if (String(password).length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    const hash = await bcrypt.hash(String(password), 12);
    params.push(hash);
    sets.push(`password_hash = $${params.length}`);
  }

  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }

  params.push(req.params.id);
  const result = await db.query(
    `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length} RETURNING id, email, full_name, role, is_active`,
    params
  );
  res.json({ user: result.rows[0] });
});
