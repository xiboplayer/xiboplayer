/**
 * FILE_TYPES — centralized download behavior per file type.
 *
 * Each type declares retry strategy, HEAD skip, and cache TTL.
 * Used by DownloadTask/FileDownload instead of ad-hoc isGetData checks.
 */

export const FILE_TYPES = {
  media:   { maxRetries: 3, retryDelayMs: 500, retryDelays: null,
             maxReenqueues: 0, reenqueueDelayMs: 0,
             skipHead: false, cacheTtl: Infinity },
  layout:  { maxRetries: 3, retryDelayMs: 500, retryDelays: null,
             maxReenqueues: 0, reenqueueDelayMs: 0,
             skipHead: false, cacheTtl: Infinity },
  dataset: { maxRetries: 4, retryDelayMs: 0,
             retryDelays: [15_000, 30_000, 60_000, 120_000],
             maxReenqueues: 5, reenqueueDelayMs: 60_000,
             skipHead: true, cacheTtl: 300 },
  static:  { maxRetries: 3, retryDelayMs: 500, retryDelays: null,
             maxReenqueues: 0, reenqueueDelayMs: 0,
             skipHead: false, cacheTtl: Infinity },
};

export function getFileTypeConfig(type) {
  return FILE_TYPES[type] || FILE_TYPES.media;
}
