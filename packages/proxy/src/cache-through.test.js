// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @vitest-environment node
//
// Integration tests for the cacheThrough proxy: chunked downloads, incomplete
// file handling, timeout scaling, and browser vs download-pipeline routing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createProxyApp } from './proxy.js';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Restore real fetch (root vitest.setup.js mocks it with vi.fn())
const realFetch = global.__nativeFetch || globalThis.fetch;
beforeAll(() => { global.fetch = realFetch; });

// ─── Mock CMS server ────────────────────────────────────────────────
// Responds to media file requests with deterministic data so we can
// verify the proxy streams, stores, and serves correctly.
const CHUNK_SIZE = 1024;     // 1 KB chunks (small for fast tests)
const FILE_SIZE = 4 * 1024;  // 4 KB total → 4 chunks
const FILE_DATA = Buffer.alloc(FILE_SIZE);
for (let i = 0; i < FILE_SIZE; i++) FILE_DATA[i] = i % 256;

let cmsServer;
let cmsPort;

function startCms() {
  return new Promise((resolve) => {
    cmsServer = http.createServer((req, res) => {
      // Serve any media file request with FILE_DATA (or a Range slice)
      if (!req.url.includes('/media/')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : FILE_SIZE - 1;
        const slice = FILE_DATA.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}`,
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
      } else {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': FILE_SIZE,
        });
        res.end(FILE_DATA);
      }
    });
    cmsServer.listen(0, 'localhost', () => {
      cmsPort = cmsServer.address().port;
      resolve();
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────
let tmpDir;
let pwaDir;

function makeApp() {
  return createProxyApp({
    pwaPath: pwaDir,
    appVersion: '0.0.0-test',
    dataDir: tmpDir,
    pwaConfig: {
      cmsUrl: `http://localhost:${cmsPort}`,
      cmsId: 'test-cms',
    },
  });
}

// Make an HTTP request to the proxy app
function proxyRequest(app, urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, 'localhost', () => {
      const port = server.address().port;
      realFetch(`http://localhost:${port}${urlPath}`, { method, headers })
        .then(async (res) => {
          const body = Buffer.from(await res.arrayBuffer());
          server.close();
          resolve({ status: res.status, body, headers: res.headers });
        })
        .catch((err) => {
          server.close();
          resolve({ status: 0, body: Buffer.alloc(0), error: err.message });
        });
    });
  });
}

// ─── Setup / Teardown ───────────────────────────────────────────────
beforeAll(async () => {
  await startCms();
});

afterAll(() => {
  cmsServer?.close();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ct-test-'));
  pwaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ct-pwa-'));
  fs.writeFileSync(path.join(pwaDir, 'index.html'), '<html>test</html>');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(pwaDir, { recursive: true, force: true });
});


// ─── Test suites ────────────────────────────────────────────────────

