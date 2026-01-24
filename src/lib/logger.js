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
