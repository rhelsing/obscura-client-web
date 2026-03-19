#!/usr/bin/env node
/**
 * E2E smoke test: Two users register, befriend, exchange messages via new API
 * Tests the updated testClient against the v0.8.0 server.
 *
 * Run: VITE_API_URL=https://dev.obscura.barrelmaker.dev node test/smoke/test-new-api-e2e.js
 */

import { TestClient, randomUsername } from '../../src/v2/test/testClient.js';

const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: VITE_API_URL or OBSCURA_API_URL required');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log(`\n=== E2E Smoke Test: testClient with new API ===`);
console.log(`Server: ${API_URL}\n`);

const alice = new TestClient(API_URL);
const bob = new TestClient(API_URL);

try {
  // 1. Register both users
  console.log('--- Step 1: Register Alice & Bob ---');
  await alice.register(randomUsername(), 'testpass12345');
  console.log(`  Alice: userId=${alice.userId}, deviceId=${alice.deviceId}`);

  await bob.register(randomUsername(), 'testpass12345');
  console.log(`  Bob: userId=${bob.userId}, deviceId=${bob.deviceId}`);

  // 2. Connect WebSocket (ticket auth)
  console.log('\n--- Step 2: Connect WebSockets ---');
  await alice.connectWebSocket();
  await bob.connectWebSocket();

  // 3. Alice sends friend request to Bob's device
  console.log('\n--- Step 3: Friend request ---');

  // Alice needs Bob's deviceId to send. In the new API, she fetches Bob's prekey bundles.
  const bobBundles = await alice.fetchPreKeyBundles(bob.userId);
  console.log(`  Alice fetched ${bobBundles.length} bundle(s) for Bob`);
  const bobDeviceId = bobBundles[0].deviceId;
  console.log(`  Bob's deviceId: ${bobDeviceId}`);

  await alice.sendFriendRequest(bobDeviceId, bob.username, bob.userId);

  // 4. Bob receives and accepts
  console.log('\n--- Step 4: Bob accepts ---');
  const friendReq = await bob.waitForMessage(10000);
  console.log(`  Bob received: ${friendReq.type} from ${friendReq.username}`);

  if (friendReq.type !== 'FRIEND_REQUEST') {
    throw new Error(`Expected FRIEND_REQUEST, got ${friendReq.type}`);
  }

  const parsed = bob.processFriendRequest(friendReq);

  // Bob needs Alice's deviceId — it's in the device announce
  const aliceDeviceId = parsed.devices?.[0]?.deviceId || parsed.sourceDeviceId;
  console.log(`  Alice's deviceId from announce: ${aliceDeviceId}`);

  await bob.sendFriendResponse(aliceDeviceId, alice.username, true, alice.userId);

  // 5. Alice receives response
  console.log('\n--- Step 5: Alice receives response ---');
  const friendResp = await alice.waitForMessage(10000);
  console.log(`  Alice received: ${friendResp.type} accepted=${friendResp.accepted}`);

  if (friendResp.type !== 'FRIEND_RESPONSE') {
    throw new Error(`Expected FRIEND_RESPONSE, got ${friendResp.type}`);
  }

  alice.processFriendResponse(friendResp);

  console.log(`  Alice friends with Bob: ${alice.isFriendsWith(bob.username)}`);
  console.log(`  Bob friends with Alice: ${bob.isFriendsWith(alice.username)}`);

  if (!alice.isFriendsWith(bob.username) || !bob.isFriendsWith(alice.username)) {
    throw new Error('Friendship not established!');
  }

  // 6. Alice sends a text message to Bob
  console.log('\n--- Step 6: Alice sends message ---');
  await alice.sendToFriend(bob.username, {
    type: 'TEXT',
    text: 'Hello from Alice via new API!',
  }, bob.userId);

  // 7. Bob receives
  console.log('\n--- Step 7: Bob receives message ---');
  const textMsg = await bob.waitForMessage(10000);
  console.log(`  Bob received: ${textMsg.type} text="${textMsg.text}"`);

  if (textMsg.type !== 'TEXT' || textMsg.text !== 'Hello from Alice via new API!') {
    throw new Error(`Unexpected message: ${textMsg.type} "${textMsg.text}"`);
  }

  // 8. Bob replies
  console.log('\n--- Step 8: Bob replies ---');
  await bob.sendToFriend(alice.username, {
    type: 'TEXT',
    text: 'Hello back from Bob!',
  }, alice.userId);

  const replyMsg = await alice.waitForMessage(10000);
  console.log(`  Alice received: ${replyMsg.type} text="${replyMsg.text}"`);

  if (replyMsg.type !== 'TEXT' || replyMsg.text !== 'Hello back from Bob!') {
    throw new Error(`Unexpected reply: ${replyMsg.type} "${replyMsg.text}"`);
  }

  // 9. Cleanup
  alice.disconnectWebSocket();
  bob.disconnectWebSocket();

  console.log('\n=== ALL E2E SMOKE TESTS PASSED ===\n');
} catch (err) {
  console.error('\n✗ FAILED:', err.message);
  console.error(err.stack);
  alice.disconnectWebSocket();
  bob.disconnectWebSocket();
  process.exit(1);
}
