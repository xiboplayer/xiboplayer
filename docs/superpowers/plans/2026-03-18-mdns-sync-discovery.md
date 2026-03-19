# mDNS Sync Discovery Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover sync lead IP via mDNS so followers connect without manual DB workarounds.

**Architecture:** New `discovery.js` module in `@xiboplayer/proxy` wraps `bonjour-service` for advertise/discover. Two new HTTP endpoints expose LAN IP and lead discovery to the browser-based PWA. Existing CMS-provided IP is the fallback if mDNS fails.

**Tech Stack:** `bonjour-service` (pure JS mDNS), Express routes, `os.networkInterfaces()`

**Spec:** `docs/superpowers/specs/2026-03-18-mdns-sync-discovery-design.md`
**Branch:** `feat/mdns-sync-discovery`
**Issue:** #275 | **PR:** #276

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/proxy/src/discovery.js` | Create | `advertiseSyncService()` + `discoverSyncLead()` + `getLanIp()` |
| `packages/proxy/src/discovery.test.js` | Create | Unit tests for advertise, discover, group filtering, timeout, getLanIp |
| `packages/proxy/src/proxy.js` | Modify | Add `GET /system/lan-ip` + `GET /system/discover-lead` routes; advertise on lead startup |
| `packages/proxy/package.json` | Modify | Add `bonjour-service` dependency |
| `packages/core/src/player-core.js` | Modify | `discoverLanIp()` fallback to `fetch('/system/lan-ip')` |
| `packages/pwa/src/main.ts` | Modify | Call `/system/discover-lead` before building relayUrl |

---

### Task 1: Add `bonjour-service` dependency

**Files:**
- Modify: `packages/proxy/package.json`

- [ ] **Step 1: Install bonjour-service**

```bash
cd /home/pau/Devel/tecman/xibo-players/xiboplayer
pnpm --filter @xiboplayer/proxy add bonjour-service
```

- [ ] **Step 2: Verify it installed**

Run: `cat packages/proxy/package.json | grep bonjour`
Expected: `"bonjour-service": "^1.x.x"` in dependencies

- [ ] **Step 3: Commit**

```bash
git add packages/proxy/package.json pnpm-lock.yaml
git commit -m "chore: add bonjour-service dependency to proxy package"
```

---

### Task 2: Create `discovery.js` with `getLanIp`, `advertiseSyncService`, `discoverSyncLead`

**Files:**
- Create: `packages/proxy/src/discovery.js`
- Create: `packages/proxy/src/discovery.test.js`

- [ ] **Step 1: Write failing tests for `getLanIp`**

Create `packages/proxy/src/discovery.test.js`:

```javascript
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
import { describe, it, expect } from 'vitest';
import { getLanIp } from './discovery.js';

