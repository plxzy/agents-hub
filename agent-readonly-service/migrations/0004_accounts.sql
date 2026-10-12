-- Shared model-account state for runners (limits are per account, so every runner sees the same cooldowns).
CREATE TABLE IF NOT EXISTS accounts (
  slot TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  until TEXT,
  last_error_kind TEXT,
  host TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
