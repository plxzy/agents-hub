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
