// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Sync relay integration tests
 *
 * Tests the WebSocket sync relay with real HTTP server + WS connections.
 * Verifies group isolation: messages are scoped to the sender's sync group.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachSyncRelay } from './sync-relay.js';

// ── Helpers ──────────────────────────────────────────────────────

/** Create an HTTP server with sync relay, return { server, wss, url } */
function createRelay() {
  const server = http.createServer();
  const wss = attachSyncRelay(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, wss, url: `ws://127.0.0.1:${port}/sync` });
    });
  });
}

/** Connect a WS client and wait for open */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Collect next N messages from a WS client */
function collectMessages(ws, count) {
  const msgs = [];
  return new Promise((resolve) => {
    ws.on('message', (data) => {
      msgs.push(JSON.parse(data));
      if (msgs.length >= count) resolve(msgs);
    });
  });
}

/** Send a JSON message */
function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

/** Wait for a short tick */
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ── Tests ────────────────────────────────────────────────────────

describe('SyncRelay', () => {
  let server;
  let wss;
  const clients = [];

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState <= 1) ws.close();
    }
    clients.length = 0;
    if (wss) wss.close();
    if (server) await new Promise((r) => server.close(r));
  });

  async function setup() {
    const relay = await createRelay();
    server = relay.server;
    wss = relay.wss;
    return relay.url;
  }

  it('should broadcast to all clients without groups (backward compat)', async () => {
    const url = await setup();
    const a = await connect(url);
    const b = await connect(url);
    clients.push(a, b);

    const received = collectMessages(b, 1);
    send(a, { type: 'heartbeat', displayId: 'a' });

    const [msg] = await received;
    expect(msg.type).toBe('heartbeat');
    expect(msg.displayId).toBe('a');
  });

  it('should not echo messages back to sender', async () => {
    const url = await setup();
    const a = await connect(url);
    clients.push(a);

    let received = false;
    a.on('message', () => { received = true; });

    send(a, { type: 'heartbeat', displayId: 'a' });
    await tick();

    expect(received).toBe(false);
  });

  it('should isolate messages by sync group', async () => {
    const url = await setup();

    // Group "wall-1": clients a and b
    const a = await connect(url);
    const b = await connect(url);
    // Group "wall-2": client c
    const c = await connect(url);
    clients.push(a, b, c);

    // Join groups
    send(a, { type: 'join', syncGroup: 'wall-1' });
    send(b, { type: 'join', syncGroup: 'wall-1' });
    send(c, { type: 'join', syncGroup: 'wall-2' });
    await tick();

    // Track what c receives
    let cReceived = false;
    c.on('message', () => { cReceived = true; });

    // b should receive a's message
    const bReceived = collectMessages(b, 1);
    send(a, { type: 'layout-change', layoutId: '42', displayId: 'a' });

    const [msg] = await bReceived;
    expect(msg.type).toBe('layout-change');
    expect(msg.layoutId).toBe('42');

    // c should NOT have received anything (different group)
    await tick();
    expect(cReceived).toBe(false);
  });

  it('should not broadcast join messages', async () => {
    const url = await setup();
    const a = await connect(url);
    const b = await connect(url);
    clients.push(a, b);

    let bReceived = false;
    b.on('message', () => { bReceived = true; });

    send(a, { type: 'join', syncGroup: 'wall-1' });
    await tick();

    expect(bReceived).toBe(false);
  });

  it('should clean up group membership on disconnect', async () => {
    const url = await setup();
    const a = await connect(url);
    const b = await connect(url);
    clients.push(a, b);

    send(a, { type: 'join', syncGroup: 'wall-1' });
    send(b, { type: 'join', syncGroup: 'wall-1' });
    await tick();

    // Disconnect a
    a.close();
    await tick(100);

    // b should still be able to send (no crash)
    send(b, { type: 'heartbeat', displayId: 'b' });
    await tick();
  });

  it('should handle multiple groups concurrently', async () => {
    const url = await setup();

    const a1 = await connect(url);
    const a2 = await connect(url);
    const b1 = await connect(url);
    const b2 = await connect(url);
    clients.push(a1, a2, b1, b2);

    send(a1, { type: 'join', syncGroup: 'alpha' });
    send(a2, { type: 'join', syncGroup: 'alpha' });
    send(b1, { type: 'join', syncGroup: 'beta' });
    send(b2, { type: 'join', syncGroup: 'beta' });
    await tick();

    // Send from a1 and b1 simultaneously
    const a2Received = collectMessages(a2, 1);
    const b2Received = collectMessages(b2, 1);

    send(a1, { type: 'heartbeat', displayId: 'a1' });
    send(b1, { type: 'heartbeat', displayId: 'b1' });

    const [msgA] = await a2Received;
    const [msgB] = await b2Received;

    expect(msgA.displayId).toBe('a1');
    expect(msgB.displayId).toBe('b1');
  });

  it('should use default group when syncGroup is empty', async () => {
    const url = await setup();
    const a = await connect(url);
    const b = await connect(url);
    clients.push(a, b);

    // Join with empty syncGroup — should get "default"
    send(a, { type: 'join', syncGroup: '' });
    send(b, { type: 'join', syncGroup: '' });
    await tick();

    const bReceived = collectMessages(b, 1);
    send(a, { type: 'heartbeat', displayId: 'a' });

    const [msg] = await bReceived;
    expect(msg.displayId).toBe('a');
  });

  it('should reject non-/sync upgrade paths', async () => {
    const relay = await createRelay();
    server = relay.server;
    wss = relay.wss;

    const { port } = server.address();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    clients.push(ws);

    await new Promise((resolve) => {
      ws.on('error', resolve);
      ws.on('close', resolve);
    });

    expect(ws.readyState).toBeGreaterThanOrEqual(2); // CLOSING or CLOSED
  });
});
