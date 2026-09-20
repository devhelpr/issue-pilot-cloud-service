import { githubAppFetch, githubFetch } from './github';
import { cancelQueuedJobs, upsertIssue } from './db';
import { allowedAccount } from './security';
import type { Env } from './types';

type Repository = { id: number; github_id: string; installation_id: string; owner: string; name: string; active: number; sync_cursor: number; sync_updated_after: string | null };

export async function refreshRepositories(env: Env): Promise<number> {
  for (let page = 1; ; page++) {
    const response = await githubAppFetch(env, `/app/installations?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitHub installations failed (${response.status})`);
    const discovered = await response.json() as Array<{ id: number; account: { id: number; login: string }; suspended_at: string | null }>;
    for (const installation of discovered) {
      if (!allowedAccount(env, String(installation.account.id)) || installation.suspended_at) continue;
      await env.DB.prepare(`INSERT INTO github_installations (github_id, account_id, account_login, status)
        VALUES (?, ?, ?, 'active') ON CONFLICT(github_id) DO UPDATE SET account_id=excluded.account_id, account_login=excluded.account_login, status='active', updated_at=CURRENT_TIMESTAMP`)
        .bind(String(installation.id), String(installation.account.id), installation.account.login).run();
    }
    if (discovered.length < 100) break;
  }
  const installations = (await env.DB.prepare("SELECT github_id FROM github_installations WHERE status='active'").all<{ github_id: string }>()).results;
  let count = 0;
  for (const installation of installations) {
    const response = await githubFetch(env, installation.github_id, '/installation/repositories?per_page=100');
    if (!response.ok) throw new Error(`GitHub repositories failed (${response.status})`);
    const data = await response.json() as { repositories: any[] };
    for (const repo of data.repositories) {
      await env.DB.prepare(`INSERT INTO repositories (github_id, installation_id, owner, name, full_name)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(github_id) DO UPDATE SET installation_id=excluded.installation_id, owner=excluded.owner, name=excluded.name, full_name=excluded.full_name, access_status='active', updated_at=CURRENT_TIMESTAMP`)
        .bind(String(repo.id), installation.github_id, repo.owner.login, repo.name, repo.full_name).run();
      count++;
    }
  }
  return count;
}

export async function syncRepository(env: Env, repository: Repository): Promise<{ done: boolean; imported: number }> {
  const params = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'asc', per_page: '100', page: String(repository.sync_cursor) });
  if (repository.sync_updated_after) params.set('since', new Date(Date.parse(repository.sync_updated_after) - 60_000).toISOString());
  const response = await githubFetch(env, repository.installation_id, `/repos/${repository.owner}/${repository.name}/issues?${params}`);
  if (response.status === 403 || response.status === 404) {
    await env.DB.prepare("UPDATE repositories SET access_status='revoked', active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(repository.id).run();
    return { done: true, imported: 0 };
  }
  if (!response.ok) throw new Error(`GitHub issue sync failed (${response.status})`);
  const issues = await response.json() as any[];
  for (const issue of issues) await upsertIssue(env.DB, repository.id, issue);
  const done = issues.length < 100;
  const latest = issues.at(-1)?.updated_at ?? repository.sync_updated_after;
  await env.DB.prepare(`UPDATE repositories SET sync_cursor=?, sync_updated_after=?, last_synced_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_synced_at END,
    sync_requested_at=CASE WHEN ? THEN NULL ELSE sync_requested_at END, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(done ? 1 : repository.sync_cursor + 1, latest, done ? 1 : 0, done ? 1 : 0, repository.id).run();
  return { done, imported: issues.filter((issue) => !issue.pull_request).length };
}

export async function runScheduledSync(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status='interrupted', updated_at=CURRENT_TIMESTAMP WHERE status='running' AND heartbeat_at < datetime('now', '-5 minutes')").run();
  const repositories = await env.DB.prepare(`SELECT id, github_id, installation_id, owner, name, active, sync_cursor, sync_updated_after FROM repositories
    WHERE active=1 AND access_status='active' AND (sync_requested_at IS NOT NULL OR last_synced_at IS NULL OR last_synced_at < datetime('now', '-15 minutes')) LIMIT 5`).all<Repository>();
  for (const repository of repositories.results) {
    try { await syncRepository(env, repository); } catch (error) { console.log(JSON.stringify({ code: 'sync_failed', repository_id: repository.id, message: error instanceof Error ? error.message : 'unknown' })); }
  }
}
