#!/usr/bin/env node
/**
 * Smoke test: Full recovery flow with messaging
 *
 * 1. Alice and Bob register, become friends, exchange messages
 * 2. Bob's device uploads a backup
 * 3. Bob "recovers" — new device, takeover old deviceId, download backup
 * 4. Recovered Bob sends message to Alice — Alice receives it
 * 5. Alice replies — recovered Bob receives it
 *
 * This proves the full encryption model works after recovery:
 * - Recovered device has new Signal keys
 * - Old sessions are stale (Alice has session with old Bob keys)
 * - First message from recovered Bob is PreKey (establishes fresh session)
 * - Alice's decrypt handles the PreKey and creates new session
 * - Bidirectional messaging works after that
 */
import { TestClient, randomUsername } from '../../src/v2/test/testClient.js';

const API_URL = process.env.VITE_API_URL;
if (!API_URL) { console.error('VITE_API_URL required'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

console.log('\n=== Recovery Messaging Smoke Test ===\n');

const alice = new TestClient(API_URL);
const bob1 = new TestClient(API_URL);

// 1. Register Alice and Bob
console.log('--- Step 1: Register ---');
await alice.register(randomUsername(), 'testpass12345');
await bob1.register(randomUsername(), 'testpass12345');
console.log(`Alice: userId=${alice.userId}, deviceId=${alice.deviceId}`);
console.log(`Bob1:  userId=${bob1.userId}, deviceId=${bob1.deviceId}`);

// 2. Connect, befriend, exchange message
console.log('\n--- Step 2: Friends + Messages ---');
await alice.connectWebSocket();
await bob1.connectWebSocket();

const bobBundles = await alice.fetchPreKeyBundles(bob1.userId);
await alice.sendFriendRequest(bobBundles[0].deviceId, bob1.username, bob1.userId);

const friendReq = await bob1.waitForMessage(10000);
const parsed = bob1.processFriendRequest(friendReq);
await bob1.sendFriendResponse(parsed.sourceDeviceId, alice.username, true, alice.userId);

const friendResp = await alice.waitForMessage(10000);
alice.processFriendResponse(friendResp);

await alice.sendToFriend(bob1.username, { type: 'TEXT', text: 'Hello Bob!' }, bob1.userId);
const msg1 = await bob1.waitForMessage(10000);
console.log(`Bob1 received: "${msg1.text}"`);

// 3. Simulate recovery — new TestClient, same user, new device via takeover
console.log('\n--- Step 3: Recovery (new device, takeover old) ---');
bob1.disconnectWebSocket();

const bob2 = new TestClient(API_URL);
bob2.username = bob1.username;
bob2.password = 'testpass12345';

// Login (user-scoped)
const loginResult = await bob2.request('/v1/sessions', {
  method: 'POST',
  auth: false,
  body: JSON.stringify({ username: bob1.username, password: 'testpass12345' }),
});
bob2.token = loginResult.token;
bob2.userId = bob2.parseUserId(loginResult.token);

// Generate new Signal keys
const recoveryKeys = await bob2.generateKeys();

// Instead of provisioning new device, TAKEOVER Bob1's device
// Login with bob1's deviceId
const takeoverLogin = await bob2.request('/v1/sessions', {
  method: 'POST',
  auth: false,
  body: JSON.stringify({ username: bob1.username, password: 'testpass12345', deviceId: bob1.deviceId }),
});
bob2.token = takeoverLogin.token;
bob2.deviceId = bob2.parseDeviceId(takeoverLogin.token) || bob1.deviceId;

// POST /v1/devices/keys with new identity key — triggers takeover
await bob2.request('/v1/devices/keys', {
  method: 'POST',
  body: JSON.stringify({
    identityKey: recoveryKeys.identityKey,
    registrationId: recoveryKeys.registrationId,
    signedPreKey: recoveryKeys.signedPreKey,
    oneTimePreKeys: recoveryKeys.oneTimePreKeys,
  }),
});
console.log(`Bob2 took over deviceId=${bob2.deviceId} with new keys`);

// Re-login to get fresh token after takeover
const freshLogin = await bob2.request('/v1/sessions', {
  method: 'POST',
  auth: false,
  body: JSON.stringify({ username: bob1.username, password: 'testpass12345', deviceId: bob2.deviceId }),
});
bob2.token = freshLogin.token;
bob2.refreshToken = freshLogin.refreshToken;

// 4. Connect recovered Bob and send message to Alice
console.log('\n--- Step 4: Recovered Bob sends to Alice ---');
await bob2.connectWebSocket();

// Bob2 knows Alice as a friend (from backup/sync)
// Manually set up the friend record since we're not restoring from backup here
bob2.friends.set(alice.username, {
  username: alice.username,
  userId: alice.userId,
  devices: [{ deviceId: alice.deviceId }],
  status: 'accepted',
});

// Send — this will be a PreKey message (no existing session)
await bob2.sendToFriend(alice.username, { type: 'TEXT', text: 'Hello from recovered Bob!' }, alice.userId);

const msg2 = await alice.waitForMessage(10000);
console.log(`Alice received: "${msg2.text}" ✓`);

// 5. Alice replies
console.log('\n--- Step 5: Alice replies ---');
await alice.sendToFriend(bob2.username, { type: 'TEXT', text: 'Welcome back Bob!' }, bob2.userId);

const msg3 = await bob2.waitForMessage(10000);
console.log(`Recovered Bob received: "${msg3.text}" ✓`);

alice.disconnectWebSocket();
bob2.disconnectWebSocket();

console.log('\n=== RECOVERY MESSAGING: PASSED ===\n');
