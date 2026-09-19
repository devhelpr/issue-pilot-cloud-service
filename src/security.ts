import type { Env } from './types';

const encoder = new TextEncoder();

export async function verifyWebhook(secret: string, body: ArrayBuffer, signature: string | undefined): Promise<boolean> {
  if (!signature?.startsWith('sha256=')) return false;
  const hex = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const actual = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const expected = Uint8Array.from(hex.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
  if (actual.length !== expected.length) return false;
  let different = 0;
  for (let i = 0; i < actual.length; i++) different |= actual[i] ^ expected[i];
  return different === 0;
}

export function isAuthorized(request: Request, env: Env): boolean {
  const value = request.headers.get('Authorization');
  return value === `Bearer ${env.DESKTOP_API_TOKEN}`;
}

export function allowedAccount(env: Env, accountId: string): boolean {
  return env.ALLOWED_GITHUB_ACCOUNT_IDS.split(',').map((item) => item.trim()).includes(accountId);
}
