#!/usr/bin/env node
/**
 * Definitive multi-device test: Alice (1 device) sends to Bob (2 devices)
 * Both bob devices must decrypt successfully.
 *
 * Tests the ONLY approach that can work:
 * - Encrypt with SignalProtocolAddress(userId, registrationId)
 * - Decrypt with SignalProtocolAddress(senderId, senderRegistrationId)
 * - The receiver needs to know the sender's registrationId
 *
 * For PreKey messages: registrationId is IN the message (Signal extracts it)
 * Question: what address does the receiver need to use?
 */

import './../../test/helpers/setup.js';
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
  if (input instanceof Uint8Array) return input.buffer.slice(input.byteOffset, input.byteOffset+input.byteLength);
  if (Array.isArray(input)) return new Uint8Array(input).buffer;
  if (typeof input === 'string') { let b=input.replace(/-/g,'+').replace(/_/g,'/'); while(b.length%4) b+='='; const bin=atob(b); const bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); return bytes.buffer; }
}
function uuidToBytes(uuid) { const hex=uuid.replace(/-/g,''); const b=new Uint8Array(16); for(let i=0;i<16;i++) b[i]=parseInt(hex.substr(i*2,2),16); return b; }
function bytesToUuid(b) { const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }
function randomUUID() { const b=new Uint8Array(16); crypto.getRandomValues(b); b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80; return bytesToUuid(b); }
function parseJwt(t) { return JSON.parse(atob(t.split('.')[1])); }

