/**
 * Configuration management with priority: env vars → localStorage → defaults
 *
 * In Node.js (tests, CLI): environment variables are the only source.
 * In browser (PWA player): localStorage is primary, env vars override if set.
 */
import { generateRsaKeyPair, isValidPemKey } from '@xiboplayer/crypto';

const STORAGE_KEY = 'xibo_config';
const HW_DB_NAME = 'xibo-hw-backup';
const HW_DB_VERSION = 1;

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

    // Try to load from localStorage
    const json = localStorage.getItem(STORAGE_KEY);

    if (json) {
      try {
        const config = JSON.parse(json);

        // CRITICAL: Hardware key must persist
        if (!config.hardwareKey || config.hardwareKey.length < 10) {
          console.error('[Config] CRITICAL: Invalid/missing hardwareKey in localStorage!');
          config.hardwareKey = this.generateStableHardwareKey();
          localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
          this._backupHardwareKey(config.hardwareKey);
        } else {
          console.log('[Config] ✓ Loaded existing hardwareKey:', config.hardwareKey);
        }

        return config;
      } catch (e) {
        console.error('[Config] Failed to parse config from localStorage:', e);
        // Fall through to create new config
      }
    }

    // No config in localStorage - first time setup
    console.log('[Config] No config in localStorage - first time setup');

    const newConfig = {
      cmsUrl: '',
      cmsKey: '',
      displayName: '',
      hardwareKey: this.generateStableHardwareKey(),
      xmrChannel: this.generateXmrChannel()
    };

    // Save immediately
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
    this._backupHardwareKey(newConfig.hardwareKey);
    console.log('[Config] ✓ Saved new config to localStorage');
    console.log('[Config] Hardware key will persist across reloads:', newConfig.hardwareKey);

    return newConfig;
  }

  /**
   * Backup keys to IndexedDB (more persistent than localStorage).
   * IndexedDB survives "Clear site data" in some browsers where localStorage doesn't.
   * @param {Object} keys - Key-value pairs to store (e.g. { hardwareKey: '...', xmrPubKey: '...' })
   */
  _backupKeys(keys) {
    try {
      const req = indexedDB.open(HW_DB_NAME, HW_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('keys', 'readwrite');
        const store = tx.objectStore('keys');
        for (const [k, v] of Object.entries(keys)) {
          store.put(v, k);
        }
        tx.oncomplete = () => {
          console.log('[Config] Keys backed up to IndexedDB:', Object.keys(keys).join(', '));
          db.close();
        };
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
    if (typeof indexedDB === 'undefined') return;
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(HW_DB_NAME, HW_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('keys')) {
            db.createObjectStore('keys');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const tx = db.transaction('keys', 'readonly');
      const store = tx.objectStore('keys');
      const backedUpKey = await new Promise((resolve) => {
        const req = store.get('hardwareKey');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      db.close();

      if (backedUpKey && backedUpKey !== this.data.hardwareKey) {
        console.log('[Config] Restoring hardware key from IndexedDB backup:', backedUpKey);
        console.log('[Config] (was:', this.data.hardwareKey, ')');
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

  save() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    }
  }

  isConfigured() {
    return !!(this.data.cmsUrl && this.data.cmsKey && this.data.displayName);
  }

  generateStableHardwareKey() {
    // Generate a stable UUID-based hardware key
    // CRITICAL: This is generated ONCE and saved to localStorage
    // It NEVER changes unless localStorage is cleared manually

    // Use crypto.randomUUID if available (best randomness)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      const uuid = crypto.randomUUID().replace(/-/g, ''); // Remove dashes
      const hardwareKey = 'pwa-' + uuid.substring(0, 28);
      console.log('[Config] Generated new UUID-based hardware key:', hardwareKey);
      return hardwareKey;
    }

    // Fallback: Generate random hex string
    const randomHex = Array.from({ length: 28 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    const hardwareKey = 'pwa-' + randomHex;
    console.log('[Config] Generated new random hardware key:', hardwareKey);
    return hardwareKey;
  }

  getCanvasFingerprint() {
    // Generate stable canvas fingerprint (same for same GPU/driver)
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'no-canvas';

      // Draw test pattern (same rendering = same device)
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Xibo Player', 2, 15);

      return canvas.toDataURL();
    } catch (e) {
      return 'canvas-error';
    }
  }

  generateHardwareKey() {
    // For backwards compatibility
    return this.generateStableHardwareKey();
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

    console.log('[Config] Generating RSA key pair for XMR registration...');
    const { publicKeyPem, privateKeyPem } = await generateRsaKeyPair();

    this.data.xmrPubKey = publicKeyPem;
    this.data.xmrPrivKey = privateKeyPem;
    this.save();

    // Backup RSA keys to IndexedDB alongside hardware key
    if (typeof indexedDB !== 'undefined') {
      this._backupKeys({ xmrPubKey: publicKeyPem, xmrPrivKey: privateKeyPem });
    }

    console.log('[Config] RSA key pair generated and saved');
  }

  hash(str) {
    // FNV-1a hash algorithm (better distribution than simple hash)
    // Produces high-entropy 32-character hex string
    let hash = 2166136261; // FNV offset basis

    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    // Convert to unsigned 32-bit integer
    hash = hash >>> 0;

    // Extend to 32 characters by hashing multiple times with different seeds
    let result = '';
    for (let round = 0; round < 4; round++) {
      let roundHash = hash + round * 1234567;
      for (let i = 0; i < str.length; i++) {
        roundHash ^= str.charCodeAt(i) + round;
        roundHash += (roundHash << 1) + (roundHash << 4) + (roundHash << 7) + (roundHash << 8) + (roundHash << 24);
      }
      roundHash = roundHash >>> 0;
      result += roundHash.toString(16).padStart(8, '0');
    }

    return result.substring(0, 32);
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
      console.error('[Config] CRITICAL: hardwareKey missing! Generating emergency key.');
      this.data.hardwareKey = this.generateStableHardwareKey();
      this.save();
    }
    return this.data.hardwareKey;
  }
  get xmrChannel() { return this.data.xmrChannel; }
  get xmrPubKey() { return this.data.xmrPubKey || ''; }
  get xmrPrivKey() { return this.data.xmrPrivKey || ''; }

  get googleGeoApiKey() { return this.data.googleGeoApiKey || ''; }
  set googleGeoApiKey(val) { this.data.googleGeoApiKey = val; this.save(); }
}

export const config = new Config();
