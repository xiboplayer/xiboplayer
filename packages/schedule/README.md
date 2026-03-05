# @xiboplayer/schedule

**Complete scheduling solution: campaigns, dayparting, interrupts, overlays, and timeline prediction.**

## Overview

Manages all aspects of digital signage scheduling to determine which layouts play when:

- **Campaign scheduling** -- groups of layouts with time windows and priorities
- **Dayparting** -- weekly time slots (Mon-Fri 09:00-17:00, evenings, weekends) with midnight-crossing support
- **Priority fallback** -- higher-priority layouts hide lower-priority ones; rate limiting triggers automatic fallback
- **Rate limiting** -- `maxPlaysPerHour` with even distribution (prevents bursts, ensures spacing)
- **Interrupts (Share of Voice)** -- layouts that must play X% of each hour, interleaved with normal content
- **Overlays** -- layouts that appear on top of main layouts without interrupting playback
- **Criteria evaluation** -- conditional display based on time, weather, custom display properties
- **Geo-fencing** -- location-based filtering (point + radius, Haversine distance)
- **Timeline prediction** -- deterministic simulation of future playback for UI overlays
- **Default layout** -- fallback when no campaigns are active

## Architecture

```
CMS Schedule XML
        |
        v
+-------------------------------------+
|  Schedule Parser                    |
|  +- campaigns[]                     |
|  +- layouts[]                       |
|  +- overlays[]                      |
|  +- default layout                  |
+-------------------------------------+
        |
        v
+-------------------------------------+
|  Evaluation Engine                  |
|  +- Recurrence (Week/Day/Month)     |
|  +- Time windows (dayparting)       |
|  +- Criteria (weather, properties)  |
|  +- Geo-fencing                     |
|  +- Priority + rate-limit filtering |
+-------------------------------------+
        |
        v
+-------------------------------------+
|  Schedule Queue Builder (LCM-based) |
|  Deterministic round-robin with:    |
|  +- Rate-limited slots (even spaced)|
|  +- Priority fallback               |
|  +- Default fills gaps              |
+-------------------------------------+
        |
        +-> getCurrentLayouts()        -> Renderer
        +-> getLayoutsInTimeRange()    -> Timeline Overlay
        +-> Track play history         -> Rate limiting
```

## Installation

```bash
npm install @xiboplayer/schedule
```

## Usage

### Basic scheduling

```javascript
import { ScheduleManager } from '@xiboplayer/schedule';

const schedule = new ScheduleManager();

schedule.setSchedule({
  campaigns: [
    {
      id: 1,
      priority: 100,
      fromdt: '2025-01-01 09:00',
      todt: '2025-12-31 17:00',
      recurrenceType: 'Week',
      recurrenceRepeatsOn: '1,2,3,4,5', // Mon-Fri
      layouts: [
        { id: 10, file: '10.xlf', duration: 30 },
        { id: 11, file: '11.xlf', duration: 30 },
      ],
    },
  ],
  default: '99.xlf',
});

const layoutsToPlay = schedule.getCurrentLayouts();
// Business hours: ['10.xlf', '11.xlf']
// After hours: ['99.xlf'] (default)
```

### Dayparting with midnight crossing

```javascript
schedule.setSchedule({
  layouts: [
    {
      id: 1,
      file: '1.xlf',
      recurrenceType: 'Week',
      recurrenceRepeatsOn: '1,2,3,4,5,6,7',
      fromdt: '1970-01-01 22:00:00', // 10 PM
      todt: '1970-01-01 02:00:00',   // 2 AM (next day)
    },
  ],
});

// Friday 23:00: returns ['1.xlf']
// Saturday 01:00: returns ['1.xlf'] (midnight crossing works)
```

### Rate limiting with even distribution

```javascript
schedule.setSchedule({
  layouts: [
    {
      id: 1,
      file: '1.xlf',
      maxPlaysPerHour: 3, // 3 times per hour, evenly spaced
    },
  ],
});

schedule.recordPlay('1'); // Play at 09:00
// Can't play again until 09:20 (60 / 3 = 20 min minimum gap)
```

### Interrupts (Share of Voice)

```javascript
schedule.setSchedule({
  layouts: [
    { id: 1, file: '1.xlf', duration: 30 },
    { id: 2, file: '2.xlf', duration: 30, shareOfVoice: 20 }, // 20% of each hour
  ],
});

const layouts = schedule.getCurrentLayouts();
// Interleaved: normal, normal, interrupt, normal, normal, interrupt, ...
```

### Criteria-based display

```javascript
schedule.setSchedule({
  layouts: [
    {
      id: 1,
      file: '1.xlf',
      criteria: [
        { metric: 'weatherTemp', condition: 'greaterThan', value: '25', type: 'number' },
      ],
    },
  ],
});

schedule.setWeatherData({ temperature: 28, humidity: 65 });
// Layout 1 displays only when temperature > 25
```

### Geo-fencing

