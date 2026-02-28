# Per-CMS Cache Storage

## Problem

The `ContentStore` stores all media under a single flat path per platform:

```
~/.local/share/xiboplayer/electron/media/
~/.local/share/xiboplayer/chromium/media/
```

When switching between CMS servers (production vs staging, or managing multiple clients), several issues arise:

1. **Media ID collisions** — different CMS instances can assign the same media IDs to different files, causing incorrect content to be served from cache
2. **Cache invalidation on switch** — switching CMS effectively invalidates the entire cache since all stored content belongs to the previous CMS
3. **Lost cache on switch-back** — returning to a previously configured CMS means re-downloading all media from scratch

## Proposed Solution

Namespace the cache directory by a CMS origin identifier derived from the CMS URL.

### Directory Structure

```
~/.local/share/xiboplayer/{electron,chromium}/cache/{cms-id}/media/
```

Where `{cms-id}` is `{hostname}-{sha256-first-12}`, e.g.:

- `https://cms.example.com` → `cms.example.com-a1b2c3d4e5f6/`
- `https://staging.example.com` → `staging.example.com-7g8h9i0j1k2l/`
- `https://192.168.1.100:8080` → `192.168.1.100-m3n4o5p6q7r8/`

The human-readable hostname prefix makes it easy to identify directories when debugging. The hash suffix ensures uniqueness even if two CMS instances share a hostname on different ports.

### Files Affected

| File | Change |
|------|--------|
| `packages/proxy/src/content-store.js` | Base path construction — accept CMS-namespaced root |
| `packages/proxy/src/proxy.js` | Store initialization — compute `cms-id` from CMS URL, pass to `ContentStore` |
| Config handling | Persist current `cms-id` so the proxy knows which cache dir to use at startup |

### Key Change Point

In `proxy.js` (line ~257), the store is currently created as:

```js
new ContentStore(path.join(dataDir, 'media'))
```

This becomes:

```js
const cmsId = computeCmsId(cmsConfig.cmsUrl);
new ContentStore(path.join(dataDir, 'cache', cmsId, 'media'))
```

The `cmsConfig` is already available alongside `dataDir` in the proxy startup path.

## Migration Strategy

On first run with the new code:

1. Detect legacy flat `media/` directory at the old path
2. Compute `cms-id` for the currently configured CMS
3. Create the new namespaced directory
4. Move existing `media/` contents into `cache/{cms-id}/media/`
5. Log the migration for visibility

This is a one-time, non-destructive operation. If the old `media/` directory doesn't exist, skip migration.

## Benefits

- **Multi-CMS without cache loss** — switch between production, staging, and client CMS instances without re-downloading media
- **Safe A/B testing** — test against staging CMS, switch back to production with full cache intact
- **No media ID collisions** — each CMS has its own namespace
- **Zero-downtime migration** — existing cache is moved, not deleted

## Future Enhancements

- **Cache pre-warming** — pre-populate cache for a known CMS before switching to it
- **Per-CMS cache size limits** — manage disk usage per CMS independently
- **Cache listing UI** — show which CMS caches exist, their sizes, and allow manual cleanup
- **Automatic cleanup** — remove cache dirs for CMS servers not used in N days
