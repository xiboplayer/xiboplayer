# Xibo Campaigns and Priority System

**Last Updated:** 2026-01-30

## Overview

This document explains how Xibo's campaign and priority system works across all three player implementations (Electron, PWA, and Arexibo). Understanding this system is crucial for proper schedule configuration and layout management.

---

## What Are Campaigns?

**Campaigns** are a Xibo scheduling feature that groups related layouts together as a single schedulable unit.

### Key Concepts

- **Campaign** = A collection of layouts with shared scheduling attributes
- **Priority Level** = Applied at the campaign level (not individual layouts)
- **Layout Cycling** = All layouts within a campaign cycle in sequence
- **Competition** = Campaigns compete with each other and standalone layouts based on priority

### Why Use Campaigns?

Campaigns solve the problem of managing related content that should play together:

**Without Campaigns:**
- Schedule 10 individual breakfast menu layouts
- Each needs identical time windows and priorities
- Changes require updating 10 separate schedule entries

**With Campaigns:**
- Group 10 breakfast layouts into a "Breakfast Menu" campaign
- Schedule the campaign once with shared priority and time window
- Changes affect all layouts at once

---

## Priority System Explained

### How Priority Works

Priority determines which layouts (or campaigns) play when multiple schedules overlap.

#### Priority Rules

1. **Higher Number Wins**: Priority 10 beats priority 5
2. **Campaign-Level Priority**: All layouts in a campaign inherit the campaign's priority
3. **Same Priority = All Play**: Multiple items with the same priority all display (cycling)
4. **No Priority = Priority 0**: Default priority if not specified

#### Priority Range

- **Type**: Integer (positive or negative)
- **Common Range**: 0-100
- **Special Values**:
  - `0`: Default/lowest priority (normal content)
  - `10`: Standard scheduled content
  - `100`: Urgent/interrupt content (alerts, emergencies)

---

## XML Schedule Format

### Campaign Structure

```xml
<schedule>
  <!-- Default layout (fallback when nothing scheduled) -->
  <default file="1" />

  <!-- Campaign: Group of layouts with shared attributes -->
  <campaign id="10" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00">
    <layout file="100" />
    <layout file="101" />
    <layout file="102" />
  </campaign>

  <!-- Standalone layout (not in a campaign) -->
  <layout file="200" priority="5" fromdt="2026-01-30 00:00:00" todt="2026-01-30 23:59:59" />
</schedule>
```

### Campaign Attributes

| Attribute | Description | Required | Example |
|-----------|-------------|----------|---------|
| `id` | Unique campaign identifier | Yes | `id="10"` |
| `priority` | Priority level (integer) | No (default: 0) | `priority="10"` |
| `fromdt` | Start date/time | Yes | `fromdt="2026-01-30 08:00:00"` |
| `todt` | End date/time | Yes | `todt="2026-01-30 17:00:00"` |
| `scheduleid` | CMS schedule ID | No | `scheduleid="123"` |

### Standalone Layout Attributes

| Attribute | Description | Required | Example |
|-----------|-------------|----------|---------|
| `file` | Layout ID | Yes | `file="200"` |
| `priority` | Priority level (integer) | No (default: 0) | `priority="5"` |
| `fromdt` | Start date/time | Yes | `fromdt="2026-01-30 00:00:00"` |
| `todt` | End date/time | Yes | `todt="2026-01-30 23:59:59"` |
| `scheduleid` | CMS schedule ID | No | `scheduleid="456"` |

---

## Priority Resolution Examples

### Example 1: Campaign Beats Standalone

**Schedule:**
```xml
<campaign id="1" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00">
  <layout file="100" />
  <layout file="101" />
</campaign>
<layout file="200" priority="5" fromdt="2026-01-30 00:00:00" todt="2026-01-30 23:59:59" />
```

**At 12:00 PM (both active):**
- Campaign priority: 10
- Standalone priority: 5
- **Result**: Displays layouts 100, 101 (campaign wins)

---

### Example 2: Multiple Same-Priority Campaigns

