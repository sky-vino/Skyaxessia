import path from "path";
import fs from "fs/promises";
import bcrypt from "bcryptjs";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { logger } from "./logger";

type QueryResult<T = any> = { rows: T[] };

const jsonColumns = new Set([
  "urls",
  "navigated_urls",
  "scan_options",
  "auth_config",
  "selectors",
  "depths",
  "wcag_criteria",
  "act_rules",
  "tags",
  "steps",
  "a11y_tree",
  "current_wcag",
  "suggested_wcag"
]);

const booleanColumns = new Set(["is_active", "is_resolved", "false_positive"]);

function sqlitePath(): string {
  const configured =
    process.env.SQLITE_PATH ||
    process.env.DATABASE_URL ||
    "data/accessibility.sqlite";
  if (configured.startsWith("sqlite://")) {
    return configured.slice("sqlite://".length);
  }
  return configured;
}

function normalizeValue(value: any): any {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object" && !(value instanceof Date))
    return JSON.stringify(value);
  return value;
}

function hydrateRow(row: any): any {
  for (const key of Object.keys(row)) {
    if (key === "COUNT(*)") {
      row.count = row[key];
    }
    if (booleanColumns.has(key)) {
      row[key] = Boolean(row[key]);
    }
    if (jsonColumns.has(key) && typeof row[key] === "string" && row[key].length) {
      try {
        row[key] = JSON.parse(row[key]);
      } catch {
        // Keep legacy plain-text values as-is.
      }
    }
  }
  return row;
}

function toSqlite(sql: string, params: any[] = []): { sql: string; params: any[] } {
  const orderedParams: any[] = [];
  let converted = sql
    .replace(/NOW\(\)\s*\+\s*INTERVAL\s+'7 days'/gi, "datetime('now', '+7 days')")
    .replace(/NOW\(\)/gi, "datetime('now')");

  converted = converted.replace(/\$(\d+)/g, (_match, index) => {
    orderedParams.push(normalizeValue(params[Number(index) - 1]));
    return "?";
  });

  return {
    sql: converted,
    params: orderedParams.length ? orderedParams : params.map(normalizeValue)
  };
}

class SqlitePool {
  private connection?: Database;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const dbFile = path.resolve(process.cwd(), sqlitePath());
    await fs.mkdir(path.dirname(dbFile), { recursive: true });

    this.connection = await open({
      filename: dbFile,
      driver: sqlite3.Database
    });

    await this.connection.exec("PRAGMA foreign_keys = ON;");
    const schema = await fs.readFile(
      path.resolve(process.cwd(), "migrations", "init.sqlite.sql"),
      "utf8"
    );
    await this.connection.exec(schema);
    await this.ensureIssueEvidenceColumns();
    await this.ensureScanNavigationColumns();
    await this.ensureAuditEventsTable();
    await this.ensureWcagGovernanceTables();
    await this.ensureDefaultAdmin();
    await this.ensureDefaultUsers();