describe('getLanIp', () => {
  it('should return a non-empty IPv4 string', () => {
    const ip = getLanIp();
    expect(ip).toBeTruthy();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('should not return a loopback address', () => {
    const ip = getLanIp();
    expect(ip).not.toBe('127.0.0.1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @xiboplayer/proxy test -- discovery.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write `getLanIp` implementation**

Create `packages/proxy/src/discovery.js`:

```javascript
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * mDNS sync discovery — advertise/discover sync leads on the LAN.
 * Uses bonjour-service (pure JS, zero native deps).
 */

import os from 'os';
import Bonjour from 'bonjour-service';

const SERVICE_TYPE = 'xibo-sync';

// Interface name prefixes to skip (Docker, VPN, bridges)
const SKIP_IFACE_PREFIXES = ['docker', 'br-', 'veth', 'virbr', 'tun', 'tap'];

/**
 * Get the first non-internal, non-Docker IPv4 address.
 * @returns {string} LAN IP or empty string
 */
export function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (SKIP_IFACE_PREFIXES.some((p) => name.startsWith(p))) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xiboplayer/proxy test -- discovery.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing tests for `advertiseSyncService` and `discoverSyncLead`**

Append to `packages/proxy/src/discovery.test.js`:

```javascript
import { advertiseSyncService, discoverSyncLead } from './discovery.js';

describe('advertiseSyncService + discoverSyncLead', () => {
  it('should advertise and discover a sync service by syncGroupId', async () => {
    const ad = advertiseSyncService({ port: 19590, syncGroupId: '99', displayId: 'test-lead' });

    try {
      const result = await discoverSyncLead({ syncGroupId: '99', timeout: 5000 });
      expect(result).toBeTruthy();
      expect(result.port).toBe(19590);
      expect(result.host).toBeTruthy();
    } finally {
      ad.stop();
    }
  });

  it('should filter by syncGroupId — wrong group returns null', async () => {
    const ad = advertiseSyncService({ port: 19591, syncGroupId: '100', displayId: 'test-lead-2' });

    try {
      const result = await discoverSyncLead({ syncGroupId: '999', timeout: 2000 });
      expect(result).toBeNull();
    } finally {
      ad.stop();
    }
  });

  it('should return null on timeout when no service is advertised', async () => {
    const result = await discoverSyncLead({ syncGroupId: '777', timeout: 1000 });
    expect(result).toBeNull();
  });

  it('should stop advertising when stop() is called', async () => {
    const ad = advertiseSyncService({ port: 19592, syncGroupId: '101', displayId: 'test-lead-3' });
    ad.stop();

    // Give mDNS time to process the de-advertisement
    await new Promise((r) => setTimeout(r, 500));

    const result = await discoverSyncLead({ syncGroupId: '101', timeout: 2000 });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm --filter @xiboplayer/proxy test -- discovery.test.js`
Expected: FAIL — functions not exported

- [ ] **Step 7: Write `advertiseSyncService` and `discoverSyncLead`**

Add to `packages/proxy/src/discovery.js`:

```javascript
/**
 * Advertise this player as a sync lead via mDNS.
 *
 * @param {Object} opts
 * @param {number} opts.port - WebSocket relay port (e.g. 9590)
 * @param {string} opts.syncGroupId - CMS sync group identifier
 * @param {string} opts.displayId - Lead's hardware key
 * @returns {{ stop: () => void }}
 */
export function advertiseSyncService({ port, syncGroupId, displayId }) {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `xibo-sync-${syncGroupId}`,
    type: SERVICE_TYPE,
    port,
    txt: { syncGroupId: String(syncGroupId), displayId: String(displayId) },
  });

  return {
    stop() {
      service.stop(() => {});
      bonjour.destroy();
    },
  };
}

/**
 * Discover a sync lead on the LAN by syncGroupId.
 *
 * @param {Object} opts
 * @param {string} opts.syncGroupId - CMS sync group to find
 * @param {number} [opts.timeout=10000] - Max ms to wait
 * @returns {Promise<{ host: string, port: number } | null>}
 */
export function discoverSyncLead({ syncGroupId, timeout = 10000 }) {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    let resolved = false;

    const browser = bonjour.find({ type: SERVICE_TYPE }, (service) => {
      if (resolved) return;
      const txt = service.txt || {};
      if (String(txt.syncGroupId) === String(syncGroupId)) {
        resolved = true;
        browser.stop();
        bonjour.destroy();
        // service.addresses contains IPs; prefer IPv4
        const host = (service.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
          || service.host;
        resolve({ host, port: service.port });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        browser.stop();
        bonjour.destroy();
        resolve(null);
      }
    }, timeout);
  });
}
```

- [ ] **Step 8: Run tests to verify all pass**

Run: `pnpm --filter @xiboplayer/proxy test -- discovery.test.js`
Expected: PASS (6 tests)

- [ ] **Step 9: Commit**

```bash
git add packages/proxy/src/discovery.js packages/proxy/src/discovery.test.js
git commit -m "feat: add mDNS discovery module (advertise + discover + getLanIp)"
```

---

### Task 3: Add `GET /system/lan-ip` and `GET /system/discover-lead` routes to proxy

**Files:**
- Modify: `packages/proxy/src/proxy.js:21-23` (imports)
- Modify: `packages/proxy/src/proxy.js:185` area (add routes after POST /config block)
- Modify: `packages/proxy/src/proxy.js:1109` (startServer — advertise on lead startup)

- [ ] **Step 1: Add import of discovery module**

In `packages/proxy/src/proxy.js`, after line 23 (`import { attachSyncRelay }`), add:

```javascript
import { getLanIp, advertiseSyncService, discoverSyncLead } from './discovery.js';
```

- [ ] **Step 2: Add `GET /system/lan-ip` route**

In `createProxyApp()`, after the `POST /config` block (around line 230), add:

```javascript
  // ─── GET /system/lan-ip — return this machine's LAN IPv4 ────
  app.get('/system/lan-ip', (_req, res) => {
    const ip = getLanIp();
    if (ip) {
      res.json({ ip });
    } else {
      res.status(404).json({ error: 'No LAN IP detected' });
    }
  });
```

- [ ] **Step 3: Add `GET /system/discover-lead` route**

Right after the lan-ip route:

```javascript
  // ─── GET /system/discover-lead — mDNS browse for sync lead ────
  app.get('/system/discover-lead', async (req, res) => {
    const { syncGroupId } = req.query;
    if (!syncGroupId) return res.status(400).json({ error: 'syncGroupId is required' });

    const result = await discoverSyncLead({ syncGroupId: String(syncGroupId), timeout: 10000 });
    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'Lead not found via mDNS' });
    }
  });
```

- [ ] **Step 4: Add mDNS advertisement to `startServer()` for leads**

In `startServer()` (line 1109), add `syncGroupId` and `isLead` to the destructured options. After `attachSyncRelay(server, { secret: syncSecret })` (line 1119), add:

```javascript
      // Advertise sync relay via mDNS if this is a lead
      if (isLead && syncGroupId) {
        const syncPort = port; // relay listens on same port as HTTP
        advertiseSyncService({ port: syncPort, syncGroupId: String(syncGroupId), displayId: displayId || 'unknown' });
        logServer.info(`mDNS: advertising sync group ${syncGroupId} on port ${syncPort}`);
      }
```

Update the `startServer` signature to include the new params:

```javascript
export function startServer({ port = 8765, listenAddress = 'localhost', pwaPath, appVersion = '0.0.0', pwaConfig, configFilePath, dataDir, onLog, icHandler, allowShellCommands = false, relaxSslCerts = true, syncSecret, syncGroupId, isLead, displayId } = {}) {
```

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add packages/proxy/src/proxy.js
git commit -m "feat: add /system/lan-ip and /system/discover-lead proxy routes"
```

---

### Task 4: Update `discoverLanIp()` in player-core.js to fall back to proxy endpoint

**Files:**
- Modify: `packages/core/src/player-core.js:56-65`

- [ ] **Step 1: Update `discoverLanIp()` with fetch fallback**

Replace the function at line 60-65:

```javascript
async function discoverLanIp() {
  // Electron: native os.networkInterfaces() via preload
  if (typeof window !== 'undefined' && window.electronAPI?.getLanIpAddress) {
    try { return await window.electronAPI.getLanIpAddress(); } catch (_) {}
  }
  // Chromium/browser: ask the proxy server (Node.js has os.networkInterfaces())
  try {
    const res = await globalThis.__nativeFetch('/system/lan-ip');
    if (res.ok) {
      const { ip } = await res.json();
      if (ip) return ip;
    }
  } catch (_) {}
  return '';
}
```

Note: Uses `globalThis.__nativeFetch` (set in vitest.setup.js) to bypass the mocked `fetch`. In production, `__nativeFetch` is the real `fetch` since the setup assigns it before mocking.

- [ ] **Step 2: Run core tests**

Run: `pnpm --filter @xiboplayer/core test`
Expected: All tests pass (discoverLanIp returns '' in test env — both branches fail gracefully)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/player-core.js
git commit -m "feat: discoverLanIp falls back to /system/lan-ip for Chromium"
```

---

### Task 5: Update PWA sync-config handler to use mDNS discovery

**Files:**
- Modify: `packages/pwa/src/main.ts:558-568`

- [ ] **Step 1: Add mDNS discovery before building relayUrl**

Replace the relay URL construction block (lines 558-568) with:

```typescript
      // Cross-device sync: build WebSocket relay URL if not explicitly set.
      // Lead connects to its own relay (localhost), followers discover lead via mDNS.
      if (!syncConfig.relayUrl && syncConfig.syncPublisherPort) {
        if (syncConfig.syncGroupId) {
          syncConfig.syncGroup = String(syncConfig.syncGroupId);
        }

        if (syncConfig.isLead) {
          syncConfig.relayUrl = `ws://localhost:${syncConfig.syncPublisherPort}/sync`;
        } else {
          // Try mDNS discovery first, fall back to CMS-provided IP
          let leadHost = syncConfig.syncGroup;
          try {
            const res = await fetch(`/system/discover-lead?syncGroupId=${syncConfig.syncGroupId}`);
            if (res.ok) {
              const { host, port } = await res.json();
              leadHost = host;
              log.info(`mDNS discovered lead at ${host}:${port}`);
            }
          } catch (_) {
            log.warn('mDNS discovery failed, using CMS-provided IP');
          }
          syncConfig.relayUrl = `ws://${leadHost}:${syncConfig.syncPublisherPort}/sync`;
        }
      }
```

Note: The `SYNC_CONFIG` handler needs to become `async` since `fetch` is awaited. Check that the `core.on(E.SYNC_CONFIG, ...)` callback is already async or wrap it.

- [ ] **Step 2: Build PWA to verify TypeScript compiles**

Run: `pnpm --filter @xiboplayer/pwa build`
Expected: Build succeeds

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/pwa/src/main.ts
git commit -m "feat: PWA discovers sync lead via mDNS before CMS IP fallback"
```

---

### Task 6: Update Chromium server.js to pass sync params to startServer

**Files:**
- Modify: `xiboplayer-chromium/xiboplayer/server/server.js` (external repo — if accessible)

This task only applies if working in the Chromium repo. The `startServer()` call needs the new `syncGroupId`, `isLead`, and `displayId` params:

```javascript
const syncGroupId = rawConfig?.sync?.syncGroupId;
const isLead = rawConfig?.sync?.isLead;
const displayId = rawConfig?.hardwareKey;

return startServer({
  port: serverPort,
  listenAddress,
  pwaPath,
  syncSecret,
  syncGroupId,
  isLead,
  displayId,
  // ... other existing params
});
```

- [ ] **Step 1: Update server.js** (in xiboplayer-chromium repo)
- [ ] **Step 2: Test Chromium kiosk with sync lead config**
- [ ] **Step 3: Commit in Chromium repo**

---

### Task 7: Final verification and push

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 2: Build PWA**

Run: `pnpm --filter @xiboplayer/pwa build`
Expected: Build succeeds

- [ ] **Step 3: Push branch**

```bash
git push
```

- [ ] **Step 4: Mark PR as ready for review**

```bash
gh pr ready 276
```