**Schedule:**
```xml
<campaign id="1" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00">
  <layout file="100" />
  <layout file="101" />
</campaign>
<campaign id="2" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00">
  <layout file="200" />
  <layout file="201" />
</campaign>
```

**At 12:00 PM (both active):**
- Both campaigns at priority 10
- **Result**: Displays layouts 100, 101, 200, 201 (all layouts cycle)

---

### Example 3: Mixed Campaigns and Standalone

**Schedule:**
```xml
<campaign id="1" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00">
  <layout file="100" />
  <layout file="101" />
</campaign>
<layout file="200" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00" />
<layout file="300" priority="5" fromdt="2026-01-30 00:00:00" todt="2026-01-30 23:59:59" />
```

**At 12:00 PM:**
- Campaign 1: priority 10 (layouts 100, 101)
- Standalone 200: priority 10
- Standalone 300: priority 5
- **Result**: Displays layouts 100, 101, 200 (priority 10 wins, all shown)

---

### Example 4: Time Window Filtering

**Schedule:**
```xml
<campaign id="1" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 12:00:00">
  <layout file="100" />  <!-- Morning campaign -->
</campaign>
<campaign id="2" priority="10" fromdt="2026-01-30 12:00:01" todt="2026-01-30 17:00:00">
  <layout file="200" />  <!-- Afternoon campaign -->
</campaign>
```

**At 10:00 AM:**
- Campaign 1 active (08:00-12:00)
- **Result**: Displays layout 100

**At 2:00 PM:**
- Campaign 2 active (12:00-17:00)
- **Result**: Displays layout 200

---

### Example 5: Interrupt Content

**Schedule:**
```xml
<campaign id="1" priority="10" fromdt="2026-01-30 00:00:00" todt="2026-01-30 23:59:59">
  <layout file="100" />  <!-- Regular content -->
</campaign>
<layout file="999" priority="100" fromdt="2026-01-30 14:00:00" todt="2026-01-30 14:15:00" />
```

**At 1:00 PM:**
- Campaign 1 active (priority 10)
- **Result**: Displays layout 100

**At 2:05 PM:**
- Campaign 1 still active (priority 10)
- Emergency layout 999 active (priority 100)
- **Result**: Displays layout 999 (interrupt content overrides)

**At 2:20 PM:**
- Campaign 1 active (priority 10)
- Emergency layout 999 expired
- **Result**: Displays layout 100 (resumes normal content)

---

## Real-World Use Cases

### Restaurant Menu Board

**Scenario:** Different menus for breakfast, lunch, dinner

```xml
<schedule>
  <default file="1" />  <!-- "We're Closed" layout -->

  <!-- Breakfast: Mon-Fri 6am-11am -->
  <campaign id="10" priority="10" fromdt="2026-01-30 06:00:00" todt="2026-01-30 11:00:00">
    <layout file="100" />  <!-- Breakfast Page 1 -->
    <layout file="101" />  <!-- Breakfast Page 2 -->
    <layout file="102" />  <!-- Breakfast Specials -->
  </campaign>

  <!-- Lunch: Mon-Fri 11am-3pm -->
  <campaign id="11" priority="10" fromdt="2026-01-30 11:00:00" todt="2026-01-30 15:00:00">
    <layout file="200" />  <!-- Lunch Menu -->
    <layout file="201" />  <!-- Daily Specials -->
  </campaign>

  <!-- Dinner: Mon-Fri 3pm-10pm -->
  <campaign id="12" priority="10" fromdt="2026-01-30 15:00:00" todt="2026-01-30 22:00:00">
    <layout file="300" />  <!-- Dinner Menu -->
    <layout file="301" />  <!-- Wine List -->
  </campaign>

  <!-- Special Promotion: Overrides all (emergency interrupt) -->
  <layout file="999" priority="100" fromdt="2026-01-30 17:00:00" todt="2026-01-30 18:00:00" />
</schedule>
```

