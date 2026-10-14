CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_published_at ON snapshots(published_at);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, agent TEXT NOT NULL, runner TEXT NOT NULL, status TEXT NOT NULL,
  started TEXT NOT NULL, ended TEXT, updated_at TEXT NOT NULL, receipt TEXT NOT NULL, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started);
CREATE INDEX IF NOT EXISTS runs_updated_at ON runs(updated_at);
CREATE INDEX IF NOT EXISTS runs_archived_started ON runs(archived_at, started);
CREATE TABLE IF NOT EXISTS accounts (
  slot TEXT PRIMARY KEY, state TEXT NOT NULL, until TEXT, last_error_kind TEXT, host TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- The user's decisions on Hub-held runs, and the one-time codes that authorise them (only the panel receives a code).
CREATE TABLE IF NOT EXISTS ratings (
  run_id TEXT PRIMARY KEY,
  rating TEXT NOT NULL,
  comment TEXT,
  rated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS confirmations (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS confirmations_expires ON confirmations(expires);
-- Reviewed memory notes held by the Hub: runners propose (candidate), the user decides in the panel (accepted/rejected).
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  proposed_by TEXT,
  source_run TEXT,
  created TEXT NOT NULL,
  decided TEXT,
  reason TEXT,
  supersedes TEXT
);
CREATE INDEX IF NOT EXISTS memory_status ON memory(status, scope);
-- Agent definitions, their skills and evals, published from the user's git (~/.agents) by `agent sync push`.
-- Git is the only writer; the Hub serves this to runners and to list_agents.
CREATE TABLE IF NOT EXISTS knowledge_files (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
