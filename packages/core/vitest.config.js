import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Environment
    environment: 'jsdom', // Browser-like environment

    // Share the monorepo root setup (fake-indexeddb/auto, fetch stub,
    // jsdom polyfills) so `pnpm --filter @xiboplayer/core test` works
    // the same way as root-level `pnpm test`.
    setupFiles: [new URL('../../vitest.setup.js', import.meta.url).pathname],

    // Test files
    include: ['src/**/*.test.js'],
    exclude: ['node_modules', 'dist'],

    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js', 'src/**/*.spec.js'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80
      }
    },

    // Globals
    globals: true,

    // Timeout
    testTimeout: 10000,

    // Reporters
    reporters: ['verbose']
  }
});
