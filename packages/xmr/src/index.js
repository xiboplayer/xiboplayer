// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/xmr - XMR WebSocket client
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { XmrWrapper } from './xmr-wrapper.js';
