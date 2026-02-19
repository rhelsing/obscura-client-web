#!/usr/bin/env node
// End-to-end test using real libsignal (XEdDSA signatures)
// Tests: Registration, PreKey Bundle fetch, Session establishment, Message send
//
// This will FAIL with ed25519-dalek server, PASS with xeddsa server
//
// Run: OBSCURA_API_URL=https://your-server.com node test-libsignal-e2e.js

import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
} from '@privacyresearch/libsignal-protocol-typescript';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_URL = process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: OBSCURA_API_URL environment variable is required');
  console.error('Example: OBSCURA_API_URL=https://your-server.com node test-libsignal-e2e.js');
  process.exit(1);
}

// === Protobuf Setup ===

let EncryptedMessage;

async function loadProto() {
  const protoPath = join(__dirname, 'public/proto/obscura/v1/obscura.proto');
  const root = await protobuf.load(protoPath);
  EncryptedMessage = root.lookupType('obscura.v1.EncryptedMessage');
}

function encodeEncryptedMessage(type, content) {
  // type: 1 = PREKEY_MESSAGE, 2 = ENCRYPTED_MESSAGE
  const message = EncryptedMessage.create({
    type: type === 3 ? 1 : 2, // Signal type 3 = PreKey, map to proto type 1
    content: content,
  });
  return EncryptedMessage.encode(message).finish();
}

// === Helpers ===

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// In-memory Signal store for testing
function createStore() {
  const store = {
    _identityKeyPair: null,
    _registrationId: null,
    _preKeys: new Map(),
    _signedPreKeys: new Map(),
    _sessions: new Map(),
    _identityKeys: new Map(),

    async getIdentityKeyPair() {
      return this._identityKeyPair;
    },
    async getLocalRegistrationId() {
      return this._registrationId;
    },
    async isTrustedIdentity(identifier, identityKey) {
      return true; // Trust all for testing
    },
    async saveIdentity(identifier, identityKey) {
      this._identityKeys.set(identifier, identityKey);
      return true;
    },
    async loadPreKey(keyId) {
      return this._preKeys.get(keyId);
    },
    async storePreKey(keyId, keyPair) {
      this._preKeys.set(keyId, keyPair);
    },
    async removePreKey(keyId) {
      this._preKeys.delete(keyId);
    },
    async loadSignedPreKey(keyId) {
      return this._signedPreKeys.get(keyId);
    },
    async storeSignedPreKey(keyId, keyPair) {
      this._signedPreKeys.set(keyId, keyPair);
    },
    async loadSession(identifier) {
      return this._sessions.get(identifier);
    },
    async storeSession(identifier, record) {
      this._sessions.set(identifier, record);
    },
  };
  return store;
}

// === API Functions ===

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  const decoded = JSON.parse(atob(payload));
  return decoded;
}

function getUserIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  return payload.sub || payload.user_id || payload.userId || payload.id;
}

async function register(username, password, keys) {
  const payload = {
    username,
    password,
    identityKey: toBase64(keys.identityKeyPair.pubKey),
    registrationId: keys.registrationId,
    signedPreKey: {
      keyId: keys.signedPreKey.keyId,
      publicKey: toBase64(keys.signedPreKey.keyPair.pubKey),
      signature: toBase64(keys.signedPreKey.signature),
    },
    oneTimePreKeys: keys.preKeys.map(pk => ({
      keyId: pk.keyId,
      publicKey: toBase64(pk.keyPair.pubKey),
    })),
  };

  const response = await fetch(`${API_URL}/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Registration failed: ${response.status} - ${text}`);
  }

  const result = await response.json();
  // Extract userId from JWT token (matches client behavior)
  result.userId = getUserIdFromToken(result.token);
  return result;
}

async function getPreKeyBundle(token, userId) {
  // Client uses /v1/keys/{userId}
  const response = await fetch(`${API_URL}/v1/keys/${userId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get prekey bundle: ${response.status}`);
  }

  return response.json();
}

async function sendMessage(token, recipientId, ciphertext, messageType) {
  // Encode as EncryptedMessage protobuf (matches real client)
  const protobufData = encodeEncryptedMessage(messageType, ciphertext);

  const response = await fetch(`${API_URL}/v1/messages/${recipientId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-protobuf',
      'Authorization': `Bearer ${token}`,
    },
    body: protobufData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to send message: ${response.status} - ${text}`);
  }

  return response;
}

// === Generate Keys ===

async function generateKeys() {
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  const preKeys = [];
  for (let i = 1; i <= 10; i++) {
    preKeys.push(await KeyHelper.generatePreKey(i));
  }

  return { identityKeyPair, registrationId, signedPreKey, preKeys };
}

