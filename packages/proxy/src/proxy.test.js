// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createProxyApp } from './proxy.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Restore real fetch (root vitest.setup.js mocks it with vi.fn())
const realFetch = global.__nativeFetch || globalThis.fetch;

// Create a temporary PWA directory with a minimal index.html
let pwaPath;
beforeAll(() => {
  global.fetch = realFetch;
  pwaPath = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-pwa-'));
  fs.writeFileSync(path.join(pwaPath, 'index.html'), '<html><body>test</body></html>');
});

function makeApp() {
  return createProxyApp({ pwaPath, appVersion: '0.0.0-test' });
}

// Helper to make a request to the Express app without starting a persistent server
async function request(app, method, url, opts = {}) {
  return new Promise((resolve) => {
    const server = app.listen(0, 'localhost', () => {
      const port = server.address().port;
      realFetch(`http://localhost:${port}${url}`, {
        method,
        redirect: opts.redirect || 'follow',
      })
        .then(async (res) => {
          const body = await res.text();
          server.close();
          resolve({ status: res.status, body, headers: res.headers, url: res.url });
        })
        .catch((err) => {
          server.close();
          resolve({ status: 0, body: err.message, headers: new Headers(), url: '' });
        });
    });
  });
}

describe('createProxyApp', () => {
  it('serves PWA at /player/', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/player/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test');
  });

  it('redirects / to /player/', async () => {
    const app = makeApp();
    // fetch follows redirects by default, so we check the final body
    const res = await request(app, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test');
  });

  it('returns 400 for /xmds-proxy without cms param', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/xmds-proxy');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Missing cms parameter');
  });

  it('returns 400 for /rest-proxy without cms param', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/rest-proxy');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Missing cms parameter');
  });

  it('returns 400 for /file-proxy without cms param', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/file-proxy');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Missing cms or url parameter');
  });

  it('SPA fallback serves index.html for sub-routes', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/player/some/deep/route');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test');
  });

  // Regression: CMS widget JS requests /player/cache/media/193.json
  // which must be within the SW scope (/player/) to be intercepted.
  // Previously PWA was at /player/pwa/ and these requests 404'd.
  it('serves /player/cache/* paths within SW scope (RSS widget data)', async () => {
    const app = makeApp();
    // /player/cache/media/193.json is a virtual path handled by SW in-browser,
    // but Express should serve the SPA fallback (not 404)
    const res = await request(app, 'GET', '/player/cache/media/193.json');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test'); // SPA fallback
  });
});
