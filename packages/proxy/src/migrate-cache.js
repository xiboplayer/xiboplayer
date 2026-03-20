// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * One-time migration: hardlink per-instance content cache to shared cache.
 *
 * Before v0.7.2, each player instance had its own ContentStore at:
 *   ~/.local/share/xiboplayer/{instance}/cache/{cmsId}/media/
 *
 * Since v0.7.2, all instances share a single cache at:
 *   ~/.local/share/xiboplayer/shared/cache/{cmsId}/media/
 *
 * This migration hardlinks files from old paths to the shared path, then
 * removes the old directories. Hardlinks are instant (no data copy) and
 * safe (same filesystem guaranteed — both under ~/.local/share/).
 *
 * Remove this migration after v0.7.3.
 */

import fs from 'fs';
import path from 'path';

/**
 * Migrate per-instance content cache to shared cache via hardlinks.
 *
 * @param {string} dataHome - XDG_DATA_HOME (e.g. ~/.local/share)
 */
export function migrateContentCache(dataHome) {
  const xiboplayer = path.join(dataHome, 'xiboplayer');
  const sharedDir = path.join(xiboplayer, 'shared');

  if (!fs.existsSync(xiboplayer)) return;

  let migrated = 0;
  let removed = 0;

  // Find all old instance dirs that have a cache/ subdirectory
  let entries;
  try {
    entries = fs.readdirSync(xiboplayer, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'shared') continue;

    const instanceDir = path.join(xiboplayer, entry.name);

    // Check for cache/ subdirectory (namespaced path)
    const cacheDir = path.join(instanceDir, 'cache');
    if (fs.existsSync(cacheDir)) {
      migrated += hardlinkTree(cacheDir, path.join(sharedDir, 'cache'));
      safeRemove(cacheDir);
      removed++;
    }

    // Check for legacy media/ subdirectory (flat path, pre-per-CMS)
    const mediaDir = path.join(instanceDir, 'media');
    if (fs.existsSync(mediaDir)) {
      migrated += hardlinkTree(mediaDir, path.join(sharedDir, 'media'));
      safeRemove(mediaDir);
      removed++;
    }

    // Remove the instance dir if empty (only had cache/media)
    tryRemoveEmpty(instanceDir);
  }

  if (migrated > 0) {
    console.log(`[Migration] Hardlinked ${migrated} files from ${removed} old cache dirs to shared/`);
  }
}

/**
 * Recursively hardlink all files from src to dest, preserving directory structure.
 * Creates dest directories as needed. Skips files that already exist at dest.
 *
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @returns {number} Number of files hardlinked
 */
function hardlinkTree(src, dest) {
  let count = 0;

  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (_) {
    return 0;
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      count += hardlinkTree(srcPath, destPath);
    } else if (entry.isFile()) {
      if (fs.existsSync(destPath)) continue; // Already exists in shared
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      try {
        fs.linkSync(srcPath, destPath);
        count++;
      } catch (e) {
        // Cross-device link not supported — fall back to copy
        if (e.code === 'EXDEV') {
          fs.copyFileSync(srcPath, destPath);
          count++;
        }
        // Other errors (permission, etc.) — skip silently
      }
    }
  }

  return count;
}

/**
 * Recursively remove a directory tree.
 */
function safeRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best effort — don't fail if removal fails
  }
}

/**
 * Remove a directory only if it's empty.
 */
function tryRemoveEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
    }
  } catch (_) {}
}
