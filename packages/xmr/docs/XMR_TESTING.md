# XMR Testing Guide

This guide explains how to test XMR (Xibo Message Relay) integration in the Xibo player.

## Table of Contents

1. [Unit Tests](#unit-tests)
2. [Integration Testing](#integration-testing)
3. [Manual Testing](#manual-testing)
4. [Real XMR Server Testing](#real-xmr-server-testing)
5. [Troubleshooting](#troubleshooting)

---

## Unit Tests

The XMR package includes comprehensive unit tests covering all functionality.

### Running Tests

```bash
# From xmr package directory
cd packages/xmr
npm test

# With coverage report
npm run test:coverage

# Watch mode (auto-run on file changes)
npm run test:watch
```

### Test Coverage

Current coverage: **48 test cases**

Categories:
- ✅ **Constructor** (2 tests) - Initialization and state
- ✅ **Connection lifecycle** (8 tests) - Start, stop, reconnect
- ✅ **Connection events** (4 tests) - connected, disconnected, error
- ✅ **CMS commands** (14 tests) - All 7 commands + error handling
- ✅ **Reconnection logic** (4 tests) - Exponential backoff, max attempts
- ✅ **stop() method** (4 tests) - Cleanup, error handling
- ✅ **isConnected()** (3 tests) - Connection state queries
- ✅ **send()** (4 tests) - Sending messages to CMS
- ✅ **Edge cases** (3 tests) - Simultaneous commands, rapid cycles
- ✅ **Memory management** (2 tests) - Timer cleanup, garbage collection

### Test Structure

Tests use Vitest with:
- **Mocking**: `vi.mock()` for @xibosignage/xibo-communication-framework
- **Fake timers**: `vi.useFakeTimers()` for reconnection testing
- **Async handling**: `vi.runAllTimersAsync()` for event handlers

Example test:
```javascript
it('should handle collectNow command', async () => {
  await wrapper.start('wss://test.xmr.com', 'cms-key-123');
  const xmr = wrapper.xmr;

  xmr.simulateCommand('collectNow');
  await vi.runAllTimersAsync();

  expect(mockPlayer.collect).toHaveBeenCalled();
});
```

---

## Integration Testing

### Mock XMR Server

For integration testing without a real CMS, create a mock XMR server:

```javascript
// test-xmr-server.js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 9505 });

wss.on('connection', (ws) => {
  console.log('Player connected');

  // Send test command after 2 seconds
  setTimeout(() => {
    ws.send(JSON.stringify({
      action: 'collectNow'
    }));
  }, 2000);

  ws.on('message', (data) => {
    console.log('Received from player:', data.toString());
  });
});

console.log('Mock XMR server listening on ws://localhost:9505');
```

Run:
```bash
node test-xmr-server.js
```

Configure player to connect:
```javascript
await xmrWrapper.start('ws://localhost:9505', 'test-key');
```

### Testing Commands

Send commands from mock server:

```javascript
// collectNow
ws.send(JSON.stringify({ action: 'collectNow' }));

// screenShot
ws.send(JSON.stringify({ action: 'screenShot' }));

// changeLayout
ws.send(JSON.stringify({
  action: 'changeLayout',
  layoutId: 'layout-123'
}));

// criteriaUpdate
ws.send(JSON.stringify({
  action: 'criteriaUpdate',
  data: { displayId: '123', criteria: 'new-criteria' }
}));

// currentGeoLocation
ws.send(JSON.stringify({
  action: 'currentGeoLocation',
  data: { latitude: 40.7128, longitude: -74.0060 }
}));
```

---

## Manual Testing

### Prerequisites

1. **XMR-enabled CMS**: Xibo CMS 2.3+ with XMR configured
2. **Player**: Xibo PWA/Linux player with XMR package
3. **Network**: Player can reach CMS XMR endpoint (typically port 9505)

### Testing Steps

#### 1. Enable XMR in CMS

1. Go to **Administration** → **Settings** → **Displays**
2. Set **Enable XMR** to **Yes**
3. Configure **XMR Address** (e.g., `ws://your-cms.com:9505`)
4. Save settings

#### 2. Configure Player

Player should receive XMR settings automatically from `registerDisplay`:

```javascript
// In registerDisplay response
{
  settings: {
    xmrWebSocketAddress: 'wss://cms.example.com:9505',
    xmrCmsKey: 'your-cms-key-here'
  }
}
```

#### 3. Verify Connection

Check player logs:
```
[XMR] Initializing connection to: wss://cms.example.com:9505
[XMR] WebSocket connected
[XMR] Connected successfully
```

Check CMS logs (XMR server):
```
Player connected: player-hw-key-123
```

#### 4. Test Commands

From CMS display management page:

**Test collectNow:**
1. Click display name
2. Click **Send Command** → **Collect Now**
3. Verify player logs:
   ```
   [XMR] Received collectNow command from CMS
   [XMR] collectNow completed successfully
   ```

**Test screenShot:**
1. Click **Send Command** → **Request Screenshot**
2. Verify screenshot appears in display's **Screenshots** tab

**Test changeLayout:**
1. Click **Send Command** → **Change Layout**
2. Select layout
3. Verify player switches immediately

#### 5. Test Reconnection

**Simulate connection loss:**
1. Stop XMR server on CMS
2. Verify player logs:
   ```
   [XMR] WebSocket disconnected
   [XMR] Connection lost, scheduling reconnection...
   [XMR] Scheduling reconnect attempt 1/10 in 5000ms
   ```
3. Restart XMR server
4. Verify player reconnects automatically

---

## Real XMR Server Testing

### Setup

1. **Install Xibo CMS** with Docker:
   ```bash
   git clone https://github.com/xibosignage/xibo-docker
   cd xibo-docker
   docker-compose up -d
   ```

2. **Enable XMR** in CMS settings (see Manual Testing above)

3. **Configure player** with CMS credentials:
   ```javascript
   const config = {
     cmsUrl: 'http://localhost',
     hardwareKey: 'test-player-123',
     serverKey: 'your-server-key'
   };
   ```

### Test Scenarios

#### Scenario 1: Basic Commands

1. Register player with CMS
2. Send collectNow via CMS display page
3. Verify XMDS collection triggered
4. Send screenShot
5. Verify screenshot uploaded
6. Send changeLayout
7. Verify layout changes

**Expected**: All commands execute successfully

#### Scenario 2: Network Interruption

1. Establish XMR connection
2. Block port 9505 with firewall:
   ```bash
   sudo iptables -A OUTPUT -p tcp --dport 9505 -j DROP
   ```
3. Wait for reconnection attempts
4. Unblock port:
   ```bash
   sudo iptables -D OUTPUT -p tcp --dport 9505 -j DROP
   ```
5. Verify automatic reconnection

**Expected**: Player reconnects within 50 seconds (max 10 attempts × 5s)

#### Scenario 3: Multiple Players

1. Start 5 players with different hardware keys
2. Send collectNow to all
3. Verify all receive command
4. Send changeLayout to specific player
5. Verify only that player changes layout

**Expected**: Commands routed to correct players

#### Scenario 4: High Frequency Commands

1. Send 10 collectNow commands in 10 seconds
2. Verify all execute without dropping
3. Monitor memory usage

**Expected**: No memory leaks, all commands processed

#### Scenario 5: CMS Upgrade

1. Establish XMR connection
2. Upgrade CMS (restart XMR server)
3. Verify player reconnects after upgrade

**Expected**: Automatic reconnection within 5-10 seconds

---

## Troubleshooting

### Connection Issues

**Problem**: XMR won't connect

**Checks**:
1. Verify XMR enabled in CMS settings
2. Check firewall allows port 9505
3. Verify `xmrWebSocketAddress` in registerDisplay response
4. Check player logs for errors

**Solution**:
```bash
# Test XMR connectivity
wscat -c wss://cms.example.com:9505

# Check XMR server status
docker logs xibo-xmr
```

---

### Commands Not Executing

**Problem**: collectNow sent but not executed

**Checks**:
1. Verify XMR connected (`wrapper.isConnected() === true`)
2. Check player logs for command reception
3. Verify player.collect() method exists
4. Check for errors in command handler

**Solution**:
```javascript
// Add debug logging
this.xmr.on('collectNow', async () => {
  console.log('[XMR] collectNow handler triggered');
  console.log('[XMR] player.collect:', typeof this.player.collect);
  // ...
});
```

---

### Reconnection Loops

**Problem**: Player keeps reconnecting endlessly

**Checks**:
1. Verify XMR server is actually running
2. Check for auth errors (wrong cmsKey)
3. Monitor reconnectAttempts counter

**Solution**:
```javascript
// Check reconnect state
console.log('Reconnect attempts:', wrapper.reconnectAttempts);
console.log('Max attempts:', wrapper.maxReconnectAttempts);

// Manually stop reconnecting
await wrapper.stop();
```

---

### Memory Leaks

**Problem**: Memory usage grows over time

**Checks**:
1. Verify `stop()` clears timers
2. Check for event listener leaks
3. Monitor with Chrome DevTools heap snapshots

**Solution**:
```javascript
// Ensure cleanup on shutdown
await wrapper.stop();
expect(wrapper.reconnectTimer).toBeNull();

// Check event listeners
console.log('XMR listeners:', wrapper.xmr?.events?.size);
```

---

## Performance Benchmarks

Expected performance metrics:

| Metric | Target | Acceptable |
|--------|--------|------------|
| Connection time | < 1s | < 3s |
| Command execution | < 100ms | < 500ms |
| Reconnection time | < 5s | < 30s |
| Memory overhead | < 5MB | < 10MB |
| CPU usage | < 1% | < 5% |

Measure with:
```javascript
// Connection time
const start = Date.now();
await wrapper.start(url, key);
console.log('Connect time:', Date.now() - start);

// Command execution
const cmdStart = Date.now();
xmr.simulateCommand('collectNow');
await waitFor(() => mockPlayer.collect.called);
console.log('Exec time:', Date.now() - cmdStart);

// Memory
const baseline = process.memoryUsage().heapUsed;
await wrapper.start(url, key);
const withXmr = process.memoryUsage().heapUsed;
console.log('Memory overhead:', (withXmr - baseline) / 1024 / 1024, 'MB');
```

---

## Continuous Integration

### GitHub Actions

```yaml
name: XMR Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
        working-directory: packages/xmr
      - run: npm run test:coverage
        working-directory: packages/xmr
      - uses: codecov/codecov-action@v2
        with:
          files: packages/xmr/coverage/lcov.info
```

---

## Test Data

### Sample registerDisplay Response

```json
{
  "displayName": "Test Display",
  "settings": {
    "collectInterval": "300",
    "xmrWebSocketAddress": "wss://cms.example.com:9505",
    "xmrCmsKey": "abcdef123456",
    "xmrChannel": "player-hw-key-123"
  }
}
```

### Sample XMR Messages

```javascript
// collectNow
{ "action": "collectNow" }

// screenShot
{ "action": "screenShot" }

// changeLayout
{ "action": "changeLayout", "layoutId": "42" }

// criteriaUpdate
{
  "action": "criteriaUpdate",
  "data": {
    "displayId": "123",
    "criteria": "tag:urgent,location:lobby"
  }
}

// currentGeoLocation
{
  "action": "currentGeoLocation",
  "data": {
    "latitude": 40.7128,
    "longitude": -74.0060
  }
}
```

---

## References

- XMR Commands: [XMR_COMMANDS.md](./XMR_COMMANDS.md)
- XMR Library: [@xibosignage/xibo-communication-framework](https://www.npmjs.com/package/@xibosignage/xibo-communication-framework)
- Xibo CMS: https://xibosignage.com
- WebSocket Testing: https://github.com/websockets/wscat
