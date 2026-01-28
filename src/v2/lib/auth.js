/**
 * Unified Auth Module
 * Hides shell/device complexity - feels like one account
 */

import { generateFirstDeviceKeys, formatSignalKeysForServer } from '../auth/register.js';
import { LoginScenario, detectScenario } from '../auth/scenarios.js';
import { generateDeviceUUID, uuidPrefix } from '../crypto/uuid.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { createStore, InMemoryStore } from './store.js';
import { signLinkChallenge } from '../crypto/signatures.js';

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

  // Generate all keys
  const keys = await generateFirstDeviceKeys();
  const signalKeys = formatSignalKeysForServer(keys.signal);

  // Register shell account
  const shellRes = await fetch(`${apiUrl}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      ...signalKeys,
    }),
  });

  if (!shellRes.ok) {
    const text = await shellRes.text();
    if (shellRes.status === 409) {
      throw new Error(`Username "${username}" is already taken`);
    }
    throw new Error(`Registration failed: ${text}`);
  }

  const shellData = await shellRes.json();

  // Store Signal keys
  await store.storeIdentityKeyPair(keys.signal.identityKeyPair);
  await store.storeLocalRegistrationId(keys.signal.registrationId);
  await store.storeSignedPreKey(keys.signal.signedPreKey.keyId, keys.signal.signedPreKey.keyPair);
  for (const pk of keys.signal.preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity
  const deviceUsername = `${username}_${uuidPrefix(keys.deviceUUID)}`;
  await store.storeDeviceIdentity({
    deviceUsername,
    deviceUUID: keys.deviceUUID,
    coreUsername: username,
  });

  // Parse userId from token
  const userId = parseUserId(shellData.token);

  // Recovery phrase - one-time access
  let recoveryPhrase = keys.recoveryPhrase;

  return {
    store,
    token: shellData.token,
    refreshToken: shellData.refreshToken,
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
      signalIdentityKey: new Uint8Array(keys.signal.identityKeyPair.pubKey),
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
    // Existing device - we have local keys, use shell token
    // (In single-account mode, shell login IS the device login)
    const userId = parseUserId(shellToken);

    return {
      status: 'ok',
      client: {
        store,
        token: shellToken,
        refreshToken: null,
        userId,
        username,
        deviceUsername: storedIdentity.deviceUsername,
        deviceUUID: storedIdentity.deviceUUID,
      },
    };
  }

  // New device - generate keys and register device account
  const deviceUUID = generateDeviceUUID();
  const deviceUsername = `${username}_${uuidPrefix(deviceUUID)}`;

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

  // Store Signal keys
  await store.storeIdentityKeyPair(identityKeyPair);
  await store.storeLocalRegistrationId(registrationId);
  await store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  for (const pk of preKeys) {
    await store.storePreKey(pk.keyId, pk.keyPair);
  }

  // Store device identity
  await store.storeDeviceIdentity({
    deviceUsername,
    deviceUUID,
    coreUsername: username,
  });

  const userId = parseUserId(deviceData.token);

  // Generate link code for existing device to scan
  // Use userId (UUID) for server communication, deviceUsername for display
  // Sign the challenge with identity key for security
  const linkCode = await generateLinkCode(userId, deviceUsername, identityKeyPair);

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
async function generateLinkCode(userId, deviceUsername, identityKeyPair) {
  const challenge = crypto.getRandomValues(new Uint8Array(16));
  const signature = await signLinkChallenge(challenge, identityKeyPair.privKey);
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes from now

  const data = {
    i: userId,         // UUID for server API calls
    u: deviceUsername, // Username for display
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
