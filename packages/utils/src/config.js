// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Configuration management with priority: env vars → localStorage → defaults
 *
 * Storage layout (per-CMS namespacing):
 *   xibo_global       — device identity: hardwareKey, xmrPubKey, xmrPrivKey
 *   xibo_cms:{cmsId}  — CMS-scoped: cmsUrl, cmsKey, displayName, xmrChannel, ...
 *   xibo_active_cms   — string cmsId of the currently active CMS
 *   xibo_config       — legacy flat key (written for rollback compatibility)
 *
 * In Node.js (tests, CLI): environment variables are the only source.
 * In browser (PWA player): localStorage is primary, env vars override if set.
 */
import { generateRsaKeyPair, isValidPemKey } from '@xiboplayer/crypto';
import { openIDB } from './idb.js';
import { createLogger } from './logger.js';

const log = createLogger('Config');

const GLOBAL_KEY = 'xibo_global';         // Device identity (all CMSes)
const CMS_PREFIX = 'xibo_cms:';           // Per-CMS config prefix
const ACTIVE_CMS_KEY = 'xibo_active_cms'; // Active CMS ID
const HW_DB_NAME = 'xibo-hw-backup';
const HW_DB_VERSION = 1;

// Keys that belong to device identity (global, not CMS-scoped)
const GLOBAL_KEYS = new Set(['hardwareKey', 'xmrPubKey', 'xmrPrivKey']);

/**
 * FNV-1a hash producing a 12-character hex string.
 * Deterministic: same input always produces same output.
 * @param {string} str - Input string to hash
 * @returns {string} 12-character lowercase hex string
 */
export function fnvHash(str) {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  hash = hash >>> 0;

  // Extend to 12 chars with a second round using a different seed
  let hash2 = hash + 1234567;
  for (let i = 0; i < str.length; i++) {
    hash2 ^= str.charCodeAt(i) + 1;
    hash2 += (hash2 << 1) + (hash2 << 4) + (hash2 << 7) + (hash2 << 8) + (hash2 << 24);
  }
  hash2 = hash2 >>> 0;

  return (hash.toString(16).padStart(8, '0') + hash2.toString(16).padStart(8, '0')).substring(0, 12);
}

/**
 * Compute a deterministic CMS ID from a CMS URL.
 * Format: {hostname}-{fnvHash12}
 *
 * @param {string} cmsUrl - Full CMS URL (e.g. "https://displays.superpantalles.com")
 * @returns {string} CMS ID (e.g. "displays.superpantalles.com-a1b2c3d4e5f6")
 */
export function computeCmsId(cmsUrl) {
  if (!cmsUrl) return null;
  try {
    const url = new URL(cmsUrl);
    const origin = url.origin;
    return `${url.hostname}-${fnvHash(origin)}`;
  } catch (e) {
    // Invalid URL — hash the raw string
    return `unknown-${fnvHash(cmsUrl)}`;
  }
}

/**
 * Check for environment variable config (highest priority).
 * Env vars: CMS_URL, CMS_KEY, DISPLAY_NAME, HARDWARE_KEY, XMR_CHANNEL
 * Returns config object if any env vars are set, null otherwise.
 */
function loadFromEnv() {
  // Check if process.env is available (Node.js or bundler injection)
  const env = typeof process !== 'undefined' && process.env ? process.env : {};

  const envConfig = {
    cmsUrl: env.CMS_URL || '',
    cmsKey: env.CMS_KEY || '',
    displayName: env.DISPLAY_NAME || '',
    hardwareKey: env.HARDWARE_KEY || '',
    xmrChannel: env.XMR_CHANNEL || '',
    googleGeoApiKey: env.GOOGLE_GEO_API_KEY || '',
  };

  // Return env config if any value is set
  const hasEnvValues = Object.values(envConfig).some(v => v !== '');
  return hasEnvValues ? envConfig : null;
}

