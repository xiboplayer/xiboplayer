import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // API integration tests need real Node.js (not jsdom)
    environment: 'node',
    // Don't use the root setup file (mocks fetch, adds jsdom shims)
    setupFiles: [],
    // Only discover tests in this package
    include: ['tests/api/**/*.test.js'],
    root: new URL('.', import.meta.url).pathname,
    // API integration tests run against real CMS — longer timeouts
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run serially to avoid race conditions on shared CMS state.
    // singleFork alone only pins every test file to one process — Vitest
    // still schedules files concurrently as interleaved async tasks inside
    // it by default, so two files' beforeAll/it hooks can still fire
    // overlapping writes at the CMS. That interleaving showed up as a
    // MariaDB deadlock (SQLSTATE[40001]) on POST /region while another file
    // was mid-layout-create — fileParallelism: false makes Vitest finish one
    // file before starting the next, matching the comment's original intent.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false
  }
});
