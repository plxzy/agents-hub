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