export class Config {
  constructor() {
    this._activeCmsId = null;
    this.data = this.load();
    // Async: try to restore hardware key from IndexedDB if localStorage lost it
    // (only when not running from env vars)
    if (!this._fromEnv) {
      this._restoreHardwareKeyFromBackup();
    }
  }

  load() {
    // Priority 1: Environment variables (Node.js, tests, CI)
    const envConfig = loadFromEnv();
    if (envConfig) {
      this._fromEnv = true;
      return envConfig;
    }

    // Priority 2: localStorage (browser)
    if (typeof localStorage === 'undefined') {
      return { cmsUrl: '', cmsKey: '', displayName: '', hardwareKey: '', xmrChannel: '' };
    }

    // Load from split storage (or fresh install)
    const globalJson = localStorage.getItem(GLOBAL_KEY);

    if (globalJson) {
      return this._loadSplit();
    }

    // Fresh install — no config at all
    return this._loadFresh();
  }

  /**
   * Load from split storage (new format).
   * Merges xibo_global + xibo_cms:{activeCmsId} into a single data object.
   */
  _loadSplit() {
    let global = {};
    try {
      global = JSON.parse(localStorage.getItem(GLOBAL_KEY) || '{}');
    } catch (e) {
      log.error('Failed to parse xibo_global:', e);
    }

    // Determine active CMS
    const activeCmsId = localStorage.getItem(ACTIVE_CMS_KEY) || null;
    this._activeCmsId = activeCmsId;

    let cmsConfig = {};
    if (activeCmsId) {
      try {
        const cmsJson = localStorage.getItem(CMS_PREFIX + activeCmsId);
        if (cmsJson) cmsConfig = JSON.parse(cmsJson);
      } catch (e) {
        log.error('Failed to parse CMS config:', e);
      }
    }

    // Merge global + CMS-scoped
    const config = { ...global, ...cmsConfig };

    // Validate and generate missing keys
    return this._validateConfig(config);
  }

  /**
   * Fresh install — no existing config.
   */
  _loadFresh() {
    const config = {};
    return this._validateConfig(config);
  }

  /**
   * Validate config, generate missing hardwareKey/xmrChannel.
   * Shared by all load paths.
   */
  _validateConfig(config) {
    let changed = false;

    if (!config.hardwareKey || config.hardwareKey.length < 10) {
      log.warn('Missing/invalid hardwareKey — generating');
      config.hardwareKey = this.generateStableHardwareKey();
      this._backupHardwareKey(config.hardwareKey);
      changed = true;
    } else {
      log.info('✓ Loaded existing hardwareKey:', config.hardwareKey);
    }

    if (!config.xmrChannel) {
      log.warn('Missing xmrChannel — generating');
      config.xmrChannel = this.generateXmrChannel();
      changed = true;
    }

    // Ensure optional fields have defaults
    config.cmsUrl = config.cmsUrl || '';
    config.cmsKey = config.cmsKey || '';
    config.displayName = config.displayName || '';

    if (changed && typeof localStorage !== 'undefined') {
      // Save via split storage
      this._saveSplit(config);
    }

    return config;
  }

  save() {
    if (typeof localStorage === 'undefined') return;
    this._saveSplit(this.data);
  }

  /**
   * Write data to split storage: xibo_global + xibo_cms:{id} + legacy xibo_config.
   */
  _saveSplit(data) {
    if (typeof localStorage === 'undefined') return;

    // Split into global and CMS-scoped
    const global = {};
    const cmsScoped = {};
    for (const [key, value] of Object.entries(data)) {
      if (GLOBAL_KEYS.has(key)) {
        global[key] = value;
      } else {
        cmsScoped[key] = value;
      }
    }

    localStorage.setItem(GLOBAL_KEY, JSON.stringify(global));

    // Compute CMS ID (may update if cmsUrl changed)
    const cmsId = computeCmsId(data.cmsUrl);
    if (cmsId) {
      localStorage.setItem(CMS_PREFIX + cmsId, JSON.stringify(cmsScoped));
      localStorage.setItem(ACTIVE_CMS_KEY, cmsId);
      this._activeCmsId = cmsId;
    }

    // Legacy flat key for rollback compatibility (index.html gate, tests, etc.)
    localStorage.setItem('xibo_config', JSON.stringify(data));
  }

