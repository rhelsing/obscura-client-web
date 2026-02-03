/**
 * Friend Management Module
 * Tracks friends and their devices for fan-out messaging
 * Now with IndexedDB persistence via friendStore
 */

import { generateVerifyCodeFromDevices } from '../crypto/signatures.js';
import { logger } from './logger.js';

export class FriendManager {
  constructor(store = null) {
    // Map of username -> { username, devices: [{ serverUserId, deviceUUID, deviceName, signalIdentityKey }], status }
    this.friends = new Map();
    this._store = store;  // friendStore instance for IndexedDB persistence
  }

  /**
   * Load friends from IndexedDB into memory
   * Call this on startup to restore persisted state
   */
  async loadFromStore() {
    if (!this._store) return;
    try {
      const friends = await this._store.getAllFriends();
      for (const f of friends) {
        // Map friendStore status names to FriendManager status names
        let status = f.status;
        if (status === 'pending_received') status = 'pending_incoming';
        if (status === 'pending_sent') status = 'pending_outgoing';

        this.friends.set(f.username, {
          username: f.username,
          devices: f.devices || [],
          status,
          addedAt: f.createdAt,
          recoveryPublicKey: f.recoveryPublicKey || null,
        });
      }
      console.log(`[FriendManager] Loaded ${friends.length} friends from IndexedDB`);
    } catch (e) {
      console.warn('[FriendManager] Failed to load from store:', e.message);
    }
  }

  /**
   * Persist a friend to IndexedDB
   */
  async _persistFriend(username) {
    if (!this._store) return;
    const f = this.friends.get(username);
    if (!f) return;

    // Map FriendManager status to friendStore status
    let storeStatus = f.status;
    if (storeStatus === 'pending_incoming') storeStatus = 'pending_received';
    if (storeStatus === 'pending_outgoing') storeStatus = 'pending_sent';

    // Determine the userId key for IndexedDB
    // First, check if there's an existing entry by scanning all friends
    // to avoid creating duplicates with different keys
    let userId = f.devices[0]?.serverUserId || username;

    try {
      // Check if a friend with this username already exists under a different key
      const allFriends = await this._store.getAllFriends();
      const existingByUsername = allFriends.find(ef => ef.username === username);

      if (existingByUsername && existingByUsername.userId !== userId) {
        // Friend exists under different key - delete old entry first
        await this._store.removeFriend(existingByUsername.userId);
      }

      await this._store.addFriend(userId, f.username, storeStatus, {
        devices: f.devices,
        recoveryPublicKey: f.recoveryPublicKey,
      });
    } catch (e) {
      console.warn('[FriendManager] Failed to persist friend:', e.message);
    }
  }

  /**
   * Remove a friend from IndexedDB
   */
  async _removeFriendFromStore(username) {
    if (!this._store) return;
    const f = this.friends.get(username);
    if (!f) return;
    const userId = f.devices[0]?.serverUserId || username;
    try {
      await this._store.removeFriend(userId);
    } catch (e) {
      console.warn('[FriendManager] Failed to remove friend from store:', e.message);
    }
  }

  /**
   * Store a friend (from FRIEND_RESPONSE or after accepting request)
   * @param {string} username - Friend's display username
   * @param {Array} devices - Array of device info objects
   * @param {string} status - 'pending_outgoing' | 'pending_incoming' | 'accepted'
   * @param {Uint8Array} [recoveryPublicKey] - Friend's recovery public key for verifying revocation
   */
  store(username, devices, status = 'accepted', recoveryPublicKey = null) {
    // Check if friend already exists - preserve devices if new ones are empty
    const existing = this.friends.get(username);
    const newDevices = devices.map(d => ({
      serverUserId: d.serverUserId,
      deviceUUID: d.deviceUUID || d.serverUserId, // For story/model filtering
      deviceName: d.deviceName || d.serverUserId,
      signalIdentityKey: d.signalIdentityKey,
    }));

    // Use new devices if provided, otherwise preserve existing
    const finalDevices = newDevices.length > 0 ? newDevices : (existing?.devices || []);

    this.friends.set(username, {
      username,
      devices: finalDevices,
      status,
      addedAt: existing?.addedAt || Date.now(),
      recoveryPublicKey: recoveryPublicKey || existing?.recoveryPublicKey || null,
    });
    // Persist to IndexedDB (fire-and-forget but logged)
    this._persistFriend(username);

    // Log friend status changes (fire-and-forget, don't block)
    if (status === 'pending_outgoing') {
      logger.logFriendRequestSent(username, finalDevices.length).catch(() => {});
    }
  }

