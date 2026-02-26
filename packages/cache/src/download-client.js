/**
 * DownloadClient — Service Worker postMessage interface for download orchestration
 *
 * Communicates with the Service Worker via postMessage for:
 * - Background file downloads (DOWNLOAD_FILES)
 * - Download prioritization (PRIORITIZE_DOWNLOAD, PRIORITIZE_LAYOUT_FILES)
 * - Progress reporting (GET_DOWNLOAD_PROGRESS)
 *
 * Usage:
 *   const downloads = new DownloadClient();
 *   await downloads.init();  // Waits for SW to be ready
 *   await downloads.download(files);
 *   downloads.prioritize('media', '123');
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('DownloadClient');

export class DownloadClient {
  constructor() {
    this.controller = null;
    this.fetchReady = false;
    this._fetchReadyPromise = null;
    this._fetchReadyResolve = null;
  }

  /**
   * Initialize — waits for Service Worker to be ready and controlling the page.
   */
  async init() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker not supported — PWA requires Service Worker');
    }

    // Guard against double-initialization (would add duplicate listeners)
    if (this._swReadyHandler) return;

    // Create promise for fetch readiness (resolved when SW sends SW_READY)
    this._fetchReadyPromise = new Promise(resolve => {
      this._fetchReadyResolve = resolve;
    });

    // Listen for SW_READY message (store handler for cleanup)
    this._swReadyHandler = (event) => {
      if (event.data?.type === 'SW_READY') {
        log.info('Received SW_READY signal — fetch handler is ready');
        this.fetchReady = true;
        this._fetchReadyResolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', this._swReadyHandler);

    const registration = await navigator.serviceWorker.getRegistration();

    // FAST PATH: Active SW, no updates pending
    if (registration && registration.active && !registration.installing && !registration.waiting) {
      log.info('Active Service Worker found (no updates pending)');
      this.controller = navigator.serviceWorker.controller || registration.active;

      // If not controlling yet, give it a moment to claim page
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      this.controller.postMessage({ type: 'PING' });
      log.info('DownloadClient initialized, waiting for fetch readiness...');
      return;
    }

    // If there's a new SW installing/waiting, wait for it
    if (registration && (registration.installing || registration.waiting)) {
      log.info('New Service Worker detected, waiting for it to activate...');
    }

    // SLOW PATH: No active SW, wait for registration (fresh install)
    log.info('No active Service Worker, waiting for registration...');

    const swReady = navigator.serviceWorker.ready;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Service Worker ready timeout after 10s')), 10000)
    );

    try {
      await Promise.race([swReady, timeout]);
    } catch (error) {
      log.error('Service Worker wait failed:', error);
      throw new Error('Service Worker not ready — please reload page');
    }

    // Wait for SW to claim page
    await new Promise(resolve => setTimeout(resolve, 100));

    this.controller = navigator.serviceWorker.controller;
    if (!this.controller) {
      const reg = await navigator.serviceWorker.getRegistration();
      this.controller = reg?.active;
    }

    if (this.controller) {
      this.controller.postMessage({ type: 'PING' });
    }

    log.info('DownloadClient initialized (slow path)');
  }

  /**
   * Wait for fetch readiness before operations that need it.
   */
  async _ensureReady() {
    if (!this.fetchReady && this._fetchReadyPromise) {
      await this._fetchReadyPromise;
    }
  }

  /**
   * Request file downloads from Service Worker (non-blocking).
   * @param {Object|Array} payload - { layoutOrder, files, layoutDependants } or flat Array
   * @returns {Promise<void>}
   */
  async download(payload) {
    if (!this.controller) {
      throw new Error('Service Worker not available');
    }

    const data = Array.isArray(payload)
      ? { files: payload }
      : payload;

    return new Promise((resolve, reject) => {
      const messageChannel = new MessageChannel();

      messageChannel.port1.onmessage = (event) => {
        const { success, error, enqueuedCount, activeCount, queuedCount } = event.data;
        if (success) {
          log.info('Download request acknowledged:', enqueuedCount, 'files');
          log.info('Queue state:', activeCount, 'active,', queuedCount, 'queued');
          resolve();
        } else {
          reject(new Error(error || 'Service Worker download failed'));
        }
      };

      this.controller.postMessage(
        { type: 'DOWNLOAD_FILES', data },
        [messageChannel.port2]
      );
    });
  }

  /**
   * Prioritize downloading a specific file (move to front of queue).
   * @param {string} fileType - 'media' or 'layout'
   * @param {string} fileId - File ID
   */
  async prioritize(fileType, fileId) {
    if (!this.controller) return;

    return new Promise((resolve) => {
      const messageChannel = new MessageChannel();
      messageChannel.port1.onmessage = (event) => resolve(event.data);
      this.controller.postMessage(
        { type: 'PRIORITIZE_DOWNLOAD', data: { fileType, fileId } },
        [messageChannel.port2]
      );
    });
  }

  /**
   * Prioritize layout files — reorder queue and hold other downloads until done.
   * @param {string[]} mediaIds - Media IDs needed by the current layout
   */
  async prioritizeLayout(mediaIds) {
    if (!this.controller) return;
    this.controller.postMessage({ type: 'PRIORITIZE_LAYOUT_FILES', data: { mediaIds } });
  }

  /**
   * Get download progress from Service Worker.
   * @returns {Promise<Object>} Progress info for all active downloads
   */
  async getProgress() {
    if (!this.controller) return {};

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          channel.port1.onmessage = null;
          resolve({});
        }
      }, 1000);

      channel.port1.onmessage = (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const { success, progress } = event.data;
          resolve(success ? progress : {});
        }
      };

      this.controller.postMessage(
        { type: 'GET_DOWNLOAD_PROGRESS' },
        [channel.port2]
      );
    });
  }

  /**
   * Remove event listeners added during init().
   */
  cleanup() {
    if (this._swReadyHandler && 'serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', this._swReadyHandler);
      this._swReadyHandler = null;
    }
  }
}
