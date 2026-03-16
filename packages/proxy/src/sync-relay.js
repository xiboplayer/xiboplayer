// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Sync Relay — WebSocket message relay for cross-device multi-display sync
 *
 * Attaches to an existing HTTP server (noServer mode) and handles WebSocket
 * connections on the /sync path. Every message received from one client is
 * broadcast to all OTHER connected clients (relay/hub pattern).
 *
 * The sync protocol itself (heartbeats, layout-change, layout-ready, etc.)
 * is handled entirely by SyncManager on each client — the relay is just
 * a dumb pipe.
 *
 * Heartbeat: server pings every 30s, expects pong within 10s.
 * Stale clients are terminated to prevent zombie connections.
 */

import { WebSocketServer } from 'ws';
import { createLogger } from '@xiboplayer/utils';

const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;

const log = createLogger('SyncRelay', 'INFO');

/**
 * Attach a WebSocket sync relay to an existing HTTP server.
 *
 * @param {import('http').Server} server — the HTTP server from Express
 * @param {Object} [options]
 * @param {string} [options.secret] — when set, join messages must include a matching token
 * @returns {WebSocketServer} the wss instance (for testing / inspection)
 */
export function attachSyncRelay(server, { secret } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  // Group isolation: Map<groupName, Set<WebSocket>>
  const groups = new Map();

  // Handle HTTP→WebSocket upgrade on /sync path only
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/sync') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Connection handler
  wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress;
    log.info(`Client connected: ${addr} (${wss.clients.size} total)`);
    ws.isAlive = true;
    ws.syncGroup = null; // Set when client sends 'join'

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // Ignore non-JSON
      }

      // Handle join: client declares its sync group and optional topology
      if (parsed.type === 'join') {
        if (secret && parsed.token !== secret) {
          log.warn(`Client ${addr} rejected: invalid token`);
          ws.close(4001, 'Invalid token');
          return;
        }
        const group = parsed.syncGroup || 'default';
        ws.syncGroup = group;
        ws.displayId = parsed.displayId || null;
        ws.topology = parsed.topology || null; // { x, y, orientation? }
        if (!groups.has(group)) groups.set(group, new Set());
        groups.get(group).add(ws);
        log.info(`Client ${addr} joined group "${group}" (${groups.get(group).size} in group)`);
        _broadcastGroupUpdate(groups.get(group));
        return; // Don't broadcast join messages
      }

      // Broadcast to same-group peers only
      const peers = ws.syncGroup ? groups.get(ws.syncGroup) : wss.clients;
      if (!peers) return;
      for (const client of peers) {
        if (client !== ws && client.readyState === 1 /* OPEN */) {
          client.send(data);
        }
      }
    });

    ws.on('close', () => {
      // Remove from group tracking
      if (ws.syncGroup && groups.has(ws.syncGroup)) {
        const group = groups.get(ws.syncGroup);
        group.delete(ws);
        if (group.size === 0) {
          groups.delete(ws.syncGroup);
        } else {
          _broadcastGroupUpdate(group);
        }
      }
      log.info(`Client disconnected: ${addr} (${wss.clients.size} remaining)`);
    });
  });

  // Broadcast group membership update (totalDisplays + topology map)
  function _broadcastGroupUpdate(group) {
    const topology = {};
    for (const client of group) {
      if (client.displayId && client.topology) {
        topology[client.displayId] = client.topology;
      }
    }
    const msg = JSON.stringify({
      type: 'group-update',
      totalDisplays: group.size,
      topology,
    });
    for (const client of group) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(msg);
      }
    }
  }

  // Heartbeat: detect stale connections
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        log.info('Terminating stale client');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_INTERVAL);

  // Clean up when server closes
  wss.on('close', () => {
    clearInterval(pingTimer);
  });

  log.info('Sync relay attached on /sync');
  return wss;
}
