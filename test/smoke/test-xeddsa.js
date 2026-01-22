#!/usr/bin/env node
// Test using XEdDSA signatures (what libsignal/Signal Protocol uses)
// This will FAIL with ed25519-dalek server, PASS with xeddsa server
//
// Run: node test-xeddsa.js
// Or:  OBSCURA_API_URL=http://localhost:3000 node test-xeddsa.js

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

const API_URL = process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: OBSCURA_API_URL environment variable is required');
  console.error('Example: OBSCURA_API_URL=https://your-server.com node test-xeddsa.js');
  process.exit(1);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function main() {
  console.log('=== XEdDSA Test (libsignal / Signal Protocol) ===\n');
  console.log('API URL:', API_URL);
  console.log('');

  // Generate keys using libsignal (uses XEdDSA for signatures)
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);
  const preKey = await KeyHelper.generatePreKey(1);

  const identityPubKey = new Uint8Array(identityKeyPair.pubKey);
  const spkPubKey = new Uint8Array(signedPreKey.keyPair.pubKey);
  const signature = new Uint8Array(signedPreKey.signature);
  const otpkPubKey = new Uint8Array(preKey.keyPair.pubKey);

  console.log('Key sizes (libsignal adds 0x05 Curve25519 type prefix):');
  console.log('  Identity Public Key:', identityPubKey.length, 'bytes (first byte: 0x' + identityPubKey[0].toString(16) + ')');
  console.log('  SignedPreKey Public Key:', spkPubKey.length, 'bytes');
  console.log('  Signature:', signature.length, 'bytes (XEdDSA, NOT Ed25519!)');
  console.log('  OneTimePreKey Public Key:', otpkPubKey.length, 'bytes');

  // Build payload with 33-byte keys (standard libsignal output)
  const payload = {
    username: `test_xeddsa_${Date.now()}`,
    password: 'testpass123',
    identityKey: toBase64(identityKeyPair.pubKey),
    registrationId,
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: toBase64(signedPreKey.keyPair.pubKey),
      signature: toBase64(signedPreKey.signature),
    },
    oneTimePreKeys: [{
      keyId: preKey.keyId,
      publicKey: toBase64(preKey.keyPair.pubKey),
    }],
  };

  console.log('\n=== Registration Payload ===\n');
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
      console.log('\n🎉 Server supports XEdDSA (Signal Protocol compatible)!');
    } else {
      console.log('❌ FAILED! Status:', response.status);
      console.log('Error:', text);
      console.log('\n⚠️  Server uses Ed25519, not XEdDSA.');
      console.log('   To fix, add to Cargo.toml: xeddsa = "1.0.2"');
      console.log('   And use xeddsa::xed25519::verify() instead of ed25519_dalek');
    }
  } catch (err) {
    console.log('❌ REQUEST ERROR:', err.message);
  }
}

main().catch(console.error);
