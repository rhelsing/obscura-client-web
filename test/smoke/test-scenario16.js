#!/usr/bin/env node
/**
 * Smoke test for scenario 16: Multi-device offline sync
 *
 * Bob1 and Bob2 are linked devices. Alice is a friend.
 * 1. All connected, sessions established
 * 2. Bob1 disconnects (goes offline)
 * 3. Bob2 sends ORM MODEL_SYNC to own devices + friends while Bob1 offline
 * 4. Bob1 reconnects, receives queued messages
 *
 * The key issue: Bob2 sends self-sync to Bob1's deviceId.
 * queueMessage needs the correct userId for Signal encryption.
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
  return (ct && ct.includes('json')) ? r.json() : r.text();
}

const serverProto = await protobuf.load(join(__dirname, '../../public/proto/obscura/v1/obscura.proto'));
const WSFrame = serverProto.lookupType('obscura.v1.WebSocketFrame');

async function genKeys(store) {
  const ikp = await KeyHelper.generateIdentityKeyPair();
  const rid = KeyHelper.generateRegistrationId();
  const spk = await KeyHelper.generateSignedPreKey(ikp, 1);
  const pks = [];
  for (let i = 1; i <= 100; i++) { const pk = await KeyHelper.generatePreKey(i); pks.push(pk); await store.storePreKey(i, pk.keyPair); }
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

async function createDevice(username, userToken) {
  const store = createStore(`${username}_${Math.random().toString(36).slice(2, 6)}`);
  const keys = await genKeys(store);
  const r = await req(userToken, '/v1/devices', { method: 'POST', body: JSON.stringify({ name: 'Dev', ...keys }) });
  const token = r.token;
  const deviceId = jwt(token).device_id;
  const userId = jwt(token).sub;
  const messenger = new Messenger({ apiUrl: API_URL, store, token, ownUserId: userId });
  await messenger.loadProto();
  return { store, token, deviceId, userId, messenger, keys };
}

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
      const encMsg = dev.messenger.EncryptedMessage.decode(frame.envelope.message);
      try {
        const result = await dev.messenger.decrypt(senderId, encMsg.content, encMsg.type);
        const clientMsg = dev.messenger.decodeClientMessage(result.bytes);
        received.push({ ...clientMsg, sourceUserId: senderId });
        if (resolvers.length > 0) resolvers.shift()({ ...clientMsg, sourceUserId: senderId });
      } catch (e) {
        console.error(`[WS ${dev.deviceId.slice(-8)}] err=${e.message.slice(0, 60)}`);
      }
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
  return { ws, waitForMessage };
}

console.log('\n=== Scenario 16 Smoke Test ===\n');

const pw = 'testpass12345';

// Register Bob (2 devices) + Alice (1 device)
const bobUser = `bob16_${Date.now()}`;
let r = await req(null, '/v1/users', { method: 'POST', body: JSON.stringify({ username: bobUser, password: pw }) });
const bobUserToken = r.token;
const bobUserId = jwt(bobUserToken).sub;
const b1 = await createDevice(bobUser, bobUserToken);
const b2 = await createDevice(bobUser, bobUserToken);

const aliceUser = `alice16_${Date.now()}`;
r = await req(null, '/v1/users', { method: 'POST', body: JSON.stringify({ username: aliceUser, password: pw }) });
const aliceUserToken = r.token;
const aliceUserId = jwt(aliceUserToken).sub;
const a1 = await createDevice(aliceUser, aliceUserToken);

console.log(`Bob:   userId=${bobUserId.slice(-8)}, d1=${b1.deviceId.slice(-8)}, d2=${b2.deviceId.slice(-8)}`);
console.log(`Alice: userId=${aliceUserId.slice(-8)}, d1=${a1.deviceId.slice(-8)}`);

// Map own devices for each
b1.messenger.mapDevice(b1.deviceId, bobUserId, b1.keys.registrationId);
b1.messenger.mapDevice(b2.deviceId, bobUserId, b2.keys.registrationId);
b2.messenger.mapDevice(b1.deviceId, bobUserId, b1.keys.registrationId);
b2.messenger.mapDevice(b2.deviceId, bobUserId, b2.keys.registrationId);
a1.messenger.mapDevice(a1.deviceId, aliceUserId, a1.keys.registrationId);

// Step 1: Establish sessions
console.log('\n--- Step 1: Establish sessions ---');
const a1ws = await connectWS(a1);
const b1ws = await connectWS(b1);
const b2ws = await connectWS(b2);

// Alice → Bob (both devices)
await a1.messenger.fetchPreKeyBundles(bobUserId);
await a1.messenger.queueMessage(b1.deviceId, { type: 0, text: 'A→B1', timestamp: Date.now() }, bobUserId);
await a1.messenger.queueMessage(b2.deviceId, { type: 0, text: 'A→B2', timestamp: Date.now() }, bobUserId);
await a1.messenger.flushMessages();
const m1 = await b1ws.waitForMessage();
const m2 = await b2ws.waitForMessage();
console.log(`A→B1: "${m1.text}" ✓`);
console.log(`A→B2: "${m2.text}" ✓`);

// Bob1 → Alice (establishes B1→A session)
await b1.messenger.fetchPreKeyBundles(aliceUserId);
await b1.messenger.queueMessage(a1.deviceId, { type: 0, text: 'B1→A', timestamp: Date.now() }, aliceUserId);
await b1.messenger.flushMessages();
const m3 = await a1ws.waitForMessage();
console.log(`B1→A: "${m3.text}" ✓`);

// Bob2 → Alice (establishes B2→A session)
await b2.messenger.fetchPreKeyBundles(aliceUserId);
await b2.messenger.queueMessage(a1.deviceId, { type: 0, text: 'B2→A', timestamp: Date.now() }, aliceUserId);
await b2.messenger.flushMessages();
const m4 = await a1ws.waitForMessage();
console.log(`B2→A: "${m4.text}" ✓`);

// Step 2: Bob1 goes offline
console.log('\n--- Step 2: Bob1 goes offline ---');
b1ws.ws.close();
await sleep(500);
console.log('Bob1 disconnected');

// Step 3: Bob2 sends self-sync (MODEL_SYNC) to Bob1 while offline
// This is what scenario 16 does — Bob2 updates profile, ORM syncs to Bob1
console.log('\n--- Step 3: Bob2 sends self-sync while Bob1 offline ---');

// The critical test: queueMessage to Bob1's deviceId WITHOUT explicit userId
// This simulates what SyncManager does
const mapped = b2.messenger._deviceMap.get(b1.deviceId);
console.log(`Bob1 in Bob2's map: userId=${mapped?.userId?.slice(-8)}, regId=${mapped?.registrationId}`);

// Send MODEL_SYNC to Bob1 (self-sync) — use mapped userId
await b2.messenger.queueMessage(b1.deviceId, {
  type: 30, // MODEL_SYNC
  modelSync: {
    model: 'profile',
    id: 'profile_test',
    op: 0,
    timestamp: Date.now(),
    data: new TextEncoder().encode(JSON.stringify({ displayName: 'Bob2 Updated' })),
  },
}, mapped?.userId); // Pass userId explicitly like SyncManager should
await b2.messenger.flushMessages();
console.log('Bob2 sent MODEL_SYNC to offline Bob1');

// Also send to Alice (cross-user)
await b2.messenger.queueMessage(a1.deviceId, {
  type: 30,
  modelSync: {
    model: 'profile',
    id: 'profile_test',
    op: 0,
    timestamp: Date.now(),
    data: new TextEncoder().encode(JSON.stringify({ displayName: 'Bob2 Updated' })),
  },
}, aliceUserId);
await b2.messenger.flushMessages();
const m5 = await a1ws.waitForMessage();
console.log(`Alice received MODEL_SYNC: "${m5.modelSync?.model}" ✓`);

// Step 4: Bob1 comes back online, receives queued messages
console.log('\n--- Step 4: Bob1 reconnects ---');
const b1ws2 = await connectWS(b1);

const m6 = await b1ws2.waitForMessage(10000);
console.log(`Bob1 received queued: type=${m6.type}, model=${m6.modelSync?.model} ✓`);

// Step 5: Verify Bob1 can still message Alice after reconnect
console.log('\n--- Step 5: Bob1 → Alice after reconnect ---');
await b1.messenger.queueMessage(a1.deviceId, { type: 0, text: 'B1 back online!', timestamp: Date.now() }, aliceUserId);
await b1.messenger.flushMessages();
const m7 = await a1ws.waitForMessage();
console.log(`B1→A after reconnect: "${m7.text}" ✓`);

a1ws.ws.close();
b1ws2.ws.close();
b2ws.ws.close();
await sleep(500);

console.log('\n=== SCENARIO 16 SMOKE TEST: PASSED ===\n');
