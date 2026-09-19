import { Hono } from 'hono';
import { z } from 'zod';
import { cancelQueuedJobs, event, id, upsertIssue } from './db';
import { allowedAccount, isAuthorized, verifyWebhook } from './security';
import { openapi } from './openapi';
import { refreshRepositories, runScheduledSync, syncRepository } from './sync';
import type { Env, JobStatus } from './types';

const app = new Hono<{ Bindings: Env }>();
const jsonError = (code: string, message: string, requestId: string, status = 400) => new Response(JSON.stringify({ code, message, request_id: requestId }), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const requestId = () => crypto.randomUUID();
const page = (value: string | undefined) => Math.min(Math.max(Number(value ?? 50) || 50, 1), 100);

app.use('/v1/*', async (c, next) => {
  if (!isAuthorized(c.req.raw, c.env)) return jsonError('unauthorized', 'Missing or invalid bearer token', requestId(), 401);
  await next();
});
app.onError((error, c) => {
  const rid = requestId();
  if (error instanceof z.ZodError) return jsonError('invalid_request', 'Request validation failed', rid, 400);
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
    await c.env.DB.prepare("UPDATE webhook_deliveries SET outcome='processed', processed_at=CURRENT_TIMESTAMP WHERE delivery_id=?").bind(deliveryId).run();
  } catch (error) {
    await c.env.DB.prepare("UPDATE webhook_deliveries SET outcome='failed', processed_at=CURRENT_TIMESTAMP WHERE delivery_id=?").bind(deliveryId).run();
    throw error;
  }
  return c.json({ accepted: true }, 202);
});

