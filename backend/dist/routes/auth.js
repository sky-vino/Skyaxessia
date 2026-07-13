"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = require("../utils/db");
const auth_1 = require("../middleware/auth");
const zod_1 = require("zod");
exports.authRouter = (0, express_1.Router)();
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().min(2),
    password: zod_1.z.string().min(6)
});
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().min(2),
    password: zod_1.z.string().min(8),
    full_name: zod_1.z.string().min(2),
    role: zod_1.z.enum(["admin", "analyst", "viewer"]).optional().default("analyst")
});
function signAccess(user) {
    return jsonwebtoken_1.default.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "15m" });
}
function signRefresh(userId) {
    return jsonwebtoken_1.default.sign({ sub: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });
}
// POST /api/auth/login
exports.authRouter.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
        return;
    }
    const { email, password } = parsed.data;
    const result = await db_1.db.query("SELECT * FROM users WHERE email = $1 AND is_active = true", [email]);
    const user = result.rows[0];
    if (!user || !(await bcryptjs_1.default.compare(password, user.password_hash))) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
    }
    const accessToken = signAccess(user);
    const refreshToken = signRefresh(user.id);
    const refreshHash = await bcryptjs_1.default.hash(refreshToken, 10);
    await db_1.db.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')", [user.id, refreshHash]);
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
exports.authRouter.post("/register", auth_1.authenticate, async (req, res) => {
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
    const hash = await bcryptjs_1.default.hash(password, 12);
    try {
        const result = await db_1.db.query("INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, role", [email, hash, full_name, role]);
        res.status(201).json({ user: result.rows[0] });
    }
    catch (err) {
        if (err.code === "23505" || err.code === "SQLITE_CONSTRAINT") {
            res.status(409).json({ error: "Email already exists" });
        }
        else {
            throw err;
        }
    }
});
// POST /api/auth/refresh
exports.authRouter.post("/refresh", async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) {
        res.status(400).json({ error: "Refresh token required" });
        return;
    }
    let payload;
    try {
        payload = jsonwebtoken_1.default.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    }
    catch {
        res.status(401).json({ error: "Invalid refresh token" });
        return;
    }
    const tokens = await db_1.db.query("SELECT * FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()", [payload.sub]);
    let valid = false;
    for (const row of tokens.rows) {
        if (await bcryptjs_1.default.compare(refresh_token, row.token_hash)) {
            valid = true;
            break;
        }
    }
    if (!valid) {
        res.status(401).json({ error: "Refresh token not found" });
        return;
    }
    const userResult = await db_1.db.query("SELECT * FROM users WHERE id = $1 AND is_active = true", [payload.sub]);
    const user = userResult.rows[0];
    if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
    }
    const newAccess = signAccess(user);
    res.json({ access_token: newAccess });
});
// POST /api/auth/logout
exports.authRouter.post("/logout", auth_1.authenticate, async (req, res) => {
    await db_1.db.query("DELETE FROM refresh_tokens WHERE user_id = $1", [req.user.id]);
    res.json({ message: "Logged out" });
});
// GET /api/auth/me
exports.authRouter.get("/me", auth_1.authenticate, async (req, res) => {
    const result = await db_1.db.query("SELECT id, email, full_name, role, avatar_url, created_at FROM users WHERE id = $1", [req.user.id]);
    res.json({ user: result.rows[0] });
});
