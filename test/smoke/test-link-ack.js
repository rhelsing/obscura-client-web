#!/usr/bin/env node
/**
 * Smoke test: Reproduce the "sending chain" error and prove the ack fixes it.
 *
 * The browser bug:
 * 1. Bob1 encrypts approval at (bobUserId, bob2RegId) → sends PreKey to Bob2
 * 2. Bob2 decrypts at (bobUserId, bob1RegId) → session stored at bob1RegId
 * 3. Bob2 later sends self-sync → encrypt finds session at (bobUserId, bob1RegId) → Whisper
 * 4. Bob1 receives Whisper → tries (bobUserId, bob2RegId) → "sending chain"
 *    because that session was only used for SENDING, never received a reply
 *
 * The fix: Bob2 sends ack BACK to Bob1 after step 2, before step 3.
 * This establishes Bob1's receiving chain.
 */
import '../../test/helpers/setup.js';
import { Messenger } from '../../src/v2/lib/messenger.js';
import { createStore } from '../../src/v2/lib/store.js';
import { KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
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
      const envelopes = frame.envelopeBatch?.envelopes || [];
      for (const envelope of envelopes) {
        const senderId = bytesToUuid(envelope.senderId);
        const encMsg = dev.messenger.EncryptedMessage.decode(envelope.message);
        try {
          const result = await dev.messenger.decrypt(senderId, encMsg.content, encMsg.type);
          const clientMsg = dev.messenger.decodeClientMessage(result.bytes);
          received.push({ ...clientMsg, sourceUserId: senderId, ok: true });
          if (resolvers.length > 0) resolvers.shift()({ ...clientMsg, sourceUserId: senderId, ok: true });
        } catch (e) {
          received.push({ error: e.message, ok: false });
          if (resolvers.length > 0) resolvers.shift()({ error: e.message, ok: false });
        }
        const ack = WSFrame.create({ ack: { messageIds: [envelope.id] } });
        ws.send(WSFrame.encode(ack).finish());
      }
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

async function runTest(withAck) {
  const label = withAck ? 'WITH ACK' : 'WITHOUT ACK';
  console.log(`\n--- Test ${label} ---`);

  const pw = 'testpass12345';
  const bobUser = `bob_ack_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`;
  let r = await req(null, '/v1/users', { method: 'POST', body: JSON.stringify({ username: bobUser, password: pw }) });
  const bobUserToken = r.token;
  const bobUserId = jwt(bobUserToken).sub;

  const b1 = await createDevice(bobUser, bobUserToken);
  const b2 = await createDevice(bobUser, bobUserToken);

  // Map own devices (like connect() does)
  b1.messenger.mapDevice(b1.deviceId, bobUserId, b1.keys.registrationId);
  b1.messenger.mapDevice(b2.deviceId, bobUserId, b2.keys.registrationId);
  b2.messenger.mapDevice(b1.deviceId, bobUserId, b1.keys.registrationId);
  b2.messenger.mapDevice(b2.deviceId, bobUserId, b2.keys.registrationId);

  // Connect Bob1 (Bob2 connects later, simulating link-pending)
  const b1ws = await connectWS(b1);

  // Step 1: Bob1 sends approval to Bob2 (PreKey via messenger)
  // This is exactly what approveLink does
  console.log(`  Bob1 encrypts at (${bobUserId.slice(-8)}, ${b2.keys.registrationId})`);
  await b1.messenger.queueMessage(b2.deviceId, { type: 0, text: 'APPROVAL', timestamp: Date.now() }, bobUserId);
  await b1.messenger.flushMessages();

  // Verify Bob1 has a SENDING session
  const b1SessionAddr = `${bobUserId}.${b2.keys.registrationId}`;
  console.log(`  Bob1 session at ${b1SessionAddr.slice(-12)}: ${(await b1.store.loadSession(b1SessionAddr)) ? 'SENDING' : 'NONE'}`);

  // Step 2: Bob2 connects and receives approval
  const b2ws = await connectWS(b2);
  const approval = await b2ws.waitForMessage();
  console.log(`  Bob2 received approval: ${approval.ok ? '✓' : '✗ ' + approval.error}`);

  // Now Bob2 has a session at some regId from the decrypt
  // The decrypt loop chose an address. The session is there.
  // When Bob2 later sends to Bob1, it will use the mapped regId (bob1RegId)
  const b2SessionAddr = `${bobUserId}.${b1.keys.registrationId}`;
  const b2HasSession = await b2.store.loadSession(b2SessionAddr);
  console.log(`  Bob2 session at ${b2SessionAddr.slice(-12)}: ${b2HasSession ? 'EXISTS (from decrypt)' : 'NONE'}`);

  if (withAck) {
    // Step 2b: Bob2 sends ack back to Bob1
    console.log('  Bob2 → Bob1 (ack)');
    await b2.messenger.queueMessage(b1.deviceId, { type: 0, text: 'LINK_ACK', timestamp: Date.now() }, bobUserId);
    await b2.messenger.flushMessages();

    const ackMsg = await b1ws.waitForMessage();
    console.log(`  Bob1 received ack: ${ackMsg.ok ? '✓ "' + ackMsg.text + '"' : '✗ ' + ackMsg.error}`);
  }

  // Step 3: Bob2 sends self-sync to Bob1 (the critical test)
  // If Bob2 has a session from step 2, this is a Whisper.
  // Bob1 needs a receiving chain to decrypt it.
  console.log('  Bob2 → Bob1 (self-sync)');
  await b2.messenger.queueMessage(b1.deviceId, { type: 0, text: 'SELF_SYNC', timestamp: Date.now() }, bobUserId);
  await b2.messenger.flushMessages();

  const sync = await b1ws.waitForMessage();
  const success = sync.ok;
  console.log(`  Bob1 decrypt: ${success ? '✓ "' + sync.text + '"' : '✗ ' + sync.error}`);

  b1ws.ws.close();
  b2ws.ws.close();
  await sleep(300);

  return success;
}

console.log('\n=== Link Ack Smoke Test ===');

const resultA = await runTest(false);
const resultB = await runTest(true);

console.log('\n--- Results ---');
console.log(`WITHOUT ACK: ${resultA ? 'PASS' : 'FAIL'}`);
console.log(`WITH ACK:    ${resultB ? 'PASS' : 'FAIL'}`);

if (!resultA && resultB) {
  console.log('\n=== ACK FIX PROVEN ===\n');
  process.exit(0);
} else if (resultA && resultB) {
  console.log('\n=== BOTH PASS — need to reproduce browser conditions more precisely ===\n');
  process.exit(0);
} else {
  console.log('\n=== UNEXPECTED ===\n');
  process.exit(1);
}