  /**
   * Switch to a different CMS. Saves the current CMS profile,
   * loads (or creates) the target CMS profile.
   *
   * @param {string} cmsUrl - New CMS URL to switch to
   * @returns {{ cmsId: string, isNew: boolean }} The new CMS ID and whether it was newly created
   */
  switchCms(cmsUrl) {
    if (typeof localStorage === 'undefined') {
      throw new Error('switchCms requires localStorage (browser only)');
    }

    // Save current state
    this.save();

    const newCmsId = computeCmsId(cmsUrl);
    if (!newCmsId) throw new Error('Invalid CMS URL');

    // Try to load existing CMS profile
    const existingJson = localStorage.getItem(CMS_PREFIX + newCmsId);
    let cmsConfig = {};
    let isNew = true;

    if (existingJson) {
      try {
        cmsConfig = JSON.parse(existingJson);
        isNew = false;
        log.info(`Switching to existing CMS profile: ${newCmsId}`);
      } catch (e) {
        log.error('Failed to parse target CMS config:', e);
      }
    } else {
      log.info(`Creating new CMS profile: ${newCmsId}`);
      cmsConfig = {
        cmsUrl,
        cmsKey: '',
        displayName: '',
        xmrChannel: this.generateXmrChannel(),
      };
      localStorage.setItem(CMS_PREFIX + newCmsId, JSON.stringify(cmsConfig));
    }

    // Update active CMS
    localStorage.setItem(ACTIVE_CMS_KEY, newCmsId);
    this._activeCmsId = newCmsId;

    // Merge global + new CMS config into data
    let global = {};
    try {
      global = JSON.parse(localStorage.getItem(GLOBAL_KEY) || '{}');
    } catch (_) {}

    this.data = { ...global, ...cmsConfig };

    // Ensure cmsUrl is set (in case the profile was pre-existing without it)
    if (!this.data.cmsUrl) {
      this.data.cmsUrl = cmsUrl;
    }

    return { cmsId: newCmsId, isNew };
  }

  /**
   * List all CMS profiles stored in localStorage.
   * @returns {Array<{ cmsId: string, cmsUrl: string, displayName: string, isActive: boolean }>}
   */
  listCmsProfiles() {
    if (typeof localStorage === 'undefined') return [];

    const profiles = [];
    const activeCmsId = localStorage.getItem(ACTIVE_CMS_KEY) || null;

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(CMS_PREFIX)) continue;

