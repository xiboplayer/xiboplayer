// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * RSA key pair generation via Web Crypto API.
 *
 * Generates RSA-1024 keys compatible with the upstream .NET player.
 * The SPKI PEM public key works with PHP's openssl_get_publickey().
 *
 * No runtime dependencies — uses only the Web Crypto API available
 * in browsers, Electron, and Node.js 16+.
 */

/**
 * Convert an ArrayBuffer (DER-encoded key) to PEM format.
 * @param {ArrayBuffer} buffer - DER-encoded key data
 * @param {string} type - Key type label ('PUBLIC KEY' or 'PRIVATE KEY')
 * @returns {string} PEM-formatted key string
 */
export function arrayBufferToPem(buffer, type) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  // Split into 64-character lines per PEM spec
  const lines = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.substring(i, i + 64));
  }

  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`;
}

/**
 * Generate an RSA key pair for XMR registration.
 *
 * Uses RSA-OAEP with SHA-256 and a 1024-bit modulus to match
 * the upstream .NET player's key format.
 *
 * @returns {Promise<{publicKeyPem: string, privateKeyPem: string}>}
 */
export async function generateRsaKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: 'SHA-256',
    },
    true, // extractable
    ['encrypt', 'decrypt']
  );

  const publicKeyDer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const privateKeyDer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    publicKeyPem: arrayBufferToPem(publicKeyDer, 'PUBLIC KEY'),
    privateKeyPem: arrayBufferToPem(privateKeyDer, 'PRIVATE KEY'),
  };
}

/**
 * Validate that a string looks like a valid PEM key.
 * Checks for proper BEGIN/END headers and base64 content.
 *
 * @param {string} pem - String to validate
 * @returns {boolean} true if the string appears to be valid PEM
 */
export function isValidPemKey(pem) {
  if (!pem || typeof pem !== 'string') return false;

  const pemRegex = /^-----BEGIN (PUBLIC KEY|PRIVATE KEY)-----\n[A-Za-z0-9+/=\n]+\n-----END \1-----$/;
  return pemRegex.test(pem.trim());
}
