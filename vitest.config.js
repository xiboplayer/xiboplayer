/**
 * Vitest configuration for xiboplayer SDK
 */

import { defineConfig } from 'vitest/config';

// ─── jsdom Response(Blob) trap — read before adding fetch tests ────────
//
// The default `environment: 'jsdom'` below is correct for almost every
// test in this monorepo BUT has one latent defect worth knowing about:
// jsdom's `Response` polyfill stringifies `Blob` bodies instead of
// reading their bytes.
//
//     // under jsdom:
//     const blob = new Blob([new TextEncoder().encode('hello')]);
//     const r = new Response(blob);
//     await r.arrayBuffer();  // → 13 bytes of "[object Blob]"
//                             //   NOT the 5 bytes of "hello"
//
// ArrayBuffer and Uint8Array bodies are fine — only Blob is broken.
//
// If your test wraps a `Blob` in a `Response` (common in Service
// Worker / CacheStorage / chunk-assembly code), add this pragma at
// the top of your test file:
//
//     // @vitest-environment node
//
// Node 18+ ships a compliant Response/Blob from undici. The pragma
// overrides the jsdom default for that file only. See
// `packages/sw/src/content-store-browser.test.js` +
// `packages/sw/src/request-handler-browser.test.js` for examples.
//
// Tracking: xibo-players/xiboplayer#371. No existing test is silently
// broken by this defect (audited 2026-04-17 — none of the current
// fetch-using tests re-wrap Blob bodies in Response). It's a trap for
// future tests, not an active bug.
// ───────────────────────────────────────────────────────────────────
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'https://cms.example.com' }
    },
    // Absolute path: `./vitest.setup.js` would resolve relative to CWD,
    // which breaks standalone package runs (`pnpm --filter X test` from
    // `packages/X/`). Using the config file's own URL anchors the path
    // to this config regardless of where vitest is invoked.
    setupFiles: [new URL('./vitest.setup.js', import.meta.url).pathname],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/cms-testing/tests/e2e/**',
      'packages/cms-testing/tests/api/**',
      'packages/pwa/playwright-tests/**',
      'packages/pwa/e2e/**',
      // Integration tests (*.integration.test.*) are OPT-IN via
      // `pnpm test:integration`, which sets VITEST_INTEGRATION=1 to
      // include them. Default `pnpm test` stays fast by excluding them
      // here — these tests boot real servers, open real sockets, and
      // can take minutes in the aggregate.
      ...(process.env.VITEST_INTEGRATION ? [] : ['**/*.integration.test.*'])
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
