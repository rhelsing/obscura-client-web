/**
 * Signature Helpers
 * Sign/verify for recovery key revocations and link code challenges
 */

import { mnemonicToSeed, validateMnemonic } from './bip39.js';
import { sign, verify, generateP2PIdentity } from './ed25519.js';

/**
 * Derive an Ed25519 keypair from a BIP39 recovery phrase
 * Uses the BIP39 seed to deterministically generate a Curve25519 keypair
 *
 * @param {string} phrase - 12-word BIP39 mnemonic
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
 */
export async function deriveRecoveryKeypair(phrase) {
  // Validate phrase first
  const valid = await validateMnemonic(phrase);
  if (!valid) {
    throw new Error('Invalid recovery phrase');
  }

  // Get 64-byte seed from phrase
  const seed = await mnemonicToSeed(phrase);

  // Use first 32 bytes as private key seed
  const privateKeySeed = seed.slice(0, 32);

  // Derive public key from private key using curve25519
  const curve25519 = await import('@privacyresearch/curve25519-typescript');
  const { AsyncCurve25519Wrapper } = curve25519.default || curve25519;
  const curve = new AsyncCurve25519Wrapper();

  // keyPair takes a 32-byte seed and returns { pubKey, privKey }
  const keyPair = await curve.keyPair(privateKeySeed.buffer);

  const publicKey = new Uint8Array(keyPair.pubKey);
  const privateKey = new Uint8Array(keyPair.privKey);

  return {
    // Public key with 0x05 prefix (33 bytes) for compatibility with Signal
    publicKey,
    // Private key is 32 bytes
    privateKey,
  };
}

/**
 * Sign data with recovery phrase (derives key, signs, discards private key)
 *
 * @param {string} phrase - 12-word BIP39 mnemonic
 * @param {Uint8Array} data - Data to sign
 * @returns {Promise<Uint8Array>} 64-byte signature
 */
export async function signWithRecoveryPhrase(phrase, data) {
  const keypair = await deriveRecoveryKeypair(phrase);
  const signature = await sign(data, keypair.privateKey);
  // Private key is discarded when function returns (not stored)
  return signature;
}

/**
 * Verify a signature against a recovery public key
 *
 * @param {Uint8Array} publicKey - Recovery public key (33 bytes with 0x05 prefix)
 * @param {Uint8Array} data - Original data
 * @param {Uint8Array} signature - 64-byte signature
 * @returns {Promise<boolean>}
 */
export async function verifyRecoverySignature(publicKey, data, signature) {
  return verify(data, signature, publicKey);
}

/**
 * Sign a link code challenge with Signal identity key
 *
 * @param {Uint8Array} challenge - Random challenge bytes
 * @param {ArrayBuffer|Uint8Array} identityPrivateKey - Signal identity private key
 * @returns {Promise<Uint8Array>} 64-byte signature
 */
export async function signLinkChallenge(challenge, identityPrivateKey) {
  const privKey = identityPrivateKey instanceof ArrayBuffer
    ? new Uint8Array(identityPrivateKey)
    : identityPrivateKey;
  return sign(challenge, privKey);
}

/**
 * Verify a link code challenge signature
 *
 * @param {Uint8Array} challenge - Original challenge
 * @param {Uint8Array} signature - 64-byte signature
 * @param {Uint8Array} identityPublicKey - Signal identity public key (33 bytes)
 * @returns {Promise<boolean>}
 */
export async function verifyLinkChallenge(challenge, signature, identityPublicKey) {
  return verify(challenge, signature, identityPublicKey);
}

/**
 * Serialize DeviceAnnounce data for signing
 * Creates a deterministic byte representation of the announcement
 *
 * @param {object} announce - { devices, timestamp, isRevocation }
 * @returns {Uint8Array}
 */
export function serializeAnnounceForSigning(announce) {
  // Create deterministic JSON representation
  const data = {
    devices: announce.devices.map(d => ({
      deviceUUID: d.deviceUUID,
      serverUserId: d.serverUserId,
    })).sort((a, b) => a.deviceUUID.localeCompare(b.deviceUUID)),
    timestamp: announce.timestamp,
    isRevocation: announce.isRevocation,
  };
  const json = JSON.stringify(data);
  return new TextEncoder().encode(json);
}

/**
 * Normalize various key formats to Uint8Array
 * Handles: Uint8Array, ArrayBuffer, Array, plain object (from JSON), base64 string
 * @param {*} key - Key in various formats
 * @returns {Uint8Array|null} Normalized key or null if invalid
 */
function normalizeKeyToUint8Array(key) {
  if (!key) return null;

  // Already Uint8Array
  if (key instanceof Uint8Array) return key;

  // ArrayBuffer
  if (key instanceof ArrayBuffer) return new Uint8Array(key);

  // Array of numbers
  if (Array.isArray(key)) return new Uint8Array(key);

  // Plain object from JSON.stringify(Uint8Array) -> {"0":5,"1":123,...}
  if (typeof key === 'object' && key !== null) {
    const keys = Object.keys(key);
    // Check if keys are numeric indices
    if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
      const maxIndex = Math.max(...keys.map(Number));
      const arr = new Uint8Array(maxIndex + 1);
      for (const k of keys) {
        arr[Number(k)] = key[k];
      }
      return arr;
    }
  }

  // Base64 string
  if (typeof key === 'string') {
    try {
      const binary = atob(key);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Generate a 4-digit verification code from a Signal identity key
 * Used for out-of-band verification during friend requests
 *
 * @param {Uint8Array|ArrayBuffer|Array|object|string} signalIdentityKey - Signal identity public key (33 bytes)
 *        Accepts various formats: Uint8Array, ArrayBuffer, Array, JSON-serialized object, base64 string
 * @returns {Promise<string>} 4-digit code ("0000" - "9999")
 */
export async function generateVerifyCode(signalIdentityKey) {
  const keyBytes = normalizeKeyToUint8Array(signalIdentityKey);

  if (!keyBytes || keyBytes.length === 0) {
    throw new Error('Invalid signalIdentityKey format');
  }

  // SHA-256 hash of the key
  const hash = await crypto.subtle.digest('SHA-256', keyBytes);
  const bytes = new Uint8Array(hash);

  // Take first 2 bytes as uint16, mod 10000 for 4-digit code
  const code = ((bytes[0] << 8) | bytes[1]) % 10000;
  return code.toString().padStart(4, '0');
}
