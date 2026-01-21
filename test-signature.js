#!/usr/bin/env node
// Test what libsignal actually signs (32 or 33 byte message)

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import curve25519 from '@privacyresearch/curve25519-typescript';
const { AsyncCurve25519Wrapper } = curve25519;

async function main() {
  // Generate keys using libsignal
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

  const identityPubKey = new Uint8Array(identityKeyPair.pubKey);  // 33 bytes
  const identityPrivKey = new Uint8Array(identityKeyPair.privKey);  // 32 bytes
  const signedPubKey = new Uint8Array(signedPreKey.keyPair.pubKey);  // 33 bytes
  const signature = new Uint8Array(signedPreKey.signature);  // 64 bytes

  console.log('=== What did libsignal sign? ===\n');
  console.log('Identity pubKey:', identityPubKey.length, 'bytes');
  console.log('Identity privKey:', identityPrivKey.length, 'bytes');
  console.log('SignedPreKey pubKey:', signedPubKey.length, 'bytes');
  console.log('Signature:', signature.length, 'bytes');

  // Strip the 0x05 prefix to get raw 32-byte keys
  const identityPubKey32 = identityPubKey.slice(1);  // 32 bytes
  const signedPubKey32 = signedPubKey.slice(1);  // 32 bytes

  console.log('\n=== Testing with libsignal Curve.verify() ===\n');

  const curve = new AsyncCurve25519Wrapper();

  // Test 1: Verify 33-byte message with 33-byte pubkey
  try {
    const valid = await curve.verify(identityPubKey, signedPubKey, signature);
    console.log('33-byte pubkey, 33-byte message:', valid ? '✅ VALID' : '❌ INVALID');
  } catch (e) {
    console.log('33-byte pubkey, 33-byte message: ❌ ERROR -', e.message);
  }

  // Test 2: Verify 32-byte message with 33-byte pubkey
  try {
    const valid = await curve.verify(identityPubKey, signedPubKey32, signature);
    console.log('33-byte pubkey, 32-byte message:', valid ? '✅ VALID' : '❌ INVALID');
  } catch (e) {
    console.log('33-byte pubkey, 32-byte message: ❌ ERROR -', e.message);
  }

  // Test 3: Verify 33-byte message with 32-byte pubkey
  try {
    const valid = await curve.verify(identityPubKey32, signedPubKey, signature);
    console.log('32-byte pubkey, 33-byte message:', valid ? '✅ VALID' : '❌ INVALID');
  } catch (e) {
    console.log('32-byte pubkey, 33-byte message: ❌ ERROR -', e.message);
  }

  // Test 4: Verify 32-byte message with 32-byte pubkey
  try {
    const valid = await curve.verify(identityPubKey32, signedPubKey32, signature);
    console.log('32-byte pubkey, 32-byte message:', valid ? '✅ VALID' : '❌ INVALID');
  } catch (e) {
    console.log('32-byte pubkey, 32-byte message: ❌ ERROR -', e.message);
  }

  console.log('\n=== Conclusion ===');
  console.log('Server must use the same key/message format that shows VALID.');
  console.log('Note: Signal uses XEdDSA, not standard Ed25519!');
}

main().catch(console.error);
