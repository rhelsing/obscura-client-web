/**
 * Device Identity Store
 * Per identity.md spec: IndexedDB for device identity
 */

const DB_NAME_PREFIX = 'obscura_device';
const DB_VERSION = 1;

const STORES = {
  IDENTITY: 'identity',
  OWN_DEVICES: 'ownDevices',
};

/**
 * Create a device store instance
 * @param {string} coreUsername - Core username (for database namespace)
 * @returns {object} Device store instance
 */
export function createDeviceStore(coreUsername) {
  const dbName = `${DB_NAME_PREFIX}_${coreUsername}`;
  let db = null;

  /**
   * Open or create the database
   */
  async function open() {
    if (db) return db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        // Identity store (singleton - just one record per user)
        if (!database.objectStoreNames.contains(STORES.IDENTITY)) {
          database.createObjectStore(STORES.IDENTITY, { keyPath: 'id' });
        }

        // Own devices store (list of linked devices)
        if (!database.objectStoreNames.contains(STORES.OWN_DEVICES)) {
          const store = database.createObjectStore(STORES.OWN_DEVICES, { keyPath: 'deviceUUID' });
          store.createIndex('serverUserId', 'serverUserId', { unique: true });
        }
      };
    });
  }

  /**
   * Close the database
   */
  function close() {
    if (db) {
      db.close();
      db = null;
    }
  }

  /**
   * Get a transaction and object store
   */
  async function getStore(storeName, mode = 'readonly') {
    await open();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  /**
   * Promise wrapper for IDB request
   */
  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    open,
    close,

    /**
     * Store device identity
     * Per identity.md: coreUsername, deviceUsername, deviceUUID, p2pIdentity, recoveryPublicKey
     */
    async storeIdentity(identity) {
      const store = await getStore(STORES.IDENTITY, 'readwrite');
      return promisify(store.put({
        id: 'current', // Singleton key
        coreUsername: identity.coreUsername,
        deviceUsername: identity.deviceUsername,
        deviceUUID: identity.deviceUUID,
        p2pPublicKey: identity.p2pPublicKey,
        p2pPrivateKey: identity.p2pPrivateKey,
        recoveryPublicKey: identity.recoveryPublicKey,
        linkPending: identity.linkPending || false,
        createdAt: identity.createdAt || Date.now(),
        updatedAt: Date.now(),
      }));
    },

    /**
     * Get device identity
     */
    async getIdentity() {
      const store = await getStore(STORES.IDENTITY);
      return promisify(store.get('current'));
    },

    /**
     * Update identity (partial update)
     */
    async updateIdentity(updates) {
      const current = await this.getIdentity();
      if (!current) {
        throw new Error('No identity to update');
      }
      return this.storeIdentity({ ...current, ...updates });
    },

    /**
     * Delete identity
     */
    async deleteIdentity() {
      const store = await getStore(STORES.IDENTITY, 'readwrite');
      return promisify(store.delete('current'));
    },

    /**
     * Check if identity exists
     */
    async hasIdentity() {
      const identity = await this.getIdentity();
      return !!identity;
    },

    /**
     * Add a device to own devices list
     */
    async addOwnDevice(device) {
      const store = await getStore(STORES.OWN_DEVICES, 'readwrite');
      return promisify(store.put({
        deviceUUID: device.deviceUUID,
        serverUserId: device.serverUserId,
        deviceName: device.deviceName,
        signalIdentityKey: device.signalIdentityKey,
        addedAt: device.addedAt || Date.now(),
      }));
    },

    /**
     * Get all own devices
     */
    async getOwnDevices() {
      const store = await getStore(STORES.OWN_DEVICES);
      return promisify(store.getAll());
    },

    /**
     * Get own device by UUID
     */
    async getOwnDevice(deviceUUID) {
      const store = await getStore(STORES.OWN_DEVICES);
      return promisify(store.get(deviceUUID));
    },

    /**
     * Remove a device from own devices list
     */
    async removeOwnDevice(deviceUUID) {
      const store = await getStore(STORES.OWN_DEVICES, 'readwrite');
      return promisify(store.delete(deviceUUID));
    },

    /**
     * Set entire own devices list (replace all)
     */
    async setOwnDevices(devices) {
      const store = await getStore(STORES.OWN_DEVICES, 'readwrite');
      // Clear existing
      await promisify(store.clear());
      // Add all new
      for (const device of devices) {
        await promisify(store.put({
          deviceUUID: device.deviceUUID,
          serverUserId: device.serverUserId,
          deviceName: device.deviceName,
          signalIdentityKey: device.signalIdentityKey,
          addedAt: device.addedAt || Date.now(),
        }));
      }
    },

    /**
     * Clear all data
     */
    async clearAll() {
      const stores = [STORES.IDENTITY, STORES.OWN_DEVICES];
      for (const storeName of stores) {
        const store = await getStore(storeName, 'readwrite');
        await promisify(store.clear());
      }
    },

    /**
     * Export all data for device sync
     */
    async exportAll() {
      const identity = await this.getIdentity();
      const ownDevices = await this.getOwnDevices();
      return { identity, ownDevices };
    },

    /**
     * Import data from device sync
     */
    async importAll(data) {
      if (data.identity) {
        await this.storeIdentity(data.identity);
      }
      if (data.ownDevices) {
        await this.setOwnDevices(data.ownDevices);
      }
    },
  };
}

/**
 * Static method to get identity for a username without full store instance
 * Used during login flow before we know which store to use
 */
export async function getIdentityForUsername(coreUsername) {
  const store = createDeviceStore(coreUsername);
  try {
    return await store.getIdentity();
  } finally {
    store.close();
  }
}

export default createDeviceStore;
