#!/usr/bin/env node
/**
 * Smoke test: Same-user device-to-device messaging via messenger.js
 * Bob1 sends DEVICE_LINK_APPROVAL to Bob2 (same userId, different devices)
 */
import '../../test/helpers/setup.js';
import { Messenger } from '../../src/v2/lib/messenger.js';
import { createStore } from '../../src/v2/lib/store.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';

const API_URL = process.env.VITE_API_URL;
if (!API_URL) { console.error('VITE_API_URL required'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toBase64(buf) { const b = new Uint8Array(buf); let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function parseJwt(t) { return JSON.parse(atob(t.split('.')[1])); }

async function req(token, path, opts={}) {
  const h = { 'Content-Type':'application/json', ...opts.headers };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${API_URL}${path}`, { ...opts, headers: h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type');
  return ct?.includes('json') ? r.json() : r.text();
}

async function genServerKeys(store) {
  const ikp = await KeyHelper.generateIdentityKeyPair();
  const rid = KeyHelper.generateRegistrationId();
  const spk = await KeyHelper.generateSignedPreKey(ikp, 1);
  const pks = [];
  for (let i=1;i<=20;i++) { const pk=await KeyHelper.generatePreKey(i); pks.push(pk); await store.storePreKey(i,pk.keyPair); }
  await store.storeIdentityKeyPair(ikp);
  await store.storeLocalRegistrationId(rid);
  await store.storeSignedPreKey(1, spk.keyPair);
  return {
    identityKey: toBase64(ikp.pubKey), registrationId: rid,
    signedPreKey: { keyId: spk.keyId, publicKey: toBase64(spk.keyPair.pubKey), signature: toBase64(spk.signature) },
    oneTimePreKeys: pks.map(p => ({ keyId: p.keyId, publicKey: toBase64(p.keyPair.pubKey) })),
  };
}

console.log('\n=== Same-User Device Messaging Test ===\n');

const pw = 'testpass12345';
const username = `sameuser_${Date.now()}`;

// Register user
const userRes = await req(null, '/v1/users', { method:'POST', body: JSON.stringify({username, password:pw}) });
const userToken = userRes.token;
const userId = parseJwt(userToken).sub;

// Create Bob1's store and messenger
const store1 = createStore(`${username}_dev1`);
const keys1 = await genServerKeys(store1);
const dev1Res = await req(userToken, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Bob1',...keys1}) });
const token1 = dev1Res.token;
const deviceId1 = parseJwt(token1).device_id;

const messenger1 = new Messenger({ apiUrl: API_URL, store: store1, token: token1 });
await messenger1.loadProto();

// Create Bob2's store and messenger
const store2 = createStore(`${username}_dev2`);
const keys2 = await genServerKeys(store2);
const dev2Res = await req(userToken, '/v1/devices', { method:'POST', body: JSON.stringify({name:'Bob2',...keys2}) });
const token2 = dev2Res.token;
const deviceId2 = parseJwt(token2).device_id;

const messenger2 = new Messenger({ apiUrl: API_URL, store: store2, token: token2 });
await messenger2.loadProto();

console.log(`User: ${userId}`);
console.log(`Bob1: deviceId=${deviceId1}, regId=${keys1.registrationId}`);
console.log(`Bob2: deviceId=${deviceId2}, regId=${keys2.registrationId}`);

// Bob1 fetches bundles (like approveLink does)
console.log('\nBob1 fetching bundles...');
const bundles = await messenger1.fetchPreKeyBundles(userId);
console.log(`  Got ${bundles.length} bundles`);
for (const b of bundles) {
  console.log(`  ${b.deviceId.slice(-8)} regId=${b.registrationId}`);
  const mapped = messenger1._deviceMap.get(b.deviceId);
  console.log(`  map: userId=${mapped?.userId?.slice(-8)}, regId=${mapped?.registrationId}`);
}

// Bob1 encrypts for Bob2
console.log('\nBob1 encrypting for Bob2...');
try {
  const plaintext = new TextEncoder().encode('approval message');
  const plainBuf = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength);
  const mapped = messenger1._deviceMap.get(deviceId2);
  console.log(`  mapped regId for bob2: ${mapped?.registrationId}`);
  const encrypted = await messenger1.encrypt(userId, plainBuf, mapped?.registrationId || 1);
  console.log(`  ✓ Encrypted: type=${encrypted.type}, bodyLen=${encrypted.body.length}`);

  // Bob2 fetches bundles to know Bob1's regId
  console.log('\nBob2 fetching bundles...');
  const bundles2 = await messenger2.fetchPreKeyBundles(userId);
  console.log(`  Got ${bundles2.length} bundles`);

  // Bob2 decrypts
  console.log('\nBob2 decrypting...');
  const decryptResult = await messenger2.decrypt(userId, encrypted.body, encrypted.protoType === 1 ? 1 : 2);
  console.log(`  ✓ Decrypted: ${new TextDecoder().decode(new Uint8Array(decryptResult.bytes))}, senderDeviceId: ${decryptResult.senderDeviceId?.slice(-8)}`);

  // Check sessions
  console.log('\nSessions:');
  for (const regId of [1, keys1.registrationId, keys2.registrationId]) {
    const s1 = await store1.loadSession(`${userId}.${regId}`);
    const s2 = await store2.loadSession(`${userId}.${regId}`);
    if (s1 || s2) {
      console.log(`  ${userId.slice(-8)}.${regId}: bob1=${!!s1}, bob2=${!!s2}`);
    }
  }

  console.log('\n=== SAME-USER MSG TEST PASSED ===\n');
} catch (e) {
  console.error('\n✗ FAILED:', e.message);

  // Debug: check sessions
  console.log('\nSessions after failure:');
  for (const regId of [1, keys1.registrationId, keys2.registrationId]) {
    const s1 = await store1.loadSession(`${userId}.${regId}`);
    const s2 = await store2.loadSession(`${userId}.${regId}`);
    if (s1 || s2) {
      console.log(`  ${userId.slice(-8)}.${regId}: bob1=${!!s1}, bob2=${!!s2}`);
    }
  }
  process.exit(1);
}
