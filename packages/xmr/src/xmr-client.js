/**
 * Native XMR (Xibo Message Relay) WebSocket Client
 *
 * Drop-in replacement for @xibosignage/xibo-communication-framework.
 * Uses a generic action dispatcher — emit(message.action, message) — so
 * every CMS action works automatically without a hardcoded if-else chain.
 *
 * API-compatible with the upstream Xmr class:
 *   new XmrClient(channel) → .init() → .start(url, key) → .on(event, cb)
 */

export class XmrClient {
  /**
   * @param {string} channel - XMR channel identifier (e.g. "player-HWKEY")
   */
  constructor(channel) {
    this.channel = channel;
    this.url = null;
    this.cmsKey = null;
    this.socket = null;
    this.isConnected = false;
    this.isConnectionWanted = false;
    this.lastMessageAt = 0;
    this._interval = null;
    this._listeners = new Map(); // event → Set<callback>
  }

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  /**
   * Emit an event to all registered listeners.
   * @param {string} event
   * @param {...*} args
   */
  emit(event, ...args) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    for (const cb of listeners) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`XmrClient: listener error for '${event}':`, e);
      }
    }
  }

  /**
   * Initialize the reconnect interval (60s health check).
   * Same cadence as upstream framework.
   */
  async init() {
    if (this._interval) return;
    this._interval = setInterval(() => {
      if (this.isConnectionWanted && !this.isActive()) {
        this.start(this.url || 'DISABLED', this.cmsKey || 'n/a');
      }
    }, 60_000);
  }

  /**
   * Connect to XMR WebSocket server.
   * @param {string} url - WebSocket URL (ws:// or wss://)
   * @param {string} cmsKey - CMS authentication key
   */
  async start(url, cmsKey) {
    this.url = url;
    this.cmsKey = cmsKey;
    this.isConnectionWanted = true;

    // Close existing socket if any
    if (this.socket) {
      try { this.socket.close(); } catch (_) { /* ignore */ }
      this.socket = null;
      this.isConnected = false;
    }

    try {
      this.socket = new WebSocket(url);
    } catch (e) {
      this.emit('error', 'Failed to connect');
      return;
    }

    this.socket.addEventListener('open', () => {
      this.socket.send(JSON.stringify({
        type: 'init',
        key: this.cmsKey,
        channel: this.channel,
      }));
      this.isConnected = true;
      this.lastMessageAt = Date.now();
      this.emit('connected');
    });

    this.socket.addEventListener('close', () => {
      this.isConnected = false;
      this.emit('disconnected');
    });

    this.socket.addEventListener('error', () => {
      this.emit('error', 'error');
    });

    this.socket.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now();

      // Heartbeat
      if (event.data === 'H') return;

      // JSON action message
      try {
        const message = JSON.parse(event.data);
        if (!message.action) return;

        // TTL check: createdDt (ISO 8601) + ttl seconds > now
        if (message.createdDt && message.ttl) {
          const created = Date.parse(message.createdDt);
          if (!isNaN(created)) {
            const expiresAt = created + parseInt(message.ttl) * 1000;
            if (expiresAt < Date.now()) return; // expired
          }
        }

        // Generic dispatch — every CMS action works automatically
        this.emit(message.action, message);
      } catch (e) {
        console.error('XmrClient: failed to parse message:', e);
      }
    });
  }

  /**
   * Stop the connection and clear the reconnect interval.
   */
  async stop() {
    this.isConnectionWanted = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      this.isConnected = false;
    }
  }

  /**
   * Send a message to the server via WebSocket.
   * @param {string} action - Action name
   * @param {*} data - Data payload
   */
  async send(action, data) {
    if (!this.socket || !this.isConnected) {
      throw new Error('Not connected');
    }
    this.socket.send(JSON.stringify({ action, ...data }));
  }

  /**
   * Check if the connection is active (connected + message within 15min).
   * @returns {boolean}
   */
  isActive() {
    return this.isConnected && (Date.now() - this.lastMessageAt) < 15 * 60 * 1000;
  }
}
