// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * @xiboplayer/proxy/hardware — Shared GPU detection and memory tuning
 *
 * Used by both Electron (import directly) and Chromium (via CLI bridge).
 * Reads /sys/class/drm to detect GPUs, selects the best one, and
 * provides adaptive memory tuning based on available RAM.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export const GPU_VENDORS = {
  '0x10de': { name: 'nvidia', label: 'NVIDIA', rank: 3, vaDriver: 'nvidia' },
  '0x1002': { name: 'amd', label: 'AMD', rank: 2, vaDriver: 'radeonsi' },
  '0x8086': { name: 'intel', label: 'Intel', rank: 1, vaDriver: 'iHD' },
};

/**
 * Detect all GPUs via /sys/class/drm.
 * @returns {Array<{card: string, vendor: string, device: string, driver: string, renderNode: string, hasDisplay: boolean, name: string, label: string, rank: number, vaDriver: string|null}>}
 */
export function detectGPUs() {
  const gpus = [];
  try {
    const drmEntries = fs.readdirSync('/sys/class/drm');
    const cards = drmEntries.filter(d => /^card\d+$/.test(d));
    for (const card of cards) {
      const devPath = `/sys/class/drm/${card}/device`;
      let vendor, device, driver;
      try {
        vendor = fs.readFileSync(`${devPath}/vendor`, 'utf8').trim();
        device = fs.readFileSync(`${devPath}/device`, 'utf8').trim();
      } catch (_) { continue; }
      try {
        driver = path.basename(fs.readlinkSync(`${devPath}/driver`));
      } catch (_) { driver = 'unknown'; }

      const cardRealPath = fs.realpathSync(devPath);
      let renderNode = null;
      for (const rn of drmEntries.filter(d => d.startsWith('renderD'))) {
        try {
          if (fs.realpathSync(`/sys/class/drm/${rn}/device`) === cardRealPath) {
            renderNode = `/dev/dri/${rn}`;
            break;
          }
        } catch (_) {}
      }
      if (!renderNode) continue;

      const hasDisplay = drmEntries.some(d =>
        d.startsWith(`${card}-`) && /-(DP|HDMI|eDP|VGA|DVI|DSI|LVDS)/.test(d)
      );

      const info = GPU_VENDORS[vendor] || { name: 'unknown', label: vendor, rank: 0, vaDriver: null };
      gpus.push({ card, vendor, device, driver, renderNode, hasDisplay, ...info });
    }
  } catch (_) {}
  return gpus;
}

/**
 * Select the best GPU from detected list.
 * On hybrid systems, prefers the GPU with display connectors.
 * @param {Array} gpus - From detectGPUs()
 * @param {string} [preference='auto'] - 'auto', 'nvidia', 'intel', 'amd', or '/dev/dri/renderDNNN'
 */
export function selectGPU(gpus, preference) {
  if (!preference || preference === 'auto') {
    const displayGPUs = gpus.filter(g => g.hasDisplay);
    const renderOnly = gpus.filter(g => !g.hasDisplay);
    if (displayGPUs.length > 0 && renderOnly.length > 0) {
      return [...displayGPUs].sort((a, b) => b.rank - a.rank)[0];
    }
    return [...gpus].sort((a, b) => b.rank - a.rank)[0] || null;
  }
  if (preference.startsWith('/dev/dri/')) {
    return gpus.find(g => g.renderNode === preference) || null;
  }
  return gpus.find(g => g.name === preference.toLowerCase()) || null;
}

/**
 * Adaptive memory tuning — scale V8 heap and raster threads to hardware.
 * @returns {{totalRAM_GB: number, cpuCount: number, maxOldSpaceMB: number, rasterThreads: number}}
 */
export function getMemoryTuning() {
  const totalRAM_GB = Math.round(os.totalmem() / (1024 ** 3));
  const cpuCount = os.cpus().length;
  let maxOldSpaceMB, rasterThreads;

  if (totalRAM_GB <= 1) {
    maxOldSpaceMB = 128; rasterThreads = 1;
  } else if (totalRAM_GB <= 2) {
    maxOldSpaceMB = 192; rasterThreads = 2;
  } else if (totalRAM_GB <= 4) {
    maxOldSpaceMB = 256; rasterThreads = Math.min(cpuCount, 2);
  } else if (totalRAM_GB <= 8) {
    maxOldSpaceMB = 512; rasterThreads = Math.min(cpuCount, 4);
  } else {
    maxOldSpaceMB = 768; rasterThreads = Math.min(cpuCount, 4);
  }

  return { totalRAM_GB, cpuCount, maxOldSpaceMB, rasterThreads };
}

/**
 * Generate Chromium/Electron GPU and memory flags.
 * This is the single source of truth — both Electron and Chromium should use this.
 *
 * @param {object} [options]
 * @param {string} [options.gpuPreference='auto'] - GPU selection preference
 * @returns {{gpu: object|null, memory: object, flags: string[], env: object}}
 */
export function getHardwareConfig(options = {}) {
  const gpus = detectGPUs();
  const gpu = gpus.length > 0 ? selectGPU(gpus, options.gpuPreference) : null;
  const memory = getMemoryTuning();

  const flags = [
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    `--num-raster-threads=${memory.rasterThreads}`,
    `--js-flags=--max-old-space-size=${memory.maxOldSpaceMB}`,
    '--enable-features=CanvasOopRasterization,VaapiVideoDecoder,VaapiVideoEncoder',
    '--disable-gpu-watchdog',
    '--disable-background-timer-throttling',
  ];

  const env = {};

  if (gpu) {
    flags.push(`--render-node-override=${gpu.renderNode}`);
    if (gpu.vaDriver) {
      env.LIBVA_DRIVER_NAME = gpu.vaDriver;
    }
  }

  return {
    gpus,
    gpu,
    memory,
    flags,
    env,
  };
}
