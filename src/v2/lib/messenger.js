/**
 * Messenger Module
 * Handles Signal encryption and message sending with fan-out + self-sync
 */

import { SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
import { logger } from './logger.js';

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
  FRIEND_SYNC: 27,
  DEVICE_LINK_APPROVAL: 11,
  DEVICE_ANNOUNCE: 12,
  DEVICE_RECOVERY_ANNOUNCE: 13,
  HISTORY_CHUNK: 20,
  SETTINGS_SYNC: 21,
  READ_SYNC: 22,
  SYNC_BLOB: 23,
  SENT_SYNC: 24,
  CONTENT_REFERENCE: 25,
  CHUNKED_CONTENT_REFERENCE: 28,
  // ORM Layer
  MODEL_SYNC: 30,
};

export const MessageTypeName = Object.fromEntries(
  Object.entries(MessageType).map(([k, v]) => [v, k])
);

export class Messenger {
  constructor(opts) {
    this.apiUrl = opts.apiUrl;
    this.store = opts.store;
    this.token = opts.token;
    this.protoBasePath = opts.protoBasePath;
    this.proto = null;
    this.clientProto = null;
  }

  setToken(token) {
    this.token = token;
  }

  async loadProto() {
    if (this.proto) return;

    const protobuf = (await import('protobufjs')).default;

    const isBrowser = typeof window !== 'undefined';
    let serverProtoPath, clientProtoPath;

    if (isBrowser) {
      // Browser: use URL paths (Vite serves from public/)
      const base = this.protoBasePath || import.meta.env?.BASE_URL || '/';
      serverProtoPath = `${base}proto/obscura/v1/obscura.proto`;
      clientProtoPath = `${base}proto/v2/client.proto`;
    } else {
      // Node.js: use filesystem paths
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      serverProtoPath = join(__dirname, '../../../public/proto/obscura/v1/obscura.proto');
      clientProtoPath = join(__dirname, '../../../public/proto/v2/client.proto');
    }

    console.log('[Messenger] loadProto:', { isBrowser, serverProtoPath, clientProtoPath });

    this.proto = await protobuf.load(serverProtoPath);
    console.log('[Messenger] Server proto loaded:', Object.keys(this.proto.nested || {}));
    this.WebSocketFrame = this.proto.lookupType('obscura.v1.WebSocketFrame');
    this.Envelope = this.proto.lookupType('obscura.v1.Envelope');
    this.EncryptedMessage = this.proto.lookupType('obscura.v1.EncryptedMessage');
    this.AckMessage = this.proto.lookupType('obscura.v1.AckMessage');

    this.clientProto = await protobuf.load(clientProtoPath);
    console.log('[Messenger] Client proto loaded:', Object.keys(this.clientProto.nested || {}));
    this.ClientMessage = this.clientProto.lookupType('obscura.v2.ClientMessage');
    this.DeviceInfo = this.clientProto.lookupType('obscura.v2.DeviceInfo');
    this.DeviceLinkApproval = this.clientProto.lookupType('obscura.v2.DeviceLinkApproval');
    this.DeviceAnnounce = this.clientProto.lookupType('obscura.v2.DeviceAnnounce');
    try {
      this.DeviceRecoveryAnnounce = this.clientProto.lookupType('obscura.v2.DeviceRecoveryAnnounce');
    } catch (e) {
      console.warn('[Messenger] DeviceRecoveryAnnounce not found in proto, recovery announce disabled');
      this.DeviceRecoveryAnnounce = null;
    }
    this.SentSync = this.clientProto.lookupType('obscura.v2.SentSync');
    this.SyncBlob = this.clientProto.lookupType('obscura.v2.SyncBlob');
    this.ContentReference = this.clientProto.lookupType('obscura.v2.ContentReference');
    this.ChunkedContentReference = this.clientProto.lookupType('obscura.v2.ChunkedContentReference');
    this.ChunkInfo = this.clientProto.lookupType('obscura.v2.ChunkInfo');
    this.ModelSync = this.clientProto.lookupType('obscura.v2.ModelSync');
    this.FriendSync = this.clientProto.lookupType('obscura.v2.FriendSync');
    console.log('[Messenger] Proto loading complete. Types:', {
      WebSocketFrame: !!this.WebSocketFrame,
      ClientMessage: !!this.ClientMessage,
      ModelSync: !!this.ModelSync,
    });
  }

