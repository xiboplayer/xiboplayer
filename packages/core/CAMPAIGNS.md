# Campaign Support in PWA Core Player

## Overview

Campaigns are scheduled groups of layouts that play together as a unit. This feature provides parity with the Electron player and allows for more sophisticated content scheduling.

## What Are Campaigns?

A **campaign** is a collection of layouts that:
- Share a common priority level
- Are scheduled together as a single unit
- Cycle through their layouts in order
- Compete with other campaigns and standalone layouts based on priority

## Key Concepts

### Priority at Campaign Level

Unlike standalone layouts where each layout has its own priority, campaigns apply priority at the group level:

- **Campaign priority**: All layouts within a campaign inherit the campaign's priority
- **Standalone layout priority**: Individual layouts not in campaigns have their own priority
- **Competition**: Campaigns compete with each other and standalone layouts based on priority
- **Winner selection**: The highest priority item(s) win, whether campaign or standalone

### Layout Cycling

Within a campaign, layouts cycle in the order they appear in the XML:

```xml
<campaign id="1" priority="10">
  <layout file="100"/>  <!-- Plays first -->
  <layout file="101"/>  <!-- Plays second -->
  <layout file="102"/>  <!-- Plays third, then back to 100 -->
</campaign>
```

The player will show: 100 → 101 → 102 → 100 → 101 → ...

## XML Structure

### Campaign with Layouts

```xml
<schedule>
  <default file="0"/>

  <!-- Campaign: group of layouts -->
  <campaign id="1" priority="10" fromdt="2026-01-30 00:00:00" todt="2026-01-31 23:59:59" scheduleid="15">
    <layout file="100"/>
    <layout file="101"/>
    <layout file="102"/>
  </campaign>

  <!-- Standalone layout -->
  <layout file="200" priority="5" fromdt="2026-01-30 00:00:00" todt="2026-01-31 23:59:59" scheduleid="20"/>
</schedule>
```

### Campaign Attributes

- `id`: Unique campaign identifier
- `priority`: Priority level (higher = more important)
- `fromdt`: Start date/time
- `todt`: End date/time
- `scheduleid`: Schedule entry ID for logging

### Layout Elements in Campaigns

Layouts within campaigns can optionally override timing:

```xml
<campaign id="1" priority="10" fromdt="2026-01-30 00:00:00" todt="2026-01-31 23:59:59">
  <!-- Layout inherits campaign timing -->
  <layout file="100"/>

  <!-- Layout has specific timing within campaign window -->
  <layout file="101" fromdt="2026-01-30 12:00:00" todt="2026-01-30 18:00:00"/>
</campaign>
```

## Scheduling Behavior

### Example 1: Campaign Beats Lower Priority Standalone

```xml
<schedule>
  <campaign id="1" priority="10">
    <layout file="100"/>
    <layout file="101"/>
  </campaign>

  <layout file="200" priority="5"/>
</schedule>
```

**Result**: Plays layouts 100 and 101 (campaign priority 10 beats standalone priority 5)

### Example 2: Multiple Campaigns at Same Priority

```xml
<schedule>
  <campaign id="1" priority="10">
    <layout file="100"/>
    <layout file="101"/>
  </campaign>

  <campaign id="2" priority="10">
    <layout file="200"/>
    <layout file="201"/>
  </campaign>
</schedule>
```

**Result**: Plays all layouts from both campaigns: 100, 101, 200, 201

### Example 3: Mixed Campaigns and Standalone at Same Priority

```xml
<schedule>
  <campaign id="1" priority="10">
    <layout file="100"/>
    <layout file="101"/>
  </campaign>

  <layout file="200" priority="10"/>
  <layout file="201" priority="10"/>
</schedule>
```

**Result**: Plays all layouts: 100, 101, 200, 201

### Example 4: Time Window Filtering

```xml
<schedule>
  <!-- Active campaign (current time within window) -->
  <campaign id="1" priority="10" fromdt="2026-01-30 00:00:00" todt="2026-01-31 23:59:59">
    <layout file="100"/>
    <layout file="101"/>
  </campaign>

  <!-- Expired campaign (ignored) -->
  <campaign id="2" priority="15" fromdt="2026-01-25 00:00:00" todt="2026-01-26 23:59:59">
    <layout file="200"/>
  </campaign>

  <!-- Fallback standalone -->
  <layout file="300" priority="5" fromdt="2026-01-30 00:00:00" todt="2026-01-31 23:59:59"/>
</schedule>
```

**Result**: Campaign 2 is expired, so campaign 1 wins with priority 10

## Implementation Details

### XMDS Parsing (`xmds.js`)

The `parseScheduleResponse()` method parses campaigns and standalone layouts:

```javascript
const schedule = {
  default: null,
  layouts: [],      // Standalone layouts
  campaigns: []     // Campaign objects
};
```

Each campaign object:
```javascript
{
  id: "1",
  priority: 10,
  fromdt: "2026-01-30 00:00:00",
  todt: "2026-01-31 23:59:59",
  scheduleid: "15",
  layouts: [
    {
      file: "100",
      priority: 10,        // Inherited from campaign
      campaignId: "1",     // Reference back to campaign
      fromdt: "...",
      todt: "...",
      scheduleid: "15"
    }
  ]
}
```

### Schedule Manager (`schedule.js`)

The `getCurrentLayouts()` method:

1. Finds active campaigns (within time window)
2. Finds active standalone layouts
3. Treats each campaign as a single item with its priority
4. Compares priorities across campaigns and standalone layouts
5. Returns layouts from all items with maximum priority

### Backward Compatibility

The implementation is fully backward compatible:

- Schedules with no `<campaign>` elements work exactly as before
- Only `<layout>` elements directly under `<schedule>` are treated as standalone
- Existing PWA players without campaign support will ignore `<campaign>` elements

## Testing

### Unit Tests

Run schedule tests:
```bash
cd packages/core
node src/schedule.test.js
```

Run XMDS parsing tests:
```bash
# Open in browser
open src/xmds-test.html
```

### Manual Testing

1. Create a test schedule with campaigns in Xibo CMS
2. Assign to a display
3. Observe layout cycling behavior
4. Verify priority handling matches expected behavior

## Comparison with Electron Player

The PWA Core implementation matches the Electron player's campaign behavior:

- ✅ Priority at campaign level
- ✅ Layout cycling within campaigns
- ✅ Mixed campaigns and standalone layouts
- ✅ Time window filtering
- ✅ Multiple campaigns at same priority

## Future Enhancements

Potential improvements:

1. **Campaign statistics**: Track how many times each campaign plays
2. **Campaign transitions**: Special transitions between campaign layouts
3. **Campaign metadata**: Additional campaign properties from CMS
4. **Sub-campaigns**: Nested campaign support

## References

- Xibo CMS Campaigns: https://xibosignage.com/docs/setup/campaigns
- XMDS Protocol: https://github.com/xibosignage/xibo/blob/master/lib/XTR/ScheduleParser.php
- Electron Player: https://github.com/xiboplayer/xiboplayer-electron
