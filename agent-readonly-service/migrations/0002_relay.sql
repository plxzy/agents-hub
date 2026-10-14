CREATE TABLE IF NOT EXISTS relay_status (
  id INTEGER PRIMARY KEY CHECK (id = 1), seen INTEGER NOT NULL,
  enabled INTEGER NOT NULL, agents TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_jobs (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, args TEXT, fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'done')),
  created INTEGER NOT NULL, expires INTEGER NOT NULL, result TEXT
);
CREATE INDEX IF NOT EXISTS relay_jobs_pending ON relay_jobs(state, created);
