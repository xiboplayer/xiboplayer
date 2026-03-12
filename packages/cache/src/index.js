// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/cache - Offline caching and downloads
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { CacheManager, cacheManager } from './cache.js';
export { StoreClient } from './store-client.js';
export { DownloadManager, FileDownload, LayoutTaskBuilder, BARRIER, isUrlExpired } from './download-manager.js';
export { CacheAnalyzer } from './cache-analyzer.js';
export { cacheWidgetHtml } from './widget-html.js';
export { FILE_TYPES, getFileTypeConfig } from './file-types.js';
