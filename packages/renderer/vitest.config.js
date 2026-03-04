import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true
  },
  resolve: {
    alias: {
      // hls.js is an optional runtime dependency (dynamic import in renderVideo).
      // Alias to the monorepo mock so renderer tests work standalone.
      'hls.js': new URL('../../vitest.hls-mock.js', import.meta.url).pathname,
      '@xiboplayer/schedule': new URL('../schedule/src/index.js', import.meta.url).pathname,
      '@xiboplayer/utils': new URL('../utils/src/index.js', import.meta.url).pathname
    }
  }
});
