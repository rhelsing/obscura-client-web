import protobuf from 'protobufjs';
import client from './client.js';

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
  }

  async loadProto() {
    if (this.proto) return;

    // Load proto from the file
    this.proto = await protobuf.load('/src/proto/obscura.proto');
    this.WebSocketFrame = this.proto.lookupType('obscura.v1.WebSocketFrame');
    this.AckMessage = this.proto.lookupType('obscura.v1.AckMessage');
    this.Envelope = this.proto.lookupType('obscura.v1.Envelope');
    this.OutgoingMessage = this.proto.lookupType('obscura.v1.OutgoingMessage');
    this.EncryptedMessage = this.proto.lookupType('obscura.v1.EncryptedMessage');
  }

  // Encode an outgoing message as protobuf (just EncryptedMessage, no wrapper)
  encodeOutgoingMessage(content, type = 2) {
    // type 1 = PREKEY_MESSAGE, type 2 = ENCRYPTED_MESSAGE
    const message = this.EncryptedMessage.create({
      type: type,
      content: typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content
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
        this.emit('status', { state: 'connected', message: 'Connected to gateway' });
        this.emit('connected');
        resolve();
      };

      this.ws.onclose = (event) => {
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

export const gateway = new Gateway();
export default gateway;
