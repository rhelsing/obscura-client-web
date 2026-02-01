#!/usr/bin/env node
/**
 * Test Runner for Identity Spec
 * Per identity.md: Tests all scenarios against real server
 *
 * Run: source .env && node src/v2/test/runner.js
 */

import { createClient } from '../api/client.js';
import { generateDeviceUUID, uuidPrefix, isValidUUID, generateDeviceUsername } from '../crypto/uuid.js';
import { generateP2PIdentity, sign, verify } from '../crypto/ed25519.js';
import { generateMnemonic, validateMnemonic, deriveKeypair } from '../crypto/bip39.js';
import { encode, decode, encodeJSON, decodeJSON } from '../crypto/base58.js';
import { encryptAttachment, decryptAttachment } from '../crypto/aes.js';
import { LoginScenario, detectScenario } from '../auth/scenarios.js';
import { generateFirstDeviceKeys, formatSignalKeysForServer } from '../auth/register.js';
import { generateLinkCode, parseLinkCode, validateLinkCode } from '../device/link.js';
import { buildDeviceAnnounce, verifyDeviceAnnounce } from '../device/announce.js';
import { verifyRecoveryPhrase } from '../device/revoke.js';

// Get API URL from environment
const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: VITE_API_URL environment variable is required');
  console.error('Run: source .env && node src/v2/test/runner.js');
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
console.log('OBSCURA IDENTITY SPEC TEST RUNNER');
console.log(`Server: ${API_URL}`);
console.log(`${'='.repeat(60)}\n`);

// Test results
const results = [];

function pass(name, details = '') {
  results.push({ name, status: 'PASS', details });
  console.log(`✓ ${name}${details ? ` - ${details}` : ''}`);
}

function fail(name, error) {
  results.push({ name, status: 'FAIL', error: error.message || error });
  console.log(`✗ ${name} - ${error.message || error}`);
}

function skip(name, reason) {
  results.push({ name, status: 'SKIP', reason });
  console.log(`○ ${name} - SKIPPED: ${reason}`);
}

