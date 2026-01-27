#!/usr/bin/env node
/**
 * E2E Friend Request/Response Test (Level 2 Compliant)
 * Tests the proper friend flow: request → response → then can message
 *
 * Run: source .env && node src/v2/test/e2e-friends.js
 */

import { TestClient } from './testClient.js';

const API_URL = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API_URL) {
  console.error('Error: VITE_API_URL environment variable is required');
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
console.log('E2E FRIEND FLOW TEST (Level 2)');
console.log(`Server: ${API_URL}`);
console.log(`${'='.repeat(60)}\n`);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function runTest() {
  const timestamp = Date.now();
  const alice = new TestClient(API_URL);
  const bob = new TestClient(API_URL);

  try {
    // === SETUP ===
    console.log('--- Setup: Register Alice and Bob ---\n');

    await alice.register(`alice_${timestamp}`);
    console.log(`  ✓ Alice registered: ${alice.username} (${alice.userId})`);
    await delay(300);

    await bob.register(`bob_${timestamp}`);
    console.log(`  ✓ Bob registered: ${bob.username} (${bob.userId})`);
    await delay(300);

    // === FRIEND REQUEST FLOW ===
    console.log('\n--- Scenario: Friend Request/Response Flow ---\n');

    // Bob connects WebSocket to receive friend request
    await bob.connectWebSocket();
    console.log('  ✓ Bob connected to WebSocket');
    await delay(300);

    // Alice sends friend request to Bob
    // Note: In real app, Alice would discover Bob's userId through some mechanism
    // For testing, we simulate the "out-of-band" discovery
    await alice.sendFriendRequest(bob.userId, bob.username);
    console.log('  ✓ Alice sent FRIEND_REQUEST to Bob');
    await delay(300);

    // Bob receives friend request
    const friendReq = await bob.waitForMessage(10000);
    assert(friendReq.type === 'FRIEND_REQUEST', `Expected FRIEND_REQUEST, got ${friendReq.type}`);
    console.log(`  ✓ Bob received FRIEND_REQUEST from "${friendReq.username}"`);

    // Bob processes the friend request (stores sender's devices)
    const reqInfo = bob.processFriendRequest(friendReq);
    assert(reqInfo.username === alice.username, 'Username mismatch');
    assert(reqInfo.devices.length > 0, 'No devices in friend request');
    console.log(`  ✓ Bob processed request: ${reqInfo.devices.length} device(s)`);

    // Alice connects to receive Bob's response
    await alice.connectWebSocket();
    console.log('  ✓ Alice connected to WebSocket');
    await delay(300);

    // Bob accepts the friend request
    await bob.sendFriendResponse(reqInfo.devices[0].serverUserId, alice.username, true);
    console.log('  ✓ Bob sent FRIEND_RESPONSE (accepted)');
    await delay(300);

    // Alice receives the response
    const friendResp = await alice.waitForMessage(10000);
    assert(friendResp.type === 'FRIEND_RESPONSE', `Expected FRIEND_RESPONSE, got ${friendResp.type}`);
    assert(friendResp.accepted === true, 'Expected accepted=true');
    console.log(`  ✓ Alice received FRIEND_RESPONSE (accepted=${friendResp.accepted})`);

    // Alice processes the response (stores Bob's devices)
    const respInfo = alice.processFriendResponse(friendResp);
    assert(respInfo.accepted === true, 'Expected accepted');
    assert(alice.isFriendsWith(bob.username), 'Alice should be friends with Bob');
    console.log(`  ✓ Alice processed response: now friends with ${bob.username}`);

    // Verify Bob is also friends with Alice
    assert(bob.isFriendsWith(alice.username), 'Bob should be friends with Alice');
    console.log(`  ✓ Bob is friends with ${alice.username}`);

    // === MESSAGING VIA FRIEND (Level 2 - no cheating!) ===
    console.log('\n--- Scenario: Message via Friend (Level 2) ---\n');

    // Alice sends message to Bob using friend device list (NOT hardcoded userId)
    await alice.sendToFriend(bob.username, { type: 'TEXT', text: 'Hello Bob, we are friends now!' });
    console.log('  ✓ Alice sent TEXT to Bob via friend list');
    await delay(300);

    // Bob receives the message
    const msg = await bob.waitForMessage(10000);
    assert(msg.type === 'TEXT', `Expected TEXT, got ${msg.type}`);
    assert(msg.text === 'Hello Bob, we are friends now!', `Wrong message: ${msg.text}`);
    console.log(`  ✓ Bob received: "${msg.text}"`);

    // Try sending without being friends (should fail)
    console.log('\n--- Verify: Cannot send to non-friend ---\n');
    try {
      await alice.sendToFriend('unknown_user', { type: 'TEXT', text: 'test' });
      throw new Error('Should have failed!');
    } catch (e) {
      if (e.message.includes('Not friends with')) {
        console.log(`  ✓ Correctly rejected: "${e.message}"`);
      } else {
        throw e;
      }
    }

    // === SUMMARY ===
    console.log(`\n${'='.repeat(60)}`);
    console.log('  ✓ ALL LEVEL 2 FRIEND TESTS PASSED!');
    console.log(`${'='.repeat(60)}\n`);

    alice.disconnectWebSocket();
    bob.disconnectWebSocket();
    process.exit(0);

  } catch (error) {
    console.error('\n  ✗ FAILED:', error.message);
    console.error('  Stack:', error.stack);
    alice.disconnectWebSocket();
    bob.disconnectWebSocket();
    process.exit(1);
  }
}

runTest();
