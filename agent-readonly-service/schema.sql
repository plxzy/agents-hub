CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_published_at ON snapshots(published_at);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, agent TEXT NOT NULL, runner TEXT NOT NULL, status TEXT NOT NULL,
  started TEXT NOT NULL, ended TEXT, updated_at TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started);
