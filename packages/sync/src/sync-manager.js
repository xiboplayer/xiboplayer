/**
 * SyncManager - Multi-display synchronization via BroadcastChannel
 *
 * Coordinates layout transitions across multiple browser tabs/windows
 * on the same machine (video wall, multi-monitor setups).
 *
 * Protocol:
 *   Lead                              Follower(s)
 *   ────                              ──────────
 *   layout-change(layoutId, showAt)  →  receives, loads layout
 *                                    ←  layout-ready(layoutId, displayId)
 *   (waits for all followers ready)
 *   layout-show(layoutId)            →  shows layout simultaneously
 *
 * Heartbeat:
 *   All nodes broadcast heartbeat every 5s.
 *   Lead tracks active followers. If a follower goes silent for 15s,
 *   it's considered offline and excluded from ready-wait.
 *
 * @module @xiboplayer/sync
 */

/**
 * @typedef {Object} SyncConfig
 * @property {string} syncGroup - "lead" or leader's LAN IP
 * @property {number} syncPublisherPort - TCP port (unused in browser, kept for compat)
 * @property {number} syncSwitchDelay - Delay in ms before showing new content
 * @property {number} syncVideoPauseDelay - Delay in ms before unpausing video
 * @property {boolean} isLead - Whether this display is the leader
 */

import { createLogger } from '@xiboplayer/utils';

const CHANNEL_NAME = 'xibo-sync';
const HEARTBEAT_INTERVAL = 5000;   // Send heartbeat every 5s
const FOLLOWER_TIMEOUT = 15000;    // Consider follower offline after 15s silence
const READY_TIMEOUT = 10000;       // Max wait for followers to be ready

export class SyncManager {
  /**
   * @param {Object} options
   * @param {string} options.displayId - This display's unique hardware key
   * @param {SyncConfig} options.syncConfig - Sync configuration from RegisterDisplay
   * @param {Function} [options.onLayoutChange] - Called when lead requests layout change
   * @param {Function} [options.onLayoutShow] - Called when lead gives show signal
   * @param {Function} [options.onVideoStart] - Called when lead gives video start signal
   * @param {Function} [options.onStatsReport] - (Lead) Called when follower sends stats
   * @param {Function} [options.onLogsReport] - (Lead) Called when follower sends logs
   * @param {Function} [options.onStatsAck] - (Follower) Called when lead confirms stats submission
   * @param {Function} [options.onLogsAck] - (Follower) Called when lead confirms logs submission
   */
  constructor(options) {
    this.displayId = options.displayId;
    this.syncConfig = options.syncConfig;
    this.isLead = options.syncConfig.isLead;
    this.switchDelay = options.syncConfig.syncSwitchDelay || 750;
    this.videoPauseDelay = options.syncConfig.syncVideoPauseDelay || 100;

    // Callbacks
    this.onLayoutChange = options.onLayoutChange || (() => {});
    this.onLayoutShow = options.onLayoutShow || (() => {});
    this.onVideoStart = options.onVideoStart || (() => {});
    this.onStatsReport = options.onStatsReport || null;
    this.onLogsReport = options.onLogsReport || null;
    this.onStatsAck = options.onStatsAck || null;
    this.onLogsAck = options.onLogsAck || null;

    // State
    this.channel = null;
    this.followers = new Map();      // displayId → { lastSeen, ready }
    this._heartbeatTimer = null;
    this._cleanupTimer = null;
    this._readyResolve = null;       // Resolve function for current ready-wait
    this._pendingLayoutId = null;    // Layout we're waiting for readiness on
    this._started = false;

    // Logger with role prefix for clarity in multi-tab console
    this._tag = this.isLead ? '[Sync:LEAD]' : '[Sync:FOLLOW]';
    this._log = createLogger(this.isLead ? 'Sync:LEAD' : 'Sync:FOLLOW');
  }

  /**
   * Start the sync manager (opens BroadcastChannel, begins heartbeats)
   */
  start() {
    if (this._started) return;
    this._started = true;

    if (typeof BroadcastChannel === 'undefined') {
      this._log.warn( 'BroadcastChannel not available — sync disabled');
      return;
    }

    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event) => this._handleMessage(event.data);

