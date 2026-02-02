/**
 * Password-based key encryption using PBKDF2 + AES-GCM
 * Encrypts Signal identity keys at rest in IndexedDB
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Derive AES-256 key from password using PBKDF2
 * @param {string} password - User's password
 * @param {Uint8Array} salt - Random salt
 * @returns {Promise<CryptoKey>} Derived AES key
 */
async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Serialize keys for encryption
 * Handles ArrayBuffer/Uint8Array conversion for JSON
 */
function serializeKeys(keys) {
  return JSON.stringify(keys, (key, value) => {
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
 * Deserialize keys after decryption
 * Restores ArrayBuffer/Uint8Array from JSON
 */
function deserializeKeys(json) {
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
 * Encrypt keys with password
 * @param {object} keys - The keys to encrypt (identityKeyPair, registrationId)
 * @param {string} password - User's password
 * @returns {Promise<object>} { salt, iv, ciphertext } - all as Uint8Array
 */
export async function encryptKeys(keys, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aesKey = await deriveKey(password, salt);

  const plaintext = new TextEncoder().encode(serializeKeys(keys));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  );

  return {
    salt,
    iv,
    ciphertext: new Uint8Array(ciphertext),
  };
}

/**
 * Decrypt keys with password
 * @param {object} encrypted - { salt, iv, ciphertext }
 * @param {string} password - User's password
 * @returns {Promise<object>} Decrypted keys
 * @throws {Error} If password is wrong (decryption fails)
 */
export async function decryptKeys(encrypted, password) {
  const aesKey = await deriveKey(password, encrypted.salt);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: encrypted.iv },
      aesKey,
      encrypted.ciphertext
    );

    return deserializeKeys(new TextDecoder().decode(plaintext));
  } catch (e) {
    throw new Error('Decryption failed - incorrect password or corrupted data');
  }
}

/**
 * Check if a stored record is in encrypted format
 * @param {object} record - Record from IndexedDB
 * @returns {boolean}
 */
export function isEncryptedFormat(record) {
  return record && record.ciphertext && record.salt && record.iv;
}

/**
 * Check if a stored record is in old unencrypted format
 * @param {object} record - Record from IndexedDB
 * @returns {boolean}
 */
export function isUnencryptedFormat(record) {
  return record && record.keyPair && !record.ciphertext;
}
