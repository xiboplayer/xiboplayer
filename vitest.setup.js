/**
 * Vitest setup file
 * Global setup for all tests
 */

import { vi } from 'vitest';
import 'fake-indexeddb/auto';

// Mock fetch (will be overridden in tests that need real network)
global.__nativeFetch = globalThis.fetch;
global.fetch = vi.fn();

// Mock canvas for screenshot tests
global.HTMLCanvasElement = class HTMLCanvasElement {
  constructor() {
    this.width = 0;
    this.height = 0;
  }

  getContext() {
    return {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn()
    };
  }

  toDataURL() {
    return 'data:image/png;base64,mock';
  }
};

// Stub HTMLMediaElement methods and properties not implemented in jsdom
// (prevents "Not implemented" errors during renderer cleanup and enables
// video duration detection tests that rely on loadedmetadata events)
try {
  const proto = window.HTMLMediaElement.prototype;
  proto.play = vi.fn(() => Promise.resolve());
  proto.pause = vi.fn();
  proto.load = vi.fn();

  // Make duration and currentTime writable — jsdom defines them as readonly
  // getters that always return NaN/0. Override with simple data properties
  // so tests can set them via Object.defineProperty or direct assignment.
  Object.defineProperty(proto, 'duration', {
    writable: true,
    configurable: true,
    value: NaN,
  });
  Object.defineProperty(proto, 'currentTime', {
    writable: true,
    configurable: true,
    value: 0,
  });
} catch (_) {
  // Fallback if HTMLMediaElement not available (non-jsdom environments)
}

// Mock atob/btoa
global.atob = (str) => Buffer.from(str, 'base64').toString('binary');
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

console.log('[vitest.setup] Global mocks initialized (fake-indexeddb active)');