  /**
   * Get a friend by username
   * @param {string} username
   * @returns {object|undefined}
   */
  get(username) {
    return this.friends.get(username);
  }

  /**
   * Reverse lookup: find username from a device's serverUserId
   * @param {string} serverUserId - Server user ID to look up
   * @returns {string|null} Username or null if not found
   */
  getUsernameFromServerId(serverUserId) {
    for (const [username, friend] of this.friends) {
      if (friend.devices.some(d => d.serverUserId === serverUserId)) {
        return username;
      }
    }
    return null;
  }

  /**
   * Check if we're friends with someone (accepted status)
   * @param {string} username
   * @returns {boolean}
   */
  isFriendsWith(username) {
    const friend = this.friends.get(username);
    return friend && friend.status === 'accepted';
  }

  /**
   * Get all serverUserIds for a friend (for fan-out messaging)
   * @param {string} username - Friend's display username
   * @returns {string[]} Array of serverUserIds
   */
  getFanOutTargets(username) {
    const friend = this.friends.get(username);
    if (!friend) {
      throw new Error(`Not friends with ${username}`);
    }
    if (friend.status !== 'accepted') {
      throw new Error(`Friend request with ${username} not yet accepted`);
    }
    if (!friend.devices || friend.devices.length === 0) {
      throw new Error(`No devices known for ${username}`);
    }
    return friend.devices.map(d => d.serverUserId);
  }

  /**
   * Add a device to a friend's device list (from DeviceAnnounce)
   * @param {string} username - Friend's username
   * @param {object} device - Device info { serverUserId, deviceName, signalIdentityKey }
   */
  addDevice(username, device) {
    const friend = this.friends.get(username);
    if (!friend) {
      throw new Error(`Not friends with ${username}`);
    }

    // Don't add duplicates
    const exists = friend.devices.some(d => d.serverUserId === device.serverUserId);
    if (!exists) {
      friend.devices.push({
        serverUserId: device.serverUserId,
        deviceUUID: device.deviceUUID || device.serverUserId, // For story/model filtering
        deviceName: device.deviceName || device.serverUserId,
        signalIdentityKey: device.signalIdentityKey,
      });
      // Persist updated device list
      this._persistFriend(username);
    }
  }

  /**
   * Set a friend's complete device list (from DeviceAnnounce)
   * @param {string} username - Friend's username
   * @param {Array} devices - Array of device info objects
   */
  setDevices(username, devices) {
    const friend = this.friends.get(username);
    if (!friend) {
      throw new Error(`Not friends with ${username}`);
    }
    friend.devices = devices.map(d => ({
      serverUserId: d.serverUserId,
      deviceUUID: d.deviceUUID || d.serverUserId, // For story/model filtering
      deviceName: d.deviceName || d.serverUserId,
      signalIdentityKey: d.signalIdentityKey,
    }));
    // Persist updated device list
    this._persistFriend(username);
  }

  /**
   * Remove a friend
   * @param {string} username
   */
  remove(username) {
    this._removeFriendFromStore(username);
    this.friends.delete(username);
    logger.logFriendRemove(username).catch(() => {});
  }

  /**
   * Get all accepted friends
   * @returns {Array}
   */
  getAll() {
    return Array.from(this.friends.values()).filter(f => f.status === 'accepted');
  }

