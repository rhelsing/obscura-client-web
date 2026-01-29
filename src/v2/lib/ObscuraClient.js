/**
 * ObscuraClient - Unified Facade
 * The one object you interact with for all Obscura operations
 */

import { FriendManager } from './friends.js';
import { DeviceManager, parseLinkCode, buildLinkApproval } from './devices.js';
import { Messenger, MessageType } from './messenger.js';
import { AttachmentManager } from './attachments.js';
import { createStore } from './store.js';
import { createMessageStore } from '../store/messageStore.js';
import { createFriendStore } from '../store/friendStore.js';
import { createDeviceStore } from '../store/deviceStore.js';
import { compress, decompress } from '../crypto/compress.js';
import {
  signWithRecoveryPhrase,
  verifyRecoverySignature,
  verifyLinkChallenge,
  serializeAnnounceForSigning,
  generateVerifyCode,
} from '../crypto/signatures.js';
import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { createSchema } from '../orm/index.js';
import { logger } from '../../lib/logger.js';

// Default reconnect settings
const RECONNECT_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

// Prekey replenishment settings
const PREKEY_MIN_COUNT = 20;
const PREKEY_REPLENISH_COUNT = 50;

export class ObscuraClient {
  constructor(opts) {
    this.apiUrl = opts.apiUrl;
    this.store = opts.store;
    this.token = opts.token;
    this.refreshToken = opts.refreshToken;
    this.userId = opts.userId;
    this.username = opts.username;
    this.deviceUsername = opts.deviceUsername;
    this.deviceUUID = opts.deviceUUID;
    this.deviceInfo = opts.deviceInfo;
    this.p2pIdentity = opts.p2pIdentity;
    this.recoveryPublicKey = opts.recoveryPublicKey;  // Only public key, never private

    // Recovery phrase - private, cleared after read
    this._recoveryPhrase = opts.recoveryPhrase || null;

    // Link code for new device linking
    this.linkCode = opts.linkCode || null;

    // Initialize logger for this device
    if (this.userId) {
      logger.init(this.userId);
    }

    // Track used link codes (one-use enforcement)
    this._usedLinkCodes = new Set();

    // Persistence stores
    this._friendStore = this.userId ? createFriendStore(this.userId) : null;
    this._deviceStore = this.username ? createDeviceStore(this.username) : null;

    // Managers (with persistence)
    this.friends = new FriendManager(this._friendStore);
    this.devices = new DeviceManager(this.userId, this._deviceStore);
    this.messenger = new Messenger({
      apiUrl: this.apiUrl,
      store: this.store,
      token: this.token,
      protoBasePath: opts.protoBasePath,
    });
    this.attachments = new AttachmentManager({
      apiUrl: this.apiUrl,
      token: this.token,
    });

    // WebSocket - detect dev mode and use /ws proxy
    this.ws = null;
    const isBrowser = typeof window !== 'undefined';
    const isDev = isBrowser && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    this.wsUrl = isDev ? `ws://${window.location.host}/ws` : this.apiUrl.replace('https://', 'wss://');
    console.log('[ObscuraClient] WS setup:', { isBrowser, isDev, apiUrl: this.apiUrl, wsUrl: this.wsUrl });
    this._reconnectAttempts = 0;
    this._shouldReconnect = true;

    // Event handlers
    this._handlers = {
      message: [],
      attachment: [],
      friendRequest: [],
      friendResponse: [],
      deviceAnnounce: [],
      linkApproval: [],
      sentSync: [],
      syncBlob: [],
      modelSync: [],
      disconnect: [],
      reconnect: [],
      error: [],
    };

    // Message history (in-memory cache, persisted to IndexedDB)
    this.messages = [];

    // Message store for persistence (browser only)
    this.messageStore = null;
    if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
      this.messageStore = createMessageStore(this.username || this.userId || 'default');
    }

    // ORM Layer (initialized by schema())
    this._ormModels = null;
    this._ormSyncManager = null;

