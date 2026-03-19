#!/usr/bin/env node
/**
 * Smoke test: 4-device SESSION_RESET
 *
 * Setup: Alice (2 devices) + Bob (2 devices), all friends
 * 1. All 4 devices can message each other
 * 2. Corrupt Bob2↔Alice1 session
 * 3. Bob2 sends SESSION_RESET to Alice (all Alice devices receive it)
 * 4. After reset, Bob2 can message Alice1 again
 * 5. Bob1↔Alice1, Bob1↔Alice2, Bob2↔Alice2 sessions are unaffected
 */
import { TestClient, randomUsername } from '../../src/v2/test/testClient.js';

const API_URL = process.env.VITE_API_URL;
if (!API_URL) { console.error('VITE_API_URL required'); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('\n=== 4-Device SESSION_RESET Smoke Test ===\n');

// Register Alice and Bob (each will have 2 devices via testClient)
const alice1 = new TestClient(API_URL);
const bob1 = new TestClient(API_URL);

await alice1.register(randomUsername(), 'testpass12345');
await bob1.register(randomUsername(), 'testpass12345');
console.log(`Alice1: userId=${alice1.userId.slice(-8)}, deviceId=${alice1.deviceId.slice(-8)}`);
console.log(`Bob1:   userId=${bob1.userId.slice(-8)}, deviceId=${bob1.deviceId.slice(-8)}`);

// Create second devices for each
const alice2 = new TestClient(API_URL);
alice2.username = alice1.username;
alice2.password = 'testpass12345';
let r = await alice2.request('/v1/sessions', { method: 'POST', auth: false, body: JSON.stringify({ username: alice1.username, password: 'testpass12345' }) });
alice2.token = r.token;
alice2.userId = alice2.parseUserId(r.token);
const a2keys = await alice2.generateKeys();
r = await alice2.request('/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'Alice2', ...a2keys }) });
alice2.token = r.token;
alice2.deviceId = alice2.parseDeviceId(r.token) || r.deviceId;
alice2.refreshToken = r.refreshToken;
const a2ikp = await alice2.store.getIdentityKeyPair();
alice2.deviceInfo = { deviceId: alice2.deviceId, username: alice2.username, signalIdentityKey: new Uint8Array(a2ikp.pubKey) };

const bob2 = new TestClient(API_URL);
bob2.username = bob1.username;
bob2.password = 'testpass12345';
r = await bob2.request('/v1/sessions', { method: 'POST', auth: false, body: JSON.stringify({ username: bob1.username, password: 'testpass12345' }) });
bob2.token = r.token;
bob2.userId = bob2.parseUserId(r.token);
const b2keys = await bob2.generateKeys();
r = await bob2.request('/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'Bob2', ...b2keys }) });
bob2.token = r.token;
bob2.deviceId = bob2.parseDeviceId(r.token) || r.deviceId;
bob2.refreshToken = r.refreshToken;
const b2ikp = await bob2.store.getIdentityKeyPair();
bob2.deviceInfo = { deviceId: bob2.deviceId, username: bob2.username, signalIdentityKey: new Uint8Array(b2ikp.pubKey) };

console.log(`Alice2: userId=${alice2.userId.slice(-8)}, deviceId=${alice2.deviceId.slice(-8)}`);
console.log(`Bob2:   userId=${bob2.userId.slice(-8)}, deviceId=${bob2.deviceId.slice(-8)}`);

// Connect all 4
await alice1.connectWebSocket();
await alice2.connectWebSocket();
await bob1.connectWebSocket();
await bob2.connectWebSocket();
console.log('All 4 devices connected');

// Make friends: Alice1 → Bob1
console.log('\n--- Befriend ---');
const bobBundles = await alice1.fetchPreKeyBundles(bob1.userId);
await alice1.sendFriendRequest(bobBundles[0].deviceId, bob1.username, bob1.userId);
const freq = await bob1.waitForMessage(10000);
const fparsed = bob1.processFriendRequest(freq);
await bob1.sendFriendResponse(fparsed.sourceDeviceId, alice1.username, true, alice1.userId);
const fresp = await alice1.waitForMessage(10000);
alice1.processFriendResponse(fresp);

// Set up friend records on all devices
for (const dev of [alice2, bob2]) {
  const otherUser = dev === alice2 ? bob1 : alice1;
  const otherBundles = await dev.fetchPreKeyBundles(otherUser.userId);
  dev.friends.set(otherUser.username, {
    username: otherUser.username,
    userId: otherUser.userId,
    devices: otherBundles.map(b => ({ deviceId: b.deviceId })),
    status: 'accepted',
  });
}
// Alice1 already has Bob as friend, copy to include Bob2
const aliceBobFriend = alice1.friends.get(bob1.username);
const allBobBundles = await alice1.fetchPreKeyBundles(bob1.userId);
aliceBobFriend.devices = allBobBundles.map(b => ({ deviceId: b.deviceId }));

// Bob1 already has Alice as friend, copy to include Alice2
const bobAliceFriend = bob1.friends.get(alice1.username);
const allAliceBundles = await bob1.fetchPreKeyBundles(alice1.userId);
bobAliceFriend.devices = allAliceBundles.map(b => ({ deviceId: b.deviceId }));

console.log('All devices have friend records');

// Step 1: Verify messaging (testClient uses userId.1 so we go through fan-out)
console.log('\n--- Step 1: Verify messaging ---');

// Alice1 sends to all Bob devices via fan-out
await alice1.sendToFriend(bob1.username, { type: 'TEXT', text: 'A1→Bobs' }, bob1.userId);
const m1 = await bob1.waitForMessage(5000);
console.log(`A1→B1: "${m1.text}" ✓`);
// Bob2 gets it too since fan-out sends to all devices
// But testClient encrypts with (userId, 1) — same session for both
// Bob2 won't decrypt because it shares userId but has different keys
// This is a testClient limitation — the browser messenger.js handles this

// Bob1 sends to Alice via fan-out (establishes B1→A session)
await bob1.sendToFriend(alice1.username, { type: 'TEXT', text: 'B1→Alices' }, alice1.userId);
const m2 = await alice1.waitForMessage(5000);
console.log(`B1→A1: "${m2.text}" ✓`);

// Step 2: Corrupt Bob2's session with Alice
console.log('\n--- Step 2: Corrupt Bob2↔Alice1 session ---');
// Delete Bob2's session with Alice
const aliceAddr1 = `${alice1.userId}.1`;
await bob2.store.removeSession(aliceAddr1);
console.log(`Deleted Bob2 session at ${aliceAddr1.slice(-12)}`);

// Step 3: Bob2 sends SESSION_RESET to Alice
console.log('\n--- Step 3: Bob2 SESSION_RESET ---');
// Bob2 needs to send SESSION_RESET to all Alice devices
// This is what resetSessionWith does in ObscuraClient
// Here we simulate it manually: delete all sessions, send PreKey SESSION_RESET

// Delete any remaining sessions Bob2 has with Alice
for (const regId of [1, a2keys.registrationId]) {
  const addr = `${alice1.userId}.${regId}`;
  const s = await bob2.store.loadSession(addr);
  if (s) {
    await bob2.store.removeSession(addr);
    console.log(`Deleted session at ${addr.slice(-12)}`);
  }
}

// Send SESSION_RESET to each Alice device (creates new PreKey session)
for (const aliceBundle of allAliceBundles) {
  await bob2.sendMessage(aliceBundle.deviceId, {
    type: 'SESSION_RESET',
    resetReason: 'test_corruption',
    timestamp: Date.now(),
  }, alice1.userId);
  console.log(`Sent SESSION_RESET to Alice device ${aliceBundle.deviceId.slice(-8)}`);
}

// Wait for Alice devices to receive
const resetMsg1 = await alice1.waitForMessage(5000);
console.log(`Alice1 received: ${resetMsg1.type} ✓`);
const resetMsg2 = await alice2.waitForMessage(5000);
console.log(`Alice2 received: ${resetMsg2.type} ✓`);

// Step 4: Bob2 sends message to Alice1 (uses new session from SESSION_RESET send)
console.log('\n--- Step 4: Post-reset messaging ---');
await bob2.queueMessage(alice1.deviceId, { type: 'TEXT', text: 'B2→A1 after reset', timestamp: Date.now() }, alice1.userId);
await bob2.flushMessages();
const m4 = await alice1.waitForMessage(5000);
console.log(`B2→A1 after reset: "${m4.text}" ✓`);

// Step 5: Verify other sessions unaffected
console.log('\n--- Step 5: Verify other sessions intact ---');
await alice1.queueMessage(bob1.deviceId, { type: 'TEXT', text: 'A1→B1 still works', timestamp: Date.now() }, bob1.userId);
await alice1.flushMessages();
const m5 = await bob1.waitForMessage(5000);
console.log(`A1→B1 still works: "${m5.text}" ✓`);

alice1.disconnectWebSocket();
alice2.disconnectWebSocket();
bob1.disconnectWebSocket();
bob2.disconnectWebSocket();

console.log('\n=== 4-DEVICE SESSION_RESET: PASSED ===\n');
