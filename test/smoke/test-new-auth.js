#!/usr/bin/env node
/**
 * Smoke test: auth.js register() and login() against new API
 * Validates the rewritten auth module works with server-managed devices.
 *
 * Run: VITE_API_URL=https://dev.obscura.barrelmaker.dev node test/smoke/test-new-auth.js
 */
import '../../test/helpers/setup.js';
import { register, login, logout } from '../../src/v2/lib/auth.js';

const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: VITE_API_URL or OBSCURA_API_URL required');
  process.exit(1);
}

function parseJwt(token) {
  return JSON.parse(atob(token.split('.')[1]));
}

const username = `smoke_auth_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const password = 'testpass12345';

console.log(`\n=== Smoke Test: auth.js register/login ===`);
console.log(`Server: ${API_URL}`);
console.log(`User: ${username}\n`);

try {
  // 1. Register
  console.log('1. register()...');
  const regResult = await register(username, password, { apiUrl: API_URL });

  console.log('   token claims:', parseJwt(regResult.token));
  console.log('   userId:', regResult.userId);
  console.log('   deviceId:', regResult.deviceId);
  console.log('   deviceUUID:', regResult.deviceUUID);
  console.log('   has recoveryPublicKey:', !!regResult.recoveryPublicKey);
  console.log('   has p2pIdentity:', !!regResult.p2pIdentity);
  console.log('   has deviceInfo:', !!regResult.deviceInfo);
  console.log('   deviceInfo.deviceId:', regResult.deviceInfo?.deviceId);

  // Verify key fields
  if (!regResult.userId) throw new Error('Missing userId');
  if (!regResult.deviceId) throw new Error('Missing deviceId');
  if (!regResult.token) throw new Error('Missing token');
  if (!regResult.deviceInfo?.deviceId) throw new Error('Missing deviceInfo.deviceId');

  // Verify recovery phrase works
  const phrase = regResult.getRecoveryPhrase();
  if (!phrase || phrase.split(' ').length !== 12) {
    throw new Error(`Invalid recovery phrase: ${phrase}`);
  }
  console.log('   ✓ Recovery phrase: 12 words');

  // Second call returns null
  if (regResult.getRecoveryPhrase() !== null) {
    throw new Error('Recovery phrase should be null on second read');
  }
  console.log('   ✓ Phrase cleared after first read');

  // No more shell tokens
  if (regResult.shellToken !== undefined) {
    console.log('   ⚠ shellToken field still present (should be removed)');
  }

  console.log('   ✓ Register passed\n');

  // 2. Logout
  console.log('2. logout()...');
  logout();
  console.log('   ✓ Logged out\n');

  // 3. Login (existing device)
  console.log('3. login() with stored deviceId...');
  const loginResult = await login(username, password, { apiUrl: API_URL });

  console.log('   status:', loginResult.status);

  if (loginResult.status === 'ok') {
    console.log('   userId:', loginResult.client.userId);
    console.log('   deviceId:', loginResult.client.deviceId);
    console.log('   token claims:', parseJwt(loginResult.client.token));
    console.log('   ✓ Login (existing device) passed');
  } else if (loginResult.status === 'newDevice') {
    // This happens if IndexedDB isn't available (Node.js without polyfill stores)
    console.log('   Got newDevice (expected in Node.js without IndexedDB persistence)');
    console.log('   deviceId:', loginResult.client.deviceId);
    console.log('   linkCode length:', loginResult.linkCode?.length);
    console.log('   ✓ Login (new device) passed');
  } else {
    throw new Error(`Unexpected login status: ${loginResult.status} - ${loginResult.reason}`);
  }

  console.log('\n=== ALL AUTH SMOKE TESTS PASSED ===\n');
} catch (err) {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}
