// Signal Protocol key generation using @privacyresearch/libsignal-protocol-typescript
// Uses Curve25519 for proper Signal Protocol compatibility

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

  // Generate signed pre-key (key ID 1)
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
