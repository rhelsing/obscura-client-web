// Test client that uses REAL crypto/Signal code against real server
import './setup.js'; // Must be first - polyfills IndexedDB, crypto, etc.

import { KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In-memory Signal store (same interface as signalStore.js but uses Maps)
class InMemorySignalStore {
  constructor() {
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys = new Map();
    this.signedPreKeys = new Map();
    this.sessions = new Map();
    this.trustedIdentities = new Map();
  }

  async getIdentityKeyPair() {
    return this.identityKeyPair;
  }

  async storeIdentityKeyPair(keyPair) {
    this.identityKeyPair = keyPair;
  }

  async getLocalRegistrationId() {
    return this.registrationId;
  }

  async storeLocalRegistrationId(registrationId) {
    this.registrationId = registrationId;
  }

  async isTrustedIdentity(identifier, identityKey, direction) {
    const stored = this.trustedIdentities.get(identifier);
    if (!stored) return true; // TOFU

    const storedArray = new Uint8Array(stored.publicKey);
    const providedArray = new Uint8Array(identityKey);

    if (storedArray.length !== providedArray.length) return false;
    for (let i = 0; i < storedArray.length; i++) {
      if (storedArray[i] !== providedArray[i]) return false;
    }
    return true;
  }

  async saveIdentity(encodedAddress, publicKey) {
    const existing = this.trustedIdentities.get(encodedAddress);
    this.trustedIdentities.set(encodedAddress, {
      publicKey,
      trusted: true,
      firstSeen: existing?.firstSeen || Date.now(),
      lastSeen: Date.now(),
    });
    return !!existing; // returns true if key changed
  }

  async loadPreKey(keyId) {
    return this.preKeys.get(keyId.toString());
  }

  async storePreKey(keyId, keyPair) {
    this.preKeys.set(keyId.toString(), keyPair);
  }

  async removePreKey(keyId) {
    this.preKeys.delete(keyId.toString());
  }

  async loadSignedPreKey(keyId) {
    return this.signedPreKeys.get(keyId.toString());
  }

  async storeSignedPreKey(keyId, keyPair) {
    this.signedPreKeys.set(keyId.toString(), keyPair);
  }

  async removeSignedPreKey(keyId) {
    this.signedPreKeys.delete(keyId.toString());
  }

  async loadSession(encodedAddress) {
    return this.sessions.get(encodedAddress);
  }

  async storeSession(encodedAddress, record) {
    this.sessions.set(encodedAddress, record);
  }

  async removeSession(encodedAddress) {
    this.sessions.delete(encodedAddress);
  }

  async hasIdentity() {
    return this.identityKeyPair !== null;
  }

  async clearAll() {
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys.clear();
    this.signedPreKeys.clear();
    this.sessions.clear();
    this.trustedIdentities.clear();
  }

  // === Pre-Key Management (for replenishment testing) ===

  getPreKeyCount() {
    return this.preKeys.size;
  }

  getHighestPreKeyId() {
    const ids = Array.from(this.preKeys.keys()).map(k => parseInt(k, 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  getHighestSignedPreKeyId() {
    const ids = Array.from(this.signedPreKeys.keys()).map(k => parseInt(k, 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  deletePreKeysExcept(keepCount) {
    const ids = Array.from(this.preKeys.keys())
      .map(k => parseInt(k, 10))
      .sort((a, b) => b - a); // highest first
    const toKeep = ids.slice(0, keepCount);
    for (const id of ids) {
      if (!toKeep.includes(id)) {
        this.preKeys.delete(id.toString());
      }
    }
    return this.preKeys.size;
  }
}

// Helper functions
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function toArrayBuffer(input) {
  // Handle if already a buffer
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Uint8Array) return input.buffer;

  // Handle byte array (array of numbers) - server returns this format
  if (Array.isArray(input)) {
    return new Uint8Array(input).buffer;
  }

  // Handle base64 string
  if (typeof input === 'string') {
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  throw new Error(`Cannot convert to ArrayBuffer: ${typeof input}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomToken() {
  return Math.random().toString(36).substring(2, 12);
}

// Signal message type constants
const SIGNAL_WHISPER_MESSAGE = 1;
const SIGNAL_PREKEY_MESSAGE = 3;
const PROTO_PREKEY_MESSAGE = 1;
const PROTO_ENCRYPTED_MESSAGE = 2;

export class TestClient {
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
    this.wsUrl = apiUrl.replace('https://', 'wss://');
    this.token = null;
    this.refreshToken = null;
    this.userId = null;
    this.username = null;
    this.password = null;
    this.store = new InMemorySignalStore();
    this.ws = null;
    this.messageQueue = [];
    this.messageResolvers = [];

    // Protobuf types (loaded lazily)
    this.proto = null;
    this.clientProto = null;
  }

  async loadProto() {
    if (this.proto) return;

    const protoPath = join(__dirname, '../../public/proto/obscura/v1/obscura.proto');
    const clientProtoPath = join(__dirname, '../../public/proto/client/client_message.proto');

    this.proto = await protobuf.load(protoPath);
    this.WebSocketFrame = this.proto.lookupType('obscura.v1.WebSocketFrame');
    this.Envelope = this.proto.lookupType('obscura.v1.Envelope');
    this.EncryptedMessage = this.proto.lookupType('obscura.v1.EncryptedMessage');
    this.AckMessage = this.proto.lookupType('obscura.v1.AckMessage');

    this.clientProto = await protobuf.load(clientProtoPath);
    this.ClientMessage = this.clientProto.lookupType('obscura.client.ClientMessage');
  }

  // === Key Generation ===

  async generateKeys() {
    const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
    const registrationId = KeyHelper.generateRegistrationId();
    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

    // Generate 100 one-time pre-keys
    const preKeys = [];
    for (let i = 1; i <= 100; i++) {
      const preKey = await KeyHelper.generatePreKey(i);
      preKeys.push(preKey);
      await this.store.storePreKey(i, preKey.keyPair);
    }

    // Store keys
    await this.store.storeIdentityKeyPair(identityKeyPair);
    await this.store.storeLocalRegistrationId(registrationId);
    await this.store.storeSignedPreKey(1, signedPreKey.keyPair);

    return {
      identityKey: arrayBufferToBase64(identityKeyPair.pubKey),
      registrationId,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
        signature: arrayBufferToBase64(signedPreKey.signature),
      },
      oneTimePreKeys: preKeys.map(pk => ({
        keyId: pk.keyId,
        publicKey: arrayBufferToBase64(pk.keyPair.pubKey),
      })),
    };
  }

  // === HTTP Methods ===

  async request(path, options = {}) {
    const url = `${this.apiUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token && options.auth !== false) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  // === Auth Methods ===

  async register(username, password = 'testpass123') {
    this.username = username;
    this.password = password;

    const keys = await this.generateKeys();

    const result = await this.request('/v1/users', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({
        username,
        password,
        ...keys,
      }),
    });

    this.token = result.token;
    this.refreshToken = result.refreshToken;
    this.userId = this.parseUserId(result.token);

    console.log(`Registered user: ${username} (${this.userId})`);
    await sleep(500); // Avoid rate limiting
    return this;
  }

  async login() {
    const result = await this.request('/v1/sessions', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    this.token = result.token;
    this.refreshToken = result.refreshToken;
    this.userId = this.parseUserId(result.token);

    console.log(`Logged in: ${this.username}`);
    await sleep(500); // Avoid rate limiting
    return this;
  }

  async logout() {
    if (this.refreshToken) {
      try {
        await this.request('/v1/sessions', {
          method: 'DELETE',
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
      } catch (e) {
        // Ignore logout errors
      }
    }
    this.token = null;
    this.refreshToken = null;
    console.log(`Logged out: ${this.username}`);
  }

  parseUserId(token) {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return decoded.sub || decoded.user_id || decoded.userId || decoded.id;
  }

  // === WebSocket Methods ===

  async connectWebSocket() {
    await this.loadProto();

    return new Promise((resolve, reject) => {
      const url = `${this.wsUrl}/v1/gateway?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log(`WebSocket connected: ${this.username}`);
        resolve();
      });

      this.ws.on('error', (err) => {
        console.error(`WebSocket error: ${this.username}`, err);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log(`WebSocket closed: ${this.username}`);
      });

      this.ws.on('message', (data) => {
        this.handleWebSocketMessage(data);
      });
    });
  }

  async handleWebSocketMessage(data) {
    try {
      const frame = this.WebSocketFrame.decode(new Uint8Array(data));

      if (frame.envelope) {
        console.log(`Received envelope from: ${frame.envelope.sourceUserId}`);

        // Decrypt the message
        const decrypted = await this.decryptMessage(
          frame.envelope.sourceUserId,
          frame.envelope.message.content,
          frame.envelope.message.type
        );

        // Decode client message
        const clientMsg = this.decodeClientMessage(decrypted);

        // Add to queue
        this.messageQueue.push({
          envelopeId: frame.envelope.id,
          sourceUserId: frame.envelope.sourceUserId,
          ...clientMsg,
        });

        // Resolve any waiting promises
        if (this.messageResolvers.length > 0) {
          const resolver = this.messageResolvers.shift();
          resolver(this.messageQueue.shift());
        }

        // Ack the message
        this.acknowledge(frame.envelope.id);
      }
    } catch (err) {
      console.error('Failed to handle WebSocket message:', err);
    }
  }

  acknowledge(messageId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const frame = this.WebSocketFrame.create({
      ack: { messageId },
    });
    const buffer = this.WebSocketFrame.encode(frame).finish();
    this.ws.send(buffer);
    console.log(`Acked message: ${messageId}`);
  }

  disconnectWebSocket() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async waitForMessage(timeout = 5000) {
    // Check if we already have a message queued
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift();
    }

    // Wait for a message
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.messageResolvers.indexOf(resolve);
        if (idx >= 0) this.messageResolvers.splice(idx, 1);
        reject(new Error('Timeout waiting for message'));
      }, timeout);

      this.messageResolvers.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  // === Encryption/Decryption ===

  async fetchPreKeyBundle(userId) {
    const bundle = await this.request(`/v1/keys/${userId}`);

    return {
      identityKey: toArrayBuffer(bundle.identityKey),
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: toArrayBuffer(bundle.signedPreKey.publicKey),
        signature: toArrayBuffer(bundle.signedPreKey.signature),
      },
      preKey: bundle.preKey ? {
        keyId: bundle.preKey.keyId,
        publicKey: toArrayBuffer(bundle.preKey.publicKey),
      } : undefined,
    };
  }

  async encrypt(targetUserId, plaintext) {
    const address = new SignalProtocolAddress(targetUserId, 1);

    // Check if we have an existing session
    const existingSession = await this.store.loadSession(address.toString());

    if (!existingSession) {
      // Need to establish session with X3DH
      const bundle = await this.fetchPreKeyBundle(targetUserId);
      const sessionBuilder = new SessionBuilder(this.store, address);
      await sessionBuilder.processPreKey(bundle);
    }

    // Encrypt
    const cipher = new SessionCipher(this.store, address);

    // Ensure we have a proper ArrayBuffer
    let plaintextBuffer;
    if (typeof plaintext === 'string') {
      const encoded = new TextEncoder().encode(plaintext);
      plaintextBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    } else if (plaintext instanceof Uint8Array) {
      plaintextBuffer = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength);
    } else if (plaintext instanceof ArrayBuffer) {
      plaintextBuffer = plaintext;
    } else {
      throw new Error(`Unexpected plaintext type: ${typeof plaintext}`);
    }

    const ciphertext = await cipher.encrypt(plaintextBuffer);

    // Convert ciphertext body to Uint8Array properly
    let body;
    if (ciphertext.body instanceof Uint8Array) {
      body = ciphertext.body;
    } else if (ciphertext.body instanceof ArrayBuffer) {
      body = new Uint8Array(ciphertext.body);
    } else if (typeof ciphertext.body === 'string') {
      // Binary string from Signal library
      body = new Uint8Array(ciphertext.body.length);
      for (let i = 0; i < ciphertext.body.length; i++) {
        body[i] = ciphertext.body.charCodeAt(i);
      }
    } else {
      throw new Error(`Unexpected ciphertext body type: ${typeof ciphertext.body}`);
    }

    return {
      type: ciphertext.type,
      body: body,
      protoType: ciphertext.type === SIGNAL_PREKEY_MESSAGE ? PROTO_PREKEY_MESSAGE : PROTO_ENCRYPTED_MESSAGE,
    };
  }

  async decryptMessage(sourceUserId, content, messageType) {
    const address = new SignalProtocolAddress(sourceUserId, 1);
    const cipher = new SessionCipher(this.store, address);

    let contentBuffer;
    if (content instanceof ArrayBuffer) {
      contentBuffer = content;
    } else if (content instanceof Uint8Array) {
      contentBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    } else {
      contentBuffer = toArrayBuffer(content);
    }

    let decrypted;
    if (messageType === PROTO_PREKEY_MESSAGE) {
      decrypted = await cipher.decryptPreKeyWhisperMessage(contentBuffer, 'binary');
    } else {
      decrypted = await cipher.decryptWhisperMessage(contentBuffer, 'binary');
    }

    // Handle different return types from libsignal
    let bytes;
    if (decrypted instanceof ArrayBuffer) {
      bytes = new Uint8Array(decrypted);
    } else if (decrypted instanceof Uint8Array) {
      bytes = decrypted;
    } else if (typeof decrypted === 'string') {
      // Binary string
      bytes = new Uint8Array(decrypted.length);
      for (let i = 0; i < decrypted.length; i++) {
        bytes[i] = decrypted.charCodeAt(i);
      }
    } else {
      throw new Error(`Unknown decrypted type: ${typeof decrypted}`);
    }

    return bytes;
  }

  // === Message Encoding/Decoding ===

  encodeClientMessage(opts) {
    const typeMap = { TEXT: 0, IMAGE: 1, FRIEND_REQUEST: 2, FRIEND_RESPONSE: 3 };
    const typeValue = typeMap[opts.type] ?? 0;

    const msg = this.ClientMessage.create({
      type: typeValue,
      text: opts.text || '',
      imageData: opts.imageData || new Uint8Array(0),
      mimeType: opts.mimeType || '',
      timestamp: Date.now(),
      displayDuration: opts.displayDuration || 8,
      username: opts.username || '',
      accepted: opts.accepted || false,
    });

    return this.ClientMessage.encode(msg).finish();
  }

  decodeClientMessage(bytes) {
    const msg = this.ClientMessage.decode(bytes);
    const typeMap = ['TEXT', 'IMAGE', 'FRIEND_REQUEST', 'FRIEND_RESPONSE'];

    return {
      type: typeMap[msg.type] || 'TEXT',
      text: msg.text,
      imageData: msg.imageData,
      mimeType: msg.mimeType,
      timestamp: msg.timestamp,
      displayDuration: msg.displayDuration || 8,
      username: msg.username || '',
      accepted: msg.accepted || false,
    };
  }

  encodeOutgoingMessage(body, protoType) {
    const msg = this.EncryptedMessage.create({
      type: protoType,
      content: body,
    });
    return this.EncryptedMessage.encode(msg).finish();
  }

  // === Messaging ===

  async sendMessage(targetUserId, opts) {
    await this.loadProto();

    const clientMsgBytes = this.encodeClientMessage(opts);
    const encrypted = await this.encrypt(targetUserId, clientMsgBytes);
    const protobufData = this.encodeOutgoingMessage(encrypted.body, encrypted.protoType);

    const url = `${this.apiUrl}/v1/messages/${targetUserId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Authorization': `Bearer ${this.token}`,
      },
      body: protobufData,
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: HTTP ${response.status}`);
    }

    console.log(`Sent ${opts.type} to ${targetUserId}`);
  }

  async sendFriendRequest(targetUserId) {
    await this.sendMessage(targetUserId, {
      type: 'FRIEND_REQUEST',
      username: this.username,
    });
  }

  // === PreKey Replenishment ===

  async uploadKeys({ signedPreKey, oneTimePreKeys }) {
    return this.request('/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        signedPreKey,
        oneTimePreKeys,
      }),
    });
  }

  async generateMorePreKeys(startId, count) {
    const preKeys = [];
    for (let i = 0; i < count; i++) {
      const keyId = startId + i;
      const preKey = await KeyHelper.generatePreKey(keyId);
      preKeys.push(preKey);
      await this.store.storePreKey(keyId, preKey.keyPair);
    }
    return preKeys.map(pk => ({
      keyId: pk.keyId,
      publicKey: arrayBufferToBase64(pk.keyPair.pubKey),
    }));
  }

  async generateNewSignedPreKey() {
    const identityKeyPair = await this.store.getIdentityKeyPair();
    if (!identityKeyPair) {
      throw new Error('No identity key found');
    }

    const currentHighest = this.store.getHighestSignedPreKeyId();
    const newKeyId = currentHighest + 1;

    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, newKeyId);
    await this.store.storeSignedPreKey(newKeyId, signedPreKey.keyPair);

    return {
      keyId: signedPreKey.keyId,
      publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
      signature: arrayBufferToBase64(signedPreKey.signature),
    };
  }
}

export function randomUsername() {
  return 'test_user_' + randomToken();
}
