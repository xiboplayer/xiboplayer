// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Chunk configuration for Service Worker downloads
 */

import { createLogger } from '@xiboplayer/utils';

/**
 * Calculate optimal chunk size based on available device memory.
 * Returns configuration for chunk streaming, blob caching, and download concurrency.
 *
 * @param {{ info: Function }} [log] - Optional logger (created internally if not provided)
 * @returns {{ chunkSize: number, blobCacheSize: number, threshold: number, concurrency: number }}
 */
export function calculateChunkConfig(log) {
  if (!log) log = createLogger('ChunkConfig');

  // Try to detect device memory (Chrome only for now)
  const deviceMemoryGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || null;

  // Fallback: estimate from user agent
  let estimatedRAM_GB = 4; // Default assumption

  if (deviceMemoryGB) {
    estimatedRAM_GB = deviceMemoryGB;
    log.info('Detected device memory:', deviceMemoryGB, 'GB');
  } else if (typeof navigator !== 'undefined') {
    // Parse user agent for hints
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('raspberry pi') || ua.includes('armv6')) {
      estimatedRAM_GB = 0.5; // Pi Zero
      log.info('Detected Pi Zero (512 MB RAM estimated)');
    } else if (ua.includes('armv7')) {
      estimatedRAM_GB = 1; // Pi 3/4
      log.info('Detected ARM device (1 GB RAM estimated)');
    } else {
      log.info('Using default RAM estimate:', estimatedRAM_GB, 'GB');
    }
  }

  // Configure based on RAM - chunk size, cache, threshold, AND concurrency
  let chunkSize, blobCacheSize, threshold, concurrency;

  if (estimatedRAM_GB <= 0.5) {
    // Pi Zero (512 MB) - very conservative
    chunkSize = 10 * 1024 * 1024;
    blobCacheSize = 25;
    threshold = 25 * 1024 * 1024;
    concurrency = 1;
    log.info('Low-memory config: 10 MB chunks, 25 MB cache, 1 concurrent download');
  } else if (estimatedRAM_GB <= 1) {
    // 1 GB RAM (Pi 3) - conservative
    chunkSize = 20 * 1024 * 1024;
    blobCacheSize = 50;
    threshold = 50 * 1024 * 1024;
    concurrency = 2;
    log.info('1GB-RAM config: 20 MB chunks, 50 MB cache, 2 concurrent downloads');
  } else if (estimatedRAM_GB <= 2) {
    // 2 GB RAM - moderate
    chunkSize = 30 * 1024 * 1024;
    blobCacheSize = 100;
    threshold = 75 * 1024 * 1024;
    concurrency = 2;
    log.info('2GB-RAM config: 30 MB chunks, 100 MB cache, 2 concurrent downloads');
  } else if (estimatedRAM_GB <= 4) {
    // 4 GB RAM - default
    chunkSize = 50 * 1024 * 1024;
    blobCacheSize = 200;
    threshold = 100 * 1024 * 1024;
    concurrency = 4;
    log.info('4GB-RAM config: 50 MB chunks, 200 MB cache, 4 concurrent downloads');
  } else {
    // 8+ GB RAM - generous but heap-safe (100 MB × 4 = 400 MB peak, within 768 MB V8 heap)
    chunkSize = 100 * 1024 * 1024;
    blobCacheSize = 500;
    threshold = 200 * 1024 * 1024;
    concurrency = 4;
    log.info('High-RAM config: 100 MB chunks, 500 MB cache, 4 concurrent downloads');
  }

  return { chunkSize, blobCacheSize, threshold, concurrency };
}
