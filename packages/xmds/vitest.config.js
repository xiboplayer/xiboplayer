import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    environmentOptions: {
      // xmds tests assert absolute URLs resolved from cms.example.com;
      // without this, jsdom defaults to about:blank and URL() throws.
      jsdom: { url: 'https://cms.example.com' }
    },
    // Share the monorepo root setup so `pnpm --filter @xiboplayer/xmds test`
    // works standalone.
    setupFiles: [new URL('../../vitest.setup.js', import.meta.url).pathname]
  }
});
