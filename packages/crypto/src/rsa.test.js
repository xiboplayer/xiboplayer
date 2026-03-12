// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * RSA Key Generation Tests
 *
 * Tests for Web Crypto API-based RSA key pair generation.
 */

import { describe, it, expect } from 'vitest';
import { generateRsaKeyPair, isValidPemKey, arrayBufferToPem } from './rsa.js';

describe('generateRsaKeyPair', () => {
  it('should return publicKeyPem and privateKeyPem', async () => {
    const keys = await generateRsaKeyPair();

    expect(keys).toHaveProperty('publicKeyPem');
    expect(keys).toHaveProperty('privateKeyPem');
    expect(typeof keys.publicKeyPem).toBe('string');
    expect(typeof keys.privateKeyPem).toBe('string');
  });

  it('should produce valid PEM public key with correct headers', async () => {
    const { publicKeyPem } = await generateRsaKeyPair();

    expect(publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(publicKeyPem).toMatch(/\n-----END PUBLIC KEY-----$/);
  });

  it('should produce valid PEM private key with correct headers', async () => {
    const { privateKeyPem } = await generateRsaKeyPair();

    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(privateKeyPem).toMatch(/\n-----END PRIVATE KEY-----$/);
  });

  it('should contain base64-encoded content between headers', async () => {
    const { publicKeyPem } = await generateRsaKeyPair();

    // Extract content between headers
    const lines = publicKeyPem.split('\n');
    const contentLines = lines.slice(1, -1); // Remove BEGIN/END lines

    for (const line of contentLines) {
      expect(line).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(line.length).toBeLessThanOrEqual(64);
    }
  });

  it('should generate different keys on each call', async () => {
    const keys1 = await generateRsaKeyPair();
    const keys2 = await generateRsaKeyPair();

    expect(keys1.publicKeyPem).not.toBe(keys2.publicKeyPem);
    expect(keys1.privateKeyPem).not.toBe(keys2.privateKeyPem);
  });

  it('should produce keys that pass isValidPemKey', async () => {
    const { publicKeyPem, privateKeyPem } = await generateRsaKeyPair();

    expect(isValidPemKey(publicKeyPem)).toBe(true);
    expect(isValidPemKey(privateKeyPem)).toBe(true);
  });
});

describe('isValidPemKey', () => {
  it('should accept valid PUBLIC KEY PEM', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ==\n-----END PUBLIC KEY-----';
    expect(isValidPemKey(pem)).toBe(true);
  });

  it('should accept valid PRIVATE KEY PEM', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAw\n-----END PRIVATE KEY-----';
    expect(isValidPemKey(pem)).toBe(true);
  });

  it('should reject null', () => {
    expect(isValidPemKey(null)).toBe(false);
  });

  it('should reject undefined', () => {
    expect(isValidPemKey(undefined)).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidPemKey('')).toBe(false);
  });

  it('should reject random string', () => {
    expect(isValidPemKey('not-a-pem-key')).toBe(false);
  });

  it('should reject mismatched headers', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\ndata\n-----END PRIVATE KEY-----';
    expect(isValidPemKey(pem)).toBe(false);
  });

  it('should reject PEM with no content', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----';
    expect(isValidPemKey(pem)).toBe(false);
  });
});

describe('arrayBufferToPem', () => {
  it('should wrap DER data in PEM headers', () => {
    const buffer = new Uint8Array([0x30, 0x82, 0x01, 0x0a]).buffer;
    const pem = arrayBufferToPem(buffer, 'PUBLIC KEY');

    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(pem).toMatch(/\n-----END PUBLIC KEY-----$/);
  });

  it('should split base64 into 64-char lines', () => {
    // Create a buffer large enough to produce multiple lines
    const buffer = new Uint8Array(100).buffer;
    const pem = arrayBufferToPem(buffer, 'PUBLIC KEY');

    const lines = pem.split('\n');
    // Skip first (BEGIN) and last (END) lines
    const contentLines = lines.slice(1, -1);
    for (const line of contentLines.slice(0, -1)) {
      expect(line.length).toBe(64);
    }
  });
});
