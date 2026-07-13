/**
 * reset-admin.js — reset (or create) the admin user against the local SQLite DB.
 *
 * Usage from the backend folder:
 *   node scripts/reset-admin.js
 *   node scripts/reset-admin.js admin@accessibility.local Admin@123
 *   node scripts/reset-admin.js you@company.com YourPasswordHere
 *
 * What it does:
 *   1. Opens backend/data/accessibility.sqlite (uses SQLITE_PATH env var if set)
 *   2. Lists all existing users so you can see what accounts exist
 *   3. Resets the target user's password OR creates the user if missing
 *   4. Sets role=admin, is_active=1
 *   5. Prints the resulting hash so you can verify
 *
 * Uses bcryptjs (same as db.ts after the swap) so hashes are compatible.
 */

const path = require("path");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

(async () => {
  const dbPath = process.env.SQLITE_PATH
    || path.join(__dirname, "..", "data", "accessibility.sqlite");
  const email = (process.argv[2] || "admin@accessibility.local").trim();
  const newPassword = process.argv[3] || "Admin@123";

  console.log("Opening DB at:", dbPath);
  const db = await open({ filename: dbPath, driver: sqlite3.Database });

  const users = await db.all("SELECT id, email, role, is_active FROM users");
  console.log("\n=== Existing users in DB ===");
  if (users.length === 0) {
    console.log("  (none — DB is empty)");
  } else {
    users.forEach(u => console.log(`  ${u.email}  role=${u.role}  active=${u.is_active}`));
  }

  const hash = await bcrypt.hash(newPassword, 12);

  const result = await db.run(
    `UPDATE users SET password_hash = ?, role = 'admin', is_active = 1, updated_at = datetime('now') WHERE email = ?`,
    [hash, email]
  );

  if (result.changes === 0) {
    await db.run(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES (?, ?, 'System Administrator', 'admin', 1)`,
      [email, hash]
    );
    console.log(`\n✓ CREATED new admin user`);
  } else {
    console.log(`\n✓ RESET password on existing user`);
  }

  console.log(`  email:    ${email}`);
  console.log(`  password: ${newPassword}`);
  console.log(`  hash:     ${hash.substring(0, 30)}...`);

  await db.close();
  console.log("\nYou can now log in with the credentials above.\n");
})().catch(err => {
  console.error("\n✗ FAILED:", err.message);
  console.error(err.stack);
  process.exit(1);
});
