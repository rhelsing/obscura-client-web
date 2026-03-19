/**
 * Unified Auth Module
 * Server-managed devices: one user account, devices as children
 */

import { generateFirstDeviceKeys, formatSignalKeysForServer } from '../auth/register.js';
import { generateDeviceUUID } from '../crypto/uuid.js';
// generateDeviceUsername removed — server assigns deviceId now
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { createStore, InMemoryStore } from './store.js';
import { createDeviceStore } from '../store/deviceStore.js';
import { signLinkChallenge } from '../crypto/signatures.js';
import { encryptKeys, decryptKeys, isEncryptedFormat, isUnencryptedFormat } from '../crypto/keyEncryption.js';
import { keyCache } from './keyCache.js';

/**
 * Register a new user account and provision first device
 * New API: POST /v1/users (no keys) → POST /v1/devices (with keys)
 *
 * @param {string} username - Display username
 * @param {string} password - Password
 * @param {object} opts - { apiUrl, store? }
 * @returns {Promise<object>} { client data, getRecoveryPhrase() }
 */
export async function register(username, password, opts = {}) {
  const { apiUrl } = opts;
  const store = opts.store || createStore(username);

  // Step 1: Register user account (no keys required)
  const userRes = await fetch(`${apiUrl}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!userRes.ok) {
    const text = await userRes.text();
    if (userRes.status === 409) {
      throw new Error(`Username "${username}" is already taken`);
    }
    throw new Error(`Registration failed: ${text}`);
  }

  const userData = await userRes.json();
  const userToken = userData.token; // User-scoped JWT (no deviceId)
  const userId = parseUserId(userToken);

  // Step 2: Generate keys for this device
  const keys = await generateFirstDeviceKeys();
  const signalKeys = formatSignalKeysForServer(keys.signal);

  // Step 3: Provision device with Signal keys
  const deviceRes = await fetch(`${apiUrl}/v1/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      name: detectDeviceName(),
      ...signalKeys,
    }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    throw new Error(`Device provisioning failed: ${text}`);
  }

  const deviceData = await deviceRes.json();
  const deviceToken = deviceData.token; // Device-scoped JWT (has device_id claim)
  const deviceId = parseDeviceId(deviceToken) || deviceData.deviceId;

  // Store identity keys encrypted with password
  const identityKeyPair = keys.signal.identityKeyPair;
  const registrationId = keys.signal.registrationId;

  const encrypted = await encryptKeys({ identityKeyPair }, password);
  encrypted.registrationId = registrationId;
  await store.storeEncryptedIdentity(encrypted);

  // Cache decrypted keys for this session
  keyCache.set({ identityKeyPair, registrationId });
  if (store.saveSessionKeys) await store.saveSessionKeys(identityKeyPair, registrationId);

  // Store prekeys
  await store.storeSignedPreKey(keys.signal.signedPreKey.keyId, keys.signal.signedPreKey.keyPair);
  for (const pk of keys.signal.preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity for re-login
  await store.storeDeviceIdentity({
    deviceId,
    deviceUUID: keys.deviceUUID,
    coreUsername: username,
    isFirstDevice: true,
    userId,
  });

  // Store full identity to deviceStore (includes recoveryPublicKey for backup)
  const deviceStore = createDeviceStore(username);
  await deviceStore.storeIdentity({
    coreUsername: username,
    deviceId,
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
    token: deviceToken,
    refreshToken: deviceData.refreshToken,
    userId,
    username,
    deviceId,
    deviceUUID: keys.deviceUUID,
    p2pIdentity: keys.p2pIdentity,
    recoveryPublicKey: keys.recoveryKeypair.publicKey,
    deviceInfo: {
      deviceId,
      deviceUUID: keys.deviceUUID,
      deviceName: detectDeviceName(),
      signalIdentityKey: new Uint8Array(identityKeyPair.pubKey),
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
 * Login to existing account
 * New API: Single POST /v1/sessions with optional deviceId
 *
 * @param {string} username - Display username
 * @param {string} password - Password
 * @param {object} opts - { apiUrl, store? }
 * @returns {Promise<object>} { status: 'ok'|'newDevice'|'error', client?, linkCode?, reason? }
 */
export async function login(username, password, opts = {}) {
  const { apiUrl } = opts;
  const store = opts.store || createStore(username);

  // Check for stored device identity (from previous session on this browser)
  const storedIdentity = await store.getDeviceIdentity();
  const storedDeviceId = storedIdentity?.deviceId;

  // Login — include deviceId if we have one for device-scoped token
  const loginBody = { username, password };
  if (storedDeviceId && storedIdentity?.coreUsername === username) {
    loginBody.deviceId = storedDeviceId;
  }

  let loginData;
  try {
    const res = await fetch(`${apiUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginBody),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { status: 'error', reason: 'Invalid credentials' };
      }
      return { status: 'error', reason: `Login failed: ${res.status}` };
    }
    loginData = await res.json();
  } catch (e) {
    return { status: 'error', reason: e.message };
  }

  const userId = parseUserId(loginData.token);
  const deviceId = parseDeviceId(loginData.token) || loginData.deviceId;

  // === Existing device (has stored identity AND got device-scoped token) ===
  if (storedIdentity && storedIdentity.coreUsername === username && deviceId) {
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
        token: loginData.token,
        refreshToken: loginData.refreshToken,
        userId,
        username,
        deviceId,
        deviceUUID: storedIdentity.deviceUUID,
        recoveryPublicKey: deviceIdentity?.recoveryPublicKey,
        p2pIdentity: deviceIdentity ? {
          publicKey: deviceIdentity.p2pPublicKey,
          privateKey: deviceIdentity.p2pPrivateKey,
        } : null,
        deviceInfo: {
          deviceId,
          deviceUUID: storedIdentity.deviceUUID,
          deviceName: detectDeviceName(),
          signalIdentityKey: identityKeyPair ? new Uint8Array(identityKeyPair.pubKey) : null,
        },
      },
    };
  }

  // === New device — need to provision via POST /v1/devices ===
  // Login gave us a user-scoped token (no deviceId). Provision a new device.
  const deviceUUID = generateDeviceUUID();

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

  // Provision device on server
  const deviceRes = await fetch(`${apiUrl}/v1/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${loginData.token}`,
    },
    body: JSON.stringify({
      name: detectDeviceName(),
      ...signalKeys,
    }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    return { status: 'error', reason: `Device provisioning failed: ${text}` };
  }

  const deviceData = await deviceRes.json();
  const newDeviceId = parseDeviceId(deviceData.token) || deviceData.deviceId;

  // Encrypt and store identity keys
  const encrypted = await encryptKeys({ identityKeyPair }, password);
  encrypted.registrationId = registrationId;
  await store.storeEncryptedIdentity(encrypted);

  // Cache decrypted keys for this session
  keyCache.set({ identityKeyPair, registrationId });
  if (store.saveSessionKeys) await store.saveSessionKeys(identityKeyPair, registrationId);

  // Store prekeys
  await store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  for (const pk of preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity for re-login
  await store.storeDeviceIdentity({
    deviceId: newDeviceId,
    deviceUUID,
    coreUsername: username,
    isFirstDevice: false,
    userId,
  });

  // Generate link code for existing device to scan
  const linkCode = await generateLinkCode(userId, newDeviceId, deviceUUID, identityKeyPair, username);

  return {
    status: 'newDevice',
    linkCode,
    client: {
      store,
      token: deviceData.token,
      refreshToken: deviceData.refreshToken,
      userId,
      username,
      deviceId: newDeviceId,
      deviceUUID,
      deviceInfo: {
        deviceId: newDeviceId,
        deviceUUID,
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
    if (store.saveSessionKeys) await store.saveSessionKeys(keyPair, registrationId);

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
      if (store.saveSessionKeys) await store.saveSessionKeys(decrypted.identityKeyPair, record.registrationId);

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

// Helper: parse deviceId from JWT (device-scoped tokens only)
function parseDeviceId(token) {
  const payload = token.split('.')[1];
  const decoded = JSON.parse(atob(payload));
  return decoded.device_id || decoded.deviceId || null;
}

// Helper: generate signed link code with expiry (base64 encoded)
async function generateLinkCode(userId, deviceId, deviceUUID, identityKeyPair, accountUsername) {
  const challenge = crypto.getRandomValues(new Uint8Array(16));
  const signature = await signLinkChallenge(challenge, identityKeyPair.privKey);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes from now

  const data = {
    i: userId,         // User UUID (for server API calls)
    u: deviceId,       // Device ID (server-assigned)
    d: deviceUUID,     // Client device UUID
    k: arrayBufferToBase64(identityKeyPair.pubKey),
    c: arrayBufferToBase64(challenge),
    s: arrayBufferToBase64(signature),  // Signature proves this device owns the key
    e: expiresAt,      // Expiry timestamp
    a: accountUsername, // Account username for ownership verification
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

  // Step 1: Login to get user-scoped token
  const loginRes = await fetch(`${apiUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`Recovery login failed: ${text}`);
  }

  const loginData = await loginRes.json();
  const userToken = loginData.token;
  const userId = parseUserId(userToken);

  // Step 2: Generate new device keys
  const deviceUUID = generateDeviceUUID();
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

  // Step 3: Provision recovery device
  const deviceRes = await fetch(`${apiUrl}/v1/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      name: `${detectDeviceName()} (Recovery)`,
      ...signalKeys,
    }),
  });

  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    throw new Error(`Failed to provision recovery device: ${text}`);
  }

  const deviceData = await deviceRes.json();
  const deviceId = parseDeviceId(deviceData.token) || deviceData.deviceId;

  // Store encrypted keys
  const encrypted = await encryptKeys({ identityKeyPair }, password);
  encrypted.registrationId = registrationId;
  await store.storeEncryptedIdentity(encrypted);

  // Cache keys for this session
  keyCache.set({ identityKeyPair, registrationId });
  if (store.saveSessionKeys) await store.saveSessionKeys(identityKeyPair, registrationId);

  // Store prekeys
  await store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  for (const pk of preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity
  await store.storeDeviceIdentity({
    deviceId,
    deviceUUID,
    coreUsername: username,
    isFirstDevice: false,
    isRecoveryDevice: true,
    userId,
  });

  // Store full identity to deviceStore
  const deviceStore = createDeviceStore(username);
  await deviceStore.storeIdentity({
    coreUsername: username,
    deviceId,
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
    deviceId,
    deviceUUID,
    p2pIdentity: {
      publicKey: backupData.deviceIdentity?.p2pPublicKey || recoveryKeypair.publicKey,
      privateKey: backupData.deviceIdentity?.p2pPrivateKey,
    },
    recoveryPublicKey: recoveryKeypair.publicKey,
    deviceInfo: {
      deviceId,
      deviceUUID,
      deviceName: detectDeviceName(),
      signalIdentityKey: new Uint8Array(identityKeyPair.pubKey),
    },
  });

  // Zero out recovery private key
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
        friend.userId || friend.devices?.[0]?.deviceId || friend.username,
        friend.username,
        friend.status || 'accepted',
        { devices: friend.devices, userAccountId: friend.userAccountId || friend.userId }
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
