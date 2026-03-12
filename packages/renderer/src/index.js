// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/renderer - Layout rendering
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { RendererLite } from './renderer-lite.js';
export { LayoutPool } from './layout-pool.js';
export { LayoutTranslator } from './layout.js';
