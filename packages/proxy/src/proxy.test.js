// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
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

  it('SPA fallback serves index.html for sub-routes', async () => {
    const app = makeApp();
    const res = await request(app, 'GET', '/player/some/deep/route');
    expect(res.status).toBe(200);
    expect(res.body).toContain('test');
  });

  // Regression: CMS widget JS requests /player/cache/media/193.json
  // which must be within the SW scope (/player/) to be intercepted.
  // Previously PWA was at /player/pwa/ and these requests 404'd.
  it('returns 404 for /player/cache/*.json (virtual SW paths, not real files)', async () => {
    const app = makeApp();
    // /player/cache/media/193.json is a virtual path handled by the Service Worker.
    // Express correctly returns 404 for file-extension paths that don't exist on disk —
    // serving HTML fallback for a .json request would cause MIME type errors.
    const res = await request(app, 'GET', '/player/cache/media/193.json');
    expect(res.status).toBe(404);
  });
});

// Helper for JSON requests
async function jsonRequest(app, method, url, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, 'localhost', () => {
      const port = server.address().port;
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      realFetch(`http://localhost:${port}${url}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text, json: () => JSON.parse(text) });
        })
        .catch((err) => { server.close(); resolve({ status: 0, body: err.message }); });
    });
  });
}

describe('IC HTTP API routes', () => {
  const mockHandler = {
    getInfo: async () => ({ hardwareKey: 'test-hw', playerType: 'electron' }),
    handleTrigger: async () => {},
    handleExpire: async () => {},
    handleExtend: async () => {},
    handleSetDuration: async () => {},
    handleFault: async () => {},
    getRealtimeData: async (key) => key === 'weather' ? { temp: 22 } : null,
  };

  function makeIcApp() {
    return createProxyApp({ pwaPath, appVersion: '0.0.0-test', icHandler: mockHandler });
  }

  it('GET /info returns player info', async () => {
    const res = await jsonRequest(makeIcApp(), 'GET', '/info');
    expect(res.status).toBe(200);
    const data = res.json();
    expect(data.hardwareKey).toBe('test-hw');
    expect(data.playerType).toBe('electron');
  });

  it('POST /trigger returns ok', async () => {
    const res = await jsonRequest(makeIcApp(), 'POST', '/trigger', { id: '42', trigger: 'btn1' });
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST /duration/expire returns ok', async () => {
    const res = await jsonRequest(makeIcApp(), 'POST', '/duration/expire', { id: '42' });
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST /duration/extend returns ok', async () => {
    const res = await jsonRequest(makeIcApp(), 'POST', '/duration/extend', { id: '42', duration: 10 });
    expect(res.status).toBe(200);
  });

  it('POST /duration/set returns ok', async () => {
    const res = await jsonRequest(makeIcApp(), 'POST', '/duration/set', { id: '42', duration: 30 });
    expect(res.status).toBe(200);
  });

  it('POST /fault returns ok', async () => {
    const res = await jsonRequest(makeIcApp(), 'POST', '/fault', { code: 'ERR', reason: 'test' });
    expect(res.status).toBe(200);
  });

  it('GET /realtime returns data for known key', async () => {
    const res = await jsonRequest(makeIcApp(), 'GET', '/realtime?dataKey=weather');
    expect(res.status).toBe(200);
    expect(res.json().temp).toBe(22);
  });

  it('GET /realtime returns 404 for unknown key', async () => {
    const res = await jsonRequest(makeIcApp(), 'GET', '/realtime?dataKey=missing');
    expect(res.status).toBe(404);
  });

  it('GET /realtime returns 400 without dataKey', async () => {
    const res = await jsonRequest(makeIcApp(), 'GET', '/realtime');
    expect(res.status).toBe(400);
  });

  it('IC routes not registered without icHandler', async () => {
    const app = makeApp(); // no icHandler
    const res = await jsonRequest(app, 'GET', '/info');
    // Should fall through to SPA which returns the index.html (200)
    // but the body won't be JSON with hardwareKey
    expect(res.body).not.toContain('hardwareKey');
  });
});
