// Simple crypto utilities for key generation (POC only - not production-ready)
// In production, use libsignal-protocol-javascript

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    publicKey: arrayBufferToBase64(publicKeyRaw),
    privateKey: arrayBufferToBase64(privateKeyPkcs8),
    keyPair,
  };
}

async function sign(privateKey, data) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(data)
  );
  return arrayBufferToBase64(signature);
}

export async function generateRegistrationKeys() {
  // Generate identity key pair
  const identity = await generateKeyPair();

  // Generate signed pre-key
  const signedPreKey = await generateKeyPair();
  const signedPreKeySignature = await sign(
    identity.keyPair.privateKey,
    signedPreKey.publicKey
  );

  // Generate one-time pre-keys (generate 10 for POC)
  const oneTimePreKeys = [];
  for (let i = 0; i < 10; i++) {
    const otp = await generateKeyPair();
    oneTimePreKeys.push({
      keyId: i + 1,
      publicKey: otp.publicKey,
    });
  }

  const registrationId = Math.floor(Math.random() * 16380) + 1;

  return {
    identityKey: identity.publicKey,
    registrationId,
    signedPreKey: {
      keyId: 1,
      publicKey: signedPreKey.publicKey,
      signature: signedPreKeySignature,
    },
    oneTimePreKeys,
    // Store private keys locally (in production, use IndexedDB with encryption)
    _private: {
      identityKey: identity.privateKey,
      signedPreKey: signedPreKey.privateKey,
    },
  };
}

export function storeKeys(keys) {
  localStorage.setItem('obscura_keys', JSON.stringify({
    identityKey: keys.identityKey,
    registrationId: keys.registrationId,
    _private: keys._private,
  }));
}

export function loadKeys() {
  const stored = localStorage.getItem('obscura_keys');
  return stored ? JSON.parse(stored) : null;
}

export function clearKeys() {
  localStorage.removeItem('obscura_keys');
}