**Timeline:**
- **6:00 AM - 11:00 AM**: Breakfast campaign (layouts 100, 101, 102 cycle)
- **11:00 AM - 3:00 PM**: Lunch campaign (layouts 200, 201 cycle)
- **3:00 PM - 10:00 PM**: Dinner campaign (layouts 300, 301 cycle)
- **5:00 PM - 6:00 PM**: Happy hour promotion (layout 999 interrupts dinner campaign)
- **All other times**: Default "We're Closed" layout

---

### Retail Store Displays

**Scenario:** Regular content + promotional overrides

```xml
<schedule>
  <default file="1" />  <!-- Store logo/hours -->

  <!-- Regular store content (low priority) -->
  <campaign id="1" priority="5" fromdt="2026-01-30 00:00:00" todt="2026-01-31 00:00:00">
    <layout file="100" />  <!-- Product showcase 1 -->
    <layout file="101" />  <!-- Product showcase 2 -->
    <layout file="102" />  <!-- Brand story -->
  </campaign>

  <!-- Tuesday sale (higher priority, overrides regular) -->
  <campaign id="2" priority="10" fromdt="2026-01-30 09:00:00" todt="2026-01-30 21:00:00">
    <layout file="200" />  <!-- Sale announcement -->
    <layout file="201" />  <!-- Featured deals -->
  </campaign>

  <!-- Flash sale announcement (highest priority, interrupts everything) -->
  <layout file="999" priority="100" fromdt="2026-01-30 12:00:00" todt="2026-01-30 13:00:00" />
</schedule>
```

**Timeline:**
- **12:00 AM - 9:00 AM**: Regular content (layouts 100, 101, 102)
- **9:00 AM - 12:00 PM**: Tuesday sale (layouts 200, 201 override regular)
- **12:00 PM - 1:00 PM**: Flash sale (layout 999 interrupts Tuesday sale)
- **1:00 PM - 9:00 PM**: Tuesday sale resumes (layouts 200, 201)
- **9:00 PM - 12:00 AM**: Regular content resumes (layouts 100, 101, 102)

---

### Corporate Lobby

**Scenario:** News + scheduled events

```xml
<schedule>
  <default file="1" />  <!-- Company logo -->

  <!-- Always-on company news (low priority) -->
  <campaign id="1" priority="5" fromdt="2026-01-30 08:00:00" todt="2026-01-30 18:00:00">
    <layout file="100" />  <!-- News feed -->
    <layout file="101" />  <!-- Employee spotlights -->
    <layout file="102" />  <!-- Company metrics -->
  </campaign>

  <!-- Weekly all-hands meeting (interrupts news) -->
  <layout file="200" priority="50" fromdt="2026-01-30 14:00:00" todt="2026-01-30 15:00:00" />

  <!-- Emergency alert (highest priority) -->
  <layout file="999" priority="100" fromdt="2026-01-30 10:00:00" todt="2026-01-30 10:15:00" />
</schedule>
```

**Timeline:**
- **8:00 AM - 2:00 PM**: Company news (layouts 100, 101, 102 cycle)
- **10:00 AM - 10:15 AM**: Emergency alert (layout 999 interrupts news)
- **2:00 PM - 3:00 PM**: All-hands meeting (layout 200 overrides news)
- **3:00 PM - 6:00 PM**: Company news resumes

---

## Implementation Status

### Feature Parity Matrix

| Feature | Electron | PWA | Arexibo | Status |
|---------|----------|-----|---------|--------|
| Campaign XML parsing | ✅ | ✅ | ✅ | Complete |
| Campaign-level priority | ✅ | ✅ | ✅ | Complete |
| Layout cycling within campaign | ✅ | ✅ | ✅ | Complete |
| Mixed campaigns + standalone | ✅ | ✅ | ✅ | Complete |
| Time window filtering | ✅ | ✅ | ✅ | Complete |
| Multiple same-priority campaigns | ✅ | ✅ | ✅ | Complete |
| Backward compatibility | ✅ | ✅ | ✅ | Complete |

