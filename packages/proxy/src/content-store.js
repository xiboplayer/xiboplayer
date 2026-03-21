// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * ContentStore — Filesystem-backed content storage for @xiboplayer/proxy
 *
 * Stores all player content (media, layouts, widgets, static resources) on disk
 * so they survive Service Worker updates, browser cache eviction, and process
 * restarts. Every deployment (Electron, Chromium kiosk, deployed PWA server)
 * runs the proxy, making this the single durable storage layer.
 *
 * File layout (mirrors CMS URL structure):
 *   {storeDir}/
 *     ${PLAYER_API}/
 *       media/42.bin                    — whole file (small media)
 *       media/42.meta.json              — { size, contentType, md5, createdAt }
 *       media/456/chunk-0.bin           — chunked file directory (large media)
 *       media/456/meta.json             — { size, numChunks, chunkSize, complete }
 *       dependencies/fonts.css.bin      — dependency files (by filename)
 *       dependencies/Aileron.otf.bin
 *     widget/...                        — widget HTML (legacy path)
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '@xiboplayer/utils';

const log = createLogger('ContentStore');

/**
 * Sanitize a store key into a safe relative path.
 * Accepts CMS URL paths (${PLAYER_API}/media/42). Strips leading slashes only.
 */
function keyToRelative(key) {
  return key.replace(/^\/+/, '');
}

export class ContentStore {
  /**
   * @param {string} storeDir — absolute path to store root (e.g. ~/.local/share/xiboplayer/electron/media)
   */
  constructor(storeDir) {
    this.storeDir = storeDir;
    /** @type {Set<string>} Paths currently being written (prevents concurrent writes to same chunk) */
    this._writeLocks = new Set();
  }

  /** Check if a chunk write is currently in progress */
  isWriteLocked(key, chunkIndex) {
    const lockKey = chunkIndex != null ? this._chunkPath(key, chunkIndex) : this._filePath(key);
    return this._writeLocks.has(lockKey);
  }

  /** Ensure the store directory exists */
  init() {
    fs.mkdirSync(this.storeDir, { recursive: true });
    log.info(`Initialized: ${this.storeDir}`);
  }

  // ── Path helpers ──────────────────────────────────────────────────

  /** Absolute path for a whole file */
  _filePath(key) {
    return path.join(this.storeDir, keyToRelative(key) + '.bin');
  }

  /** Absolute path for metadata sidecar */
  _metaPath(key) {
    const rel = keyToRelative(key);
    // Chunked files store meta inside the directory
    const chunkDir = path.join(this.storeDir, rel);
    if (fs.existsSync(chunkDir) && fs.statSync(chunkDir).isDirectory()) {
      return path.join(chunkDir, 'meta.json');
    }
    return path.join(this.storeDir, rel + '.meta.json');
  }

  /** Absolute path for a chunk */
  _chunkPath(key, chunkIndex) {
    return path.join(this.storeDir, keyToRelative(key), `chunk-${chunkIndex}.bin`);
  }

  /** Absolute path for chunk metadata */
  _chunkMetaPath(key) {
    return path.join(this.storeDir, keyToRelative(key), 'meta.json');
  }

  // ── Existence checks ──────────────────────────────────────────────

  /**
   * Check if a file exists on disk (whole or chunked).
   * @param {string} key
   * @returns {{ exists: boolean, chunked: boolean, metadata: object|null }}
   */
  has(key) {
    // Check whole file first
    if (fs.existsSync(this._filePath(key))) {
      return { exists: true, chunked: false, metadata: this.getMetadata(key) };
    }
    // Check chunked directory
    const chunkMeta = this._chunkMetaPath(key);
    if (fs.existsSync(chunkMeta)) {
      const metadata = JSON.parse(fs.readFileSync(chunkMeta, 'utf8'));
      return { exists: true, chunked: true, metadata };
    }
    return { exists: false, chunked: false, metadata: null };
  }

  /** Check if a specific chunk exists */
  hasChunk(key, chunkIndex) {
    return fs.existsSync(this._chunkPath(key, chunkIndex));
  }

