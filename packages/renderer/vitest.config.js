import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Share the monorepo-root setup file so running tests for this
    // package alone (pnpm --filter @xiboplayer/renderer test) gets the
    // same jsdom polyfills (Element.prototype.animate, HTMLMediaElement
    // shims, etc.) as the root-level pnpm test.
    setupFiles: ['../../vitest.setup.js']
  },
  resolve: {
    alias: {
      // hls.js is an optional runtime dependency (dynamic import in renderVideo).
      // Alias to the monorepo mock so renderer tests work standalone.
      'hls.js': new URL('../../vitest.hls-mock.js', import.meta.url).pathname,
      '@xiboplayer/expr': new URL('../expr/src/index.js', import.meta.url).pathname,
      '@xiboplayer/schedule': new URL('../schedule/src/index.js', import.meta.url).pathname,
      '@xiboplayer/utils': new URL('../utils/src/index.js', import.meta.url).pathname
    }
  }
});
