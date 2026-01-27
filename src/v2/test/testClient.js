// v2 Test client that uses REAL crypto/Signal code against real server
// Uses v2 proto with proper nested message structs
import '../../../test/helpers/setup.js'; // Must be first - polyfills IndexedDB, crypto, etc.

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

// v2 Message Type enum values (must match proto)
const MessageType = {
  TEXT: 0,
  IMAGE: 1,
  FRIEND_REQUEST: 2,
  FRIEND_RESPONSE: 3,
  SESSION_RESET: 4,
  // Note: 10 skipped - link "request" is out-of-band (QR/link code)
  DEVICE_LINK_APPROVAL: 11,
  DEVICE_ANNOUNCE: 12,
  HISTORY_CHUNK: 20,
  SETTINGS_SYNC: 21,
  READ_SYNC: 22,
  SYNC_BLOB: 23,
  SENT_SYNC: 24,
};

// Reverse map for decoding
const MessageTypeName = Object.fromEntries(
  Object.entries(MessageType).map(([k, v]) => [v, k])
);

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

    // Level 2: Friend tracking (no cheating!)
    // Map of username -> { username, devices: [{ serverUserId, ... }], status: 'pending'|'accepted' }
    this.friends = new Map();

    // This device's info (for sharing in friend requests)
    this.deviceInfo = null;

    // Level 2: Own device tracking (for self-sync)
    // Array of { serverUserId, deviceName, ... } - other devices belonging to same user
    this.ownDevices = [];

    // Message history (for sync verification)
    this.messages = [];
  }

  // === Level 2: Friend Management ===

  /**
   * Get this client's device info for sharing in friend requests
   */
  getMyDeviceInfo() {
    if (!this.deviceInfo) {
      throw new Error('Device not registered yet');
    }
    return this.deviceInfo;
  }

  /**
   * Get all device userIds for a friend (for fan-out)
   * @param {string} friendUsername - Friend's username
   * @returns {string[]} Array of serverUserIds to send to
   */
  getFanOutTargets(friendUsername) {
    const friend = this.friends.get(friendUsername);
    if (!friend) {
      throw new Error(`Not friends with ${friendUsername}`);
    }
    if (friend.status !== 'accepted') {
      throw new Error(`Friend request with ${friendUsername} not yet accepted`);
    }
    if (!friend.devices || friend.devices.length === 0) {
      throw new Error(`No devices known for ${friendUsername}`);
    }
    return friend.devices.map(d => d.serverUserId);
  }

  /**
   * Store a friend (from FRIEND_RESPONSE or after sending accepted response)
   */
  storeFriend(username, devices, status = 'accepted') {
    this.friends.set(username, {
      username,
      devices,
      status,
      addedAt: Date.now(),
    });
    console.log(`  [Friends] Stored ${username} with ${devices.length} device(s), status: ${status}`);
  }

  /**
   * Get a friend by username
   */
  getFriend(username) {
    return this.friends.get(username);
  }

  /**
   * Check if we're friends with someone
   */
  isFriendsWith(username) {
    const friend = this.friends.get(username);
    return friend && friend.status === 'accepted';
  }

  // === Level 2: Own Device Management (for self-sync) ===

  /**
   * Add an own device (from DEVICE_LINK_APPROVAL or manual setup)
   * @param {object} deviceInfo - { serverUserId, deviceName, ... }
   */
  addOwnDevice(deviceInfo) {
    // Don't add self
    if (deviceInfo.serverUserId === this.userId) {
      return;
    }
    // Don't add duplicates
    const existing = this.ownDevices.find(d => d.serverUserId === deviceInfo.serverUserId);
    if (!existing) {
      this.ownDevices.push(deviceInfo);
      console.log(`  [OwnDevices] Added ${deviceInfo.deviceName || deviceInfo.serverUserId}`);
    }
  }

  /**
   * Set all own devices (from DEVICE_LINK_APPROVAL)
   * @param {Array} devices - Array of device info objects
   */
  setOwnDevices(devices) {
    this.ownDevices = devices.filter(d => d.serverUserId !== this.userId);
    console.log(`  [OwnDevices] Set ${this.ownDevices.length} other device(s)`);
  }

  /**
   * Get serverUserIds of own devices for self-sync fan-out
   * @returns {string[]} Array of serverUserIds (excluding self)
   */
  getOwnFanOutTargets() {
    return this.ownDevices.map(d => d.serverUserId);
  }

  /**
   * Process a SENT_SYNC message (add to local history as "sent by me")
   * @param {object} msg - Decoded message with sentSync field
   */
  processSentSync(msg) {
    const sentSync = msg.sentSync;
    this.messages.push({
      conversationId: sentSync.conversationId,
      messageId: sentSync.messageId,
      timestamp: Number(sentSync.timestamp),
      content: sentSync.content,
      isSent: true, // KEY: this is a message WE sent, not received
    });
    console.log(`  [SentSync] Added sent message to ${sentSync.conversationId}`);
  }

  /**
   * Generate a unique message ID
   * @returns {string} Unique message ID
   */
  generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async loadProto() {
    if (this.proto) return;

    // Server proto (v1 - for WebSocketFrame, EncryptedMessage)
    const serverProtoPath = join(__dirname, '../../../public/proto/obscura/v1/obscura.proto');
    // Client proto (v2 - unified client messages)
    const clientProtoPath = join(__dirname, '../proto/client.proto');

    this.proto = await protobuf.load(serverProtoPath);
    this.WebSocketFrame = this.proto.lookupType('obscura.v1.WebSocketFrame');
    this.Envelope = this.proto.lookupType('obscura.v1.Envelope');
    this.EncryptedMessage = this.proto.lookupType('obscura.v1.EncryptedMessage');
    this.AckMessage = this.proto.lookupType('obscura.v1.AckMessage');

    this.clientProto = await protobuf.load(clientProtoPath);
    this.ClientMessage = this.clientProto.lookupType('obscura.v2.ClientMessage');
    this.DeviceInfo = this.clientProto.lookupType('obscura.v2.DeviceInfo');
    this.DeviceLinkApproval = this.clientProto.lookupType('obscura.v2.DeviceLinkApproval');
    this.DeviceAnnounce = this.clientProto.lookupType('obscura.v2.DeviceAnnounce');
    this.HistoryChunk = this.clientProto.lookupType('obscura.v2.HistoryChunk');
    this.MessageEntry = this.clientProto.lookupType('obscura.v2.MessageEntry');
    this.SyncBlob = this.clientProto.lookupType('obscura.v2.SyncBlob');
    this.SentSync = this.clientProto.lookupType('obscura.v2.SentSync');
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

    // Store this device's info for Level 2 friend exchange
    const identityKeyPair = await this.store.getIdentityKeyPair();
    this.deviceInfo = {
      serverUserId: this.userId,
      username: this.username,
      signalIdentityKey: new Uint8Array(identityKeyPair.pubKey),
    };

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
      // Suppress MessageCounterError - happens when server redelivers already-processed messages
      // (Signal replay protection correctly rejects these)
      if (err.name === 'MessageCounterError') {
        console.log(`[Ignoring stale message: ${err.message}]`);
      } else {
        console.error('Failed to handle WebSocket message:', err);
      }
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

  // === Message Encoding/Decoding (v2 with proper nested structs) ===

  encodeClientMessage(opts) {
    const typeValue = typeof opts.type === 'string' ? MessageType[opts.type] : opts.type;

    // Build base message
    const msgData = {
      type: typeValue,
      timestamp: opts.timestamp || Date.now(),
      text: opts.text || '',
      mimeType: opts.mimeType || '',
      displayDuration: opts.displayDuration || 8,
      attachmentId: opts.attachmentId || '',
      attachmentExpires: opts.attachmentExpires || 0,
      username: opts.username || '',
      accepted: opts.accepted || false,
      resetReason: opts.resetReason || '',
    };

    // Add nested structs based on type
    if (typeValue === MessageType.DEVICE_LINK_APPROVAL && opts.deviceLinkApproval) {
      msgData.deviceLinkApproval = this.DeviceLinkApproval.create({
        p2pPublicKey: opts.deviceLinkApproval.p2pPublicKey,
        p2pPrivateKey: opts.deviceLinkApproval.p2pPrivateKey,
        recoveryPublicKey: opts.deviceLinkApproval.recoveryPublicKey,
        challengeResponse: opts.deviceLinkApproval.challengeResponse,
        ownDevices: (opts.deviceLinkApproval.ownDevices || []).map(d => this.DeviceInfo.create({
          deviceUuid: d.deviceUUID || d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        friendsExport: opts.deviceLinkApproval.friendsExport || new Uint8Array(0),
        sessionsExport: opts.deviceLinkApproval.sessionsExport || new Uint8Array(0),
        trustedIdsExport: opts.deviceLinkApproval.trustedIdsExport || new Uint8Array(0),
      });
    }

    // deviceAnnounce can be included in DEVICE_ANNOUNCE, FRIEND_REQUEST, or FRIEND_RESPONSE
    if (opts.deviceAnnounce) {
      msgData.deviceAnnounce = this.DeviceAnnounce.create({
        devices: (opts.deviceAnnounce.devices || []).map(d => this.DeviceInfo.create({
          deviceUuid: d.deviceUUID || d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: opts.deviceAnnounce.timestamp || Date.now(),
        isRevocation: opts.deviceAnnounce.isRevocation || false,
        signature: opts.deviceAnnounce.signature || new Uint8Array(0),
      });
    }

    if (typeValue === MessageType.HISTORY_CHUNK && opts.historyChunk) {
      msgData.historyChunk = this.HistoryChunk.create({
        entries: (opts.historyChunk.entries || []).map(e => this.MessageEntry.create({
          messageId: e.messageId,
          timestamp: e.timestamp,
          content: e.content,
          authorDeviceId: e.authorDeviceId,
          signature: e.signature,
        })),
        isFinal: opts.historyChunk.isFinal || false,
      });
    }

    if (typeValue === MessageType.SETTINGS_SYNC && opts.settingsData) {
      msgData.settingsData = opts.settingsData;
    }

    if (typeValue === MessageType.READ_SYNC && opts.readMessageId) {
      msgData.readMessageId = opts.readMessageId;
    }

    if (typeValue === MessageType.SYNC_BLOB && opts.syncBlob) {
      msgData.syncBlob = this.SyncBlob.create({
        compressedData: opts.syncBlob.compressedData,
      });
    }

    if (typeValue === MessageType.SENT_SYNC && opts.sentSync) {
      msgData.sentSync = this.SentSync.create({
        conversationId: opts.sentSync.conversationId,
        messageId: opts.sentSync.messageId,
        timestamp: opts.sentSync.timestamp,
        content: typeof opts.sentSync.content === 'string'
          ? new TextEncoder().encode(opts.sentSync.content)
          : opts.sentSync.content,
      });
    }

    const msg = this.ClientMessage.create(msgData);
    return this.ClientMessage.encode(msg).finish();
  }

  decodeClientMessage(bytes) {
    const msg = this.ClientMessage.decode(bytes);
    const typeName = MessageTypeName[msg.type] || 'TEXT';

    const result = {
      type: typeName,
      timestamp: Number(msg.timestamp) || 0,
      text: msg.text || '',
      mimeType: msg.mimeType || '',
      displayDuration: msg.displayDuration || 8,
      attachmentId: msg.attachmentId || '',
      attachmentExpires: Number(msg.attachmentExpires) || 0,
      username: msg.username || '',
      accepted: msg.accepted || false,
      resetReason: msg.resetReason || '',
    };

    // Extract nested structs
    if (msg.deviceLinkApproval) {
      result.deviceLinkApproval = {
        p2pPublicKey: msg.deviceLinkApproval.p2pPublicKey,
        p2pPrivateKey: msg.deviceLinkApproval.p2pPrivateKey,
        recoveryPublicKey: msg.deviceLinkApproval.recoveryPublicKey,
        challengeResponse: msg.deviceLinkApproval.challengeResponse,
        ownDevices: (msg.deviceLinkApproval.ownDevices || []).map(d => ({
          deviceUUID: d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        friendsExport: msg.deviceLinkApproval.friendsExport,
        sessionsExport: msg.deviceLinkApproval.sessionsExport,
        trustedIdsExport: msg.deviceLinkApproval.trustedIdsExport,
      };
    }

    if (msg.deviceAnnounce) {
      result.deviceAnnounce = {
        devices: (msg.deviceAnnounce.devices || []).map(d => ({
          deviceUUID: d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: Number(msg.deviceAnnounce.timestamp) || 0,
        isRevocation: msg.deviceAnnounce.isRevocation || false,
        signature: msg.deviceAnnounce.signature,
      };
    }

    if (msg.historyChunk) {
      result.historyChunk = {
        entries: (msg.historyChunk.entries || []).map(e => ({
          messageId: e.messageId,
          timestamp: Number(e.timestamp) || 0,
          content: e.content,
          authorDeviceId: e.authorDeviceId,
          signature: e.signature,
        })),
        isFinal: msg.historyChunk.isFinal || false,
      };
    }

    if (msg.settingsData && msg.settingsData.length > 0) {
      result.settingsData = msg.settingsData;
    }

    if (msg.readMessageId) {
      result.readMessageId = msg.readMessageId;
    }

    if (msg.syncBlob) {
      result.syncBlob = {
        compressedData: msg.syncBlob.compressedData,
      };
    }

    if (msg.sentSync) {
      result.sentSync = {
        conversationId: msg.sentSync.conversationId,
        messageId: msg.sentSync.messageId,
        timestamp: Number(msg.sentSync.timestamp) || 0,
        content: msg.sentSync.content,
      };
    }

    return result;
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

    const typeName = typeof opts.type === 'string' ? opts.type : MessageTypeName[opts.type];
    console.log(`Sent ${typeName} to ${targetUserId}`);
  }

  /**
   * Send FRIEND_REQUEST with our device info (Level 2 compliant)
   * Per protocol-spec: Includes sender's device list so recipient knows where to respond
   */
  async sendFriendRequest(targetUserId, targetUsername) {
    // Include our device info so recipient knows our devices
    const myDeviceAnnounce = {
      devices: [{
        deviceUUID: this.userId, // Using userId as device identifier for now
        serverUserId: this.userId,
        deviceName: this.username,
        signalIdentityKey: this.deviceInfo.signalIdentityKey,
      }],
      timestamp: Date.now(),
      isRevocation: false,
      signature: new Uint8Array(64), // Placeholder - would be signed in real impl
    };

    await this.sendMessage(targetUserId, {
      type: 'FRIEND_REQUEST',
      username: this.username,
      deviceAnnounce: myDeviceAnnounce,
    });

    // Mark as pending friend
    this.friends.set(targetUsername, {
      username: targetUsername,
      devices: [], // Don't know their devices yet
      status: 'pending_outgoing',
      addedAt: Date.now(),
    });

    console.log(`  [Friends] Sent FRIEND_REQUEST to ${targetUsername}`);
  }

  /**
   * Send FRIEND_RESPONSE with our device info (Level 2 compliant)
   * Per protocol-spec: If accepted, includes our device list
   */
  async sendFriendResponse(targetUserId, targetUsername, accepted) {
    const myDeviceAnnounce = accepted ? {
      devices: [{
        deviceUUID: this.userId,
        serverUserId: this.userId,
        deviceName: this.username,
        signalIdentityKey: this.deviceInfo.signalIdentityKey,
      }],
      timestamp: Date.now(),
      isRevocation: false,
      signature: new Uint8Array(64),
    } : null;

    await this.sendMessage(targetUserId, {
      type: 'FRIEND_RESPONSE',
      username: this.username,
      accepted,
      deviceAnnounce: myDeviceAnnounce,
    });

    if (accepted) {
      // Get their devices from the pending request we stored
      const pending = this.friends.get(targetUsername);
      if (pending && pending.devices) {
        this.storeFriend(targetUsername, pending.devices, 'accepted');
      }
    }

    console.log(`  [Friends] Sent FRIEND_RESPONSE (${accepted ? 'accepted' : 'rejected'}) to ${targetUsername}`);
  }

  /**
   * Process incoming FRIEND_REQUEST
   * Returns the parsed request for the test to decide how to respond
   */
  processFriendRequest(msg) {
    const senderUsername = msg.username;
    const senderDevices = msg.deviceAnnounce?.devices || [];

    // Store as pending incoming
    this.friends.set(senderUsername, {
      username: senderUsername,
      devices: senderDevices.map(d => ({
        serverUserId: d.serverUserId,
        deviceName: d.deviceName,
        signalIdentityKey: d.signalIdentityKey,
      })),
      status: 'pending_incoming',
      addedAt: Date.now(),
    });

    console.log(`  [Friends] Received FRIEND_REQUEST from ${senderUsername} (${senderDevices.length} device(s))`);

    return {
      username: senderUsername,
      devices: senderDevices,
      sourceUserId: msg.sourceUserId,
    };
  }

  /**
   * Process incoming FRIEND_RESPONSE
   * Updates friend status and stores their devices
   */
  processFriendResponse(msg) {
    const senderUsername = msg.username;
    const accepted = msg.accepted;
    const senderDevices = msg.deviceAnnounce?.devices || [];

    if (accepted) {
      this.storeFriend(senderUsername, senderDevices.map(d => ({
        serverUserId: d.serverUserId,
        deviceName: d.deviceName,
        signalIdentityKey: d.signalIdentityKey,
      })), 'accepted');
      console.log(`  [Friends] ${senderUsername} ACCEPTED friend request (${senderDevices.length} device(s))`);
    } else {
      this.friends.delete(senderUsername);
      console.log(`  [Friends] ${senderUsername} REJECTED friend request`);
    }

    return { username: senderUsername, accepted, devices: senderDevices };
  }

  /**
   * Send message to a friend using their device list (Level 2 - no cheating!)
   * Fans out to all their devices AND syncs to own devices
   */
  async sendToFriend(friendUsername, opts) {
    const targets = this.getFanOutTargets(friendUsername);
    const messageId = this.generateMessageId();
    const timestamp = Date.now();

    // Send to friend's devices
    for (const targetUserId of targets) {
      await this.sendMessage(targetUserId, opts);
    }

    // Store locally as sent message
    this.messages.push({
      conversationId: friendUsername,
      messageId,
      timestamp,
      content: opts.text || opts.content,
      isSent: true,
    });

    // Self-sync: send SENT_SYNC to own devices (Level 2 compliant)
    const ownTargets = this.getOwnFanOutTargets();
    if (ownTargets.length > 0) {
      for (const targetUserId of ownTargets) {
        await this.sendMessage(targetUserId, {
          type: 'SENT_SYNC',
          sentSync: {
            conversationId: friendUsername,
            messageId,
            timestamp,
            content: opts.text || opts.content,
          },
        });
      }
      console.log(`  [SentSync] Synced to ${ownTargets.length} own device(s)`);
    }

    console.log(`  [Friends] Sent ${opts.type} to ${friendUsername} (${targets.length} device(s))`);
  }

  // === Attachments ===

  async uploadAttachment(blob) {
    const url = `${this.apiUrl}/v1/attachments`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${this.token}`,
      },
      body: blob,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return response.json(); // { id, expiresAt }
  }

  async fetchAttachment(id) {
    const url = `${this.apiUrl}/v1/attachments/${id}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return response.blob();
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

// Export message type constants for tests
export { MessageType, MessageTypeName };