    // Auto-save session in browser
    if (typeof window !== 'undefined') {
      this.saveSession();
    }
  }

  /**
   * Save session to localStorage
   */
  saveSession() {
    if (typeof localStorage === 'undefined') return;
    const session = {
      apiUrl: this.apiUrl,
      token: this.token,
      refreshToken: this.refreshToken,
      userId: this.userId,
      username: this.username,
      deviceUsername: this.deviceUsername,
      deviceUUID: this.deviceUUID,
      // Store deviceInfo for verify codes (signalIdentityKey as array for JSON)
      deviceInfo: this.deviceInfo ? {
        deviceUUID: this.deviceInfo.deviceUUID,
        serverUserId: this.deviceInfo.serverUserId,
        deviceName: this.deviceInfo.deviceName,
        signalIdentityKey: this.deviceInfo.signalIdentityKey ? Array.from(this.deviceInfo.signalIdentityKey) : null,
      } : null,
    };
    localStorage.setItem('obscura_session', JSON.stringify(session));
  }

  /**
   * Clear session from localStorage
   */
  static clearSession() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('obscura_session');
    }
  }

  /**
   * Restore session from localStorage
   * @returns {ObscuraClient|null}
   */
  static restoreSession() {
    if (typeof localStorage === 'undefined') return null;

    const saved = localStorage.getItem('obscura_session');
    if (!saved) return null;

    try {
      const session = JSON.parse(saved);
      if (!session.token || !session.username) return null;

      // Recreate store from IndexedDB using username
      const store = createStore(session.username);

      // Restore deviceInfo with signalIdentityKey as Uint8Array
      const deviceInfo = session.deviceInfo ? {
        deviceUUID: session.deviceInfo.deviceUUID,
        serverUserId: session.deviceInfo.serverUserId,
        deviceName: session.deviceInfo.deviceName,
        signalIdentityKey: session.deviceInfo.signalIdentityKey ? new Uint8Array(session.deviceInfo.signalIdentityKey) : null,
      } : null;

      return new ObscuraClient({
        apiUrl: session.apiUrl,
        store,
        token: session.token,
        refreshToken: session.refreshToken,
        userId: session.userId,
        username: session.username,
        deviceUsername: session.deviceUsername,
        deviceUUID: session.deviceUUID,
        deviceInfo,
      });
    } catch (e) {
      console.warn('Failed to restore session:', e);
      return null;
    }
  }

  /**
   * Define models for the ORM layer
   *
   * Usage:
   *   await client.schema({
   *     story: { fields: { content: 'string' }, sync: 'g-set', ephemeral: true, ttl: '24h' },
   *     streak: { fields: { count: 'number' }, sync: 'lww', collectable: true },
   *   });
   *
   *   // Then use:
   *   await client.story.create({ content: 'Hello!' });
   *
   * @param {object} definitions - Model definitions
   * @returns {Promise<SchemaBuilder>}
   */
  async schema(definitions) {
    return createSchema(this, definitions);
  }

  /**
   * Get recovery phrase (explicit backup flow - clears after first read)
   * @returns {string|null}
   */
  getRecoveryPhrase() {
    const phrase = this._recoveryPhrase;
    this._recoveryPhrase = null;
    return phrase;
  }

  /**
   * Get my 4-digit verify code for sharing with friends
   * They can use this to verify friend requests came from me
   * @returns {Promise<string>} 4-digit code ("0000" - "9999")
   */
  async getMyVerifyCode() {
    const identityKey = this.deviceInfo?.signalIdentityKey;
    if (!identityKey) return null;
    return generateVerifyCode(identityKey);
  }

  // === Message Persistence ===

  /**
   * Get messages for a conversation (from IndexedDB or in-memory)
   * @param {string} conversationId - Friend username
   * @returns {Promise<Array>} Messages sorted by timestamp
   */
  async getMessages(conversationId) {
    if (this.messageStore) {
      return this.messageStore.getMessages(conversationId);
    }
    // Fallback to in-memory
    return this.messages.filter(m =>
      m.from === conversationId || m.to === conversationId || m.conversationId === conversationId
    );
  }

  /**
   * Persist a message to IndexedDB (and in-memory cache)
   * @private
   */
  async _persistMessage(conversationId, message) {
    // Add to in-memory cache
    this.messages.push(message);

    // Persist to IndexedDB
    if (this.messageStore) {
      await this.messageStore.addMessage(conversationId, {
        messageId: message.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        content: message.text || message.content,
        timestamp: message.timestamp || Date.now(),
        isSent: message.isSent || false,
        authorDeviceId: message.authorDeviceId || this.deviceUUID,
      });
    }
  }

  /**
   * Register an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  on(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event].push(handler);
    }
    return this;
  }

  /**
   * Remove an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  off(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter(h => h !== handler);
    }
    return this;
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  _emit(event, data) {
    if (this._handlers[event]) {
      for (const handler of this._handlers[event]) {
        try {
          handler(data);
        } catch (e) {
          console.error(`Error in ${event} handler:`, e);
        }
      }
    }
  }

  /**
   * Connect to WebSocket gateway (auto-reconnect enabled)
   */
  async connect() {
    // Load persisted state from IndexedDB before connecting
    await this.friends.loadFromStore();
    await this.devices.loadFromStore();

    await this.messenger.loadProto();
    this._shouldReconnect = true;

    // Import ws for Node.js environment
    let WS;
    if (typeof WebSocket !== 'undefined') {
      WS = WebSocket;
    } else {
      WS = (await import('ws')).default;
    }

    return new Promise((resolve, reject) => {
      const url = `${this.wsUrl}/v1/gateway?token=${encodeURIComponent(this.token)}`;
      console.log('[ObscuraClient] Connecting to WebSocket:', url);
      console.log('[ObscuraClient] wsUrl:', this.wsUrl);
      this.ws = new WS(url);

      const onOpen = () => {
        console.log('[ObscuraClient] WebSocket connected!');
        this._reconnectAttempts = 0;
        logger.logGatewayConnect();
        resolve();
      };

      const onError = (err) => {
        console.log('[ObscuraClient] WebSocket error:', err);
        if (this._reconnectAttempts === 0) {
          reject(err);
        }
        this._emit('error', err);
      };

      const onClose = (event) => {
        logger.logGatewayDisconnect(event?.code, event?.reason);
        this._emit('disconnect');
        if (this._shouldReconnect) {
          this._scheduleReconnect();
        }
      };

      const onMessage = (data) => {
        // In browser: data is MessageEvent, use data.data
        // In Node.js ws: data is Buffer directly
        const payload = data.data !== undefined ? data.data : data;
        this._handleMessage(payload);
      };

      // Use the appropriate pattern based on environment
      if (this.ws.on) {
        // Node.js ws package
        this.ws.on('open', onOpen);
        this.ws.on('error', onError);
        this.ws.on('close', onClose);
        this.ws.on('message', onMessage);
      } else {
        // Browser WebSocket
        this.ws.onopen = onOpen;
        this.ws.onerror = onError;
        this.ws.onclose = onClose;
        this.ws.onmessage = onMessage;
      }
    });
  }

  /**
   * Schedule a reconnect with exponential backoff
   */
  _scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempts),
      RECONNECT_MAX_DELAY_MS
    );
    this._reconnectAttempts++;

    setTimeout(async () => {
      if (!this._shouldReconnect) return;

      try {
        await this.connect();
        this._emit('reconnect');
      } catch (e) {
        // Will retry via onClose
      }
    }, delay);
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    this._shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  async _handleMessage(data) {
    try {
      // Handle different data types
      let bytes;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
        bytes = new Uint8Array(data);
      } else if (data instanceof Blob) {
        // Handle Blob (Node.js ws package can return this)
        const buffer = await data.arrayBuffer();
        bytes = new Uint8Array(buffer);
      } else if (data?.arrayBuffer) {
        // Blob-like object
        const buffer = await data.arrayBuffer();
        bytes = new Uint8Array(buffer);
      } else {
        console.log(`  [ws] Unexpected data type: ${typeof data}, ${data?.constructor?.name}`);
        return;
      }

      if (bytes.length === 0) {
        return;
      }

      const frame = this.messenger.WebSocketFrame.decode(bytes);
      console.log('[ws] Frame received:', frame.envelope ? 'envelope' : frame.ack ? 'ack' : 'unknown', frame.envelope?.id?.slice(-8) || '');

      if (frame.envelope) {
        const correlationId = logger.generateCorrelationId();
        await logger.logReceiveEnvelope(
          frame.envelope.id,
          frame.envelope.sourceUserId,
          frame.envelope.message.type,
          correlationId
        );

        const decrypted = await this.messenger.decrypt(
          frame.envelope.sourceUserId,
          frame.envelope.message.content,
          frame.envelope.message.type
        );

        const msg = this.messenger.decodeClientMessage(decrypted);
        msg.sourceUserId = frame.envelope.sourceUserId;
        msg.envelopeId = frame.envelope.id;

        await logger.logReceiveDecode(frame.envelope.sourceUserId, msg.type, correlationId);

        this._routeMessage(msg);
        this._acknowledge(frame.envelope.id);

        await logger.logReceiveComplete(frame.envelope.id, frame.envelope.sourceUserId, msg.type, correlationId);

        // Check and replenish prekeys (non-blocking)
        this._checkAndReplenishPrekeys().catch(() => {});
      }
    } catch (e) {
      // Suppress replay protection errors (stale messages)
      if (e.name !== 'MessageCounterError') {
        console.error('  [ws] Failed to handle message:', e.message);
        this._emit('error', e);
      }
    }
  }

  /**
   * Route message to appropriate handler
   * This is the CENTRAL place where all incoming messages flow.
   * Persistence happens here (or in called methods) BEFORE ACK.
   */
  _routeMessage(msg) {
    // Log every incoming message
    console.log('[ws] Message:', msg.type, 'from:', msg.sourceUserId?.slice(-8) || 'unknown');

    switch (msg.type) {
      case 'FRIEND_REQUEST':
        const request = this.friends.processRequest(msg, (userId, username, accepted) => {
          return this._sendFriendResponse(userId, username, accepted);
        });
        this._emit('friendRequest', request);
        break;

      case 'FRIEND_RESPONSE':
        const response = this.friends.processResponse(msg);
        this._emit('friendResponse', response);
        break;

      case 'DEVICE_ANNOUNCE':
        const announce = this._processAnnounce(msg);
        this._emit('deviceAnnounce', announce);
        break;

      case 'DEVICE_LINK_APPROVAL':
        const approval = this._processLinkApproval(msg);
        this._emit('linkApproval', approval);
        break;

      case 'SENT_SYNC':
        this._processSentSync(msg);
        this._emit('sentSync', msg.sentSync);
        break;

      case 'SYNC_BLOB':
        this._processSyncBlob(msg);
        this._emit('syncBlob', msg.syncBlob);
        break;

      case 'CONTENT_REFERENCE':
        // Persist attachment reference as a special message type
        this._persistMessage(msg.sourceUserId, {
          from: msg.sourceUserId,
          type: 'ATTACHMENT',
          contentReference: msg.contentReference,
          timestamp: msg.timestamp,
          isSent: false,
        });
        this._emit('attachment', {
          from: msg.sourceUserId,
          contentReference: msg.contentReference,
          timestamp: msg.timestamp,
        });
        break;

      case 'MODEL_SYNC':
        // Route to ORM sync manager if available (non-blocking)
        if (this._ormSyncManager) {
          this._ormSyncManager.handleIncoming(msg.modelSync, msg.sourceUserId)
            .catch(e => console.error('MODEL_SYNC handling failed:', e.message));
        }
        this._emit('modelSync', {
          ...msg.modelSync,
          sourceUserId: msg.sourceUserId,
        });
        break;

      case 'TEXT':
      case 'IMAGE':
      default:
        // Look up username from serverUserId for correct conversationId
        const conversationId = this.friends.getUsernameFromServerId(msg.sourceUserId) || msg.sourceUserId;
        this._persistMessage(conversationId, {
          from: msg.sourceUserId,
          conversationId,
          type: msg.type,
          text: msg.text,
          timestamp: msg.timestamp,
          isSent: false,
        });
        this._emit('message', { ...msg, conversationId });
        break;
    }
  }

  /**
   * Acknowledge a message
   */
  _acknowledge(messageId) {
    if (!this.ws || this.ws.readyState !== 1) return;

    const frame = this.messenger.WebSocketFrame.create({
      ack: { messageId },
    });
    const buffer = this.messenger.WebSocketFrame.encode(frame).finish();
    this.ws.send(buffer);
  }

  /**
   * Send a friend request
   */
  async befriend(userId, username) {
    const myDeviceAnnounce = {
      devices: [{
        deviceUUID: this.deviceUUID,
        serverUserId: this.userId,
        deviceName: this.username,
        signalIdentityKey: this.deviceInfo?.signalIdentityKey || new Uint8Array(33),
      }],
      timestamp: Date.now(),
      isRevocation: false,
      signature: new Uint8Array(64),
    };

    await this.messenger.sendMessage(userId, {
      type: 'FRIEND_REQUEST',
      username: this.username,
      deviceAnnounce: myDeviceAnnounce,
    });

    this.friends.store(username, [], 'pending_outgoing');
  }

  /**
   * Send friend response (internal)
   */
  async _sendFriendResponse(userId, username, accepted) {
    const myDeviceAnnounce = accepted ? {
      devices: [{
        deviceUUID: this.deviceUUID,
        serverUserId: this.userId,
        deviceName: this.username,
        signalIdentityKey: this.deviceInfo?.signalIdentityKey || new Uint8Array(33),
      }],
      timestamp: Date.now(),
      isRevocation: false,
      signature: new Uint8Array(64),
    } : null;

    await this.messenger.sendMessage(userId, {
      type: 'FRIEND_RESPONSE',
      username: this.username,
      accepted,
      deviceAnnounce: myDeviceAnnounce,
    });
  }

  /**
   * Send a message to a friend (auto fan-out + self-sync)
   */
  async send(friendUsername, opts) {
    const targets = this.friends.getFanOutTargets(friendUsername);
    const messageId = this.messenger.generateMessageId();
    const timestamp = Date.now();
    const correlationId = logger.generateCorrelationId();

    // Build message
    const msgOpts = {
      type: opts.type || 'TEXT',
      text: opts.text || '',
      timestamp,
      ...opts,
    };

    // Log send start
    await logger.logSendStart(friendUsername, msgOpts.type, correlationId);

    // Fan-out to all friend devices
    for (const targetUserId of targets) {
      await this.messenger.sendMessage(targetUserId, msgOpts);
    }

    // Log send complete
    await logger.logSendComplete(friendUsername, targets.length, correlationId);

    // Store locally and persist to IndexedDB
    await this._persistMessage(friendUsername, {
      to: friendUsername,
      messageId,
      timestamp,
      text: opts.text,
      isSent: true,
    });

    // Self-sync to own devices
    const selfTargets = this.devices.getSelfSyncTargets();
    if (selfTargets.length > 0) {
      for (const targetUserId of selfTargets) {
        await this.messenger.sendMessage(targetUserId, {
          type: 'SENT_SYNC',
          sentSync: {
            conversationId: friendUsername,
            messageId,
            timestamp,
            content: opts.text,
          },
        });
      }
    }
  }

  /**
   * Send an attachment to a friend (upload once, fan-out ContentReference)
   * @param {string} friendUsername - Friend to send to
   * @param {Blob|ArrayBuffer|Uint8Array} content - Content to upload
   * @param {object} opts - Optional: { contentType }
   * @returns {Promise<object>} The ContentReference
   */
  async sendAttachment(friendUsername, content, opts = {}) {
    // Upload and encrypt once
    const ref = await this.attachments.upload(content);

    // Fan-out ContentReference to all friend devices
    const targets = this.friends.getFanOutTargets(friendUsername);
    const timestamp = Date.now();

    for (const targetUserId of targets) {
      await this.messenger.sendMessage(targetUserId, {
        type: 'CONTENT_REFERENCE',
        contentReference: ref,
        timestamp,
      });
    }

    // Self-sync to own devices
    const selfTargets = this.devices.getSelfSyncTargets();
    for (const targetUserId of selfTargets) {
      await this.messenger.sendMessage(targetUserId, {
        type: 'SENT_SYNC',
        sentSync: {
          conversationId: friendUsername,
          messageId: ref.attachmentId,
          timestamp,
          contentReference: ref,
        },
      });
    }

    return ref;
  }

  /**
   * Approve a device link (existing device approves new)
   * Sends DEVICE_LINK_APPROVAL followed by SYNC_BLOB
   *
   * Security checks:
   * - Link code expiry (5 min)
   * - One-use (can't replay)
   * - Signature verification (proves code came from device with that key)
   */
  async approveLink(linkCode) {
    const parsed = parseLinkCode(linkCode);

    // Check expiry (if present - for backwards compat)
    if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
      throw new Error('Link code expired');
    }

    // Check one-use (convert challenge to string for Set)
    const challengeKey = Array.from(parsed.challenge).join(',');
    if (this._usedLinkCodes.has(challengeKey)) {
      throw new Error('Link code already used');
    }
    this._usedLinkCodes.add(challengeKey);

    // Verify signature (if present - for backwards compat)
    if (parsed.signature && parsed.signalIdentityKey) {
      const valid = await verifyLinkChallenge(
        parsed.challenge,
        parsed.signature,
        parsed.signalIdentityKey
      );
      if (!valid) {
        throw new Error('Invalid link code signature');
      }
    }

    const approval = buildLinkApproval({
      p2pPublicKey: this.p2pIdentity?.publicKey || new Uint8Array(32),
      recoveryPublicKey: this.recoveryPublicKey || new Uint8Array(32),
      challenge: parsed.challenge,
      ownDevices: this.devices.buildFullList(this.deviceInfo || {
        serverUserId: this.userId,
        deviceUUID: this.deviceUUID,
        deviceName: this.username,
      }),
    });

    // Send approval first
    await this.messenger.sendMessage(parsed.serverUserId, {
      type: 'DEVICE_LINK_APPROVAL',
      deviceLinkApproval: approval,
    });

    // Add new device to our list
    this.devices.add({
      serverUserId: parsed.serverUserId,
      signalIdentityKey: parsed.signalIdentityKey,
    });

    // Send SYNC_BLOB with full state
    const syncData = {
      friends: this._serializeFriends(),
      messages: this.messageStore ? await this.messageStore.exportAll() : this.messages,
      settings: {},
    };
    const compressedData = await compress(syncData);

    await this.messenger.sendMessage(parsed.serverUserId, {
      type: 'SYNC_BLOB',
      syncBlob: { compressedData },
    });
  }

  /**
   * Serialize friends for sync
   */
  _serializeFriends() {
    const result = [];
    for (const [username, data] of this.friends.friends.entries()) {
      result.push({
        username,
        devices: data.devices,
        status: data.status,
        addedAt: data.addedAt,
      });
    }
    return result;
  }

  /**
   * Process SYNC_BLOB (new device receives full state)
   */
  async _processSyncBlob(msg) {
    if (!msg.syncBlob?.compressedData) return;

    try {
      const data = await decompress(msg.syncBlob.compressedData);

      // Restore friends
      if (data.friends) {
        for (const friend of data.friends) {
          this.friends.store(friend.username, friend.devices, friend.status);
        }
      }

      // Restore messages
      if (data.messages) {
        // Persist to IndexedDB
        if (this.messageStore) {
          await this.messageStore.importMessages(data.messages);
        }
        // Also update in-memory cache
        this.messages = [...this.messages, ...data.messages];
      }

      // Settings could be applied here
    } catch (e) {
      console.error('Failed to process SYNC_BLOB:', e.message);
    }
  }

  /**
   * Process link approval (new device receives)
   */
  _processLinkApproval(msg) {
    const approval = msg.deviceLinkApproval;
    const self = this;

    return {
      ...approval,
      apply() {
        // Apply the device list
        if (approval.ownDevices) {
          self.devices.setAll(approval.ownDevices);
        }
      },
    };
  }

  /**
   * Announce devices to all friends
   */
  async announceDevices() {
    const announce = {
      devices: this.devices.buildFullList(this.deviceInfo || {
        serverUserId: this.userId,
        deviceUUID: this.deviceUUID,
        deviceName: this.username,
      }),
      timestamp: Date.now(),
      isRevocation: false,
      signature: new Uint8Array(64),
    };

    // Send to all friends
    for (const friend of this.friends.getAll()) {
      for (const device of friend.devices) {
        await this.messenger.sendMessage(device.serverUserId, {
          type: 'DEVICE_ANNOUNCE',
          deviceAnnounce: announce,
        });
      }
    }
  }

  /**
   * Revoke a device (remove from own list, broadcast to friends)
   * Requires recovery phrase to sign the revocation.
   *
   * @param {string} recoveryPhrase - 12-word BIP39 phrase
   * @param {string} deviceUUID - UUID of device to revoke
   */
  async revokeDevice(recoveryPhrase, deviceUUID) {
    // Remove from local device list
    this.devices.remove(deviceUUID);

    // Build revocation announcement with updated device list
    const announce = {
      devices: this.devices.buildFullList(this.deviceInfo || {
        serverUserId: this.userId,
        deviceUUID: this.deviceUUID,
        deviceName: this.username,
      }),
      timestamp: Date.now(),
      isRevocation: true,
    };

    // Sign with recovery key (derives keypair from phrase, signs, discards private key)
    const dataToSign = serializeAnnounceForSigning(announce);
    announce.signature = await signWithRecoveryPhrase(recoveryPhrase, dataToSign);

    // Broadcast to all friends
    for (const friend of this.friends.getAll()) {
      for (const device of friend.devices) {
        await this.messenger.sendMessage(device.serverUserId, {
          type: 'DEVICE_ANNOUNCE',
          deviceAnnounce: announce,
        });
      }
    }
  }

  /**
   * Process device announce (update friend's device list)
   * For revocations, verifies signature if recovery public key is known.
   */
  _processAnnounce(msg) {
    const announce = msg.deviceAnnounce;
    const self = this;

    return {
      ...announce,
      sourceUserId: msg.sourceUserId,

      /**
       * Apply the device list update
       * For revocations, optionally verify signature first
       */
      async apply() {
        // Find which friend this is from
        let friend = null;
        for (const f of self.friends.getAll()) {
          const isFromFriend = f.devices.some(d => d.serverUserId === msg.sourceUserId);
          if (isFromFriend) {
            friend = f;
            break;
          }
        }

        if (!friend) return;

        // For revocations, verify signature if we have their recovery public key
        if (announce.isRevocation) {
          if (friend.recoveryPublicKey && announce.signature) {
            const dataToSign = serializeAnnounceForSigning(announce);
            const valid = await verifyRecoverySignature(
              friend.recoveryPublicKey,
              dataToSign,
              announce.signature
            );
            if (!valid) {
              console.warn(`Invalid revocation signature from ${friend.username}, ignoring`);
              return;
            }
          }
          // If no recoveryPublicKey stored, accept anyway (backwards compat)
        }

        self.friends.setDevices(friend.username, announce.devices);
      },
    };
  }

  /**
   * Process sent sync (mark as sent by us)
   */
  _processSentSync(msg) {
    const sync = msg.sentSync;
    // Persist to IndexedDB using conversationId as the key
    this._persistMessage(sync.conversationId, {
      conversationId: sync.conversationId,
      messageId: sync.messageId,
      timestamp: sync.timestamp,
      text: typeof sync.content === 'string' ? sync.content : new TextDecoder().decode(sync.content),
      isSent: true,
    });
  }

  /**
   * Check prekey count and replenish if below threshold
   * Called after successful message decryption (prekeys consumed on first message from new sender)
   */
  async _checkAndReplenishPrekeys() {
    try {
      const count = await this.store.getPreKeyCount();
      if (count >= PREKEY_MIN_COUNT) return;

      const highestId = await this.store.getHighestPreKeyId();
      const newPreKeys = [];

      // Generate new prekeys
      for (let i = 1; i <= PREKEY_REPLENISH_COUNT; i++) {
        const pk = await KeyHelper.generatePreKey(highestId + i);
        await this.store.storePreKey(pk.keyId, pk.keyPair);
        newPreKeys.push({
          keyId: pk.keyId,
          publicKey: arrayBufferToBase64(pk.keyPair.pubKey),
        });
      }

      // Get identity key and registration ID for upload
      const identityKeyPair = await this.store.getIdentityKeyPair();
      const registrationId = await this.store.getLocalRegistrationId();
      const signedPreKey = await this._getSignedPreKeyForUpload();

      // Upload to server
      const response = await fetch(`${this.apiUrl}/v1/keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          identityKey: arrayBufferToBase64(identityKeyPair.pubKey),
          registrationId,
          signedPreKey,
          oneTimePreKeys: newPreKeys,
        }),
      });

      if (!response.ok) {
        console.warn('Prekey replenishment upload failed:', response.status);
      }
    } catch (e) {
      console.warn('Prekey replenishment failed:', e.message);
    }
  }

  /**
   * Get signed prekey in server format for upload
   */
  async _getSignedPreKeyForUpload() {
    // Get the current signed prekey (ID 1)
    const signedPreKey = await this.store.loadSignedPreKey(1);
    if (!signedPreKey) {
      throw new Error('No signed prekey found');
    }
    return {
      keyId: 1,
      publicKey: arrayBufferToBase64(signedPreKey.pubKey),
      signature: '', // Server should already have signature from registration
    };
  }
}

// Helper function for base64 encoding
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
