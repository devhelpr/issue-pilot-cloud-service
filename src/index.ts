import { Hono } from 'hono';
import { z } from 'zod';
import { event, id, issueUpsert } from './db';
import { allowedAccount, isAuthorized, verifyWebhook } from './security';
import { openapi } from './openapi';
import { discoverInstallations, repositoryUpsert, requestRepositoryRefresh, runScheduledSync, syncRepository } from './sync';
import { GitHubApiError } from './github';
import type { Env, JobStatus } from './types';

const app = new Hono<{ Bindings: Env }>();
const jsonError = (code: string, message: string, requestId: string, status = 400) => new Response(JSON.stringify({ code, message, request_id: requestId }), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const requestId = () => crypto.randomUUID();
const page = (value: string | undefined) => Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);
type Cursor = { key: string; id: number | string };
const encodeCursor = (value: Cursor) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decodeCursor = (raw: string | undefined): Cursor | undefined => {
  if (!raw) return undefined;
  try {
    const padded = raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - raw.length % 4) % 4);
    const value = JSON.parse(atob(padded));
    if (typeof value?.key !== 'string' || (typeof value.id !== 'string' && typeof value.id !== 'number')) throw new Error('invalid');
    return value;
  } catch { throw new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'Invalid cursor' }]); }
};

app.use('/v1/*', async (c, next) => {
  if (!isAuthorized(c.req.raw, c.env)) return jsonError('unauthorized', 'Missing or invalid bearer token', requestId(), 401);
  await next();
});
app.onError((error, c) => {
  const rid = requestId();
  if (error instanceof z.ZodError) return jsonError('invalid_request', 'Request validation failed', rid, 400);
  if (error instanceof GitHubApiError) {
    const headers = new Headers({ 'content-type': error.contentType ?? 'application/json', 'x-request-id': rid });
    if (error.githubRequestId) headers.set('x-github-request-id', error.githubRequestId);
    return new Response(error.body, { status: error.status, headers });
  }
  console.log(JSON.stringify({ code: 'internal_error', request_id: rid, message: error.message }));
  return jsonError('internal_error', 'Internal server error', rid, 500);
});

app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/openapi.json', (c) => c.json(openapi));

app.post('/github/webhook', async (c) => {
  const raw = await c.req.raw.arrayBuffer();
  if (!(await verifyWebhook(c.env.WEBHOOK_SECRET, raw, c.req.header('X-Hub-Signature-256')))) return c.text('Unauthorized', 401);
  const deliveryId = c.req.header('X-GitHub-Delivery');
  const eventName = c.req.header('X-GitHub-Event') ?? 'unknown';
  if (!deliveryId) return c.text('Missing delivery ID', 400);
  const exists = await c.env.DB.prepare('SELECT delivery_id FROM webhook_deliveries WHERE delivery_id=?').bind(deliveryId).first();
  if (exists) return c.json({ accepted: true, duplicate: true }, 202);
  const payload = JSON.parse(new TextDecoder().decode(raw));
  await c.env.DB.prepare('INSERT INTO webhook_deliveries (delivery_id, event) VALUES (?, ?)').bind(deliveryId, eventName).run();
  try {
    if (eventName === 'installation' || eventName === 'installation_repositories') await handleInstallation(c.env, payload);
    if (eventName === 'issues') await handleIssue(c.env, payload);
    if (eventName === 'issue_comment') await handleIssueComment(c.env, payload);
    await c.env.DB.prepare("UPDATE webhook_deliveries SET outcome='processed', processed_at=CURRENT_TIMESTAMP WHERE delivery_id=?").bind(deliveryId).run();
  } catch (error) {
    await c.env.DB.prepare("UPDATE webhook_deliveries SET outcome='failed', processed_at=CURRENT_TIMESTAMP WHERE delivery_id=?").bind(deliveryId).run();
    throw error;
  }
  return c.json({ accepted: true }, 202);
});

