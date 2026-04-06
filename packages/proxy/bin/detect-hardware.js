#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CLI bridge for hardware detection — used by Electron and Chromium's launch-kiosk.sh
// Usage: node detect-hardware.js [--gpu=auto|nvidia|intel|amd|/dev/dri/renderDNNN] [--json]
//
// Output (default): KEY=VALUE pairs for shell eval
// Output (--json):  Full hardware config JSON (gpus, gpu, memory, flags, env)

import { getHardwareConfig } from '../src/hardware.js';

const args = process.argv.slice(2);
const gpuPref = (args.find(a => a.startsWith('--gpu=')) || '').split('=')[1]
  || process.env.XIBO_GPU || 'auto';
const jsonOutput = args.includes('--json');

const hw = getHardwareConfig({ gpuPreference: gpuPref });

if (jsonOutput) {
  console.log(JSON.stringify(hw));
} else {
  const kv = {
    gpu_count: hw.gpus.length,
    gpu_selected: hw.gpu ? hw.gpu.label : 'none',
    gpu_render_node: hw.gpu ? hw.gpu.renderNode : '',
    gpu_va_driver: hw.gpu ? (hw.gpu.vaDriver || '') : '',
    gpu_vendor: hw.gpu ? hw.gpu.name : '',
    gpu_has_display: hw.gpu ? hw.gpu.hasDisplay : false,
    ram_gb: hw.memory.totalRAM_GB,
    cpu_count: hw.memory.cpuCount,
    max_old_space_mb: hw.memory.maxOldSpaceMB,
    raster_threads: hw.memory.rasterThreads,
  };
  for (const [k, v] of Object.entries(kv)) {
    console.log(`${k.toUpperCase()}=${v}`);
  }
}