    logger.info(`SQLite database ready at ${dbFile}`);
  }

  private async ensureScanNavigationColumns(): Promise<void> {
    const columns = await this.connection!.all("PRAGMA table_info(scans)");
    const existing = new Set(columns.map((column: any) => column.name));
    if (!existing.has("navigated_urls")) {
      await this.connection!.exec("ALTER TABLE scans ADD COLUMN navigated_urls TEXT;");
    }
  }

  private async ensureIssueEvidenceColumns(): Promise<void> {
    const columns = await this.connection!.all("PRAGMA table_info(issues)");
    const existing = new Set(columns.map((column: any) => column.name));
    if (!existing.has("evidence_screenshot")) {
      await this.connection!.exec("ALTER TABLE issues ADD COLUMN evidence_screenshot TEXT;");
    }
    if (!existing.has("evidence_explanation")) {
      await this.connection!.exec("ALTER TABLE issues ADD COLUMN evidence_explanation TEXT;");
    }
  }

  private async ensureAuditEventsTable(): Promise<void> {
    await this.connection!.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
        actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        action      TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT,
        entity_name TEXT,
        metadata    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
    `);
  }

  private async ensureWcagGovernanceTables(): Promise<void> {
    await this.connection!.exec(`
      CREATE TABLE IF NOT EXISTS wcag_mappings (
        id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
        rule_id        TEXT NOT NULL,
        wcag_criteria  TEXT NOT NULL,
        mapping_status TEXT NOT NULL DEFAULT 'review_required' CHECK (mapping_status IN ('active', 'review_required', 'rejected')),
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at    TEXT,
        review_notes   TEXT,
        UNIQUE(rule_id, wcag_criteria)
      );

      CREATE TABLE IF NOT EXISTS wcag_governance_logs (
        id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
        mapping_id     TEXT NOT NULL REFERENCES wcag_mappings(id) ON DELETE CASCADE,
        action         TEXT NOT NULL CHECK (action IN ('created', 'approved', 'rejected', 'auto_cached')),
        performed_by   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        notes          TEXT,
        timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_wcag_mappings_rule_id ON wcag_mappings(rule_id);
      CREATE INDEX IF NOT EXISTS idx_wcag_mappings_status ON wcag_mappings(mapping_status);
      CREATE INDEX IF NOT EXISTS idx_wcag_mappings_created ON wcag_mappings(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wcag_governance_logs_mapping ON wcag_governance_logs(mapping_id);
      CREATE INDEX IF NOT EXISTS idx_wcag_governance_logs_timestamp ON wcag_governance_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_wcag_governance_logs_action ON wcag_governance_logs(action);

      CREATE TABLE IF NOT EXISTS wcag_metadata (
        criterion   TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        level       TEXT,
        principle   TEXT,
        url         TEXT,
        source      TEXT,
        fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS wcag_mapping_reviews (
        id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
        rule_id        TEXT NOT NULL,
        current_wcag   TEXT NOT NULL,
        suggested_wcag TEXT,
        reason         TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed','resolved')),
        first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at    TEXT,
        UNIQUE(rule_id, current_wcag, reason)
      );

      CREATE INDEX IF NOT EXISTS idx_wcag_mapping_reviews_status ON wcag_mapping_reviews(status);
      CREATE INDEX IF NOT EXISTS idx_wcag_mapping_reviews_last_seen ON wcag_mapping_reviews(last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS wcag_rule_registry (
        rule_id             TEXT PRIMARY KEY,
        rule_name           TEXT NOT NULL,
        category            TEXT,
        default_wcag        TEXT NOT NULL DEFAULT '[]',
        approved_wcag       TEXT NOT NULL DEFAULT '[]',
        mapping_status      TEXT NOT NULL DEFAULT 'review_required' CHECK (mapping_status IN ('approved','review_required','rejected','obsolete','advisory')),
        review_status       TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected','resolved')),
        source_module       TEXT,
        rationale           TEXT,
        last_reviewed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
        last_reviewed_at    TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS wcag_mapping_decisions (
        id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
        rule_id          TEXT NOT NULL REFERENCES wcag_rule_registry(rule_id) ON DELETE CASCADE,
        previous_wcag    TEXT,
        decided_wcag     TEXT NOT NULL DEFAULT '[]',
        decision         TEXT NOT NULL CHECK (decision IN ('accepted','dismissed','resolved','registered','auto_review_required')),
        reason           TEXT,
        decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_wcag_rule_registry_status ON wcag_rule_registry(mapping_status, review_status);
      CREATE INDEX IF NOT EXISTS idx_wcag_rule_registry_updated ON wcag_rule_registry(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wcag_mapping_decisions_rule ON wcag_mapping_decisions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_wcag_mapping_decisions_date ON wcag_mapping_decisions(decided_at DESC);
    `);
  }

  private async ensureDefaultAdmin(): Promise<void> {
    const email = process.env.DEFAULT_ADMIN_EMAIL || "admin@axessia.local";
    const password = process.env.DEFAULT_ADMIN_PASSWORD || "Admin@123";
    const hash = await bcrypt.hash(password, 12);

    await this.connection!.run(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, 'admin', 1)
       ON CONFLICT(email) DO UPDATE SET
         password_hash = excluded.password_hash,
         role = 'admin',
         is_active = 1,
         updated_at = datetime('now')`,
      [email, hash, "System Administrator"]
    );
  }

  private async ensureDefaultUsers(): Promise<void> {
    const password = "Accessibility";
    const hash = await bcrypt.hash(password, 12);
    for (let index = 1; index <= 5; index++) {
      const username = `user${index}`;
      await this.connection!.run(
        `INSERT INTO users (email, password_hash, full_name, role, is_active)
         VALUES (?, ?, ?, 'analyst', 1)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash,
           full_name = excluded.full_name,
           role = 'analyst',
           is_active = 1,
           updated_at = datetime('now')`,
        [username, hash, `User ${index}`]
      );
    }
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    await this.ready;
    const query = toSqlite(sql, params);
    const returnsRows =
      /^\s*(SELECT|WITH|PRAGMA)\b/i.test(query.sql) || /\bRETURNING\b/i.test(query.sql);

    if (returnsRows) {
      const rows = await this.connection!.all(query.sql, query.params);
      return { rows: rows.map(hydrateRow) as T[] };
    }

    await this.connection!.run(query.sql, query.params);
    return { rows: [] };
  }
}

export const db = new SqlitePool();