app.post('/v1/github/sync', async (c) => {
  const installations = await discoverInstallations(c.env);
  await requestRepositoryRefresh(c.env);
  return c.json({ requested: true, installations }, 202);
});
app.get('/v1/repositories', async (c) => {
  const limit = page(c.req.query('limit')); const cursor = decodeCursor(c.req.query('cursor'));
  const rows = await c.env.DB.prepare(`SELECT * FROM repositories ${cursor ? 'WHERE (full_name > ? OR (full_name = ? AND id > ?))' : ''} ORDER BY full_name, id LIMIT ?`)
    .bind(...(cursor ? [cursor.key, cursor.key, cursor.id, limit + 1] : [limit + 1])).all<any>();
  const items = rows.results.slice(0, limit); const last = items.at(-1);
  return c.json({ items, next_cursor: rows.results.length > limit && last ? encodeCursor({ key: last.full_name, id: last.id }) : null });
});
app.patch('/v1/repositories/:id', async (c) => {
  const body = z.object({ active: z.boolean() }).parse(await c.req.json());
  const repo = await c.env.DB.prepare('SELECT * FROM repositories WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!repo) return jsonError('not_found', 'Repository not found', requestId(), 404);
  if (body.active && repo.access_status !== 'active') return jsonError('access_revoked', 'Repository access was revoked', requestId(), 409);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE repositories SET active=?, sync_requested_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sync_requested_at END, sync_cursor=CASE WHEN ? THEN 1 ELSE sync_cursor END, sync_status=CASE WHEN ? THEN 'queued' ELSE sync_status END, sync_error=CASE WHEN ? THEN NULL ELSE sync_error END, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.active ? 1 : 0, body.active ? 1 : 0, body.active ? 1 : 0, body.active ? 1 : 0, body.active ? 1 : 0, repo.id),
    ...(body.active ? [] : [c.env.DB.prepare("UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE status='running' AND issue_id IN (SELECT id FROM issues WHERE repository_id=?)").bind(repo.id)])
  ]);
  return c.json({ id: repo.id, active: body.active });
});
app.post('/v1/repositories/:id/sync', async (c) => {
  const repo = await c.env.DB.prepare('SELECT * FROM repositories WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!repo) return jsonError('not_found', 'Repository not found', requestId(), 404);
  await c.env.DB.prepare("UPDATE repositories SET sync_requested_at=CURRENT_TIMESTAMP, sync_cursor=1, sync_updated_after=NULL, sync_status='queued', sync_error=NULL WHERE id=?").bind(repo.id).run();
  return c.json({ requested: true }, 202);
});
app.get('/v1/issues', async (c) => {
  const status = c.req.query('state'); const repo = c.req.query('repository_id'); const limit = page(c.req.query('limit'));
  const clauses = ['1=1']; const values: unknown[] = []; const cursor = decodeCursor(c.req.query('cursor'));
  if (status) { clauses.push('i.state=?'); values.push(status); } if (repo) { clauses.push('i.repository_id=?'); values.push(repo); }
  if (cursor) { clauses.push('(i.github_updated_at < ? OR (i.github_updated_at = ? AND i.id < ?))'); values.push(cursor.key, cursor.key, cursor.id); }
  values.push(limit + 1);
  const result = await c.env.DB.prepare(`SELECT i.*, r.full_name, r.active FROM issues i JOIN repositories r ON r.id=i.repository_id WHERE ${clauses.join(' AND ')} ORDER BY i.github_updated_at DESC, i.id DESC LIMIT ?`).bind(...values).all<any>();
  const items = result.results.slice(0, limit); const last = items.at(-1);
  return c.json({ items, next_cursor: result.results.length > limit && last ? encodeCursor({ key: last.github_updated_at, id: last.id }) : null });
});
app.get('/v1/issues/:id/comments', async (c) => {
  const issueId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(issueId) || issueId <= 0) return jsonError('invalid_issue_id', 'Issue ID must be a positive integer', requestId(), 400);
  const issue = await c.env.DB.prepare("SELECT i.id FROM issues i JOIN repositories r ON r.id=i.repository_id WHERE i.id=? AND r.active=1 AND r.access_status='active'").bind(issueId).first<{ id: number }>();
  if (!issue) return jsonError('not_found', 'Active issue not found', requestId(), 404);
  const limit = page(c.req.query('limit'));
  const since = c.req.query('since');
  const rows = await c.env.DB.prepare(`SELECT CAST(github_id AS INTEGER) AS id, author_login, body, html_url, created_at, updated_at
    FROM issue_comments WHERE issue_id=? AND deleted_at IS NULL ${since ? 'AND updated_at > ?' : ''}
    ORDER BY updated_at DESC, github_id DESC LIMIT ?`)
    .bind(...(since ? [issueId, since, limit] : [issueId, limit])).all();
  return c.json({ items: rows.results });
});
app.post('/v1/issues/:id/approve', async (c) => {
  const body = z.object({ version: z.string() }).parse(await c.req.json()); const key = c.req.header('Idempotency-Key');
  if (!key) return jsonError('missing_idempotency_key', 'Idempotency-Key is required', requestId(), 400);
  const issue = await c.env.DB.prepare('SELECT i.*, r.active, r.access_status FROM issues i JOIN repositories r ON r.id=i.repository_id WHERE i.id=?').bind(c.req.param('id')).first<any>();
  if (!issue) return jsonError('not_found', 'Issue not found', requestId(), 404);
  if (issue.version !== body.version) return jsonError('issue_changed', 'Issue changed; review it again', requestId(), 409);
  if (!issue.active || issue.access_status !== 'active' || issue.state !== 'open') return jsonError('not_runnable', 'Issue is not runnable', requestId(), 409);
  const existing = await c.env.DB.prepare('SELECT * FROM jobs WHERE idempotency_key=?').bind(key).first(); if (existing) return c.json(existing, 200);
  const jobId = id();
  try { await c.env.DB.batch([c.env.DB.prepare('INSERT INTO jobs (id, issue_id, issue_version, issue_title, issue_body, status, idempotency_key) VALUES (?, ?, ?, ?, ?, \'queued\', ?)').bind(jobId, issue.id, issue.version, issue.title, issue.body, key), c.env.DB.prepare('INSERT INTO job_events (job_id, event_type, detail_json) VALUES (?, \'queued\', \'{}\')').bind(jobId)]); }
  catch { return jsonError('active_job_exists', 'An active job already exists for this issue', requestId(), 409); }
  return c.json({ id: jobId, status: 'queued' }, 201);
});
app.get('/v1/jobs', async (c) => { const status = c.req.query('status'); const limit = page(c.req.query('limit')); const cursor = decodeCursor(c.req.query('cursor')); const clauses: string[] = []; const values: unknown[] = []; if (status) { clauses.push('status=?'); values.push(status); } if (cursor) { clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(cursor.key, cursor.key, cursor.id); } values.push(limit + 1); const result = await c.env.DB.prepare(`SELECT * FROM jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...values).all<any>(); const items = result.results.slice(0, limit); const last = items.at(-1); return c.json({ items, next_cursor: result.results.length > limit && last ? encodeCursor({ key: last.created_at, id: last.id }) : null }); });
app.get('/v1/jobs/:id', async (c) => { const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(c.req.param('id')).first(); if (!job) return jsonError('not_found', 'Job not found', requestId(), 404); const events = await c.env.DB.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY id').bind(c.req.param('id')).all(); return c.json({ ...job as object, events: events.results }); });
app.post('/v1/jobs/:id/claim', async (c) => {
  const body = z.object({ client_id: z.string().min(1), claim_id: z.string().uuid() }).parse(await c.req.json()); const jobId = c.req.param('id');
  const same = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND status='running' AND claim_id=?").bind(jobId, body.claim_id).first(); if (same) return c.json(same);
  const result = await c.env.DB.prepare("UPDATE jobs SET status='running', client_id=?, claim_id=?, claimed_at=CURRENT_TIMESTAMP, heartbeat_at=CURRENT_TIMESTAMP, phase='analyzing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").bind(body.client_id, body.claim_id, jobId).run();
  if (!result.meta.changes) return jsonError('claim_conflict', 'Job is not available', requestId(), 409); await event(c.env.DB, jobId, 'claimed', body); return c.json({ id: jobId, status: 'running', claim_id: body.claim_id });
});
app.post('/v1/jobs/:id/heartbeat', async (c) => {
  const body = z.object({ claim_id: z.string().uuid() }).parse(await c.req.json()); const job = await c.env.DB.prepare("SELECT j.stop_requested, r.active, r.access_status, i.state FROM jobs j JOIN issues i ON i.id=j.issue_id JOIN repositories r ON r.id=i.repository_id WHERE j.id=? AND j.status='running' AND j.claim_id=?").bind(c.req.param('id'), body.claim_id).first<any>(); if (!job) return jsonError('stale_claim', 'Claim is no longer active', requestId(), 409); const stopRequested = Boolean(job.stop_requested) || !job.active || job.access_status !== 'active' || job.state !== 'open'; if (stopRequested) return c.json({ ok: false, stop_requested: true }); await c.env.DB.prepare('UPDATE jobs SET heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(c.req.param('id')).run(); return c.json({ ok: true, stop_requested: false });
});
app.post('/v1/jobs/:id/status', async (c) => {
  const body = z.object({ claim_id: z.string().uuid(), phase: z.enum(['analyzing','fixing','testing','creating_pr']).optional(), status: z.enum(['succeeded','failed']).optional(), summary: z.string().max(4000).optional(), commit_sha: z.string().optional(), pr_url: z.string().url().optional() }).parse(await c.req.json());
  const job = await c.env.DB.prepare('SELECT j.*, r.active, r.access_status, i.state FROM jobs j JOIN issues i ON i.id=j.issue_id JOIN repositories r ON r.id=i.repository_id WHERE j.id=? AND j.claim_id=?').bind(c.req.param('id'), body.claim_id).first<any>();
  if (!job) return jsonError('stale_claim', 'Claim is no longer active', requestId(), 409);
  const newStatus: JobStatus = body.status ?? 'running';
  // A response lost after the external write can be resent after the job has become terminal.
  if (job.status !== 'running') {
    const identicalTerminal = body.status && job.status === body.status && (job.commit_sha ?? null) === (body.commit_sha ?? null) && (job.pr_url ?? null) === (body.pr_url ?? null);
    if (!identicalTerminal) return jsonError('stale_claim', 'Claim is no longer active', requestId(), 409);
    return c.json({ id: job.id, status: job.status, commit_sha: job.commit_sha, pr_url: job.pr_url, reconciliation: 'stored' });
  }
  const externalWrite = body.phase === 'creating_pr' || Boolean(body.commit_sha) || Boolean(body.pr_url) || body.status === 'succeeded';
  if (externalWrite && (job.stop_requested || !job.active || job.access_status !== 'active' || job.state !== 'open')) return jsonError('stop_requested', 'Repository access or issue state no longer permits external writes', requestId(), 409);
  await c.env.DB.prepare('UPDATE jobs SET status=?, phase=?, result_summary=COALESCE(?,result_summary), commit_sha=COALESCE(?,commit_sha), pr_url=COALESCE(?,pr_url), heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newStatus, body.phase ?? job.phase, body.summary ?? null, body.commit_sha ?? null, body.pr_url ?? null, job.id).run(); await event(c.env.DB, job.id, newStatus === 'running' ? 'progress' : newStatus, body); return c.json({ id: job.id, status: newStatus, commit_sha: body.commit_sha ?? job.commit_sha, pr_url: body.pr_url ?? job.pr_url, reconciliation: 'updated' });
});
app.get('/v1/jobs/:id/claim', async (c) => { const claimId = z.string().uuid().parse(c.req.query('claim_id')); const job = await c.env.DB.prepare('SELECT j.status, j.claim_id, j.stop_requested, r.active, r.access_status, i.state FROM jobs j JOIN issues i ON i.id=j.issue_id JOIN repositories r ON r.id=i.repository_id WHERE j.id=?').bind(c.req.param('id')).first<any>(); if (!job) return jsonError('not_found', 'Job not found', requestId(), 404); const repositoryActive = Boolean(job.active) && job.access_status === 'active'; const valid = job.status === 'running' && job.claim_id === claimId && !job.stop_requested && repositoryActive && job.state === 'open'; return c.json({ valid, stop_requested: Boolean(job.stop_requested), repository_active: repositoryActive, issue_state: job.state }); });
app.post('/v1/jobs/:id/retry', async (c) => { const old = await c.env.DB.prepare("SELECT j.*, i.version AS current_version, i.state AS issue_state, r.active, r.access_status FROM jobs j JOIN issues i ON i.id=j.issue_id JOIN repositories r ON r.id=i.repository_id WHERE j.id=? AND j.status IN ('interrupted','failed','cancelled')").bind(c.req.param('id')).first<any>(); if (!old) return jsonError('not_retryable', 'Job is not retryable', requestId(), 409); if (old.issue_version !== old.current_version || old.issue_state !== 'open' || !old.active || old.access_status !== 'active') return jsonError('issue_changed', 'Issue changed, closed, or is no longer accessible', requestId(), 409); const jobId = id(); await c.env.DB.batch([c.env.DB.prepare('INSERT INTO jobs (id, issue_id, attempt, issue_version, issue_title, issue_body, status) VALUES (?, ?, ?, ?, ?, ?, \'queued\')').bind(jobId, old.issue_id, old.attempt + 1, old.issue_version, old.issue_title, old.issue_body), c.env.DB.prepare('INSERT INTO job_events (job_id,event_type,detail_json) VALUES (?,\'retried\',?)').bind(jobId, JSON.stringify({ from: old.id }))]); return c.json({ id: jobId, status: 'queued' }, 201); });

async function handleInstallation(env: Env, payload: any): Promise<void> {
  const installation = payload.installation; if (!installation) return; const accountId = String(installation.account.id);
  if (!allowedAccount(env, accountId)) return;
  const status = ['deleted', 'suspend'].includes(payload.action) ? (payload.action === 'deleted' ? 'deleted' : 'suspended') : 'active';
  await env.DB.prepare(`INSERT INTO github_installations (github_id, account_id, account_login, status) VALUES (?,?,?,?)
    ON CONFLICT(github_id) DO UPDATE SET account_id=excluded.account_id, account_login=excluded.account_login, status=excluded.status, updated_at=CURRENT_TIMESTAMP
    WHERE github_installations.account_id IS NOT excluded.account_id
       OR github_installations.account_login IS NOT excluded.account_login
       OR github_installations.status IS NOT excluded.status`).bind(String(installation.id), accountId, installation.account.login, status).run();
  if (status !== 'active') {
    const repositories = await env.DB.prepare('SELECT id FROM repositories WHERE installation_id=?').bind(String(installation.id)).all<{ id: number }>();
    await env.DB.batch([env.DB.prepare("UPDATE repositories SET active=0, access_status='revoked', updated_at=CURRENT_TIMESTAMP WHERE installation_id=?").bind(String(installation.id)), ...repositories.results.map((repo) => env.DB.prepare("UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE status='running' AND issue_id IN (SELECT id FROM issues WHERE repository_id=?)").bind(repo.id))]);
  }
  const removed = payload.repositories_removed ?? (payload.action === 'removed' && payload.repository ? [payload.repository] : []);
  if (status === 'active' && removed.length) {
    const githubIds = removed.map((repo: any) => String(repo.id));
    const placeholders = githubIds.map(() => '?').join(',');
    const repositories = await env.DB.prepare(`SELECT id FROM repositories WHERE installation_id=? AND github_id IN (${placeholders})`).bind(String(installation.id), ...githubIds).all<{ id: number }>();
    await env.DB.batch([
      env.DB.prepare(`UPDATE repositories SET active=0, access_status='revoked', updated_at=CURRENT_TIMESTAMP WHERE installation_id=? AND github_id IN (${placeholders})`).bind(String(installation.id), ...githubIds),
      ...repositories.results.map((repo) => env.DB.prepare("UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE status='running' AND issue_id IN (SELECT id FROM issues WHERE repository_id=?)").bind(repo.id))
    ]);
  }
  const added = payload.repositories_added ?? [];
  if (status === 'active' && added.length) {
    await env.DB.batch(added.map((repo: any) => repositoryUpsert(env, String(installation.id), repo)));
  }
  if (status === 'active') await requestRepositoryRefresh(env, String(installation.id));
}
async function handleIssue(env: Env, payload: any): Promise<void> {
  if (payload.issue?.pull_request) return; const repo = await env.DB.prepare('SELECT * FROM repositories WHERE github_id=?').bind(String(payload.repository.id)).first<any>(); if (!repo || !repo.active || repo.access_status !== 'active') return;
  const upsert = issueUpsert(env.DB, repo.id, payload.issue); if (!upsert) return;
  // Keep the issue version write and revocation of runnable work in one D1 transaction.
  await env.DB.batch([upsert, ...(payload.issue.state === 'closed' ? [
    env.DB.prepare("UPDATE jobs SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE status='queued' AND issue_id IN (SELECT id FROM issues WHERE github_id=? AND state='closed' AND version=?)").bind(String(payload.issue.id), payload.issue.updated_at),
    env.DB.prepare("UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE status='running' AND issue_id IN (SELECT id FROM issues WHERE github_id=? AND state='closed' AND version=?)").bind(String(payload.issue.id), payload.issue.updated_at)
  ] : [])]);
}

async function handleIssueComment(env: Env, payload: any): Promise<void> {
  const action = payload.action;
  if (!['created', 'edited', 'deleted'].includes(action)) return;
  if (payload.issue?.pull_request) return;
  const comment = payload.comment;
  const githubIssueId = payload.issue?.id;
  const repositoryGithubId = payload.repository?.id;
  if (!comment?.id || !githubIssueId || !repositoryGithubId) return;
  const issue = await env.DB.prepare('SELECT i.id FROM issues i JOIN repositories r ON r.id=i.repository_id WHERE i.github_id=? AND r.github_id=?')
    .bind(String(githubIssueId), String(repositoryGithubId)).first<{ id: number }>();
  if (!issue) return;
  if (action === 'deleted') {
    await env.DB.prepare('UPDATE issue_comments SET body=NULL, updated_at=CURRENT_TIMESTAMP, deleted_at=CURRENT_TIMESTAMP WHERE github_id=? AND issue_id=?')
      .bind(String(comment.id), issue.id).run();
    return;
  }
  const createdAt = comment.created_at ?? new Date().toISOString();
  await env.DB.prepare(`INSERT INTO issue_comments (github_id, issue_id, author_login, body, html_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET author_login=excluded.author_login, body=excluded.body,
      html_url=excluded.html_url, updated_at=excluded.updated_at, deleted_at=NULL
    WHERE issue_comments.issue_id=excluded.issue_id`)
    .bind(String(comment.id), issue.id, comment.user?.login ?? 'unknown', comment.body ?? '', comment.html_url ?? '', createdAt, comment.updated_at ?? createdAt).run();
}

export default { fetch: app.fetch, scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runScheduledSync(env)) } satisfies ExportedHandler<Env>;
