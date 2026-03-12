# Changelog

All notable changes to @xiboplayer/xmr will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-03-12

### Changed

- **Replaced @xibosignage/xibo-communication-framework with native XmrClient**
  - Native `xmr-client.js` (~180 lines) replaces the upstream library entirely
  - Generic action dispatcher: `emit(message.action, message)` — every CMS action works
    automatically, no hardcoded if-else chain
  - Upstream only dispatched 5 of ~14 CMS actions; the rest fell through to
    `console.error('unknown action')`. Native client handles all actions generically.
  - TTL check uses native `Date.parse()` instead of luxon (eliminated 68KB dependency)
  - Event emitter uses built-in `Map<Set>` instead of nanoevents
  - Bundle size reduced by ~70KB

### Added

- **XmrClient unit tests** (26 tests)
  - WebSocket open/close/error lifecycle
  - Heartbeat handling
  - JSON action dispatch with TTL validation
  - Generic dispatch for unknown/future actions
  - `isActive()` 15min silence check
  - Reconnect interval (60s health check)
  - `stop()` cleanup
  - `on()`/`emit()` with unsubscribe and error isolation

### Removed

- `@xibosignage/xibo-communication-framework` dependency (from both `@xiboplayer/xmr`
  and `@xiboplayer/core` package.json)
- `luxon` (68KB) — no longer pulled in transitively
- `nanoevents` — no longer pulled in transitively

## [0.9.0] - 2026-02-10

### Added

- **New Commands**
  - `criteriaUpdate`: Updates display criteria and triggers re-collection
  - `currentGeoLocation`: Reports geographic location to CMS

- **Intentional Shutdown Flag**
  - Prevents automatic reconnection when `stop()` is called
  - Distinguishes between network errors and intentional disconnects
  - Cleaner shutdown behavior

- **Comprehensive Test Suite**
  - 48 test cases covering all functionality
  - Constructor and initialization tests
  - Connection lifecycle tests (start, stop, reconnect)
  - All 7 CMS command tests with error handling
  - Reconnection logic with exponential backoff
  - Memory management and cleanup tests
  - Edge cases (simultaneous commands, rapid cycles)

- **Complete Documentation**
  - Updated README.md with full API reference
  - XMR_COMMANDS.md: Complete command reference
  - XMR_TESTING.md: Comprehensive testing guide
  - Usage examples and troubleshooting

- **Test Utilities**
  - test-utils.js with mock helpers
  - createSpy(), createMockPlayer(), createMockConfig()
  - waitFor() and wait() async helpers

- **Vitest Configuration**
  - vitest.config.js for package-specific settings
  - Node environment (no DOM needed)
  - Coverage thresholds (80% lines, functions, statements)

### Changed

- **Command Handler Documentation**
  - Updated header comments with all supported commands
  - Listed both `screenShot` and `screenshot` aliases
  - Documented new v0.0.6 commands

- **Error Handling**
  - All commands now have graceful error handling
  - Errors logged but don't crash player
  - Connection state preserved across command failures

### Fixed

- **Reconnection on Stop**
  - Fixed issue where `stop()` would trigger reconnection
  - Added `intentionalShutdown` flag to prevent unwanted reconnects
  - Proper cleanup of reconnection timers on stop

- **Memory Leaks**
  - Ensured timers are cleared on stop
  - Proper event listener management
  - Garbage collection-friendly shutdown

## [0.8.0] - 2025-XX-XX

### Initial Implementation

- Full XMR protocol implementation with WebSocket connection lifecycle
- All CMS commands: collectNow, screenShot, changeLayout, overlayLayout, revertToSchedule, purgeAll, commandAction, triggerWebhook, dataUpdate, rekeyAction, criteriaUpdate, currentGeoLocation, licenceCheck
- Automatic reconnection with 60s health-check interval
- Connection lifecycle management
- Event-based command handling

## Upgrade Guide

### From 0.8.x to 0.9.0

**No breaking changes.** This is a feature release with new commands and improvements.

1. **Update dependency**:
   ```bash
   npm install @xiboplayer/xmr@0.9.0
   ```

2. **Optional: Implement new commands**:
   ```javascript
   // Add to your player class (optional)
   async reportGeoLocation(data) {
     // Your implementation
   }
   ```

3. **Enjoy new features**:
   - `criteriaUpdate` works automatically (triggers collect)
   - `currentGeoLocation` logs warning if not implemented
   - Better shutdown behavior (no reconnect loops)

## Testing

Run the test suite to verify the upgrade:

```bash
cd packages/xmr
npm test
```

All 48 tests should pass.

## Migration Notes

### No Breaking Changes

The v0.9.0 release is fully backward compatible with v0.8.x. All existing code will continue to work without modification.

### New Optional Features

If you want to use the new commands:

1. **criteriaUpdate**: No action needed, works automatically
2. **currentGeoLocation**: Implement `player.reportGeoLocation(data)` method

### Improved Behavior

The intentional shutdown flag improves shutdown behavior:

**Before (v0.8.x)**:
```javascript
await xmr.stop(); // Would trigger reconnection!
```

**After (v0.9.0)**:
```javascript
await xmr.stop(); // Clean shutdown, no reconnection
```

## Dependencies

### Removed

- `@xibosignage/xibo-communication-framework` — replaced by native `XmrClient`

### Current

- `@xiboplayer/utils`: workspace:* (logger)
- `vitest`: ^2.0.0 (dev dependency)

## Support

- **Documentation**: [README.md](./README.md)
- **GitHub Issues**: https://github.com/xibo/xibo-players/issues
- **Community**: https://community.xibo.org.uk

---

[Unreleased]: https://github.com/xibo/xibo-players/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/xibo/xibo-players/releases/tag/v0.9.0
[0.8.0]: https://github.com/xibo/xibo-players/releases/tag/v0.8.0
