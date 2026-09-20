import { githubApiError, githubAppFetch, githubFetch } from './github';
import { issueUpsert } from './db';
import { allowedAccount } from './security';
import type { Env } from './types';

type Repository = { id: number; github_id: string; installation_id: string; owner: string; name: string; active: number; sync_cursor: number; sync_updated_after: string | null };
type Installation = { id: number; account: { id: number; login: string }; suspended_at: string | null };
type GitHubRepository = { id: number; owner: { login: string }; name: string; full_name: string };

// GitHub returns { installations, total_count } for this endpoint (not a bare array).
function installationPage(payload: unknown): Installation[] {
  if (Array.isArray(payload)) return payload as Installation[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { installations?: unknown }).installations)) {
    return (payload as { installations: Installation[] }).installations;
  }
  throw new Error('GitHub installations response had an unexpected shape');
}

function installationUpsert(env: Env, installation: Installation): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO github_installations (github_id, account_id, account_login, status)
    VALUES (?, ?, ?, 'active')
    ON CONFLICT(github_id) DO UPDATE SET
      account_id=excluded.account_id,
      account_login=excluded.account_login,
      status='active',
      updated_at=CURRENT_TIMESTAMP
    WHERE github_installations.account_id IS NOT excluded.account_id
       OR github_installations.account_login IS NOT excluded.account_login
       OR github_installations.status IS NOT 'active'`)
    .bind(String(installation.id), String(installation.account.id), installation.account.login);
}

export function repositoryUpsert(env: Env, installationId: string, repo: GitHubRepository): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO repositories (github_id, installation_id, owner, name, full_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET
      installation_id=excluded.installation_id,
      owner=excluded.owner,
      name=excluded.name,
      full_name=excluded.full_name,
      access_status='active',
      updated_at=CURRENT_TIMESTAMP
    WHERE repositories.installation_id IS NOT excluded.installation_id
       OR repositories.owner IS NOT excluded.owner
       OR repositories.name IS NOT excluded.name
       OR repositories.full_name IS NOT excluded.full_name
       OR repositories.access_status IS NOT 'active'`)
    .bind(String(repo.id), installationId, repo.owner.login, repo.name, repo.full_name);
}

/** Discover installations and persist only changed installation metadata. */
export async function discoverInstallations(env: Env): Promise<number> {
  let count = 0;
  for (let page = 1; ; page++) {
    const response = await githubAppFetch(env, `/app/installations?per_page=100&page=${page}`);
    if (!response.ok) throw await githubApiError(response);
    const discovered = installationPage(await response.json());
    const statements = discovered
      .filter((installation) => allowedAccount(env, String(installation.account.id)) && !installation.suspended_at)
      .map((installation) => installationUpsert(env, installation));
    if (statements.length) await env.DB.batch(statements);
    count += statements.length;
    if (discovered.length < 100) break;
  }
  return count;
}

/** Ask the scheduler to reconcile repositories. This operation is intentionally cheap and durable. */
export async function requestRepositoryRefresh(env: Env, installationId?: string): Promise<void> {
  if (installationId) {
    await env.DB.prepare("UPDATE github_installations SET repository_sync_requested_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE github_id=? AND status='active' AND repository_sync_requested_at IS NULL").bind(installationId).run();
    return;
  }
  await env.DB.prepare("UPDATE github_installations SET repository_sync_requested_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE status='active' AND repository_sync_requested_at IS NULL").run();
}

/** Reconcile one installation. The caller owns the lease. */
export async function refreshInstallationRepositories(env: Env, installationId: string): Promise<number> {
  const installation = await env.DB.prepare("SELECT github_id FROM github_installations WHERE github_id=? AND status='active'").bind(installationId).first<{ github_id: string }>();
  if (!installation) return 0;
  let count = 0;
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const response = await githubFetch(env, installationId, `/installation/repositories?per_page=100&page=${page}`);
    if (!response.ok) throw await githubApiError(response);
    const data = await response.json() as { repositories: GitHubRepository[] };
    data.repositories.forEach((repo) => seen.add(String(repo.id)));
    if (data.repositories.length) await env.DB.batch(data.repositories.map((repo) => repositoryUpsert(env, installationId, repo)));
    count += data.repositories.length;
    if (data.repositories.length < 100) break;
  }
  const existing = (await env.DB.prepare('SELECT github_id FROM repositories WHERE installation_id=?').bind(installationId).all<{ github_id: string }>()).results;
  const stale = existing.map((repo) => repo.github_id).filter((githubId) => !seen.has(githubId));
  for (let offset = 0; offset < stale.length; offset += 99) {
    const chunk = stale.slice(offset, offset + 99);
    const placeholders = chunk.map(() => '?').join(',');
    await env.DB.batch([
      env.DB.prepare(`UPDATE repositories SET active=0, access_status='revoked', updated_at=CURRENT_TIMESTAMP
        WHERE installation_id=? AND github_id IN (${placeholders}) AND (active=1 OR access_status='active')`).bind(installationId, ...chunk),
      env.DB.prepare(`UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE status='running'
        AND issue_id IN (SELECT id FROM issues WHERE repository_id IN (SELECT id FROM repositories WHERE installation_id=? AND github_id IN (${placeholders})))`).bind(installationId, ...chunk)
    ]);
  }
  return count;
}