  /**
   * Fetch pre-key bundle for a user
   */
  async fetchPreKeyBundle(userId) {
    let res;
    try {
      res = await fetch(`${this.apiUrl}/v1/keys/${userId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
    } catch (e) {
      await logger.logPrekeyFetchError(userId, e, null);
      throw e;
    }

    if (!res.ok) {
      const error = new Error(`Failed to fetch keys for ${userId}: ${res.status}`);
      await logger.logPrekeyFetchError(userId, error, res.status);
      throw error;
    }

    const bundle = await res.json();
    await logger.logPrekeyFetch(userId, !!bundle.preKey, bundle.registrationId);

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
      await logger.logSessionEstablish(targetUserId, !!bundle.preKey);
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

    // Check if session exists
    const hasSession = await this.store.loadSession(address.toString());

    let contentBuffer;
    if (content instanceof ArrayBuffer) {
      contentBuffer = content;
    } else if (content instanceof Uint8Array) {
      contentBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    } else {
      contentBuffer = toArrayBuffer(content);
    }

    let decrypted;
    try {
      if (messageType === PROTO_PREKEY_MESSAGE) {
        console.log('[Messenger] Decrypting PreKey:', {
          sourceUserId: sourceUserId?.slice(-8),
          contentSize: contentBuffer?.byteLength,
          hasSession: !!hasSession,
        });
        decrypted = await cipher.decryptPreKeyWhisperMessage(contentBuffer, 'binary');
      } else {
        decrypted = await cipher.decryptWhisperMessage(contentBuffer, 'binary');
      }
    } catch (e) {
      // Add diagnostic info for sending chain errors
      if (e.message?.includes('sending chain')) {
        const msgTypeName = messageType === PROTO_PREKEY_MESSAGE ? 'PreKey' : 'Whisper';
        await logger.logDecryptError(sourceUserId, e, msgTypeName, true);
        console.warn('[Messenger] Decrypt error - sending chain issue:', {
          sourceUserId: sourceUserId?.slice(-8),
          messageType: msgTypeName,
          hasSession: !!hasSession,
          error: e.message,
        });
        // Re-throw with more context
        const err = new Error(`Sending chain error from ${sourceUserId?.slice(-8)} (type=${messageType}, session=${!!hasSession})`);
        err.name = 'SendingChainError';
        err.originalError = e;
        throw err;
      }
      // Log other decrypt errors too
      const msgTypeName = messageType === PROTO_PREKEY_MESSAGE ? 'PreKey' : 'Whisper';
      await logger.logDecryptError(sourceUserId, e, msgTypeName, false);
      throw e;
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
        recoveryPublicKey: opts.deviceAnnounce.recoveryPublicKey || new Uint8Array(0),
      });
    }

    if (typeValue === MessageType.DEVICE_RECOVERY_ANNOUNCE && opts.deviceRecoveryAnnounce && this.DeviceRecoveryAnnounce) {
      msgData.deviceRecoveryAnnounce = this.DeviceRecoveryAnnounce.create({
        newDevices: (opts.deviceRecoveryAnnounce.newDevices || []).map(d => this.DeviceInfo.create({
          deviceUuid: d.deviceUUID || d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: opts.deviceRecoveryAnnounce.timestamp || Date.now(),
        isFullRecovery: opts.deviceRecoveryAnnounce.isFullRecovery || false,
        signature: opts.deviceRecoveryAnnounce.signature || new Uint8Array(0),
        recoveryPublicKey: opts.deviceRecoveryAnnounce.recoveryPublicKey || new Uint8Array(0),
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

    if (typeValue === MessageType.CONTENT_REFERENCE && opts.contentReference) {
      msgData.contentReference = this.ContentReference.create({
        attachmentId: opts.contentReference.attachmentId,
        contentKey: opts.contentReference.contentKey,
        nonce: opts.contentReference.nonce,
        contentHash: opts.contentReference.contentHash,
        contentType: opts.contentReference.contentType || '',
        sizeBytes: opts.contentReference.sizeBytes || 0,
        fileName: opts.contentReference.fileName || '',
      });
    }

    if (typeValue === MessageType.CHUNKED_CONTENT_REFERENCE && opts.chunkedContentReference) {
      msgData.chunkedContentReference = this.ChunkedContentReference.create({
        fileId: opts.chunkedContentReference.fileId,
        chunks: opts.chunkedContentReference.chunks.map(c => this.ChunkInfo.create({
          index: c.index,
          attachmentId: c.attachmentId,
          contentKey: c.contentKey,
          nonce: c.nonce,
          chunkHash: c.chunkHash,
          sizeBytes: c.sizeBytes || 0,
        })),
        completeHash: opts.chunkedContentReference.completeHash,
        contentType: opts.chunkedContentReference.contentType || '',
        totalSizeBytes: opts.chunkedContentReference.totalSizeBytes || 0,
        fileName: opts.chunkedContentReference.fileName || '',
      });
    }

    if (typeValue === MessageType.MODEL_SYNC && opts.modelSync) {
      msgData.modelSync = this.ModelSync.create({
        model: opts.modelSync.model,
        id: opts.modelSync.id,
        op: opts.modelSync.op || 0,
        timestamp: opts.modelSync.timestamp || Date.now(),
        data: opts.modelSync.data instanceof Uint8Array
          ? opts.modelSync.data
          : typeof opts.modelSync.data === 'string'
            ? new TextEncoder().encode(opts.modelSync.data)
            : new TextEncoder().encode(JSON.stringify(opts.modelSync.data)),
        signature: opts.modelSync.signature || new Uint8Array(0),
        authorDeviceId: opts.modelSync.authorDeviceId || '',
      });
    }

    if (typeValue === MessageType.FRIEND_SYNC && opts.friendSync) {
      msgData.friendSync = this.FriendSync.create({
        username: opts.friendSync.username,
        action: opts.friendSync.action,
        status: opts.friendSync.status || 'accepted',
        devices: (opts.friendSync.devices || []).map(d => this.DeviceInfo.create({
          deviceUuid: d.deviceUUID || d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: opts.friendSync.timestamp || Date.now(),
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
        recoveryPublicKey: msg.deviceAnnounce.recoveryPublicKey,
      };
    }

    if (msg.deviceRecoveryAnnounce) {
      result.deviceRecoveryAnnounce = {
        newDevices: (msg.deviceRecoveryAnnounce.newDevices || []).map(d => ({
          deviceUUID: d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: Number(msg.deviceRecoveryAnnounce.timestamp) || 0,
        isFullRecovery: msg.deviceRecoveryAnnounce.isFullRecovery || false,
        signature: msg.deviceRecoveryAnnounce.signature,
        recoveryPublicKey: msg.deviceRecoveryAnnounce.recoveryPublicKey,
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

    if (msg.contentReference) {
      result.contentReference = {
        attachmentId: msg.contentReference.attachmentId,
        contentKey: msg.contentReference.contentKey,
        nonce: msg.contentReference.nonce,
        contentHash: msg.contentReference.contentHash,
        contentType: msg.contentReference.contentType || '',
        sizeBytes: Number(msg.contentReference.sizeBytes) || 0,
        fileName: msg.contentReference.fileName || '',
      };
    }

    if (msg.chunkedContentReference) {
      result.chunkedContentReference = {
        fileId: msg.chunkedContentReference.fileId,
        chunks: (msg.chunkedContentReference.chunks || []).map(c => ({
          index: c.index,
          attachmentId: c.attachmentId,
          contentKey: c.contentKey,
          nonce: c.nonce,
          chunkHash: c.chunkHash,
          sizeBytes: Number(c.sizeBytes) || 0,
        })),
        completeHash: msg.chunkedContentReference.completeHash,
        contentType: msg.chunkedContentReference.contentType || '',
        totalSizeBytes: Number(msg.chunkedContentReference.totalSizeBytes) || 0,
        fileName: msg.chunkedContentReference.fileName || '',
      };
    }

    if (msg.modelSync) {
      result.modelSync = {
        model: msg.modelSync.model,
        id: msg.modelSync.id,
        op: msg.modelSync.op,
        timestamp: Number(msg.modelSync.timestamp) || 0,
        data: msg.modelSync.data,
        signature: msg.modelSync.signature,
        authorDeviceId: msg.modelSync.authorDeviceId || '',
      };
    }

    if (msg.friendSync) {
      result.friendSync = {
        username: msg.friendSync.username,
        action: msg.friendSync.action,
        status: msg.friendSync.status || 'accepted',
        devices: (msg.friendSync.devices || []).map(d => ({
          deviceUUID: d.deviceUuid,
          serverUserId: d.serverUserId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: Number(msg.friendSync.timestamp) || 0,
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
