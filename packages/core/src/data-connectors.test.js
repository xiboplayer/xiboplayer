// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DataConnectorManager } from './data-connectors.js';

// Mock fetchWithRetry (used by DataConnectorManager internally)
vi.mock('@xiboplayer/utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchWithRetry: vi.fn(),
  };
});

import { fetchWithRetry } from '@xiboplayer/utils';

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => h === 'Content-Type' ? 'application/json' : null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('DataConnectorManager', () => {
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new DataConnectorManager();
  });

  afterEach(() => {
    manager.cleanup();
  });

  // ── setConnectors ──────────────────────────────────────────────

  describe('setConnectors', () => {
    it('registers connectors with valid dataKey and url', () => {
      manager.setConnectors([
        { dataKey: 'weather', url: 'https://api.test/weather', updateInterval: 60 },
      ]);
      expect(manager.connectors.size).toBe(1);
      expect(manager.connectors.has('weather')).toBe(true);
    });

    it('skips connectors missing dataKey or url', () => {
      manager.setConnectors([
        { url: 'https://api.test/no-key' },
        { dataKey: 'no-url' },
        { dataKey: 'ok', url: 'https://api.test/ok', updateInterval: 30 },
      ]);
      expect(manager.connectors.size).toBe(1);
    });

    it('clears previous connectors on reconfigure', () => {
      manager.setConnectors([{ dataKey: 'a', url: 'https://a.test' }]);
      manager.setConnectors([{ dataKey: 'b', url: 'https://b.test' }]);
      expect(manager.connectors.size).toBe(1);
      expect(manager.connectors.has('a')).toBe(false);
      expect(manager.connectors.has('b')).toBe(true);
    });

    it('handles null/empty input', () => {
      manager.setConnectors(null);
      expect(manager.connectors.size).toBe(0);
      manager.setConnectors([]);
      expect(manager.connectors.size).toBe(0);
    });
  });

  // ── startPolling / stopPolling ─────────────────────────────────

  describe('polling', () => {
    it('fetches immediately on start', async () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({ temp: 20 }));

      manager.setConnectors([{ dataKey: 'weather', url: 'https://api.test/w', updateInterval: 60 }]);
      manager.startPolling();

      // Wait for the immediate fetch to resolve
      await new Promise(r => setTimeout(r, 50));

      expect(fetchWithRetry).toHaveBeenCalledTimes(1);
      expect(manager.getData('weather')).toEqual({ temp: 20 });
    });

    it('sets up interval timer', () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({ v: 1 }));

      manager.setConnectors([{ dataKey: 'data', url: 'https://api.test/d', updateInterval: 10 }]);
      manager.startPolling();

      const entry = manager.connectors.get('data');
      expect(entry.timer).not.toBeNull();
    });

    it('stops polling on stopPolling', () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({}));

      manager.setConnectors([{ dataKey: 'data', url: 'https://api.test/d', updateInterval: 5 }]);
      manager.startPolling();

      const entry = manager.connectors.get('data');
      expect(entry.timer).not.toBeNull();

      manager.stopPolling();
      expect(entry.timer).toBeNull();
    });
  });

  // ── fetchData + events ─────────────────────────────────────────

  describe('fetchData', () => {
    it('emits data-updated on success', async () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({ x: 1 }));
      const spy = vi.fn();
      manager.on('data-updated', spy);

      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test/k', updateInterval: 60 }]);
      const entry = manager.connectors.get('k');
      await manager.fetchData(entry);

      expect(spy).toHaveBeenCalledWith('k', { x: 1 });
    });

    it('emits data-changed when data differs', async () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({ v: 1 }));
      const spy = vi.fn();
      manager.on('data-changed', spy);

      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test/k', updateInterval: 60 }]);
      const entry = manager.connectors.get('k');

      await manager.fetchData(entry);
      expect(spy).toHaveBeenCalledTimes(1); // null → {v:1} is a change

      fetchWithRetry.mockResolvedValue(jsonResponse({ v: 1 }));
      await manager.fetchData(entry);
      expect(spy).toHaveBeenCalledTimes(1); // same data, no change event

      fetchWithRetry.mockResolvedValue(jsonResponse({ v: 2 }));
      await manager.fetchData(entry);
      expect(spy).toHaveBeenCalledTimes(2); // changed
    });

    it('emits fetch-error on failure', async () => {
      fetchWithRetry.mockRejectedValue(new Error('Network timeout'));
      const spy = vi.fn();
      manager.on('fetch-error', spy);

      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test/k', updateInterval: 60 }]);
      const entry = manager.connectors.get('k');
      await manager.fetchData(entry);

      expect(spy).toHaveBeenCalledWith('k', expect.any(Error));
    });
  });

  // ── Circuit breaker ────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('increments failure counter on fetch error', async () => {
      fetchWithRetry.mockRejectedValue(new Error('fail'));

      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test/k', updateInterval: 60 }]);
      const entry = manager.connectors.get('k');
      await manager.fetchData(entry);

      expect(entry.failures).toBe(1);
    });

    it('resets failure counter on success', async () => {
      fetchWithRetry.mockRejectedValue(new Error('fail'));

      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test/k', updateInterval: 60 }]);
      const entry = manager.connectors.get('k');

      await manager.fetchData(entry);
      await manager.fetchData(entry);
      expect(entry.failures).toBe(2);

      fetchWithRetry.mockResolvedValue(jsonResponse({ ok: true }));
      await manager.fetchData(entry);
      expect(entry.failures).toBe(0);
    });

    it('backs off after 3 consecutive failures', async () => {
      fetchWithRetry.mockRejectedValue(new Error('fail'));

      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test/k', updateInterval: 10 }]);
      const entry = manager.connectors.get('k');
      // Simulate an active polling timer
      entry.timer = setInterval(() => {}, 10000);

      // 3 consecutive failures triggers circuit breaker
      await manager.fetchData(entry);
      expect(entry.failures).toBe(1);
      await manager.fetchData(entry);
      expect(entry.failures).toBe(2);
      await manager.fetchData(entry);
      expect(entry.failures).toBe(3);
      // Timer was replaced by backed-off setTimeout
      expect(entry.timer).not.toBeNull();
    });
  });

  // ── getData / getAvailableKeys ────────────────────────────────

  describe('getData', () => {
    it('returns null for unknown key', () => {
      expect(manager.getData('nonexistent')).toBeNull();
    });

    it('returns stored data after fetch', async () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({ temp: 25 }));
      manager.setConnectors([{ dataKey: 'w', url: 'https://api.test/w', updateInterval: 60 }]);
      await manager.fetchData(manager.connectors.get('w'));
      expect(manager.getData('w')).toEqual({ temp: 25 });
    });
  });

  describe('getAvailableKeys', () => {
    it('returns empty array when no data', () => {
      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test', updateInterval: 60 }]);
      expect(manager.getAvailableKeys()).toEqual([]);
    });

    it('returns keys with data', async () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({ v: 1 }));
      manager.setConnectors([
        { dataKey: 'a', url: 'https://a.test', updateInterval: 60 },
        { dataKey: 'b', url: 'https://b.test', updateInterval: 60 },
      ]);
      await manager.fetchData(manager.connectors.get('a'));
      expect(manager.getAvailableKeys()).toEqual(['a']);
    });
  });

  // ── refreshAll / cleanup ──────────────────────────────────────

  describe('refreshAll', () => {
    it('restarts polling for all connectors', async () => {
      fetchWithRetry.mockResolvedValue(jsonResponse({}));
      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test', updateInterval: 60 }]);
      manager.startPolling();
      await new Promise(r => setTimeout(r, 50));

      fetchWithRetry.mockClear();
      manager.refreshAll();
      await new Promise(r => setTimeout(r, 50));
      expect(fetchWithRetry).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('stops polling and clears all state', () => {
      manager.setConnectors([{ dataKey: 'k', url: 'https://api.test', updateInterval: 60 }]);
      manager.cleanup();
      expect(manager.connectors.size).toBe(0);
    });
  });
});
