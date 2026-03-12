// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/xmds - XMDS clients (REST and SOAP)
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { RestClient } from './rest-client.js';
export { XmdsClient } from './xmds-client.js';
export { ProtocolDetector } from './protocol-detector.js';
export { CMS_CLIENT_METHODS, assertCmsClient } from './cms-client.js';
export { parseScheduleResponse } from './schedule-parser.js';
