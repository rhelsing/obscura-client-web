#!/usr/bin/env node
// Test using Ed25519 signatures (what the server expects)
// This mimics how the server's own tests generate keys

import * as crypto from 'crypto';

const API_URL = process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: OBSCURA_API_URL environment variable is required');
  console.error('Example: OBSCURA_API_URL=https://your-server.com node test-ed25519.js');
  process.exit(1);
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

async function main() {
  console.log('=== Generating Ed25519 Keys (server-compatible) ===\n');

  // Generate Ed25519 identity key pair
  const identityKeyPair = crypto.generateKeyPairSync('ed25519');
  const identityPubKey = identityKeyPair.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const identityPrivKey = identityKeyPair.privateKey;

  // Generate Ed25519 signed pre-key pair
  const spkKeyPair = crypto.generateKeyPairSync('ed25519');
  const spkPubKey = spkKeyPair.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);

  // Generate Ed25519 one-time pre-key pair
  const otpkKeyPair = crypto.generateKeyPairSync('ed25519');
  const otpkPubKey = otpkKeyPair.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);

  // Sign the signed pre-key public key with identity private key
  const signature = crypto.sign(null, spkPubKey, identityPrivKey);

  console.log('Identity Public Key:', identityPubKey.length, 'bytes');
  console.log('SignedPreKey Public Key:', spkPubKey.length, 'bytes');
  console.log('Signature:', signature.length, 'bytes');
  console.log('OneTimePreKey Public Key:', otpkPubKey.length, 'bytes');

  // Build registration payload (32-byte keys, like server tests)
  const payload = {
    username: `test_ed25519_${Date.now()}`,
    password: 'testpass12345',
    identityKey: toBase64(identityPubKey),
    registrationId: Math.floor(Math.random() * 16380) + 1,
    signedPreKey: {
      keyId: 1,
      publicKey: toBase64(spkPubKey),
      signature: toBase64(signature),
    },
    oneTimePreKeys: [{
      keyId: 1,
      publicKey: toBase64(otpkPubKey),
    }],
  };

  console.log('\n=== Payload (32-byte Ed25519 keys) ===\n');
  console.log(JSON.stringify(payload, null, 2));

  console.log('\n=== Testing Registration ===\n');

  try {
    const response = await fetch(`${API_URL}/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    if (response.ok) {
      console.log('✅ SUCCESS! Status:', response.status);
      console.log('Response:', text.slice(0, 200));
    } else {
      console.log('❌ FAILED! Status:', response.status);
      console.log('Error:', text);
    }
  } catch (err) {
    console.log('❌ REQUEST ERROR:', err.message);
  }

  console.log('\n=== Now test with 33-byte keys (0x05 prefix) ===\n');

  // Add 0x05 prefix to simulate libsignal format
  const identityPubKey33 = Buffer.concat([Buffer.from([0x05]), identityPubKey]);
  const spkPubKey33 = Buffer.concat([Buffer.from([0x05]), spkPubKey]);
  const otpkPubKey33 = Buffer.concat([Buffer.from([0x05]), otpkPubKey]);

  // Sign the 32-byte key (what libsignal does)
  const signature32 = crypto.sign(null, spkPubKey, identityPrivKey);

  const payload33 = {
    username: `test_ed25519_33_${Date.now()}`,
    password: 'testpass12345',
    identityKey: toBase64(identityPubKey33),
    registrationId: Math.floor(Math.random() * 16380) + 1,
    signedPreKey: {
      keyId: 1,
      publicKey: toBase64(spkPubKey33),
      signature: toBase64(signature32), // signature over 32-byte key
    },
    oneTimePreKeys: [{
      keyId: 1,
      publicKey: toBase64(otpkPubKey33),
    }],
  };

  console.log('Payload sizes:');
  console.log('  identityKey:', Buffer.from(payload33.identityKey, 'base64').length, 'bytes');
  console.log('  signedPreKey.publicKey:', Buffer.from(payload33.signedPreKey.publicKey, 'base64').length, 'bytes');
  console.log('  signature over:', spkPubKey.length, 'bytes');

  try {
    const response = await fetch(`${API_URL}/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload33),
    });

    const text = await response.text();

    if (response.ok) {
      console.log('\n✅ SUCCESS! Status:', response.status);
      console.log('Response:', text.slice(0, 200));
    } else {
      console.log('\n❌ FAILED! Status:', response.status);
      console.log('Error:', text);
    }
  } catch (err) {
    console.log('\n❌ REQUEST ERROR:', err.message);
  }
}

main().catch(console.error);
