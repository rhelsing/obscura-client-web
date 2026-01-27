/**
 * Messenger Module
 * Handles Signal encryption and message sending with fan-out + self-sync
 */

import { SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';

// Signal message type constants
const SIGNAL_PREKEY_MESSAGE = 3;
const PROTO_PREKEY_MESSAGE = 1;
const PROTO_ENCRYPTED_MESSAGE = 2;

// Message type enum (matches proto)
export const MessageType = {
  TEXT: 0,
  IMAGE: 1,
  FRIEND_REQUEST: 2,
  FRIEND_RESPONSE: 3,
  SESSION_RESET: 4,
  DEVICE_LINK_APPROVAL: 11,
  DEVICE_ANNOUNCE: 12,
  HISTORY_CHUNK: 20,
  SETTINGS_SYNC: 21,
  READ_SYNC: 22,
  SYNC_BLOB: 23,
  SENT_SYNC: 24,
};

export const MessageTypeName = Object.fromEntries(
  Object.entries(MessageType).map(([k, v]) => [v, k])
);

export class Messenger {
  constructor(opts) {
    this.apiUrl = opts.apiUrl;
    this.store = opts.store;
    this.token = opts.token;
    this.proto = null;
    this.clientProto = null;
  }

  setToken(token) {
    this.token = token;
  }

  async loadProto() {
    if (this.proto) return;

    // Dynamic import for protobuf
    const protobuf = (await import('protobufjs')).default;
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const serverProtoPath = join(__dirname, '../../../public/proto/obscura/v1/obscura.proto');
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
    this.SentSync = this.clientProto.lookupType('obscura.v2.SentSync');
    this.SyncBlob = this.clientProto.lookupType('obscura.v2.SyncBlob');
  }

  /**
   * Fetch pre-key bundle for a user
   */
  async fetchPreKeyBundle(userId) {
    const res = await fetch(`${this.apiUrl}/v1/keys/${userId}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch keys for ${userId}: ${res.status}`);
    }

    const bundle = await res.json();

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

  /**
   * Encrypt a message for a target user
   */
  async encrypt(targetUserId, plaintext) {
    const address = new SignalProtocolAddress(targetUserId, 1);
    const existingSession = await this.store.loadSession(address.toString());

    if (!existingSession) {
      const bundle = await this.fetchPreKeyBundle(targetUserId);
      const sessionBuilder = new SessionBuilder(this.store, address);
      await sessionBuilder.processPreKey(bundle);
    }

    const cipher = new SessionCipher(this.store, address);

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

    let body;
    if (ciphertext.body instanceof Uint8Array) {
      body = ciphertext.body;
    } else if (ciphertext.body instanceof ArrayBuffer) {
      body = new Uint8Array(ciphertext.body);
    } else if (typeof ciphertext.body === 'string') {
      body = new Uint8Array(ciphertext.body.length);
      for (let i = 0; i < ciphertext.body.length; i++) {
        body[i] = ciphertext.body.charCodeAt(i);
      }
    } else {
      throw new Error(`Unexpected ciphertext body type: ${typeof ciphertext.body}`);
    }

    return {
      type: ciphertext.type,
      body,
      protoType: ciphertext.type === SIGNAL_PREKEY_MESSAGE ? PROTO_PREKEY_MESSAGE : PROTO_ENCRYPTED_MESSAGE,
    };
  }

  /**
   * Decrypt a message from a source user
   */
  async decrypt(sourceUserId, content, messageType) {
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

    let bytes;
    if (decrypted instanceof ArrayBuffer) {
      bytes = new Uint8Array(decrypted);
    } else if (decrypted instanceof Uint8Array) {
      bytes = decrypted;
    } else if (typeof decrypted === 'string') {
      bytes = new Uint8Array(decrypted.length);
      for (let i = 0; i < decrypted.length; i++) {
        bytes[i] = decrypted.charCodeAt(i);
      }
    } else {
      throw new Error(`Unknown decrypted type: ${typeof decrypted}`);
    }

    return bytes;
  }

  /**
   * Encode a client message to protobuf
   */
  encodeClientMessage(opts) {
    const typeValue = typeof opts.type === 'string' ? MessageType[opts.type] : opts.type;

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

    if (typeValue === MessageType.SYNC_BLOB && opts.syncBlob) {
      msgData.syncBlob = this.SyncBlob.create({
        compressedData: opts.syncBlob.compressedData,
      });
    }

    const msg = this.ClientMessage.create(msgData);
    return this.ClientMessage.encode(msg).finish();
  }

  /**
   * Decode a client message from protobuf bytes
   */
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

    if (msg.sentSync) {
      result.sentSync = {
        conversationId: msg.sentSync.conversationId,
        messageId: msg.sentSync.messageId,
        timestamp: Number(msg.sentSync.timestamp) || 0,
        content: msg.sentSync.content,
      };
    }

    if (msg.syncBlob) {
      result.syncBlob = {
        compressedData: msg.syncBlob.compressedData,
      };
    }

    return result;
  }

  /**
   * Send an encrypted message to a target user
   */
  async sendMessage(targetUserId, opts) {
    await this.loadProto();

    const clientMsgBytes = this.encodeClientMessage(opts);
    const encrypted = await this.encrypt(targetUserId, clientMsgBytes);

    const msg = this.EncryptedMessage.create({
      type: encrypted.protoType,
      content: encrypted.body,
    });
    const protobufData = this.EncryptedMessage.encode(msg).finish();

    const res = await fetch(`${this.apiUrl}/v1/messages/${targetUserId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Authorization': `Bearer ${this.token}`,
      },
      body: protobufData,
    });

    if (!res.ok) {
      throw new Error(`Failed to send message: ${res.status}`);
    }
  }

  /**
   * Generate a unique message ID
   */
  generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// Helper functions
function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (input instanceof Uint8Array) return input.buffer;

  if (Array.isArray(input)) {
    return new Uint8Array(input).buffer;
  }

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
