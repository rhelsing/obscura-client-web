// Centralized logger for message debugging
// Wraps logStore with convenience methods for send/receive flows

import { logStore, LogEventType } from './logStore.js';

class Logger {
  constructor() {
    this.enabled = true;
    this.listeners = new Set();
  }

  // Subscribe to new log events
  onLog(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // Notify listeners of new log
  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[Logger] Listener error:', err);
      }
    }
  }

  // Initialize logger for a device
  init(deviceId) {
    logStore.init(deviceId);
  }

  // Enable/disable logging
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  // Core log method
  async log(eventType, data = {}, correlationId = null) {
    if (!this.enabled) return null;
    try {
      const event = await logStore.log(eventType, data, correlationId);
      this._emit(event);
      return event;
    } catch (err) {
      console.warn('[Logger] Failed to log event:', err);
      return null;
    }
  }

  // === SEND FLOW ===

  async logSendStart(recipientId, messageType, correlationId) {
    return this.log(LogEventType.SEND_START, {
      recipientId,
      messageType,
      direction: 'outbound',
    }, correlationId);
  }

  async logSendEncryptStart(recipientId, plaintextSize, correlationId) {
    return this.log(LogEventType.SEND_ENCRYPT_START, {
      recipientId,
      plaintextSize,
    }, correlationId);
  }

  async logSendEncryptComplete(recipientId, ciphertextSize, signalType, correlationId) {
    return this.log(LogEventType.SEND_ENCRYPT_COMPLETE, {
      recipientId,
      ciphertextSize,
      signalType, // PREKEY_MESSAGE or ENCRYPTED_MESSAGE
    }, correlationId);
  }

  async logSendComplete(recipientId, protobufSize, correlationId) {
    return this.log(LogEventType.SEND_COMPLETE, {
      recipientId,
      protobufSize,
      success: true,
    }, correlationId);
  }

  async logSendError(recipientId, error, correlationId) {
    return this.log(LogEventType.SEND_ERROR, {
      recipientId,
      error: error.message || String(error),
      status: error.status,
    }, correlationId);
  }

  // === RECEIVE FLOW ===

  async logReceiveEnvelope(envelopeId, sourceUserId, messageType, correlationId) {
    return this.log(LogEventType.RECEIVE_ENVELOPE, {
      envelopeId,
      sourceUserId,
      messageType,
      direction: 'inbound',
    }, correlationId);
  }

  async logReceiveDecryptStart(sourceUserId, ciphertextSize, messageType, correlationId) {
    return this.log(LogEventType.RECEIVE_DECRYPT_START, {
      sourceUserId,
      ciphertextSize,
      messageType,
    }, correlationId);
  }

  async logReceiveDecryptComplete(sourceUserId, plaintextSize, correlationId) {
    return this.log(LogEventType.RECEIVE_DECRYPT_COMPLETE, {
      sourceUserId,
      plaintextSize,
    }, correlationId);
  }

  async logReceiveDecode(sourceUserId, clientMessageType, correlationId) {
    return this.log(LogEventType.RECEIVE_DECODE, {
      sourceUserId,
      clientMessageType, // TEXT, IMAGE, FRIEND_REQUEST, etc.
    }, correlationId);
  }

  async logReceiveComplete(envelopeId, sourceUserId, clientMessageType, correlationId) {
    return this.log(LogEventType.RECEIVE_COMPLETE, {
      envelopeId,
      sourceUserId,
      clientMessageType,
      success: true,
    }, correlationId);
  }

  async logReceiveError(envelopeId, sourceUserId, error, correlationId) {
    return this.log(LogEventType.RECEIVE_ERROR, {
      envelopeId,
      sourceUserId,
      error: error.message || String(error),
    }, correlationId);
  }

  // Decrypt succeeded but processing failed - message is unrecoverable
  async logMessageLost(envelopeId, sourceUserId, messageType, error, correlationId) {
    return this.log(LogEventType.MESSAGE_LOST, {
      envelopeId,
      sourceUserId,
      messageType,
      error: error.message || String(error),
      reason: 'Decryption succeeded but processing failed. Signal keys are one-time use, so this message cannot be recovered.',
    }, correlationId);
  }

  // === SESSION EVENTS ===

  async logSessionEstablish(userId, hasPreKey) {
    return this.log(LogEventType.SESSION_ESTABLISH, {
      userId,
      hasPreKey,
    });
  }

  async logSessionReset(userId, reason) {
    return this.log(LogEventType.SESSION_RESET, {
      userId,
      reason,
    });
  }

  // === GATEWAY EVENTS ===

  async logGatewayConnect() {
    return this.log(LogEventType.GATEWAY_CONNECT, {
      connectedAt: Date.now(),
    });
  }

  async logGatewayDisconnect(code, reason) {
    return this.log(LogEventType.GATEWAY_DISCONNECT, {
      code,
      reason,
    });
  }

  async logGatewayAck(messageId) {
    return this.log(LogEventType.GATEWAY_ACK, {
      messageId,
    });
  }

  // === PREKEY EVENTS ===

  async logPrekeyFetch(targetUserId, hasPreKey, registrationId) {
    return this.log(LogEventType.PREKEY_FETCH, {
      targetUserId,
      hasPreKey,
      registrationId,
    });
  }

  async logPrekeyFetchError(targetUserId, error, status) {
    return this.log(LogEventType.PREKEY_FETCH_ERROR, {
      targetUserId,
      error: error?.message || String(error),
      status,
    });
  }

  async logPrekeyReplenish(previousCount, newCount, uploadedCount) {
    return this.log(LogEventType.PREKEY_REPLENISH, {
      previousCount,
      newCount,
      uploadedCount,
    });
  }

  async logPrekeyReplenishError(error, status, count) {
    return this.log(LogEventType.PREKEY_REPLENISH_ERROR, {
      error: error?.message || String(error),
      status,
      count,
    });
  }

  // === CRYPTO ERRORS ===

  async logEncryptError(targetUserId, error, hasSession) {
    return this.log(LogEventType.ENCRYPT_ERROR, {
      targetUserId,
      error: error?.message || String(error),
      hasSession,
    });
  }

  async logDecryptError(sourceUserId, error, messageType, isSessionDesync = false) {
    return this.log(LogEventType.DECRYPT_ERROR, {
      sourceUserId,
      error: error?.message || String(error),
      messageType,
      isSessionDesync,
    });
  }

  // === FRIEND EVENTS ===

  async logFriendRequestSent(username, deviceCount) {
    return this.log(LogEventType.FRIEND_REQUEST_SENT, {
      username,
      deviceCount,
    });
  }

  async logFriendRequestReceived(username, sourceUserId, deviceCount) {
    return this.log(LogEventType.FRIEND_REQUEST_RECEIVED, {
      username,
      sourceUserId,
      deviceCount,
    });
  }

  async logFriendAccept(username) {
    return this.log(LogEventType.FRIEND_ACCEPT, {
      username,
    });
  }

  async logFriendReject(username) {
    return this.log(LogEventType.FRIEND_REJECT, {
      username,
    });
  }

  async logFriendRemove(username) {
    return this.log(LogEventType.FRIEND_REMOVE, {
      username,
    });
  }

  // === DEVICE EVENTS ===

  async logDeviceAdd(serverUserId, deviceName, deviceUUID) {
    return this.log(LogEventType.DEVICE_ADD, {
      serverUserId,
      deviceName,
      deviceUUID,
    });
  }

  async logDeviceRemove(serverUserId, deviceUUID) {
    return this.log(LogEventType.DEVICE_REMOVE, {
      serverUserId,
      deviceUUID,
    });
  }

  async logDeviceLinkStart(deviceUUID, challenge) {
    return this.log(LogEventType.DEVICE_LINK_START, {
      deviceUUID,
      challenge,
    });
  }

  async logDeviceLinkApprove(deviceUUID, serverUserId) {
    return this.log(LogEventType.DEVICE_LINK_APPROVE, {
      deviceUUID,
      serverUserId,
    });
  }

  async logDeviceAnnounce(deviceCount, isRevocation, sourceUserId) {
    return this.log(LogEventType.DEVICE_ANNOUNCE, {
      deviceCount,
      isRevocation,
      sourceUserId,
    });
  }

  async logDeviceRevoke(revokedDeviceId, deletedMessageCount, selfRevoked = false) {
    return this.log(LogEventType.DEVICE_REVOKE, {
      revokedDeviceId,
      deletedMessageCount,
      selfRevoked,
    });
  }

  // === ATTACHMENT EVENTS ===

  async logAttachmentUpload(attachmentId, sizeBytes, contentType) {
    return this.log(LogEventType.ATTACHMENT_UPLOAD, {
      attachmentId,
      sizeBytes,
      contentType,
    });
  }

  async logAttachmentUploadError(error, status, sizeBytes) {
    return this.log(LogEventType.ATTACHMENT_UPLOAD_ERROR, {
      error: error?.message || String(error),
      status,
      sizeBytes,
    });
  }

  async logAttachmentDownload(attachmentId, sizeBytes, fromCache) {
    return this.log(LogEventType.ATTACHMENT_DOWNLOAD, {
      attachmentId,
      sizeBytes,
      fromCache,
    });
  }

  async logAttachmentDownloadError(attachmentId, error, status) {
    return this.log(LogEventType.ATTACHMENT_DOWNLOAD_ERROR, {
      attachmentId,
      error: error?.message || String(error),
      status,
    });
  }

  async logAttachmentCacheHit(attachmentId) {
    return this.log(LogEventType.ATTACHMENT_CACHE_HIT, {
      attachmentId,
    });
  }

  // === STORAGE EVENTS ===

  async logStorageError(operation, error, context = {}) {
    return this.log(LogEventType.STORAGE_ERROR, {
      operation,
      error: error?.message || String(error),
      ...context,
    });
  }

  async logMessagePersist(conversationId, messageId) {
    return this.log(LogEventType.MESSAGE_PERSIST, {
      conversationId,
      messageId,
    });
  }

  async logMessagePersistError(conversationId, error) {
    return this.log(LogEventType.MESSAGE_PERSIST_ERROR, {
      conversationId,
      error: error?.message || String(error),
    });
  }

  // === ORM SYNC EVENTS ===

  async logOrmSyncSend(model, id, op, targetDeviceCount) {
    return this.log(LogEventType.ORM_SYNC_SEND, {
      model,
      id,
      op,
      targetDeviceCount,
    });
  }

  async logOrmSyncReceive(model, id, op, authorDeviceId) {
    return this.log(LogEventType.ORM_SYNC_RECEIVE, {
      model,
      id,
      op,
      authorDeviceId,
    });
  }

  async logOrmSyncError(model, error, direction) {
    return this.log(LogEventType.ORM_SYNC_ERROR, {
      model,
      error: error?.message || String(error),
      direction,
    });
  }

  async logSyncBlobSend(targetUserId, modelCount, compressedSize) {
    return this.log(LogEventType.SYNC_BLOB_SEND, {
      targetUserId,
      modelCount,
      compressedSize,
    });
  }

  async logSyncBlobReceive(sourceUserId, modelCount) {
    return this.log(LogEventType.SYNC_BLOB_RECEIVE, {
      sourceUserId,
      modelCount,
    });
  }

  // === TTL CLEANUP EVENTS ===

  async logTtlCleanup(model, deletedCount) {
    return this.log(LogEventType.TTL_CLEANUP, {
      model,
      deletedCount,
    });
  }

  async logTtlCleanupError(model, error) {
    return this.log(LogEventType.TTL_CLEANUP_ERROR, {
      model,
      error: error?.message || String(error),
    });
  }

  // === AUTH LIFECYCLE EVENTS ===

  async logTokenRefresh(data) {
    return this.log(LogEventType.TOKEN_REFRESH, data);
  }

  async logTokenRefreshError(data) {
    return this.log(LogEventType.TOKEN_REFRESH_ERROR, {
      ...data,
      error: data.error?.message || data.error || 'Unknown',
    });
  }

  async logSessionRestore(data) {
    return this.log(LogEventType.SESSION_RESTORE, data);
  }

  async logSessionRestoreError(data) {
    return this.log(LogEventType.SESSION_RESTORE_ERROR, {
      ...data,
      error: data.error?.message || data.error || 'Unknown',
    });
  }

  async logLogin(data) {
    return this.log(LogEventType.LOGIN, data);
  }

  async logLoginError(data) {
    return this.log(LogEventType.LOGIN_ERROR, data);
  }

  async logLogout(data) {
    return this.log(LogEventType.LOGOUT, data);
  }

  // === BACKUP EVENTS ===

  async logBackupUpload(data) {
    return this.log(LogEventType.BACKUP_UPLOAD, data);
  }

  async logBackupUploadError(data) {
    return this.log(LogEventType.BACKUP_UPLOAD_ERROR, {
      ...data,
      error: data.error?.message || data.error || 'Unknown',
    });
  }

  async logBackupCheck(data) {
    return this.log(LogEventType.BACKUP_CHECK, data);
  }

  async logBackupCheckError(data) {
    return this.log(LogEventType.BACKUP_CHECK_ERROR, {
      ...data,
      error: data.error?.message || data.error || 'Unknown',
    });
  }

  async logBackupDownload(data) {
    return this.log(LogEventType.BACKUP_DOWNLOAD, data);
  }

  async logBackupDownloadError(data) {
    return this.log(LogEventType.BACKUP_DOWNLOAD_ERROR, {
      ...data,
      error: data.error?.message || data.error || 'Unknown',
    });
  }

  // === QUERY METHODS ===

  async getAllEvents(limit = 500) {
    return logStore.getAllEvents(limit);
  }

  async getEventsByCorrelation(correlationId) {
    return logStore.getEventsByCorrelation(correlationId);
  }

  async getEventsByType(eventType, limit = 100) {
    return logStore.getEventsByType(eventType, limit);
  }

  async getEventCount() {
    return logStore.getEventCount();
  }

  async clearAll() {
    return logStore.clearAll();
  }

  // Generate a new correlation ID for tracking a message flow
  generateCorrelationId() {
    return logStore.generateCorrelationId();
  }
}

// Singleton instance
export const logger = new Logger();
export default logger;
