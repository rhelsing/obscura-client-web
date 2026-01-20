import protobuf from 'protobufjs';
import client from './client.js';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

class Gateway {
  constructor() {
    this.ws = null;
    this.proto = null;
    this.WebSocketFrame = null;
    this.AckMessage = null;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.heartbeatTimer = null;
  }

  async loadProto() {
    if (this.proto) return;

    // Load server protocol proto (from public folder)
    this.proto = await protobuf.load('/proto/obscura/v1/obscura.proto');
    this.WebSocketFrame = this.proto.lookupType('obscura.v1.WebSocketFrame');
    this.AckMessage = this.proto.lookupType('obscura.v1.AckMessage');
    this.Envelope = this.proto.lookupType('obscura.v1.Envelope');
    this.EncryptedMessage = this.proto.lookupType('obscura.v1.EncryptedMessage');

    // Load client-to-client message proto (from public folder)
    this.clientProto = await protobuf.load('/proto/client/client_message.proto');
    this.ClientMessage = this.clientProto.lookupType('obscura.client.ClientMessage');
  }

  // Message type enum mapping
  static MessageTypes = {
    TEXT: 0,
    IMAGE: 1,
    FRIEND_REQUEST: 2,
    FRIEND_RESPONSE: 3,
  };

  // Encode a client message (text, image, or friend request/response)
  encodeClientMessage({
    type = 'TEXT',
    text = '',
    imageData = null,
    mimeType = '',
    displayDuration = 8,
    username = '',
    accepted = false,
  }) {
    const typeValue = Gateway.MessageTypes[type] ?? 0;

    const clientMsg = this.ClientMessage.create({
      type: typeValue,
      text: text,
      imageData: imageData || new Uint8Array(0),
      mimeType: mimeType,
      timestamp: Date.now(),
      displayDuration: displayDuration,
      username: username,
      accepted: accepted,
    });
    return this.ClientMessage.encode(clientMsg).finish();
  }

  // Decode a client message from bytes
  decodeClientMessage(bytes) {
    try {
      const msg = this.ClientMessage.decode(bytes);

      // Map type number back to string
      const typeMap = ['TEXT', 'IMAGE', 'FRIEND_REQUEST', 'FRIEND_RESPONSE'];
      const typeStr = typeMap[msg.type] || 'TEXT';

      return {
        type: typeStr,
        text: msg.text,
        imageData: msg.imageData,
        mimeType: msg.mimeType,
        timestamp: msg.timestamp,
        displayDuration: msg.displayDuration || 8,
        username: msg.username || '',
        accepted: msg.accepted || false,
      };
    } catch (e) {
      console.warn('Could not decode as ClientMessage, treating as raw text');
      return {
        type: 'TEXT',
        text: new TextDecoder().decode(bytes),
        imageData: null,
        mimeType: '',
        timestamp: Date.now(),
        displayDuration: 8,
        username: '',
        accepted: false,
      };
    }
  }

  // Encode for sending to server (wraps ClientMessage in EncryptedMessage)
  encodeOutgoingMessage(clientMessageBytes, encType = 2) {
    // encType 1 = PREKEY_MESSAGE, encType 2 = ENCRYPTED_MESSAGE
    const message = this.EncryptedMessage.create({
      type: encType,
      content: clientMessageBytes,
    });
    return this.EncryptedMessage.encode(message).finish();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return () => {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) callbacks.splice(index, 1);
    };
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => cb(data));
  }

  async connect() {
    if (!client.isAuthenticated()) {
      throw new Error('Not authenticated');
    }

    await this.loadProto();

    const url = client.getGatewayUrl();
    this.emit('status', { state: 'connecting', message: 'Connecting to gateway...' });

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.emit('status', { state: 'connected', message: 'Connected to gateway' });
        this.emit('connected');
        resolve();
      };

      this.ws.onclose = (event) => {
        this.stopHeartbeat();
        this.emit('status', { state: 'disconnected', message: `Disconnected (${event.code})` });
        this.emit('disconnected', event);
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        this.emit('status', { state: 'error', message: 'Connection error' });
        this.emit('error', error);
        reject(error);
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  handleMessage(data) {
    try {
      const frame = this.WebSocketFrame.decode(new Uint8Array(data));

      if (frame.envelope) {
        this.emit('envelope', frame.envelope);
        // Auto-acknowledge
        this.acknowledge(frame.envelope.id);
      }
    } catch (error) {
      console.error('Failed to decode message:', error);
      this.emit('error', error);
    }
  }

  acknowledge(messageId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Cannot acknowledge: WebSocket not open');
      return;
    }

    const frame = this.WebSocketFrame.create({
      ack: { messageId }
    });

    const buffer = this.WebSocketFrame.encode(frame).finish();
    this.ws.send(buffer);
    this.emit('ack', { messageId });
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('status', { state: 'failed', message: 'Max reconnection attempts reached' });
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.emit('status', {
      state: 'reconnecting',
      message: `Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    });

    setTimeout(() => {
      if (client.isAuthenticated()) {
        this.connect().catch(() => {});
      }
    }, delay);
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send an empty WebSocketFrame as keepalive
        const frame = this.WebSocketFrame.create({});
        const buffer = this.WebSocketFrame.encode(frame).finish();
        this.ws.send(buffer);
      }
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

export const gateway = new Gateway();
export default gateway;
