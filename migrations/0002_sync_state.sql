ALTER TABLE repositories ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'queued' CHECK(sync_status IN ('queued','running','completed','failed'));
ALTER TABLE repositories ADD COLUMN sync_error TEXT;
