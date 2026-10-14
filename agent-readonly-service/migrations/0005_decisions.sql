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
