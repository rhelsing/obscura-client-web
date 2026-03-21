#!/usr/bin/env node
/**
 * Smoke test: Multi-device with per-device Signal addresses
 * Key insight: SignalProtocolAddress(userId, DEVICE_REGISTRATION_ID)
 * not SignalProtocolAddress(userId, 1) for all devices
 */

import '../../test/helpers/setup.js';
import { KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_URL = process.env.VITE_API_URL;
if (!API_URL) { console.error('VITE_API_URL required'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toBase64(buf) { const b = new Uint8Array(buf); let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Uint8Array) return input.buffer;
  if (Array.isArray(input)) return new Uint8Array(input).buffer;
  if (typeof input === 'string') { let b=input.replace(/-/g,'+').replace(/_/g,'/'); while(b.length%4) b+='='; const bin=atob(b); const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return bytes.buffer; }
  throw new Error('bad input');
}
function uuidToBytes(uuid) { const hex=uuid.replace(/-/g,''); const b=new Uint8Array(16); for(let i=0;i<16;i++) b[i]=parseInt(hex.substr(i*2,2),16); return b; }
function bytesToUuid(b) { const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }
function randomUUID() { const b=new Uint8Array(16); crypto.getRandomValues(b); b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80; return bytesToUuid(b); }
function parseJwt(t) { return JSON.parse(atob(t.split('.')[1])); }

async function request(token, path, opts={}) {
  const h = { 'Content-Type':'application/json', ...opts.headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${API_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type');
  return ct?.includes('json') ? r.json() : r.text();
}

// Minimal Signal store
class Store {
  constructor() { this.ikp=null; this.rid=null; this.pks=new Map(); this.spks=new Map(); this.sess=new Map(); this.ids=new Map(); }
  async getIdentityKeyPair() { return this.ikp; }
  async getLocalRegistrationId() { return this.rid; }
  async isTrustedIdentity() { return true; }
  async saveIdentity(addr, pk) { this.ids.set(addr, pk); return false; }
  async loadPreKey(id) { return this.pks.get(id.toString()); }
  async storePreKey(id, kp) { this.pks.set(id.toString(), kp); }
  async removePreKey(id) { this.pks.delete(id.toString()); }
  async loadSignedPreKey(id) { return this.spks.get(id.toString()); }
  async storeSignedPreKey(id, kp) { this.spks.set(id.toString(), kp); }
  async removeSignedPreKey(id) { this.spks.delete(id.toString()); }
  async loadSession(addr) { return this.sess.get(addr); }
  async storeSession(addr, rec) { this.sess.set(addr, rec); }
  async removeSession(addr) { this.sess.delete(addr); }
}

// Load proto
const serverProto = await protobuf.load(join(__dirname, '../../public/proto/obscura/v1/obscura.proto'));
const clientProto = await protobuf.load(join(__dirname, '../../public/proto/v2/client.proto'));
const WebSocketFrame = serverProto.lookupType('obscura.v1.WebSocketFrame');
const SendMessageRequest = serverProto.lookupType('obscura.v1.SendMessageRequest');
const EncryptedMessage = clientProto.lookupType('obscura.v2.EncryptedMessage');
const ClientMessage = clientProto.lookupType('obscura.v2.ClientMessage');

async function genKeys(store) {
  const ikp = await KeyHelper.generateIdentityKeyPair();
  const rid = KeyHelper.generateRegistrationId();
  const spk = await KeyHelper.generateSignedPreKey(ikp, 1);
  const pks = [];
  for (let i=1;i<=20;i++) { const pk=await KeyHelper.generatePreKey(i); pks.push(pk); await store.storePreKey(i,pk.keyPair); }
  store.ikp = ikp; store.rid = rid;
  await store.storeSignedPreKey(1, spk.keyPair);
  return {
    identityKey: toBase64(ikp.pubKey), registrationId: rid,
    signedPreKey: { keyId: spk.keyId, publicKey: toBase64(spk.keyPair.pubKey), signature: toBase64(spk.signature) },
    oneTimePreKeys: pks.map(p => ({ keyId: p.keyId, publicKey: toBase64(p.keyPair.pubKey) })),
  };
}

console.log('\n=== Multi-Device Signal Address Test ===\n');

// Register user + 2 devices
const store1 = new Store();
const store2 = new Store();

const username = `md_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
const password = 'testpass12345';

// Register user
const userRes = await request(null, '/v1/users', { method:'POST', body: JSON.stringify({username, password}) });
const userToken = userRes.token;
const userId = parseJwt(userToken).sub;
console.log(`User: ${userId}`);

// Device 1
const keys1 = await genKeys(store1);
const dev1Res = await request(userToken, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Dev1',...keys1}) });
const token1 = dev1Res.token;
const deviceId1 = parseJwt(token1).device_id;
console.log(`Device1: ${deviceId1}, regId=${keys1.registrationId}`);

// Device 2
const keys2 = await genKeys(store2);
const dev2Res = await request(userToken, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Dev2',...keys2}) });
const token2 = dev2Res.token;
const deviceId2 = parseJwt(token2).device_id;
console.log(`Device2: ${deviceId2}, regId=${keys2.registrationId}`);

// Register Alice
const aliceStore = new Store();
const aliceUsername = `alice_${Date.now()}`;
const aliceUserRes = await request(null, '/v1/users', { method:'POST', body: JSON.stringify({username:aliceUsername, password}) });
const aliceUserToken = aliceUserRes.token;
const aliceUserId = parseJwt(aliceUserToken).sub;
const aliceKeys = await genKeys(aliceStore);
const aliceDevRes = await request(aliceUserToken, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Alice',...aliceKeys}) });
const aliceToken = aliceDevRes.token;
const aliceDeviceId = parseJwt(aliceToken).device_id;
console.log(`Alice: userId=${aliceUserId}, deviceId=${aliceDeviceId}, regId=${aliceKeys.registrationId}`);

// Fetch Bob's bundles from Alice
const bundles = await request(aliceToken, `/v1/users/${userId}`);
console.log(`\nBob bundles: ${bundles.length}`);
for (const b of bundles) {
  console.log(`  deviceId=${b.deviceId}, regId=${b.registrationId}`);
}

// === KEY TEST: Use registrationId as Signal device ID ===
console.log('\n--- Test: SignalProtocolAddress(userId, registrationId) ---');

// Connect device 2 websocket
const ticket2 = await request(token2, '/v1/gateway/ticket', { method:'POST' });
const wsUrl = API_URL.replace('https://','wss://');

const received = [];
const ws2 = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${wsUrl}/v1/gateway?ticket=${ticket2.ticket}`);
  ws.on('open', () => { console.log('Dev2 WS connected'); resolve(ws); });
  ws.on('error', reject);
  ws.on('message', async (data) => {
    const frame = WebSocketFrame.decode(new Uint8Array(data));
    const envelopes = frame.envelopeBatch?.envelopes || [];
    for (const envelope of envelopes) {
      const senderId = bytesToUuid(envelope.senderId);
      const envId = bytesToUuid(envelope.id);
      console.log(`  Dev2 received envelope: sender=${senderId.slice(-8)}`);

      // Try to decrypt using registrationId-based address
      const encMsg = EncryptedMessage.decode(envelope.message);

      // The sender could be Alice (cross-user) or Bob device1 (same-user)
      // Signal address: (senderId, ???)
      // Try with registrationId from the sender's bundle
      let decrypted = null;

      // We know the sender's userId from the envelope
      // For Alice: use her registrationId
      // For own device: use their registrationId
      const senderRegId = senderId === aliceUserId ? aliceKeys.registrationId : keys1.registrationId;
      const addr = new SignalProtocolAddress(senderId, senderRegId);
      const cipher = new SessionCipher(store2, addr);

      try {
        if (encMsg.type === 1) { // PreKey
          const plain = await cipher.decryptPreKeyWhisperMessage(
            encMsg.content.buffer.slice(encMsg.content.byteOffset, encMsg.content.byteOffset + encMsg.content.byteLength),
            'binary'
          );
          const cm = ClientMessage.decode(new Uint8Array(plain));
          console.log(`  Dev2 DECRYPTED (regId addr): type=${cm.type}, text="${cm.text}"`);
          decrypted = cm;
        }
      } catch (e) {
        console.log(`  Dev2 decrypt with regId FAILED: ${e.message}`);
      }

      received.push({ senderId, decrypted, envId });

      // ACK
      const ackFrame = WebSocketFrame.create({ ack: { messageIds: [envelope.id] } });
      ws.send(WebSocketFrame.encode(ackFrame).finish());
    }
  });
});

await sleep(500);

// Alice sends to BOTH bob devices using registrationId-based addresses
console.log('\nAlice sending to both bob devices...');

for (const bundle of bundles) {
  const addr = new SignalProtocolAddress(userId, bundle.registrationId);
  const session = await aliceStore.loadSession(addr.toString());
  if (!session) {
    const sb = new SessionBuilder(aliceStore, addr);
    await sb.processPreKey({
      identityKey: toArrayBuffer(bundle.identityKey),
      registrationId: bundle.registrationId,
      signedPreKey: { keyId: bundle.signedPreKey.keyId, publicKey: toArrayBuffer(bundle.signedPreKey.publicKey), signature: toArrayBuffer(bundle.signedPreKey.signature) },
      preKey: bundle.oneTimePreKey ? { keyId: bundle.oneTimePreKey.keyId, publicKey: toArrayBuffer(bundle.oneTimePreKey.publicKey) } : undefined,
    });
    console.log(`  Built session: addr=(${userId.slice(-8)}, ${bundle.registrationId}) for device ${bundle.deviceId.slice(-8)}`);
  }

  const cipher = new SessionCipher(aliceStore, addr);
  const cm = ClientMessage.create({ type: 0, text: `Hello device ${bundle.deviceId.slice(-8)}`, timestamp: Date.now() });
  const plainBytes = ClientMessage.encode(cm).finish();
  const plainBuf = plainBytes.buffer.slice(plainBytes.byteOffset, plainBytes.byteOffset + plainBytes.byteLength);
  const ct = await cipher.encrypt(plainBuf);

  let body;
  if (typeof ct.body === 'string') { body = new Uint8Array(ct.body.length); for(let i=0;i<ct.body.length;i++) body[i]=ct.body.charCodeAt(i); }
  else body = new Uint8Array(ct.body);

  const encMsg = EncryptedMessage.create({ type: ct.type === 3 ? 1 : 2, content: body });
  const encBytes = EncryptedMessage.encode(encMsg).finish();

  await fetch(`${API_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf', 'Authorization': `Bearer ${aliceToken}`, 'Idempotency-Key': randomUUID() },
    body: SendMessageRequest.encode(SendMessageRequest.create({ messages: [{ submissionId: uuidToBytes(randomUUID()), deviceId: uuidToBytes(bundle.deviceId), message: encBytes }] })).finish(),
  });
  console.log(`  Sent to device ${bundle.deviceId.slice(-8)}`);
}

// Wait for messages
await sleep(3000);
console.log(`\nDev2 received ${received.length} message(s)`);

ws2.close();
await sleep(500);

console.log('\n=== TEST COMPLETE ===\n');
