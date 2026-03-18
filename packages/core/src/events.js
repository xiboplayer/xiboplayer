// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Core event name constants — shared between PlayerCore and platform layers.
 * Using constants prevents silent typo bugs at the core/platform boundary.
 */

export const CORE_EVENTS = Object.freeze({
  // Collection lifecycle
  COLLECTION_START: 'collection-start',
  COLLECTION_COMPLETE: 'collection-complete',
  COLLECTION_ERROR: 'collection-error',

  // Registration
  REGISTER_COMPLETE: 'register-complete',

  // Schedule
  SCHEDULE_RECEIVED: 'schedule-received',
  LAYOUTS_SCHEDULED: 'layouts-scheduled',
  NO_LAYOUTS_SCHEDULED: 'no-layouts-scheduled',
  TIMELINE_UPDATED: 'timeline-updated',

  // Layout lifecycle
  LAYOUT_PREPARE_REQUEST: 'layout-prepare-request',
  LAYOUT_EXPIRE_CURRENT: 'layout-expire-current',
  LAYOUT_ALREADY_PLAYING: 'layout-already-playing',
  CHECK_PENDING_LAYOUT: 'check-pending-layout',

  // Downloads
  FILES_RECEIVED: 'files-received',
  DOWNLOAD_REQUEST: 'download-request',

  // Overlay
  OVERLAY_LAYOUT_REQUEST: 'overlay-layout-request',
  REVERT_TO_SCHEDULE: 'revert-to-schedule',

  // Sync
  SYNC_CONFIG: 'sync-config',

  // XMR
  XMR_CONNECTED: 'xmr-connected',
  XMR_MISCONFIGURED: 'xmr-misconfigured',

  // Navigation
  NAVIGATE_TO_WIDGET: 'navigate-to-widget',

  // Commands
  EXECUTE_NATIVE_COMMAND: 'execute-native-command',
  SCHEDULED_COMMAND: 'scheduled-command',
  COMMAND_RESULT: 'command-result',

  // Screenshots
  SCREENSHOT_REQUEST: 'screenshot-request',

  // Stats/Logs
  SUBMIT_STATS_REQUEST: 'submit-stats-request',
  SUBMIT_LOGS_REQUEST: 'submit-logs-request',

  // Settings
  LOG_LEVEL_CHANGED: 'log-level-changed',
  OFFLINE_MODE: 'offline-mode',

  // Purge
  PURGE_REQUEST: 'purge-request',
  PURGE_ALL_REQUEST: 'purge-all-request',
});
