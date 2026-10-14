CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_published_at ON snapshots(published_at);
