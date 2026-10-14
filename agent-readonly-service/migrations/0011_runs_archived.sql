-- Runs the user archived in the panel. The panel reads only unarchived runs, newest first.
ALTER TABLE runs ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS runs_archived_started ON runs(archived_at, started);
