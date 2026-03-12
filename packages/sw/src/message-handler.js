// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * MessageHandler - Handles postMessage from client
 *
 * Lightweight SW message handler for lifecycle and file management.
 * Download orchestration has moved to the main thread (PwaPlayer).
 */

import { createLogger } from '@xiboplayer/utils';

/** Store key = URL path without leading / and query params */
const storeKeyFrom = (f) => (f.path || '').split('?')[0].replace(/^\/+/, '') || `${f.type || 'media'}/${f.id}`;

export class MessageHandler {
  /**
   * @param {Object} downloadManager - DownloadManager instance (kept for future SW-only mode)
   * @param {Object} config
   */
  constructor(downloadManager, config) {
    this.downloadManager = downloadManager;
    this.config = config;
    this.log = createLogger('SW Message');
  }

  /**
   * Handle message from client
   */
  async handleMessage(event) {
    const { type, data } = event.data;
    this.log.info('Received:', type);

    switch (type) {
      case 'PING': {
        this.log.info('PING received, broadcasting SW_READY');
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
          client.postMessage({ type: 'SW_READY' });
        });
        return { success: true };
      }

      case 'DELETE_FILES':
        return await this.handleDeleteFiles(data.files);

      case 'GET_ALL_FILES':
        return await this.handleGetAllFiles();

      case 'CLEAR_CACHE':
        return { success: true };

      default:
        this.log.warn('Unknown message type:', type);
        return { success: false, error: 'Unknown message type' };
    }
  }

  /**
   * Handle DELETE_FILES message - purge obsolete files from ContentStore via proxy
   */
  async handleDeleteFiles(files) {
    if (!files || !Array.isArray(files)) {
      return { success: false, error: 'No files provided' };
    }

    try {
      const deleteFiles = files.map(f => ({
        ...f,
        key: storeKeyFrom(f),
      }));
      const resp = await fetch('/store/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: deleteFiles }),
      });
      const result = await resp.json();
      this.log.info(`Purge complete: ${result.deleted}/${result.total} files deleted`);
      return { success: true, deleted: result.deleted, total: result.total };
    } catch (err) {
      this.log.error('Delete failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Handle GET_ALL_FILES — list files from ContentStore via proxy
   */
  async handleGetAllFiles() {
    try {
      const resp = await fetch('/store/list');
      const data = await resp.json();
      return { success: true, files: data.files || [] };
    } catch (err) {
      this.log.error('Failed to list files:', err.message);
      return { success: true, files: [] };
    }
  }
}
