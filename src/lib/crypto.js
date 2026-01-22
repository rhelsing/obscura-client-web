// Signal Protocol key generation using @privacyresearch/libsignal-protocol-typescript
// Uses Curve25519 keys with XEdDSA signatures (Signal Protocol standard)

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { signalStore } from './signalStore.js';

// Helper to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Generate all keys needed for registration
// Returns data formatted for server registration AND stores keys locally
export async function generateRegistrationKeys() {
  // Ensure the store is open
  await signalStore.open();

  // Generate identity key pair (Curve25519)
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();

  // Generate registration ID (random value 1-16380)
  const registrationId = KeyHelper.generateRegistrationId();

  // Generate signed pre-key (key ID 1) - uses XEdDSA signature
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  // Generate one-time pre-keys (100 keys, IDs 1-100)
  const preKeys = [];
  for (let i = 1; i <= 100; i++) {
    const preKey = await KeyHelper.generatePreKey(i);
    preKeys.push(preKey);
  }

  // Store everything in IndexedDB via signalStore
  await signalStore.storeIdentityKeyPair(identityKeyPair);
  await signalStore.storeLocalRegistrationId(registrationId);
  await signalStore.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);

  for (const preKey of preKeys) {
    await signalStore.storePreKey(preKey.keyId, preKey.keyPair);
  }

  // Return data formatted for server registration (base64 encoded public keys)
  // Public keys are 33 bytes (with 0x05 Curve25519 type prefix)
  // Private keys are 32 bytes
  // Signatures are 64 bytes (XEdDSA)
  return {
    identityKey: arrayBufferToBase64(identityKeyPair.pubKey),
    registrationId,
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
      signature: arrayBufferToBase64(signedPreKey.signature),
    },
    oneTimePreKeys: preKeys.map(pk => ({
      keyId: pk.keyId,
      publicKey: arrayBufferToBase64(pk.keyPair.pubKey),
    })),
  };
}

// Store reference to keys in localStorage for backwards compat
// The actual keys are in IndexedDB, this just tracks that we have them
export function storeKeys(keys) {
  localStorage.setItem('obscura_keys', JSON.stringify({
    identityKey: keys.identityKey,
    registrationId: keys.registrationId,
    hasSignalKeys: true,
  }));
}

// Load keys info from localStorage
// Returns metadata only - actual keys are in IndexedDB
export function loadKeys() {
  const stored = localStorage.getItem('obscura_keys');
  return stored ? JSON.parse(stored) : null;
}

// Clear all keys (logout)
export async function clearKeys() {
  localStorage.removeItem('obscura_keys');
  await signalStore.clearAll();
}

// Check if we have Signal Protocol keys stored
export async function hasSignalKeys() {
  return signalStore.hasIdentity();
}

// Migration helper - check if user has old ECDSA keys
export function hasLegacyKeys() {
  const stored = localStorage.getItem('obscura_keys');
  if (!stored) return false;

  const keys = JSON.parse(stored);
  // Old keys have _private property with ECDSA keys
  // New keys have hasSignalKeys flag
  return keys._private !== undefined && !keys.hasSignalKeys;
}

// Clear legacy keys to force re-registration
export function clearLegacyKeys() {
  const stored = localStorage.getItem('obscura_keys');
  if (stored) {
    const keys = JSON.parse(stored);
    if (keys._private !== undefined) {
      localStorage.removeItem('obscura_keys');
      console.log('Legacy ECDSA keys cleared - re-registration required');
    }
  }
}

// === Pre-Key Replenishment ===

const PREKEY_THRESHOLD = 20;
const PREKEY_BATCH_SIZE = 50;

// Generate additional one-time prekeys starting from a given ID
export async function generateMorePreKeys(startId, count) {
  await signalStore.open();

  const preKeys = [];
  for (let i = 0; i < count; i++) {
    const keyId = startId + i;
    const preKey = await KeyHelper.generatePreKey(keyId);
    await signalStore.storePreKey(preKey.keyId, preKey.keyPair);
    preKeys.push({
      keyId: preKey.keyId,
      publicKey: arrayBufferToBase64(preKey.keyPair.pubKey),
    });
  }

  return preKeys;
}

// Generate a new signed prekey (required by API for uploads)
export async function generateNewSignedPreKey() {
  await signalStore.open();

  const identityKeyPair = await signalStore.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error('No identity key found');
  }

  const currentHighest = await signalStore.getHighestSignedPreKeyId();
  const newKeyId = currentHighest + 1;

  // Generate signed prekey with XEdDSA signature
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, newKeyId);
  await signalStore.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);

  return {
    keyId: signedPreKey.keyId,
    publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
    signature: arrayBufferToBase64(signedPreKey.signature),
  };
}

// Check prekey count and replenish if below threshold
export async function replenishPreKeys(client) {
  await signalStore.open();

  const count = await signalStore.getPreKeyCount();
  console.log(`[PreKey] Current count: ${count}, threshold: ${PREKEY_THRESHOLD}`);

  if (count >= PREKEY_THRESHOLD) {
    return { replenished: false, count, uploaded: 0 };
  }

  console.log(`[PreKey] Below threshold, generating ${PREKEY_BATCH_SIZE} new prekeys...`);

  const highestId = await signalStore.getHighestPreKeyId();
  const startId = highestId + 1;

  const newPreKeys = await generateMorePreKeys(startId, PREKEY_BATCH_SIZE);
  const signedPreKey = await generateNewSignedPreKey();

  await client.uploadKeys({
    signedPreKey,
    oneTimePreKeys: newPreKeys,
  });

  const newCount = await signalStore.getPreKeyCount();
  console.log(`[PreKey] Replenished. New count: ${newCount}`);

  return { replenished: true, count: newCount, uploaded: newPreKeys.length };
}

// Get current prekey status
export async function getPreKeyStatus() {
  await signalStore.open();
  const count = await signalStore.getPreKeyCount();
  const highestId = await signalStore.getHighestPreKeyId();
  return {
    count,
    highestId,
    threshold: PREKEY_THRESHOLD,
    needsReplenishment: count < PREKEY_THRESHOLD,
  };
}
