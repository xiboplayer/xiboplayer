// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/utils - Shared utilities
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { createLogger, setLogLevel, getLogLevel, isDebug, applyCmsLogLevel, mapCmsLogLevel, registerLogSink, unregisterLogSink, LOG_LEVELS } from './logger.js';
export { EventEmitter } from './event-emitter.js';
import { config as _config } from './config.js';
export { config, SHELL_ONLY_KEYS, extractPwaConfig, computeCmsId, fnvHash, warnPlatformMismatch } from './config.js';
export { fetchWithRetry } from './fetch-retry.js';
export { CmsApiClient, CmsApiError } from './cms-api.js';

/**
 * CMS Player API base path — all media, dependencies, and widgets are served
 * under this prefix.
 *
 * Default: '/player/api/v2' (standalone index.php endpoint).
 * Override: set `playerApiBase` in config.json / localStorage, or call
 *           setPlayerApi('/new/path') before route registration (proxy).
 *
 * Browser: reads from config.data.playerApiBase at import time.
 * Node:    call setPlayerApi() before createProxyApp().
 */
const DEFAULT_PLAYER_API = '/player/api/v2';
let _playerApi = _config.data?.playerApiBase || DEFAULT_PLAYER_API;

/** Current Player API base path (no trailing slash). */
export let PLAYER_API = _playerApi;

/** Override the Player API base path at runtime (call before route registration). */
export function setPlayerApi(base) {
  _playerApi = base.replace(/\/+$/, '');
  PLAYER_API = _playerApi;
}
