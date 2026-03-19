#!/usr/bin/env node
/**
 * Smoke test: Multi-device messaging
 * Test what actually happens when the same user has 2 devices.
 *
 * Questions to answer:
 * 1. What is Envelope.sender_id when device A sends to device B of SAME user?
 * 2. What is Envelope.sender_id when device A sends to device C of DIFFERENT user?
 * 3. How should Signal sessions be keyed?
 * 4. Can we fetch our OWN prekey bundles?
 */

import { TestClient, randomUsername } from '../../src/v2/test/testClient.js';

const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: VITE_API_URL required');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log(`\n=== Multi-Device Smoke Test ===`);
console.log(`Server: ${API_URL}\n`);

try {
  // === Setup: Register Alice (1 device) and Bob (2 devices) ===
  console.log('--- Setup ---');

  // Register Bob's user account
  const bob1 = new TestClient(API_URL);
  await bob1.register(randomUsername(), 'testpass12345');
  console.log(`Bob1: userId=${bob1.userId}, deviceId=${bob1.deviceId}`);

  // Register Bob's second device (same user, new device)
  const bob2 = new TestClient(API_URL);
  bob2.username = bob1.username;
  bob2.password = 'testpass12345';

  // Login as Bob (user-scoped token)
  const loginResult = await bob2.request('/v1/sessions', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ username: bob1.username, password: 'testpass12345' }),
  });
  bob2.token = loginResult.token;
  bob2.userId = bob2.parseUserId(loginResult.token);
  console.log(`Bob2 login: userId=${bob2.userId}, hasDeviceId=${!!bob2.parseDeviceId(loginResult.token)}`);

  // Generate keys for bob2
  const bob2Keys = await bob2.generateKeys();

  // Provision bob2's device
  const bob2Device = await bob2.request('/v1/devices', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bob Device 2', ...bob2Keys }),
  });
  bob2.token = bob2Device.token;
  bob2.deviceId = bob2.parseDeviceId(bob2Device.token) || bob2Device.deviceId;
  console.log(`Bob2 provisioned: userId=${bob2.userId}, deviceId=${bob2.deviceId}`);
  console.log(`Same userId? ${bob1.userId === bob2.userId}`);

  // Register Alice
  const alice = new TestClient(API_URL);
  await alice.register(randomUsername(), 'testpass12345');
  console.log(`Alice: userId=${alice.userId}, deviceId=${alice.deviceId}`);

  // === Test 1: Fetch own prekey bundles ===
  console.log('\n--- Test 1: Fetch own prekey bundles ---');
  const ownBundles = await bob1.fetchPreKeyBundles(bob1.userId);
  console.log(`Bob1 fetches own bundles: ${ownBundles.length} device(s)`);
  for (const b of ownBundles) {
    console.log(`  device: ${b.deviceId}, regId: ${b.registrationId}`);
  }

  // === Test 2: Bob1 sends to Bob2 (same user, different device) ===
  console.log('\n--- Test 2: Same-user device-to-device message ---');
  await bob2.connectWebSocket();

  // Bob1 needs to encrypt for bob2. What userId should Signal use?
  // Option A: Use bob2.userId (same as bob1.userId)
  // Option B: Use bob2.deviceId
  console.log(`Encrypting with userId (${bob1.userId})...`);
  try {
    await bob1.sendMessage(bob2.deviceId, { type: 'TEXT', text: 'Hello from bob1' }, bob1.userId);
    console.log('Send succeeded');
  } catch (e) {
    console.log(`Send with userId FAILED: ${e.message}`);
  }

  // Wait for bob2 to receive
  try {
    const msg = await bob2.waitForMessage(5000);
    console.log(`Bob2 received: type=${msg.type}, text="${msg.text}"`);
    console.log(`Envelope sender_id: ${msg.sourceUserId}`);
    console.log(`sender_id === bob1.userId? ${msg.sourceUserId === bob1.userId}`);
    console.log(`sender_id === bob1.deviceId? ${msg.sourceUserId === bob1.deviceId}`);
  } catch (e) {
    console.log(`Bob2 receive FAILED: ${e.message}`);
  }
  bob2.disconnectWebSocket();

  // === Test 3: Alice sends to Bob (cross-user) ===
  console.log('\n--- Test 3: Cross-user message, multiple devices ---');

  // Fetch Bob's bundles from Alice's perspective
  const bobBundles = await alice.fetchPreKeyBundles(bob1.userId);
  console.log(`Alice fetches Bob bundles: ${bobBundles.length} device(s)`);
  for (const b of bobBundles) {
    console.log(`  device: ${b.deviceId}`);
  }

  // Connect both bob devices
  await bob1.connectWebSocket();
  await bob2.connectWebSocket();

  // Alice sends to BOTH bob devices
  for (const bundle of bobBundles) {
    await alice.queueMessage(bundle.deviceId, { type: 'TEXT', text: 'Hello both bobs!' }, bob1.userId);
  }
  await alice.flushMessages();
  console.log(`Alice sent to ${bobBundles.length} devices`);

  // Both should receive
  try {
    const msg1 = await bob1.waitForMessage(5000);
    console.log(`Bob1 received: "${msg1.text}", sender_id=${msg1.sourceUserId}`);
    console.log(`sender_id === alice.userId? ${msg1.sourceUserId === alice.userId}`);
    console.log(`sender_id === alice.deviceId? ${msg1.sourceUserId === alice.deviceId}`);
  } catch (e) {
    console.log(`Bob1 receive FAILED: ${e.message}`);
  }

  try {
    const msg2 = await bob2.waitForMessage(5000);
    console.log(`Bob2 received: "${msg2.text}", sender_id=${msg2.sourceUserId}`);
  } catch (e) {
    console.log(`Bob2 receive FAILED: ${e.message}`);
  }

  // === Test 4: What Signal address works for same-user? ===
  console.log('\n--- Test 4: Signal session key investigation ---');

  // After test 2, bob1 has a session keyed by bob1.userId (same as bob2.userId)
  // That means bob1 encrypted for "bob.userId" and bob2 decrypted from "bob.userId"
  // But bob1 IS bob.userId... so the session is with yourself?
  //
  // Actually: bob1 fetches bob2's prekey bundle (via fetchPreKeyBundles(bob1.userId))
  // The bundle has bob2's identity key. The session is built with bob2's keys.
  // The SignalProtocolAddress is (bob.userId, 1).
  // When bob2 receives, it decrypts using the session at address (bob.userId, 1) = sender's userId.
  //
  // This works because:
  // - bob1 has session (bob.userId, 1) built from bob2's prekey bundle
  // - bob2 has session (bob.userId, 1) built from decrypting bob1's prekey message
  // Both sessions use the SAME address but different directions (sending vs receiving)

  console.log('Session analysis:');
  const bob1Sessions = [];
  const bob2Sessions = [];

  // Check what sessions exist
  for (const userId of [bob1.userId, bob2.userId, alice.userId, bob1.deviceId, bob2.deviceId, alice.deviceId]) {
    const addr = `${userId}.1`;
    const s1 = await bob1.store.loadSession(addr);
    const s2 = await bob2.store.loadSession(addr);
    if (s1) bob1Sessions.push(addr);
    if (s2) bob2Sessions.push(addr);
  }
  console.log('Bob1 sessions:', bob1Sessions);
  console.log('Bob2 sessions:', bob2Sessions);

  bob1.disconnectWebSocket();
  bob2.disconnectWebSocket();

  console.log('\n=== MULTI-DEVICE SMOKE TEST COMPLETE ===\n');
} catch (err) {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}
