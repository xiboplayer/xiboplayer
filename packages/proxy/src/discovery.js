// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * mDNS sync discovery — advertise/discover sync leads on the LAN.
 * Uses bonjour-service (pure JS, zero native deps).
 */

import os from 'os';
import { Bonjour } from 'bonjour-service';

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
