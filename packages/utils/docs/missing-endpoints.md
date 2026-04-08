# Missing Xibo REST API Endpoints

Deferred-work record for `CmsApiClient`. Every entry is an endpoint in the
[Xibo REST API manual](https://account.xibosignage.com/manual/api/) that is
deliberately **not** implemented in `src/cms-api.js`, with a one-line reason.

This file has three purposes:

1. **Prevent re-analysis**: the question "should we implement endpoint X?" has
   already been answered here — consult the list before re-opening the debate.
2. **Backlog**: when a concrete feature needs a deferred endpoint, promote it
   to an issue and remove from this list.
3. **Scope boundary**: makes explicit what `CmsApiClient` is and is not. It is a
   machine-to-machine signage-operations client, not an admin console.

## Current state (2026-04-08)

- **Implemented**: ~117 public methods covering layouts, regions, widgets,
  media, campaigns, schedules, displays, display groups, playlists, datasets,
  dayparts, commands, notifications, folders, tags, resolutions, templates.
- **Deferred**: ~80 endpoints, listed below.
- **Xibo REST total**: ~200 endpoints (estimated from the public manual).

## Tier 1 — Implement next (tracked in xiboplayer-ai issues)

These have concrete feature drivers and should move out of this file soon.

| Area | Endpoints | Driver | Issue |
|---|---|---|---|
| Menuboard CRUD | `/menuboard`, `/menuboard/{id}/category*`, `/menuboard/product/*` | menu-board SMIL templates, AI menu generation | xibo-players/xiboplayer-ai#40 |
| Stats & Reports | `/stats`, `/stats/export`, `/report/*` | Voice-driven analytics in AI demo | xibo-players/xiboplayer-ai#41 |
| CMS Logs | `/log` GET | Remote kiosk troubleshooting | xibo-players/xiboplayer-ai#42 |

## Tier 2 — Implement when a feature arrives

Real signage value, but no concrete feature depends on them yet.

| Endpoint group | Reason to defer | Trigger to implement |
|---|---|---|
| `/displayprofile/*` | Kiosk fleet uses hand-crafted profiles today | Bulk profile push feature for kiosk fleet |
| `/syncgroup/*` | No multi-display video wall customer yet | First video-wall deployment |
| `/action/*` (triggers) | Passive displays only, no touch UI | Touch/interactive display project |
| `/fonts` CRUD | Xibo web UI works fine for one-off font upload | Brand-compliance automation feature |

## Tier 3 — Intentionally not implementing

Either duplicates the Xibo web UI with no automation value, or would create an
admin surface we don't want to own.

### User, group, and permission management

| Endpoints | Why skipped |
|---|---|
| `/user`, `/user/{id}` | Admin UI territory; not part of signage operations |
| `/user/me`, `/user/pref` | One-time setup; Xibo web UI handles this |
| `/user/permissions/{entity}/{id}` | Permission edits rare; web UI has a better matrix view |
| `/group`, `/group/{id}` | Same as above |
| `/group/{id}/members/*` | Same as above |

### Module configuration

| Endpoints | Why skipped |
|---|---|
| `/module` | Read-only introspection; callers don't need it |
| `/module/settings/*` | Set once per install; web UI only |
| `/module/template/*` | Would require exposing Twig rendering — out of scope |

### System tasks

| Endpoints | Why skipped |
|---|---|
| `/task` | Xibo CMS system tasks; managed via `cron`, not REST |
| `/task/{id}` | Same |

### Display profiles (generic config editors)

| Endpoints | Why skipped |
|---|---|
| `/displayprofile` list | Deferred to Tier 2 — kiosk fleet may promote |

### Versioning and metadata

| Endpoints | Why skipped |
|---|---|
| `/about` | Static CMS version info; not needed programmatically |
| `/clock` | Server time; use HTTP `Date` header if needed |

### Library sub-operations already covered

| Endpoints | Why skipped |
|---|---|
| `/library/{mediaId}/isused` | `getMediaUsage(mediaId)` covers this |
| `/library/thumbnail/{mediaId}` | Browser loads thumbnails directly via URL pattern |
| `/library/download/{mediaId}` | `downloadMedia(mediaId)` covers this |

### Player version management

| Endpoints | Why skipped |
|---|---|
| `/playersoftware` | We build our own players; Xibo's version feed is irrelevant |
| `/playersoftware/{versionId}` | Same |

### Transitions and widget metadata

| Endpoints | Why skipped |
|---|---|
| `/transition` | Transitions are set per-widget via `setWidgetTransition` (covered) |
| `/widget/{widgetId}/expiry` | `setWidgetExpiry` covers this |

### Connectors (experimental)

| Endpoints | Why skipped |
|---|---|
| `/connector/*` | Xibo v4 feature; unused by our templates; revisit if we integrate DataConnectors |

## Decision framework

Before promoting anything to Tier 1 or Tier 2:

1. **Does a real feature in the 19-repo ecosystem need it?** If no → stays deferred.
2. **Can the user do it through the Xibo web UI already?** If yes → the bar is
   much higher (needs automation value, not just availability).
3. **Does it change between Xibo CMS major versions?** If yes → recurring CI cost.
   Accept only if the feature value justifies upstream tracking.

## Maintenance

- When adding a new method to `cms-api.js`, remove its entry from this file.
- When Xibo CMS ships a new major version, scan its API changelog for
  additions to Tier 3 categories; most will stay skipped but occasionally
  something new belongs in Tier 2.
- Review this file every ~6 months or whenever the AI demo / kiosk fleet gains
  a new capability that might promote a deferred endpoint.
