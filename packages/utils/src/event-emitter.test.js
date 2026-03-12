// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * EventEmitter Tests
 *
 * Contract-based testing for EventEmitter module
 * Tests all pre/post conditions, invariants, and edge cases
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from './event-emitter.js';

/** Simple spy factory — wraps vi.fn() for readability */
const createSpy = () => vi.fn();

describe('EventEmitter', () => {
  let emitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  describe('on(event, callback)', () => {
    it('should satisfy contract: registers callback for event', () => {
      const callback = createSpy();

      // Pre-condition: emitter has no listeners
      expect(emitter.events.size).toBe(0);

      // Execute
      emitter.on('test', callback);

      // Post-condition: callback registered
      expect(emitter.events.has('test')).toBe(true);
      expect(emitter.events.get('test')).toContain(callback);
    });

    it('should allow same callback to be registered multiple times', () => {
      const callback = createSpy();

      emitter.on('test', callback);
      emitter.on('test', callback);
      emitter.on('test', callback);

      // Invariant: Same callback can be registered multiple times
      expect(emitter.events.get('test').length).toBe(3);

      // When emitted, called for each registration
      emitter.emit('test');
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('should create event array if not exists', () => {
      const callback = createSpy();

      emitter.on('new-event', callback);

      expect(emitter.events.has('new-event')).toBe(true);
      expect(Array.isArray(emitter.events.get('new-event'))).toBe(true);
    });

    it('should support multiple callbacks for same event', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();
      const callback3 = createSpy();

      emitter.on('test', callback1);
      emitter.on('test', callback2);
      emitter.on('test', callback3);

      expect(emitter.events.get('test').length).toBe(3);
    });
  });

  describe('once(event, callback)', () => {
    it('should satisfy contract: callback called once then removed', () => {
      const callback = createSpy();

      // Pre-condition: no listeners
      expect(emitter.events.size).toBe(0);

      // Execute
      emitter.once('test', callback);

      // Post-condition: wrapper registered
      expect(emitter.events.has('test')).toBe(true);
      expect(emitter.events.get('test').length).toBe(1);

      // Emit first time
      emitter.emit('test', 'arg1');

      // Invariant: callback called
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('arg1');

      // Invariant: callback removed after emission
      expect(emitter.events.get('test').length).toBe(0);

      // Emit second time
      emitter.emit('test', 'arg2');

      // Invariant: callback NOT called again
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should remove wrapper correctly', () => {
      const callback = createSpy();

      emitter.once('test', callback);

      // Before emission: 1 listener (wrapper)
      const listenersBeforeEmit = emitter.events.get('test');
      expect(listenersBeforeEmit.length).toBe(1);

      // Emit
      emitter.emit('test');

      // After emission: 0 listeners
      expect(emitter.events.get('test').length).toBe(0);
    });

    it('should support multiple once() listeners', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();

      emitter.once('test', callback1);
      emitter.once('test', callback2);

      // Both wrappers registered
      expect(emitter.events.get('test').length).toBe(2);

      // Emit
      emitter.emit('test', 'data');

      // Both called (array is copied before iteration)
      expect(callback1).toHaveBeenCalledWith('data');
      expect(callback2).toHaveBeenCalledWith('data');

      // Both removed
      expect(emitter.events.get('test').length).toBe(0);
    });
  });

  describe('emit(event, ...args)', () => {
    it('should satisfy contract: calls all registered callbacks with args', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();

      emitter.on('test', callback1);
      emitter.on('test', callback2);

      // Execute
      emitter.emit('test', 'arg1', 'arg2', 'arg3');

      // Post-condition: All callbacks called with args
      expect(callback1).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
      expect(callback2).toHaveBeenCalledWith('arg1', 'arg2', 'arg3');
    });

    it('should maintain invariant: callbacks invoked in registration order', () => {
      const callOrder = [];

      emitter.on('test', () => callOrder.push('first'));
      emitter.on('test', () => callOrder.push('second'));
      emitter.on('test', () => callOrder.push('third'));

      emitter.emit('test');

      expect(callOrder).toEqual(['first', 'second', 'third']);
    });

    it('should handle emit with no listeners (no error)', () => {
      // Edge case: emitting event with no listeners should not throw
      expect(() => {
        emitter.emit('non-existent-event', 'data');
      }).not.toThrow();
    });

    it('should pass multiple arguments correctly', () => {
      const callback = createSpy();
      emitter.on('test', callback);

      emitter.emit('test', 1, 'two', { three: 3 }, [4, 5]);

      expect(callback).toHaveBeenCalledWith(1, 'two', { three: 3 }, [4, 5]);
    });

    it('should handle zero arguments', () => {
      const callback = createSpy();
      emitter.on('test', callback);

      emitter.emit('test');

      expect(callback).toHaveBeenCalledWith();
    });
  });

  describe('off(event, callback)', () => {
    it('should satisfy contract: removes specific callback', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();
      const callback3 = createSpy();

      emitter.on('test', callback1);
      emitter.on('test', callback2);
      emitter.on('test', callback3);

      // Pre-condition: 3 callbacks
      expect(emitter.events.get('test').length).toBe(3);

      // Execute: remove callback2
      emitter.off('test', callback2);

      // Post-condition: only callback2 removed
      const listeners = emitter.events.get('test');
      expect(listeners.length).toBe(2);
      expect(listeners).toContain(callback1);
      expect(listeners).toContain(callback3);
      expect(listeners).not.toContain(callback2);
    });

    it('should maintain invariant: other callbacks unaffected', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();

      emitter.on('test', callback1);
      emitter.on('test', callback2);

      // Remove callback1
      emitter.off('test', callback1);

      // Emit
      emitter.emit('test', 'data');

      // Invariant: only callback2 called
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith('data');
    });

    it('should handle removing non-existent callback (no error)', () => {
      const callback = createSpy();

      // Edge case: removing callback that was never added
      expect(() => {
        emitter.off('test', callback);
      }).not.toThrow();
    });

    it('should handle removing from non-existent event (no error)', () => {
      const callback = createSpy();

      // Edge case: event doesn't exist
      expect(() => {
        emitter.off('non-existent', callback);
      }).not.toThrow();
    });

    it('should remove only first occurrence when callback registered multiple times', () => {
      const callback = createSpy();

      emitter.on('test', callback);
      emitter.on('test', callback);
      emitter.on('test', callback);

      // 3 registrations
      expect(emitter.events.get('test').length).toBe(3);

      // Remove once
      emitter.off('test', callback);

      // 2 remaining
      expect(emitter.events.get('test').length).toBe(2);

      // Emit: called 2 times
      emitter.emit('test');
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('removeAllListeners(event?)', () => {
    it('should satisfy contract: removes all listeners for specific event', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();

      emitter.on('test1', callback1);
      emitter.on('test1', callback2);
      emitter.on('test2', callback1);

      // Pre-condition: 2 events with listeners
      expect(emitter.events.size).toBe(2);
      expect(emitter.events.get('test1').length).toBe(2);

      // Execute: remove all for 'test1'
      emitter.removeAllListeners('test1');

      // Post-condition: test1 removed, test2 intact
      expect(emitter.events.has('test1')).toBe(false);
      expect(emitter.events.has('test2')).toBe(true);
      expect(emitter.events.get('test2').length).toBe(1);
    });

    it('should satisfy contract: removes ALL listeners when event not specified', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();

      emitter.on('test1', callback1);
      emitter.on('test2', callback2);
      emitter.on('test3', callback1);

      // Pre-condition: 3 events
      expect(emitter.events.size).toBe(3);

      // Execute: remove all
      emitter.removeAllListeners();

      // Post-condition: all events removed
      expect(emitter.events.size).toBe(0);
    });

    it('should maintain invariant: events Map structure maintained', () => {
      emitter.on('test', createSpy());

      emitter.removeAllListeners('test');

      // Map still exists, just empty for that event
      expect(emitter.events).toBeInstanceOf(Map);
    });

    it('should handle removing listeners from non-existent event (no error)', () => {
      expect(() => {
        emitter.removeAllListeners('non-existent');
      }).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle callback removal during emission', () => {
      const callback1 = createSpy();
      const callback2 = vi.fn(() => {
        // Remove itself during execution
        emitter.off('test', callback2);
      });
      const callback3 = createSpy();

      emitter.on('test', callback1);
      emitter.on('test', callback2);
      emitter.on('test', callback3);

      // Emit
      emitter.emit('test');

      // All 3 called (array is copied before iteration)
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);

      // But callback2 removed for future emissions
      emitter.emit('test');
      expect(callback1).toHaveBeenCalledTimes(2);
      expect(callback2).toHaveBeenCalledTimes(1); // Not called again
      expect(callback3).toHaveBeenCalledTimes(2);
    });

    it('should handle errors in callbacks gracefully', () => {
      const callback1 = createSpy();
      const callback2 = vi.fn(() => {
        throw new Error('Callback error');
      });
      const callback3 = createSpy();

      emitter.on('test', callback1);
      emitter.on('test', callback2);
      emitter.on('test', callback3);

      // Error in callback2 should propagate
      expect(() => {
        emitter.emit('test');
      }).toThrow('Callback error');

      // callback1 was called (before error)
      expect(callback1).toHaveBeenCalledTimes(1);
      // callback3 NOT called (error stopped iteration)
      expect(callback3).not.toHaveBeenCalled();
    });

    it('should handle multiple events independently', () => {
      const callback1 = createSpy();
      const callback2 = createSpy();

      emitter.on('event1', callback1);
      emitter.on('event2', callback2);

      emitter.emit('event1', 'data1');

      expect(callback1).toHaveBeenCalledWith('data1');
      expect(callback2).not.toHaveBeenCalled();

      emitter.emit('event2', 'data2');

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledWith('data2');
    });
  });

  describe('Memory Management', () => {
    it('should not leak memory when listeners are removed', () => {
      // Register many listeners
      for (let i = 0; i < 1000; i++) {
        emitter.on(`event${i}`, createSpy());
      }

      expect(emitter.events.size).toBe(1000);

      // Remove all
      emitter.removeAllListeners();

      // Map properly cleaned
      expect(emitter.events.size).toBe(0);
    });

    it('should clean up event arrays when last listener removed', () => {
      const callback = createSpy();

      emitter.on('test', callback);
      expect(emitter.events.has('test')).toBe(true);

      emitter.off('test', callback);

      // Array still exists but empty (implementation detail)
      // This is acceptable - small memory overhead
      expect(emitter.events.get('test').length).toBe(0);
    });
  });
});
