/**
 * WebSocket Gateway for Obscura Server
 * Per identity.md spec: Receive messages via WebSocket, ACK after processing
 */

import protobuf from 'protobufjs';

const HEARTBEAT_INTERVAL = 30000;

/**
 * Create a gateway instance
 * @param {object} options
 * @param {string} options.protoBasePath - Base path to proto files
 * @returns {object} Gateway instance
 */
export function createGateway(options = {}) {
  const protoBasePath = options.protoBasePath || '/';

  let ws = null;
  let proto = null;
  let WebSocketFrame = null;
  let AckMessage = null;
  let Envelope = null;
  let EncryptedMessage = null;
  let ClientMessage = null;
  let heartbeatTimer = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  const reconnectDelay = 1000;

  const listeners = new Map();

  function on(event, callback) {
    if (!listeners.has(event)) {
      listeners.set(event, []);
    }
    listeners.get(event).push(callback);
    return () => {
      const callbacks = listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) callbacks.splice(index, 1);
    };
  }

  function emit(event, data) {
    const callbacks = listeners.get(event) || [];
    callbacks.forEach(cb => cb(data));
  }

  function removeAllListeners(event) {
    if (event) {
      listeners.delete(event);
    } else {
      listeners.clear();
    }
  }

  async function loadProto() {
    if (proto) return;

    // Load server protocol proto
    proto = await protobuf.load(`${protoBasePath}proto/obscura/v1/obscura.proto`);
    WebSocketFrame = proto.lookupType('obscura.v1.WebSocketFrame');
    AckMessage = proto.lookupType('obscura.v1.AckMessage');
    Envelope = proto.lookupType('obscura.v1.Envelope');
    EncryptedMessage = proto.lookupType('obscura.v1.EncryptedMessage');

    // Load client message proto
    const clientProto = await protobuf.load(`${protoBasePath}proto/client/client_message.proto`);
    ClientMessage = clientProto.lookupType('obscura.client.ClientMessage');
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const frame = WebSocketFrame.create({});
        ws.send(WebSocketFrame.encode(frame).finish());
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function handleMessage(data) {
    try {
      const frame = WebSocketFrame.decode(new Uint8Array(data));

      if (frame.envelope) {
        emit('envelope', frame.envelope);
      }
    } catch (error) {
      console.error('Failed to decode message:', error);
      emit('error', error);
    }
  }

  return {
    /**
     * Load protobuf definitions
     */
    loadProto,

    /**
     * Connect to WebSocket gateway
     * @param {string} gatewayUrl - Full WebSocket URL with token
     */
    async connect(gatewayUrl) {
      await loadProto();

      emit('status', { state: 'connecting' });

      return new Promise((resolve, reject) => {
        ws = new WebSocket(gatewayUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          reconnectAttempts = 0;
          startHeartbeat();
          emit('status', { state: 'connected' });
          emit('connected');
          resolve();
        };

        ws.onclose = (event) => {
          stopHeartbeat();
          emit('status', { state: 'disconnected', code: event.code });
          emit('disconnected', event);
        };

        ws.onerror = (error) => {
          emit('status', { state: 'error' });
          emit('error', error);
          reject(error);
        };

        ws.onmessage = (event) => {
          handleMessage(event.data);
        };
      });
    },

    /**
     * Disconnect from gateway
     */
    disconnect() {
      stopHeartbeat();
      if (ws) {
        ws.close();
        ws = null;
      }
    },

    /**
     * Check if connected
     */
    isConnected() {
      return ws && ws.readyState === WebSocket.OPEN;
    },

    /**
     * Acknowledge a message
     * @param {string} messageId - Envelope ID to acknowledge
     */
    acknowledge(messageId) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('Cannot acknowledge: WebSocket not open');
        return;
      }

      const frame = WebSocketFrame.create({
        ack: { messageId }
      });

      ws.send(WebSocketFrame.encode(frame).finish());
      emit('ack', { messageId });
    },

    /**
     * Encode a client message
     */
    encodeClientMessage(msg) {
      if (!ClientMessage) {
        throw new Error('Proto not loaded. Call loadProto() first.');
      }

      const MessageTypes = {
        TEXT: 0,
        IMAGE: 1,
        FRIEND_REQUEST: 2,
        FRIEND_RESPONSE: 3,
        SESSION_RESET: 4,
        DEVICE_LINK_REQUEST: 10,
        DEVICE_LINK_APPROVAL: 11,
        DEVICE_ANNOUNCE: 12,
      };

      const typeValue = typeof msg.type === 'string' ? (MessageTypes[msg.type] ?? 0) : msg.type;

      const clientMsg = ClientMessage.create({
        type: typeValue,
        text: msg.text || '',
        imageData: msg.imageData || new Uint8Array(0),
        mimeType: msg.mimeType || '',
        timestamp: msg.timestamp || Date.now(),
        displayDuration: msg.displayDuration || 8,
        username: msg.username || '',
        accepted: msg.accepted || false,
        attachmentId: msg.attachmentId || '',
        attachmentExpires: msg.attachmentExpires || 0,
        // Device management fields (new)
        deviceLinkApproval: msg.deviceLinkApproval,
        deviceAnnounce: msg.deviceAnnounce,
      });

      return ClientMessage.encode(clientMsg).finish();
    },

    /**
     * Decode a client message
     */
    decodeClientMessage(bytes) {
      if (!ClientMessage) {
        throw new Error('Proto not loaded. Call loadProto() first.');
      }

      const typeMap = {
        0: 'TEXT',
        1: 'IMAGE',
        2: 'FRIEND_REQUEST',
        3: 'FRIEND_RESPONSE',
        4: 'SESSION_RESET',
        10: 'DEVICE_LINK_REQUEST',
        11: 'DEVICE_LINK_APPROVAL',
        12: 'DEVICE_ANNOUNCE',
      };

      try {
        const msg = ClientMessage.decode(bytes);
        return {
          type: typeMap[msg.type] || 'TEXT',
          text: msg.text,
          imageData: msg.imageData,
          mimeType: msg.mimeType,
          timestamp: msg.timestamp,
          displayDuration: msg.displayDuration || 8,
          username: msg.username || '',
          accepted: msg.accepted || false,
          attachmentId: msg.attachmentId || '',
          attachmentExpires: msg.attachmentExpires || 0,
          deviceLinkApproval: msg.deviceLinkApproval,
          deviceAnnounce: msg.deviceAnnounce,
        };
      } catch (e) {
        console.warn('Could not decode ClientMessage:', e);
        return null;
      }
    },

    /**
     * Encode for server transport (wrap in EncryptedMessage)
     */
    encodeOutgoingMessage(ciphertextBytes, encType = 2) {
      if (!EncryptedMessage) {
        throw new Error('Proto not loaded. Call loadProto() first.');
      }

      const message = EncryptedMessage.create({
        type: encType,
        content: ciphertextBytes,
      });

      return EncryptedMessage.encode(message).finish();
    },

    /**
     * Event handling
     */
    on,
    emit,
    removeAllListeners,
  };
}

export default createGateway;
