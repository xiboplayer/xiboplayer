// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Sync relay — end-to-end integration scenarios
 *
 * Complements `sync-relay.test.js` (which already tests group isolation
 * and disconnect cleanup with a real HTTP server + ws clients) by
 * covering the scenarios that only surface at the full-system layer:
 *
 *   1. Token authentication — rejects bad tokens, accepts good ones
 *   2. Disconnect → reconnect → rejoin group flow (mirrors what
 *      WebSocketTransport does on network blips in production)
 *   3. Multi-client coordination round-trip simulating the SyncManager
 *      layout-prepare-request → layout-prepare-ready → layout-show
 *      protocol at the transport layer (message routing correctness
 *      under realistic N-follower load)
 *
 * OPT-IN: this file uses the `.integration.test.*` suffix and is
 * excluded from the default `pnpm test` run at the root vitest config
 * (integration tests boot real servers + open real sockets). Run via
 * `pnpm test:integration` at the monorepo root.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachSyncRelay } from './sync-relay.js';

// ── Helpers (duplicated from sync-relay.test.js; the two files don't
//    share a setup module on purpose so either can run standalone) ──

function createRelay(opts = {}) {
  const server = http.createServer();
  const wss = attachSyncRelay(server, opts);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, wss, url: `ws://127.0.0.1:${port}/sync` });
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function expectCloseWithin(ws, ms = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Socket still open after ${ms}ms`)),
      ms,
    );
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function collectMessages(ws, count, { filter } = {}) {
  const msgs = [];
  return new Promise((resolve) => {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data);
      if (filter && !filter(parsed)) return;
      msgs.push(parsed);
      if (msgs.length >= count) resolve(msgs);
    });
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ── Tests ────────────────────────────────────────────────────────

describe('SyncRelay — integration', () => {
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

  async function setup(opts) {
    const relay = await createRelay(opts);
    server = relay.server;
    wss = relay.wss;
    return relay.url;
  }

  // ── Token authentication ─────────────────────────────────────────

  describe('token authentication', () => {
    it('rejects a join that omits the token when a secret is set', async () => {
      const url = await setup({ secret: 'deadbeef' });
      const ws = await connect(url);
      clients.push(ws);

      // Join without token — relay must close the socket with 4001.
      send(ws, { type: 'join', syncGroup: 'wall-1' });
      const code = await expectCloseWithin(ws, 1000);
      expect(code).toBe(4001);
    });

    it('rejects a join with a wrong token', async () => {
      const url = await setup({ secret: 'deadbeef' });
      const ws = await connect(url);
      clients.push(ws);

      send(ws, { type: 'join', syncGroup: 'wall-1', token: 'feedface' });
      const code = await expectCloseWithin(ws, 1000);
      expect(code).toBe(4001);
    });

    it('accepts a join with the correct token', async () => {
      const url = await setup({ secret: 'deadbeef' });
      const a = await connect(url);
      const b = await connect(url);
      clients.push(a, b);

      send(a, { type: 'join', syncGroup: 'wall-1', token: 'deadbeef' });
      send(b, { type: 'join', syncGroup: 'wall-1', token: 'deadbeef' });
      await tick();

      // Routing works => auth succeeded.
      const received = collectMessages(b, 1, {
        filter: (m) => m.type === 'heartbeat',
      });
      send(a, {
        type: 'heartbeat',
        displayId: 'a',
        token: 'deadbeef',
      });
      const [msg] = await received;
      expect(msg.type).toBe('heartbeat');
    });

    it('does not require tokens when no secret is configured', async () => {
      const url = await setup();
      const a = await connect(url);
      const b = await connect(url);
      clients.push(a, b);

      send(a, { type: 'join', syncGroup: 'wall-1' });
      send(b, { type: 'join', syncGroup: 'wall-1' });
      await tick();

      const received = collectMessages(b, 1, {
        filter: (m) => m.type === 'heartbeat',
      });
      send(a, { type: 'heartbeat', displayId: 'a' });
      const [msg] = await received;
      expect(msg.type).toBe('heartbeat');
    });
  });

  // ── Reconnect flow ───────────────────────────────────────────────

  describe('reconnect flow', () => {
    it('restores group membership on rejoin after disconnect', async () => {
      const url = await setup();

      // Initial membership: a + b in wall-1
      const a = await connect(url);
      const b = await connect(url);
      clients.push(a, b);

      send(a, { type: 'join', syncGroup: 'wall-1', displayId: 'a' });
      send(b, { type: 'join', syncGroup: 'wall-1', displayId: 'b' });
      await tick();

      // b drops
      b.close();
      await tick(80);

      // Replacement b' reconnects and rejoins the SAME group
      const b2 = await connect(url);
      clients.push(b2);
      send(b2, { type: 'join', syncGroup: 'wall-1', displayId: 'b' });
      await tick();

      // a → b2 messages must route again
      const received = collectMessages(b2, 1, {
        filter: (m) => m.type === 'layout-change',
      });
      send(a, { type: 'layout-change', layoutId: '100', displayId: 'a' });
      const [msg] = await received;
      expect(msg.layoutId).toBe('100');
    });
  });

  // ── Multi-client layout coordination round-trip ──────────────────

  describe('layout coordination protocol', () => {
    it('routes lead → 3 followers → lead round-trip without cross-talk', async () => {
      const url = await setup();
      const lead = await connect(url);
      const f1 = await connect(url);
      const f2 = await connect(url);
      const f3 = await connect(url);
      clients.push(lead, f1, f2, f3);

      // Everyone joins the same group
      for (const [ws, id] of [[lead, 'lead'], [f1, 'f1'], [f2, 'f2'], [f3, 'f3']]) {
        send(ws, { type: 'join', syncGroup: 'wall-1', displayId: id });
      }
      await tick();

      // Each follower collects the lead's PREPARE request exactly once
      const f1Prep = collectMessages(f1, 1, {
        filter: (m) => m.type === 'layout-prepare-request',
      });
      const f2Prep = collectMessages(f2, 1, {
        filter: (m) => m.type === 'layout-prepare-request',
      });
      const f3Prep = collectMessages(f3, 1, {
        filter: (m) => m.type === 'layout-prepare-request',
      });

      send(lead, {
        type: 'layout-prepare-request',
        layoutId: '42',
        displayId: 'lead',
      });

      const [m1] = await f1Prep;
      const [m2] = await f2Prep;
      const [m3] = await f3Prep;

      expect(m1.layoutId).toBe('42');
      expect(m2.layoutId).toBe('42');
      expect(m3.layoutId).toBe('42');

      // Lead must NOT receive its own prepare-request (no echo-back).
      // Then each follower reports READY, and lead collects all three.
      const leadReady = collectMessages(lead, 3, {
        filter: (m) => m.type === 'layout-prepare-ready',
      });

      send(f1, {
        type: 'layout-prepare-ready',
        layoutId: '42',
        displayId: 'f1',
      });
      send(f2, {
        type: 'layout-prepare-ready',
        layoutId: '42',
        displayId: 'f2',
      });
      send(f3, {
        type: 'layout-prepare-ready',
        layoutId: '42',
        displayId: 'f3',
      });

      const readyMsgs = await leadReady;
      const ids = new Set(readyMsgs.map((m) => m.displayId));
      expect(ids).toEqual(new Set(['f1', 'f2', 'f3']));

      // Finally, lead dispatches SHOW and followers receive it
      const f1Show = collectMessages(f1, 1, {
        filter: (m) => m.type === 'layout-show',
      });
      const f2Show = collectMessages(f2, 1, {
        filter: (m) => m.type === 'layout-show',
      });
      const f3Show = collectMessages(f3, 1, {
        filter: (m) => m.type === 'layout-show',
      });

      send(lead, {
        type: 'layout-show',
        layoutId: '42',
        displayId: 'lead',
      });

      const [s1] = await f1Show;
      const [s2] = await f2Show;
      const [s3] = await f3Show;
      expect(s1.layoutId).toBe('42');
      expect(s2.layoutId).toBe('42');
      expect(s3.layoutId).toBe('42');
    });

    it('does not cross-route layout-show between groups', async () => {
      const url = await setup();
      const leadA = await connect(url);
      const followerA = await connect(url);
      const leadB = await connect(url);
      const followerB = await connect(url);
      clients.push(leadA, followerA, leadB, followerB);

      send(leadA, { type: 'join', syncGroup: 'wall-A', displayId: 'leadA' });
      send(followerA, { type: 'join', syncGroup: 'wall-A', displayId: 'fA' });
      send(leadB, { type: 'join', syncGroup: 'wall-B', displayId: 'leadB' });
      send(followerB, { type: 'join', syncGroup: 'wall-B', displayId: 'fB' });
      await tick();

      let fBReceivedShow = false;
      followerB.on('message', (data) => {
        const m = JSON.parse(data);
        if (m.type === 'layout-show') fBReceivedShow = true;
      });

      const fAShow = collectMessages(followerA, 1, {
        filter: (m) => m.type === 'layout-show',
      });

      send(leadA, { type: 'layout-show', layoutId: '99', displayId: 'leadA' });

      const [msg] = await fAShow;
      expect(msg.layoutId).toBe('99');

      // Give the relay a generous window to rule out delayed leakage.
      await tick(150);
      expect(fBReceivedShow).toBe(false);
    });
  });
});
