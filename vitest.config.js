/**
 * Vitest configuration for xiboplayer SDK
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'https://cms.example.com' }
    },
    setupFiles: './vitest.setup.js',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/cms-testing/tests/e2e/**',
      'packages/cms-testing/tests/api/**',
      'packages/pwa/playwright-tests/**',
      'packages/pwa/e2e/**',
      '**/*.integration.test.*'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.js'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.js',
        '**/*.spec.js'
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50
      }
    }
  },
  resolve: {
    alias: {
      'hls.js': new URL('./vitest.hls-mock.js', import.meta.url).pathname
    }
  }
});
