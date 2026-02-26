/**
 * StoreClient & DownloadClient Tests
 *
 * StoreClient: pure REST client for ContentStore — no SW dependency
 * DownloadClient: SW postMessage client for download orchestration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoreClient } from './store-client.js';
import { DownloadClient } from './download-client.js';
import { createTestBlob } from './test-utils.js';

/**
 * Reset global.fetch between tests
 */
function resetMocks() {
  global.fetch = vi.fn();
  delete global.MessageChannel;
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

// ===========================================================================
// DownloadClient Tests
// ===========================================================================

/**
 * Helper: set up navigator.serviceWorker mock.
 */
function setupServiceWorker(opts = {}) {
  const {
    supported = true,
    controller = null,
    active = undefined,
    installing = null,
    waiting = null,
    swReadyResolves = true,
  } = opts;

  if (!supported) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete navigator.serviceWorker;
    return;
  }

  const activeSW = active !== undefined
    ? active
    : controller
      ? { state: 'activated', postMessage: controller.postMessage }
      : null;

  const registration = {
    active: activeSW,
    installing,
    waiting,
  };

  const messageListeners = [];

  const swContainer = {
    controller,
    ready: swReadyResolves
      ? Promise.resolve(registration)
      : new Promise(() => {}),
    getRegistration: vi.fn().mockResolvedValue(registration),
    addEventListener: vi.fn((event, handler) => {
      if (event === 'message') {
        messageListeners.push(handler);
      }
    }),
    removeEventListener: vi.fn(),
  };

  swContainer._messageListeners = messageListeners;
  swContainer._registration = registration;

  Object.defineProperty(navigator, 'serviceWorker', {
    value: swContainer,
    configurable: true,
    writable: true,
  });

  return swContainer;
}

function dispatchSWMessage(swContainer, data) {
  for (const listener of swContainer._messageListeners || []) {
    listener({ data });
  }
}

function setupMessageChannel() {
  const channels = [];

  global.MessageChannel = class {
    constructor() {
      const self = { port1: { onmessage: null }, port2: {} };
      channels.push(self);
      this.port1 = self.port1;
      this.port2 = self.port2;
    }
  };

  return {
    get lastChannel() {
      return channels[channels.length - 1];
    },
    respondOnLastChannel(data) {
      const ch = channels[channels.length - 1];
      if (ch && ch.port1.onmessage) {
        ch.port1.onmessage({ data });
      }
    },
    channels,
  };
}

async function createInitialisedDownloadClient() {
  const controller = { postMessage: vi.fn() };
  const sw = setupServiceWorker({ controller });

  const client = new DownloadClient();
  const initPromise = client.init();

  await Promise.resolve();
  dispatchSWMessage(sw, { type: 'SW_READY' });

  await initPromise;
  return { client, sw, controller };
}

describe('DownloadClient', () => {
  beforeEach(() => {
    resetMocks();
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  describe('init()', () => {
    it('should initialize with SW controller', async () => {
      setupMessageChannel();
      const { client } = await createInitialisedDownloadClient();

      expect(client.controller).toBeTruthy();
    });

    it('should throw if SW not supported', async () => {
      setupServiceWorker({ supported: false });

      const client = new DownloadClient();

      await expect(client.init()).rejects.toThrow('Service Worker not supported');
    });
  });

  describe('download()', () => {
    it('should post DOWNLOAD_FILES message to SW', async () => {
      setupMessageChannel();
      const { client } = await createInitialisedDownloadClient();

      client.controller.postMessage = vi.fn();

      const files = [
        { id: '1', type: 'media', path: 'http://test.com/file1.mp4' },
        { id: '2', type: 'media', path: 'http://test.com/file2.mp4' },
      ];

      const mc = setupMessageChannel();
      const downloadPromise = client.download(files);

      // Simulate SW acknowledging the download
      mc.respondOnLastChannel({
        success: true,
        enqueuedCount: 2,
        activeCount: 2,
        queuedCount: 0,
      });

      await expect(downloadPromise).resolves.toBeUndefined();
    });

    it('should reject when SW returns error', async () => {
      setupMessageChannel();
      const { client } = await createInitialisedDownloadClient();

      client.controller.postMessage = vi.fn();

      const mc = setupMessageChannel();
      const downloadPromise = client.download([]);

      mc.respondOnLastChannel({ success: false, error: 'Download failed' });

      await expect(downloadPromise).rejects.toThrow('Download failed');
    });

    it('should throw if SW controller not available', async () => {
      setupMessageChannel();
      const { client } = await createInitialisedDownloadClient();

      client.controller = null;

      await expect(client.download([])).rejects.toThrow('Service Worker not available');
    });
  });

  describe('getProgress()', () => {
    it('should return empty object when controller is null', async () => {
      setupMessageChannel();
      const { client } = await createInitialisedDownloadClient();
      client.controller = null;

      const progress = await client.getProgress();

      expect(progress).toEqual({});
    });
  });
});
