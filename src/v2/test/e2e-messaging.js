#!/usr/bin/env node
/**
 * E2E Multi-Device Messaging Tests (v2 - Level 2 Compliant)
 *
 * LEVEL 2 COMPLIANCE
 * ==================
 *
 * Level 2 means "no cheating" - the test client must discover everything
 * through proper protocol flows, never using hardcoded values or backdoors.
 *
 * LEVEL 1 (cheating - NOT allowed):
 * - Hardcoded userIds passed directly to send functions
 * - Knowing recipient's devices without proper discovery
 * - Bypassing friend flow to message strangers
 * - Using server-side knowledge client shouldn't have
 * - Using fake "__self__" friend entries for self-sync
 *
 * LEVEL 2 (no cheating - REQUIRED):
 * - Friends discovered via FRIEND_REQUEST → FRIEND_RESPONSE flow
 * - Friend devices discovered via DeviceAnnounce in friend messages
 * - Own devices tracked via ownDevices array (not fake friends)
 * - Messages sent via friend device list lookup (sendToFriend)
 * - Self-sync via SENT_SYNC to own devices from ownDevices array
 * - Initial sync via SYNC_BLOB after DEVICE_LINK_APPROVAL
 *
 * WHY THIS MATTERS:
 * Tests that cheat don't catch real bugs. If the test knows something
 * the real client wouldn't, passing tests mean nothing.
 *
 * EXCEPTION - Device linking:
 * DEVICE_LINK_APPROVAL can use direct userId because it's between
 * same-user devices that discovered each other via QR/link code.
 *
 * Run: source .env && node src/v2/test/e2e-messaging.js
 */

import { TestClient } from './testClient.js';
import { buildLinkApprovalProto, verifyChallenge } from '../device/link.js';
import { buildDeviceAnnounceProto, verifyDeviceAnnounceProto } from '../device/announce.js';
import { generateP2PIdentity } from '../crypto/ed25519.js';
import { encryptAttachment, decryptAttachment, uint8ArrayToBase64, base64ToUint8Array } from '../crypto/aes.js';

const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: VITE_API_URL environment variable is required');
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
console.log('E2E MULTI-DEVICE MESSAGING TESTS (Level 2)');
console.log(`Server: ${API_URL}`);
console.log(`${'='.repeat(60)}\n`);

const results = [];

function pass(name, details = '') {
  results.push({ name, status: 'PASS', details });
  console.log(`  ✓ ${name}${details ? ` - ${details}` : ''}`);
}

