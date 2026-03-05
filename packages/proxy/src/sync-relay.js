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
 * @returns {WebSocketServer} the wss instance (for testing / inspection)
 */
export function attachSyncRelay(server) {
  const wss = new WebSocketServer({ noServer: true });

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

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      // Broadcast to all OTHER connected clients
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === 1 /* OPEN */) {
          client.send(data);
        }
      }
    });

    ws.on('close', () => {
      log.info(`Client disconnected: ${addr} (${wss.clients.size} remaining)`);
    });
  });

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
