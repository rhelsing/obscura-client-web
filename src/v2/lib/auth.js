/**
 * Unified Auth Module
 * Hides shell/device complexity - feels like one account
 */

import { generateFirstDeviceKeys, formatSignalKeysForServer } from '../auth/register.js';
import { LoginScenario, detectScenario } from '../auth/scenarios.js';
import { generateDeviceUUID, generateDeviceUsername } from '../crypto/uuid.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { createStore, InMemoryStore } from './store.js';
import { createDeviceStore } from '../store/deviceStore.js';
import { signLinkChallenge } from '../crypto/signatures.js';
import { encryptKeys, decryptKeys, isEncryptedFormat, isUnencryptedFormat } from '../crypto/keyEncryption.js';
import { keyCache } from './keyCache.js';

/**
 * Register a new user (creates shell + device accounts internally)
 * @param {string} username - Display username
 * @param {string} password - Password
 * @param {object} opts - { apiUrl, store? }
 * @returns {Promise<object>} { client data, getRecoveryPhrase() }
 */
export async function register(username, password, opts = {}) {
  const { apiUrl } = opts;
  const store = opts.store || createStore(username);

  // Generate keys for shell account (for findability)
  const keys = await generateFirstDeviceKeys();
  const shellSignalKeys = formatSignalKeysForServer(keys.signal);

  // Register shell account with Signal keys (for findability)
  const shellRes = await fetch(`${apiUrl}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      ...shellSignalKeys,
    }),
  });

  if (!shellRes.ok) {
    const text = await shellRes.text();
    if (shellRes.status === 409) {
      throw new Error(`Username "${username}" is already taken`);
    }
    throw new Error(`Registration failed: ${text}`);
  }

  // Generate SEPARATE keys for device account
  const deviceIdentityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const deviceRegistrationId = KeyHelper.generateRegistrationId();
  const deviceSignedPreKey = await KeyHelper.generateSignedPreKey(deviceIdentityKeyPair, 1);

  const devicePreKeys = [];
  for (let i = 1; i <= 100; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    devicePreKeys.push(preKey);
  }

  const deviceSignalKeys = formatSignalKeysForServer({
    identityKeyPair: deviceIdentityKeyPair,
    registrationId: deviceRegistrationId,
    signedPreKey: deviceSignedPreKey,
    preKeys: devicePreKeys,
  });

  // Register device account with its own Signal keys
  const deviceUsername = generateDeviceUsername();
  const deviceRes = await fetch(`${apiUrl}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: deviceUsername,
      password,
      ...deviceSignalKeys,
    }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    throw new Error(`Device registration failed: ${text}`);
  }

  const deviceData = await deviceRes.json();

  // Use DEVICE token's userId, not shell
  const userId = parseUserId(deviceData.token);

  // Encrypt and store DEVICE identity keys (not shell keys)
  const encrypted = await encryptKeys({
    identityKeyPair: deviceIdentityKeyPair,
  }, password);
  encrypted.registrationId = deviceRegistrationId;
  await store.storeEncryptedIdentity(encrypted);

  // Cache decrypted DEVICE keys for this session
  keyCache.set({
    identityKeyPair: deviceIdentityKeyPair,
    registrationId: deviceRegistrationId,
  });

  // Store DEVICE prekeys (not shell prekeys)
  await store.storeSignedPreKey(deviceSignedPreKey.keyId, deviceSignedPreKey.keyPair);
  for (const pk of devicePreKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity with userId for re-login
  await store.storeDeviceIdentity({
    deviceUsername,
    deviceUUID: keys.deviceUUID,
    coreUsername: username,
    isFirstDevice: true,
    userId,
  });

  // Store full identity to deviceStore (includes recoveryPublicKey for backup)
  const deviceStore = createDeviceStore(username);
  await deviceStore.storeIdentity({
    coreUsername: username,
    deviceUsername,
    deviceUUID: keys.deviceUUID,
    p2pPublicKey: keys.p2pIdentity.publicKey,
    p2pPrivateKey: keys.p2pIdentity.privateKey,
    recoveryPublicKey: keys.recoveryKeypair.publicKey,
  });
  deviceStore.close();

  // Recovery phrase - one-time access
  let recoveryPhrase = keys.recoveryPhrase;

  return {
    store,
    token: deviceData.token,  // Use device token!
    refreshToken: deviceData.refreshToken,
    userId,
    username,
    deviceUsername,
    deviceUUID: keys.deviceUUID,
    p2pIdentity: keys.p2pIdentity,
    // Only store PUBLIC key - private key is never stored, must re-derive from phrase
    recoveryPublicKey: keys.recoveryKeypair.publicKey,
    deviceInfo: {
      deviceUUID: keys.deviceUUID,
      serverUserId: userId,  // Use UUID, not deviceUsername!
      deviceName: detectDeviceName(),
      signalIdentityKey: new Uint8Array(deviceIdentityKeyPair.pubKey),  // Device's key, not shell's
    },

    // Explicit backup flow - clears after first read
    getRecoveryPhrase() {
      const phrase = recoveryPhrase;
      recoveryPhrase = null;
      return phrase;
    },
  };
}

