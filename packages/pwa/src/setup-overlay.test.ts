// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Unit tests for SetupOverlay.
 *
 * Tests show/hide/toggle lifecycle, backdrop and iframe management,
 * gate card visibility, and the CMS key validation flow.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock @xiboplayer/utils before importing SetupOverlay
vi.mock('@xiboplayer/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: {
    cmsKey: 'test-cms-key-123',
  },
}));

import { SetupOverlay } from './setup-overlay.js';

// ── Helpers ─────────────────────────────────────────────────

function getBackdrop(): HTMLElement | null {
  return document.getElementById('setup-overlay-backdrop');
}

// ── Tests ───────────────────────────────────────────────────

describe('SetupOverlay', () => {
  afterEach(() => {
    document.querySelectorAll('#setup-overlay-backdrop').forEach(el => el.remove());
  });

  // ── show / hide / toggle ──────────────────────────────────

  describe('show', () => {
    it('creates the backdrop on first show', () => {
      const overlay = new SetupOverlay();
      expect(getBackdrop()).toBeNull();
      overlay.show();
      expect(getBackdrop()).not.toBeNull();
      overlay.hide();
    });

    it('makes the backdrop visible', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      expect(getBackdrop()!.style.display).toBe('flex');
      overlay.hide();
    });

    it('is idempotent (calling show twice does not duplicate)', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      overlay.show();
      expect(document.querySelectorAll('#setup-overlay-backdrop').length).toBe(1);
      overlay.hide();
    });

    it('sets isVisible to true', () => {
      const overlay = new SetupOverlay();
      expect(overlay.isVisible()).toBe(false);
      overlay.show();
      expect(overlay.isVisible()).toBe(true);
      overlay.hide();
    });
  });

  describe('hide', () => {
    it('hides the backdrop', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      overlay.hide();
      expect(getBackdrop()!.style.display).toBe('none');
    });

    it('sets isVisible to false', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      overlay.hide();
      expect(overlay.isVisible()).toBe(false);
    });

    it('is safe to call without prior show', () => {
      const overlay = new SetupOverlay();
      overlay.hide(); // should not throw
      expect(overlay.isVisible()).toBe(false);
    });
  });

  describe('toggle', () => {
    it('shows when hidden', () => {
      const overlay = new SetupOverlay();
      overlay.toggle();
      expect(overlay.isVisible()).toBe(true);
      overlay.hide();
    });

    it('hides when visible', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      overlay.toggle();
      expect(overlay.isVisible()).toBe(false);
    });
  });

  // ── DOM structure ─────────────────────────────────────────

  describe('DOM structure', () => {
    it('contains the gate card with CMS Key input', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const input = getBackdrop()!.querySelector('#gate-key') as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.type).toBe('password');
      overlay.hide();
    });

    it('contains the gate form', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const form = getBackdrop()!.querySelector('#gate-form') as HTMLFormElement;
      expect(form).not.toBeNull();
      overlay.hide();
    });

    it('contains a cancel button inside the gate card', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const cancelBtn = getBackdrop()!.querySelector('#gate-cancel') as HTMLButtonElement;
      expect(cancelBtn).not.toBeNull();
      expect(cancelBtn.textContent!.trim()).toBe('Cancel');
      overlay.hide();
    });

    it('contains an iframe (initially hidden)', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const iframe = getBackdrop()!.querySelector('iframe') as HTMLIFrameElement;
      expect(iframe).not.toBeNull();
      expect(iframe.style.display).toBe('none');
      overlay.hide();
    });
  });

  // ── Gate validation ───────────────────────────────────────

  describe('gate CMS key validation', () => {
    it('shows error for incorrect CMS key', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const input = getBackdrop()!.querySelector('#gate-key') as HTMLInputElement;
      const form = getBackdrop()!.querySelector('#gate-form') as HTMLFormElement;
      const errorEl = getBackdrop()!.querySelector('#gate-error') as HTMLElement;

      input.value = 'wrong-key';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      expect(errorEl.style.display).toBe('block');
      expect(errorEl.textContent).toBe('Incorrect CMS key');
      overlay.hide();
    });

    it('shows iframe on correct CMS key', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const input = getBackdrop()!.querySelector('#gate-key') as HTMLInputElement;
      const form = getBackdrop()!.querySelector('#gate-form') as HTMLFormElement;

      input.value = 'test-cms-key-123';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const iframe = getBackdrop()!.querySelector('iframe') as HTMLIFrameElement;
      expect(iframe.style.display).toBe('block');
      expect(iframe.src).toContain('setup.html');
      overlay.hide();
    });

    it('hides gate card after successful unlock', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const input = getBackdrop()!.querySelector('#gate-key') as HTMLInputElement;
      const form = getBackdrop()!.querySelector('#gate-form') as HTMLFormElement;
      const gateCard = input.closest('div[style]')!.parentElement!;

      input.value = 'test-cms-key-123';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      // Gate card's parent (the card container) should be hidden
      // The gate card is the div with the form in it
      const gateParent = form.closest('div')!;
      // Walk up to find the card container
      let card = gateParent;
      while (card.parentElement && card.parentElement.id !== 'setup-overlay-backdrop') {
        card = card.parentElement;
      }
      expect(card.style.display).toBe('none');
      overlay.hide();
    });
  });

  // ── Cancel button closes overlay ──────────────────────────

  describe('cancel button', () => {
    it('gate cancel button hides the overlay', () => {
      const overlay = new SetupOverlay();
      overlay.show();
      const cancelBtn = getBackdrop()!.querySelector('#gate-cancel') as HTMLButtonElement;
      cancelBtn.click();
      expect(overlay.isVisible()).toBe(false);
    });
  });
});