```javascript
schedule.setLocation(37.7749, -122.4194);

schedule.setSchedule({
  layouts: [
    {
      id: 1,
      file: '1.xlf',
      isGeoAware: true,
      geoLocation: '37.7749,-122.4194,500', // lat,lng,radius_meters
    },
  ],
});

// Returns ['1.xlf'] only if player is within 500m
```

### Timeline prediction

```javascript
const timeline = calculateTimeline(queue, queuePosition, {
  from: new Date(),
  hours: 2,
  defaultLayout: schedule.schedule.default,
  durations: durations,
});

// Returns:
// [
//   { layoutFile: '10.xlf', startTime, endTime, duration: 30, isDefault: false },
//   { layoutFile: '11.xlf', startTime, endTime, duration: 30, isDefault: false },
//   ...
// ]
```

## Campaign Evaluation Algorithm

When `getCurrentLayouts()` is called:

1. **Filter time-active items** -- campaigns and standalone layouts within their date/time window and recurrence rules
2. **Apply criteria** -- filter by weather, display properties, geo-fencing
3. **Apply rate limiting** -- exclude layouts that exceeded `maxPlaysPerHour`
4. **Find max priority** -- only max priority items win
5. **Extract layouts** -- campaigns return all their layouts; standalone layouts contribute themselves
6. **Process interrupts** -- separate interrupt layouts, calculate share-of-voice, interleave
7. **Return layout files** -- ready for the renderer

## Key Concepts

### Schedule Queue (LCM-based)

The queue is a pre-computed, deterministic round-robin cycle:

- **LCM period** -- Least Common Multiple of all `maxPlaysPerHour` intervals (capped at 2 hours)
- **Simulation** -- walks the period applying priority and rate-limit rules at each step
- **Caching** -- reused until the active layout set changes
- **Predictable** -- answers "what's playing in 30 minutes?" offline

### Dayparting

| Type | Pattern | Example |
|------|---------|---------|
| Week | Specific days + time-of-day | Mon-Fri 09:00-17:00 |
| Day | Daily with optional interval | Every 2 days |
| Month | Specific days of month | 1st, 15th (monthly) |

Midnight crossing: `22:00 - 02:00` works across day boundaries.

### Criteria Evaluation

**Built-in metrics:** `dayOfWeek`, `dayOfMonth`, `month`, `hour`, `isoDay`

**Weather metrics:** `weatherTemp`, `weatherHumidity`, `weatherWindSpeed`, `weatherCondition`, `weatherCloudCover`

**Operators:** `equals`, `notEquals`, `greaterThan`, `greaterThanOrEquals`, `lessThan`, `lessThanOrEquals`, `contains`, `startsWith`, `endsWith`, `in`

### Geo-fencing

- Format: `"lat,lng,radius"` (e.g., `"37.7749,-122.4194,500"`)
- Default radius: 500 meters
- Calculation: Haversine formula (great-circle distance)
- Permissive: if no location available, layout displays (fail-open for offline)

## API Reference

### Constructor

```javascript
new ScheduleManager(options?)
```

| Option | Type | Description |
|--------|------|-------------|
| `interruptScheduler` | InterruptScheduler? | Optional interrupt handler |
| `displayProperties` | Object? | Custom display fields from CMS |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `setSchedule(schedule)` | void | Load schedule from XMDS response |
| `getCurrentLayouts()` | string[] | Layouts active now |
| `getLayoutsAtTime(date)` | string[] | Layouts at specific time |
| `getAllLayoutsAtTime(date)` | Array | All time-active layouts with metadata |
| `getScheduleQueue(durations)` | {queue, periodSeconds} | Pre-computed round-robin queue |
| `popNextFromQueue(durations)` | {layoutId, duration} | Pop next entry, advance position |
| `peekNextInQueue(durations)` | {layoutId, duration} | Peek without advancing |
| `recordPlay(layoutId)` | void | Track a play for rate limiting |
| `canPlayLayout(layoutId, max)` | boolean | Check if layout can play now |
| `setWeatherData(data)` | void | Update weather for criteria |
| `setLocation(lat, lng)` | void | Set GPS location for geo-fencing |
| `setDisplayProperties(props)` | void | Set custom display fields |
| `detectConflicts(options)` | Array | Find priority-shadowing conflicts |

### Overlay Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `setOverlays(overlays)` | void | Update overlay list |
| `getCurrentOverlays()` | Array | Active overlays (sorted by priority) |
| `shouldCheckOverlays(lastCheck)` | boolean | Check interval (every 60s) |

### Timeline Functions

```javascript
import { calculateTimeline, parseLayoutDuration, buildScheduleQueue } from '@xiboplayer/schedule';

const { duration } = parseLayoutDuration(xlfXml, videoDurations?);
const { queue, periodSeconds } = buildScheduleQueue(allLayouts, durations);
const timeline = calculateTimeline(queue, position, { from, hours, defaultLayout, durations });
```

## Dependencies

No external dependencies -- fully self-contained scheduling engine.

- `@xiboplayer/utils` -- logging only

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
