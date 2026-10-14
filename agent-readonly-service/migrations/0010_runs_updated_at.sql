-- The panel's change check reads MAX(updated_at) on every poll; the index keeps that to one row.
CREATE INDEX IF NOT EXISTS runs_updated_at ON runs(updated_at);