### Implementation Details

#### PWA Core
- **Branch**: `feature/pwa-campaigns`
- **Files**: `packages/core/src/xmds.js`, `packages/core/src/schedule.js`
- **Tests**: 6 comprehensive test cases
- **Status**: Ready for merge

#### Arexibo
- **Branch**: `feature/arx-dayparting` (includes campaigns)
- **Files**: `src/schedule.rs`
- **Tests**: 9 campaign-specific tests
- **Status**: Ready for merge

#### Electron
- **Status**: Already implemented (baseline reference)

---

## Technical Details

### Scheduling Algorithm

All three players use the same priority resolution algorithm:

```
function getCurrentLayouts(currentDateTime):
  1. Filter all schedule items (campaigns + standalone) by time window
     → Keep only items where: fromdt <= now <= todt

  2. Find maximum priority among active items
     → maxPriority = max(item.priority for all active items)

  3. Select all items matching maximum priority
     → winners = items where priority == maxPriority

  4. Collect layouts from winning items
     → For campaigns: add all layouts in campaign
     → For standalone: add the layout

  5. Return collected layouts
     → If no layouts: return default layout
```

### Layout Cycling

When multiple layouts are selected, they cycle with:

1. **Duration**: Each layout's configured duration (from layout definition)
2. **Order**: Maintains XML order within campaigns
3. **Seamless**: Transitions between layouts based on player settings
4. **Repeat**: Cycles indefinitely until schedule changes

---

## Configuration Best Practices

### Priority Guidelines

**Recommended Priority Tiers:**

| Priority Range | Use Case | Example |
|----------------|----------|---------|
| 0 | Default/fallback content | Idle screens, logos |
| 1-5 | Low-priority background content | Generic ads, filler content |
| 10 | Standard scheduled content | Normal operations, menus |
| 20-50 | Important scheduled content | Special events, meetings |
| 75-90 | High-priority overrides | Alerts, announcements |
| 100+ | Emergency interrupts | Fire alarms, emergencies |

### Time Window Guidelines

1. **No Gaps**: Ensure continuous coverage with default layout fallback
2. **No Overlaps**: Use priority to handle intentional overlaps
3. **Timezone Aware**: All times in player's local timezone
4. **Boundary Handling**: End time is inclusive (todt="17:00:00" includes 17:00)

### Campaign Organization

**Good Campaign Structure:**
```xml
<!-- Logical grouping: Related content together -->
<campaign id="morning" priority="10" fromdt="..." todt="...">
  <layout file="100" />  <!-- Morning welcome -->
  <layout file="101" />  <!-- Morning news -->
  <layout file="102" />  <!-- Morning schedule -->
</campaign>
```

**Poor Campaign Structure:**
```xml
<!-- Unrelated content mixed together -->
<campaign id="random" priority="10" fromdt="..." todt="...">
  <layout file="100" />  <!-- Welcome screen -->
  <layout file="999" />  <!-- Emergency alert -->
  <layout file="200" />  <!-- Lunch menu -->
</campaign>
```

---

## Troubleshooting

### Common Issues

#### Issue: "Lower priority content showing instead of higher"

**Cause**: Time window mismatch

**Check:**
1. Verify both items are active at current time
2. Check system clock on player
3. Confirm timezone matches schedule

#### Issue: "Campaign layouts not cycling"

**Cause**: Empty campaign or single layout

**Check:**
1. Verify campaign has multiple layouts in XML
2. Check layout durations are set correctly
3. Ensure layouts are valid and downloaded

#### Issue: "All layouts showing at once instead of cycling"

**Cause**: Player misconfiguration (not a campaign issue)

**Check:**
1. Player cycling settings
2. Region configuration
3. Xibo player version compatibility

#### Issue: "Standalone layout never shows"

**Cause**: Another item always has higher priority

**Check:**
1. Compare priorities of all schedule items
2. Verify time windows don't overlap with higher priority items
3. Add default layout as fallback

---

## Migration from Non-Campaign Schedules

