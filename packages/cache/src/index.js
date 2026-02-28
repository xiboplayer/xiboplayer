// @xiboplayer/cache - Offline caching and downloads
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { CacheManager, cacheManager } from './cache.js';
export { StoreClient } from './store-client.js';
export { DownloadClient } from './download-client.js';
export { DownloadManager, FileDownload, LayoutTaskBuilder, isUrlExpired, toProxyUrl, setCmsOrigin } from './download-manager.js';
export { CacheAnalyzer } from './cache-analyzer.js';
export { cacheWidgetHtml } from './widget-html.js';
