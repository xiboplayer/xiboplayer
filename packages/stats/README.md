# @xiboplayer/stats

**Proof of play tracking, log reporting, and fault alerts for Xibo CMS.**

## Overview

Collects and reports display analytics to the Xibo CMS:

- **Proof of play** -- per-layout and per-widget duration tracking with IndexedDB persistence
- **Hour-boundary splitting** -- stats crossing hour boundaries are split for correct CMS aggregation
- **Aggregation modes** -- individual or aggregated submission (configurable from CMS)
- **Event stats** -- point-in-time engagement data (touch, webhook, interactive triggers)
- **Log reporting** -- display logs batched and submitted to CMS (max 50 per batch)
- **Fault alerts** -- error deduplication with 5-minute cooldown, triggers CMS dashboard alerts
- **enableStat** -- per-layout/per-widget stat suppression via XLF flags
- **Quota resilience** -- auto-cleans oldest 100 submitted records on IndexedDB quota exceeded

## Architecture

```
Renderer events                StatsCollector              CMS
(widgetStart/widgetEnd)        (IndexedDB)                (XMDS)
                                    |
widgetStart(id, layout) -----> startWidget() -----> [in-progress Map]
                                    |
widgetEnd(id, layout) -------> endWidget() -------> [split at hour]
                                    |                      |
                                    v                      v
                               IndexedDB            getStatsForSubmission(50)
                               (xibo-player-stats)         |
                                    |                formatStats() -> XML
                                    |                      |
                                    v               submitStats() -----> CMS
                               clearSubmittedStats()

Renderer events                LogReporter                 CMS
(errors, status)               (IndexedDB)                (XMDS)
                                    |
log('error', msg) -----------> _saveLog() -------> IndexedDB
reportFault(code, reason) ---> [dedup 5min] -----> [alertType field]
                                    |
                               getLogsForSubmission(50)
                                    |
                               formatLogs() -> XML
                                    |
                               submitLog() ---------> CMS
```

## Installation

```bash
npm install @xiboplayer/stats
```

## Usage

### StatsCollector -- proof of play

```javascript
import { StatsCollector, formatStats } from '@xiboplayer/stats';

const stats = new StatsCollector();
await stats.init();

// Track layout playback
await stats.startLayout(123, 456); // layoutId, scheduleId
// ... layout plays for 30 seconds ...
await stats.endLayout(123, 456);

// Track widget playback
await stats.startWidget(789, 123, 456); // mediaId, layoutId, scheduleId
// ... widget plays ...
await stats.endWidget(789, 123, 456);

// Record interactive event
await stats.recordEvent('touch', 123, 789, 456); // tag, layoutId, widgetId, scheduleId

// Submit to CMS
const pending = await stats.getStatsForSubmission(50);
if (pending.length > 0) {
  const xml = formatStats(pending);
  await xmds.submitStats(xml);
  await stats.clearSubmittedStats(pending);
}
```

### Aggregated submission

```javascript
// When CMS aggregationLevel is 'Aggregate':
const aggregated = await stats.getAggregatedStatsForSubmission(50);
// Groups by (type, layoutId, mediaId, scheduleId, hour) and sums durations
const xml = formatStats(aggregated);
await xmds.submitStats(xml);
// Clear using _rawIds from aggregated records
```

### LogReporter -- CMS logging

```javascript
import { LogReporter, formatLogs, formatFaults } from '@xiboplayer/stats';

const reporter = new LogReporter();
await reporter.init();

// Log messages (stored in IndexedDB, submitted in batches)
await reporter.error('Failed to load layout', 'PLAYER');
await reporter.info('Layout loaded successfully', 'PLAYER');
await reporter.debug('Rendering widget 42', 'RENDERER');

// Report fault (triggers CMS dashboard alert)
await reporter.reportFault('LAYOUT_LOAD_FAILED', 'Layout 123 failed to render');
// Same code won't be reported again within 5 minutes (deduplication)

// Submit logs to CMS
const logs = await reporter.getLogsForSubmission(50);
if (logs.length > 0) {
  const xml = formatLogs(logs);
  await xmds.submitLog(xml);
  await reporter.clearSubmittedLogs(logs);
}

// Submit faults (faster cycle, ~60s)
const faults = await reporter.getFaultsForSubmission(10);
if (faults.length > 0) {
  const json = formatFaults(faults);
  await xmds.reportFaults(json);
  await reporter.clearSubmittedLogs(faults);
}
```

## Stat Types

| Type | Tracked by | Fields |
|------|------------|--------|
| `layout` | startLayout/endLayout | layoutId, scheduleId, start, end, duration, count |
| `media` | startWidget/endWidget | mediaId, widgetId, layoutId, scheduleId, start, end, duration |
| `event` | recordEvent | tag, layoutId, widgetId, scheduleId, start (point-in-time) |

## API Reference

### StatsCollector

```javascript
new StatsCollector(cmsId?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `init()` | Promise | Initialize IndexedDB (idempotent) |
| `startLayout(layoutId, scheduleId, opts?)` | Promise | Start tracking layout |
| `endLayout(layoutId, scheduleId)` | Promise | End layout, save to DB |
| `startWidget(mediaId, layoutId, scheduleId, widgetId?, opts?)` | Promise | Start tracking widget |
| `endWidget(mediaId, layoutId, scheduleId)` | Promise | End widget, save to DB |
| `recordEvent(tag, layoutId, widgetId, scheduleId)` | Promise | Record instant event |
| `getStatsForSubmission(limit?)` | Promise<Array> | Get unsubmitted stats (default 50) |
| `getAggregatedStatsForSubmission(limit?)` | Promise<Array> | Get grouped stats |
| `clearSubmittedStats(stats)` | Promise | Delete submitted records |
| `getAllStats()` | Promise<Array> | All stats (debugging) |
| `clearAllStats()` | Promise | Clear everything (testing) |

### LogReporter

```javascript
new LogReporter(cmsId?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `init()` | Promise | Initialize IndexedDB |
| `log(level, message, category?, extra?)` | Promise | Store log entry |
| `error(message, category?)` | Promise | Shorthand for log('error', ...) |
| `audit(message, category?)` | Promise | Shorthand for log('audit', ...) |
| `info(message, category?)` | Promise | Shorthand for log('info', ...) |
| `debug(message, category?)` | Promise | Shorthand for log('debug', ...) |
| `reportFault(code, reason, cooldownMs?)` | Promise | Report fault with dedup (default 5min cooldown) |
| `getLogsForSubmission(limit?)` | Promise<Array> | Get unsubmitted logs (default 50) |
| `getFaultsForSubmission(limit?)` | Promise<Array> | Get unsubmitted faults (default 10) |
| `clearSubmittedLogs(logs)` | Promise | Delete submitted records |

### Formatters

| Function | Returns | Description |
|----------|---------|-------------|
| `formatStats(stats)` | string | Format stats as XML for XMDS SubmitStats |
| `formatLogs(logs)` | string | Format logs as XML for XMDS SubmitLog |
| `formatFaults(faults)` | string | Format faults as JSON for XMDS ReportFaults |

## Dependencies

- `@xiboplayer/utils` -- logger

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
