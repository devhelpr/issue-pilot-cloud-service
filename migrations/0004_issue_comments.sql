CREATE TABLE issue_comments (
  github_id TEXT PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  author_login TEXT NOT NULL,
  body TEXT,
  html_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX issue_comments_issue_updated_idx ON issue_comments(issue_id, updated_at DESC);
CREATE INDEX issue_comments_issue_created_idx ON issue_comments(issue_id, created_at DESC);
