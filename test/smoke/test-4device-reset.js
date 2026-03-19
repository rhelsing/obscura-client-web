#!/usr/bin/env node
/**
 * 4-device SESSION_RESET smoke test using messenger.js
 *
 * Alice (2 devices) + Bob (2 devices), all friends.
 * 1. All pairs can message
 * 2. Corrupt Bob2↔Alice session
 * 3. Bob2 sends SESSION_RESET to all Alice devices
 * 4. After reset, Bob2 can message Alice again
 * 5. Other sessions unaffected
 */
import '../../test/helpers/setup.js';
import { Messenger } from '../../src/v2/lib/messenger.js';
import { createStore } from '../../src/v2/lib/store.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import WebSocket from 'ws';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_URL = process.env.VITE_API_URL;
if (!API_URL) { console.error('VITE_API_URL required'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toBase64(b) { const a = new Uint8Array(b); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
function jwt(t) { return JSON.parse(atob(t.split('.')[1])); }
function uuidToBytes(uuid) { const hex = uuid.replace(/-/g, ''); const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16); return b; }
function bytesToUuid(b) { const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }

async function req(token, path, opts = {}) {
  const h = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type');
  return ct?.includes('json') ? r.json() : r.text();
}

// Load server proto for WebSocket
const serverProto = await protobuf.load(join(__dirname, '../../public/proto/obscura/v1/obscura.proto'));
const WSFrame = serverProto.lookupType('obscura.v1.WebSocketFrame');

async function genKeys(store) {
  const ikp = await KeyHelper.generateIdentityKeyPair();
  const rid = KeyHelper.generateRegistrationId();
  const spk = await KeyHelper.generateSignedPreKey(ikp, 1);
  const pks = [];
  for (let i = 1; i <= 100; i++) { const pk = await KeyHelper.generatePreKey(i); pks.push(pk); await store.storePreKey(i, pk.keyPair); }
  // Override getters to bypass the global keyCache singleton
  // (keyCache is shared across all stores in the same process — breaks multi-device tests)
  store.identityKeyPair = ikp;
  store.registrationId = rid;
  store.getIdentityKeyPair = async () => ikp;
  store.getLocalRegistrationId = async () => rid;
  await store.storeSignedPreKey(1, spk.keyPair);
  return {
    identityKey: toBase64(ikp.pubKey), registrationId: rid,
    signedPreKey: { keyId: spk.keyId, publicKey: toBase64(spk.keyPair.pubKey), signature: toBase64(spk.signature) },
    oneTimePreKeys: pks.map(p => ({ keyId: p.keyId, publicKey: toBase64(p.keyPair.pubKey) })),
  };
}

// Create a device with messenger
async function createDevice(username, password, userToken) {
  const store = createStore(`${username}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const keys = await genKeys(store);

  const r = await req(userToken, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'Dev', ...keys }) });
  const token = r.token;
  const deviceId = jwt(token).device_id;
  const userId = jwt(token).sub;

  const messenger = new Messenger({ apiUrl: API_URL, store, token });
  await messenger.loadProto();

  return { store, token, deviceId, userId, messenger, username, keys };
}

// Connect WebSocket and return message receiver
async function connectWS(dev) {
  const ticket = await req(dev.token, '/v1/gateway/ticket', { method: 'POST' });
  const wsUrl = API_URL.replace('https://', 'wss://');
  const received = [];
  const resolvers = [];

  const ws = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}/v1/gateway?ticket=${ticket.ticket}`);
    ws.on('open', () => resolve(ws));
    ws.on('message', async (data) => {
      const frame = WSFrame.decode(new Uint8Array(data));
      if (!frame.envelope) return;

      const senderId = bytesToUuid(frame.envelope.senderId);
      const envId = bytesToUuid(frame.envelope.id);
      const encMsg = dev.messenger.EncryptedMessage.decode(frame.envelope.message);

      try {
        const result = await dev.messenger.decrypt(senderId, encMsg.content, encMsg.type);
        const clientMsg = dev.messenger.decodeClientMessage(result.bytes);
        const msg = { ...clientMsg, sourceUserId: senderId, senderDeviceId: result.senderDeviceId, envelopeId: envId };
        received.push(msg);
        if (resolvers.length > 0) resolvers.shift()(msg);
      } catch (e) {
        console.error(`[WS ${dev.deviceId.slice(-8)}] from=${senderId.slice(-8)} type=${encMsg.type} err=${e.message.slice(0, 50)}`);
      }

      // ACK
      const ack = WSFrame.create({ ack: { messageIds: [frame.envelope.id] } });
      ws.send(WSFrame.encode(ack).finish());
    });
  });

  const waitForMessage = (timeout = 5000) => {
    if (received.length > 0) return Promise.resolve(received.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
      resolvers.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  };

  return { ws, waitForMessage, received };
}

// Send a text message from one device to another
async function sendText(fromDev, toDeviceId, toUserId, text) {
  await fromDev.messenger.queueMessage(toDeviceId, {
    type: 0, // TEXT
    text,
    timestamp: Date.now(),
  }, toUserId);
  await fromDev.messenger.flushMessages();
}

console.log('\n=== 4-Device SESSION_RESET (messenger.js) ===\n');

const pw = 'testpass12345';

// Register Alice + 2 devices
const aliceUser = `alice4d_${Date.now()}`;
let r = await req(null, '/v1/users', { method: 'POST', body: JSON.stringify({ username: aliceUser, password: pw }) });
const aliceUserToken = r.token;
const aliceUserId = jwt(aliceUserToken).sub;

const a1 = await createDevice(aliceUser, pw, aliceUserToken);
const a2 = await createDevice(aliceUser, pw, aliceUserToken);

// Register Bob + 2 devices
const bobUser = `bob4d_${Date.now()}`;
r = await req(null, '/v1/users', { method: 'POST', body: JSON.stringify({ username: bobUser, password: pw }) });
const bobUserToken = r.token;
const bobUserId = jwt(bobUserToken).sub;

const b1 = await createDevice(bobUser, pw, bobUserToken);
const b2 = await createDevice(bobUser, pw, bobUserToken);

console.log(`Alice: userId=${aliceUserId.slice(-8)}, d1=${a1.deviceId.slice(-8)}, d2=${a2.deviceId.slice(-8)}`);
console.log(`Bob:   userId=${bobUserId.slice(-8)}, d1=${b1.deviceId.slice(-8)}, d2=${b2.deviceId.slice(-8)}`);

// TEST B: Don't pre-populate maps — let encrypt/decrypt discover via fetchPreKeyBundles
// (like the browser does — messenger auto-fetches when no session exists)
// Only map own devices (browser does this in connect())
for (const dev of [a1, a2]) {
  dev.messenger.mapDevice(a1.deviceId, aliceUserId, a1.keys.registrationId);
  dev.messenger.mapDevice(a2.deviceId, aliceUserId, a2.keys.registrationId);
}
for (const dev of [b1, b2]) {
  dev.messenger.mapDevice(b1.deviceId, bobUserId, b1.keys.registrationId);
  dev.messenger.mapDevice(b2.deviceId, bobUserId, b2.keys.registrationId);
}
console.log('Only own device maps set (no cross-user pre-fetch)');

// Connect all 4
const a1ws = await connectWS(a1);
const a2ws = await connectWS(a2);
const b1ws = await connectWS(b1);
const b2ws = await connectWS(b2);
console.log('All connected');

// --- Step 1: Verify messaging ---
console.log('\n--- Step 1: Verify messaging ---');

await sendText(a1, b1.deviceId, bobUserId, 'A1→B1');
const m1 = await b1ws.waitForMessage();
console.log(`A1→B1: "${m1.text}" ✓`);

await sendText(a1, b2.deviceId, bobUserId, 'A1→B2');
const m2 = await b2ws.waitForMessage();
console.log(`A1→B2: "${m2.text}" ✓`);

await sendText(b2, a1.deviceId, aliceUserId, 'B2→A1');
const m3 = await a1ws.waitForMessage();
console.log(`B2→A1: "${m3.text}" ✓`);

await sendText(b2, a2.deviceId, aliceUserId, 'B2→A2');
const m4 = await a2ws.waitForMessage();
console.log(`B2→A2: "${m4.text}" ✓`);

// --- Step 2: Corrupt Bob2's session with Alice ---
console.log('\n--- Step 2: Corrupt Bob2↔Alice session ---');

// Delete all Bob2's sessions with Alice (at all known regIds)
const b2RegIds = new Set([1]);
for (const [, info] of b2.messenger._deviceMap) {
  if (info.userId === aliceUserId && info.registrationId) b2RegIds.add(info.registrationId);
}
const ownRegId = await b2.store.getLocalRegistrationId();
if (ownRegId) b2RegIds.add(ownRegId);

for (const regId of b2RegIds) {
  const addr = `${aliceUserId}.${regId}`;
  const s = await b2.store.loadSession(addr);
  if (s) {
    await b2.store.removeSession(addr);
    console.log(`Deleted Bob2 session: ${addr.slice(-12)}`);
  }
}

// --- Step 3: Bob2 sends SESSION_RESET to all Alice devices ---
console.log('\n--- Step 3: Bob2 SESSION_RESET ---');

const aliceBundles = await b2.messenger.fetchPreKeyBundles(aliceUserId);
for (const bundle of aliceBundles) {
  await sendText(b2, bundle.deviceId, aliceUserId, 'SESSION_RESET');
  console.log(`Sent SESSION_RESET to Alice device ${bundle.deviceId.slice(-8)}`);
}

// Wait for both Alice devices to receive
const r1 = await a1ws.waitForMessage();
console.log(`Alice1 received: "${r1.text}" ✓`);
const r2 = await a2ws.waitForMessage();
console.log(`Alice2 received: "${r2.text}" ✓`);

// In the real app, _handleSessionReset deletes stale sessions.
// Here we simulate by deleting all sessions with Bob EXCEPT the one just created.
for (const dev of [a1, a2]) {
  // Delete stale session at .1 (the fresh one is at a different regId from the PreKey)
  const staleAddr = `${bobUserId}.1`;
  const stale = await dev.store.loadSession(staleAddr);
  if (stale) {
    await dev.store.removeSession(staleAddr);
  }
}

// --- Step 4: Post-reset messaging ---
console.log('\n--- Step 4: Post-reset B2→A1 ---');

await sendText(b2, a1.deviceId, aliceUserId, 'B2→A1 after reset');
const m5 = await a1ws.waitForMessage();
console.log(`B2→A1 after reset: "${m5.text}" ✓`);

// --- Step 5: Verify other sessions unaffected ---
console.log('\n--- Step 5: Other sessions intact ---');

await sendText(a1, b1.deviceId, bobUserId, 'A1→B1 still works');
const m6 = await b1ws.waitForMessage();
console.log(`A1→B1 still works: "${m6.text}" ✓`);

await sendText(b1, a2.deviceId, aliceUserId, 'B1→A2 still works');
const m7 = await a2ws.waitForMessage();
console.log(`B1→A2 still works: "${m7.text}" ✓`);

// Cleanup
a1ws.ws.close(); a2ws.ws.close(); b1ws.ws.close(); b2ws.ws.close();
await sleep(500);

console.log('\n=== 4-DEVICE SESSION_RESET: PASSED ===\n');
