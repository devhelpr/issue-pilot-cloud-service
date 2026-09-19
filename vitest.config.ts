import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: { workers: { wrangler: { configPath: './wrangler.test.toml' }, miniflare: { d1Databases: ['DB'] } } }
  }
});
