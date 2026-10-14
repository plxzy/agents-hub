-- Run receipts posted by runners (dok first). The Hub is their durable home; newest 1000 are kept.
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  runner TEXT NOT NULL,
  status TEXT NOT NULL,
  started TEXT NOT NULL,
  ended TEXT,
  updated_at TEXT NOT NULL,
  receipt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started);
