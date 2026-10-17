-- Operator actions on runs (cancel, pause, dismiss, retry_inspection): one row per accepted request, with the run's state before and after.
CREATE TABLE IF NOT EXISTS run_actions (
  action_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL,
  caller TEXT NOT NULL,
  reason TEXT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_actions_run ON run_actions(run_id, created_at);
