// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * @xiboplayer/proxy/hardware — ESM wrapper around the CJS source of truth.
 *
 * Implementation lives in `./hardware.cjs` (required by Electron's CJS
 * main process directly). This file re-exports from there so existing
 * ESM consumers (proxy.js, bin/detect-hardware.js, @xiboplayer/proxy's
 * index.js) keep working unchanged.
 *
 * Rationale (#324): we need ONE place for the GPU detection logic.
 * Duplicating it in Electron wastes effort and drifts. The CJS side
 * has to be the source of truth because Electron's main process is
 * CJS; ESM consumers get a trivial wrapper here.
 *
 * @see hardware.cjs — actual implementation
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjs = require('./hardware.cjs');

export const GPU_VENDORS = cjs.GPU_VENDORS;
export const detectGPUs = cjs.detectGPUs;
export const selectGPU = cjs.selectGPU;
export const getMemoryTuning = cjs.getMemoryTuning;
export const getHardwareConfig = cjs.getHardwareConfig;
