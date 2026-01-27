#!/usr/bin/env node
/**
 * E2E Tests using clean Obscura API
 * Run: source .env && node src/v2/test/e2e-clean.js
 */
import '../../../test/helpers/setup.js'; // Polyfills for Node.js
import { Obscura } from '../lib/index.js';

const API = process.env.VITE_API_URL || process.env.OBSCURA_API_URL;
if (!API) {
  console.error('Error: VITE_API_URL required');
  process.exit(1);
}

const ts = Date.now();

// Test helper: wrap on() in a promise for sequential tests
const once = (client, event, ms = 15000) => new Promise((ok, fail) => {
  const t = setTimeout(() => {
    client.off(event, handler);
    fail(new Error(`Timeout: ${event}`));
  }, ms);
  const handler = (data) => {
    clearTimeout(t);
    client.off(event, handler);
    ok(data);
  };
  client.on(event, handler);
});

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const ok = (name) => console.log(`  ✓ ${name}`);

async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log('OBSCURA CLEAN API E2E TESTS');
  console.log(`Server: ${API}`);
  console.log(`${'='.repeat(50)}\n`);

  // --- Registration ---
  const alice = await Obscura.register(`alice_${ts}`, 'pass', { apiUrl: API });
  const phrase = alice.getRecoveryPhrase();
  if (!phrase || phrase.split(' ').length !== 12) throw new Error('Bad phrase');
  ok('Register alice + recovery phrase');
  await delay(300);

  const bob = await Obscura.register(`bob_${ts}`, 'pass', { apiUrl: API });
  ok('Register bob');
  await delay(300);

  // --- Login existing ---
  const r = await Obscura.login(`alice_${ts}`, 'pass', { apiUrl: API, store: alice.store });
  if (r.status !== 'ok') throw new Error(`Login failed: ${r.reason}`);
  ok('Login existing device');
  await delay(300);

  // --- Friend flow ---
  await alice.connect();
  await bob.connect();
  ok('Connected');
  await delay(300);

  // Register handlers BEFORE sending to avoid race
  const reqPromise = once(bob, 'friendRequest');
  const respPromise = once(alice, 'friendResponse');

  await alice.befriend(bob.userId, bob.username);
  const req = await reqPromise;
  await req.accept();
  await delay(300);

  const resp = await respPromise;
  if (!resp.accepted) throw new Error('Not accepted');
  ok('Friend flow');
  await delay(300);

  // --- Message ---
  await alice.send(bob.username, { text: 'Hello!' });
  const msg = await once(bob, 'message');
  if (msg.text !== 'Hello!') throw new Error(`Wrong text: ${msg.text}`);
  ok('Send message');
  await delay(300);

  // --- Multi-device ---
  const loginResult = await Obscura.login(`bob_${ts}`, 'pass', { apiUrl: API });
  if (loginResult.status !== 'newDevice') throw new Error('Expected newDevice');
  const bob2 = loginResult.client;
  await bob2.connect();
  await delay(300);

  // bob2 should receive linkApproval AND syncBlob
  const approvalPromise = once(bob2, 'linkApproval');
  const syncPromise = once(bob2, 'syncBlob');
  await bob.approveLink(bob2.linkCode);
  const approval = await approvalPromise;
  approval.apply();
  await syncPromise;  // Wait for sync to arrive and be processed
  await delay(300);

  // Verify bob2 now has alice as a friend (synced from bob)
  const bob2Alice = bob2.friends.get(alice.username);
  if (!bob2Alice) throw new Error('bob2 should have alice as friend after sync');
  if (bob2Alice.status !== 'accepted') throw new Error('bob2 friend status should be accepted');
  ok('Friend sync via SYNC_BLOB');

  await bob.announceDevices();
  const announce = await once(alice, 'deviceAnnounce');
  announce.apply();
  ok('Link second device');
  await delay(300);

  // Register handlers BEFORE sending to avoid race condition
  const p1 = once(bob, 'message');
  const p2 = once(bob2, 'message');
  await alice.send(bob.username, { text: 'Both!' });
  const [m1, m2] = await Promise.all([p1, p2]);
  if (m1.text !== 'Both!' || m2.text !== 'Both!') throw new Error('Fan-out failed');
  ok('Multi-device fan-out');
  await delay(300);

  // Verify bob2 can send to alice (friend was synced)
  const aliceMsgPromise = once(alice, 'message');
  await bob2.send(alice.username, { text: 'Hello from bob2!' });
  const aliceMsg = await aliceMsgPromise;
  if (aliceMsg.text !== 'Hello from bob2!') throw new Error('bob2 -> alice failed');
  ok('bob2 can send to synced friend');
  await delay(300);

  // --- Self-sync ---
  const aliceLogin = await Obscura.login(`alice_${ts}`, 'pass', { apiUrl: API });
  if (aliceLogin.status !== 'newDevice') throw new Error('Expected newDevice for alice2');
  const alice2 = aliceLogin.client;
  await alice2.connect();
  await delay(300);

  // Register handlers before approving
  const alice2ApprovalPromise = once(alice2, 'linkApproval');
  const alice2SyncPromise = once(alice2, 'syncBlob');
  await alice.approveLink(alice2.linkCode);
  const alice2Approval = await alice2ApprovalPromise;
  alice2Approval.apply();
  await alice2SyncPromise;
  await delay(300);

  await alice.send(bob.username, { text: 'Sync!' });
  const sync = await once(alice2, 'sentSync');
  if (sync.conversationId !== bob.username) throw new Error('Sync failed');
  ok('Self-sync');

  // --- Cleanup ---
  [alice, alice2, bob, bob2].forEach(c => c.disconnect());

  console.log(`\n${'='.repeat(50)}`);
  console.log('  ALL TESTS PASSED!');
  console.log(`${'='.repeat(50)}\n`);
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
