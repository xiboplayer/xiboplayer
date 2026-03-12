// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * CmsClient interface definition — the unified contract for CMS communication.
 *
 * Both RestClient and XmdsClient implement this interface identically.
 * PlayerCore calls these methods without knowing which transport is underneath.
 * ProtocolDetector selects the implementation at startup.
 *
 * This file provides:
 *   1. JSDoc type definitions for the interface
 *   2. CMS_CLIENT_METHODS — canonical list of required methods
 *   3. assertCmsClient() — runtime conformance check
 *
 * @example
 *   import { ProtocolDetector, RestClient, XmdsClient } from '@xiboplayer/xmds';
 *
 *   const detector = new ProtocolDetector(cmsUrl, RestClient, XmdsClient);
 *   const { client } = await detector.detect(config);
 *   // client implements CmsClient — PlayerCore doesn't care which one
 */

/**
 * @typedef {Object} RegisterDisplayResult
 * @property {string} code - 'READY' or error code
 * @property {string} message - Human-readable status message
 * @property {Object|null} settings - Display settings (null if not READY)
 * @property {string[]} tags - Display tags
 * @property {Array<{commandCode: string, commandString: string}>} commands - Scheduled commands
 * @property {Object} displayAttrs - Server-provided attributes (date, timezone, status)
 * @property {string} checkRf - CRC checksum for RequiredFiles (skip if unchanged)
 * @property {string} checkSchedule - CRC checksum for Schedule (skip if unchanged)
 * @property {Object|null} syncConfig - Multi-display sync configuration
 */

/**
 * @typedef {Object} RequiredFilesResult
 * @property {Array<{type: string, id: string, size: number, md5: string, download: string, path: string, saveAs: string|null}>} files
 * @property {Array<{id: string, storedAs: string}>} purge - Files to delete
 */

/**
 * @typedef {Object} CmsClient
 * @property {() => Promise<RegisterDisplayResult>} registerDisplay
 * @property {() => Promise<RequiredFilesResult>} requiredFiles
 * @property {() => Promise<Object>} schedule
 * @property {(layoutId: string, regionId: string, mediaId: string) => Promise<string>} getResource
 * @property {(status: Object) => Promise<any>} notifyStatus
 * @property {(inventoryXml: string|Array) => Promise<any>} mediaInventory
 * @property {(mediaId: string, type: string, reason: string) => Promise<boolean>} blackList
 * @property {(logXml: string|Array, hardwareKeyOverride?: string) => Promise<boolean>} submitLog
 * @property {(base64Image: string) => Promise<boolean>} submitScreenShot
 * @property {(statsXml: string|Array, hardwareKeyOverride?: string) => Promise<boolean>} submitStats
 * @property {(faultJson: string|Object) => Promise<boolean>} reportFaults
 * @property {() => Promise<Object>} getWeather
 */

/**
 * Canonical list of methods that every CmsClient implementation must provide.
 * Used for runtime conformance checks and test assertions.
 */
export const CMS_CLIENT_METHODS = [
  'registerDisplay',
  'requiredFiles',
  'schedule',
  'getResource',
  'notifyStatus',
  'mediaInventory',
  'blackList',
  'submitLog',
  'submitScreenShot',
  'submitStats',
  'reportFaults',
  'getWeather',
];

/**
 * Verify that an object implements the CmsClient interface.
 * Throws if any required method is missing or not a function.
 *
 * @param {any} client - Object to check
 * @param {string} [label] - Label for error messages (e.g. 'RestClient')
 * @throws {Error} If the client doesn't conform
 */
export function assertCmsClient(client, label = 'client') {
  for (const method of CMS_CLIENT_METHODS) {
    if (typeof client[method] !== 'function') {
      throw new Error(`${label} missing CmsClient method: ${method}()`);
    }
  }
}
