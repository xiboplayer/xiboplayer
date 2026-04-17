// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * CommonJS bridge for `@xiboplayer/proxy/hardware`.
 *
 * Electron's main process loads as CJS; the SDK package is ESM. This
 * bridge lets Electron do:
 *
 *     const { detectGPUs, selectBestGPU, getGpuFlags } =
 *       require('@xiboplayer/proxy/hardware');
 *
 * …without each Electron release duplicating the 200+ lines of
 * detection logic from `hardware.js`.
 *
 * Not yet implemented. The three viable strategies (see #324 for
 * the design conversation) are:
 *
 *   (a) Convert `xiboplayer-electron/src/main.js` to ESM (Electron
 *       28+ supports ESM main-process). Then this file is unneeded.
 *   (b) Build-time compile `hardware.js` to CJS and emit here.
 *   (c) Rewrite `hardware.js` as pure-Node-core CJS and have the
 *       ESM entry wrap it.
 *
 * None are done yet — throw loudly so anyone who adopts this before
 * the rewrite discovers the gap immediately rather than at runtime
 * on a kiosk in the field.
 */
'use strict';

function notImplemented() {
  throw new Error(
    '@xiboplayer/proxy/hardware CJS bridge not implemented yet — ' +
      'see xibo-players/xiboplayer#324. Use the ESM entry via dynamic ' +
      'import from an Electron ESM main, or wait for the rewrite.',
  );
}

module.exports = {
  detectGPUs: notImplemented,
  selectBestGPU: notImplemented,
  getGpuFlags: notImplemented,
  getAdaptiveMemoryFlags: notImplemented,
};
