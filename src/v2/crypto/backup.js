/**
 * Backup Encryption Module
 * Uses ECDH + AES-256-GCM for asymmetric backup encryption
 *
 * Export flow (no phrase needed):
 *   1. Generate ephemeral Curve25519 keypair
 *   2. ECDH: ephemeralPrivate + recoveryPublicKey → sharedSecret
 *   3. Derive AES key from sharedSecret via HKDF
 *   4. Encrypt backup data with AES-256-GCM
 *   5. Package: { ephemeralPublicKey, iv, ciphertext }
 *
 * Import flow (phrase required):
 *   1. Derive recovery keypair from 12-word phrase
 *   2. ECDH: recoveryPrivate + ephemeralPublicKey → same sharedSecret
 *   3. Derive same AES key
 *   4. Decrypt backup data
 */

import { deriveRecoveryKeypair } from './signatures.js';

const BACKUP_VERSION = 1;
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12;

/**
 * Perform ECDH key agreement using Curve25519
 * @param {Uint8Array} privateKey - 32-byte private key
 * @param {Uint8Array} publicKey - 32 or 33-byte public key (0x05 prefix stripped if present)
 * @returns {Promise<Uint8Array>} 32-byte shared secret
 */
async function ecdh(privateKey, publicKey) {
  const curve25519 = await import('@privacyresearch/curve25519-typescript');
  const { AsyncCurve25519Wrapper } = curve25519.default || curve25519;
  const curve = new AsyncCurve25519Wrapper();

  // Strip 0x05 prefix if present
  const pubKeyBytes = publicKey.length === 33 && publicKey[0] === 0x05
    ? publicKey.slice(1)
    : publicKey;

  // sharedSecret returns ArrayBuffer
  const shared = await curve.sharedSecret(pubKeyBytes.buffer, privateKey.buffer);
  return new Uint8Array(shared);
}

/**
 * Generate ephemeral Curve25519 keypair
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
 */
async function generateEphemeralKeypair() {
  const curve25519 = await import('@privacyresearch/curve25519-typescript');
  const { AsyncCurve25519Wrapper } = curve25519.default || curve25519;
  const curve = new AsyncCurve25519Wrapper();

  // Generate random 32-byte seed
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keyPair = await curve.keyPair(seed.buffer);

  return {
    publicKey: new Uint8Array(keyPair.pubKey),
    privateKey: new Uint8Array(keyPair.privKey),
  };
}

/**
 * Derive AES key from shared secret using HKDF
 * @param {Uint8Array} sharedSecret - 32-byte shared secret from ECDH
 * @param {Uint8Array} salt - Random salt for HKDF
 * @returns {Promise<CryptoKey>} AES-GCM key
 */
async function deriveAESKey(sharedSecret, salt) {
  // Import shared secret as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveKey']
  );

  // Derive AES key using HKDF
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      salt,
      info: new TextEncoder().encode('obscura-backup-v1'),
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Serialize backup data for encryption
 * Handles ArrayBuffer/Uint8Array conversion
 */
function serializeBackupData(data) {
  return JSON.stringify(data, (key, value) => {
    if (value instanceof ArrayBuffer) {
      return { __type: 'ArrayBuffer', data: Array.from(new Uint8Array(value)) };
    }
    if (value instanceof Uint8Array) {
      return { __type: 'Uint8Array', data: Array.from(value) };
    }
    return value;
  });
}

/**
 * Deserialize backup data after decryption
 */
function deserializeBackupData(json) {
  return JSON.parse(json, (key, value) => {
    if (value && typeof value === 'object') {
      if (value.__type === 'ArrayBuffer') {
        return new Uint8Array(value.data).buffer;
      }
      if (value.__type === 'Uint8Array') {
        return new Uint8Array(value.data);
      }
    }
    return value;
  });
}

/**
 * Encrypt backup data using ECDH with recoveryPublicKey
 * No recovery phrase needed - uses stored public key
 *
 * @param {object} backupData - Data to backup (will be JSON serialized)
 * @param {Uint8Array} recoveryPublicKey - Recovery public key (33 bytes with 0x05 prefix)
 * @returns {Promise<Uint8Array>} Encrypted backup blob
 */