/** Manual repair/bootstrap path. Normal desktop reads do not call this. */
export async function refreshRepositories(env: Env): Promise<number> {
  await discoverInstallations(env);
  await requestRepositoryRefresh(env);
  return (await env.DB.prepare("SELECT COUNT(*) AS count FROM repositories WHERE access_status='active'").first<{ count: number }>())?.count ?? 0;
}

export async function syncRepository(env: Env, repository: Repository): Promise<{ done: boolean; imported: number }> {
  await env.DB.prepare("UPDATE repositories SET sync_status='running', sync_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(repository.id).run();
  const params = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'asc', per_page: '100', page: String(repository.sync_cursor) });
  if (repository.sync_updated_after) params.set('since', new Date(Date.parse(repository.sync_updated_after) - 60_000).toISOString());
  const response = await githubFetch(env, repository.installation_id, `/repos/${repository.owner}/${repository.name}/issues?${params}`);
  if (response.status === 403 || response.status === 404) {
    await env.DB.batch([
      env.DB.prepare("UPDATE repositories SET access_status='revoked', active=0, sync_status='failed', sync_error='GitHub repository access was revoked', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(repository.id),
      env.DB.prepare("UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE status='running' AND issue_id IN (SELECT id FROM issues WHERE repository_id=?)").bind(repository.id)
    ]);
    return { done: true, imported: 0 };
  }
  if (!response.ok) throw new Error(`GitHub issue sync failed (${response.status})`);
  const issues = await response.json() as any[];
  const done = issues.length < 100;
  const latest = issues.at(-1)?.updated_at ?? repository.sync_updated_after;
  // The page checkpoint only advances in the same transaction as all its version-guarded issue writes.
  await env.DB.batch([
    ...issues.map((issue) => issueUpsert(env.DB, repository.id, issue)).filter((statement): statement is D1PreparedStatement => Boolean(statement)),
    env.DB.prepare(`UPDATE repositories SET sync_cursor=?, sync_updated_after=?, last_synced_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_synced_at END,
      sync_requested_at=CASE WHEN ? THEN NULL ELSE sync_requested_at END, sync_status=?, sync_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(done ? 1 : repository.sync_cursor + 1, latest, done ? 1 : 0, done ? 1 : 0, done ? 'completed' : 'running', repository.id)
  ]);
  return { done, imported: issues.filter((issue) => !issue.pull_request).length };
}

async function runRepositoryDiscovery(env: Env): Promise<void> {
  const discovery = await env.DB.prepare(`SELECT github_id FROM github_installations
    WHERE status='active'
      AND (repository_sync_requested_at IS NOT NULL
        OR repository_sync_last_synced_at IS NULL
        OR repository_sync_last_synced_at < datetime('now', '-1 hour'))
      AND (repository_sync_lease_until IS NULL OR repository_sync_lease_until < CURRENT_TIMESTAMP)
    ORDER BY repository_sync_requested_at IS NULL, repository_sync_last_synced_at
    LIMIT 1`).first<{ github_id: string }>();
  if (!discovery) return;

  const claimed = await env.DB.prepare(`UPDATE github_installations
    SET repository_sync_lease_until=datetime('now', '+10 minutes')
    WHERE github_id=? AND status='active'
      AND (repository_sync_lease_until IS NULL OR repository_sync_lease_until < CURRENT_TIMESTAMP)`).bind(discovery.github_id).run();
  if (!claimed.meta.changes) return;

  try {
    await refreshInstallationRepositories(env, discovery.github_id);
    await env.DB.prepare(`UPDATE github_installations
      SET repository_sync_requested_at=NULL, repository_sync_last_synced_at=CURRENT_TIMESTAMP,
          repository_sync_lease_until=NULL, updated_at=CURRENT_TIMESTAMP WHERE github_id=?`).bind(discovery.github_id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE github_installations SET repository_sync_lease_until=NULL, updated_at=CURRENT_TIMESTAMP WHERE github_id=?").bind(discovery.github_id).run();
    throw error;
  }
}

export async function runScheduledSync(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status='interrupted', updated_at=CURRENT_TIMESTAMP WHERE status='running' AND heartbeat_at < datetime('now', '-5 minutes')").run();
  try { await runRepositoryDiscovery(env); }
  catch (error) { console.log(JSON.stringify({ code: 'repository_discovery_failed', message: error instanceof Error ? error.message : 'unknown' })); }
  const repositories = await env.DB.prepare(`SELECT id, github_id, installation_id, owner, name, active, sync_cursor, sync_updated_after FROM repositories
    WHERE active=1 AND access_status='active' AND (sync_requested_at IS NOT NULL OR last_synced_at IS NULL OR last_synced_at < datetime('now', '-15 minutes')) LIMIT 5`).all<Repository>();
  for (const repository of repositories.results) {
    try { await syncRepository(env, repository); } catch (error) { const message = error instanceof Error ? error.message : 'unknown'; await env.DB.prepare("UPDATE repositories SET sync_status='failed', sync_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(message.slice(0, 1000), repository.id).run(); console.log(JSON.stringify({ code: 'sync_failed', repository_id: repository.id, message })); }
  }
}
