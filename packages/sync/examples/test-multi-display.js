#!/usr/bin/env node
/**
 * Multi-Display Sync Demo — test all sync features locally
 *
 * Starts a relay + simulates 4 displays in a 2×2 grid with choreography.
 * Demonstrates: group isolation, wall mode (layoutMap), topology,
 * auto-detected totalDisplays, and transition choreography.
 *
 * Usage:
 *   node packages/sync/examples/test-multi-display.js
 *
 * What it does:
 *   1. Starts a standalone relay on port 9590
 *   2. Creates 4 SyncManager instances (1 lead + 3 followers)
 *   3. All join group "lobby" with 2×2 topology
 *   4. Lead requests layout changes — followers sync
 *   5. Choreography staggers are computed and logged
 *   6. Wall mode maps lead's layout to position-specific layouts
 */

import http from 'node:http';
import { attachSyncRelay } from '../../proxy/src/sync-relay.js';
import { SyncManager } from '../src/sync-manager.js';
import { WebSocketTransport } from '../src/ws-transport.js';
import { computeStagger } from '../src/choreography.js';

const PORT = 9590;
const RELAY_URL = `ws://127.0.0.1:${PORT}/sync`;

// ── Display configs ──────────────────────────────────────────────
const displays = [
  {
    id: 'display-lead',
    isLead: true,
    topology: { x: 0, y: 0, orientation: 0 },
    layoutMap: null, // lead plays the original layout
  },
  {
    id: 'display-top-right',
    isLead: false,
    topology: { x: 1, y: 0, orientation: 0 },
    layoutMap: { '100': 201 }, // wall mode: lead's 100 → this display's 201
  },
  {
    id: 'display-bottom-left',
    isLead: false,
    topology: { x: 0, y: 1, orientation: 90 }, // portrait totem
    layoutMap: { '100': 202 },
  },
  {
    id: 'display-bottom-right',
    isLead: false,
    topology: { x: 1, y: 1, orientation: 0 },
    layoutMap: { '100': 203 },
  },
];

const CHOREOGRAPHY = 'diagonal-tl';
const STAGGER_MS = 200;
const GRID_COLS = 2;
const GRID_ROWS = 2;

// ── Start relay ──────────────────────────────────────────────────
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ service: 'test-relay', status: 'ok' }));
});
attachSyncRelay(server);

server.listen(PORT, async () => {
  console.log(`\n🔄 Relay running on ws://127.0.0.1:${PORT}/sync\n`);

  // Wait for server to be ready
  await sleep(200);

  // ── Create SyncManagers ──────────────────────────────────────
  const managers = [];

  for (const display of displays) {
    const syncConfig = {
      syncGroup: 'lobby',
      syncPublisherPort: PORT,
      syncSwitchDelay: 500,
      syncVideoPauseDelay: 100,
      isLead: display.isLead,
      relayUrl: RELAY_URL,
      topology: display.topology,
      layoutMap: display.layoutMap,
      choreography: CHOREOGRAPHY,
      staggerMs: STAGGER_MS,
      gridCols: GRID_COLS,
      gridRows: GRID_ROWS,
    };

    const transport = new WebSocketTransport(RELAY_URL, {
      syncGroup: 'lobby',
      displayId: display.id,
      topology: display.topology,
    });

    const manager = new SyncManager({
      displayId: display.id,
      syncConfig,
      transport,
      onLayoutChange: (layoutId) => {
        // Wall mode: map lead's layout to position-specific
        const mapped = display.layoutMap?.[layoutId] ?? layoutId;
        const tag = mapped !== layoutId ? ` (wall: ${layoutId}→${mapped})` : '';
        console.log(`  📺 ${display.id}: Loading layout ${mapped}${tag}`);

        // Simulate load time
        setTimeout(() => {
          manager.reportReady(layoutId);
          console.log(`  ✅ ${display.id}: Ready`);
        }, 100 + Math.random() * 200);
      },
      onLayoutShow: (layoutId) => {
        const stagger = computeStagger({
          choreography: CHOREOGRAPHY,
          topology: display.topology,
          gridCols: GRID_COLS,
          gridRows: GRID_ROWS,
          staggerMs: STAGGER_MS,
        });
        console.log(`  🎬 ${display.id}: Show layout ${layoutId} (delay: ${stagger}ms, ${CHOREOGRAPHY})`);
      },
      onVideoStart: (layoutId, regionId) => {
        console.log(`  ▶️  ${display.id}: Video start in layout ${layoutId} region ${regionId}`);
      },
      onGroupUpdate: (totalDisplays, topology) => {
        console.log(`  📡 ${display.id}: Group update — ${totalDisplays} displays, topology:`, JSON.stringify(topology));
      },
    });

    manager.start();
    managers.push({ display, manager });
    console.log(`${display.isLead ? '👑' : '👤'} ${display.id} joined (${display.topology.x},${display.topology.y}) orientation=${display.topology.orientation ?? 0}°`);
    await sleep(300);
  }

  console.log('\n--- All displays connected ---\n');
  await sleep(500);

  // ── Show choreography stagger table ────────────────────────
  console.log(`\n📊 Choreography: ${CHOREOGRAPHY} (${STAGGER_MS}ms stagger)`);
  console.log('┌─────────────────────────┬──────────┬──────────┐');
  console.log('│ Display                 │ Position │ Delay    │');
  console.log('├─────────────────────────┼──────────┼──────────┤');
  for (const { display } of managers) {
    const stagger = computeStagger({
      choreography: CHOREOGRAPHY,
      topology: display.topology,
      gridCols: GRID_COLS,
      gridRows: GRID_ROWS,
      staggerMs: STAGGER_MS,
    });
    console.log(`│ ${display.id.padEnd(23)} │ (${display.topology.x},${display.topology.y})    │ ${String(stagger).padStart(4)}ms   │`);
  }
  console.log('└─────────────────────────┴──────────┴──────────┘\n');

  // ── Lead requests layout change ────────────────────────────
  const lead = managers.find(m => m.display.isLead);

  console.log('🚀 Lead requesting layout 100 (wall mode: each display maps to its own layout)...\n');
  await lead.manager.requestLayoutChange(100);
  console.log('\n✅ Layout 100 shown across all displays!\n');

  await sleep(1000);

  console.log('🚀 Lead requesting layout 200 (mirror mode: all show same layout)...\n');
  await lead.manager.requestLayoutChange(200);
  console.log('\n✅ Layout 200 shown across all displays!\n');

  await sleep(500);

  // ── Show other choreography patterns ──────────────────────
  console.log('\n📊 All choreography patterns for this 2×2 grid:\n');
  const patterns = ['simultaneous', 'wave-right', 'wave-left', 'wave-down', 'wave-up',
    'diagonal-tl', 'diagonal-tr', 'diagonal-bl', 'diagonal-br',
    'center-out', 'outside-in'];

  for (const pattern of patterns) {
    const delays = displays.map(d => computeStagger({
      choreography: pattern,
      topology: d.topology,
      gridCols: GRID_COLS,
      gridRows: GRID_ROWS,
      staggerMs: STAGGER_MS,
    }));
    const grid = `(0,0)=${delays[0]}ms  (1,0)=${delays[1]}ms  |  (0,1)=${delays[2]}ms  (1,1)=${delays[3]}ms`;
    console.log(`  ${pattern.padEnd(14)} → ${grid}`);
  }

  // ── Cleanup ────────────────────────────────────────────────
  console.log('\n🧹 Cleaning up...');
  for (const { manager } of managers) {
    manager.stop();
  }
  server.close();
  console.log('Done.\n');
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
