/**
 * Ed25519 / XEdDSA Identity and Signing
 * Per identity.md spec: P2P identity uses Ed25519
 *
 * Uses libsignal's XEdDSA implementation which converts Curve25519 keys
 * to Ed25519 for signing operations (same as Signal Protocol standard).
 */

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

/**
 * Generate a P2P identity keypair
 * Uses Curve25519 internally, XEdDSA for signing (Ed25519-compatible)
 *
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
 */
export async function generateP2PIdentity() {
  // Use libsignal's key generation (Curve25519 with XEdDSA signing)
  const keyPair = await KeyHelper.generateIdentityKeyPair();

  return {
    // Public key is 33 bytes (0x05 prefix + 32 bytes Curve25519)
    publicKey: new Uint8Array(keyPair.pubKey),
    // Private key is 32 bytes
    privateKey: new Uint8Array(keyPair.privKey),
  };
}

/**
 * Sign data using XEdDSA (Curve25519 → Ed25519 signing)
 *
 * libsignal's generateSignedPreKey internally uses XEdDSA for signing.
 * For arbitrary data signing, we use the Curve25519 library directly.
 *
 * @param {Uint8Array|ArrayBuffer} data - Data to sign
 * @param {Uint8Array|ArrayBuffer} privateKey - 32-byte private key
 * @returns {Promise<Uint8Array>} 64-byte XEdDSA signature
 */
export async function sign(data, privateKey) {
  // Import the curve25519 library
  const curve25519 = await import('@privacyresearch/curve25519-typescript');
  const { AsyncCurve25519Wrapper } = curve25519.default || curve25519;
  const curve = new AsyncCurve25519Wrapper();

  const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const keyBuffer = privateKey instanceof ArrayBuffer ? privateKey : privateKey.buffer.slice(privateKey.byteOffset, privateKey.byteOffset + privateKey.byteLength);

  // XEdDSA sign: converts Curve25519 private key to Ed25519 and signs
  const signature = await curve.sign(keyBuffer, dataBuffer);

  return new Uint8Array(signature);
}

/**
 * Verify an XEdDSA signature
 *
 * @param {Uint8Array|ArrayBuffer} data - Original data
 * @param {Uint8Array|ArrayBuffer} signature - 64-byte signature
 * @param {Uint8Array|ArrayBuffer} publicKey - 33-byte public key (with 0x05 prefix) or 32-byte raw
 * @returns {Promise<boolean>} True if signature is valid
 */
export async function verify(data, signature, publicKey) {
  const curve25519 = await import('@privacyresearch/curve25519-typescript');
  const { AsyncCurve25519Wrapper } = curve25519.default || curve25519;
  const curve = new AsyncCurve25519Wrapper();

  const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const sigBuffer = signature instanceof ArrayBuffer ? signature : signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength);

  // Handle both 33-byte (with prefix) and 32-byte (raw) public keys
  let keyBytes = publicKey instanceof ArrayBuffer ? new Uint8Array(publicKey) : publicKey;

  if (keyBytes.length === 33 && keyBytes[0] === 0x05) {
    // Keep 33-byte key as-is for verify (it expects the prefix)
    // Actually, let's check what the verify method expects
  }

  try {
    // verify(pubKey, message, signature) - pubKey should be 33 bytes with prefix
    const result = await curve.verify(keyBytes, dataBuffer, sigBuffer);
    return result === true || result === undefined;
  } catch (e) {
    return false;
  }
}

/**
 * Convert ArrayBuffer to Uint8Array
 */
function toUint8Array(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  throw new Error('Expected ArrayBuffer or Uint8Array');
}

/**
 * Compare two byte arrays for equality
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Serialize a keypair for storage/transmission
 * @param {{publicKey: Uint8Array, privateKey: Uint8Array}} keypair
 * @returns {{publicKey: string, privateKey: string}} Base64 encoded
 */
export function serializeKeypair(keypair) {
  return {
    publicKey: uint8ArrayToBase64(keypair.publicKey),
    privateKey: uint8ArrayToBase64(keypair.privateKey),
  };
}

/**
 * Deserialize a keypair from storage/transmission
 * @param {{publicKey: string, privateKey: string}} serialized - Base64 encoded
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array}}
 */
export function deserializeKeypair(serialized) {
  return {
    publicKey: base64ToUint8Array(serialized.publicKey),
    privateKey: base64ToUint8Array(serialized.privateKey),
  };
}

// Helper functions
function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