/**
 * Login to existing account (handles all scenarios)
 * @param {string} username - Display username
 * @param {string} password - Password
 * @param {object} opts - { apiUrl, store? }
 * @returns {Promise<object>} { status: 'ok'|'newDevice'|'error', client?, linkCode?, reason? }
 */
export async function login(username, password, opts = {}) {
  const { apiUrl } = opts;
  const store = opts.store || createStore(username);

  // Try shell login
  let shellLoginSuccess = false;
  let shellToken = null;

  try {
    const res = await fetch(`${apiUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (res.ok) {
      const data = await res.json();
      shellLoginSuccess = true;
      shellToken = data.token;
    } else if (res.status === 401) {
      return { status: 'error', reason: 'Invalid credentials' };
    } else {
      return { status: 'error', reason: `Login failed: ${res.status}` };
    }
  } catch (e) {
    return { status: 'error', reason: e.message };
  }

  // Check for stored device identity
  const storedIdentity = await store.getDeviceIdentity();

  if (storedIdentity && storedIdentity.coreUsername === username) {
    // Existing device - shell login succeeded, now login to device account
    const deviceRes = await fetch(`${apiUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: storedIdentity.deviceUsername,
        password,
      }),
    });

    if (deviceRes.ok) {
      // Normal path - device account exists
      const deviceData = await deviceRes.json();
      const userId = parseUserId(deviceData.token);

      // Load and decrypt identity keys (with migration for old format)
      const identityKeyPair = await loadAndDecryptIdentity(store, password);

      if (!identityKeyPair) {
        return { status: 'error', reason: 'Could not decrypt local keys - try clearing data and re-linking' };
      }

      // Load recoveryPublicKey and p2pIdentity from device store
      const deviceStore = createDeviceStore(username);
      const deviceIdentity = await deviceStore.getIdentity();
      deviceStore.close();

      return {
        status: 'ok',
        client: {
          store,
          token: deviceData.token,  // Device token, not shell!
          refreshToken: deviceData.refreshToken,
          userId,
          username,
          deviceUsername: storedIdentity.deviceUsername,
          deviceUUID: storedIdentity.deviceUUID,
          recoveryPublicKey: deviceIdentity?.recoveryPublicKey,
          p2pIdentity: deviceIdentity ? {
            publicKey: deviceIdentity.p2pPublicKey,
            privateKey: deviceIdentity.p2pPrivateKey,
          } : null,
          deviceInfo: {
            deviceUUID: storedIdentity.deviceUUID,
            serverUserId: userId,
            deviceName: detectDeviceName(),
            signalIdentityKey: identityKeyPair ? new Uint8Array(identityKeyPair.pubKey) : null,
          },
        },
      };
    }

    // MIGRATION: Old user without device account (shell = device in old system)
    console.log('[Auth] Migrating old shell-only user to shell+device model...');
    const shellUserId = parseUserId(shellToken);

    // Load existing identity keys
    const existingIdentityKeyPair = await loadAndDecryptIdentity(store, password);
    if (!existingIdentityKeyPair) {
      return { status: 'error', reason: 'Could not decrypt local keys for migration' };
    }

    // Generate new device account with NEW keys (existing keys belong to shell)
    const deviceIdentityKeyPair = await KeyHelper.generateIdentityKeyPair();
    const deviceRegistrationId = KeyHelper.generateRegistrationId();
    const deviceSignedPreKey = await KeyHelper.generateSignedPreKey(deviceIdentityKeyPair, 1);

    const devicePreKeys = [];
    for (let i = 1; i <= 100; i++) {
      const preKey = await KeyHelper.generatePreKey(i);
      devicePreKeys.push(preKey);
    }

    const deviceSignalKeys = formatSignalKeysForServer({
      identityKeyPair: deviceIdentityKeyPair,
      registrationId: deviceRegistrationId,
      signedPreKey: deviceSignedPreKey,
      preKeys: devicePreKeys,
    });

    // Create new device account
    const newDeviceUsername = generateDeviceUsername();
    const newDeviceRes = await fetch(`${apiUrl}/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newDeviceUsername,
        password,
        ...deviceSignalKeys,
      }),
    });

    if (!newDeviceRes.ok) {
      const text = await newDeviceRes.text();
      return { status: 'error', reason: `Migration failed - could not create device account: ${text}` };
    }

    const newDeviceData = await newDeviceRes.json();
    const newDeviceUserId = parseUserId(newDeviceData.token);

    // Migrate local data from shell userId to new device userId
    await migrateUserData(shellUserId, newDeviceUserId);

    // Update stored identity with NEW device keys
    const encrypted = await encryptKeys({ identityKeyPair: deviceIdentityKeyPair }, password);
    encrypted.registrationId = deviceRegistrationId;
    await store.storeEncryptedIdentity(encrypted);

    // Cache new keys
    keyCache.set({ identityKeyPair: deviceIdentityKeyPair, registrationId: deviceRegistrationId });

    // Store new prekeys
    await store.storeSignedPreKey(deviceSignedPreKey.keyId, deviceSignedPreKey.keyPair);
    for (const pk of devicePreKeys) {
      await store.storePreKey(pk.keyId, pk.keyPair);
    }

    // Update device identity
    await store.storeDeviceIdentity({
      deviceUsername: newDeviceUsername,
      deviceUUID: storedIdentity.deviceUUID || generateDeviceUUID(),
      coreUsername: username,
      isFirstDevice: storedIdentity.isFirstDevice,
      userId: newDeviceUserId,
    });

    console.log('[Auth] Migration complete:', { shellUserId, newDeviceUserId });

    return {
      status: 'ok',
      client: {
        store,
        token: newDeviceData.token,
        refreshToken: newDeviceData.refreshToken,
        userId: newDeviceUserId,
        username,
        deviceUsername: newDeviceUsername,
        deviceUUID: storedIdentity.deviceUUID || generateDeviceUUID(),
        deviceInfo: {
          deviceUUID: storedIdentity.deviceUUID,
          serverUserId: newDeviceUserId,
          deviceName: detectDeviceName(),
          signalIdentityKey: new Uint8Array(deviceIdentityKeyPair.pubKey),
        },
      },
    };
  }

  // New device - generate keys and register device account
  const deviceUUID = generateDeviceUUID();
  const deviceUsername = generateDeviceUsername();

  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  const preKeys = [];
  for (let i = 1; i <= 100; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    preKeys.push(preKey);
  }

  const signalKeys = formatSignalKeysForServer({
    identityKeyPair,
    registrationId,
    signedPreKey,
    preKeys,
  });

  // Register new device account
  const deviceRes = await fetch(`${apiUrl}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: deviceUsername,
      password,
      ...signalKeys,
    }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    return { status: 'error', reason: `Device registration failed: ${text}` };
  }

  const deviceData = await deviceRes.json();

  // Encrypt and store identity keys
  const encrypted = await encryptKeys({ identityKeyPair }, password);
  encrypted.registrationId = registrationId;
  await store.storeEncryptedIdentity(encrypted);

  // Cache decrypted keys for this session
  keyCache.set({ identityKeyPair, registrationId });

  // Store prekeys (not encrypted)
  await store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  for (const pk of preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  const userId = parseUserId(deviceData.token);

  // Store device identity with userId for re-login
  await store.storeDeviceIdentity({
    deviceUsername,
    deviceUUID,
    coreUsername: username,
    isFirstDevice: false,
    userId,  // Store for re-login
  });

  // Generate link code for existing device to scan
  // Use userId (UUID) for server communication, deviceUsername for display
  // Include deviceUUID for complete device info on approving device
  // Sign the challenge with identity key for security
  const linkCode = await generateLinkCode(userId, deviceUsername, deviceUUID, identityKeyPair);

  return {
    status: 'newDevice',
    linkCode,
    client: {
      store,
      token: deviceData.token,
      refreshToken: deviceData.refreshToken,
      userId,
      username,
      deviceUsername,
      deviceUUID,
      deviceInfo: {
        deviceUUID,
        serverUserId: userId,  // Use UUID, not deviceUsername!
        deviceName: detectDeviceName(),
        signalIdentityKey: new Uint8Array(identityKeyPair.pubKey),
      },
    },
  };
}

