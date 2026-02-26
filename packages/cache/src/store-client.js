/**
 * StoreClient — Pure REST client for ContentStore
 *
 * Communicates with the proxy's /store/* endpoints via fetch().
 * No Service Worker dependency — works immediately after construction.
 *
 * Usage:
 *   const store = new StoreClient();
 *   const exists = await store.has('media', '123');
 *   const blob = await store.get('media', '123');
 *   await store.put('widget', 'layout/1/region/2/media/3', htmlBlob, 'text/html');
 *   await store.remove([{ type: 'media', id: '456' }]);
 *   const files = await store.list();
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('StoreClient');

export class StoreClient {
  /**
   * Check if a file exists in the store.
   * @param {string} type - 'media', 'layout', 'widget', 'static'
   * @param {string} id - File ID or path
   * @returns {Promise<boolean>}
   */
  async has(type, id) {
    try {
      const response = await fetch(`/store/${type}/${id}`, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get a file from the store as a Blob.
   * @param {string} type - 'media', 'layout', 'widget', 'static'
   * @param {string} id - File ID or path
   * @returns {Promise<Blob|null>}
   */
  async get(type, id) {
    try {
      const response = await fetch(`/store/${type}/${id}`);
      if (!response.ok) {
        response.body?.cancel();
        if (response.status === 404) return null;
        throw new Error(`Failed to get file: ${response.status}`);
      }
      return await response.blob();
    } catch (error) {
      log.error('get error:', error.message);
      return null;
    }
  }

  /**
   * Store a file in the ContentStore.
   * @param {string} type - 'media', 'layout', 'widget', 'static'
   * @param {string} id - File ID or path
   * @param {Blob|ArrayBuffer|string} body - Content to store
   * @param {string} [contentType='application/octet-stream'] - MIME type
   * @returns {Promise<boolean>} true if stored successfully
   */
  async put(type, id, body, contentType = 'application/octet-stream') {
    try {
      const response = await fetch(`/store/${type}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body,
      });
      response.body?.cancel();
      return response.ok;
    } catch (error) {
      log.error('put error:', error.message);
      return false;
    }
  }

  /**
   * Delete files from the store.
   * @param {Array<{type: string, id: string}>} files - Files to delete
   * @returns {Promise<{deleted: number, total: number}>}
   */
  async remove(files) {
    try {
      const response = await fetch('/store/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      const result = await response.json();
      return { deleted: result.deleted || 0, total: result.total || files.length };
    } catch (error) {
      log.error('remove error:', error.message);
      return { deleted: 0, total: files.length };
    }
  }

  /**
   * List all files in the store.
   * @returns {Promise<Array<{id: string, type: string, size: number}>>}
   */
  async list() {
    try {
      const response = await fetch('/store/list');
      const data = await response.json();
      return data.files || [];
    } catch (error) {
      log.error('list error:', error.message);
      return [];
    }
  }
}
