/**
 * BIP39 Mnemonic Generation and Derivation
 * Per identity.md spec: 128 bits entropy → 12 words
 *
 * Standard: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
 */

import { WORDLIST } from './bip39-wordlist.js';

/**
 * Generate a 12-word BIP39 mnemonic
 * 128 bits entropy + 4 bits checksum = 132 bits = 12 words × 11 bits
 *
 * @returns {Promise<string>} 12 space-separated words
 */
export async function generateMnemonic() {
  // Generate 128 bits (16 bytes) of entropy
  const entropy = new Uint8Array(16);
  crypto.getRandomValues(entropy);

  return entropyToMnemonic(entropy);
}

/**
 * Convert entropy bytes to mnemonic words
 * @param {Uint8Array} entropy - 16 bytes (128 bits) for 12 words
 * @returns {Promise<string>} Mnemonic phrase
 */
export async function entropyToMnemonic(entropy) {
  if (entropy.length !== 16) {
    throw new Error('Entropy must be 16 bytes (128 bits) for 12-word mnemonic');
  }

  // Calculate SHA-256 checksum
  const hash = await crypto.subtle.digest('SHA-256', entropy);
  const hashBytes = new Uint8Array(hash);

  // For 128 bits entropy, checksum is first 4 bits of hash
  const checksumBits = 4;

  // Combine entropy + checksum into bit string
  // 128 bits entropy + 4 bits checksum = 132 bits = 12 × 11 bits
  const bits = bytesToBits(entropy) + bytesToBits(hashBytes).slice(0, checksumBits);

  // Split into 11-bit chunks and map to words
  const words = [];
  for (let i = 0; i < 12; i++) {
    const chunk = bits.slice(i * 11, (i + 1) * 11);
    const index = parseInt(chunk, 2);
    words.push(WORDLIST[index]);
  }

  return words.join(' ');
}

/**
 * Validate a mnemonic phrase
 * @param {string} mnemonic - Space-separated words
 * @returns {Promise<boolean>} True if valid
 */
export async function validateMnemonic(mnemonic) {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);

  if (words.length !== 12) {
    return false;
  }

  // Check all words are in wordlist
  const indices = [];
  for (const word of words) {
    const index = WORDLIST.indexOf(word);
    if (index === -1) return false;
    indices.push(index);
  }

  // Convert word indices back to bits
  let bits = '';
  for (const index of indices) {
    bits += index.toString(2).padStart(11, '0');
  }

  // Split into entropy (128 bits) and checksum (4 bits)
  const entropyBits = bits.slice(0, 128);
  const checksumBits = bits.slice(128, 132);

  // Convert entropy bits back to bytes
  const entropy = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, (i + 1) * 8), 2);
  }

  // Calculate expected checksum
  const hash = await crypto.subtle.digest('SHA-256', entropy);
  const hashBytes = new Uint8Array(hash);
  const expectedChecksum = bytesToBits(hashBytes).slice(0, 4);

  return checksumBits === expectedChecksum;
}

/**
 * Derive a seed from mnemonic (BIP39 standard)
 * @param {string} mnemonic - 12-word phrase
 * @param {string} passphrase - Optional passphrase (default empty)
 * @returns {Promise<Uint8Array>} 64-byte seed
 */
export async function mnemonicToSeed(mnemonic, passphrase = '') {
  const encoder = new TextEncoder();
  const mnemonicBytes = encoder.encode(mnemonic.normalize('NFKD'));
  const salt = encoder.encode('mnemonic' + passphrase.normalize('NFKD'));

  // Import mnemonic as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    mnemonicBytes,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // PBKDF2-HMAC-SHA512, 2048 iterations, 512 bits output
  const seed = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 2048,
      hash: 'SHA-512',
    },
    keyMaterial,
    512
  );

  return new Uint8Array(seed);
}

/**
 * Derive a keypair from mnemonic
 * Uses first 32 bytes of seed as private key
 *
 * Note: For recovery phrase verification, we use SHA-256 hash of seed
 * as a deterministic "fingerprint" (public key). This is sufficient for
 * comparing whether two phrases derive the same identity.
 *
 * @param {string} mnemonic - 12-word phrase
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
 */
export async function deriveKeypair(mnemonic) {
  const seed = await mnemonicToSeed(mnemonic);

  // Use first 32 bytes as private key seed
  const privateKey = seed.slice(0, 32);

  // Use SHA-256 hash of entire seed as deterministic "public key" fingerprint
  // This is sufficient for recovery phrase verification (comparing two phrases)
  // The actual Ed25519/Curve25519 public key would require the curve library
  const fingerprintHash = await crypto.subtle.digest('SHA-256', seed);
  const publicKey = new Uint8Array(fingerprintHash);

  return {
    publicKey: publicKey,
    privateKey: privateKey,
  };
}

/**
 * Convert bytes to binary string
 * @param {Uint8Array} bytes
 * @returns {string} Binary string (e.g., "10110101...")
 */
function bytesToBits(bytes) {
  let bits = '';
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }
  return bits;
}

/**
 * Get the wordlist (for display/validation)
 * @returns {string[]} 2048 BIP39 words
 */
export function getWordlist() {
  return [...WORDLIST];
}

/**
 * Check if a word is in the BIP39 wordlist
 * @param {string} word
 * @returns {boolean}
 */
export function isValidWord(word) {
  return WORDLIST.includes(word.toLowerCase());
}
