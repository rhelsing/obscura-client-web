#!/usr/bin/env node
/**
 * Smoke test for the new v0.8.0 server API (server-managed devices)
 * Tests: registerUser → provisionDevice → loginWithDevice → listDevices → fetchPreKeyBundles
 *
 * Run: OBSCURA_API_URL=https://dev.obscura.barrelmaker.dev node test/smoke/test-new-api.js
 */

import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

const API_URL = process.env.OBSCURA_API_URL || process.env.VITE_API_URL;
if (!API_URL) {
  console.error('Error: OBSCURA_API_URL or VITE_API_URL required');
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

function parseJwt(token) {
  return JSON.parse(atob(token.split('.')[1]));
}

async function request(path, opts = {}) {
  const url = `${API_URL}${path}`;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${opts.method || 'GET'} ${path}: ${res.status} ${text}`);
  }
  const ct = res.headers.get('content-type');
  return ct?.includes('json') ? res.json() : res.text();
}

const username = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const password = 'testpass12345';

console.log(`\n=== Smoke Test: New API (v0.8.0) ===`);
console.log(`Server: ${API_URL}`);
console.log(`User: ${username}\n`);

try {
  // 1. Register user (no keys)
  console.log('1. POST /v1/users (register, no keys)...');
  const regResult = await request('/v1/users', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  console.log('   ✓ Registered. Token claims:', parseJwt(regResult.token));
  const userToken = regResult.token;
  const userId = parseJwt(userToken).sub;
  console.log('   userId:', userId);
  console.log('   has deviceId claim:', 'deviceId' in parseJwt(userToken));

  // 2. Generate Signal keys
  console.log('\n2. Generating Signal keys...');
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);
  const preKeys = [];
  for (let i = 1; i <= 10; i++) {
    preKeys.push(await KeyHelper.generatePreKey(i));
  }
  console.log('   ✓ Keys generated');

  // 3. Provision device
  console.log('\n3. POST /v1/devices (provision device)...');
  const deviceResult = await request('/v1/devices', {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({
      name: 'Smoke Test Device',
      identityKey: toBase64(identityKeyPair.pubKey),
      registrationId,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: toBase64(signedPreKey.keyPair.pubKey),
        signature: toBase64(signedPreKey.signature),
      },
      oneTimePreKeys: preKeys.map(pk => ({
        keyId: pk.keyId,
        publicKey: toBase64(pk.keyPair.pubKey),
      })),
    }),
  });
  const deviceToken = deviceResult.token;
  const deviceClaims = parseJwt(deviceToken);
  console.log('   ✓ Device provisioned. Claims:', deviceClaims);
  const deviceId = deviceResult.deviceId || deviceClaims.deviceId;
  console.log('   deviceId:', deviceId);

  // 4. Login with deviceId
  console.log('\n4. POST /v1/sessions (login with deviceId)...');
  const loginResult = await request('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ username, password, deviceId }),
  });
  const loginClaims = parseJwt(loginResult.token);
  console.log('   ✓ Logged in. Claims:', loginClaims);
  console.log('   deviceId in token:', loginClaims.deviceId);

  // 5. List devices
  console.log('\n5. GET /v1/devices (list devices)...');
  const deviceList = await request('/v1/devices', {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  console.log('   ✓ Devices:', JSON.stringify(deviceList, null, 2));

  // 6. Fetch prekey bundles
  console.log(`\n6. GET /v1/users/${userId} (prekey bundles)...`);
  const bundles = await request(`/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  console.log('   ✓ Bundles:', Array.isArray(bundles) ? `${bundles.length} bundle(s)` : typeof bundles);
  if (Array.isArray(bundles) && bundles.length > 0) {
    console.log('   First bundle keys:', Object.keys(bundles[0]));
  }

  // 7. Upload more prekeys
  console.log('\n7. POST /v1/devices/keys (upload prekeys)...');
  const newSignedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 2);
  const newPreKeys = [];
  for (let i = 11; i <= 15; i++) {
    newPreKeys.push(await KeyHelper.generatePreKey(i));
  }
  await request('/v1/devices/keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      signedPreKey: {
        keyId: newSignedPreKey.keyId,
        publicKey: toBase64(newSignedPreKey.keyPair.pubKey),
        signature: toBase64(newSignedPreKey.signature),
      },
      oneTimePreKeys: newPreKeys.map(pk => ({
        keyId: pk.keyId,
        publicKey: toBase64(pk.keyPair.pubKey),
      })),
    }),
  });
  console.log('   ✓ Keys uploaded');

  // 8. Get gateway ticket
  console.log('\n8. POST /v1/gateway/ticket...');
  const ticketResult = await request('/v1/gateway/ticket', {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  console.log('   ✓ Ticket:', ticketResult.ticket?.slice(0, 20) + '...');

  console.log('\n=== ALL SMOKE TESTS PASSED ===\n');
} catch (err) {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
}
