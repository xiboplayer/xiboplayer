/**
 * XmrClient Tests
 *
 * Tests the native XMR WebSocket client: connection lifecycle,
 * message parsing, TTL checks, generic action dispatch, and reconnection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { XmrClient } from './xmr-client.js';

// --- Mock WebSocket ---

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._listeners = {};
    this.sentMessages = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener(event, cb) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(cb);
  }

  send(data) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this._fire('close', {});
  }

  // Test helpers
  _fire(event, data) {
    (this._listeners[event] || []).forEach(cb => cb(data));
  }

  _open() {
    this.readyState = 1; // OPEN
    this._fire('open', {});
  }

  _message(data) {
    this._fire('message', { data });
  }

  _error() {
    this._fire('error', {});
  }
}

describe('XmrClient', () => {
  let client;
  let originalWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket;
    client = new XmrClient('test-channel');
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  function getSocket() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  describe('start()', () => {
    it('should open WebSocket and send init message on connect', async () => {
      await client.start('wss://xmr.example.com', 'cms-key-123');
      const ws = getSocket();
      ws._open();

      expect(ws.url).toBe('wss://xmr.example.com');
      expect(ws.sentMessages).toHaveLength(1);

      const initMsg = JSON.parse(ws.sentMessages[0]);
      expect(initMsg).toEqual({
        type: 'init',
        key: 'cms-key-123',
        channel: 'test-channel',
      });
    });

    it('should emit connected on WebSocket open', async () => {
      const spy = vi.fn();
      client.on('connected', spy);

      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(client.isConnected).toBe(true);
    });

    it('should emit disconnected on WebSocket close', async () => {
      const spy = vi.fn();
      client.on('disconnected', spy);

      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();
      getSocket().close();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(client.isConnected).toBe(false);
    });

    it('should emit error on WebSocket error', async () => {
      const spy = vi.fn();
      client.on('error', spy);

      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._error();

      expect(spy).toHaveBeenCalledWith('error');
    });

    it('should close existing socket when start() called again', async () => {
      await client.start('wss://xmr.example.com', 'cms-key');
      const first = getSocket();
      first._open();

      await client.start('wss://xmr.example.com', 'cms-key');

      expect(first.readyState).toBe(3); // CLOSED
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });

  describe('Message handling', () => {
    beforeEach(async () => {
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();
    });

    it('should handle heartbeat "H" without emitting action', () => {
      const spy = vi.fn();
      client.on('collectNow', spy);

      const before = client.lastMessageAt;
      vi.advanceTimersByTime(1000);
      getSocket()._message('H');

      expect(client.lastMessageAt).toBeGreaterThan(before);
      expect(spy).not.toHaveBeenCalled();
    });

    it('should emit action name with full message for valid JSON', () => {
      const spy = vi.fn();
      client.on('collectNow', spy);

      const msg = {
        action: 'collectNow',
        createdDt: new Date().toISOString(),
        ttl: 300,
      };
      getSocket()._message(JSON.stringify(msg));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(msg);
    });

    it('should not emit expired messages (TTL check)', () => {
      const spy = vi.fn();
      client.on('collectNow', spy);

      const msg = {
        action: 'collectNow',
        createdDt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
        ttl: 300, // 5 min TTL → expired
      };
      getSocket()._message(JSON.stringify(msg));

      expect(spy).not.toHaveBeenCalled();
    });

    it('should emit messages without TTL fields (no expiry check)', () => {
      const spy = vi.fn();
      client.on('collectNow', spy);

      const msg = { action: 'collectNow' };
      getSocket()._message(JSON.stringify(msg));

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should dispatch any unknown action generically (no hardcoded list)', () => {
      const spy = vi.fn();
      client.on('someFutureAction', spy);

      const msg = {
        action: 'someFutureAction',
        createdDt: new Date().toISOString(),
        ttl: 300,
        customField: 'hello',
      };
      getSocket()._message(JSON.stringify(msg));

      expect(spy).toHaveBeenCalledWith(msg);
    });

    it('should dispatch commandAction with full message including commandCode', () => {
      const spy = vi.fn();
      client.on('commandAction', spy);

      const msg = {
        action: 'commandAction',
        commandCode: 'collectNow',
        createdDt: new Date().toISOString(),
        ttl: 300,
      };
      getSocket()._message(JSON.stringify(msg));

      expect(spy).toHaveBeenCalledWith(msg);
      expect(spy.mock.calls[0][0].commandCode).toBe('collectNow');
    });

    it('should ignore messages without action field', () => {
      const spy = vi.fn();
      client.on('collectNow', spy);

      getSocket()._message(JSON.stringify({ data: 'no action' }));

      expect(spy).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON gracefully', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      getSocket()._message('not-json{{{');

      expect(errorSpy).toHaveBeenCalledWith(
        'XmrClient: failed to parse message:',
        expect.any(SyntaxError)
      );
      errorSpy.mockRestore();
    });
  });

  describe('isActive()', () => {
    it('should return true when connected and recent message', async () => {
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      expect(client.isActive()).toBe(true);
    });

    it('should return false after 15min silence', async () => {
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      vi.advanceTimersByTime(15 * 60 * 1000 + 1);

      expect(client.isActive()).toBe(false);
    });

    it('should return false when not connected', () => {
      expect(client.isActive()).toBe(false);
    });
  });

  describe('Reconnect interval', () => {
    it('should call start() every 60s when connection wanted but inactive', async () => {
      await client.init();
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      // Advance past 15min to make isActive() false
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      // Force disconnect state
      client.isConnected = false;

      const instancesBefore = MockWebSocket.instances.length;
      vi.advanceTimersByTime(60_000);

      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore);
    });

    it('should not reconnect if stop() was called', async () => {
      await client.init();
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      await client.stop();
      const instancesAfterStop = MockWebSocket.instances.length;

      vi.advanceTimersByTime(120_000);

      expect(MockWebSocket.instances.length).toBe(instancesAfterStop);
    });
  });

  describe('stop()', () => {
    it('should close socket and clear interval', async () => {
      await client.init();
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      await client.stop();

      expect(client.socket).toBeNull();
      expect(client.isConnected).toBe(false);
      expect(client._interval).toBeNull();
    });

    it('should be safe to call when not started', async () => {
      await expect(client.stop()).resolves.not.toThrow();
    });
  });

  describe('on() / emit()', () => {
    it('should support multiple listeners per event', () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      client.on('test', spy1);
      client.on('test', spy2);

      client.emit('test', 'data');

      expect(spy1).toHaveBeenCalledWith('data');
      expect(spy2).toHaveBeenCalledWith('data');
    });

    it('should return unsubscribe function', () => {
      const spy = vi.fn();
      const unsub = client.on('test', spy);

      client.emit('test');
      expect(spy).toHaveBeenCalledTimes(1);

      unsub();
      client.emit('test');
      expect(spy).toHaveBeenCalledTimes(1); // not called again
    });

    it('should not throw when emitting with no listeners', () => {
      expect(() => client.emit('nonexistent', 'data')).not.toThrow();
    });

    it('should catch and log listener errors without breaking other listeners', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const badListener = vi.fn(() => { throw new Error('boom'); });
      const goodListener = vi.fn();

      client.on('test', badListener);
      client.on('test', goodListener);

      client.emit('test', 'data');

      expect(badListener).toHaveBeenCalled();
      expect(goodListener).toHaveBeenCalledWith('data');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("listener error for 'test'"),
        expect.any(Error)
      );
      errorSpy.mockRestore();
    });
  });

  describe('send()', () => {
    it('should send JSON via WebSocket', async () => {
      await client.start('wss://xmr.example.com', 'cms-key');
      getSocket()._open();

      await client.send('testAction', { foo: 'bar' });

      // sentMessages[0] is the init message
      const sent = JSON.parse(getSocket().sentMessages[1]);
      expect(sent.action).toBe('testAction');
      expect(sent.foo).toBe('bar');
    });

    it('should throw when not connected', async () => {
      await expect(client.send('test', {})).rejects.toThrow('Not connected');
    });
  });
});
