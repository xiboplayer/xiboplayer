#!/usr/bin/env node
/**
 * xiboplayer-relay CLI — standalone WebSocket sync relay
 *
 * Runs a lightweight HTTP + WebSocket server that relays sync messages
 * between xiboplayer displays on a LAN. Displays connect via WebSocket
 * to /sync and are isolated by sync group.
 *
 * Usage:
 *   xiboplayer-relay --port=9590
 *   npx @xiboplayer/proxy relay --port=9590
 */

import http from 'node:http';
import { attachSyncRelay } from '../src/sync-relay.js';

const args = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 9590;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: 'xiboplayer-relay', status: 'ok' }));
});

attachSyncRelay(server);

server.listen(port, () => {
  console.log(`Sync relay listening on ws://0.0.0.0:${port}/sync`);
});
