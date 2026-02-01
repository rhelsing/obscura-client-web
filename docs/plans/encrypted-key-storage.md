# Encrypted Key Storage Implementation

## Overview

Encrypt Signal keys at rest in IndexedDB using the user's password. Keys only exist decrypted in memory while JWT is valid.

---

## New File: `src/v2/crypto/keyEncryption.js`

```javascript
/**
 * Password-based key encryption using PBKDF2 + AES-GCM
 */

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Derive AES key from password
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
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt keys with password
 * @param {object} keys - The keys to encrypt (identityKeyPair, etc.)
 * @param {string} password - User's password
 * @returns {object} { salt, iv, ciphertext } - all as Uint8Array
 */
export async function encryptKeys(keys, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aesKey = await deriveKey(password, salt);

  const plaintext = new TextEncoder().encode(JSON.stringify(keys));
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
 * @returns {object} Decrypted keys
 * @throws {Error} If password is wrong (decryption fails)
 */
export async function decryptKeys(encrypted, password) {
  const aesKey = await deriveKey(password, encrypted.salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: encrypted.iv },
    aesKey,
    encrypted.ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}
```

---

## New File: `src/v2/lib/keyCache.js`

```javascript
/**
 * In-memory cache for decrypted keys
 * Cleared on JWT expiry or logout
 */

let cache = null;

export const keyCache = {
  /**
   * Store decrypted keys in memory
   */
  set(keys) {
    cache = {
      identityKeyPair: keys.identityKeyPair,
      registrationId: keys.registrationId,
      // Prekeys and sessions stay in IndexedDB (not sensitive identity)
    };
  },

  /**
   * Get cached keys
   */
  get() {
    return cache;
  },

  /**
   * Get identity key pair from cache
   */
  getIdentityKeyPair() {
    return cache?.identityKeyPair || null;
  },

  /**
   * Get registration ID from cache
   */
  getRegistrationId() {
    return cache?.registrationId || null;
  },

  /**
   * Check if keys are loaded
   */
  isLoaded() {
    return cache !== null;
  },

  /**
   * Clear cache (on logout or JWT expiry)
   */
  clear() {
    cache = null;
  },
};
```

---

## Modified: `src/v2/lib/IndexedDBStore.js`

```javascript
// Change identity storage to encrypted format

const STORES = {
  IDENTITY: 'identity',           // Now stores { salt, iv, ciphertext }
  PRE_KEYS: 'preKeys',            // Unchanged (not identity-critical)
  SIGNED_PRE_KEYS: 'signedPreKeys', // Unchanged
  SESSIONS: 'sessions',           // Unchanged
  TRUSTED_IDENTITIES: 'trustedIdentities', // Unchanged
  DEVICE_IDENTITY: 'deviceIdentity', // Unchanged
};

// NEW: Store encrypted identity
async storeEncryptedIdentity(encrypted) {
  const store = await this._getStore(STORES.IDENTITY, 'readwrite');
  await this._promisify(store.put({
    id: 'identity',
    salt: encrypted.salt,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
  }));
}

// NEW: Load encrypted identity (for decryption at login)
async loadEncryptedIdentity() {
  const store = await this._getStore(STORES.IDENTITY);
  const record = await this._promisify(store.get('identity'));
  if (!record || !record.ciphertext) return null;
  return {
    salt: new Uint8Array(record.salt),
    iv: new Uint8Array(record.iv),
    ciphertext: new Uint8Array(record.ciphertext),
  };
}

// MODIFIED: getIdentityKeyPair reads from cache, not IndexedDB
async getIdentityKeyPair() {
  // Keys now live in memory cache, not IndexedDB
  return keyCache.getIdentityKeyPair();
}

// MODIFIED: storeIdentityKeyPair encrypts before storing
async storeIdentityKeyPair(keyPair, password) {
  const encrypted = await encryptKeys({ identityKeyPair: keyPair }, password);
  await this.storeEncryptedIdentity(encrypted);
  // Also cache in memory for immediate use
  keyCache.set({ identityKeyPair: keyPair });
}
```

---

## Modified: `src/v2/lib/auth.js`