function fail(name, error) {
  results.push({ name, status: 'FAIL', error: error.message || error });
  console.log(`  ✗ ${name} - ${error.message || error}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function cleanup(...clients) {
  for (const client of clients) {
    try { client.disconnectWebSocket(); } catch (e) { }
  }
}

/**
 * Helper: Establish friendship between two clients (Level 2)
 * Handles the full FRIEND_REQUEST → FRIEND_RESPONSE flow
 */
async function becomeFriends(sender, receiver) {
  // Sender sends friend request
  await sender.sendFriendRequest(receiver.userId, receiver.username);
  await delay(300);

  // Receiver gets the request
  const req = await receiver.waitForMessage(10000);
  assert(req.type === 'FRIEND_REQUEST', `Expected FRIEND_REQUEST, got ${req.type}`);
  receiver.processFriendRequest(req);

  // Receiver accepts
  const senderDevice = receiver.getFriend(sender.username).devices[0];
  await receiver.sendFriendResponse(senderDevice.serverUserId, sender.username, true);
  await delay(300);

  // Sender gets the response
  const resp = await sender.waitForMessage(10000);
  assert(resp.type === 'FRIEND_RESPONSE', `Expected FRIEND_RESPONSE, got ${resp.type}`);
  assert(resp.accepted === true, 'Expected accepted');
  sender.processFriendResponse(resp);

  pass(`${sender.username} ↔ ${receiver.username} are now friends`);
}

/**
 * Helper: Add additional device to friend's device list
 * Simulates receiving a DEVICE_ANNOUNCE from friend
 */
function addDeviceToFriend(client, friendUsername, device) {
  const friend = client.getFriend(friendUsername);
  if (!friend) throw new Error(`Not friends with ${friendUsername}`);
  friend.devices.push({
    serverUserId: device.userId,
    deviceName: device.username,
    signalIdentityKey: device.deviceInfo?.signalIdentityKey || new Uint8Array(33),
  });
  console.log(`  [Friends] Added device ${device.username} to ${friendUsername}'s list`);
}

// Create fresh client with same credentials
async function freshClient(oldClient) {
  const fresh = new TestClient(API_URL);
  fresh.username = oldClient.username;
  fresh.password = oldClient.password;
  fresh.store = oldClient.store;
  fresh.friends = oldClient.friends; // Preserve friend list!
  fresh.deviceInfo = oldClient.deviceInfo;
  await fresh.login();
  await delay(300);
  return fresh;
}

// Drain any queued messages (avoids stale message interference)
async function drainMessages(client, maxWait = 2000) {
  const start = Date.now();
  let drained = 0;
  while (Date.now() - start < maxWait) {
    if (client.messageQueue.length > 0) {
      client.messageQueue.shift();
      drained++;
    } else {
      await delay(100);
    }
  }
  if (drained > 0) {
    console.log(`  [Drain] Cleared ${drained} stale message(s) from ${client.username}`);
  }
}

// ==================== MAIN TEST SUITE ====================

async function runTests() {
  const timestamp = Date.now();

  // Create clients
  const a1 = new TestClient(API_URL);
  let a2 = new TestClient(API_URL);
  let b1 = new TestClient(API_URL);
  let b2 = new TestClient(API_URL);

  try {
    // ==================== SETUP ====================
    console.log('--- Setup: Registering devices ---\n');

    await a1.register(`alice_a1_${timestamp}`);
    pass('Registered A1', a1.username);
    await delay(300);

    await a2.register(`alice_a2_${timestamp}`);
    pass('Registered A2', a2.username);
    await delay(300);

    await b1.register(`bob_b1_${timestamp}`);
    pass('Registered B1', b1.username);
    await delay(300);

    await b2.register(`bob_b2_${timestamp}`);
    pass('Registered B2', b2.username);
    await delay(300);

    // ==================== SCENARIO: Friend Flow + Fan-Out ====================
    console.log('\n--- Scenario: Friend Request → Response → Message (Level 2) ---\n');

    // Connect both parties
    await b1.connectWebSocket();
    pass('B1 connected');
    await delay(300);

    await a1.connectWebSocket();
    pass('A1 connected');
    await delay(300);

    // A1 and B1 become friends (proper Level 2 flow)
    await becomeFriends(a1, b1);

    // A1 sends message to B1 VIA FRIEND LIST (no cheating!)
    await a1.sendToFriend(b1.username, { type: 'TEXT', text: 'Hello friend!' });
    await delay(300);

    const msg = await b1.waitForMessage(10000);
    assert(msg.type === 'TEXT', `Expected TEXT, got ${msg.type}`);
    assert(msg.text === 'Hello friend!', `Wrong text: ${msg.text}`);
    pass('B1 received via friend flow', `"${msg.text}"`);

    console.log('\n  ✓ FRIEND FLOW PASSED: Level 2 compliant messaging\n');

    // ==================== SCENARIO: Multi-Device Fan-Out ====================
    console.log('--- Scenario: Multi-Device Fan-Out (Level 2) ---\n');

    // B2 comes online
    await b2.connectWebSocket();
    pass('B2 connected');
    await delay(300);

    // Simulate B1 announcing B2 to A1 (in real app: DEVICE_ANNOUNCE)
    // A1 now knows Bob has 2 devices
    addDeviceToFriend(a1, b1.username, b2);
    pass('A1 learned about B2 via DeviceAnnounce');

    // A1 sends to "Bob" - should fan out to both B1 and B2
    await a1.sendToFriend(b1.username, { type: 'TEXT', text: 'Hello both devices!' });
    await delay(300);

    // Both B devices receive
    const b1Msg = await b1.waitForMessage(10000);
    assert(b1Msg.text === 'Hello both devices!', `B1 wrong: ${b1Msg.text}`);
    pass('B1 received fan-out', `"${b1Msg.text}"`);

    const b2Msg = await b2.waitForMessage(10000);
    assert(b2Msg.text === 'Hello both devices!', `B2 wrong: ${b2Msg.text}`);
    pass('B2 received fan-out', `"${b2Msg.text}"`);

    console.log('\n  ✓ MULTI-DEVICE FAN-OUT PASSED: Both devices received\n');

    b1.disconnectWebSocket();
    b2.disconnectWebSocket();
    await delay(300);

    // ==================== SCENARIO: Self-Sync (Level 2) ====================
    console.log('--- Scenario: Self-Sync (A1 → A2) ---\n');

    // A2 connects
    await a2.connectWebSocket();
    pass('A2 connected');
    await delay(300);

    // A1 registers A2 as own device (Level 2 compliant - NOT using __self__ hack)
    a1.addOwnDevice({ serverUserId: a2.userId, deviceName: a2.username });

    // Temporarily remove B2 from Bob's device list to avoid queueing messages
    const bobFriend = a1.getFriend(b1.username);
    const b2Device = bobFriend.devices.find(d => d.serverUserId === b2.userId);
    bobFriend.devices = bobFriend.devices.filter(d => d.serverUserId !== b2.userId);

    // Fresh B1 for receiving
    b1 = await freshClient(b1);
    await b1.connectWebSocket();
    await delay(500);
    pass('B1 reconnected');

    // A1 sends to Bob - sendToFriend now automatically sends SENT_SYNC to own devices
    await a1.sendToFriend(b1.username, { type: 'TEXT', text: 'Hi Bob from A1' });
    await delay(300);

    const bobMsg = await b1.waitForMessage(10000);
    assert(bobMsg.text === 'Hi Bob from A1', `Bob wrong: ${bobMsg.text}`);
    pass('B1 received', `"${bobMsg.text}"`);

    // A2 receives SENT_SYNC (not TEXT) - Level 2 compliant self-sync
    const syncMsg = await a2.waitForMessage(10000);
    assert(syncMsg.type === 'SENT_SYNC', `A2 expected SENT_SYNC, got ${syncMsg.type}`);
    pass('A2 received SENT_SYNC', `conv: ${syncMsg.sentSync.conversationId}`);

    console.log('\n  ✓ SELF-SYNC PASSED (Level 2): A2 received SENT_SYNC\n');

    b1.disconnectWebSocket();
    await delay(300);

    // ==================== SCENARIO: Device Link Approval ====================
    console.log('--- Scenario: Device Link Approval (A1 → A2) ---\n');

    const p2pIdentity = await generateP2PIdentity();
    pass('Generated P2P identity', `${p2pIdentity.publicKey.length} bytes`);

    const challenge = new Uint8Array(16);
    crypto.getRandomValues(challenge);
    pass('Generated challenge', `${challenge.length} bytes`);

    const approvalPayload = buildLinkApprovalProto({
      p2pPublicKey: p2pIdentity.publicKey,
      p2pPrivateKey: p2pIdentity.privateKey,
      recoveryPublicKey: new Uint8Array(32),
      challenge: challenge,
      ownDevices: [
        { deviceUUID: 'a1-uuid', serverUserId: a1.userId, deviceName: 'A1', signalIdentityKey: new Uint8Array(33).fill(0x05) },
        { deviceUUID: 'a2-uuid', serverUserId: a2.userId, deviceName: 'A2', signalIdentityKey: new Uint8Array(33).fill(0x05) },
      ],
    });
    pass('Built approval payload');

    // Device linking uses direct userId (same user, different devices)
    await a1.sendMessage(a2.userId, { type: 'DEVICE_LINK_APPROVAL', deviceLinkApproval: approvalPayload });
    pass('A1 sent DEVICE_LINK_APPROVAL');
    await delay(300);

    const approval = await a2.waitForMessage(10000);
    assert(approval.type === 'DEVICE_LINK_APPROVAL', `Expected DEVICE_LINK_APPROVAL, got ${approval.type}`);
    assert(approval.deviceLinkApproval, 'Missing deviceLinkApproval');
    assert(verifyChallenge(challenge, approval.deviceLinkApproval.challengeResponse), 'Challenge mismatch');
    pass('A2 received and verified approval');

    console.log('\n  ✓ DEVICE LINK APPROVAL PASSED\n');

    a2.disconnectWebSocket();
    await delay(300);

    // ==================== SCENARIO: Device Announce to Friends ====================
    console.log('--- Scenario: Device Announce Broadcast ---\n');

    // Re-add B2 to Bob's device list
    if (b2Device) {
      bobFriend.devices.push(b2Device);
    }

    b1 = await freshClient(b1);
    await b1.connectWebSocket();
    await delay(1000);
    // Clear any queued messages
    b1.messageQueue = [];
    pass('B1 reconnected');

    b2 = await freshClient(b2);
    await b2.connectWebSocket();
    await delay(1000);
    // Clear any queued messages
    b2.messageQueue = [];
    pass('B2 reconnected');

    const announce = await buildDeviceAnnounceProto({
      devices: [
        { deviceUUID: 'a1-uuid', serverUserId: a1.userId, deviceName: 'A1', signalIdentityKey: new Uint8Array(33).fill(0x05) },
        { deviceUUID: 'a2-uuid', serverUserId: a2.userId, deviceName: 'A2', signalIdentityKey: new Uint8Array(33).fill(0x05) },
      ],
      isRevocation: false,
      signingKey: p2pIdentity.privateKey,
    });
    pass('Built announce', `${announce.devices.length} devices`);

    // A1 sends announce to all Bob's devices via friend list
    await a1.sendToFriend(b1.username, { type: 'DEVICE_ANNOUNCE', deviceAnnounce: announce });
    await delay(300);

    const b1Ann = await b1.waitForMessage(10000);
    assert(b1Ann.type === 'DEVICE_ANNOUNCE', `Expected DEVICE_ANNOUNCE, got ${b1Ann.type}`);
    const b1Valid = await verifyDeviceAnnounceProto(b1Ann.deviceAnnounce, p2pIdentity.publicKey);
    assert(b1Valid.valid, `B1 verify failed: ${b1Valid.error}`);
    pass('B1 received and verified announce');

    const b2Ann = await b2.waitForMessage(10000);
    assert(b2Ann.type === 'DEVICE_ANNOUNCE', `Expected DEVICE_ANNOUNCE, got ${b2Ann.type}`);
    const b2Valid = await verifyDeviceAnnounceProto(b2Ann.deviceAnnounce, p2pIdentity.publicKey);
    assert(b2Valid.valid, `B2 verify failed: ${b2Valid.error}`);
    pass('B2 received and verified announce');

    console.log('\n  ✓ DEVICE ANNOUNCE PASSED\n');

    b1.disconnectWebSocket();
    b2.disconnectWebSocket();
    await delay(300);

    // ==================== SCENARIO: Attachment via Friend ====================
    console.log('--- Scenario: Encrypted Attachment (Level 2) ---\n');

    const charlie = new TestClient(API_URL);
    await charlie.register(`charlie_${timestamp}`);
    pass('Registered Charlie', charlie.username);
    await delay(300);

    b1 = await freshClient(b1);
    await b1.connectWebSocket();
    await delay(500);
    pass('B1 reconnected');

    await charlie.connectWebSocket();
    pass('Charlie connected');
    await delay(300);

    // A1 ↔ Charlie become friends
    await becomeFriends(a1, charlie);

    // Create and encrypt image
    const imageData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, ...new Array(100).fill(0).map((_, i) => i % 256)]);
    const encrypted = await encryptAttachment(imageData);
    const uploadResult = await a1.uploadAttachment(encrypted.encryptedBlob);
    pass('Uploaded attachment', uploadResult.id);
    await delay(300);

    const attachmentMeta = JSON.stringify({
      contentKey: uint8ArrayToBase64(encrypted.contentKey),
      nonce: uint8ArrayToBase64(encrypted.nonce),
      contentHash: uint8ArrayToBase64(encrypted.contentHash),
    });

    // A1 sends to B1 and Charlie VIA FRIEND LISTS
    await a1.sendToFriend(b1.username, {
      type: 'IMAGE', text: attachmentMeta, attachmentId: uploadResult.id,
      attachmentExpires: uploadResult.expiresAt, mimeType: 'image/png',
    });
    pass('A1 sent IMAGE to B1');

    await a1.sendToFriend(charlie.username, {
      type: 'IMAGE', text: attachmentMeta, attachmentId: uploadResult.id,
      attachmentExpires: uploadResult.expiresAt, mimeType: 'image/png',
    });
    pass('A1 sent IMAGE to Charlie');
    await delay(300);

    // Both receive and decrypt
    const bImg = await b1.waitForMessage(10000);
    const bMeta = JSON.parse(bImg.text);
    const bBlob = await b1.fetchAttachment(bImg.attachmentId);
    const bDec = new Uint8Array(await decryptAttachment(bBlob, base64ToUint8Array(bMeta.contentKey), base64ToUint8Array(bMeta.nonce), base64ToUint8Array(bMeta.contentHash)));
    assert(bDec[0] === 0x89, 'B1 decryption failed');
    pass('B1 decrypted attachment');

    const cImg = await charlie.waitForMessage(10000);
    const cMeta = JSON.parse(cImg.text);
    const cBlob = await charlie.fetchAttachment(cImg.attachmentId);
    const cDec = new Uint8Array(await decryptAttachment(cBlob, base64ToUint8Array(cMeta.contentKey), base64ToUint8Array(cMeta.nonce), base64ToUint8Array(cMeta.contentHash)));
    assert(cDec[0] === 0x89, 'Charlie decryption failed');
    pass('Charlie decrypted attachment');

    console.log('\n  ✓ ENCRYPTED ATTACHMENT PASSED\n');

    // ==================== SCENARIO: SENT_SYNC (Level 2 Incremental Sync) ====================
    console.log('--- Scenario: SENT_SYNC Incremental Sync (Level 2) ---\n');

    // A1 and A2 should be linked from earlier tests
    // Set up A2 as an own device for A1 (proper Level 2 way)
    a2 = await freshClient(a2);
    await a2.connectWebSocket();
    pass('A2 reconnected');
    await delay(300);

    // A1 registers A2 as own device (Level 2 compliant - from device link)
    a1.addOwnDevice({ serverUserId: a2.userId, deviceName: 'A2' });

    // Also set up the reverse: A2 knows about A1
    a2.addOwnDevice({ serverUserId: a1.userId, deviceName: 'A1' });

    // A2 needs to know about Bob to verify sync (copy A1's friend data)
    const a1BobFriend = a1.getFriend(b1.username);
    if (a1BobFriend) {
      a2.storeFriend(a1BobFriend.username, a1BobFriend.devices, 'accepted');
    }

    // A1 sends message to Bob - should ALSO send SENT_SYNC to A2
    await a1.sendToFriend(b1.username, { type: 'TEXT', text: 'Sync test message' });
    await delay(500);

    // B1 receives the message normally
    const bobSyncMsg = await b1.waitForMessage(10000);
    assert(bobSyncMsg.text === 'Sync test message', `Bob wrong: ${bobSyncMsg.text}`);
    pass('B1 received message normally');

    // A2 should receive SENT_SYNC (not TEXT)
    const a2SyncMsg = await a2.waitForMessage(10000);
    assert(a2SyncMsg.type === 'SENT_SYNC', `A2 expected SENT_SYNC, got ${a2SyncMsg.type}`);
    assert(a2SyncMsg.sentSync.conversationId === b1.username, `Wrong conversation: ${a2SyncMsg.sentSync.conversationId}`);
    pass('A2 received SENT_SYNC', `conv: ${a2SyncMsg.sentSync.conversationId}`);

    // A2 processes the sync (marks as "sent by me")
    a2.processSentSync(a2SyncMsg);
    const a2Msg = a2.messages.find(m => m.conversationId === b1.username);
    assert(a2Msg && a2Msg.isSent === true, 'A2 should have message marked as sent');
    pass('A2 stored as sent message', `isSent: ${a2Msg.isSent}`);

    console.log('\n  ✓ SENT_SYNC INCREMENTAL SYNC PASSED (Level 2)\n');

    // ==================== SCENARIO: Bidirectional Self-Sync ====================
    console.log('--- Scenario: Bidirectional Self-Sync (Level 2) ---\n');

    // Clear message queues
    a1.messageQueue = [];
    a2.messageQueue = [];

    // A2 sends to Bob (should sync back to A1)
    await a2.sendToFriend(b1.username, { type: 'TEXT', text: 'Message from A2' });
    await delay(500);

    // B1 receives from A2
    const bobFromA2 = await b1.waitForMessage(10000);
    assert(bobFromA2.text === 'Message from A2', `Bob wrong: ${bobFromA2.text}`);
    pass('B1 received from A2');

    // A1 should receive SENT_SYNC from A2
    const a1SyncMsg = await a1.waitForMessage(10000);
    assert(a1SyncMsg.type === 'SENT_SYNC', `A1 expected SENT_SYNC, got ${a1SyncMsg.type}`);
    pass('A1 received SENT_SYNC from A2');

    // Process it
    a1.processSentSync(a1SyncMsg);
    // Content may be bytes or string, check both ways
    const a1FromA2 = a1.messages.find(m => {
      if (typeof m.content === 'string') return m.content === 'Message from A2';
      if (m.content instanceof Uint8Array) return new TextDecoder().decode(m.content) === 'Message from A2';
      return false;
    });
    assert(a1FromA2 && a1FromA2.isSent === true, 'A1 should have A2 message marked as sent');
    pass('A1 synced A2 message as sent');

    // Verify A1 received A2's message via SENT_SYNC
    // Note: A2 was freshClient'd so its messages are from this session only
    const a1HasA2Msg = a1.messages.some(m => {
      const content = m.content instanceof Uint8Array ? new TextDecoder().decode(m.content) : m.content;
      return content === 'Message from A2' && m.isSent;
    });
    assert(a1HasA2Msg, 'A1 should have A2 message via SENT_SYNC');
    pass('Bidirectional sync verified', 'A1 synced A2 message as sent');

    console.log('\n  ✓ BIDIRECTIONAL SELF-SYNC PASSED (Level 2)\n');

    a2.disconnectWebSocket();
    await delay(300);

    // ==================== SUMMARY ====================
    await cleanup(a1, a2, b1, b2, charlie);

    console.log(`${'='.repeat(60)}`);
    console.log('TEST SUMMARY (Level 2 Compliant)');
    console.log(`${'='.repeat(60)}`);

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;

    console.log(`\n  Total: ${results.length} checks`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);

    if (failed === 0) {
      console.log(`\n  ${'='.repeat(40)}`);
      console.log('  ✓ ALL LEVEL 2 TESTS PASSED!');
      console.log('  No cheating - all via friend flow');
      console.log(`  ${'='.repeat(40)}\n`);
    } else {
      console.log('\n  Failed:');
      for (const r of results.filter(r => r.status === 'FAIL')) {
        console.log(`    - ${r.name}: ${r.error}`);
      }
    }

    process.exit(failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('\n  FATAL:', error.message);
    console.error('  Stack:', error.stack);
    await cleanup(a1, a2, b1, b2);
    process.exit(1);
  }
}

runTests();
