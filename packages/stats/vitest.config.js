import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    // Share the monorepo root setup (fake-indexeddb/auto, fetch stub,
    // jsdom polyfills) so `pnpm --filter @xiboplayer/stats test` works
    // the same way as the root-level `pnpm test`.
    setupFiles: [new URL('../../vitest.setup.js', import.meta.url).pathname]
  }
});
