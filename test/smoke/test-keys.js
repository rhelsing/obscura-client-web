#!/usr/bin/env node
// Test script to figure out the correct key format for server handshake
// Run with: node test-keys.js

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

const API_URL = process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: OBSCURA_API_URL environment variable is required');
  console.error('Example: OBSCURA_API_URL=https://your-server.com node test-keys.js');
  process.exit(1);
}

// Helper to convert ArrayBuffer to base64 (keeps all bytes)
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// URL-safe base64
function toBase64Url(buffer) {
  return toBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Helper to convert ArrayBuffer to base64 (strips 0x05 prefix if present)
function toBase64Stripped(buffer) {
  let bytes = new Uint8Array(buffer);
  if (bytes.length === 33 && bytes[0] === 0x05) {
    bytes = bytes.slice(1);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function toBase64StrippedUrl(buffer) {
  return toBase64Stripped(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Helper to show key info
function showKeyInfo(name, buffer) {
  const bytes = new Uint8Array(buffer);
  console.log(`${name}:`);
  console.log(`  Length: ${bytes.length} bytes`);
  console.log(`  First byte: 0x${bytes[0].toString(16).padStart(2, '0')}`);
  console.log(`  Base64 (full): ${toBase64(buffer)}`);
  if (bytes.length === 33 && bytes[0] === 0x05) {
    console.log(`  Base64 (stripped): ${toBase64Stripped(buffer)}`);
  }
}

async function generateAndShowKeys() {
  console.log('=== Generating Signal Protocol Keys ===\n');

  // Generate identity key pair
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();

  // Generate signed pre-key
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  // Generate one-time pre-key
  const preKey = await KeyHelper.generatePreKey(1);

  console.log('--- Key Analysis ---\n');
  showKeyInfo('Identity Public Key', identityKeyPair.pubKey);
  console.log();
  showKeyInfo('Identity Private Key', identityKeyPair.privKey);
  console.log();
  showKeyInfo('SignedPreKey Public Key', signedPreKey.keyPair.pubKey);
  console.log();
  showKeyInfo('SignedPreKey Signature', signedPreKey.signature);
  console.log();
  showKeyInfo('OneTimePreKey Public Key', preKey.keyPair.pubKey);
  console.log();

  return { identityKeyPair, registrationId, signedPreKey, preKey };
}

async function testRegistration(keys, config) {
  const { identityKeyPair, registrationId, signedPreKey, preKey } = keys;
  const { identityStrip, signedStrip, onetimeStrip, urlSafe, label } = config;

  console.log(`\n=== Testing: ${label} ===\n`);

  const username = `test_${Date.now()}`;
  const password = 'testpass12345';

  // Choose encoding functions based on config
  const encodeKey = (buffer, strip) => {
    if (strip && urlSafe) return toBase64StrippedUrl(buffer);
    if (strip) return toBase64Stripped(buffer);
    if (urlSafe) return toBase64Url(buffer);
    return toBase64(buffer);
  };

  const payload = {
    username,
    password,
    identityKey: encodeKey(identityKeyPair.pubKey, identityStrip),
    registrationId,
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: encodeKey(signedPreKey.keyPair.pubKey, signedStrip),
      signature: urlSafe ? toBase64Url(signedPreKey.signature) : toBase64(signedPreKey.signature),
    },
    oneTimePreKeys: [{
      keyId: preKey.keyId,
      publicKey: encodeKey(preKey.keyPair.pubKey, onetimeStrip),
    }],
  };

  // Decode base64 (handles URL-safe)
  const decodeB64 = (s) => {
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return atob(b64);
  };

  console.log('Payload sizes:');
  console.log(`  identityKey: ${decodeB64(payload.identityKey).length} bytes`);
  console.log(`  signedPreKey.publicKey: ${decodeB64(payload.signedPreKey.publicKey).length} bytes`);
  console.log(`  signedPreKey.signature: ${decodeB64(payload.signedPreKey.signature).length} bytes`);
  console.log(`  oneTimePreKeys[0].publicKey: ${decodeB64(payload.oneTimePreKeys[0].publicKey).length} bytes`);

  // Show actual JSON being sent
  console.log('\nActual JSON payload:');
  console.log(JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(`${API_URL}/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    if (response.ok) {
      console.log(`\n✅ SUCCESS! Status: ${response.status}`);
      console.log('Response:', text.slice(0, 200));
      return true;
    } else {
      console.log(`\n❌ FAILED! Status: ${response.status}`);
      console.log('Error:', text);
      return false;
    }
  } catch (err) {
    console.log(`\n❌ REQUEST ERROR:`, err.message);
    return false;
  }
}

// Main
async function main() {
  const keys = await generateAndShowKeys();

  // Test key combos - signature was created over 33-byte signedPreKey
  // Server needs to verify with matching format
  const configs = [
    { identityStrip: false, signedStrip: false, onetimeStrip: false, urlSafe: false, label: '1. ALL 33-byte' },
    { identityStrip: true,  signedStrip: true,  onetimeStrip: true,  urlSafe: false, label: '2. ALL 32-byte' },
  ];

  for (const config of configs) {
    await testRegistration(keys, config);
    await new Promise(r => setTimeout(r, 1000)); // avoid rate limit
  }
}

main().catch(console.error);
