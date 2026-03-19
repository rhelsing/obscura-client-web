#!/usr/bin/env node
/**
 * Local test: Can Signal decrypt a PreKey message using address (userId, 1)
 * when it was encrypted with address (userId, registrationId)?
 */
import '../../test/helpers/setup.js';
import { KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';

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

const alice = new Store();
const bob = new Store();

alice.ikp = await KeyHelper.generateIdentityKeyPair();
alice.rid = KeyHelper.generateRegistrationId();
const spkA = await KeyHelper.generateSignedPreKey(alice.ikp, 1);
await alice.storeSignedPreKey(1, spkA.keyPair);

bob.ikp = await KeyHelper.generateIdentityKeyPair();
bob.rid = KeyHelper.generateRegistrationId();
const spkB = await KeyHelper.generateSignedPreKey(bob.ikp, 1);
await bob.storeSignedPreKey(1, spkB.keyPair);
const pkB = await KeyHelper.generatePreKey(1);
await bob.storePreKey(1, pkB.keyPair);

console.log('Alice regId:', alice.rid);
console.log('Bob regId:', bob.rid);

const userId = 'fake-user-id';

// Alice encrypts with (userId, bob.regId)
const encAddr = new SignalProtocolAddress(userId, bob.rid);
const sb = new SessionBuilder(alice, encAddr);
await sb.processPreKey({
  identityKey: bob.ikp.pubKey, registrationId: bob.rid,
  signedPreKey: { keyId: 1, publicKey: spkB.keyPair.pubKey, signature: spkB.signature },
  preKey: { keyId: 1, publicKey: pkB.keyPair.pubKey },
});
const cipher = new SessionCipher(alice, encAddr);
const plainBuf = new TextEncoder().encode('hello');
const ct = await cipher.encrypt(plainBuf.buffer.slice(plainBuf.byteOffset, plainBuf.byteOffset + plainBuf.byteLength));
let body;
if (typeof ct.body === 'string') { body = new Uint8Array(ct.body.length); for(let i=0;i<ct.body.length;i++) body[i]=ct.body.charCodeAt(i); }
else body = new Uint8Array(ct.body);

console.log('\n--- Decrypt with address (userId, 1) ---');
try {
  const c2 = new SessionCipher(bob, new SignalProtocolAddress(userId, 1));
  const p = await c2.decryptPreKeyWhisperMessage(body.buffer.slice(body.byteOffset, body.byteOffset+body.byteLength), 'binary');
  console.log('SUCCESS:', new TextDecoder().decode(new Uint8Array(p)));
  console.log('Sessions:', Array.from(bob.sess.keys()));
} catch(e) {
  console.log('FAILED:', e.message);
}

console.log('\n--- Decrypt with address (userId, bob.regId) ---');
try {
  // Need fresh prekey since the first attempt may have consumed it
  const pkB2 = await KeyHelper.generatePreKey(2);
  await bob.storePreKey(2, pkB2.keyPair);

  // Re-encrypt
  const alice2 = new Store();
  alice2.ikp = await KeyHelper.generateIdentityKeyPair();
  alice2.rid = KeyHelper.generateRegistrationId();

  const encAddr2 = new SignalProtocolAddress(userId, bob.rid);
  const sb2 = new SessionBuilder(alice2, encAddr2);
  await sb2.processPreKey({
    identityKey: bob.ikp.pubKey, registrationId: bob.rid,
    signedPreKey: { keyId: 1, publicKey: spkB.keyPair.pubKey, signature: spkB.signature },
    preKey: { keyId: 2, publicKey: pkB2.keyPair.pubKey },
  });
  const cipher2 = new SessionCipher(alice2, encAddr2);
  const p2buf = new TextEncoder().encode('hello2');
  const ct2 = await cipher2.encrypt(p2buf.buffer.slice(p2buf.byteOffset, p2buf.byteOffset + p2buf.byteLength));
  let body2;
  if (typeof ct2.body === 'string') { body2 = new Uint8Array(ct2.body.length); for(let i=0;i<ct2.body.length;i++) body2[i]=ct2.body.charCodeAt(i); }
  else body2 = new Uint8Array(ct2.body);

  const c3 = new SessionCipher(bob, new SignalProtocolAddress(userId, bob.rid));
  const p2 = await c3.decryptPreKeyWhisperMessage(body2.buffer.slice(body2.byteOffset, body2.byteOffset+body2.byteLength), 'binary');
  console.log('SUCCESS:', new TextDecoder().decode(new Uint8Array(p2)));
  console.log('Sessions:', Array.from(bob.sess.keys()));
} catch(e) {
  console.log('FAILED:', e.message);
}
