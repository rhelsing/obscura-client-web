/**
 * Friend Management Module
 * Tracks friends and their devices for fan-out messaging
 */

import { generateVerifyCode } from '../crypto/signatures.js';

export class FriendManager {
  constructor() {
    // Map of username -> { username, devices: [{ serverUserId, deviceName, signalIdentityKey }], status }
    this.friends = new Map();
  }

  /**
   * Store a friend (from FRIEND_RESPONSE or after accepting request)
   * @param {string} username - Friend's display username
   * @param {Array} devices - Array of device info objects
   * @param {string} status - 'pending_outgoing' | 'pending_incoming' | 'accepted'
   */
  store(username, devices, status = 'accepted') {
    this.friends.set(username, {
      username,
      devices: devices.map(d => ({
        serverUserId: d.serverUserId,
        deviceName: d.deviceName || d.serverUserId,
        signalIdentityKey: d.signalIdentityKey,
      })),
      status,
      addedAt: Date.now(),
    });
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
        deviceName: device.deviceName || device.serverUserId,
        signalIdentityKey: device.signalIdentityKey,
      });
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
      deviceName: d.deviceName || d.serverUserId,
      signalIdentityKey: d.signalIdentityKey,
    }));
  }

  /**
   * Remove a friend
   * @param {string} username
   */
  remove(username) {
    this.friends.delete(username);
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
    const senderIdentityKey = senderDevices[0]?.signalIdentityKey;

    this.store(senderUsername, senderDevices, 'pending_incoming');

    const self = this;
    return {
      username: senderUsername,
      devices: senderDevices,
      sourceUserId: msg.sourceUserId,

      /**
       * Get the 4-digit verify code for out-of-band verification
       * @returns {Promise<string>} 4-digit code ("0000" - "9999")
       */
      async getVerifyCode() {
        if (!senderIdentityKey) return null;
        return generateVerifyCode(senderIdentityKey);
      },

      async accept() {
        self.store(senderUsername, senderDevices, 'accepted');
        // Send response will be handled by ObscuraClient
        return sendFn(senderDevices[0]?.serverUserId, senderUsername, true);
      },

      async reject() {
        self.remove(senderUsername);
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

    if (accepted) {
      this.store(senderUsername, senderDevices, 'accepted');
    } else {
      this.remove(senderUsername);
    }

    return {
      username: senderUsername,
      accepted,
      devices: senderDevices,
    };
  }
}
