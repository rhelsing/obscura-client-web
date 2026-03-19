#!/usr/bin/env node
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
const API = process.env.VITE_API_URL;
const pw = 'testpass12345';
const un = 'takeover_' + Date.now();
function toBase64(b){const a=new Uint8Array(b);let s='';for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);}
function jwt(t){return JSON.parse(atob(t.split('.')[1]));}

let r = await(await fetch(API+'/v1/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:un,password:pw})})).json();
const userToken = r.token;

const ikp1 = await KeyHelper.generateIdentityKeyPair();
const spk1 = await KeyHelper.generateSignedPreKey(ikp1, 1);
const pk1 = await KeyHelper.generatePreKey(1);
r = await(await fetch(API+'/v1/devices',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+userToken},body:JSON.stringify({name:'D1',identityKey:toBase64(ikp1.pubKey),registrationId:KeyHelper.generateRegistrationId(),signedPreKey:{keyId:1,publicKey:toBase64(spk1.keyPair.pubKey),signature:toBase64(spk1.signature)},oneTimePreKeys:[{keyId:1,publicKey:toBase64(pk1.keyPair.pubKey)}]})})).json();
const dev1Token = r.token;
const dev1Id = jwt(dev1Token).device_id;
console.log('Device 1:', dev1Id);

// Upload backup (min 32 bytes per spec)
const backupData = new Uint8Array(100);
crypto.getRandomValues(backupData);
let res = await fetch(API+'/v1/backup',{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':'100','Authorization':'Bearer '+dev1Token,'If-None-Match':'*'},body:backupData});
console.log('Upload:', res.status, 'etag:', res.headers.get('etag'));

res = await fetch(API+'/v1/backup',{method:'HEAD',headers:{'Authorization':'Bearer '+dev1Token}});
console.log('HEAD dev1:', res.status);

// Device takeover with new keys
console.log('\n--- Device Takeover ---');
const ikp2 = await KeyHelper.generateIdentityKeyPair();
const spk2 = await KeyHelper.generateSignedPreKey(ikp2, 1);
const pk2 = await KeyHelper.generatePreKey(1);

r = await(await fetch(API+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:un,password:pw,deviceId:dev1Id})})).json();
const takeoverToken = r.token;
console.log('Login with dev1Id:', jwt(takeoverToken).device_id === dev1Id);

res = await fetch(API+'/v1/devices/keys',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+takeoverToken},body:JSON.stringify({identityKey:toBase64(ikp2.pubKey),registrationId:KeyHelper.generateRegistrationId(),signedPreKey:{keyId:2,publicKey:toBase64(spk2.keyPair.pubKey),signature:toBase64(spk2.signature)},oneTimePreKeys:[{keyId:2,publicKey:toBase64(pk2.keyPair.pubKey)}]})});
console.log('Takeover:', res.status);

// Re-login to get fresh token
r = await(await fetch(API+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:un,password:pw,deviceId:dev1Id})})).json();
const freshToken = r.token;

res = await fetch(API+'/v1/backup',{method:'HEAD',headers:{'Authorization':'Bearer '+freshToken}});
console.log('HEAD after takeover:', res.status);

if (res.status === 200) {
  res = await fetch(API+'/v1/backup',{method:'GET',headers:{'Authorization':'Bearer '+freshToken}});
  const data = new Uint8Array(await res.arrayBuffer());
  console.log('Downloaded:', data.length, 'bytes, matches:', data.every((b,i) => b === backupData[i]));
  console.log('\n=== DEVICE TAKEOVER + BACKUP: PASSED ===');
} else {
  console.log('\n=== BACKUP NOT ACCESSIBLE AFTER TAKEOVER ===');
  // Check if takeover purges backup (per OpenAPI: "Deletes ALL pending messages")
  // The spec says takeover deletes keys + messages, but doesn't mention backup
}