/**
 * Load and decrypt identity keys, with migration for old unencrypted format
 * @param {object} store - IndexedDB store
 * @param {string} password - User's password
 * @returns {Promise<object|null>} Identity key pair or null if failed
 */
async function loadAndDecryptIdentity(store, password) {
  // Check if keys are already in cache
  if (keyCache.isLoaded()) {
    return keyCache.getIdentityKeyPair();
  }

  // Load identity record from IndexedDB
  const record = await store.loadIdentityRecord();
  if (!record) return null;

  // Case 1: Old unencrypted format - migrate to encrypted
  if (isUnencryptedFormat(record)) {
    console.log('Migrating keys to encrypted storage...');

    const { keyPair, registrationId } = record;

    // Encrypt with user's password
    const encrypted = await encryptKeys({ identityKeyPair: keyPair }, password);
    encrypted.registrationId = registrationId;

    // Store encrypted version
    await store.storeEncryptedIdentity(encrypted);

    // Cache for this session
    keyCache.set({ identityKeyPair: keyPair, registrationId });

    console.log('Migration complete');
    return keyPair;
  }

  // Case 2: New encrypted format - decrypt
  if (isEncryptedFormat(record)) {
    try {
      const decrypted = await decryptKeys({
        salt: new Uint8Array(record.salt),
        iv: new Uint8Array(record.iv),
        ciphertext: new Uint8Array(record.ciphertext),
      }, password);

      // Cache for this session
      keyCache.set({
        identityKeyPair: decrypted.identityKeyPair,
        registrationId: record.registrationId,
      });

      return decrypted.identityKeyPair;
    } catch (e) {
      console.error('Failed to decrypt identity keys:', e.message);
      return null;
    }
  }

  // No valid identity found
  return null;
}

