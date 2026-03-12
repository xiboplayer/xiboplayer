# XMR Supported Commands

This document lists all CMS commands supported by the XMR (Xibo Message Relay) integration in the Xibo player.

## Command Reference

### collectNow

Triggers an immediate XMDS collection cycle.

**Event name**: `collectNow`

**Payload**: None

**Action**: Calls `player.collect()` to force an immediate sync with CMS

**Use case**: When CMS needs player to update its schedule immediately without waiting for the next collection interval

**Example**:
```javascript
// CMS sends via XMR
xmr.send('collectNow');

// Player receives and executes
await player.collect();
```

---

### screenShot / screenshot

Captures a screenshot of the current display and uploads it to CMS.

**Event names**: `screenShot`, `screenshot` (both supported)

**Payload**: None

**Action**: Calls `player.captureScreenshot()` to take and upload screenshot

**Use case**: Remote monitoring, verification that content is displaying correctly

**Example**:
```javascript
// CMS sends via XMR
xmr.send('screenShot');

// Player receives and executes
await player.captureScreenshot();
```

---

### changeLayout

Switches the display to a specific layout immediately.

**Event name**: `changeLayout`

**Payload**: `layoutId` (string) - The layout ID to switch to

**Action**: Calls `player.changeLayout(layoutId)` to immediately show the specified layout

**Use case**: Emergency content override, special announcements

**Example**:
```javascript
// CMS sends via XMR
xmr.send('changeLayout', 'layout-123');

// Player receives and executes
await player.changeLayout('layout-123');
```

---

### licenceCheck

Validates the display license status.

**Event name**: `licenceCheck`

**Payload**: None

**Action**: No action required for open-source players

**Use case**: License validation for CMS-managed displays

**Example**:
```javascript
// CMS sends via XMR
xmr.send('licenceCheck');

// Player receives - no action needed for Linux
// Acknowledge license check
```

---

### rekey

Triggers RSA key pair rotation for XMR encryption.

**Event name**: `rekey`

**Payload**: None

**Action**: TODO - Not yet implemented (for future XMR encryption)

**Use case**: Security - rotating encryption keys periodically

**Example**:
```javascript
// CMS sends via XMR
xmr.send('rekey');

// Player receives - future implementation
// Would generate new RSA key pair and send public key to CMS
```

---

### criteriaUpdate (since v0.9.0)

Updates display criteria and triggers immediate re-collection.

**Event name**: `criteriaUpdate`

**Payload**: Object with criteria data

**Action**: Calls `player.collect()` to fetch updated display criteria from CMS

**Use case**: When CMS changes display tags, criteria, or custom metadata

**Example**:
```javascript
// CMS sends via XMR
xmr.send('criteriaUpdate', { displayId: '123', criteria: 'new-criteria' });

// Player receives and re-collects
await player.collect(); // Gets new criteria from registerDisplay
```

---

### currentGeoLocation (since v0.9.0)

Reports current geographic location to CMS.

**Event name**: `currentGeoLocation`

**Payload**: Object with latitude/longitude (optional)

**Action**: Calls `player.reportGeoLocation(data)` if implemented

**Use case**: Location-based content delivery, asset tracking

**Example**:
```javascript
// CMS sends via XMR
xmr.send('currentGeoLocation', { latitude: 40.7128, longitude: -74.0060 });

// Player receives and reports location
if (player.reportGeoLocation) {
  await player.reportGeoLocation(data);
} else {
  console.warn('Geo location reporting not implemented');
}
```

**Note**: This command requires `player.reportGeoLocation()` to be implemented. Currently logs a warning if not available.

---

## Connection Events

The XMR wrapper also emits internal connection events:

### connected

Fired when WebSocket connection is established.

**Action**:
- Sets `connected = true`
- Resets `reconnectAttempts = 0`
- Updates player status

---

### disconnected

Fired when WebSocket connection is lost.

**Action**:
- Sets `connected = false`
- Updates player status
- Schedules automatic reconnection (unless intentionally stopped)

---

### error

Fired when WebSocket encounters an error.

**Action**:
- Logs error to console
- Does not affect connection state

---

## Command Implementation

All commands follow this pattern:

```javascript
// 1. Register handler in setupEventHandlers()
this.xmr.on('commandName', async (data) => {
  console.log('[XMR] Received commandName:', data);
  try {
    await this.player.performAction(data);
    console.log('[XMR] commandName completed successfully');
  } catch (error) {
    console.error('[XMR] commandName failed:', error);
  }
});
```

## Error Handling

All command handlers implement graceful error handling:

1. **Try/catch blocks** - All async operations wrapped in try/catch
2. **Logging** - Errors logged to console with context
3. **Non-blocking** - Errors don't crash the player
4. **Connection preservation** - Command failures don't disconnect XMR

## Testing

All commands are covered by comprehensive unit tests in `xmr-wrapper.test.js`:

- ✅ Command execution (happy path)
- ✅ Error handling (failure scenarios)
- ✅ Missing implementation warnings
- ✅ Multiple simultaneous commands
- ✅ Connection state preservation

Run tests with:
```bash
npm test
```

## Adding New Commands

To add support for a new XMR command:

1. **Add handler** in `setupEventHandlers()`:
   ```javascript
   this.xmr.on('newCommand', async (data) => {
     console.log('[XMR] Received newCommand:', data);
     try {
       await this.player.handleNewCommand(data);
       console.log('[XMR] newCommand completed successfully');
     } catch (error) {
       console.error('[XMR] newCommand failed:', error);
     }
   });
   ```

2. **Update documentation** (this file):
   - Add command reference
   - Document payload structure
   - Provide usage example

3. **Add tests** in `xmr-wrapper.test.js`:
   - Test happy path
   - Test error handling
   - Test edge cases

4. **Implement player method** (if needed):
   ```javascript
   // In player-core.js or appropriate module
   async handleNewCommand(data) {
     // Implementation
   }
   ```

## Version History

### v0.10.0 (Current)
- ✅ Replaced upstream library with native `XmrClient` (generic action dispatch)
- ✅ All 14 CMS commands supported (upstream only handled 5)
- ✅ Any future CMS action works automatically (no code changes needed)
- ✅ Eliminated luxon (68KB) and nanoevents dependencies
- ✅ 82 tests (26 XmrClient + 56 XmrWrapper)

### v0.9.0
- ✅ Added `criteriaUpdate` and `currentGeoLocation` commands
- ✅ Intentional shutdown flag (no reconnect on stop)
- ✅ Comprehensive test suite

### v0.8.0
- Initial implementation with full command set
- Connection lifecycle management
- Automatic reconnection with 60s health-check interval

## References

- **XMR Client**: Native `XmrClient` (`xmr-client.js`) — full XMR protocol implementation
- **Xibo CMS**: https://xibosignage.com
- **XMR Protocol**: WebSocket-based push messaging