      const cmsId = key.slice(CMS_PREFIX.length);
      try {
        const data = JSON.parse(localStorage.getItem(key));
        profiles.push({
          cmsId,
          cmsUrl: data.cmsUrl || '',
          displayName: data.displayName || '',
          isActive: cmsId === activeCmsId,
        });
      } catch (_) {}
    }

    return profiles;
  }

  /**
   * Get the active CMS ID (deterministic hash of the CMS URL origin).
   * Returns null if no CMS is configured.
   * @returns {string|null}
   */
  get activeCmsId() {
    // Return cached value if available
    if (this._activeCmsId) return this._activeCmsId;
    // Compute from current cmsUrl
    const id = computeCmsId(this.data?.cmsUrl);
    this._activeCmsId = id;
    return id;
  }

  isConfigured() {
    return !!(this.data.cmsUrl && this.data.cmsKey && this.data.displayName);
  }

  /**
   * Backup keys to IndexedDB (more persistent than localStorage).
   * IndexedDB survives "Clear site data" in some browsers where localStorage doesn't.
   * @param {Object} keys - Key-value pairs to store (e.g. { hardwareKey: '...', xmrPubKey: '...' })
   */
  async _backupKeys(keys) {
    try {
      const db = await openIDB(HW_DB_NAME, HW_DB_VERSION, 'keys');
      const tx = db.transaction('keys', 'readwrite');
      const store = tx.objectStore('keys');
      for (const [k, v] of Object.entries(keys)) {
        store.put(v, k);
      }
      tx.oncomplete = () => {
        log.info('Keys backed up to IndexedDB:', Object.keys(keys).join(', '));
        db.close();
      };
    } catch (e) {
      // IndexedDB not available — localStorage-only mode
    }
  }

  /**
   * Backup hardware key to IndexedDB (convenience wrapper).
   */
  _backupHardwareKey(key) {
    this._backupKeys({ hardwareKey: key });
  }

  /**
   * Restore hardware key from IndexedDB if localStorage was cleared.
   * Runs async after construction — if a backed-up key is found and
   * differs from the current one, it restores the original key.
   */
  async _restoreHardwareKeyFromBackup() {
    try {
      const db = await openIDB(HW_DB_NAME, HW_DB_VERSION, 'keys');

      const tx = db.transaction('keys', 'readonly');
      const store = tx.objectStore('keys');
      const backedUpKey = await new Promise((resolve) => {
        const req = store.get('hardwareKey');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      db.close();

      if (backedUpKey && backedUpKey !== this.data.hardwareKey) {
        log.info('Restoring hardware key from IndexedDB backup:', backedUpKey);
        log.info('(was:', this.data.hardwareKey, ')');
        this.data.hardwareKey = backedUpKey;
        this.save();
      } else if (!backedUpKey && this.data.hardwareKey) {
        // No backup yet — save current key as backup
        this._backupHardwareKey(this.data.hardwareKey);
      }
    } catch (e) {
      // IndexedDB not available — that's fine
    }
  }

  generateStableHardwareKey() {
    // Generate a stable UUID-based hardware key
    // CRITICAL: This is generated ONCE and saved to localStorage
    // It NEVER changes unless localStorage is cleared manually

    // Use crypto.randomUUID if available (best randomness)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      const uuid = crypto.randomUUID().replace(/-/g, ''); // Remove dashes
      const hardwareKey = 'pwa-' + uuid.substring(0, 28);
      log.info('Generated new UUID-based hardware key:', hardwareKey);
      return hardwareKey;
    }

    // Fallback: Generate random hex string
    const randomHex = Array.from({ length: 28 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const hardwareKey = 'pwa-' + randomHex;
    log.info('Generated new random hardware key:', hardwareKey);
    return hardwareKey;
  }

  generateXmrChannel() {
    // Generate UUID for XMR channel
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Ensure an RSA key pair exists for XMR registration.
   * If keys are missing or invalid, generates a new pair and persists them.
   * Idempotent — safe to call multiple times.
   */
  async ensureXmrKeyPair() {
    if (this.data.xmrPubKey && isValidPemKey(this.data.xmrPubKey)) {
      return;
    }

    log.info('Generating RSA key pair for XMR registration...');
    const { publicKeyPem, privateKeyPem } = await generateRsaKeyPair();

    this.data.xmrPubKey = publicKeyPem;
    this.data.xmrPrivKey = privateKeyPem;
    this.save();

    // Backup RSA keys to IndexedDB alongside hardware key
    if (typeof indexedDB !== 'undefined') {
      this._backupKeys({ xmrPubKey: publicKeyPem, xmrPrivKey: privateKeyPem });
    }

    log.info('RSA key pair generated and saved');
  }

  get cmsUrl() { return this.data.cmsUrl; }
  set cmsUrl(val) { this.data.cmsUrl = val; this.save(); }

  get cmsKey() { return this.data.cmsKey; }
  set cmsKey(val) { this.data.cmsKey = val; this.save(); }

  get displayName() { return this.data.displayName; }
  set displayName(val) { this.data.displayName = val; this.save(); }

  get hardwareKey() {
    // CRITICAL: Ensure hardware key never becomes undefined
    if (!this.data.hardwareKey) {
      log.error('CRITICAL: hardwareKey missing! Generating emergency key.');
      this.data.hardwareKey = this.generateStableHardwareKey();
      this.save();
    }
    return this.data.hardwareKey;
  }
  get xmrChannel() {
    if (!this.data.xmrChannel) {
      log.warn('xmrChannel missing at access time — generating');
      this.data.xmrChannel = this.generateXmrChannel();
      this.save();
    }
    return this.data.xmrChannel;
  }
  get xmrPubKey() { return this.data.xmrPubKey || ''; }
  get xmrPrivKey() { return this.data.xmrPrivKey || ''; }

  get googleGeoApiKey() { return this.data.googleGeoApiKey || ''; }
  set googleGeoApiKey(val) { this.data.googleGeoApiKey = val; this.save(); }

  get controls() { return this.data.controls || {}; }
  get transport() { return this.data.transport || 'auto'; }
  get debug() { return this.data.debug || {}; }
}

export const config = new Config();

/**
 * Shell-only config keys common to ALL player shells (Electron, Chromium, etc.).
 * These control the native shell window/process and must NOT be forwarded to the PWA.
 *
 * Each shell may have additional shell-specific keys — pass them as extraShellKeys
 * to extractPwaConfig().
 *
 * Electron extras:  autoLaunch
 * Chromium extras:  browser, extraBrowserFlags
 */
/**
 * Keys that are specific to a particular shell platform.
 * Used by warnPlatformMismatch() to detect config.json mistakes.
 */
const PLATFORM_KEYS = {
  kioskMode:          ['electron', 'chromium'],
  autoLaunch:         ['electron'],
  allowShellCommands: ['electron', 'chromium'],
  browser:            ['chromium'],
  extraBrowserFlags:  ['chromium'],
};

/**
 * Log warnings for config keys that don't belong to the current platform.
 * Informational only — does not prevent startup.
 *
 * @param {Object} configObj - The full config.json object
 * @param {string} platform - Current platform: 'electron' or 'chromium'
 */
export function warnPlatformMismatch(configObj, platform) {
  if (!configObj || !platform) return;
  const p = platform.toLowerCase();
  for (const [key, platforms] of Object.entries(PLATFORM_KEYS)) {
    if (key in configObj && !platforms.includes(p)) {
      log.warn(
        `Key "${key}" is only supported on ${platforms.join('/')}, ` +
        `but current platform is ${p} — this key will be ignored`
      );
    }
  }
}

export const SHELL_ONLY_KEYS = new Set([
  'serverPort',
  'kioskMode',
  'fullscreen',
  'hideMouseCursor',
  'preventSleep',
  'allowShellCommands',
  'width',
  'height',
  'relaxSslCerts',
]);

/**
 * Extract PWA config from a full shell config.json.
 *
 * Uses a deny-list approach: filters out shell-only keys, passes everything else.
 * This is future-proof — new config.json fields automatically reach the PWA
 * without code changes in each shell.
 *
 * @param {Object} config - Full config object from config.json
 * @param {Iterable<string>} [extraShellKeys] - Additional shell-specific keys to exclude
 * @returns {Object} Config to pass to the PWA (via proxy pwaConfig)
 */
export function extractPwaConfig(config, extraShellKeys) {
  const exclude = new Set([...SHELL_ONLY_KEYS, ...(extraShellKeys || [])]);
  const pwaConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (!exclude.has(key)) {
      pwaConfig[key] = value;
    }
  }
  return Object.keys(pwaConfig).length > 0 ? pwaConfig : undefined;
}
