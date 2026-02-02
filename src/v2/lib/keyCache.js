/**
 * Session cache for decrypted Signal keys
 * Uses sessionStorage to survive page refresh but clear on tab close
 * Cleared on JWT expiry or logout
 */

const STORAGE_KEY = 'obscura_key_cache';

/**
 * Serialize keys for sessionStorage (handles ArrayBuffer/Uint8Array)
 */
function serialize(keys) {
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
 * Deserialize keys from sessionStorage
 */
function deserialize(json) {
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
 * Load from sessionStorage
 */
function loadFromStorage() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return deserialize(stored);
  } catch (e) {
    console.warn('Failed to load key cache from sessionStorage:', e);
    return null;
  }
}

/**
 * Save to sessionStorage
 */
function saveToStorage(keys) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, serialize(keys));
  } catch (e) {
    console.warn('Failed to save key cache to sessionStorage:', e);
  }
}

/**
 * Clear from sessionStorage
 */
function clearStorage() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // Ignore
  }
}

// In-memory cache (primary) with sessionStorage backup
let cache = null;

export const keyCache = {
  /**
   * Store decrypted keys
   * @param {object} keys - { identityKeyPair, registrationId }
   */
  set(keys) {
    cache = {
      identityKeyPair: keys.identityKeyPair,
      registrationId: keys.registrationId,
    };
    saveToStorage(cache);
  },

  /**
   * Get all cached keys
   * @returns {object|null} { identityKeyPair, registrationId } or null
   */
  get() {
    if (!cache) {
      cache = loadFromStorage();
    }
    return cache;
  },

  /**
   * Get identity key pair from cache
   * @returns {object|null} { pubKey, privKey } or null
   */
  getIdentityKeyPair() {
    const c = this.get();
    return c?.identityKeyPair || null;
  },

  /**
   * Get registration ID from cache
   * @returns {number|null}
   */
  getRegistrationId() {
    const c = this.get();
    return c?.registrationId || null;
  },

  /**
   * Check if keys are loaded in cache
   * @returns {boolean}
   */
  isLoaded() {
    return this.get() !== null;
  },

  /**
   * Clear cache (on logout or JWT expiry)
   */
  clear() {
    cache = null;
    clearStorage();
  },
};