  /**
   * Get pending incoming requests
   * @returns {Array}
   */
  getPendingIncoming() {
    return Array.from(this.friends.values()).filter(f => f.status === 'pending_incoming');
  }

  /**
   * Get pending outgoing requests
   * @returns {Array}
   */
  getPendingOutgoing() {
    return Array.from(this.friends.values()).filter(f => f.status === 'pending_outgoing');
  }

  /**
   * Process incoming FRIEND_REQUEST
   * @param {object} msg - Message with username and deviceAnnounce
   * @returns {object} FriendRequest object with accept/reject methods and verifyCode
   */
  processRequest(msg, sendFn) {
    const senderUsername = msg.username;
    const senderDevices = msg.deviceAnnounce?.devices || [];
    const senderRecoveryKey = msg.deviceAnnounce?.recoveryPublicKey;
    // Sort by deviceUUID for deterministic "primary" device across all clients
    const sortedDevices = [...senderDevices].sort((a, b) =>
      (a.deviceUUID || '').localeCompare(b.deviceUUID || '')
    );
    const senderIdentityKey = sortedDevices[0]?.signalIdentityKey;

    // Store recovery key with pending request so it survives page reloads
    this.store(senderUsername, senderDevices, 'pending_incoming', senderRecoveryKey);
    logger.logFriendRequestReceived(senderUsername, msg.sourceUserId, senderDevices.length).catch(() => {});

    const self = this;
    return {
      username: senderUsername,
      devices: senderDevices,
      sourceUserId: msg.sourceUserId,
      recoveryPublicKey: senderRecoveryKey,

      /**
       * Get the 4-digit verify code for out-of-band verification
       * Concatenates all device keys (sorted) and hashes for the code
       * @returns {Promise<string>} 4-digit code ("0000" - "9999")
       */
      async getVerifyCode() {
        if (!senderDevices || senderDevices.length === 0) return null;
        return generateVerifyCodeFromDevices(senderDevices);
      },

      async accept() {
        self.store(senderUsername, senderDevices, 'accepted', senderRecoveryKey);
        // Store friend's recovery key for verifying revocation signatures
        if (senderRecoveryKey && self._store) {
          const userId = senderDevices[0]?.serverUserId || senderUsername;
          self._store.setFriendRecoveryKey(userId, senderRecoveryKey).catch(e => {
            console.warn('Failed to store friend recovery key:', e.message);
          });
        }
        // Send response - logging happens in ObscuraClient._sendFriendResponse
        return sendFn(senderDevices[0]?.serverUserId, senderUsername, true);
      },

      async reject() {
        self.remove(senderUsername);
        // Send response - logging happens in ObscuraClient._sendFriendResponse
        return sendFn(senderDevices[0]?.serverUserId, senderUsername, false);
      },
    };
  }

  /**
   * Process incoming FRIEND_RESPONSE
   * @param {object} msg - Message with username, accepted, and deviceAnnounce
   * @returns {object} Response info
   */
  processResponse(msg) {
    const senderUsername = msg.username;
    const accepted = msg.accepted;
    const senderDevices = msg.deviceAnnounce?.devices || [];
    const senderRecoveryKey = msg.deviceAnnounce?.recoveryPublicKey;

    if (accepted) {
      this.store(senderUsername, senderDevices, 'accepted', senderRecoveryKey);
      // Store friend's recovery key for verifying revocation signatures
      if (senderRecoveryKey && this._store) {
        const userId = senderDevices[0]?.serverUserId || senderUsername;
        this._store.setFriendRecoveryKey(userId, senderRecoveryKey).catch(e => {
          console.warn('Failed to store friend recovery key:', e.message);
        });
      }
    } else {
      this.remove(senderUsername);
    }

    return {
      username: senderUsername,
      accepted,
      devices: senderDevices,
      recoveryPublicKey: senderRecoveryKey,
    };
  }
}
