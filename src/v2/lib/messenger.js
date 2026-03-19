/**
 * Messenger Module
 * Handles Signal encryption and message sending with fan-out + self-sync
 */

import { SessionBuilder, SessionCipher, SignalProtocolAddress } from '@privacyresearch/libsignal-protocol-typescript';
import { logger } from './logger.js';
import { uuidToBytes, generateDeviceUUID } from '../crypto/uuid.js';

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
    this.ownUserId = opts.ownUserId || null; // For fallback userId resolution
    this.protoBasePath = opts.protoBasePath;
    this.proto = null;
    this.clientProto = null;
    this._queue = []; // Pending submissions for batch sending
    // deviceId → { userId, registrationId } mapping for Signal session resolution
    // Signal sessions are keyed by (userId, registrationId),
    // but message routing uses deviceId. This map bridges the two.
    this._deviceMap = new Map();
  }

  /**
   * Register a deviceId → { userId, registrationId } mapping for Signal session resolution
   */
  mapDevice(deviceId, userId, registrationId) {
    this._deviceMap.set(deviceId, { userId, registrationId });
  }

  /**
   * Legacy alias
   */
  mapDeviceToUser(deviceId, userId) {
    const existing = this._deviceMap.get(deviceId);
    this._deviceMap.set(deviceId, { userId, registrationId: existing?.registrationId || 1 });
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
    this.AckMessage = this.proto.lookupType('obscura.v1.AckMessage');
    this.SendMessageRequest = this.proto.lookupType('obscura.v1.SendMessageRequest');
    this.SendMessageResponse = this.proto.lookupType('obscura.v1.SendMessageResponse');

    this.clientProto = await protobuf.load(clientProtoPath);
    console.log('[Messenger] Client proto loaded:', Object.keys(this.clientProto.nested || {}));
    this.EncryptedMessage = this.clientProto.lookupType('obscura.v2.EncryptedMessage');
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
   * Fetch PreKey bundles for all devices of a user
   * New API: GET /v1/users/{userId} returns array of PreKeyBundleResponse
   * @param {string} userId - User UUID
   * @returns {Promise<Array>} Array of { deviceId, identityKey, registrationId, signedPreKey, preKey }
   */
  async fetchPreKeyBundles(userId) {
    let res;
    try {
      res = await fetch(`${this.apiUrl}/v1/users/${userId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
    } catch (e) {
      await logger.logPrekeyFetchError(userId, e, null);
      throw e;
    }

    if (!res.ok) {
      const error = new Error(`Failed to fetch bundles for ${userId}: ${res.status}`);
      await logger.logPrekeyFetchError(userId, error, res.status);
      throw error;
    }

    const bundles = await res.json();

    return bundles.map(b => {
      const bundle = {
        deviceId: b.deviceId,
        identityKey: toArrayBuffer(b.identityKey),
        registrationId: b.registrationId,
        signedPreKey: {
          keyId: b.signedPreKey.keyId,
          publicKey: toArrayBuffer(b.signedPreKey.publicKey),
          signature: toArrayBuffer(b.signedPreKey.signature),
        },
        preKey: b.oneTimePreKey ? {
          keyId: b.oneTimePreKey.keyId,
          publicKey: toArrayBuffer(b.oneTimePreKey.publicKey),
        } : undefined,
      };
      // Auto-populate deviceId → userId map for Signal session resolution
      // Note: registrationId stored for future multi-device support but not used for addressing yet
      this._deviceMap.set(b.deviceId, { userId, registrationId: b.registrationId });
      logger.logPrekeyFetch(userId, !!bundle.preKey, bundle.registrationId);
      return bundle;
    });
  }

  /**
   * Encrypt a message for a target user's device.
   * Signal sessions are keyed by (userId, registrationId).
   * @param {string} targetUserId - Target user UUID
   * @param {*} plaintext - Data to encrypt
   * @param {number} [registrationId] - Target device's registrationId (default: fetches bundles)
   */
  async encrypt(targetUserId, plaintext, registrationId = 1) {
    const address = new SignalProtocolAddress(targetUserId, registrationId);
    const existingSession = await this.store.loadSession(address.toString());
    if (!existingSession) {
      const bundles = await this.fetchPreKeyBundles(targetUserId);
      const bundle = bundles.find(b => b.registrationId === registrationId) || bundles[0];
      try {
        const sessionBuilder = new SessionBuilder(this.store, address);
        await sessionBuilder.processPreKey(bundle);
      } catch (e) {
        console.error(`[encrypt] processPreKey FAILED for ${targetUserId.slice(-8)}:`, e.message);
        console.error(`[encrypt] bundle had: identityKey=${bundle.identityKey?.byteLength}B, signedPreKey.keyId=${bundle.signedPreKey?.keyId}, preKey=${!!bundle.preKey}, regId=${bundle.registrationId}`);
        throw e;
      }
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
   * Decrypt a message from a source user.
   * Tries known registrationIds for the sender to find the right Signal session.
   * @param {string} sourceUserId - Sender's user UUID (from Envelope.sender_id)
   * @param {*} content - Encrypted content
   * @param {number} messageType - PROTO_PREKEY_MESSAGE or PROTO_ENCRYPTED_MESSAGE
   * @param {number} [senderRegId] - Sender's registrationId (if known)
   */
  async decrypt(sourceUserId, content, messageType, senderRegId) {
    // Collect all candidate registrationIds for this sender
    const candidateRegIds = new Set();
    if (senderRegId) candidateRegIds.add(senderRegId);
    candidateRegIds.add(1); // legacy fallback
    // Add own registrationId (for self-sync: other device encrypted with our regId)
    const ownRegId = await this.store.getLocalRegistrationId?.();
    if (ownRegId) candidateRegIds.add(ownRegId);
    // Add all known regIds for this userId from device map
    for (const [, info] of this._deviceMap) {
      if (info.userId === sourceUserId && info.registrationId) {
        candidateRegIds.add(info.registrationId);
      }
    }

    let contentBuffer;
    if (content instanceof ArrayBuffer) {
      contentBuffer = content;
    } else if (content instanceof Uint8Array) {
      contentBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    } else {
      contentBuffer = toArrayBuffer(content);
    }

    // Try each candidate address — return first successful decrypt
    // Sort: try addresses WITH existing sessions first to avoid corrupting sessions
    const sortedRegIds = [...candidateRegIds];
    const withSession = [];
    const withoutSession = [];
    for (const regId of sortedRegIds) {
      const hasSession = await this.store.loadSession(`${sourceUserId}.${regId}`);
      if (hasSession) withSession.push(regId);
      else withoutSession.push(regId);
    }
    const orderedRegIds = messageType === PROTO_PREKEY_MESSAGE
      ? [...withoutSession, ...withSession]
      : [...withSession, ...withoutSession];

    let lastError = null;
    for (const regId of orderedRegIds) {
      const address = new SignalProtocolAddress(sourceUserId, regId);
      const hasSession = await this.store.loadSession(address.toString());

      // For Whisper messages, skip if no session at this address
      if (messageType !== PROTO_PREKEY_MESSAGE && !hasSession) continue;

      const cipher = new SessionCipher(this.store, address);
      try {
        let decrypted;
        if (messageType === PROTO_PREKEY_MESSAGE) {
          decrypted = await cipher.decryptPreKeyWhisperMessage(contentBuffer, 'binary');
        } else {
          decrypted = await cipher.decryptWhisperMessage(contentBuffer, 'binary');
        }

        // Success — convert and return with sender device info
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
        // Look up which deviceId this regId belongs to
        let senderDeviceId = null;
        for (const [deviceId, info] of this._deviceMap) {
          if (info.userId === sourceUserId && info.registrationId === regId) {
            senderDeviceId = deviceId;
            break;
          }
        }
        return { bytes, senderRegId: regId, senderDeviceId };
      } catch (e) {
        lastError = e;
        // Try next regId
      }
    }

    // All candidates failed — try PreKey decrypt at a fresh address from fetched bundles
    if (messageType === PROTO_PREKEY_MESSAGE) {
      try {
        const bundles = await this.fetchPreKeyBundles(sourceUserId);
        if (bundles.length > 0) {
          const freshRegId = bundles[0].registrationId;
          if (!candidateRegIds.has(freshRegId)) {
            const address = new SignalProtocolAddress(sourceUserId, freshRegId);
            const cipher = new SessionCipher(this.store, address);
            const decrypted = await cipher.decryptPreKeyWhisperMessage(contentBuffer, 'binary');
            let bytes;
            if (decrypted instanceof ArrayBuffer) bytes = new Uint8Array(decrypted);
            else if (decrypted instanceof Uint8Array) bytes = decrypted;
            else { bytes = new Uint8Array(decrypted.length); for (let i = 0; i < decrypted.length; i++) bytes[i] = decrypted.charCodeAt(i); }
            return { bytes, senderRegId: freshRegId, senderDeviceId: bundles[0].deviceId };
          }
        }
      } catch (e) {
        lastError = e;
      }
    }

    // All attempts failed
    if (!lastError) {
      // No candidates had sessions — equivalent to "No record"
      throw new Error(`No record for ${sourceUserId}`);
    }
    throw lastError;
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
          deviceId: d.deviceId,
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
          deviceId: d.deviceId,
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
          deviceId: d.deviceId,
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
          deviceId: d.deviceId,
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
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
      };
    }

    if (msg.deviceAnnounce) {
      result.deviceAnnounce = {
        devices: (msg.deviceAnnounce.devices || []).map(d => ({
          deviceUUID: d.deviceUuid,
          deviceId: d.deviceId,
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
          deviceId: d.deviceId,
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
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          signalIdentityKey: d.signalIdentityKey,
        })),
        timestamp: Number(msg.friendSync.timestamp) || 0,
      };
    }

    return result;
  }

  /**
   * Encrypt and queue a message for batch sending (no HTTP call).
   * Call flushMessages() after queueing all messages to send them in one request.
   *
   * @param {string} targetDeviceId - Target device UUID (for server routing)
   * @param {object} opts - Message options
   * @param {string} [targetUserId] - Optional target user UUID override for Signal encryption
   */
  async queueMessage(targetDeviceId, opts, targetUserId) {
    await this.loadProto();

    // Resolve userId + registrationId from device map
    const mapped = this._deviceMap.get(targetDeviceId);
    const encryptUserId = targetUserId || mapped?.userId || targetDeviceId;
    const registrationId = mapped?.registrationId || 1;

    const clientMsgBytes = this.encodeClientMessage(opts);
    const encrypted = await this.encrypt(encryptUserId, clientMsgBytes, registrationId);

    const encMsg = this.EncryptedMessage.create({
      type: encrypted.protoType,
      content: encrypted.body,
    });
    const encryptedPayload = this.EncryptedMessage.encode(encMsg).finish();

    // Server routes by device_id
    this._queue.push({
      submissionId: uuidToBytes(generateDeviceUUID()),
      deviceId: uuidToBytes(targetDeviceId),
      message: encryptedPayload,
    });
  }

  /**
   * Flush all queued messages in a single HTTP request.
   * Returns { sent, failed, failedSubmissions } for error reporting.
   */
  async flushMessages() {
    if (this._queue.length === 0) {
      return { sent: 0, failed: 0, failedSubmissions: [] };
    }

    await this.loadProto();

    const submissions = this._queue.splice(0);
    const req = this.SendMessageRequest.create({ messages: submissions });
    const protobufData = this.SendMessageRequest.encode(req).finish();

    const res = await fetch(`${this.apiUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Authorization': `Bearer ${this.token}`,
        'Idempotency-Key': generateDeviceUUID(),
      },
      body: protobufData,
    });

    if (!res.ok) {
      throw new Error(`Failed to send batch: ${res.status}`);
    }

    // Parse response for per-submission errors
    const responseBytes = new Uint8Array(await res.arrayBuffer());
    let failedSubmissions = [];
    if (responseBytes.length > 0) {
      try {
        const resp = this.SendMessageResponse.decode(responseBytes);
        failedSubmissions = resp.failedSubmissions || [];
        if (failedSubmissions.length > 0) {
          console.warn(`[Messenger] Batch: ${failedSubmissions.length}/${submissions.length} submissions failed`);
          for (const f of failedSubmissions) {
            console.warn(`[Messenger]   submission failed: code=${f.errorCode} ${f.errorMessage || ''}`);
          }
        }
      } catch (e) {
        // Response may be empty on full success
      }
    }

    return {
      sent: submissions.length - failedSubmissions.length,
      failed: failedSubmissions.length,
      failedSubmissions,
    };
  }

  /**
   * Send an encrypted message (convenience for non-batch cases).
   * @param {string} targetDeviceId - Target device UUID (for routing)
   * @param {object} opts - Message options
   * @param {string} [targetUserId] - Target user UUID (for Signal encryption)
   */
  async sendMessage(targetDeviceId, opts, targetUserId) {
    await this.queueMessage(targetDeviceId, opts, targetUserId);
    await this.flushMessages();
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