```javascript
import { encryptKeys, decryptKeys } from '../crypto/keyEncryption.js';
import { keyCache } from './keyCache.js';

// REGISTRATION - encrypt keys before storing
export async function register(username, password, opts = {}) {
  // ... generate keys ...

  // Encrypt and store identity keys
  const encrypted = await encryptKeys({
    identityKeyPair: keys.signal.identityKeyPair,
    registrationId: keys.signal.registrationId,
  }, password);
  await store.storeEncryptedIdentity(encrypted);

  // Cache decrypted keys for this session
  keyCache.set({
    identityKeyPair: keys.signal.identityKeyPair,
    registrationId: keys.signal.registrationId,
  });

  // ... rest of registration ...
}

// LOGIN - decrypt keys into cache
export async function login(username, password, opts = {}) {
  // ... validate credentials with server ...

  // Load and decrypt stored keys
  const encrypted = await store.loadEncryptedIdentity();
  if (encrypted) {
    try {
      const keys = await decryptKeys(encrypted, password);
      keyCache.set(keys);
    } catch (e) {
      // Decryption failed - password changed or corruption
      return { status: 'error', reason: 'Could not decrypt local keys' };
    }
  }

  // ... rest of login ...
}

// LOGOUT - clear cache
export async function logout() {
  keyCache.clear();
  // ... rest of logout ...
}
```

---

## Modified: Token refresh handling

```javascript
// In your token refresh logic (wherever it lives)

async function onTokenExpired() {
  // Clear decrypted keys - user must re-login
  keyCache.clear();

  // Redirect to login
  router.navigate('/login');
}

async function refreshToken() {
  const res = await fetch(`${apiUrl}/v1/sessions/refresh`, { ... });

  if (res.status === 401) {
    // Refresh failed - session over
    onTokenExpired();
    return null;
  }

  // ... handle successful refresh ...
}
```

---

## What Stays Unencrypted

| Data | Encrypted? | Reason |
|------|------------|--------|
| Identity key pair | Yes | Core identity - extraction = impersonation |
| Registration ID | Yes | Part of identity |
| Prekeys | No | Ephemeral, rotated frequently |
| Signed prekeys | No | Rotated, less sensitive |
| Sessions | No | Stateful, device-bound, useless without identity |
| Trusted identities | No | Public keys only |

Prekeys and sessions without the identity key are useless. An attacker would need both.

---

## Migration (Critical for Existing Users)

**Problem:** Existing users have unencrypted keys in IndexedDB. We can't just start requiring encryption — they'd be locked out.

**Solution:** Detect and migrate on login.

```javascript
// In login flow, BEFORE normal auth:

async function handleLogin(username, password, store) {
  // Check storage format
  const record = await store.loadRawIdentityRecord();

  if (record?.keyPair && !record?.ciphertext) {
    // OLD FORMAT: unencrypted keys present
    // Migrate to encrypted format using the password they just entered

    const encrypted = await encryptKeys({
      identityKeyPair: record.keyPair,
      registrationId: record.registrationId,
    }, password);

    // Store new encrypted format
    await store.storeEncryptedIdentity(encrypted);

    // Delete old unencrypted record
    await store.deleteRawIdentity();

    // Cache for session
    keyCache.set({
      identityKeyPair: record.keyPair,
      registrationId: record.registrationId,
    });

    console.log('Migrated keys to encrypted storage');
    return; // Continue with login
  }

  if (record?.ciphertext) {
    // NEW FORMAT: already encrypted, decrypt normally
    const keys = await decryptKeys(record, password);
    keyCache.set(keys);
    return;
  }

  // No keys at all - new device flow
}
```

**Migration flow:**

```
User logs in
     │
     ▼
┌─────────────────────────────┐
│ Check IndexedDB format      │
└─────────────────────────────┘
     │
     ├── Has `keyPair` (old) ──────► Encrypt with password, delete old, continue
     │
     ├── Has `ciphertext` (new) ───► Decrypt with password, continue
     │
     └── Empty ────────────────────► New device flow
```

**Key points:**
- Migration happens transparently on first login after upgrade
- User's password is available at login time, so we can encrypt
- Old unencrypted data is deleted after successful migration
- No user action required
- Backwards compatible: old clients can't read new format (but they'd need to upgrade anyway)

---

## Security Properties

1. **At rest:** Identity keys encrypted with AES-256-GCM, key derived via PBKDF2 (100k iterations)
2. **In memory:** Decrypted only while JWT valid
3. **Tab close:** Memory cleared (sessionStorage alternative for tab persistence)
4. **JWT expiry:** Cache explicitly cleared, forces re-login
5. **Password change:** Re-encrypt keys with new password

---

## Files to Change

1. **New:** `src/v2/crypto/keyEncryption.js` - PBKDF2 + AES-GCM helpers
2. **New:** `src/v2/lib/keyCache.js` - In-memory key cache
3. **Modify:** `src/v2/lib/IndexedDBStore.js` - Encrypted storage methods
4. **Modify:** `src/v2/lib/auth.js` - Encrypt on register, decrypt on login
5. **Modify:** Token refresh logic - Clear cache on expiry
6. **New:** Migration script for existing users
