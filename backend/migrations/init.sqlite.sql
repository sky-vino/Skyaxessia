CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','analyst','viewer')),
  avatar_url    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  name            TEXT,
  urls            TEXT NOT NULL,
  navigated_urls  TEXT,
  state_label     TEXT NOT NULL DEFAULT 'default',
  scan_options    TEXT NOT NULL DEFAULT '{}',
  auth_config     TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  progress        INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  started_at      TEXT,
  completed_at    TEXT,
  error_message   TEXT,
  total_issues    INTEGER NOT NULL DEFAULT 0,
  critical_count  INTEGER NOT NULL DEFAULT 0,
  serious_count   INTEGER NOT NULL DEFAULT 0,
  moderate_count  INTEGER NOT NULL DEFAULT 0,
  minor_count     INTEGER NOT NULL DEFAULT 0,
  score           REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scans_project ON scans(project_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_by ON scans(created_by);
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC);

CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  scan_id         TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('critical','serious','moderate','minor')),
  priority        INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  category        TEXT,
  message         TEXT NOT NULL,
  url             TEXT NOT NULL,
  selector        TEXT,
  selectors       TEXT,
  affected_elements TEXT,
  depths          TEXT,
  wcag_criteria   TEXT,
  act_rules       TEXT,
  tags            TEXT,
  help_url        TEXT,
  html_snippet    TEXT,
  fix_suggestion  TEXT,
  evidence_screenshot TEXT,
  evidence_explanation TEXT,
  ai_explanation  TEXT,
  ai_impact       TEXT,
  ai_fix_code     TEXT,
  component_id    TEXT,
  component_owner TEXT,
  source_hint     TEXT,
  state_label     TEXT,
  phase           TEXT,
  is_resolved     INTEGER NOT NULL DEFAULT 0,
  false_positive  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_scan ON issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON issues(severity);
CREATE INDEX IF NOT EXISTS idx_issues_rule ON issues(rule_id);
CREATE INDEX IF NOT EXISTS idx_issues_url ON issues(url);

CREATE TABLE IF NOT EXISTS test_cases (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  issue_id    TEXT REFERENCES issues(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  wcag_ref    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pass','fail','pending','skipped','manual')),
  steps       TEXT,
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_test_cases_scan ON test_cases(scan_id);

CREATE TABLE IF NOT EXISTS dom_snapshots (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  phase       TEXT,
  html        TEXT,
  a11y_tree   TEXT,
  screenshot  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dom_snapshots_scan ON dom_snapshots(scan_id);

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