  /**
   * Return indices of missing chunks for a chunked file.
   * @param {string} key
   * @returns {number[]} — empty if not chunked or all chunks present
   */
  missingChunks(key) {
    const metaPath = this._chunkMetaPath(key);
    if (!fs.existsSync(metaPath)) return [];
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta.numChunks) return [];
    const missing = [];
    for (let i = 0; i < meta.numChunks; i++) {
      if (!fs.existsSync(this._chunkPath(key, i))) missing.push(i);
    }
    return missing;
  }

  // ── Read operations ───────────────────────────────────────────────

  /**
   * Get the absolute path for serving a whole file
   * @returns {string|null}
   */
  getPath(key) {
    const fp = this._filePath(key);
    return fs.existsSync(fp) ? fp : null;
  }

  /**
   * Get a ReadStream for a file, optionally with byte range.
   * Works for both whole files and assembled chunk reads.
   * @param {string} key
   * @param {{ start?: number, end?: number }} [range]
   * @returns {fs.ReadStream|null}
   */
  getReadStream(key, range) {
    const fp = this._filePath(key);
    if (!fs.existsSync(fp)) return null;
    const opts = {};
    if (range) {
      if (range.start != null) opts.start = range.start;
      if (range.end != null) opts.end = range.end;
    }
    return fs.createReadStream(fp, opts);
  }

  /**
   * Get a ReadStream for a specific chunk
   * @param {string} key
   * @param {number} chunkIndex
   * @param {{ start?: number, end?: number }} [range]
   * @returns {fs.ReadStream|null}
   */
  getChunkReadStream(key, chunkIndex, range) {
    const cp = this._chunkPath(key, chunkIndex);
    if (!fs.existsSync(cp)) return null;
    const opts = {};
    if (range) {
      if (range.start != null) opts.start = range.start;
      if (range.end != null) opts.end = range.end;
    }
    return fs.createReadStream(cp, opts);
  }

  /**
   * Read metadata for a file
   * @param {string} key
   * @returns {object|null}
   */
  getMetadata(key) {
    // Try whole-file metadata
    const wholeMetaPath = path.join(this.storeDir, keyToRelative(key) + '.meta.json');
    if (fs.existsSync(wholeMetaPath)) {
      try { return JSON.parse(fs.readFileSync(wholeMetaPath, 'utf8')); } catch { return null; }
    }
    // Try chunked metadata
    const chunkMeta = this._chunkMetaPath(key);
    if (fs.existsSync(chunkMeta)) {
      try { return JSON.parse(fs.readFileSync(chunkMeta, 'utf8')); } catch { return null; }
    }
    return null;
  }

  // ── Write operations ──────────────────────────────────────────────

  /**
   * Store a whole file atomically (write .tmp, rename).
   * @param {string} key
   * @param {Buffer} buffer
   * @param {object} metadata — { contentType, size, md5 }
   */
  put(key, buffer, metadata) {
    const fp = this._filePath(key);
    const metaPath = path.join(this.storeDir, keyToRelative(key) + '.meta.json');
    const tmpPath = fp + '.tmp';

    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, fp);

    const meta = {
      size: buffer.byteLength,
      contentType: metadata.contentType || 'application/octet-stream',
      md5: metadata.md5 || null,
      createdAt: Date.now(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }

  /**
   * Store a single chunk atomically.
   * Creates the chunk directory and writes metadata on first chunk.
   * @param {string} key
   * @param {number} chunkIndex
   * @param {Buffer} buffer
   * @param {object} [metadata] — full file metadata (written on first call)
   */
  putChunk(key, chunkIndex, buffer, metadata) {
    const cp = this._chunkPath(key, chunkIndex);
    const tmpPath = cp + '.tmp';

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, cp);

    // Write/update metadata if provided
    if (metadata) {
      const metaPath = this._chunkMetaPath(key);
      const existing = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        : {};
      const merged = { ...existing, ...metadata, updatedAt: Date.now() };
      if (!merged.createdAt) merged.createdAt = Date.now();
      fs.writeFileSync(metaPath, JSON.stringify(merged));
    }
  }

  /**
   * Mark a chunked file as complete.
   * Called after all chunks are stored.
   * @param {string} key
   */
  markComplete(key) {
    const metaPath = this._chunkMetaPath(key);
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.complete = true;
    meta.completedAt = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }

  /**
   * Unmark a chunked file as complete (keeps all chunks on disk).
   * Used when missing chunks are detected — allows re-download of only missing chunks.
   * @param {string} key
   * @returns {boolean} true if the file was unmarked
   */
  unmarkComplete(key) {
    const metaPath = this._chunkMetaPath(key);
    if (!fs.existsSync(metaPath)) return false;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.complete;
    delete meta.completedAt;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    return true;
  }

  /**
   * Create a temp write stream for streaming data to disk.
   * Returns a WriteStream and a commit() function that atomically
   * renames the temp file and writes metadata.
   *
   * @param {string} key
   * @param {number|null} chunkIndex — null for whole file, number for chunk
   * @returns {{ writeStream: fs.WriteStream, commit: (metadata: object) => void }}
   */
  /**
   * Create a temp-write handle for atomically writing a file or chunk.
   * Returns null if a write is already in progress for this path (prevents
   * concurrent writes to the same chunk — race condition #1).
   *
   * @returns {{ writeStream, commit, abort } | null}
   */
  createTempWrite(key, chunkIndex) {
    let finalPath;
    if (chunkIndex != null) {
      finalPath = this._chunkPath(key, chunkIndex);
    } else {
      finalPath = this._filePath(key);
    }

    // Acquire write lock — reject concurrent writes to same path
    if (this._writeLocks.has(finalPath)) {
      return null;
    }
    this._writeLocks.add(finalPath);

    const tmpPath = finalPath + '.tmp';
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    const writeStream = fs.createWriteStream(tmpPath);
    // Prevent unhandled error crashes (caller attaches its own error handler)
    writeStream.on('error', () => {});

    const releaseLock = () => { this._writeLocks.delete(finalPath); };

    const commit = (metadata) => {
      fs.renameSync(tmpPath, finalPath);
      releaseLock();
      if (chunkIndex != null) {
        // Write/update chunk metadata
        const metaPath = this._chunkMetaPath(key);
        const existing = fs.existsSync(metaPath)
          ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
          : {};
        const merged = { ...existing, ...metadata, updatedAt: Date.now() };
        if (!merged.createdAt) merged.createdAt = Date.now();
        fs.writeFileSync(metaPath, JSON.stringify(merged));
      } else {
        const metaPath = path.join(this.storeDir, keyToRelative(key) + '.meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
          size: metadata.size || 0,
          contentType: metadata.contentType || 'application/octet-stream',
          md5: metadata.md5 || null,
          createdAt: Date.now(),
        }));
      }
    };

    const abort = () => {
      releaseLock();
      try { fs.unlinkSync(tmpPath); } catch {}
    };

    return { writeStream, commit, abort };
  }

  // ── Delete operations ─────────────────────────────────────────────

  /**
   * Delete a file (whole file + metadata, or chunk dir + metadata)
   * @param {string} key
   * @returns {boolean} true if something was deleted
   */
  delete(key) {
    let deleted = false;

    // Whole file
    const fp = this._filePath(key);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      deleted = true;
    }
    const metaPath = path.join(this.storeDir, keyToRelative(key) + '.meta.json');
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
      deleted = true;
    }

    // Chunk directory
    const chunkDir = path.join(this.storeDir, keyToRelative(key));
    if (fs.existsSync(chunkDir) && fs.statSync(chunkDir).isDirectory()) {
      fs.rmSync(chunkDir, { recursive: true, force: true });
      deleted = true;
    }

    return deleted;
  }

  // ── Store statistics ───────────────────────────────────────────────

  /**
   * Get total store size on disk (bytes).
   * Walks the store directory recursively.
   */
  getSize() {
    return this._dirSize(this.storeDir);
  }

  _dirSize(dir) {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += this._dirSize(fp);
      } else {
        total += fs.statSync(fp).size;
      }
    }
    return total;
  }

  /**
   * List all stored files with metadata.
   * Recursively walks the store directory to support deep key structures
   * (e.g. ${PLAYER_API}/media/42.bin).
   * @returns {Array<{ key: string, type: string, id: string, size: number, cachedAt: number, chunked: boolean }>}
   */
  list() {
    const files = [];
    if (!fs.existsSync(this.storeDir)) return files;
    this._walk(this.storeDir, '', files);
    return files;
  }

  /**
   * Recursive walk for list(). Detects .bin files and chunk directories.
   * @param {string} dir - Current directory path
   * @param {string} relPath - Relative path from storeDir
   * @param {Array} files - Accumulator
   */
  _walk(dir, relPath, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith('.meta.json') || entry.name.endsWith('.tmp')) continue;

      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Check if this is a chunk directory (has meta.json inside)
        const chunkMeta = path.join(entryPath, 'meta.json');
        if (fs.existsSync(chunkMeta)) {
          const key = entryRel;
          const meta = this.getMetadata(key);
          // Extract type and id from the key path
          const parts = key.split('/');
          const id = parts[parts.length - 1];
          const type = parts.slice(0, -1).join('/');
          files.push({
            key, type, id,
            size: meta?.size || 0,
            cachedAt: meta?.createdAt || 0,
            chunked: true,
            complete: meta?.complete || false,
          });
        } else {
          // Recurse into subdirectory
          this._walk(entryPath, entryRel, files);
        }
      } else if (entry.name.endsWith('.bin')) {
        const key = entryRel.replace(/\.bin$/, '');
        const meta = this.getMetadata(key);
        const parts = key.split('/');
        const id = parts[parts.length - 1];
        const type = parts.slice(0, -1).join('/');
        files.push({
          key, type, id,
          size: meta?.size || fs.statSync(entryPath).size,
          cachedAt: meta?.createdAt || 0,
          chunked: false,
          complete: true,
        });
      }
    }
  }
}
