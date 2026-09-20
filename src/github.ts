import type { Env } from './types';

const GITHUB_API = 'https://api.github.com';

/** A GitHub REST error that can be safely returned by an API handler. */
export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly contentType: string | null,
    public readonly githubRequestId: string | null
  ) {
    super(`GitHub API request failed (${status})`);
    this.name = 'GitHubApiError';
  }
}

export async function githubApiError(response: Response): Promise<GitHubApiError> {
  return new GitHubApiError(
    response.status,
    await response.text(),
    response.headers.get('content-type'),
    response.headers.get('x-github-request-id')
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToDer(pem: string): ArrayBuffer {
  const content = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const binary = atob(content);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

export async function appJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(env.GITHUB_APP_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export async function installationToken(env: Env, installationId: string): Promise<string> {
  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST', headers: { Authorization: `Bearer ${await appJwt(env)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'issue-pilot' }
  });
  if (!response.ok) throw await githubApiError(response);
  return (await response.json() as { token: string }).token;
}

export async function githubFetch(env: Env, installationId: string, path: string): Promise<Response> {
  const token = await installationToken(env, installationId);
  return fetch(`${GITHUB_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'issue-pilot', 'X-GitHub-Api-Version': '2022-11-28' } });
}

export async function githubAppFetch(env: Env, path: string): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, { headers: { Authorization: `Bearer ${await appJwt(env)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'issue-pilot', 'X-GitHub-Api-Version': '2022-11-28' } });
}
