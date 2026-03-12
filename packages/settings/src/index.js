// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/settings - CMS settings management
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;

/**
 * Settings manager for Xibo Player
 * @module @xiboplayer/settings
 */
export { DisplaySettings } from './settings.js';