    // Start heartbeat
    this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL);
    this._sendHeartbeat(); // Send initial heartbeat immediately

    // Lead: periodically clean up stale followers
    if (this.isLead) {
      this._cleanupTimer = setInterval(() => this._cleanupStaleFollowers(), HEARTBEAT_INTERVAL);
    }

    this._log.info( 'Started. DisplayId:', this.displayId);
  }

  /**
   * Stop the sync manager
   */
  stop() {
    if (!this._started) return;
    this._started = false;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.followers.clear();
    this._log.info( 'Stopped');
  }

  // ── Lead API ──────────────────────────────────────────────────────

  /**
   * [Lead only] Request all displays to change to a layout.
   * Waits for followers to report ready, then sends show signal.
   *
   * @param {string|number} layoutId - Layout to change to
   * @returns {Promise<void>} Resolves when show signal is sent
   */
  async requestLayoutChange(layoutId) {
    if (!this.isLead) {
      this._log.warn( 'requestLayoutChange called on follower — ignoring');
      return;
    }

    layoutId = String(layoutId);
    this._pendingLayoutId = layoutId;

    // Mark all followers as not-ready for this layout
    for (const [, follower] of this.followers) {
      follower.ready = false;
      follower.readyLayoutId = null;
    }

    const showAt = Date.now() + this.switchDelay;

    this._log.info( `Requesting layout change: ${layoutId} (show at ${new Date(showAt).toISOString()}, ${this.followers.size} followers)`);

    // Broadcast layout-change to all followers
    this._send({
      type: 'layout-change',
      layoutId,
      showAt,
      displayId: this.displayId,
    });

    // Wait for all active followers to report ready (or timeout)
    if (this.followers.size > 0) {
      await this._waitForFollowersReady(layoutId);
    }

    // Apply switch delay (remaining time from showAt)
    const remaining = showAt - Date.now();
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining));
    }

    // Send show signal
    this._log.info( `Sending layout-show: ${layoutId}`);
    this._send({
      type: 'layout-show',
      layoutId,
      displayId: this.displayId,
    });

    // Also trigger on self (lead shows too)
    this.onLayoutShow(layoutId);

    this._pendingLayoutId = null;
  }

  /**
   * [Lead only] Signal followers to start video playback.
   *
   * @param {string|number} layoutId - Layout containing the video
   * @param {string} regionId - Region with the video widget
   */
  async requestVideoStart(layoutId, regionId) {
    if (!this.isLead) return;

    // Wait videoPauseDelay before unpausing
    await new Promise(resolve => setTimeout(resolve, this.videoPauseDelay));

    this._send({
      type: 'video-start',
      layoutId: String(layoutId),
      regionId,
      displayId: this.displayId,
    });

    // Also trigger on self
    this.onVideoStart(String(layoutId), regionId);
  }

  // ── Follower API ──────────────────────────────────────────────────

  /**
   * [Follower only] Report that layout is loaded and ready to show.
   * Called by platform layer after layout content is prepared.
   *
   * @param {string|number} layoutId - Layout that is ready
   */
  reportReady(layoutId) {
    layoutId = String(layoutId);

    this._log.info( `Reporting ready for layout ${layoutId}`);

    this._send({
      type: 'layout-ready',
      layoutId,
      displayId: this.displayId,
    });
  }

  /**
   * [Follower only] Delegate stats submission to the lead.
   * Lead will submit on our behalf and send a stats-ack when done.
   *
   * @param {string} statsXml - Formatted stats XML to submit
   */
  reportStats(statsXml) {
    if (this.isLead) return;

    this._log.info('Delegating stats to lead');
    this._send({
      type: 'stats-report',
      displayId: this.displayId,
      statsXml,
    });
  }

  /**
   * [Follower only] Delegate logs submission to the lead.
   * Lead will submit on our behalf and send a logs-ack when done.
   *
   * @param {string} logsXml - Formatted logs XML to submit
   */
  reportLogs(logsXml) {
    if (this.isLead) return;

    this._log.info('Delegating logs to lead');
    this._send({
      type: 'logs-report',
      displayId: this.displayId,
      logsXml,
    });
  }

  // ── Message handling ──────────────────────────────────────────────

  /** @private */
  _handleMessage(msg) {
    // Ignore our own messages
    if (msg.displayId === this.displayId) return;

    switch (msg.type) {
      case 'heartbeat':
        this._handleHeartbeat(msg);
        break;

      case 'layout-change':
        // Follower: lead is requesting a layout change
        if (!this.isLead) {
          this._log.info( `Layout change requested: ${msg.layoutId}`);
          this.onLayoutChange(msg.layoutId, msg.showAt);
        }
        break;

      case 'layout-ready':
        // Lead: follower reports ready
        if (this.isLead) {
          this._handleFollowerReady(msg);
        }
        break;

      case 'layout-show':
        // Follower: lead says show now
        if (!this.isLead) {
          this._log.info( `Layout show signal: ${msg.layoutId}`);
          this.onLayoutShow(msg.layoutId);
        }
        break;

      case 'video-start':
        // Follower: lead says start video
        if (!this.isLead) {
          this._log.info( `Video start signal: ${msg.layoutId} region ${msg.regionId}`);
          this.onVideoStart(msg.layoutId, msg.regionId);
        }
        break;

      case 'stats-report':
        // Lead: follower is delegating stats submission
        if (this.isLead && this.onStatsReport) {
          const statsAck = () => this._send({ type: 'stats-ack', displayId: this.displayId, targetDisplayId: msg.displayId });
          this.onStatsReport(msg.displayId, msg.statsXml, statsAck);
        }
        break;

      case 'logs-report':
        // Lead: follower is delegating logs submission
        if (this.isLead && this.onLogsReport) {
          const logsAck = () => this._send({ type: 'logs-ack', displayId: this.displayId, targetDisplayId: msg.displayId });
          this.onLogsReport(msg.displayId, msg.logsXml, logsAck);
        }
        break;

      case 'stats-ack':
        // Follower: lead confirmed stats were submitted for us
        if (!this.isLead && msg.targetDisplayId === this.displayId && this.onStatsAck) {
          this._log.info('Stats acknowledged by lead');
          this.onStatsAck(msg.targetDisplayId);
        }
        break;

      case 'logs-ack':
        // Follower: lead confirmed logs were submitted for us
        if (!this.isLead && msg.targetDisplayId === this.displayId && this.onLogsAck) {
          this._log.info('Logs acknowledged by lead');
          this.onLogsAck(msg.targetDisplayId);
        }
        break;

      default:
        this._log.warn( 'Unknown message type:', msg.type);
    }
  }

  /** @private */
  _handleHeartbeat(msg) {
    const existing = this.followers.get(msg.displayId);
    if (existing) {
      existing.lastSeen = Date.now();
    } else {
      // New follower discovered
      this.followers.set(msg.displayId, {
        lastSeen: Date.now(),
        ready: false,
        readyLayoutId: null,
        role: msg.role || 'unknown',
      });
      this._log.info( `Follower joined: ${msg.displayId} (${this.followers.size} total)`);
    }
  }

  /** @private */
  _handleFollowerReady(msg) {
    const follower = this.followers.get(msg.displayId);
    if (!follower) {
      // Late joiner — register them
      this.followers.set(msg.displayId, {
        lastSeen: Date.now(),
        ready: true,
        readyLayoutId: msg.layoutId,
      });
    } else {
      follower.ready = true;
      follower.readyLayoutId = msg.layoutId;
      follower.lastSeen = Date.now();
    }

    this._log.info( `Follower ${msg.displayId} ready for layout ${msg.layoutId}`);

    // Check if all followers are now ready
    if (this._pendingLayoutId === msg.layoutId && this._readyResolve) {
      if (this._allFollowersReady(msg.layoutId)) {
        this._log.info( 'All followers ready');
        this._readyResolve();
        this._readyResolve = null;
      }
    }
  }

  /** @private */
  _allFollowersReady(layoutId) {
    for (const [, follower] of this.followers) {
      // Skip stale followers
      if (Date.now() - follower.lastSeen > FOLLOWER_TIMEOUT) continue;
      if (!follower.ready || follower.readyLayoutId !== layoutId) {
        return false;
      }
    }
    return true;
  }

  /** @private */
  _waitForFollowersReady(layoutId) {
    return new Promise((resolve) => {
      // Already all ready?
      if (this._allFollowersReady(layoutId)) {
        resolve();
        return;
      }

      this._readyResolve = resolve;

      // Timeout: don't wait forever for unresponsive followers
      setTimeout(() => {
        if (this._readyResolve === resolve) {
          const notReady = [];
          for (const [id, f] of this.followers) {
            if (!f.ready || f.readyLayoutId !== layoutId) {
              notReady.push(id);
            }
          }
          this._log.warn( `Ready timeout — proceeding without: ${notReady.join(', ')}`);
          this._readyResolve = null;
          resolve();
        }
      }, READY_TIMEOUT);
    });
  }

  // ── Heartbeat & cleanup ───────────────────────────────────────────

  /** @private */
  _sendHeartbeat() {
    this._send({
      type: 'heartbeat',
      displayId: this.displayId,
      role: this.isLead ? 'lead' : 'follower',
      timestamp: Date.now(),
    });
  }

  /** @private */
  _cleanupStaleFollowers() {
    const now = Date.now();
    for (const [id, follower] of this.followers) {
      if (now - follower.lastSeen > FOLLOWER_TIMEOUT) {
        this._log.info( `Removing stale follower: ${id} (last seen ${Math.round((now - follower.lastSeen) / 1000)}s ago)`);
        this.followers.delete(id);
      }
    }
  }

  /** @private */
  _send(msg) {
    if (!this.channel) return;
    try {
      this.channel.postMessage(msg);
    } catch (e) {
      this._log.error( 'Failed to send:', e);
    }
  }

  // ── Status ────────────────────────────────────────────────────────

  /**
   * Get current sync status
   * @returns {Object}
   */
  getStatus() {
    return {
      started: this._started,
      isLead: this.isLead,
      displayId: this.displayId,
      followers: this.followers.size,
      pendingLayoutId: this._pendingLayoutId,
      followerDetails: Array.from(this.followers.entries()).map(([id, f]) => ({
        displayId: id,
        lastSeen: f.lastSeen,
        ready: f.ready,
        readyLayoutId: f.readyLayoutId,
        stale: Date.now() - f.lastSeen > FOLLOWER_TIMEOUT,
      })),
    };
  }
}
