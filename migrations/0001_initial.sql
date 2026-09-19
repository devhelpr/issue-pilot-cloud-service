PRAGMA foreign_keys = ON;

CREATE TABLE github_installations (
  github_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL REFERENCES github_installations(github_id),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  access_status TEXT NOT NULL DEFAULT 'active' CHECK(access_status IN ('active','revoked')),
  sync_requested_at TEXT,
  sync_cursor INTEGER NOT NULL DEFAULT 1,
  sync_updated_after TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX repositories_installation_active_idx ON repositories(installation_id, active);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT NOT NULL UNIQUE,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  html_url TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK(state IN ('open','closed')),
  github_updated_at TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repository_id, number)
);
CREATE INDEX issues_repository_state_idx ON issues(repository_id, state, github_updated_at DESC);

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'received'
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  issue_version TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  issue_body TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','interrupted','cancelled')),
  phase TEXT,
  client_id TEXT,
  claim_id TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
  result_summary TEXT,
  commit_sha TEXT,
  pr_url TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX jobs_one_active_per_issue ON jobs(issue_id) WHERE status IN ('queued','running');
CREATE INDEX jobs_status_created_idx ON jobs(status, created_at DESC);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  event_type TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX job_events_job_idx ON job_events(job_id, id);
