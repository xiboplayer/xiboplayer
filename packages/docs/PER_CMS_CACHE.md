# Per-CMS Cache and Config Storage

## Problem

Both the media cache and the player configuration are stored as flat, single-CMS structures:

- **Media cache** (`ContentStore`): `~/.local/share/xiboplayer/{electron,chromium}/media/`
- **Config** (`Config` class): single `xibo_config` key in `localStorage`

When switching between CMS servers (production vs staging, or managing multiple clients), several issues arise:

1. **Media ID collisions** — different CMS instances can assign the same media IDs to different files, causing incorrect content to be served from cache
2. **Cache invalidation on switch** — switching CMS effectively invalidates the entire cache since all stored content belongs to the previous CMS
3. **Lost cache on switch-back** — returning to a previously configured CMS means re-downloading all media from scratch
4. **Lost config on switch** — CMS-specific settings (`cmsKey`, `displayName`, `xmrChannel`) are overwritten, requiring re-registration when switching back

## What Changes Per-CMS vs What Stays Global

The `hardwareKey` is generated once on first launch (`crypto.randomUUID()` prefixed with `pwa-`) and identifies the physical display device. It never changes because the CMS uses it to recognize which display is connecting — if it changed, the CMS would see a new unknown display instead of the previously registered one. The same display connects to different CMS servers with the same identity, just as a laptop keeps the same MAC address regardless of which Wi-Fi network it joins.

RSA keys (`xmrPubKey`, `xmrPrivKey`) are tied to the `hardwareKey` and used for XMR message encryption. They must stay the same across CMS switches.

| Data | Storage | Per-CMS? | Why |
|------|---------|----------|-----|
| `hardwareKey` | localStorage + IndexedDB | **No** | Identifies the physical display, generated once, never changes |
| `xmrPubKey`, `xmrPrivKey` | localStorage + IndexedDB | **No** | Tied to hardwareKey, used for XMR encryption |
| `cmsUrl` | localStorage | **Yes** | Each CMS has a different URL |
| `cmsKey` | localStorage | **Yes** | Server-side auth key, unique per CMS |
| `displayName` | localStorage | **Yes** | Assigned by each CMS on registration |
| `xmrChannel` | localStorage | **Yes** | Derived from CMS registration |
| `googleGeoApiKey` | localStorage | **No** | API key is display-level, not CMS-specific |
| Media cache | Filesystem | **Yes** | Media IDs are CMS-scoped, collide across servers |

## Proposed Solution

### 1. Per-CMS Media Cache

Namespace the cache directory by a CMS origin identifier derived from the CMS URL.

#### Directory Structure

```
~/.local/share/xiboplayer/{electron,chromium}/cache/{cms-id}/media/
```

Where `{cms-id}` is `{hostname}-{sha256-first-12}`, e.g.:

- `https://cms.example.com` → `cms.example.com-a1b2c3d4e5f6/`
- `https://staging.example.com` → `staging.example.com-7g8h9i0j1k2l/`
- `https://192.168.1.100:8080` → `192.168.1.100-m3n4o5p6q7r8/`

The human-readable hostname prefix makes it easy to identify directories when debugging. The hash suffix ensures uniqueness even if two CMS instances share a hostname on different ports.

#### Key Change Point

In `proxy.js` (line ~257), the store is currently created as:

```js
new ContentStore(path.join(dataDir, 'media'))
```

This becomes:

```js
const cmsId = computeCmsId(cmsConfig.cmsUrl);
new ContentStore(path.join(dataDir, 'cache', cmsId, 'media'))
```

### 2. Per-CMS Config

Change `localStorage` from a single `xibo_config` key to a namespaced structure:

```
Current:   localStorage['xibo_config'] = { cmsUrl, cmsKey, displayName, hardwareKey, ... }

Proposed:  localStorage['xibo_global']  = { hardwareKey, xmrPubKey, xmrPrivKey, googleGeoApiKey }
           localStorage['xibo_cms:{cms-id}'] = { cmsUrl, cmsKey, displayName, xmrChannel }
           localStorage['xibo_active_cms'] = '{cms-id}'
```

#### Config class changes

The `Config` class (`packages/utils/src/config.js`) needs to:

1. Split `load()` to read global keys from `xibo_global` and CMS-specific keys from `xibo_cms:{active-cms-id}`
2. Split `save()` to write to the appropriate key based on which property changed
3. Add `switchCms(cmsUrl)` method that:
   - Saves current CMS-specific config
   - Computes `cms-id` for the new CMS URL
   - Loads existing config for that CMS (if previously registered) or starts fresh
   - Updates `xibo_active_cms`
4. Add `listCmsProfiles()` method that returns all known CMS configs

## Files Affected

| File | Change |
|------|--------|
| `packages/proxy/src/content-store.js` | Base path construction — accept CMS-namespaced root |
| `packages/proxy/src/proxy.js` | Store initialization — compute `cms-id` from CMS URL, pass to `ContentStore` |
| `packages/utils/src/config.js` | Split storage into global + per-CMS, add `switchCms()` and `listCmsProfiles()` |
| `packages/pwa/src/main.ts` | Pass `cms-id` to proxy on init |

## Benefits

- **Multi-CMS without cache loss** — switch between production, staging, and client CMS instances without re-downloading media
- **No re-registration on switch-back** — display name, CMS key, and XMR channel are preserved per CMS
- **Safe A/B testing** — test against staging CMS, switch back to production with full cache and config intact
- **No media ID collisions** — each CMS has its own namespace
- **Zero-downtime migration** — existing cache and config are moved, not deleted
- **Same hardware identity** — the display always presents the same hardwareKey to every CMS

## Future Enhancements

- **Content-addressable storage** — deduplicate media by MD5 checksum. Store file blobs in a shared `blobs/{md5}.bin` directory; per-CMS media entries become lightweight references (`meta.json` pointing to the blob). This saves disk space in two scenarios: (1) the same media uploaded to the CMS under different names or IDs (common — same video re-uploaded for different campaigns), and (2) the same media shared across CMS instances. The CMS already provides MD5 checksums for every file, so no extra hashing is needed. Cleanup requires refcounting — a blob is only deleted when no CMS profile references it.
- **Cache pre-warming** — pre-populate cache for a known CMS before switching to it
- **Per-CMS cache size limits** — manage disk usage per CMS independently
- **CMS profile UI** — show configured CMS profiles, switch between them, delete stale ones
- **Automatic cleanup** — remove cache dirs and config for CMS servers not used in N days
