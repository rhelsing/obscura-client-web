/**
 * First Device Registration
 * Per identity.md spec: Create shell account + device account
 */

import { generateDeviceUUID, generateDeviceUsername } from '../crypto/uuid.js';
import { generateP2PIdentity } from '../crypto/ed25519.js';
import { generateMnemonic } from '../crypto/bip39.js';
import { deriveRecoveryKeypair } from '../crypto/signatures.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

/**
 * Generate all keys needed for first device registration
 * @returns {Promise<object>} Registration data
 */
export async function generateFirstDeviceKeys() {
  // Generate device UUID
  const deviceUUID = generateDeviceUUID();

  // Generate P2P identity (shared across devices)
  const p2pIdentity = await generateP2PIdentity();

  // Generate 12-word recovery phrase (BIP39)
  const recoveryPhrase = await generateMnemonic();

  // Derive recovery keypair from phrase (Ed25519 for signing)
  const recoveryKeypair = await deriveRecoveryKeypair(recoveryPhrase);

  // Generate Signal Protocol keys
  const signalIdentityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(signalIdentityKeyPair, 1);

  // Generate 100 one-time prekeys
  const preKeys = [];
  for (let i = 1; i <= 100; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    preKeys.push(preKey);
  }

  return {
    deviceUUID,
    p2pIdentity,
    recoveryPhrase, // Only returned here - never stored!
    recoveryKeypair,
    signal: {
      identityKeyPair: signalIdentityKeyPair,
      registrationId,
      signedPreKey,
      preKeys,
    },
  };
}

/**
 * Format Signal keys for server registration
 * @param {object} signal - Signal keys from generateFirstDeviceKeys
 * @returns {object} Server-ready format (base64 encoded)
 */
export function formatSignalKeysForServer(signal) {
  return {
    identityKey: arrayBufferToBase64(signal.identityKeyPair.pubKey),
    registrationId: signal.registrationId,
    signedPreKey: {
      keyId: signal.signedPreKey.keyId,
      publicKey: arrayBufferToBase64(signal.signedPreKey.keyPair.pubKey),
      signature: arrayBufferToBase64(signal.signedPreKey.signature),
    },
    oneTimePreKeys: signal.preKeys.map(pk => ({
      keyId: pk.keyId,
      publicKey: arrayBufferToBase64(pk.keyPair.pubKey),
    })),
  };
}

/**
 * Register first device (shell + device accounts)
 * Per identity.md: Creates TWO accounts on server
 *
 * @param {object} client - API client instance
 * @param {string} username - Display username (shell account name)
 * @param {string} password - Password for both accounts
 * @param {object} keys - Keys from generateFirstDeviceKeys()
 * @returns {Promise<object>} Registration result
 */
export async function registerFirstDevice(client, username, password, keys) {
  const { deviceUUID, signal } = keys;

  // Step 1: Register shell account (reserves namespace)
  // Shell account has NO keys - just username/password
  let shellResult;
  try {
    shellResult = await client.registerShell(username, password);
  } catch (err) {
    if (err.status === 409) {
      throw new Error(`Username "${username}" is already taken`);
    }
    throw err;
  }

  // Step 2: Register device account (with Signal keys)
  // Use unlinkable device username - server cannot correlate with shell account
  const deviceUsername = generateDeviceUsername();
  const signalKeys = formatSignalKeysForServer(signal);

  let deviceResult;
  try {
    deviceResult = await client.registerDevice({
      username: deviceUsername,
      password,
      ...signalKeys,
    });
  } catch (err) {
    // Note: Shell account was created but device failed
    // This is a partial failure state - user may need to retry device registration
    console.error('Device registration failed after shell success:', err);
    throw new Error('Device registration failed. Please try again.');
  }

  // Set the device token (this is what we use for API calls)
  client.setToken(deviceResult.token);

  return {
    success: true,
    coreUsername: username,
    deviceUsername,
    deviceUUID,
    shellToken: shellResult.token,
    deviceToken: deviceResult.token,
    refreshToken: deviceResult.refreshToken,
    expiresAt: deviceResult.expiresAt,
  };
}

/**
 * Build initial device info for storage
 * @param {string} deviceUUID
 * @param {string} deviceUsername - Server username (e.g., "alice_abc123")
 * @param {Uint8Array} signalIdentityKey - Signal identity public key
 * @returns {object} DeviceInfo structure per identity.md
 */
export function buildDeviceInfo(deviceUUID, deviceUsername, signalIdentityKey) {
  return {
    deviceUUID,
    serverUserId: deviceUsername,
    deviceName: detectDeviceName(),
    signalIdentityKey: signalIdentityKey,
  };
}

/**
 * Auto-detect device name from user agent
 * Per identity.md: Auto-detect but allow rename
 */
export function detectDeviceName() {
  if (typeof navigator === 'undefined') {
    return 'Unknown Device';
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

// Helper function
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