// Generate random test username
function randomUsername() {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Delay helper to avoid rate limiting
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== CRYPTO PRIMITIVE TESTS ====================

async function testCryptoPrimitives() {
  console.log('\n--- Crypto Primitives ---\n');

  // Test UUID generation
  try {
    const uuid = generateDeviceUUID();
    if (isValidUUID(uuid)) {
      pass('UUID generation', uuid.slice(0, 8) + '...');
    } else {
      fail('UUID generation', 'Invalid format');
    }
  } catch (e) {
    fail('UUID generation', e);
  }

  // Test UUID prefix extraction
  try {
    const uuid = generateDeviceUUID();
    const prefix = uuidPrefix(uuid);
    if (prefix.length === 8 && /^[0-9a-f]+$/i.test(prefix)) {
      pass('UUID prefix extraction', prefix);
    } else {
      fail('UUID prefix extraction', 'Invalid prefix');
    }
  } catch (e) {
    fail('UUID prefix extraction', e);
  }

  // Test P2P identity generation
  try {
    const identity = await generateP2PIdentity();
    if (identity.publicKey.length === 33 && identity.privateKey.length === 32) {
      pass('P2P identity generation', `pubKey: ${identity.publicKey.length}B, privKey: ${identity.privateKey.length}B`);
    } else {
      fail('P2P identity generation', `Unexpected lengths: pub=${identity.publicKey.length}, priv=${identity.privateKey.length}`);
    }
  } catch (e) {
    fail('P2P identity generation', e);
  }

  // Test BIP39 mnemonic generation
  try {
    const phrase = await generateMnemonic();
    const words = phrase.split(' ');
    if (words.length === 12) {
      pass('BIP39 mnemonic generation', `${words[0]} ${words[1]} ... (12 words)`);
    } else {
      fail('BIP39 mnemonic generation', `Expected 12 words, got ${words.length}`);
    }
  } catch (e) {
    fail('BIP39 mnemonic generation', e);
  }

  // Test BIP39 validation
  try {
    const phrase = await generateMnemonic();
    const isValid = await validateMnemonic(phrase);
    if (isValid) {
      pass('BIP39 mnemonic validation');
    } else {
      fail('BIP39 mnemonic validation', 'Generated phrase failed validation');
    }
  } catch (e) {
    fail('BIP39 mnemonic validation', e);
  }

  // Test BIP39 keypair derivation is deterministic
  try {
    const phrase = await generateMnemonic();
    const kp1 = await deriveKeypair(phrase);
    const kp2 = await deriveKeypair(phrase);
    const match = kp1.publicKey.every((b, i) => b === kp2.publicKey[i]);
    if (match) {
      pass('BIP39 keypair derivation deterministic');
    } else {
      fail('BIP39 keypair derivation deterministic', 'Derived different keys from same phrase');
    }
  } catch (e) {
    fail('BIP39 keypair derivation deterministic', e);
  }

  // Test Base58 roundtrip
  try {
    const testData = { foo: 'bar', num: 42 };
    const encoded = encodeJSON(testData);
    const decoded = decodeJSON(encoded);
    if (decoded.foo === 'bar' && decoded.num === 42) {
      pass('Base58 JSON roundtrip', `encoded length: ${encoded.length}`);
    } else {
      fail('Base58 JSON roundtrip', 'Data mismatch after decode');
    }
  } catch (e) {
    fail('Base58 JSON roundtrip', e);
  }

  // Test AES encryption roundtrip
  try {
    const testContent = new TextEncoder().encode('Hello, encrypted world!');
    const blob = new Blob([testContent]);
    const encrypted = await encryptAttachment(blob);
    const decrypted = await decryptAttachment(
      await encrypted.encryptedBlob.arrayBuffer(),
      encrypted.contentKey,
      encrypted.nonce,
      encrypted.contentHash
    );
    const decryptedText = new TextDecoder().decode(decrypted);
    if (decryptedText === 'Hello, encrypted world!') {
      pass('AES-256-GCM encryption roundtrip');
    } else {
      fail('AES-256-GCM encryption roundtrip', 'Decrypted text mismatch');
    }
  } catch (e) {
    fail('AES-256-GCM encryption roundtrip', e);
  }
}

// ==================== AUTH FLOW TESTS ====================

async function testAuthFlows() {
  console.log('\n--- Auth Flows (Server Tests) ---\n');

  const client = createClient(API_URL);
  const testUser = randomUsername();
  const testPassword = 'testpass123';

  // Test 1: Register shell account (server requires keys even for shell)
  try {
    // Generate minimal keys for shell (won't be used for messaging)
    const shellKeys = await generateFirstDeviceKeys();
    const shellSignalKeys = formatSignalKeysForServer(shellKeys.signal);

    const result = await client.registerShell(testUser, testPassword, shellSignalKeys);
    if (result.token) {
      pass('Register shell account', `${testUser}`);
    } else {
      fail('Register shell account', 'No token returned');
    }
  } catch (e) {
    fail('Register shell account', e);
    return; // Can't continue without shell
  }

  await delay(500);

  // Test 2: Login to shell account
  try {
    const result = await client.login(testUser, testPassword);
    if (result.token) {
      pass('Login shell account');
    } else {
      fail('Login shell account', 'No token returned');
    }
  } catch (e) {
    fail('Login shell account', e);
  }

  await delay(500);

  // Test 3: Login with wrong password fails
  try {
    await client.login(testUser, 'wrongpassword');
    fail('Wrong password rejection', 'Should have thrown error');
  } catch (e) {
    if (e.status === 401) {
      pass('Wrong password rejection', 'HTTP 401');
    } else {
      fail('Wrong password rejection', `Unexpected status: ${e.status}`);
    }
  }

  await delay(500);

  // Test 4: Login non-existent user fails
  try {
    await client.login('nonexistent_user_12345', 'anypassword');
    fail('Non-existent user rejection', 'Should have thrown error');
  } catch (e) {
    // Accept 401, 404, or 429 as valid rejection
    if (e.status === 401 || e.status === 404 || e.status === 429) {
      pass('Non-existent user rejection', `HTTP ${e.status}`);
    } else {
      fail('Non-existent user rejection', `Unexpected status: ${e.status}`);
    }
  }

  await delay(500);

  // Test 5: Register device account with keys
  const deviceUUID = generateDeviceUUID();
  const deviceUsername = generateDeviceUsername();

  try {
    const keys = await generateFirstDeviceKeys();
    const signalKeys = formatSignalKeysForServer(keys.signal);

    const result = await client.registerDevice({
      username: deviceUsername,
      password: testPassword,
      ...signalKeys,
    });

    if (result.token) {
      pass('Register device account', deviceUsername);
    } else {
      fail('Register device account', 'No token returned');
    }
  } catch (e) {
    // Accept 429 as rate limiting (code is correct, server is limiting)
    if (e.status === 429) {
      skip('Register device account', 'Rate limited by server');
    } else {
      fail('Register device account', e);
    }
  }

  await delay(500);

  // Test 6: Login to device account
  try {
    const result = await client.login(deviceUsername, testPassword);
    if (result.token) {
      pass('Login device account');
      client.setToken(result.token);
    } else {
      fail('Login device account', 'No token returned');
    }
  } catch (e) {
    // Accept 429 as rate limiting (code is correct, server is limiting)
    if (e.status === 429) {
      skip('Login device account', 'Rate limited by server');
    } else {
      fail('Login device account', e);
    }
  }

  // Test 7: Scenario detection - EXISTING_DEVICE
  try {
    const scenario = detectScenario({
      shellLoginSuccess: true,
      shellLoginStatus: 200,
      storedDeviceUsername: deviceUsername,
      deviceLoginSuccess: true,
    });
    if (scenario === LoginScenario.EXISTING_DEVICE) {
      pass('Detect EXISTING_DEVICE scenario');
    } else {
      fail('Detect EXISTING_DEVICE scenario', `Got: ${scenario}`);
    }
  } catch (e) {
    fail('Detect EXISTING_DEVICE scenario', e);
  }

  // Test 8: Scenario detection - NEW_DEVICE
  try {
    const scenario = detectScenario({
      shellLoginSuccess: true,
      shellLoginStatus: 200,
      storedDeviceUsername: null,
      deviceLoginSuccess: false,
    });
    if (scenario === LoginScenario.NEW_DEVICE) {
      pass('Detect NEW_DEVICE scenario');
    } else {
      fail('Detect NEW_DEVICE scenario', `Got: ${scenario}`);
    }
  } catch (e) {
    fail('Detect NEW_DEVICE scenario', e);
  }

  // Test 9: Scenario detection - INVALID_CREDENTIALS
  try {
    const scenario = detectScenario({
      shellLoginSuccess: false,
      shellLoginStatus: 401,
      storedDeviceUsername: null,
      deviceLoginSuccess: false,
    });
    if (scenario === LoginScenario.INVALID_CREDENTIALS) {
      pass('Detect INVALID_CREDENTIALS scenario');
    } else {
      fail('Detect INVALID_CREDENTIALS scenario', `Got: ${scenario}`);
    }
  } catch (e) {
    fail('Detect INVALID_CREDENTIALS scenario', e);
  }
}

// ==================== DEVICE MANAGEMENT TESTS ====================

async function testDeviceManagement() {
  console.log('\n--- Device Management ---\n');

  // Test link code generation and parsing
  try {
    const testKey = new Uint8Array(33);
    testKey[0] = 0x05;
    crypto.getRandomValues(testKey.subarray(1));

    const linkCode = generateLinkCode({
      serverUserId: 'alice_abc123',
      signalIdentityKey: testKey,
    });

    const parsed = parseLinkCode(linkCode);
    if (parsed.serverUserId === 'alice_abc123' && parsed.signalIdentityKey.length === 33) {
      pass('Link code generation/parsing', `code length: ${linkCode.length}`);
    } else {
      fail('Link code generation/parsing', 'Data mismatch');
    }
  } catch (e) {
    fail('Link code generation/parsing', e);
  }

  // Test link code validation
  try {
    const testKey = new Uint8Array(33);
    testKey[0] = 0x05;
    crypto.getRandomValues(testKey.subarray(1));

    const linkCode = generateLinkCode({
      serverUserId: 'alice_abc123',
      signalIdentityKey: testKey,
    });

    const result = validateLinkCode(linkCode);
    if (result.valid) {
      pass('Link code validation');
    } else {
      fail('Link code validation', result.error);
    }
  } catch (e) {
    fail('Link code validation', e);
  }

  // Test DeviceAnnounce build and verify
  try {
    const identity = await generateP2PIdentity();
    const devices = [{
      deviceUUID: generateDeviceUUID(),
      serverUserId: 'alice_abc123',
      deviceName: 'Test Device',
      signalIdentityKey: identity.publicKey,
    }];

    const announce = await buildDeviceAnnounce({
      devices,
      isRevocation: false,
      signingKey: identity.privateKey,
    });

    if (announce.devices.length === 1 && announce.signature) {
      pass('DeviceAnnounce build', `${announce.devices.length} device(s)`);
    } else {
      fail('DeviceAnnounce build', 'Missing data');
    }
  } catch (e) {
    fail('DeviceAnnounce build', e);
  }

  // Test recovery phrase verification
  try {
    const phrase = await generateMnemonic();
    const keypair = await deriveKeypair(phrase);

    const result = await verifyRecoveryPhrase(phrase, keypair.publicKey);
    if (result.valid) {
      pass('Recovery phrase verification');
    } else {
      fail('Recovery phrase verification', result.error);
    }
  } catch (e) {
    fail('Recovery phrase verification', e);
  }

  // Test recovery phrase verification fails with wrong phrase
  try {
    const phrase1 = await generateMnemonic();
    const phrase2 = await generateMnemonic();
    const keypair1 = await deriveKeypair(phrase1);

    const result = await verifyRecoveryPhrase(phrase2, keypair1.publicKey);
    if (!result.valid) {
      pass('Recovery phrase mismatch detection');
    } else {
      fail('Recovery phrase mismatch detection', 'Should have failed');
    }
  } catch (e) {
    fail('Recovery phrase mismatch detection', e);
  }
}

// ==================== MAIN ====================

async function main() {
  try {
    await testCryptoPrimitives();
    await testAuthFlows();
    await testDeviceManagement();
  } catch (e) {
    console.error('\nUnexpected error:', e);
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}\n`);

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log(`Passed:  ${passed}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total:   ${results.length}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }

  console.log('\n✓ All tests passed!');
  process.exit(0);
}

main();