async function req(token, path, opts={}) {
  const h = { 'Content-Type':'application/json', ...opts.headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${API_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type');
  return ct?.includes('json') ? r.json() : r.text();
}

class Store {
  constructor() { this.ikp=null; this.rid=null; this.pks=new Map(); this.spks=new Map(); this.sess=new Map(); this.ids=new Map(); }
  async getIdentityKeyPair(){return this.ikp} async getLocalRegistrationId(){return this.rid}
  async isTrustedIdentity(){return true} async saveIdentity(a,p){this.ids.set(a,p);return false}
  async loadPreKey(i){return this.pks.get(i.toString())} async storePreKey(i,k){this.pks.set(i.toString(),k)}
  async removePreKey(i){this.pks.delete(i.toString())}
  async loadSignedPreKey(i){return this.spks.get(i.toString())} async storeSignedPreKey(i,k){this.spks.set(i.toString(),k)}
  async removeSignedPreKey(i){this.spks.delete(i.toString())}
  async loadSession(a){return this.sess.get(a)} async storeSession(a,r){this.sess.set(a,r)}
  async removeSession(a){this.sess.delete(a)}
}

const serverProto = await protobuf.load(join(__dirname, '../../public/proto/obscura/v1/obscura.proto'));
const clientProto = await protobuf.load(join(__dirname, '../../public/proto/v2/client.proto'));
const WSFrame = serverProto.lookupType('obscura.v1.WebSocketFrame');
const SendReq = serverProto.lookupType('obscura.v1.SendMessageRequest');
const EncMsg = clientProto.lookupType('obscura.v2.EncryptedMessage');
const ClientMsg = clientProto.lookupType('obscura.v2.ClientMessage');

async function genKeys(store) {
  store.ikp = await KeyHelper.generateIdentityKeyPair();
  store.rid = KeyHelper.generateRegistrationId();
  const spk = await KeyHelper.generateSignedPreKey(store.ikp, 1);
  await store.storeSignedPreKey(1, spk.keyPair);
  const pks = [];
  for (let i=1;i<=20;i++) { const pk=await KeyHelper.generatePreKey(i); pks.push(pk); await store.storePreKey(i,pk.keyPair); }
  return {
    identityKey: toBase64(store.ikp.pubKey), registrationId: store.rid,
    signedPreKey: { keyId: spk.keyId, publicKey: toBase64(spk.keyPair.pubKey), signature: toBase64(spk.signature) },
    oneTimePreKeys: pks.map(p => ({ keyId: p.keyId, publicKey: toBase64(p.keyPair.pubKey) })),
  };
}

function encryptBody(ct) {
  let body;
  if (typeof ct.body === 'string') { body = new Uint8Array(ct.body.length); for(let i=0;i<ct.body.length;i++) body[i]=ct.body.charCodeAt(i); }
  else body = new Uint8Array(ct.body);
  return body;
}

console.log('\n=== Definitive Multi-Device Test ===\n');

// Setup: Alice + Bob (2 devices)
const aliceStore = new Store();
const bob1Store = new Store();
const bob2Store = new Store();

const pw = 'testpass12345';
const bobUser = `bob_${Date.now()}`;
const aliceUser = `alice_${Date.now()}`;

// Register Bob + 2 devices
const bobUserRes = await req(null, '/v1/users', { method:'POST', body: JSON.stringify({username:bobUser,password:pw}) });
const bobUserId = parseJwt(bobUserRes.token).sub;
const bob1Keys = await genKeys(bob1Store);
const bob1Dev = await req(bobUserRes.token, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Bob1',...bob1Keys}) });
const bob1Token = bob1Dev.token;
const bob1DevId = parseJwt(bob1Token).device_id;
const bob2Keys = await genKeys(bob2Store);
const bob2Dev = await req(bobUserRes.token, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Bob2',...bob2Keys}) });
const bob2Token = bob2Dev.token;
const bob2DevId = parseJwt(bob2Token).device_id;

// Register Alice
const aliceUserRes = await req(null, '/v1/users', { method:'POST', body: JSON.stringify({username:aliceUser,password:pw}) });
const aliceUserId = parseJwt(aliceUserRes.token).sub;
const aliceKeys = await genKeys(aliceStore);
const aliceDev = await req(aliceUserRes.token, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Alice',...aliceKeys}) });
const aliceToken = aliceDev.token;
const aliceDevId = parseJwt(aliceToken).device_id;

console.log(`Bob:   userId=${bobUserId.slice(-8)}, dev1=${bob1DevId.slice(-8)} (regId=${bob1Keys.registrationId}), dev2=${bob2DevId.slice(-8)} (regId=${bob2Keys.registrationId})`);
console.log(`Alice: userId=${aliceUserId.slice(-8)}, dev=${aliceDevId.slice(-8)} (regId=${aliceKeys.registrationId})`);

// Fetch Bob's bundles
const bobBundles = await req(aliceToken, `/v1/users/${bobUserId}`);
console.log(`\nBob bundles: ${bobBundles.length}`);

// Connect both bob devices
const wsUrl = API_URL.replace('https://','wss://');

function connectWS(token, store, label) {
  return new Promise(async (resolve) => {
    const ticket = await req(token, '/v1/gateway/ticket', { method:'POST' });
    const ws = new WebSocket(`${wsUrl}/v1/gateway?ticket=${ticket.ticket}`);
    const received = [];
    ws.on('open', () => { console.log(`${label} connected`); resolve({ ws, received }); });
    ws.on('message', async (data) => {
      const frame = WSFrame.decode(new Uint8Array(data));
      const envelopes = frame.envelopeBatch?.envelopes || [];
      for (const envelope of envelopes) {
      const senderId = bytesToUuid(envelope.senderId);
      const encMsg = EncMsg.decode(envelope.message);

      // Try decrypting with (senderId, senderRegId)
      // For first message, we don't know sender's regId — try all known ones
      const regIdsToTry = [aliceKeys.registrationId, bob1Keys.registrationId, bob2Keys.registrationId, 1];
      let decrypted = null;
      let usedRegId = null;

      for (const regId of regIdsToTry) {
        const addr = new SignalProtocolAddress(senderId, regId);
        const c = new SessionCipher(store, addr);
        try {
          let plain;
          if (encMsg.type === 1) {
            plain = await c.decryptPreKeyWhisperMessage(toArrayBuffer(encMsg.content), 'binary');
          } else {
            plain = await c.decryptWhisperMessage(toArrayBuffer(encMsg.content), 'binary');
          }
          decrypted = ClientMsg.decode(new Uint8Array(plain));
          usedRegId = regId;
          break;
        } catch(e) {
          // Try next
        }
      }

      if (decrypted) {
        console.log(`  ${label} ✓ DECRYPTED (regId=${usedRegId}): "${decrypted.text}"`);
      } else {
        console.log(`  ${label} ✗ ALL DECRYPT ATTEMPTS FAILED`);
      }
      received.push({ senderId, decrypted, usedRegId });

      // ACK
      const ack = WSFrame.create({ ack: { messageIds: [envelope.id] } });
      ws.send(WSFrame.encode(ack).finish());
      }
    });
  });
}

const bob1WS = await connectWS(bob1Token, bob1Store, 'Bob1');
const bob2WS = await connectWS(bob2Token, bob2Store, 'Bob2');

await sleep(500);

// Alice sends to BOTH bob devices
console.log('\n--- Alice sends to both Bob devices ---');
for (const bundle of bobBundles) {
  // Build session with (bobUserId, bundle.registrationId)
  const addr = new SignalProtocolAddress(bobUserId, bundle.registrationId);
  const existing = await aliceStore.loadSession(addr.toString());
  if (!existing) {
    const sb = new SessionBuilder(aliceStore, addr);
    await sb.processPreKey({
      identityKey: toArrayBuffer(bundle.identityKey),
      registrationId: bundle.registrationId,
      signedPreKey: { keyId: bundle.signedPreKey.keyId, publicKey: toArrayBuffer(bundle.signedPreKey.publicKey), signature: toArrayBuffer(bundle.signedPreKey.signature) },
      preKey: bundle.oneTimePreKey ? { keyId: bundle.oneTimePreKey.keyId, publicKey: toArrayBuffer(bundle.oneTimePreKey.publicKey) } : undefined,
    });
  }
  const cipher = new SessionCipher(aliceStore, addr);
  const cm = ClientMsg.create({ type:0, text:`Hi ${bundle.deviceId.slice(-8)}!`, timestamp:Date.now() });
  const plain = ClientMsg.encode(cm).finish();
  const ct = await cipher.encrypt(toArrayBuffer(plain));
  const body = encryptBody(ct);
  const enc = EncMsg.encode(EncMsg.create({ type: ct.type===3?1:2, content:body })).finish();

  const sendRes = await fetch(`${API_URL}/v1/messages`, {
    method:'POST',
    headers: { 'Content-Type':'application/x-protobuf', 'Authorization':`Bearer ${aliceToken}`, 'Idempotency-Key':randomUUID() },
    body: SendReq.encode(SendReq.create({ messages:[{ submissionId:uuidToBytes(randomUUID()), deviceId:uuidToBytes(bundle.deviceId), message:enc }] })).finish(),
  });
  console.log(`Sent to ${bundle.deviceId.slice(-8)} (regId=${bundle.registrationId}): HTTP ${sendRes.status}`);
}

await sleep(3000);

console.log(`\nBob1 received: ${bob1WS.received.length}`);
console.log(`Bob2 received: ${bob2WS.received.length}`);

bob1WS.ws.close();
bob2WS.ws.close();
await sleep(500);

const success = bob1WS.received.length === 1 && bob2WS.received.length === 1 &&
  bob1WS.received[0].decrypted && bob2WS.received[0].decrypted;

if (success) {
  console.log('\n=== MULTI-DEVICE TEST PASSED ===\n');
} else {
  console.log('\n=== MULTI-DEVICE TEST FAILED ===\n');
  process.exit(1);
}