export async function encryptBackup(backupData, recoveryPublicKey) {
  // 1. Generate ephemeral keypair
  const ephemeral = await generateEphemeralKeypair();

  // 2. ECDH: ephemeral private + recovery public → shared secret
  const sharedSecret = await ecdh(ephemeral.privateKey, recoveryPublicKey);

  // 3. Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // 4. Derive AES key from shared secret
  const aesKey = await deriveAESKey(sharedSecret, salt);

  // 5. Serialize and encrypt data
  const plaintext = new TextEncoder().encode(serializeBackupData(backupData));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  );

  // 6. Package into backup blob
  // Format: version (1) + ephemeralPubKey (32) + salt (32) + iv (12) + ciphertext (variable)
  const header = new Uint8Array(1 + 32 + 32 + IV_LENGTH);
  header[0] = BACKUP_VERSION;
  header.set(ephemeral.publicKey, 1);
  header.set(salt, 1 + 32);
  header.set(iv, 1 + 32 + 32);

  // Combine header + ciphertext
  const blob = new Uint8Array(header.length + ciphertext.byteLength);
  blob.set(header);
  blob.set(new Uint8Array(ciphertext), header.length);

  // Zero out sensitive data
  ephemeral.privateKey.fill(0);
  sharedSecret.fill(0);

  return blob;
}

/**
 * Decrypt backup using recovery phrase
 *
 * @param {Uint8Array} encryptedBlob - Encrypted backup from encryptBackup()
 * @param {string} recoveryPhrase - 12-word BIP39 recovery phrase
 * @returns {Promise<object>} Decrypted backup data
 * @throws {Error} If phrase is invalid or decryption fails
 */
export async function decryptBackup(encryptedBlob, recoveryPhrase) {
  // 1. Derive recovery keypair from phrase
  const recoveryKeypair = await deriveRecoveryKeypair(recoveryPhrase);

  try {
    // 2. Parse backup blob
    const version = encryptedBlob[0];
    if (version !== BACKUP_VERSION) {
      throw new Error(`Unsupported backup version: ${version}`);
    }

    const ephemeralPublicKey = encryptedBlob.slice(1, 1 + 32);
    const salt = encryptedBlob.slice(1 + 32, 1 + 32 + 32);
    const iv = encryptedBlob.slice(1 + 32 + 32, 1 + 32 + 32 + IV_LENGTH);
    const ciphertext = encryptedBlob.slice(1 + 32 + 32 + IV_LENGTH);

    // 3. ECDH: recovery private + ephemeral public → shared secret
    const sharedSecret = await ecdh(recoveryKeypair.privateKey, ephemeralPublicKey);

    // 4. Derive AES key
    const aesKey = await deriveAESKey(sharedSecret, salt);

    // 5. Decrypt
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      ciphertext
    );

    // 6. Deserialize
    const json = new TextDecoder().decode(plaintext);
    const data = deserializeBackupData(json);

    // Zero out sensitive data
    sharedSecret.fill(0);

    return data;
  } finally {
    // Always zero out recovery private key
    recoveryKeypair.privateKey.fill(0);
  }
}

/**
 * Verify a recovery phrase matches a stored recovery public key
 * Used to validate phrase before attempting restore
 *
 * @param {string} phrase - 12-word recovery phrase
 * @param {Uint8Array} expectedPublicKey - Stored recovery public key
 * @returns {Promise<boolean>} True if phrase derives to matching public key
 */
export async function verifyRecoveryPhrase(phrase, expectedPublicKey) {
  try {
    const derived = await deriveRecoveryKeypair(phrase);

    // Compare public keys
    const derivedBytes = derived.publicKey;
    const expectedBytes = expectedPublicKey instanceof Uint8Array
      ? expectedPublicKey
      : new Uint8Array(expectedPublicKey);

    if (derivedBytes.length !== expectedBytes.length) return false;

    let match = true;
    for (let i = 0; i < derivedBytes.length; i++) {
      if (derivedBytes[i] !== expectedBytes[i]) match = false;
    }

    // Zero out private key
    derived.privateKey.fill(0);

    return match;
  } catch {
    return false;
  }
}
