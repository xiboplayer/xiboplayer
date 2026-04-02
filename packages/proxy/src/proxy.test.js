// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createProxyApp } from './proxy.js';
import express from 'express';
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

describe('POST /config — runtime config updates', () => {
  let configDir;

  beforeAll(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-config-test-'));
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function makeConfigApp(initialConfig = {}) {
    const configFile = path.join(configDir, `config-${Date.now()}.json`);
    if (Object.keys(initialConfig).length > 0) {
      fs.writeFileSync(configFile, JSON.stringify(initialConfig));
    }
    return createProxyApp({
      pwaPath,
      appVersion: '0.0.0-test',
      pwaConfig: initialConfig,
      configFilePath: configFile,
    });
  }

  it('POST /config merges cmsUrl into config', async () => {
    const app = makeConfigApp();
    const res = await jsonRequest(app, 'POST', '/config', {
      cmsUrl: 'https://new-cms.example.com',
    });
    expect(res.status).toBe(200);
  });

  it('POST /config returns 400 without cmsUrl or sync', async () => {
    const app = makeConfigApp();
    const res = await jsonRequest(app, 'POST', '/config', {
      displayName: 'test',
    });
    expect(res.status).toBe(400);
  });

  it('POST /config merges apiClientId and apiClientSecret', async () => {
    const configFile = path.join(configDir, `config-api-${Date.now()}.json`);
    fs.writeFileSync(configFile, JSON.stringify({
      cmsUrl: 'https://test.com',
      cmsKey: 'key',
    }));

    const app = createProxyApp({
      pwaPath,
      appVersion: '0.0.0-test',
      pwaConfig: { cmsUrl: 'https://test.com', cmsKey: 'key' },
      configFilePath: configFile,
    });

    // First POST the CMS URL (required field)
    await jsonRequest(app, 'POST', '/config', {
      cmsUrl: 'https://test.com',
      apiClientId: 'client-abc',
      apiClientSecret: 'secret-xyz',
    });

    // Verify config file was written with the API credentials
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(saved.apiClientId).toBe('client-abc');
    expect(saved.apiClientSecret).toBe('secret-xyz');
  });

  it('POST /config preserves existing fields when merging new ones', async () => {
    const configFile = path.join(configDir, `config-merge-${Date.now()}.json`);
    fs.writeFileSync(configFile, JSON.stringify({
      cmsUrl: 'https://test.com',
      cmsKey: 'existing-key',
      displayName: 'Existing Display',
    }));

    const app = createProxyApp({
      pwaPath,
      appVersion: '0.0.0-test',
      pwaConfig: { cmsUrl: 'https://test.com', cmsKey: 'existing-key', displayName: 'Existing Display' },
      configFilePath: configFile,
    });

    await jsonRequest(app, 'POST', '/config', {
      cmsUrl: 'https://test.com',
      apiClientId: 'new-client',
    });

    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(saved.cmsKey).toBe('existing-key');     // preserved
    expect(saved.displayName).toBe('Existing Display');  // preserved
    expect(saved.apiClientId).toBe('new-client');   // added
  });
});

describe('XMDS proxy forwarding', () => {
  let fakeCmsServer;
  let fakeCmsPort;

  // Spin up a fake CMS that mimics /xmds.php
  beforeAll(async () => {
    const cms = express();
    cms.use(express.text({ type: 'text/xml', limit: '1mb' }));
    cms.all('/xmds.php', (req, res) => {
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.send(`<soap:Envelope><soap:Body><Echo>${req.body || 'GET'}</Echo></soap:Body></soap:Envelope>`);
    });
    await new Promise((resolve) => {
      fakeCmsServer = cms.listen(0, 'localhost', () => {
        fakeCmsPort = fakeCmsServer.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (fakeCmsServer) fakeCmsServer.close();
  });

  it('forwards request body to CMS and returns CMS response', async () => {
    const app = makeApp();
    const soapBody = '<RegisterDisplay xmlns="urn:xmds"><hardwareKey>abc</hardwareKey></RegisterDisplay>';

    const res = await new Promise((resolve) => {
      const server = app.listen(0, 'localhost', () => {
        const port = server.address().port;
        realFetch(`http://localhost:${port}/xmds-proxy?cms=http://localhost:${fakeCmsPort}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: soapBody,
        })
          .then(async (r) => {
            const body = await r.text();
            server.close();
            resolve({ status: r.status, body });
          })
          .catch((err) => { server.close(); resolve({ status: 0, body: err.message }); });
      });
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('<Echo>');
    expect(res.body).toContain('RegisterDisplay');
  });

  it('returns 400 when cms query parameter is missing', async () => {
    const app = makeApp();
    const res = await request(app, 'POST', '/xmds-proxy');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Missing cms parameter');
  });

  it('returns error when CMS is unreachable', async () => {
    const app = makeApp();
    const res = await new Promise((resolve) => {
      const server = app.listen(0, 'localhost', () => {
        const port = server.address().port;
        // Port 1 is almost certainly not listening
        realFetch(`http://localhost:${port}/xmds-proxy?cms=http://localhost:1`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml; charset=utf-8' },
          body: '<test/>',
        })
          .then(async (r) => {
            const body = await r.text();
            server.close();
            resolve({ status: r.status, body });
          })
          .catch((err) => { server.close(); resolve({ status: 0, body: err.message }); });
      });
    });

    expect(res.status).toBe(500);
    expect(res.body).toContain('Proxy error');
  });
});
