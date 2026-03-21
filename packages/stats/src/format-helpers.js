// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Shared formatting helpers for stats and log XML serialization.
 *
 * @module @xiboplayer/stats/format-helpers
 */

/**
 * Format Date object as "YYYY-MM-DD HH:MM:SS"
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDateTime(date) {
  if (!(date instanceof Date)) {
    date = new Date(date);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Escape XML special characters in a string.
 * Returns non-string values unchanged.
 * @param {string|*} str
 * @returns {string|*}
 */
export function escapeXml(str) {
  if (typeof str !== 'string') {
    return str;
  }

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