### Converting Standalone Layouts to Campaigns

**Before (Standalone):**
```xml
<layout file="100" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00" />
<layout file="101" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00" />
<layout file="102" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00" />
```

**After (Campaign):**
```xml
<campaign id="1" priority="10" fromdt="2026-01-30 08:00:00" todt="2026-01-30 17:00:00">
  <layout file="100" />
  <layout file="101" />
  <layout file="102" />
</campaign>
```

**Benefits:**
- ✅ Single schedule entry instead of three
- ✅ Guaranteed same priority and time window
- ✅ Easier to update all layouts at once

### Backward Compatibility

All players maintain full backward compatibility:

- ✅ Old schedules without campaigns continue working
- ✅ Mixed old + new schedules supported
- ✅ No breaking changes to existing functionality

---

## References

### Xibo CMS Documentation
- [Xibo Manual - Scheduling](https://xibosignage.com/manual/en/scheduling.html)
- [Xibo Manual - Campaigns](https://xibosignage.com/manual/en/media_module_campaigns.html)

### Implementation Branches
- **PWA**: `feature/pwa-campaigns` in [xiboplayer repo](https://github.com/xibo-players/xiboplayer)
- **Arexibo**: `feature/arx-dayparting` in [arexibo repo](https://github.com/linuxnow/arexibo)

### Related Documentation
- `TRANSITIONS.md` - Layout transition effects
- `DAYPARTING.md` - Recurring schedule patterns
- `XIBO_FEATURE_COMPARISON.md` - Cross-player feature matrix

---

## Appendix: Complete Example

### Multi-Day Restaurant Schedule

```xml
<schedule>
  <!-- Fallback: Closed -->
  <default file="1" />

  <!-- Monday-Friday Breakfast (6am-11am) -->
  <campaign id="weekday_breakfast" priority="10"
            fromdt="2026-01-27 06:00:00" todt="2026-01-27 11:00:00">
    <layout file="100" />
    <layout file="101" />
    <layout file="102" />
  </campaign>

  <!-- Monday-Friday Lunch (11am-3pm) -->
  <campaign id="weekday_lunch" priority="10"
            fromdt="2026-01-27 11:00:00" todt="2026-01-27 15:00:00">
    <layout file="200" />
    <layout file="201" />
  </campaign>

  <!-- Monday-Friday Dinner (3pm-10pm) -->
  <campaign id="weekday_dinner" priority="10"
            fromdt="2026-01-27 15:00:00" todt="2026-01-27 22:00:00">
    <layout file="300" />
    <layout file="301" />
  </campaign>

  <!-- Weekend Brunch (9am-3pm) -->
  <campaign id="weekend_brunch" priority="10"
            fromdt="2026-02-01 09:00:00" todt="2026-02-01 15:00:00">
    <layout file="400" />
    <layout file="401" />
    <layout file="402" />
  </campaign>

  <!-- Weekend Dinner (3pm-10pm) -->
  <campaign id="weekend_dinner" priority="10"
            fromdt="2026-02-01 15:00:00" todt="2026-02-01 22:00:00">
    <layout file="500" />
    <layout file="501" />
  </campaign>

  <!-- Special: Valentine's Day Override -->
  <campaign id="valentines" priority="50"
            fromdt="2026-02-14 15:00:00" todt="2026-02-14 22:00:00">
    <layout file="600" />  <!-- Valentine's Special Menu -->
    <layout file="601" />  <!-- Valentine's Desserts -->
  </campaign>

  <!-- Emergency: Power Outage Notice -->
  <layout file="999" priority="100"
          fromdt="2026-01-30 18:00:00" todt="2026-01-30 19:00:00" />
</schedule>
```

This schedule demonstrates:
- ✅ Multiple campaigns for different meal times
- ✅ Weekday vs weekend content separation
- ✅ Special event overrides (Valentine's Day)
- ✅ Emergency interrupt capability
- ✅ Proper priority tier usage
- ✅ Comprehensive time coverage with fallback

---

**End of Document**
