// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @xiboplayer/utils before importing RestClient
vi.mock('@xiboplayer/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  fetchWithRetry: vi.fn(),
  PLAYER_API: '/player/api/v2',
}));

import { RestClient } from './rest-client.js';
import { fetchWithRetry } from '@xiboplayer/utils';

const mockConfig = {
  cmsUrl: 'https://cms.example.com',
  cmsKey: 'serverkey123',
  hardwareKey: 'hw-001',
  displayName: 'Test Display',
  xmrChannel: 'xmr-ch',
};

/** Helper: create a mock Response object */
function mockResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 304 ? 'Not Modified' : status === 401 ? 'Unauthorized' : 'Error',
    headers: {
      get: (name) => headers[name] || null,
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Helper: mock a successful auth response */
function mockAuthResponse() {
  return mockResponse(200, {
    token: 'jwt-token-123',
    displayId: 42,
    expiresIn: 3600,
  }, { 'Content-Type': 'application/json' });
}

describe('RestClient', () => {
  let client;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new RestClient(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── JWT authentication ─────────────────────────────────────

  describe('JWT authentication', () => {
    it('authenticates and stores token on first request', async () => {
      const authResp = mockAuthResponse();
      const dataResp = mockResponse(200, { ok: true }, { 'Content-Type': 'application/json' });

      fetchWithRetry
        .mockResolvedValueOnce(authResp)   // POST /auth
        .mockResolvedValueOnce(dataResp);  // GET /schedule

      const result = await client.restGet('/displays/42/schedule');

      expect(result).toEqual({ ok: true });
      expect(fetchWithRetry).toHaveBeenCalledTimes(2);
      // First call is auth
      expect(fetchWithRetry.mock.calls[0][1].method).toBe('POST');
      expect(client._token).toBe('jwt-token-123');
      expect(client._displayId).toBe(42);
    });

    it('reuses token on subsequent requests', async () => {
      const authResp = mockAuthResponse();
      const resp1 = mockResponse(200, { a: 1 }, { 'Content-Type': 'application/json' });
      const resp2 = mockResponse(200, { b: 2 }, { 'Content-Type': 'application/json' });

      fetchWithRetry
        .mockResolvedValueOnce(authResp)
        .mockResolvedValueOnce(resp1)
        .mockResolvedValueOnce(resp2);

      await client.restGet('/foo');
      await client.restGet('/bar');

      // Only one auth call, two data calls
      expect(fetchWithRetry).toHaveBeenCalledTimes(3);
    });

    it('throws on auth failure', async () => {
      fetchWithRetry.mockResolvedValueOnce(mockResponse(403, 'Forbidden'));

      await expect(client.restGet('/anything')).rejects.toThrow('Auth failed: 403');
    });
  });

  // ─── ETag caching ───────────────────────────────────────────

  describe('ETag caching', () => {
    it('returns cached response on 304', async () => {
      const authResp = mockAuthResponse();
      const firstResp = mockResponse(200, { data: 'fresh' }, {
        'Content-Type': 'application/json',
        'ETag': '"etag-1"',
      });
      const cachedResp = mockResponse(304, null);

      fetchWithRetry
        .mockResolvedValueOnce(authResp)
        .mockResolvedValueOnce(firstResp)
        .mockResolvedValueOnce(cachedResp);

      // First call populates cache
      const first = await client.restGet('/resource');
      expect(first).toEqual({ data: 'fresh' });

      // Second call gets 304, returns cached
      const second = await client.restGet('/resource');
      expect(second).toEqual({ data: 'fresh' });
    });

    it('sends If-None-Match header when ETag is cached', async () => {
      const authResp = mockAuthResponse();
      const firstResp = mockResponse(200, { data: 1 }, {
        'Content-Type': 'application/json',
        'ETag': '"my-etag"',
      });
      const secondResp = mockResponse(304, null);

      fetchWithRetry
        .mockResolvedValueOnce(authResp)
        .mockResolvedValueOnce(firstResp)
        .mockResolvedValueOnce(secondResp);

      await client.restGet('/path');
      await client.restGet('/path');

      // Third fetchWithRetry call (second GET) should include If-None-Match
      const secondGetCall = fetchWithRetry.mock.calls[2];
      expect(secondGetCall[1].headers['If-None-Match']).toBe('"my-etag"');
    });
  });

  // ─── 401 retry guard ───────────────────────────────────────

  describe('401 retry guard', () => {
    it('restGet retries once on 401 then succeeds', async () => {
      const authResp1 = mockAuthResponse();
      const unauthorizedResp = mockResponse(401, 'Unauthorized');
      const authResp2 = mockAuthResponse();
      const successResp = mockResponse(200, { ok: true }, { 'Content-Type': 'application/json' });

      fetchWithRetry
        .mockResolvedValueOnce(authResp1)   // first auth
        .mockResolvedValueOnce(unauthorizedResp) // GET returns 401
        .mockResolvedValueOnce(authResp2)   // re-auth
        .mockResolvedValueOnce(successResp); // retry GET succeeds

      const result = await client.restGet('/resource');
      expect(result).toEqual({ ok: true });
    });

    it('restGet throws on second consecutive 401 (no infinite recursion)', async () => {
      const authResp1 = mockAuthResponse();
      const unauth1 = mockResponse(401, 'Unauthorized');
      const authResp2 = mockAuthResponse();
      const unauth2 = mockResponse(401, 'Unauthorized');

      fetchWithRetry
        .mockResolvedValueOnce(authResp1)
        .mockResolvedValueOnce(unauth1)
        .mockResolvedValueOnce(authResp2)
        .mockResolvedValueOnce(unauth2);

      await expect(client.restGet('/resource'))
        .rejects.toThrow('401 Unauthorized (after re-auth)');
    });

    it('restSend retries once on 401 then succeeds', async () => {
      const authResp1 = mockAuthResponse();
      const unauth = mockResponse(401, 'Unauthorized');
      const authResp2 = mockAuthResponse();
      const success = mockResponse(200, { saved: true }, { 'Content-Type': 'application/json' });

      fetchWithRetry
        .mockResolvedValueOnce(authResp1)
        .mockResolvedValueOnce(unauth)
        .mockResolvedValueOnce(authResp2)
        .mockResolvedValueOnce(success);

      const result = await client.restSend('PUT', '/resource', { key: 'value' });
      expect(result).toEqual({ saved: true });
    });

    it('restSend throws on second consecutive 401 (no infinite recursion)', async () => {
      const authResp1 = mockAuthResponse();
      const unauth1 = mockResponse(401, 'Unauthorized');
      const authResp2 = mockAuthResponse();
      const unauth2 = mockResponse(401, 'Unauthorized');

      fetchWithRetry
        .mockResolvedValueOnce(authResp1)
        .mockResolvedValueOnce(unauth1)
        .mockResolvedValueOnce(authResp2)
        .mockResolvedValueOnce(unauth2);

      await expect(client.restSend('POST', '/resource', {}))
        .rejects.toThrow('401 Unauthorized (after re-auth)');
    });
  });

  // ─── Cache eviction ─────────────────────────────────────────

  describe('cache eviction', () => {
    it('evicts oldest entry when cache exceeds max size', () => {
      // Fill cache to max
      for (let i = 0; i < 100; i++) {
        client._cacheSet(`/path-${i}`, `etag-${i}`, { i });
      }
      expect(client._etags.size).toBe(100);
      expect(client._responseCache.size).toBe(100);

      // Adding one more should evict /path-0
      client._cacheSet('/path-new', 'etag-new', { new: true });
      expect(client._etags.size).toBe(100);
      expect(client._etags.has('/path-0')).toBe(false);
      expect(client._responseCache.has('/path-0')).toBe(false);
      expect(client._etags.has('/path-new')).toBe(true);
      expect(client._responseCache.get('/path-new')).toEqual({ new: true });
    });

    it('does not evict when under max size', () => {
      client._cacheSet('/a', 'etag-a', 'data-a');
      client._cacheSet('/b', 'etag-b', 'data-b');
      expect(client._etags.size).toBe(2);
      expect(client._etags.has('/a')).toBe(true);
      expect(client._etags.has('/b')).toBe(true);
    });

    it('evicts multiple oldest entries on sequential inserts', () => {
      for (let i = 0; i < 100; i++) {
        client._cacheSet(`/p-${i}`, `e-${i}`, i);
      }
      // Add 3 more
      client._cacheSet('/x1', 'ex1', 'x1');
      client._cacheSet('/x2', 'ex2', 'x2');
      client._cacheSet('/x3', 'ex3', 'x3');

      expect(client._etags.size).toBe(100);
      expect(client._etags.has('/p-0')).toBe(false);
      expect(client._etags.has('/p-1')).toBe(false);
      expect(client._etags.has('/p-2')).toBe(false);
      expect(client._etags.has('/p-3')).toBe(true); // still present
      expect(client._etags.has('/x3')).toBe(true);
    });
  });

  // ─── Proxy mode detection ──────────────────────────────────

  describe('proxy mode detection', () => {
    it('detects proxy mode when electronAPI.isElectron is set', () => {
      window.electronAPI = { isElectron: true };
      expect(client._isProxyMode()).toBe(true);
      delete window.electronAPI;
    });

    it('detects proxy mode when hostname is localhost', () => {
      // jsdom defaults to localhost
      const original = window.location.hostname;
      expect(client._isProxyMode()).toBe(original === 'localhost');
    });

    it('returns direct URL in non-proxy mode', () => {
      // Ensure no proxy indicators
      delete window.electronAPI;
      // jsdom hostname is localhost, so override _isProxyMode
      vi.spyOn(client, '_isProxyMode').mockReturnValue(false);

      const url = client.getRestBaseUrl();
      expect(url).toBe('https://cms.example.com/player/api/v2');
    });

    it('returns local origin URL in proxy mode via electronAPI', () => {
      window.electronAPI = { isElectron: true };

      const url = client.getRestBaseUrl();
      expect(url).toContain('/player/api/v2');
      // In proxy mode, uses window.location.origin (which is cms.example.com in vitest)
      // The key assertion is that _isProxyMode is true and the URL uses origin
      expect(url).toBe(`${window.location.origin}/player/api/v2`);

      delete window.electronAPI;
    });
  });
});