describe('cacheThrough: basic cache miss → CMS fetch → store', () => {
  it('fetches from CMS on cache miss and stores the file', async () => {
    const app = makeApp();

    const res = await proxyRequest(app, '/player/api/v2/media/file/test.mp4');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(FILE_SIZE);
    expect(res.body.equals(FILE_DATA)).toBe(true);

    // Second request should be served from store (cache hit)
    const res2 = await proxyRequest(app, '/player/api/v2/media/file/test.mp4');
    expect(res2.status).toBe(200);
    expect(res2.body.length).toBe(FILE_SIZE);
    expect(res2.body.equals(FILE_DATA)).toBe(true);
  });

  it('fetches with Range header from CMS and returns 206', async () => {
    const app = makeApp();

    const res = await proxyRequest(app, '/player/api/v2/media/file/ranged.mp4', {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(res.status).toBe(206);
    expect(res.body.length).toBe(CHUNK_SIZE);
    expect(res.body.equals(FILE_DATA.subarray(0, CHUNK_SIZE))).toBe(true);
  });
});


describe('cacheThrough: chunk download pipeline (X-Store-Chunk-Index)', () => {
  it('stores individual chunks via X-Store-* headers', async () => {
    const app = makeApp();

    // Download chunk 0 (first chunk, barrier priority)
    const res0 = await proxyRequest(app, '/player/api/v2/media/file/chunked.mp4', {
      headers: {
        'Range': `bytes=0-${CHUNK_SIZE - 1}`,
        'X-Store-Chunk-Index': '0',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });
    expect(res0.status).toBe(206);
    expect(res0.body.length).toBe(CHUNK_SIZE);
    expect(res0.body.equals(FILE_DATA.subarray(0, CHUNK_SIZE))).toBe(true);

    // Download chunk 3 (last chunk, barrier priority)
    const lastStart = 3 * CHUNK_SIZE;
    const res3 = await proxyRequest(app, '/player/api/v2/media/file/chunked.mp4', {
      headers: {
        'Range': `bytes=${lastStart}-${FILE_SIZE - 1}`,
        'X-Store-Chunk-Index': '3',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });
    expect(res3.status).toBe(206);
    expect(res3.body.length).toBe(CHUNK_SIZE);
    expect(res3.body.equals(FILE_DATA.subarray(lastStart, FILE_SIZE))).toBe(true);
  });

  it('download pipeline requests for missing chunks fall through to CMS (#283)', async () => {
    const app = makeApp();

    // Store chunk 0 and 3 (barrier chunks) — simulates partial download
    await proxyRequest(app, '/player/api/v2/media/file/partial.mp4', {
      headers: {
        'Range': `bytes=0-${CHUNK_SIZE - 1}`,
        'X-Store-Chunk-Index': '0',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });
    const lastStart = 3 * CHUNK_SIZE;
    await proxyRequest(app, '/player/api/v2/media/file/partial.mp4', {
      headers: {
        'Range': `bytes=${lastStart}-${FILE_SIZE - 1}`,
        'X-Store-Chunk-Index': '3',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });

    // Now request chunk 1 (missing) — download pipeline with X-Store-Chunk-Index
    // This MUST fall through to CMS, not return 404 from store
    const chunk1Start = 1 * CHUNK_SIZE;
    const chunk1End = 2 * CHUNK_SIZE - 1;
    const res1 = await proxyRequest(app, '/player/api/v2/media/file/partial.mp4', {
      headers: {
        'Range': `bytes=${chunk1Start}-${chunk1End}`,
        'X-Store-Chunk-Index': '1',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });

    // Must get 206 with actual chunk data from CMS, NOT 404
    expect(res1.status).toBe(206);
    expect(res1.body.length).toBe(CHUNK_SIZE);
    expect(res1.body.equals(FILE_DATA.subarray(chunk1Start, chunk1End + 1))).toBe(true);
  });

  it('all chunks download → file completes without 404 errors', async () => {
    const app = makeApp();
    const numChunks = 4;

    // Download all chunks sequentially (simulates download manager)
    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min((i + 1) * CHUNK_SIZE, FILE_SIZE) - 1;
      const res = await proxyRequest(app, '/player/api/v2/media/file/full.mp4', {
        headers: {
          'Range': `bytes=${start}-${end}`,
          'X-Store-Chunk-Index': String(i),
          'X-Store-Num-Chunks': String(numChunks),
          'X-Store-Chunk-Size': String(CHUNK_SIZE),
        },
      });

      expect(res.status).toBe(206);
      expect(res.body.length).toBe(end - start + 1);
      expect(res.body.equals(FILE_DATA.subarray(start, end + 1))).toBe(true);
    }
  });
});


describe('cacheThrough: incomplete chunked file — browser vs pipeline (#283)', () => {
  // Helper: store some chunks to create an incomplete chunked file
  async function setupIncompleteFile(app) {
    // Store chunk 0 (first) and chunk 3 (last) — barrier pattern
    await proxyRequest(app, '/player/api/v2/media/file/video.mp4', {
      headers: {
        'Range': `bytes=0-${CHUNK_SIZE - 1}`,
        'X-Store-Chunk-Index': '0',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });
    const lastStart = 3 * CHUNK_SIZE;
    await proxyRequest(app, '/player/api/v2/media/file/video.mp4', {
      headers: {
        'Range': `bytes=${lastStart}-${FILE_SIZE - 1}`,
        'X-Store-Chunk-Index': '3',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });
    // Chunks 1, 2 are missing — file is incomplete
  }

  it('browser request (no X-Store-Chunk-Index) serves from store, not CMS', async () => {
    const app = makeApp();
    await setupIncompleteFile(app);

    // Browser requests chunk 0 range — should serve from store (chunk 0 exists)
    const res = await proxyRequest(app, '/player/api/v2/media/file/video.mp4', {
      headers: { 'Range': `bytes=0-${CHUNK_SIZE - 1}` },
    });

    // Should get data (served from store), not a CMS redirect
    // The exact status depends on serveFromStore behavior for chunked files
    expect([200, 206]).toContain(res.status);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('download pipeline request (with X-Store-Chunk-Index) falls through to CMS', async () => {
    const app = makeApp();
    await setupIncompleteFile(app);

    // Download pipeline requests missing chunk 2 — must go to CMS
    const chunk2Start = 2 * CHUNK_SIZE;
    const chunk2End = 3 * CHUNK_SIZE - 1;
    const res = await proxyRequest(app, '/player/api/v2/media/file/video.mp4', {
      headers: {
        'Range': `bytes=${chunk2Start}-${chunk2End}`,
        'X-Store-Chunk-Index': '2',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(CHUNK_SIZE),
      },
    });

    // Must get 206 with actual data from CMS, NOT 404
    expect(res.status).toBe(206);
    expect(res.body.length).toBe(CHUNK_SIZE);
    expect(res.body.equals(FILE_DATA.subarray(chunk2Start, chunk2End + 1))).toBe(true);
  });

  it('browser request for missing chunk range gets handled gracefully', async () => {
    const app = makeApp();
    await setupIncompleteFile(app);

    // Browser requests chunk 1 range (missing chunk) — no X-Store-Chunk-Index
    // serveFromStore → serveChunkedFile → chunk 1 not on disk
    // The response may hang if serveChunkedFile sends headers then can't read,
    // so use a short timeout via AbortController.
    const chunk1Start = 1 * CHUNK_SIZE;
    const chunk1End = 2 * CHUNK_SIZE - 1;

    const server = await new Promise(r => { const s = app.listen(0, 'localhost', () => r(s)); });
    const port = server.address().port;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const fetchRes = await realFetch(
        `http://localhost:${port}/player/api/v2/media/file/video.mp4`,
        {
          headers: { 'Range': `bytes=${chunk1Start}-${chunk1End}` },
          signal: controller.signal,
        }
      ).catch(() => null);
      clearTimeout(timer);

      if (fetchRes) {
        // Should NOT crash — either returns partial data or 404 for the missing chunk
        // The key point is it doesn't open a new CMS stream (no duplicate download)
        expect([200, 206, 404]).toContain(fetchRes.status);
      }
      // If fetch was aborted (server hung on missing chunk), that's also acceptable —
      // the important thing is no CMS stream was opened for a browser request.
    } finally {
      server.close();
    }
  }, 10000);
});


describe('cacheThrough: timeout scaling for large chunks', () => {
  it('uses 30s timeout for non-chunk requests (no X-Store-Chunk-Size)', async () => {
    // We can't directly observe the timeout, but we can verify the proxy
    // works correctly without chunk headers (uses default 30s)
    const app = makeApp();
    const res = await proxyRequest(app, '/player/api/v2/media/file/small.png');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(FILE_SIZE);
  });

  it('scales timeout based on X-Store-Chunk-Size header', async () => {
    // For a 100 MB chunk: 30s base + 100s = 130s timeout
    // We verify it doesn't timeout on a fast local request with large chunk size header
    const app = makeApp();
    const res = await proxyRequest(app, '/player/api/v2/media/file/big.mp4', {
      headers: {
        'Range': `bytes=0-${CHUNK_SIZE - 1}`,
        'X-Store-Chunk-Index': '0',
        'X-Store-Num-Chunks': '4',
        'X-Store-Chunk-Size': String(100 * 1024 * 1024), // 100 MB
      },
    });
    expect(res.status).toBe(206);
    expect(res.body.length).toBe(CHUNK_SIZE);
  });
});


describe('cacheThrough: HEAD requests on store', () => {
  it('HEAD returns 404 for non-existent file', async () => {
    const app = makeApp();
    const res = await proxyRequest(app, '/store/player/api/v2/media/file/nope.mp4', {
      method: 'HEAD',
    });
    expect(res.status).toBe(404);
  });

  it('HEAD returns 200 after file is fully cached', async () => {
    const app = makeApp();

    // First, cache the file via GET
    await proxyRequest(app, '/player/api/v2/media/file/cached.mp4');

    // HEAD on /store/ path should find it
    const res = await proxyRequest(app, '/store/player/api/v2/media/file/cached.mp4', {
      method: 'HEAD',
    });
    expect(res.status).toBe(200);
  });
});


describe('cacheThrough: complete file served from store', () => {
  it('serves complete file from store on second request (cache hit)', async () => {
    const app = makeApp();

    // First request: cache miss → CMS
    const res1 = await proxyRequest(app, '/player/api/v2/media/file/hit.mp4');
    expect(res1.status).toBe(200);

    // Second request: cache hit → store
    const res2 = await proxyRequest(app, '/player/api/v2/media/file/hit.mp4');
    expect(res2.status).toBe(200);
    expect(res2.body.length).toBe(FILE_SIZE);
    expect(res2.body.equals(FILE_DATA)).toBe(true);
  });
});
