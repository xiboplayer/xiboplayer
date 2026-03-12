// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Test Utilities for Xibo Player Core
 *
 * Provides mocking utilities, test helpers, and fixtures for unit tests.
 */

import { vi } from 'vitest';

/**
 * Mock fetch with controllable responses
 *
 * Usage:
 *   mockFetch({
 *     'http://example.com/file.mp4': {
 *       blob: createTestBlob(1024),
 *       headers: { 'Content-Length': '1024' }
 *     }
 *   });
 */
export function mockFetch(responses = {}) {
  global.fetch = vi.fn((url, options) => {
    const method = options?.method || 'GET';
    const key = `${method} ${url}`;
    const response = responses[key] || responses[url];

    if (!response) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: {
          get: () => null
        }
      });
    }

    return Promise.resolve({
      ok: response.ok !== false,
      status: response.status || 200,
      statusText: response.statusText || 'OK',
      headers: {
        get: (name) => response.headers?.[name] || null
      },
      blob: () => Promise.resolve(response.blob || new Blob()),
      text: () => Promise.resolve(response.text || ''),
      json: () => Promise.resolve(response.json || {}),
      arrayBuffer: () => Promise.resolve(response.arrayBuffer || new ArrayBuffer(0))
    });
  });

  return global.fetch;
}

/**
 * Mock Service Worker navigator
 *
 * Usage:
 *   mockServiceWorker({ ready: true, controller: {} });
 *   mockServiceWorker({ supported: false }); // Simulate no SW support
 */
export function mockServiceWorker(config = {}) {
  const {
    ready = true,
    controller = {},
    supported = true
  } = config;

  if (supported) {
    global.navigator.serviceWorker = {
      ready: ready ? Promise.resolve({ active: {} }) : Promise.reject(new Error('Not ready')),
      controller: controller,
      register: vi.fn(() => Promise.resolve({ scope: '/' })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
  } else {
    delete global.navigator.serviceWorker;
  }
}

/**
 * Mock CacheManager for DirectCacheBackend tests
 *
 * Returns a mock object with all cache.js methods
 */
export function mockCacheManager() {
  return {
    init: vi.fn(() => Promise.resolve()),
    getCachedFile: vi.fn(() => Promise.resolve(null)),
    getCachedResponse: vi.fn(() => Promise.resolve(null)),
    downloadFile: vi.fn(() => Promise.resolve({ id: '1', size: 100 })),
    getFile: vi.fn(() => Promise.resolve(null)),
    getCacheKey: vi.fn((type, id) => `/cache/${type}/${id}`),
    cache: {
      match: vi.fn(() => Promise.resolve(null)),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve(true))
    }
  };
}

/**
 * Create test blob
 *
 * Usage:
 *   const blob = createTestBlob(1024); // 1KB blob
 *   const blob = createTestBlob(1024, 'video/mp4'); // Typed blob
 */
export function createTestBlob(size = 1024, type = 'application/octet-stream') {
  const buffer = new ArrayBuffer(size);
  return new Blob([buffer], { type });
}

/**
 * Wait for condition to be true
 *
 * Usage:
 *   await waitFor(() => task.state === 'complete', 5000);
 */
export async function waitFor(condition, timeout = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Wait for a specific time (for testing timing-dependent logic)
 *
 * Usage:
 *   await wait(100); // Wait 100ms
 */
export async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a spy that tracks calls but doesn't interfere
 *
 * Usage:
 *   const spy = createSpy();
 *   obj.on('event', spy);
 *   // ... trigger event
 *   expect(spy).toHaveBeenCalledWith('arg1', 'arg2');
 */
export function createSpy() {
  return vi.fn();
}

/**
 * Mock MessageChannel for Service Worker tests
 */
export function mockMessageChannel() {
  class MockMessagePort {
    constructor() {
      this.onmessage = null;
      this._listeners = [];
    }

    addEventListener(event, callback) {
      if (event === 'message') {
        this._listeners.push(callback);
      }
    }

    removeEventListener(event, callback) {
      if (event === 'message') {
        const index = this._listeners.indexOf(callback);
        if (index !== -1) {
          this._listeners.splice(index, 1);
        }
      }
    }

    postMessage(data) {
      // Simulate async message passing
      setTimeout(() => {
        if (this.paired) {
          const event = { data };

          // Call onmessage if set
          if (this.paired.onmessage) {
            this.paired.onmessage(event);
          }

          // Call event listeners
          this.paired._listeners.forEach(listener => listener(event));
        }
      }, 0);
    }
  }

  class MockMessageChannel {
    constructor() {
      this.port1 = new MockMessagePort();
      this.port2 = new MockMessagePort();
      this.port1.paired = this.port2;
      this.port2.paired = this.port1;
    }
  }

  global.MessageChannel = MockMessageChannel;
  return MockMessageChannel;
}

/**
 * Reset all mocks
 */
export function resetMocks() {
  vi.clearAllMocks();
  delete global.fetch;
  delete global.navigator.serviceWorker;
  delete global.MessageChannel;
}
