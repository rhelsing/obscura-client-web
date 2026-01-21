// Signal Protocol key generation using @privacyresearch/libsignal-protocol-typescript
// Uses Curve25519 for proper Signal Protocol compatibility
// With USE_ED_SIGNING flag, uses pure Ed25519 for server compatibility

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { signalStore } from './signalStore.js';
import { FEATURES } from './config.js';

// Helper to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// === Ed25519 Key Generation (Web Crypto API) ===
// Used when FEATURES.USE_ED_SIGNING is true for server compatibility

async function generateEd25519KeyPair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  return keyPair;
}

async function exportEd25519PublicKey(publicKey) {
  // Export as SPKI format, then extract the raw 32-byte key
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  const spkiArray = new Uint8Array(spki);
  // SPKI has a header, the raw key is the last 32 bytes
  return spkiArray.slice(-32);
}

async function exportEd25519PrivateKey(privateKey) {
  // Export as PKCS8 format for storage
  return await crypto.subtle.exportKey('pkcs8', privateKey);
}

async function signWithEd25519(privateKey, data) {
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return new Uint8Array(signature);
}

async function importEd25519PrivateKey(pkcs8Buffer) {
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Buffer,
    'Ed25519',
    true,
    ['sign']
  );
}

// Generate all keys needed for registration
// Returns data formatted for server registration AND stores keys locally
export async function generateRegistrationKeys() {
  // Ensure the store is open
  await signalStore.open();

  if (FEATURES.USE_ED_SIGNING) {
    return generateRegistrationKeysEd25519();
  } else {
    return generateRegistrationKeysLibsignal();
  }
}

// Ed25519 key generation (server compatible - pure Ed25519 signatures)
async function generateRegistrationKeysEd25519() {
  // Generate identity key pair (Ed25519)
  const identityKeyPair = await generateEd25519KeyPair();
  const identityPubKey = await exportEd25519PublicKey(identityKeyPair.publicKey);
  const identityPrivKey = await exportEd25519PrivateKey(identityKeyPair.privateKey);

  // Generate registration ID (random value 1-16380)
  const registrationId = Math.floor(Math.random() * 16380) + 1;

  // Generate signed pre-key (Ed25519)
  const spkKeyPair = await generateEd25519KeyPair();
  const spkPubKey = await exportEd25519PublicKey(spkKeyPair.publicKey);
  const spkPrivKey = await exportEd25519PrivateKey(spkKeyPair.privateKey);

  // Sign the signed pre-key public key with identity private key
  const signature = await signWithEd25519(identityKeyPair.privateKey, spkPubKey);

  // Generate one-time pre-keys (100 keys, IDs 1-100)
  const preKeys = [];
  for (let i = 1; i <= 100; i++) {
    const preKeyPair = await generateEd25519KeyPair();
    const preKeyPubKey = await exportEd25519PublicKey(preKeyPair.publicKey);
    const preKeyPrivKey = await exportEd25519PrivateKey(preKeyPair.privateKey);
    preKeys.push({
      keyId: i,
      pubKey: preKeyPubKey,
      privKey: preKeyPrivKey,
    });
  }

  // Store everything in IndexedDB via signalStore (Ed25519 format)
  await signalStore.storeIdentityKeyPair({
    pubKey: identityPubKey.buffer,
    privKey: identityPrivKey,
    isEd25519: true,
  });
  await signalStore.storeLocalRegistrationId(registrationId);
  await signalStore.storeSignedPreKey(1, {
    pubKey: spkPubKey.buffer,
    privKey: spkPrivKey,
    isEd25519: true,
  });

  for (const preKey of preKeys) {
    await signalStore.storePreKey(preKey.keyId, {
      pubKey: preKey.pubKey.buffer,
      privKey: preKey.privKey,
      isEd25519: true,
    });
  }

  // Return data formatted for server registration (base64 encoded 32-byte public keys)
  return {
    identityKey: arrayBufferToBase64(identityPubKey),
    registrationId,
    signedPreKey: {
      keyId: 1,
      publicKey: arrayBufferToBase64(spkPubKey),
      signature: arrayBufferToBase64(signature),
    },
    oneTimePreKeys: preKeys.map(pk => ({
      keyId: pk.keyId,
      publicKey: arrayBufferToBase64(pk.pubKey),
    })),
  };
}

// Libsignal key generation (XEdDSA signatures - may not work with ed25519-dalek server)
async function generateRegistrationKeysLibsignal() {
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
  // Public keys are 33 bytes (with 0x05 Curve25519 type prefix)
  // Private keys are 32 bytes
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

  // Check if we're in Ed25519 mode by checking the identity key
  const identityKeyPair = await signalStore.getIdentityKeyPair();
  const useEd25519 = FEATURES.USE_ED_SIGNING && identityKeyPair?.isEd25519;

  const preKeys = [];
  for (let i = 0; i < count; i++) {
    const keyId = startId + i;

    if (useEd25519) {
      // Ed25519 mode
      const preKeyPair = await generateEd25519KeyPair();
      const preKeyPubKey = await exportEd25519PublicKey(preKeyPair.publicKey);
      const preKeyPrivKey = await exportEd25519PrivateKey(preKeyPair.privateKey);

      await signalStore.storePreKey(keyId, {
        pubKey: preKeyPubKey.buffer,
        privKey: preKeyPrivKey,
        isEd25519: true,
      });

      preKeys.push({
        keyId,
        publicKey: arrayBufferToBase64(preKeyPubKey),
      });
    } else {
      // Libsignal mode
      const preKey = await KeyHelper.generatePreKey(keyId);
      await signalStore.storePreKey(preKey.keyId, preKey.keyPair);
      preKeys.push({
        keyId: preKey.keyId,
        publicKey: arrayBufferToBase64(preKey.keyPair.pubKey),
      });
    }
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

  if (FEATURES.USE_ED_SIGNING && identityKeyPair.isEd25519) {
    // Ed25519 mode
    const spkKeyPair = await generateEd25519KeyPair();
    const spkPubKey = await exportEd25519PublicKey(spkKeyPair.publicKey);
    const spkPrivKey = await exportEd25519PrivateKey(spkKeyPair.privateKey);

    // Import identity private key to sign
    const identityPrivKey = await importEd25519PrivateKey(identityKeyPair.privKey);
    const signature = await signWithEd25519(identityPrivKey, spkPubKey);

    await signalStore.storeSignedPreKey(newKeyId, {
      pubKey: spkPubKey.buffer,
      privKey: spkPrivKey,
      isEd25519: true,
    });

    return {
      keyId: newKeyId,
      publicKey: arrayBufferToBase64(spkPubKey),
      signature: arrayBufferToBase64(signature),
    };
  } else {
    // Libsignal mode (XEdDSA)
    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, newKeyId);
    await signalStore.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);

    return {
      keyId: signedPreKey.keyId,
      publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
      signature: arrayBufferToBase64(signedPreKey.signature),
    };
  }
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
