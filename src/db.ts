import type { JobStatus } from './types';

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();

export async function event(db: D1Database, jobId: string, eventType: string, detail: unknown = {}): Promise<void> {
  await db.prepare('INSERT INTO job_events (job_id, event_type, detail_json) VALUES (?, ?, ?)').bind(jobId, eventType, JSON.stringify(detail)).run();
}

export async function upsertIssue(db: D1Database, repoId: number, issue: any): Promise<void> {
  if (issue.pull_request) return;
  const version = issue.updated_at;
  const labels = JSON.stringify((issue.labels ?? []).map((label: any) => typeof label === 'string' ? label : label.name));
  await db.prepare(`INSERT INTO issues (github_id, repository_id, number, title, body, html_url, labels_json, state, github_updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET title=excluded.title, body=excluded.body, html_url=excluded.html_url,
      labels_json=excluded.labels_json, state=excluded.state, github_updated_at=excluded.github_updated_at, version=excluded.version, updated_at=CURRENT_TIMESTAMP
    WHERE excluded.github_updated_at >= issues.github_updated_at`)
    .bind(String(issue.id), repoId, issue.number, issue.title, issue.body ?? null, issue.html_url, labels, issue.state, issue.updated_at, version).run();
}

export async function cancelQueuedJobs(db: D1Database, issueId: number, reason: string): Promise<void> {
  const result = await db.prepare("UPDATE jobs SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE issue_id=? AND status='queued'").bind(issueId).run();
  if (result.meta.changes) {
    const jobs = await db.prepare("SELECT id FROM jobs WHERE issue_id=? AND status='cancelled' ORDER BY updated_at DESC LIMIT ?").bind(issueId, result.meta.changes).all<{ id: string }>();
    await Promise.all(jobs.results.map((job) => event(db, job.id, 'cancelled', { reason })));
  }
  await db.prepare("UPDATE jobs SET stop_requested=1, updated_at=CURRENT_TIMESTAMP WHERE issue_id=? AND status='running'").bind(issueId).run();
}

export function isTerminal(status: JobStatus): boolean {
  return ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(status);
}