// Helper: detect device name
function detectDeviceName() {
  if (typeof navigator === 'undefined') {
    return 'Node Device';
  }
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown Device';
}

// Helper: parse userId from JWT
function parseUserId(token) {
  const payload = token.split('.')[1];
  const decoded = JSON.parse(atob(payload));
  return decoded.sub || decoded.user_id || decoded.userId || decoded.id;
}

// Helper: generate signed link code with expiry (base64 encoded)
async function generateLinkCode(userId, deviceUsername, deviceUUID, identityKeyPair) {
  const challenge = crypto.getRandomValues(new Uint8Array(16));
  const signature = await signLinkChallenge(challenge, identityKeyPair.privKey);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes from now

  const data = {
    i: userId,         // UUID for server API calls
    u: deviceUsername, // Username for display
    d: deviceUUID,     // Full device UUID for complete device info
    k: arrayBufferToBase64(identityKeyPair.pubKey),
    c: arrayBufferToBase64(challenge),
    s: arrayBufferToBase64(signature),  // Signature proves this device owns the key
    e: expiresAt,      // Expiry timestamp
  };
  return btoa(JSON.stringify(data));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Migrate user data from old userId to new userId
 * Used when migrating from shell-only to shell+device model
 */
async function migrateUserData(oldUserId, newUserId) {
  if (typeof indexedDB === 'undefined') {
    console.warn('[Auth] IndexedDB not available, skipping data migration');
    return;
  }

  console.log('[Auth] Migrating data:', { from: oldUserId, to: newUserId });

  // Migrate friends database
  await migrateDatabase(`obscura_friends_v2_${oldUserId}`, `obscura_friends_v2_${newUserId}`);

  // Migrate messages database
  await migrateDatabase(`obscura_messages_v2_${oldUserId}`, `obscura_messages_v2_${newUserId}`);

  // Migrate attachments database
  await migrateDatabase(`obscura_attachments_${oldUserId}`, `obscura_attachments_${newUserId}`);

  // Migrate ORM models database (stories, pix, pixRegistry, comments, etc.)
  await migrateDatabase(`obscura_models_${oldUserId}`, `obscura_models_${newUserId}`);

  console.log('[Auth] Data migration complete');
}

/**
 * Copy all data from one IndexedDB database to another
 */
async function migrateDatabase(sourceDbName, targetDbName) {
  try {
    // Check if source exists by trying to open it
    const sourceDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(sourceDbName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    const storeNames = Array.from(sourceDb.objectStoreNames);
    if (storeNames.length === 0) {
      sourceDb.close();
      return;
    }

    // Get version to create target with same schema
    const version = sourceDb.version;

    // Create target database with same schema
    const targetDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(targetDbName, version);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // Copy store schemas from source
        for (const storeName of storeNames) {
          if (!db.objectStoreNames.contains(storeName)) {
            const sourceStore = sourceDb.transaction(storeName, 'readonly').objectStore(storeName);
            const keyPath = sourceStore.keyPath;
            if (keyPath) {
              db.createObjectStore(storeName, { keyPath });
            } else {
              db.createObjectStore(storeName);
            }
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
    });

    // Copy data from each store
    for (const storeName of storeNames) {
      const sourceTx = sourceDb.transaction(storeName, 'readonly');
      const sourceStore = sourceTx.objectStore(storeName);
      const allData = await new Promise((resolve, reject) => {
        const request = sourceStore.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      if (allData.length > 0) {
        const targetTx = targetDb.transaction(storeName, 'readwrite');
        const targetStore = targetTx.objectStore(storeName);
        for (const item of allData) {
          await new Promise((resolve, reject) => {
            const request = targetStore.put(item);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
          });
        }
      }
    }

    sourceDb.close();
    targetDb.close();

    console.log(`[Auth] Migrated ${sourceDbName} -> ${targetDbName}`);
  } catch (err) {
    // Source database might not exist, that's ok
    console.log(`[Auth] Could not migrate ${sourceDbName}: ${err.message}`);
  }
}

/**
 * Logout - clears in-memory keys but keeps encrypted data
 * User can log back in with password to decrypt keys again
 */
export function logout() {
  keyCache.clear();

  // Clear localStorage session
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('obscura_session');
  }
}

/**
 * Unlink this device - wipes all local data for the user
 * After this, logging in again will treat it as a fresh device needing link approval
 *
 * @param {string} username - Core username
 * @param {string} userId - User ID (for message/friend store namespacing)
 * @returns {Promise<void>}
 */
export async function unlinkDevice(username, userId) {
  // Clear in-memory keys first
  keyCache.clear();
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB not available');
  }

  // All database prefixes used by the app
  const databases = [
    `obscura_signal_v2_${username}`,
    `obscura_device_${username}`,
    `obscura_friends_v2_${userId}`,
    `obscura_messages_v2_${userId}`,
    `obscura_attachments_${userId}`,
    `obscura_models_${userId}`,
    `obscura_logs_${username}`,
  ];

  const errors = [];

  for (const dbName of databases) {
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          // Database is open elsewhere - still counts as pending delete
          console.warn(`Database ${dbName} deletion blocked - will complete when connections close`);
          resolve();
        };
      });
    } catch (err) {
      errors.push({ dbName, error: err.message });
    }
  }

  if (errors.length > 0) {
    console.warn('Some databases failed to delete:', errors);
  }

  // Also clear localStorage session and lastRead timestamps
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('obscura_session');

    // Clear lastRead timestamps for this user's conversations
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`lastRead_${username}_`)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  }
}

