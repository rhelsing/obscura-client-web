/**
 * Own Device Management Module
 * Tracks user's own devices for self-sync messaging
 * Now with IndexedDB persistence via deviceStore
 */

export class DeviceManager {
  constructor(currentUserId, store = null) {
    this.currentUserId = currentUserId;
    this._store = store;  // deviceStore instance for IndexedDB persistence
    // Array of { serverUserId, deviceUUID, deviceName, signalIdentityKey }
    this.ownDevices = [];
  }

  /**
   * Load own devices from IndexedDB into memory
   * Call this on startup to restore persisted state
   */
  async loadFromStore() {
    if (!this._store) return;
    try {
      const devices = await this._store.getOwnDevices();
      this.ownDevices = devices
        .filter(d => d.serverUserId !== this.currentUserId)
        .map(d => ({
          serverUserId: d.serverUserId,
          deviceUUID: d.deviceUUID,
          deviceName: d.deviceName || 'Unknown Device',
          signalIdentityKey: d.signalIdentityKey,
        }));
      console.log(`[DeviceManager] Loaded ${this.ownDevices.length} own devices from IndexedDB`);
    } catch (e) {
      console.warn('[DeviceManager] Failed to load from store:', e.message);
    }
  }

  /**
   * Persist all own devices to IndexedDB
   */
  async _persistDevices() {
    if (!this._store) return;
    try {
      await this._store.setOwnDevices(this.ownDevices);
    } catch (e) {
      console.warn('[DeviceManager] Failed to persist devices:', e.message);
    }
  }

  /**
   * Set current device's userId
   * @param {string} userId
   */
  setCurrentUserId(userId) {
    this.currentUserId = userId;
  }

  /**
   * Add an own device (from DEVICE_LINK_APPROVAL)
   * @param {object} device - { serverUserId, deviceUUID?, deviceName, signalIdentityKey? }
   */
  add(device) {
    // Don't add self
    if (device.serverUserId === this.currentUserId) {
      return;
    }

    // Don't add duplicates
    const exists = this.ownDevices.some(d => d.serverUserId === device.serverUserId);
    if (!exists) {
      this.ownDevices.push({
        serverUserId: device.serverUserId,
        deviceUUID: device.deviceUUID || device.serverUserId,
        deviceName: device.deviceName || 'Unknown Device',
        signalIdentityKey: device.signalIdentityKey,
      });
      // Persist to IndexedDB
      this._persistDevices();
    }
  }

  /**
   * Set all own devices (from DEVICE_LINK_APPROVAL)
   * @param {Array} devices - Array of device info objects
   */
  setAll(devices) {
    this.ownDevices = devices
      .filter(d => d.serverUserId !== this.currentUserId)
      .map(d => ({
        serverUserId: d.serverUserId,
        deviceUUID: d.deviceUUID || d.serverUserId,
        deviceName: d.deviceName || 'Unknown Device',
        signalIdentityKey: d.signalIdentityKey,
      }));
    // Persist to IndexedDB
    this._persistDevices();
  }

  /**
   * Get all own devices (excluding current)
   * @returns {Array}
   */
  getAll() {
    return [...this.ownDevices];
  }

  /**
   * Get serverUserIds of own devices for self-sync fan-out
   * @returns {string[]} Array of serverUserIds (excluding current device)
   */
  getSelfSyncTargets() {
    return this.ownDevices.map(d => d.serverUserId);
  }

  /**
   * Remove a device (revocation)
   * @param {string} idOrUUID - serverUserId or deviceUUID
   */
  remove(idOrUUID) {
    this.ownDevices = this.ownDevices.filter(d =>
      d.serverUserId !== idOrUUID && d.deviceUUID !== idOrUUID
    );
    // Persist to IndexedDB
    this._persistDevices();
  }

  /**
   * Get device by serverUserId
   * @param {string} serverUserId
   * @returns {object|undefined}
   */
  get(serverUserId) {
    return this.ownDevices.find(d => d.serverUserId === serverUserId);
  }

  /**
   * Check if we have any other devices
   * @returns {boolean}
   */
  hasOtherDevices() {
    return this.ownDevices.length > 0;
  }

  /**
   * Build device list including current device (for DeviceAnnounce)
   * @param {object} currentDeviceInfo - Current device's info
   * @returns {Array}
   */
  buildFullList(currentDeviceInfo) {
    return [
      {
        serverUserId: currentDeviceInfo.serverUserId,
        deviceUUID: currentDeviceInfo.deviceUUID,
        deviceName: currentDeviceInfo.deviceName || 'Current Device',
        signalIdentityKey: currentDeviceInfo.signalIdentityKey,
      },
      ...this.ownDevices,
    ];
  }
}

/**
 * Parse link code from another device
 * @param {string} linkCode - Base64 encoded link code
 * @returns {object} { userId, serverUserId, deviceUsername, signalIdentityKey, challenge, signature, expiresAt }
 */
export function parseLinkCode(linkCode) {
  try {
    const data = JSON.parse(atob(linkCode));
    return {
      userId: data.i,             // UUID for server API calls
      serverUserId: data.i,       // Alias for userId
      deviceUsername: data.u,     // Username for display
      signalIdentityKey: base64ToUint8Array(data.k),
      challenge: base64ToUint8Array(data.c),
      signature: data.s ? base64ToUint8Array(data.s) : null,  // Signature proving ownership
      expiresAt: data.e || null,  // Expiry timestamp (ms)
    };
  } catch (e) {
    throw new Error('Invalid link code');
  }
}

/**
 * Build link approval response
 * @param {object} opts - { p2pPublicKey, recoveryPublicKey, challenge, ownDevices }
 * @returns {object} DeviceLinkApproval proto-ready object
 */
export function buildLinkApproval(opts) {
  const { p2pPublicKey, recoveryPublicKey, challenge, ownDevices } = opts;

  // Challenge response is just the challenge signed/echoed back
  // In real impl this would be signed with p2p key
  const challengeResponse = challenge;

  return {
    p2pPublicKey,
    recoveryPublicKey,
    challengeResponse,
    ownDevices: ownDevices.map(d => ({
      deviceUuid: d.deviceUUID,
      serverUserId: d.serverUserId,
      deviceName: d.deviceName,
      signalIdentityKey: d.signalIdentityKey,
    })),
    friendsExport: new Uint8Array(0),
    sessionsExport: new Uint8Array(0),
    trustedIdsExport: new Uint8Array(0),
  };
}

// Helper
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
