// Session management for Signal Protocol encryption
// Handles X3DH key exchange and Double Ratchet encryption/decryption

import {
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
} from '@privacyresearch/libsignal-protocol-typescript';
import { signalStore } from './signalStore.js';
import client from '../api/client.js';

const SIGNAL_WHISPER_MESSAGE = 1;
const SIGNAL_PREKEY_MESSAGE = 3;
const PROTO_PREKEY_MESSAGE = 1;
const PROTO_ENCRYPTED_MESSAGE = 2;

// Convert key data to ArrayBuffer (handles byte arrays, ArrayBuffer, Uint8Array, or base64 strings)
function toArrayBuffer(input) {
  if (Array.isArray(input)) {
    return new Uint8Array(input).buffer;
  }
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  if (typeof input === 'string') {
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  throw new Error(`Cannot convert to ArrayBuffer: ${typeof input}`);
}

class SessionManager {
  constructor(store) {
    this.store = store;
    this.ciphers = new Map();
  }

  getAddress(userId, deviceId = 1) {
    return new SignalProtocolAddress(userId, deviceId);
  }

  getCipher(userId, deviceId = 1) {
    const key = `${userId}:${deviceId}`;
    if (!this.ciphers.has(key)) {
      this.ciphers.set(key, new SessionCipher(this.store, this.getAddress(userId, deviceId)));
    }
    return this.ciphers.get(key);
  }

  async hasSession(userId, deviceId = 1) {
    const session = await this.store.loadSession(this.getAddress(userId, deviceId).toString());
    return session !== undefined;
  }

  async establishSession(userId, deviceId = 1) {
    const bundle = await client.fetchPreKeyBundle(userId);

    const device = {
      identityKey: toArrayBuffer(bundle.identityKey),
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: toArrayBuffer(bundle.signedPreKey.publicKey),
        signature: toArrayBuffer(bundle.signedPreKey.signature),
      },
    };

    const otp = bundle.preKey || bundle.oneTimePreKey;
    if (otp) {
      device.preKey = {
        keyId: otp.keyId,
        publicKey: toArrayBuffer(otp.publicKey),
      };
    }

    const sessionBuilder = new SessionBuilder(this.store, this.getAddress(userId, deviceId));
    await sessionBuilder.processPreKey(device);
    return this.getCipher(userId, deviceId);
  }

  async ensureSession(userId, deviceId = 1) {
    if (await this.hasSession(userId, deviceId)) {
      return this.getCipher(userId, deviceId);
    }
    return this.establishSession(userId, deviceId);
  }

  async encrypt(userId, plaintext) {
    const cipher = await this.ensureSession(userId);

    let plaintextBuffer;
    if (plaintext instanceof ArrayBuffer) {
      plaintextBuffer = plaintext;
    } else if (plaintext instanceof Uint8Array) {
      plaintextBuffer = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength);
    } else if (typeof plaintext === 'string') {
      plaintextBuffer = new TextEncoder().encode(plaintext).buffer;
    } else {
      throw new Error('Plaintext must be ArrayBuffer, Uint8Array, or string');
    }

    const ciphertext = await cipher.encrypt(plaintextBuffer);
    const protoType = ciphertext.type === SIGNAL_PREKEY_MESSAGE ? PROTO_PREKEY_MESSAGE : PROTO_ENCRYPTED_MESSAGE;

    let bodyBytes;
    if (typeof ciphertext.body === 'string') {
      bodyBytes = new Uint8Array(ciphertext.body.length);
      for (let i = 0; i < ciphertext.body.length; i++) {
        bodyBytes[i] = ciphertext.body.charCodeAt(i);
      }
    } else if (ciphertext.body instanceof ArrayBuffer) {
      bodyBytes = new Uint8Array(ciphertext.body);
    } else if (ciphertext.body instanceof Uint8Array) {
      bodyBytes = ciphertext.body;
    } else {
      throw new Error(`Unexpected ciphertext body type: ${typeof ciphertext.body}`);
    }

    return { type: ciphertext.type, body: bodyBytes, protoType };
  }

  async decrypt(userId, content, messageType) {
    const cipher = this.getCipher(userId);

    let contentBuffer;
    if (content instanceof ArrayBuffer) {
      contentBuffer = content;
    } else if (content instanceof Uint8Array) {
      contentBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    } else if (typeof content === 'string') {
      contentBuffer = toArrayBuffer(content);
    } else {
      throw new Error('Content must be ArrayBuffer, Uint8Array, or base64 string');
    }

    if (messageType === PROTO_PREKEY_MESSAGE) {
      return cipher.decryptPreKeyWhisperMessage(contentBuffer, 'binary');
    }
    return cipher.decryptWhisperMessage(contentBuffer, 'binary');
  }

  async clearAllSessions() {
    this.ciphers.clear();
    await this.store.clearAll();
  }
}

export const sessionManager = new SessionManager(signalStore);
export default sessionManager;
