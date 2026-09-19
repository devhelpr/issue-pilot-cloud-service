export interface Env {
  DB: D1Database;
  WEBHOOK_SECRET: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_ID: string;
  DESKTOP_API_TOKEN: string;
  ALLOWED_GITHUB_ACCOUNT_IDS: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
