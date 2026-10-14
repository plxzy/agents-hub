CREATE TABLE IF NOT EXISTS review_repositories (
  repo TEXT PRIMARY KEY, github TEXT NOT NULL UNIQUE, base TEXT NOT NULL DEFAULT 'main', enabled_after TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_publications (
  run_id TEXT PRIMARY KEY, repo TEXT NOT NULL, root TEXT NOT NULL,
  commit_sha TEXT NOT NULL, receipt TEXT NOT NULL, manifest TEXT,
  started TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  error TEXT, published_at TEXT, pr_number INTEGER, pr_url TEXT
);
CREATE INDEX IF NOT EXISTS review_publications_due ON review_publications(status, due);
CREATE INDEX IF NOT EXISTS review_publications_root ON review_publications(root, started);
CREATE TABLE IF NOT EXISTS review_threads (
  root TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
  pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_publisher_health (id INTEGER PRIMARY KEY CHECK(id=1), observed_at TEXT NOT NULL);
