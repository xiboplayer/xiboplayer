// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * WebSocketTransport — cross-device sync transport
 *
 * Connects to the lead player's proxy WebSocket relay at /sync.
 * Used for LAN video walls where each screen is a separate device.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (1s → 2s → 4s → max 30s)
 * - JSON serialization (WebSocket sends strings, not structured clones)
 * - Same transport interface as BroadcastChannelTransport
 *
 * Transport interface: { send(msg), onMessage(callback), close(), get connected() }
 */

import { createLogger } from '@xiboplayer/utils';

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const BACKOFF_FACTOR = 2;

export class WebSocketTransport {
  /**
   * @param {string} url — WebSocket URL, e.g. ws://192.168.1.100:8765/sync
   * @param {Object} [options]
   * @param {string} [options.syncGroup] — group name for relay isolation
   * @param {string} [options.displayId] — this display's unique ID
   * @param {Object} [options.topology] — this display's topology { x, y, orientation? }
   * @param {string} [options.token] — auth token for relay join validation
   */
  constructor(url, { syncGroup, displayId, topology, token } = {}) {
    this._url = url;
    this._syncGroup = syncGroup || null;
    this._displayId = displayId || null;
    this._topology = topology || null;
    this._token = token || null;
    this._callback = null;
    this._closed = false;
    this._retryMs = INITIAL_RETRY_MS;
    this._retryTimer = null;
    this._log = createLogger('WS-Sync');
    this.ws = null;

    this._connect();
  }

  /**
   * Send a message to the relay (which broadcasts to other clients).
   * @param {Object} msg — plain object (JSON-serialized for WebSocket)
   */
  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Register a callback for incoming messages.
   * @param {Function} callback — receives the parsed message object
   */
  onMessage(callback) {
    this._callback = callback;
  }

  /** Close the connection and stop reconnecting. */
  close() {
    this._closed = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** @returns {boolean} Whether the WebSocket is open */
  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** @private */
  _connect() {
    if (this._closed) return;

    try {
      this.ws = new WebSocket(this._url);
    } catch (e) {
      this._log.error('WebSocket creation failed:', e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._log.info(`Connected to ${this._url}`);
      this._retryMs = INITIAL_RETRY_MS; // Reset backoff on success

      // Join sync group for relay isolation (+ topology for auto-detection)
      if (this._syncGroup) {
        const join = { type: 'join', syncGroup: this._syncGroup };
        if (this._displayId) join.displayId = this._displayId;
        if (this._topology) join.topology = this._topology;
        if (this._token) join.token = this._token;
        this.ws.send(JSON.stringify(join));
      }
    };

    this.ws.onmessage = async (event) => {
      if (!this._callback) return;
      try {
        // Browser WebSocket delivers string; Node ws delivers Buffer;
        // Node 22+ native WebSocket delivers Blob. Handle all three.
        let raw = event.data;
        if (typeof raw !== 'string') {
          raw = (raw instanceof Blob) ? await raw.text() : String(raw);
        }
        const msg = JSON.parse(raw);
        this._callback(msg);
      } catch (e) {
        this._log.warn('Failed to parse message:', e.message);
      }
    };

    this.ws.onclose = () => {
      if (!this._closed) {
        this._log.info('Connection closed — will reconnect');
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (e) => {
      // onclose will fire after onerror, triggering reconnect
      this._log.warn('WebSocket error');
    };
  }

  /** @private */
  _scheduleReconnect() {
    if (this._closed || this._retryTimer) return;

    this._log.info(`Reconnecting in ${this._retryMs}ms...`);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, this._retryMs);

    this._retryMs = Math.min(this._retryMs * BACKOFF_FACTOR, MAX_RETRY_MS);
  }
}
