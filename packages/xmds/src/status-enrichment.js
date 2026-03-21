// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Shared notifyStatus enrichment — adds storage estimate, timezone,
 * and statusDialog to the status object before submission.
 *
 * @param {Object} status - Mutable status object to enrich in place
 * @returns {Promise<void>}
 */
export async function enrichStatus(status) {
  // Add storage estimate if available
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      status.availableSpace = estimate.quota - estimate.usage;
      status.totalSpace = estimate.quota;
    } catch (_) { /* storage estimate not supported */ }
  }

  // Add timezone if not already provided
  if (!status.timeZone && typeof Intl !== 'undefined') {
    status.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // Add statusDialog (summary for CMS display status page) if not provided
  if (!status.statusDialog) {
    status.statusDialog = `Current Layout: ${status.currentLayoutId || 'None'}`;
  }
}