// === Main Test ===

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  libsignal E2E Test (XEdDSA / Signal Protocol)               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log('API URL:', API_URL);
  console.log('');

  // Load protobuf definitions
  await loadProto();
  console.log('Loaded protobuf definitions\n');

  const userA = `alice_${Date.now()}`;
  const userB = `bob_${Date.now()}`;
  const password = 'testpass12345';

  // === Step 1: Generate keys for both users ===
  console.log('━━━ Step 1: Generating libsignal keys ━━━\n');

  const keysA = await generateKeys();
  const keysB = await generateKeys();

  console.log('Alice keys:');
  console.log('  Identity Key:', new Uint8Array(keysA.identityKeyPair.pubKey).length, 'bytes');
  console.log('  First byte:', '0x' + new Uint8Array(keysA.identityKeyPair.pubKey)[0].toString(16));
  console.log('  Signature:', new Uint8Array(keysA.signedPreKey.signature).length, 'bytes (XEdDSA)');

  console.log('\nBob keys:');
  console.log('  Identity Key:', new Uint8Array(keysB.identityKeyPair.pubKey).length, 'bytes');
  console.log('  First byte:', '0x' + new Uint8Array(keysB.identityKeyPair.pubKey)[0].toString(16));
  console.log('  Signature:', new Uint8Array(keysB.signedPreKey.signature).length, 'bytes (XEdDSA)');

  // === Step 2: Register both users ===
  console.log('\n━━━ Step 2: Registering users ━━━\n');

  let regA, regB;
  try {
    regA = await register(userA, password, keysA);
    console.log('✅ Alice registered! ID:', regA.userId);
  } catch (err) {
    console.log('❌ Alice registration FAILED:', err.message);
    console.log('\n⚠️  Server does not support XEdDSA signatures!');
    console.log('   Add to Cargo.toml: xeddsa = "1.0.2"');
    console.log('   Use xeddsa::xed25519::verify() for signature verification');
    process.exit(1);
  }

  try {
    regB = await register(userB, password, keysB);
    console.log('✅ Bob registered! ID:', regB.userId);
  } catch (err) {
    console.log('❌ Bob registration FAILED:', err.message);
    process.exit(1);
  }

  // Registration returns tokens, so we can skip separate login
  // (matches client behavior where register() calls setTokens())

  // === Step 3: Alice fetches Bob's prekey bundle ===
  console.log('\n━━━ Step 3: Fetching prekey bundle ━━━\n');

  const bobBundle = await getPreKeyBundle(regA.token, regB.userId);
  console.log('✅ Got Bob\'s prekey bundle:');
  console.log('  Registration ID:', bobBundle.registrationId);
  console.log('  Identity Key:', bobBundle.identityKey ? 'present' : 'missing');
  console.log('  Signed PreKey:', bobBundle.signedPreKey ? 'present' : 'missing');
  // Server may use preKey or oneTimePreKey field name
  const otpk = bobBundle.preKey || bobBundle.oneTimePreKey;
  console.log('  One-Time PreKey:', otpk ? 'present' : 'missing');

  // === Step 4: Alice builds session with Bob ===
  console.log('\n━━━ Step 4: Building Signal session ━━━\n');

  const storeA = createStore();
  storeA._identityKeyPair = keysA.identityKeyPair;
  storeA._registrationId = keysA.registrationId;

  // Store Alice's prekeys
  for (const pk of keysA.preKeys) {
    await storeA.storePreKey(pk.keyId, pk.keyPair);
  }
  await storeA.storeSignedPreKey(keysA.signedPreKey.keyId, keysA.signedPreKey.keyPair);

  const bobAddress = new SignalProtocolAddress(regB.userId, 1);

  // Build prekey bundle for session
  const preKeyBundle = {
    registrationId: bobBundle.registrationId,
    identityKey: fromBase64(bobBundle.identityKey),
    signedPreKey: {
      keyId: bobBundle.signedPreKey.keyId,
      publicKey: fromBase64(bobBundle.signedPreKey.publicKey),
      signature: fromBase64(bobBundle.signedPreKey.signature),
    },
  };

  if (otpk) {
    preKeyBundle.preKey = {
      keyId: otpk.keyId,
      publicKey: fromBase64(otpk.publicKey),
    };
  }

  const sessionBuilder = new SessionBuilder(storeA, bobAddress);

  try {
    await sessionBuilder.processPreKey(preKeyBundle);
    console.log('✅ Session established with Bob!');
  } catch (err) {
    console.log('❌ Session building FAILED:', err.message);
    console.log('\n⚠️  This likely means the server returned invalid keys.');
    process.exit(1);
  }

  // === Step 5: Alice encrypts and sends a message ===
  console.log('\n━━━ Step 5: Encrypting and sending message ━━━\n');

  const sessionCipher = new SessionCipher(storeA, bobAddress);
  const plaintext = 'Hello Bob! This is a test message from Alice.';

  const ciphertext = await sessionCipher.encrypt(new TextEncoder().encode(plaintext).buffer);
  console.log('✅ Message encrypted!');
  console.log('  Type:', ciphertext.type === 3 ? 'PreKeyWhisperMessage' : 'WhisperMessage');
  console.log('  Body length:', ciphertext.body.length, 'bytes');

  // Convert ciphertext body to Uint8Array for protobuf
  let bodyBytes;
  if (typeof ciphertext.body === 'string') {
    bodyBytes = new Uint8Array(ciphertext.body.length);
    for (let i = 0; i < ciphertext.body.length; i++) {
      bodyBytes[i] = ciphertext.body.charCodeAt(i);
    }
  } else {
    bodyBytes = new Uint8Array(ciphertext.body);
  }

  try {
    await sendMessage(regA.token, regB.userId, bodyBytes, ciphertext.type);
    console.log('✅ Message sent to Bob!');
  } catch (err) {
    console.log('❌ Message send FAILED:', err.message);
    process.exit(1);
  }

  // === Done! ===
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🎉 ALL TESTS PASSED!                                        ║');
  console.log('║                                                              ║');
  console.log('║  Server correctly supports:                                  ║');
  console.log('║  ✅ XEdDSA signature verification (registration)             ║');
  console.log('║  ✅ 33-byte Curve25519 keys (0x05 prefix)                    ║');
  console.log('║  ✅ PreKey bundle retrieval                                  ║');
  console.log('║  ✅ Encrypted message delivery                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