/**
 * Recover account from encrypted backup
 * Creates new device, restores data, prepares for recovery announcement
 *
 * @param {string} username - Username from backup
 * @param {string} password - Password for new device
 * @param {object} backupData - Decrypted backup data
 * @param {string} recoveryPhrase - 12-word recovery phrase
 * @param {object} opts - { apiUrl, revokeOthers }
 * @returns {Promise<{client: ObscuraClient}>} Client ready to use
 */
export async function recoverAccount(username, password, backupData, recoveryPhrase, opts = {}) {
  const { apiUrl, revokeOthers = false } = opts;
  const store = createStore(username);

  // Import recovery key derivation
  const { deriveRecoveryKeypair } = await import('../crypto/signatures.js');
  const recoveryKeypair = await deriveRecoveryKeypair(recoveryPhrase);

  // Generate new device keys
  const deviceUUID = generateDeviceUUID();
  const deviceUsername = generateDeviceUsername();
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  const preKeys = [];
  for (let i = 1; i <= 100; i++) {
    preKeys.push(await KeyHelper.generatePreKey(i));
  }

  const signalKeys = formatSignalKeysForServer({
    identityKeyPair,
    registrationId,
    signedPreKey,
    preKeys,
  });

  // Register new device account (shell account already exists)
  const deviceRes = await fetch(`${apiUrl}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: deviceUsername,
      password,
      ...signalKeys,
    }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    throw new Error(`Failed to register recovery device: ${text}`);
  }

  const deviceData = await deviceRes.json();
  const userId = parseUserId(deviceData.token);

  // Store encrypted keys
  const encrypted = await encryptKeys({ identityKeyPair }, password);
  encrypted.registrationId = registrationId;
  await store.storeEncryptedIdentity(encrypted);

  // Cache keys for this session
  keyCache.set({ identityKeyPair, registrationId });

  // Store prekeys
  await store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  for (const pk of preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity (Signal store)
  await store.storeDeviceIdentity({
    deviceUsername,
    deviceUUID,
    coreUsername: username,
    isFirstDevice: false,
    isRecoveryDevice: true,
    userId,
  });

  // Store full identity to deviceStore (includes recoveryPublicKey for future backups)
  const deviceStore = createDeviceStore(username);
  await deviceStore.storeIdentity({
    coreUsername: username,
    deviceUsername,
    deviceUUID,
    p2pPublicKey: backupData.deviceIdentity?.p2pPublicKey || recoveryKeypair.publicKey,
    p2pPrivateKey: backupData.deviceIdentity?.p2pPrivateKey,
    recoveryPublicKey: recoveryKeypair.publicKey,
  });
  deviceStore.close();

  // Import backup data (friends, messages, etc.)
  await restoreBackupData(username, userId, backupData, store);

  // Build client
  const { ObscuraClient } = await import('./ObscuraClient.js');
  const client = new ObscuraClient({
    apiUrl,
    store,
    token: deviceData.token,
    refreshToken: deviceData.refreshToken,
    userId,
    username,
    deviceUsername,
    deviceUUID,
    p2pIdentity: {
      publicKey: backupData.deviceIdentity?.p2pPublicKey || recoveryKeypair.publicKey,
      privateKey: backupData.deviceIdentity?.p2pPrivateKey,
    },
    recoveryPublicKey: recoveryKeypair.publicKey,
    deviceInfo: {
      deviceUUID,
      serverUserId: userId,
      deviceName: detectDeviceName(),
      signalIdentityKey: new Uint8Array(identityKeyPair.pubKey),
    },
  });

  // Zero out recovery private key (we only need it for signing recovery announcement)
  // The announceRecovery() method will re-derive it from the phrase
  recoveryKeypair.privateKey.fill(0);

  return { client, revokeOthers };
}

/**
 * Restore backup data to local stores
 * @private
 */
async function restoreBackupData(username, userId, backupData, signalStore) {
  // Import stores
  const { createFriendStore } = await import('../store/friendStore.js');
  const { createMessageStore } = await import('../store/messageStore.js');

  // Restore friends
  if (backupData.friends) {
    const friendStore = createFriendStore(userId);
    for (const friend of backupData.friends) {
      await friendStore.addFriend(
        friend.devices?.[0]?.serverUserId || friend.username,
        friend.username,
        friend.status || 'accepted',
        { devices: friend.devices }
      );
    }
    friendStore.close();
  }

  // Restore messages
  if (backupData.messages && typeof indexedDB !== 'undefined') {
    const messageStore = createMessageStore(username);
    await messageStore.importMessages(backupData.messages);
    messageStore.close();
  }

  // Restore Signal identity if available
  if (backupData.signalIdentity) {
    const signalId = backupData.signalIdentity;

    // If we have encrypted data, store it directly
    if (signalId.ciphertext && signalId.salt && signalId.iv) {
      await signalStore.storeEncryptedIdentity({
        salt: signalId.salt instanceof Uint8Array ? signalId.salt : new Uint8Array(Object.values(signalId.salt)),
        iv: signalId.iv instanceof Uint8Array ? signalId.iv : new Uint8Array(Object.values(signalId.iv)),
        ciphertext: signalId.ciphertext instanceof Uint8Array ? signalId.ciphertext : new Uint8Array(Object.values(signalId.ciphertext)),
        registrationId: signalId.registrationId,
      });
    }
  }

  // Note: We don't restore Signal sessions from backup because:
  // 1. Sessions are ephemeral and will be re-established via PreKey
  // 2. Restoring old sessions could cause message decryption failures
  // The recovery device will establish fresh sessions with all contacts
}
