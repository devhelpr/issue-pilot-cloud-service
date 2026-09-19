import { beforeAll, describe, expect, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import migrationSql from '../migrations/0001_initial.sql?raw';

declare module 'cloudflare:test' {
  interface ProvidedEnv { DB: D1Database }
}

const auth = { Authorization: 'Bearer test-desktop-token' };

describe('approved job lifecycle', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, [{ name: '0001_initial.sql', queries: migrationSql.split(';').map((query) => query.trim()).filter(Boolean) }]);
    await env.DB.prepare("INSERT INTO github_installations (github_id, account_id, account_login) VALUES ('10','1','owner')").run();
    await env.DB.prepare("INSERT INTO repositories (github_id, installation_id, owner, name, full_name, active) VALUES ('20','10','owner','repo','owner/repo',1)").run();
    await env.DB.prepare("INSERT INTO issues (github_id, repository_id, number, title, body, html_url, state, github_updated_at, version) VALUES ('30',1,1,'Fix it','Details','https://github.test/owner/repo/issues/1','open','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')").run();
  });

  it('requires auth, queues after approval, and lets only one claim win', async () => {
    expect((await SELF.fetch('https://worker.test/v1/issues')).status).toBe(401);
    const approved = await SELF.fetch('https://worker.test/v1/issues/1/approve', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'Idempotency-Key': 'test-key-1' }, body: JSON.stringify({ version: '2025-01-01T00:00:00Z' }) });
    expect(approved.status).toBe(201);
    const job = await approved.json<{ id: string }>();
    const first = await SELF.fetch(`https://worker.test/v1/jobs/${job.id}/claim`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'mac', claim_id: '00000000-0000-4000-8000-000000000001' }) });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`https://worker.test/v1/jobs/${job.id}/claim`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'other', claim_id: '00000000-0000-4000-8000-000000000002' }) });
    expect(second.status).toBe(409);
  });
});
