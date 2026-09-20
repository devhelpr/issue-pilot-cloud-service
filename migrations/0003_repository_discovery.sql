ALTER TABLE github_installations ADD COLUMN repository_sync_requested_at TEXT;
ALTER TABLE github_installations ADD COLUMN repository_sync_last_synced_at TEXT;
ALTER TABLE github_installations ADD COLUMN repository_sync_lease_until TEXT;
