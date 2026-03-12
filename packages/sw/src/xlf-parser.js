// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * XLF XML parsing utilities for Service Worker context
 */

/**
 * Extract media IDs from XLF XML content
 * @param {string} xlfText - Raw XLF XML string
 * @param {{ debug: Function }} [log] - Optional logger
 * @returns {Set<string>} Set of media file IDs
 */
export function extractMediaIdsFromXlf(xlfText, log) {
  const ids = new Set();
  // fileId is the CMS media library ID (id is just the widget sequence number)
  const fileIdMatches = xlfText.matchAll(/<media[^>]+fileId="(\d+)"/g);
  for (const m of fileIdMatches) ids.add(m[1]);
  // Data widgets (RSS, dataset, etc.) have no fileId — their id IS the widgetId
  // which the CMS returns as a media entry in RequiredFiles
  const mediaTagMatches = xlfText.matchAll(/<media\s+([^>]+)>/g);
  for (const m of mediaTagMatches) {
    const attrs = m[1];
    if (!attrs.includes('fileId=')) {
      const idMatch = attrs.match(/\bid="(\d+)"/);
      if (idMatch) ids.add(idMatch[1]);
    }
  }
  // background attribute on <layout> is also a media file ID
  const bgMatches = xlfText.matchAll(/<layout[^>]+background="(\d+)"/g);
  for (const m of bgMatches) ids.add(m[1]);
  if (log) log.debug(`extractMediaIdsFromXlf: found ${ids.size} IDs: ${[...ids].join(', ')} (XLF ${xlfText.length} bytes)`);
  return ids;
}
