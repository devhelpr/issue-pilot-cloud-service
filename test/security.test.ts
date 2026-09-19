import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/security';

describe('GitHub webhook verification', () => {
  it('accepts GitHub’s documented HMAC vector', async () => {
    const body = new TextEncoder().encode('Hello, World!').buffer;
    await expect(verifyWebhook("It's a Secret to Everybody", body, 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')).resolves.toBe(true);
  });

  it('rejects missing and invalid signatures', async () => {
    const body = new TextEncoder().encode('Hello, World!').buffer;
    await expect(verifyWebhook('secret', body, undefined)).resolves.toBe(false);
    await expect(verifyWebhook('secret', body, 'sha256=' + '0'.repeat(64))).resolves.toBe(false);
  });
});