app.post('/v1/github/sync', async (c) => c.json({ repositories: await refreshRepositories(c.env) }));
app.get('/v1/repositories', async (c) => c.json({ items: (await c.env.DB.prepare('SELECT * FROM repositories ORDER BY full_name LIMIT ?').bind(page(c.req.query('limit'))).all()).results }));
app.patch('/v1/repositories/:id', async (c) => {
  const body = z.object({ active: z.boolean() }).parse(await c.req.json());
  const repo = await c.env.DB.prepare('SELECT * FROM repositories WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!repo) return jsonError('not_found', 'Repository not found', requestId(), 404);
  if (body.active && repo.access_status !== 'active') return jsonError('access_revoked', 'Repository access was revoked', requestId(), 409);
  await c.env.DB.prepare('UPDATE repositories SET active=?, sync_requested_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sync_requested_at END, sync_cursor=CASE WHEN ? THEN 1 ELSE sync_cursor END, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(body.active ? 1 : 0, body.active ? 1 : 0, body.active ? 1 : 0, repo.id).run();
  return c.json({ id: repo.id, active: body.active });
});
app.post('/v1/repositories/:id/sync', async (c) => {
  const repo = await c.env.DB.prepare('SELECT * FROM repositories WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!repo) return jsonError('not_found', 'Repository not found', requestId(), 404);
  await c.env.DB.prepare("UPDATE repositories SET sync_requested_at=CURRENT_TIMESTAMP, sync_cursor=1, sync_updated_after=NULL WHERE id=?").bind(repo.id).run();
  return c.json({ requested: true }, 202);
});
app.get('/v1/issues', async (c) => {
  const status = c.req.query('state'); const repo = c.req.query('repository_id'); const limit = page(c.req.query('limit'));
  const clauses = ['1=1']; const values: unknown[] = [];
  if (status) { clauses.push('i.state=?'); values.push(status); } if (repo) { clauses.push('i.repository_id=?'); values.push(repo); }
  values.push(limit);
  const result = await c.env.DB.prepare(`SELECT i.*, r.full_name, r.active FROM issues i JOIN repositories r ON r.id=i.repository_id WHERE ${clauses.join(' AND ')} ORDER BY i.github_updated_at DESC LIMIT ?`).bind(...values).all();
  return c.json({ items: result.results });
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
app.get('/v1/jobs', async (c) => { const status = c.req.query('status'); const result = await c.env.DB.prepare(`SELECT * FROM jobs ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT ?`).bind(...(status ? [status, page(c.req.query('limit'))] : [page(c.req.query('limit'))])).all(); return c.json({ items: result.results }); });
app.get('/v1/jobs/:id', async (c) => { const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(c.req.param('id')).first(); if (!job) return jsonError('not_found', 'Job not found', requestId(), 404); const events = await c.env.DB.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY id').bind(c.req.param('id')).all(); return c.json({ ...job as object, events: events.results }); });
app.post('/v1/jobs/:id/claim', async (c) => {
  const body = z.object({ client_id: z.string().min(1), claim_id: z.string().uuid() }).parse(await c.req.json()); const jobId = c.req.param('id');
  const same = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND status='running' AND claim_id=?").bind(jobId, body.claim_id).first(); if (same) return c.json(same);
  const result = await c.env.DB.prepare("UPDATE jobs SET status='running', client_id=?, claim_id=?, claimed_at=CURRENT_TIMESTAMP, heartbeat_at=CURRENT_TIMESTAMP, phase='analyzing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").bind(body.client_id, body.claim_id, jobId).run();
  if (!result.meta.changes) return jsonError('claim_conflict', 'Job is not available', requestId(), 409); await event(c.env.DB, jobId, 'claimed', body); return c.json({ id: jobId, status: 'running', claim_id: body.claim_id });
});
app.post('/v1/jobs/:id/heartbeat', async (c) => {
  const body = z.object({ claim_id: z.string().uuid() }).parse(await c.req.json()); const result = await c.env.DB.prepare("UPDATE jobs SET heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running' AND claim_id=?").bind(c.req.param('id'), body.claim_id).run(); if (!result.meta.changes) return jsonError('stale_claim', 'Claim is no longer active', requestId(), 409); const job = await c.env.DB.prepare('SELECT stop_requested FROM jobs WHERE id=?').bind(c.req.param('id')).first(); return c.json({ ok: true, stop_requested: Boolean((job as any)?.stop_requested) });
});
app.post('/v1/jobs/:id/status', async (c) => {
  const body = z.object({ claim_id: z.string().uuid(), phase: z.enum(['analyzing','fixing','testing','creating_pr']).optional(), status: z.enum(['succeeded','failed']).optional(), summary: z.string().max(4000).optional(), commit_sha: z.string().optional(), pr_url: z.string().url().optional() }).parse(await c.req.json());
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND claim_id=? AND status='running'").bind(c.req.param('id'), body.claim_id).first<any>(); if (!job) return jsonError('stale_claim', 'Claim is no longer active', requestId(), 409);
  const newStatus: JobStatus = body.status ?? 'running'; await c.env.DB.prepare('UPDATE jobs SET status=?, phase=?, result_summary=COALESCE(?,result_summary), commit_sha=COALESCE(?,commit_sha), pr_url=COALESCE(?,pr_url), heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(newStatus, body.phase ?? job.phase, body.summary ?? null, body.commit_sha ?? null, body.pr_url ?? null, job.id).run(); await event(c.env.DB, job.id, newStatus === 'running' ? 'progress' : newStatus, body); return c.json({ id: job.id, status: newStatus });
});
app.post('/v1/jobs/:id/retry', async (c) => { const old = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND status IN ('interrupted','failed','cancelled')").bind(c.req.param('id')).first<any>(); if (!old) return jsonError('not_retryable', 'Job is not retryable', requestId(), 409); const jobId = id(); await c.env.DB.batch([c.env.DB.prepare('INSERT INTO jobs (id, issue_id, attempt, issue_version, issue_title, issue_body, status) VALUES (?, ?, ?, ?, ?, ?, \'queued\')').bind(jobId, old.issue_id, old.attempt + 1, old.issue_version, old.issue_title, old.issue_body), c.env.DB.prepare('INSERT INTO job_events (job_id,event_type,detail_json) VALUES (?,\'retried\',?)').bind(jobId, JSON.stringify({ from: old.id }))]); return c.json({ id: jobId, status: 'queued' }, 201); });

async function handleInstallation(env: Env, payload: any): Promise<void> {
  const installation = payload.installation; if (!installation) return; const accountId = String(installation.account.id);
  if (!allowedAccount(env, accountId)) return;
  const status = ['deleted', 'suspend'].includes(payload.action) ? (payload.action === 'deleted' ? 'deleted' : 'suspended') : 'active';
  await env.DB.prepare('INSERT INTO github_installations (github_id,account_id,account_login,status) VALUES (?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET status=excluded.status, account_login=excluded.account_login, updated_at=CURRENT_TIMESTAMP').bind(String(installation.id), accountId, installation.account.login, status).run();
  if (status !== 'active') await env.DB.prepare("UPDATE repositories SET active=0, access_status='revoked' WHERE installation_id=?").bind(String(installation.id)).run();
}
async function handleIssue(env: Env, payload: any): Promise<void> {
  if (payload.issue?.pull_request) return; const repo = await env.DB.prepare('SELECT * FROM repositories WHERE github_id=?').bind(String(payload.repository.id)).first<any>(); if (!repo || !repo.active || repo.access_status !== 'active') return;
  await upsertIssue(env.DB, repo.id, payload.issue); const issue = await env.DB.prepare('SELECT id FROM issues WHERE github_id=?').bind(String(payload.issue.id)).first<any>();
  if (payload.issue.state === 'closed' && issue) await cancelQueuedJobs(env.DB, issue.id, 'issue_closed');
}

export default { fetch: app.fetch, scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runScheduledSync(env)) } satisfies ExportedHandler<Env>;
