# XiboPlayer SDK — Spec Compliance Audit

**Date:** 2026-02-21
**Scope:** All `@xiboplayer/*` packages + PWA player
**Method:** Compared against Xibo developer docs, upstream XLR, .NET/Electron players, and arexibo

## Executive Summary

| Audit Source | Score | Notes |
|-------------|-------|-------|
| XMDS Spec (14 methods) | 14/14 | Full SOAP + REST coverage |
| XMR Spec (13 handlers) | 13/13 | All handlers + rekey |
| XLF Rendering | ~95% | scaletype added; default transition exists |
| Schedule Spec | ~95% | Recurrence + weather done; adspace stub only |
| Stats Spec | ~95% | Engagement tracking exists; BroadcastChannel not needed |
| Interactive Control | 100% | Full IC server via postMessage |
| Overall | **~98%** | 14/15 gaps resolved (PRs #86–#90), 1 remaining (#84 adspace) |

## Feature Compliance Matrix

### XMDS Communication — 14/14

| Method | SOAP | REST | Notes |
|--------|------|------|-------|
| RegisterDisplay | ✅ | ✅ | Settings, XMR address, display profile |
| RequiredFiles | ✅ | ✅ | CRC32 skip, ETag 304 (REST) |
| Schedule | ✅ | ✅ | Full schedule XML parsing |
| GetResource | ✅ | ✅ | Widget HTML content |
| GetWidgetHtml | ✅ | ✅ | Modern widget endpoint |
| MediaInventory | ✅ | ✅ | Cached file inventory |
| NotifyStatus | ✅ | ✅ | Full fields (PR #89) |
| SubmitLog | ✅ | ✅ | Log + fault entries |
| SubmitStats | ✅ | ✅ | Proof-of-play with aggregation |
| SubmitScreenShot | ✅ | ✅ | getDisplayMedia + html2canvas fallback |
| BlackList | ✅ | ✅ | REST added (PR #89) |
| GetFile | ✅ | ✅ | Chunked parallel download |
| ReportFaults | ✅ | ✅ | Periodic agent added (PR #87) |
| GetWeather | ✅ | ✅ | Weather → criteria integration |

### XMR Push Messaging — 13/13

All handlers implemented: `collectNow`, `screenShot`, `licenceCheck`, `changeLayout`, `overlayLayout`, `revertToSchedule`, `purgeAll`, `commandAction`, `triggerWebhook`, `dataUpdate`, `criteriaUpdate`, `currentGeoLocation`, `rekey`.

- RSA key pair generation and registration (Web Crypto API)
- Key rotation via rekey command
- Exponential backoff reconnection (10 attempts)

### Schedule Management

| Feature | Status | Issue |
|---------|--------|-------|
| Priority-based layout selection | ✅ | — |
| Dayparting (ISO day-of-week, midnight crossing) | ✅ | — |
| maxPlaysPerHour (even distribution) | ✅ | — |
| Campaign scheduling | ✅ | — |
| Interrupt/share-of-voice interleaving | ✅ | — |
| Overlay management (priority z-index) | ✅ | — |
| Action/command/data connector events | ✅ | — |
| Default layout fallback | ✅ | — |
| Geo-fencing (haversine + browser Geolocation) | ✅ | — |
| Criteria evaluation (5 metrics + custom props) | ✅ | — |
| Weather criteria | ✅ | [#73](https://github.com/xibo-players/xiboplayer/issues/73) ✓ |
| Recurrence patterns (daily/weekly/monthly) | ✅ | [#80](https://github.com/xibo-players/xiboplayer/issues/80) ✓ (PR #90) |
| Adspace exchange / SSP ads | ❌ | [#84](https://github.com/xibo-players/xiboplayer/issues/84) |
| Layout interleaving (weighted SoV) | ✅ | [#78](https://github.com/xibo-players/xiboplayer/issues/78) ✓ |

### Renderer (renderer-lite vs XLR)

| Feature | renderer-lite | XLR | Notes |
|---------|:---:|:---:|-------|
| XLF parsing + layout scaling | ✅ | ✅ | |
| Image/video/audio/text widgets | ✅ | ✅ | |
| Clock/webpage/embedded/PDF/HLS | ✅ | ✅ | |
| Dataset widgets | ✅ | ✅ | |
| Fade + fly transitions (8 directions) | ✅ | ✅ | |
| Background images/colors | ✅ | ✅ | |
| ResizeObserver dynamic rescaling | ✅ | ❌ | Our win |
| Blob URL lifecycle (no leaks) | ✅ | ❌ | Our win |
| Preload pool (parallel prefetch) | ✅ | ❌ | Our win — Promise.all |
| Time-gating (schedule-aware regions) | ✅ | ❌ | Our win |
| Cycle playback (auto-replay) | ✅ | ❌ | Our win |
| Element reuse (toggle visibility) | ✅ | ❌ | Our win — avoids DOM churn |
| Image scaletype options | ✅ | ✅ | [#74](https://github.com/xibo-players/xiboplayer/issues/74) ✓ (PR #89) |
| Default transition (instant toggle) | ✅ | ✅ | [#83](https://github.com/xibo-players/xiboplayer/issues/83) ✓ (already existed) |
| Drawer regions | ❌ | ✅ | Not planned (XLR-specific) |

### Stats and Reporting

| Feature | Status | Issue |
|---------|--------|-------|
| Layout proof-of-play | ✅ | — |
| Widget proof-of-play | ✅ | — |
| Stats aggregation (hourly) | ✅ | — |
| Log submission to CMS | ✅ | — |
| Fault deduplication (5-min cooldown) | ✅ | — |
| Replay-safe tracking | ✅ | — |
| Quota-exceeded cleanup | ✅ | — |
| Widget engagement tracking | ✅ | [#77](https://github.com/xibo-players/xiboplayer/issues/77) ✓ (already existed) |
| BroadcastChannel transport | N/A | [#82](https://github.com/xibo-players/xiboplayer/issues/82) ✓ (not needed) |

## SDK vs Upstream Players

### vs .NET Player (Windows v4 R406)

| Capability | SDK | .NET | Gap |
|-----------|:---:|:----:|-----|
| XMDS methods | 14/14 | 14/14 | — |
| XMR handlers | 13/13 | 13/13 | — |
| Retry-After (429) | ✅ | ✅ | [#70](https://github.com/xibo-players/xiboplayer/issues/70) ✓ (PR #86) |
| Fault reporting agent | ✅ | ✅ | [#71](https://github.com/xibo-players/xiboplayer/issues/71) ✓ (PR #87) |
| Unsafe layout blacklist | ✅ | ✅ | [#72](https://github.com/xibo-players/xiboplayer/issues/72) ✓ (PR #88) |
| NotifyStatus fields | ✅ | ✅ | [#76](https://github.com/xibo-players/xiboplayer/issues/76) ✓ (PR #89) |
| Layout interleaving | ✅ | ✅ | [#78](https://github.com/xibo-players/xiboplayer/issues/78) ✓ |
| Download window enforcement | ✅ | ✅ | [#81](https://github.com/xibo-players/xiboplayer/issues/81) ✓ (PR #90) |
| Shell/RS232 commands | N/A | ✅ | Browser sandbox |
| Parallel downloads | ✅ (4 chunks) | ❌ (sequential) | Our advantage |
| Bundle size | ~500KB | ~50MB | Our advantage |

### vs Upstream Electron Player

| Capability | SDK | Electron (upstream) | Gap |
|-----------|:---:|:---:|-----|
| Scheduled commands | ✅ | ✅ | [#79](https://github.com/xibo-players/xiboplayer/issues/79) ✓ (already existed) |
| Widget duration webhooks | ✅ | ✅ | [#79](https://github.com/xibo-players/xiboplayer/issues/79) ✓ (already existed) |
| Event stats | ✅ | ✅ | [#79](https://github.com/xibo-players/xiboplayer/issues/79) ✓ (already existed) |
| Web Crypto (RSA) | ✅ | ✅ | — |

### vs Arexibo (Rust Player)

| Capability | SDK | Arexibo | Notes |
|-----------|:---:|:-------:|-------|
| XMDS | 14/14 | 10/14 | SDK has full coverage |
| XMR | 13/13 | 8/13 | SDK has more handlers |
| Renderer | Browser DOM | GTK4/WebView | Different approach |
| Offline mode | ✅ (IndexedDB) | ✅ (SQLite) | Both robust |
| Package system | npm monorepo | Single binary | Different trade-offs |
| Test coverage | 1179 tests | ~200 tests | SDK more tested |

## Prioritized Gap List — Resolution Status

14 of 15 issues resolved. 8 implemented via PRs #86–#90, 5 already existed, 1 closed as not needed.

### Critical — All Resolved

| # | Issue | Resolution | PR |
|---|-------|-----------|-----|
| 1 | [#70](https://github.com/xibo-players/xiboplayer/issues/70) | ✅ HTTP 429 Retry-After + HTTP-date parsing | #86 |
| 2 | [#71](https://github.com/xibo-players/xiboplayer/issues/71) | ✅ Periodic fault reporting agent (60s timer) | #87 |
| 3 | [#72](https://github.com/xibo-players/xiboplayer/issues/72) | ✅ Layout blacklisting (threshold + auto-reset) | #88 |

### Moderate — All Resolved

| # | Issue | Resolution | PR |
|---|-------|-----------|-----|
| 4 | [#73](https://github.com/xibo-players/xiboplayer/issues/73) | ✅ Already implemented (weather → criteria) | — |
| 5 | [#74](https://github.com/xibo-players/xiboplayer/issues/74) | ✅ Image/video scaletype mapping | #89 |
| 6 | [#75](https://github.com/xibo-players/xiboplayer/issues/75) | ✅ BlackList via REST transport | #89 |
| 7 | [#76](https://github.com/xibo-players/xiboplayer/issues/76) | ✅ NotifyStatus enrichment | #89 |
| 8 | [#77](https://github.com/xibo-players/xiboplayer/issues/77) | ✅ Already implemented (recordEvent) | — |
| 9 | [#78](https://github.com/xibo-players/xiboplayer/issues/78) | ✅ Already implemented (interleaveLayouts) | — |
| 10 | [#79](https://github.com/xibo-players/xiboplayer/issues/79) | ✅ Already implemented in PWA | — |

### Minor — 4 Resolved, 1 Remaining

| # | Issue | Resolution | PR |
|---|-------|-----------|-----|
| 11 | [#80](https://github.com/xibo-players/xiboplayer/issues/80) | ✅ Day + Month recurrence patterns | #90 |
| 12 | [#81](https://github.com/xibo-players/xiboplayer/issues/81) | ✅ Download window enforcement in PlayerCore | #90 |
| 13 | [#82](https://github.com/xibo-players/xiboplayer/issues/82) | ✅ Closed — fire-and-forget pattern sufficient | — |
| 14 | [#83](https://github.com/xibo-players/xiboplayer/issues/83) | ✅ Already implemented (instant opacity fallback) | — |
| 15 | [#84](https://github.com/xibo-players/xiboplayer/issues/84) | ❌ **Open** — Adspace/SSP (stub only) | — |

## renderer-lite Advantages

Our renderer-lite has several architectural wins over upstream XLR:

1. **Preload pool** — Parallel media prefetch via `Promise.all` eliminates visible loading gaps between layouts
2. **Element reuse** — Pre-create all widget elements, toggle visibility instead of creating/destroying DOM nodes (avoids layout thrashing)
3. **Time-gating** — Schedule-aware regions skip rendering of off-schedule content
4. **Cycle playback** — Automatic region replay when all widgets have played (no manual restart)
5. **ResizeObserver** — Dynamic rescaling without layout recalculation
6. **Blob URL tracking** — Explicit lifecycle management prevents memory leaks that plague XLR on long-running displays

## Methodology

Four separate audits were conducted:

1. **Xibo Developer Docs** — XMDS, XMR, XLF, IC, and stats specifications from xibosignage.com
2. **XLR Source** — Upstream Xibo Layout Renderer (JavaScript), commit comparison
3. **Upstream Players** — .NET player v4 R406 and Electron player source code
4. **Arexibo** — Our Rust player implementation, feature comparison

Each audit produced a detailed feature-by-feature comparison. This document synthesizes the actionable gaps into tracked issues.
