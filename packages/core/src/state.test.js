// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * PlayerState Tests
 *
 * Tests for centralized player state management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlayerState } from './state.js';

describe('PlayerState', () => {
  let state;

  beforeEach(() => {
    state = new PlayerState();
  });

  describe('Initial State', () => {
    it('should start with null currentLayoutId', () => {
      expect(state.currentLayoutId).toBeNull();
    });

    it('should start with null currentScheduleId', () => {
      expect(state.currentScheduleId).toBeNull();
    });

    it('should start with empty displayName', () => {
      expect(state.displayName).toBe('');
    });

    it('should start with empty hardwareKey', () => {
      expect(state.hardwareKey).toBe('');
    });

    it('should start with pwa playerType', () => {
      expect(state.playerType).toBe('pwa');
    });

    it('should start with idle displayStatus', () => {
      expect(state.displayStatus).toBe('idle');
    });

    it('should start with zero screen dimensions', () => {
      expect(state.screenWidth).toBe(0);
      expect(state.screenHeight).toBe(0);
    });

    it('should start with null lastCollectionTime', () => {
      expect(state.lastCollectionTime).toBeNull();
    });

    it('should start with null lastHeartbeat', () => {
      expect(state.lastHeartbeat).toBeNull();
    });

    it('should start with isRegistered false', () => {
      expect(state.isRegistered).toBe(false);
    });
  });

  describe('set()', () => {
    it('should update a property value', () => {
      state.set('displayName', 'Test Display');

      expect(state.displayName).toBe('Test Display');
    });

    it('should emit change event with key, new value, and old value', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('displayStatus', 'rendering');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('displayStatus', 'rendering', 'idle');
    });

    it('should not emit change event when value is the same', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('playerType', 'pwa'); // Same as initial value

      expect(spy).not.toHaveBeenCalled();
    });

    it('should not emit change event for same null value', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('currentLayoutId', null); // Same as initial value

      expect(spy).not.toHaveBeenCalled();
    });

    it('should emit change event when changing from null to a value', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('currentLayoutId', 42);

      expect(spy).toHaveBeenCalledWith('currentLayoutId', 42, null);
    });

    it('should emit change event when changing from a value to null', () => {
      state.set('currentLayoutId', 42);

      const spy = vi.fn();
      state.on('change', spy);

      state.set('currentLayoutId', null);

      expect(spy).toHaveBeenCalledWith('currentLayoutId', null, 42);
    });

    it('should handle multiple sequential updates', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('displayStatus', 'collecting');
      state.set('displayStatus', 'rendering');
      state.set('displayStatus', 'idle');

      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenNthCalledWith(1, 'displayStatus', 'collecting', 'idle');
      expect(spy).toHaveBeenNthCalledWith(2, 'displayStatus', 'rendering', 'collecting');
      expect(spy).toHaveBeenNthCalledWith(3, 'displayStatus', 'idle', 'rendering');
    });

    it('should update numeric properties', () => {
      state.set('screenWidth', 1920);
      state.set('screenHeight', 1080);

      expect(state.screenWidth).toBe(1920);
      expect(state.screenHeight).toBe(1080);
    });

    it('should update boolean properties', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('isRegistered', true);

      expect(state.isRegistered).toBe(true);
      expect(spy).toHaveBeenCalledWith('isRegistered', true, false);
    });

    it('should not emit when setting same boolean value', () => {
      const spy = vi.fn();
      state.on('change', spy);

      state.set('isRegistered', false); // Same as initial

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('toJSON()', () => {
    it('should return a snapshot of all state properties', () => {
      const json = state.toJSON();

      expect(json).toEqual({
        currentLayoutId: null,
        currentScheduleId: null,
        displayName: '',
        hardwareKey: '',
        playerType: 'pwa',
        displayStatus: 'idle',
        screenWidth: 0,
        screenHeight: 0,
        lastCollectionTime: null,
        lastHeartbeat: null,
        isRegistered: false
      });
    });

    it('should reflect updated values', () => {
      state.set('displayName', 'My Display');
      state.set('currentLayoutId', 123);
      state.set('isRegistered', true);
      state.set('screenWidth', 1920);
      state.set('screenHeight', 1080);

      const json = state.toJSON();

      expect(json.displayName).toBe('My Display');
      expect(json.currentLayoutId).toBe(123);
      expect(json.isRegistered).toBe(true);
      expect(json.screenWidth).toBe(1920);
      expect(json.screenHeight).toBe(1080);
    });

    it('should return a plain object (not the state instance)', () => {
      const json = state.toJSON();

      expect(json).not.toBe(state);
      expect(json.constructor).toBe(Object);
    });

    it('should return independent snapshot (mutations do not affect original)', () => {
      const json = state.toJSON();
      json.displayName = 'Modified';

      expect(state.displayName).toBe(''); // Original unchanged
    });
  });
});
