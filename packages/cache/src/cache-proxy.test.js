/**
 * StoreClient Tests
 *
 * StoreClient: pure REST client for ContentStore — no SW dependency
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoreClient } from './store-client.js';
import { createTestBlob } from './test-utils.js';

/**
 * Reset global.fetch between tests
 */
function resetMocks() {
  global.fetch = vi.fn();
}

// ===========================================================================
// StoreClient Tests
// ===========================================================================

describe('StoreClient', () => {
  let store;

  beforeEach(() => {
    resetMocks();
    store = new StoreClient();
  });

  describe('has()', () => {
    it('should perform HEAD request to /store/:type/:id', async () => {
      global.fetch = vi.fn((url, options) => {
        if (url === '/store/media/123' && options?.method === 'HEAD') {
          return Promise.resolve({ ok: true, status: 200 });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const exists = await store.has('media', '123');

      expect(exists).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('/store/media/123', { method: 'HEAD' });
    });

    it('should return false for 404', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));

      const exists = await store.has('media', '123');

      expect(exists).toBe(false);
    });

    it('should return false on fetch error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

      const exists = await store.has('media', '123');

      expect(exists).toBe(false);
    });
  });

  describe('get()', () => {
    it('should fetch from /store/:type/:id and return blob', async () => {
      const testBlob = createTestBlob(1024);
      global.fetch = vi.fn((url) => {
        if (url === '/store/media/123') {
          return Promise.resolve({
            ok: true,
            status: 200,
            blob: () => Promise.resolve(testBlob),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const blob = await store.get('media', '123');

      expect(blob).toBe(testBlob);
      expect(global.fetch).toHaveBeenCalledWith('/store/media/123');
    });

    it('should return null for 404', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));

      const blob = await store.get('media', '123');

      expect(blob).toBeNull();
    });

    it('should return null on fetch error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

      const blob = await store.get('media', '123');

      expect(blob).toBeNull();
    });
  });

  describe('put()', () => {
    it('should PUT content to /store/:type/:id', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true }));

      const result = await store.put('widget', '1/2/3', '<html>test</html>', 'text/html');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('/store/widget/1/2/3', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html' },
        body: '<html>test</html>',
      });
    });

    it('should use default content type when not specified', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true }));

      await store.put('media', '42', new Blob([new Uint8Array(10)]));

      expect(global.fetch).toHaveBeenCalledWith('/store/media/42', expect.objectContaining({
        headers: { 'Content-Type': 'application/octet-stream' },
      }));
    });

    it('should return false on error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

      const result = await store.put('widget', '1/2/3', 'data');

      expect(result).toBe(false);
    });
  });

  describe('remove()', () => {
    it('should POST to /store/delete with file list', async () => {
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ deleted: 2, total: 2 }),
      }));

      const files = [
        { type: 'media', id: '1' },
        { type: 'media', id: '2' },
      ];
      const result = await store.remove(files);

      expect(result).toEqual({ deleted: 2, total: 2 });
      expect(global.fetch).toHaveBeenCalledWith('/store/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
    });

    it('should return zeros on error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('fail')));

      const result = await store.remove([{ type: 'media', id: '1' }]);

      expect(result).toEqual({ deleted: 0, total: 1 });
    });
  });

  describe('list()', () => {
    it('should GET /store/list and return files', async () => {
      const mockFiles = [
        { id: '1', type: 'media', size: 1024 },
        { id: '2', type: 'layout', size: 512 },
      ];
      global.fetch = vi.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ files: mockFiles }),
      }));

      const files = await store.list();

      expect(files).toEqual(mockFiles);
      expect(global.fetch).toHaveBeenCalledWith('/store/list');
    });

    it('should return empty array on error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('fail')));

      const files = await store.list();

      expect(files).toEqual([]);
    });
  });
});

