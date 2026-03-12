// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * BroadcastChannelTransport — same-machine sync transport
 *
 * Wraps the browser BroadcastChannel API behind the sync transport interface.
 * Used for multi-tab / multi-window sync on a single device.
 *
 * Transport interface: { send(msg), onMessage(callback), close(), get connected() }
 */

const DEFAULT_CHANNEL = 'xibo-sync';

export class BroadcastChannelTransport {
  /**
   * @param {string} [channelName='xibo-sync']
   */
  constructor(channelName = DEFAULT_CHANNEL) {
    this.channel = new BroadcastChannel(channelName);
    this._connected = true;
  }

  /**
   * Send a message to all other tabs/windows on this channel.
   * @param {Object} msg — plain object (structured-cloned by BroadcastChannel)
   */
  send(msg) {
    if (!this.channel) return;
    this.channel.postMessage(msg);
  }

  /**
   * Register a callback for incoming messages.
   * @param {Function} callback — receives the message data (already deserialized)
   */
  onMessage(callback) {
    this.channel.onmessage = (e) => callback(e.data);
  }

  /** Close the channel. */
  close() {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this._connected = false;
  }

  /** @returns {boolean} Whether the channel is open */
  get connected() {
    return this._connected && !!this.channel;
  }
}
