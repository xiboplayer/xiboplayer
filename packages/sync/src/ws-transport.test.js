// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * WebSocketTransport tests
 *
 * Focuses on message parsing — the onmessage handler must correctly parse
 * JSON from three different event.data types:
 *   1. string  — browser WebSocket (standard)
 *   2. Buffer  — Node.js `ws` package
 *   3. Blob    — Node 22+ native WebSocket (undici)
 *
 * Uses a mock WebSocket to test the transport in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock WebSocket ──────────────────────────────────────────────
// Captures onopen/onmessage/onclose/onerror handlers set by the transport

class MockWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._sent = [];
    MockWebSocket.instances.push(this);

    // Auto-fire onopen in next microtask
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }

  send(data) {
    this._sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Test helper: simulate receiving a message with arbitrary event.data
  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }
}

// Install mock before importing the transport
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

// Dynamic import so it picks up our mock WebSocket
async function createTransport(url = 'ws://localhost:9590/sync', opts = {}) {
  const { WebSocketTransport } = await import('./ws-transport.js');
  return new WebSocketTransport(url, opts);
}

// ── Tests ───────────────────────────────────────────────────────

describe('WebSocketTransport', () => {
  describe('message parsing', () => {
    const testMsg = { type: 'layout-change', layoutId: '42', showAt: 12345 };

    it('parses string data (browser WebSocket)', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      const received = vi.fn();
      transport.onMessage(received);

      // Browser sends string
      ws.simulateMessage(JSON.stringify(testMsg));

      // Allow async onmessage to complete
      await vi.waitFor(() => expect(received).toHaveBeenCalled());
      expect(received).toHaveBeenCalledWith(testMsg);

      transport.close();
    });

    it('parses Buffer data (Node ws package)', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      const received = vi.fn();
      transport.onMessage(received);

      // Node ws sends Buffer
      const buffer = Buffer.from(JSON.stringify(testMsg));
      ws.simulateMessage(buffer);

      await vi.waitFor(() => expect(received).toHaveBeenCalled());
      expect(received).toHaveBeenCalledWith(testMsg);

      transport.close();
    });

    it('parses Blob data (Node 22+ native WebSocket)', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      const received = vi.fn();
      transport.onMessage(received);

      // Node 22+ native WS (undici) sends Blob
      const blob = new Blob([JSON.stringify(testMsg)]);
      ws.simulateMessage(blob);

      await vi.waitFor(() => expect(received).toHaveBeenCalled());
      expect(received).toHaveBeenCalledWith(testMsg);

      transport.close();
    });

    it('warns on unparseable data without crashing', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      const received = vi.fn();
      transport.onMessage(received);

      // Send garbage
      ws.simulateMessage('not json {{{');

      // Give async handler a tick
      await new Promise(r => setTimeout(r, 50));

      expect(received).not.toHaveBeenCalled();

      transport.close();
    });

    it('ignores messages when no callback registered', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      // No onMessage callback set — should not throw
      ws.simulateMessage(JSON.stringify(testMsg));
      await new Promise(r => setTimeout(r, 50));

      transport.close();
    });
  });

  describe('join message', () => {
    it('sends join with syncGroup on connect', async () => {
      const transport = await createTransport('ws://localhost:9590/sync', {
        syncGroup: 'lobby',
      });
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      // Wait for onopen to fire and send join
      await vi.waitFor(() => expect(ws._sent.length).toBeGreaterThan(0));

      const join = JSON.parse(ws._sent[0]);
      expect(join.type).toBe('join');
      expect(join.syncGroup).toBe('lobby');

      transport.close();
    });

    it('includes displayId and topology in join', async () => {
      const transport = await createTransport('ws://localhost:9590/sync', {
        syncGroup: 'wall',
        displayId: 'display-1',
        topology: { x: 1, y: 0, orientation: 90 },
      });
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      await vi.waitFor(() => expect(ws._sent.length).toBeGreaterThan(0));

      const join = JSON.parse(ws._sent[0]);
      expect(join.displayId).toBe('display-1');
      expect(join.topology).toEqual({ x: 1, y: 0, orientation: 90 });

      transport.close();
    });

    it('does not send join when no syncGroup', async () => {
      const transport = await createTransport('ws://localhost:9590/sync', {});
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
      const ws = MockWebSocket.instances[0];

      // Give time for onopen
      await new Promise(r => setTimeout(r, 50));

      expect(ws._sent.length).toBe(0);

      transport.close();
    });
  });

  describe('send', () => {
    it('serializes objects to JSON', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

      transport.send({ type: 'heartbeat', displayId: 'test' });
      const ws = MockWebSocket.instances[0];
      const lastSent = ws._sent[ws._sent.length - 1];
      expect(JSON.parse(lastSent)).toEqual({ type: 'heartbeat', displayId: 'test' });

      transport.close();
    });

    it('does not send when connection is closed', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

      transport.close();
      transport.send({ type: 'heartbeat' });
      // Should not throw
    });
  });

  describe('lifecycle', () => {
    it('reports connected when WebSocket is OPEN', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

      expect(transport.connected).toBe(true);

      transport.close();
      expect(transport.connected).toBe(false);
    });

    it('close() prevents reconnection', async () => {
      const transport = await createTransport();
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

      transport.close();

      // Wait to ensure no reconnect
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).toBe(1); // no new instance
    });
  });
});
