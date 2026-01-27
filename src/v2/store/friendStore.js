/**
 * Friend Store (Extended with Device Lists)
 * Per identity.md spec: Friends with device lists for fan-out
 */

const DB_NAME_PREFIX = 'obscura_friends_v2';
const DB_VERSION = 1;

const STORES = {
  FRIENDS: 'friends',
  PENDING_MESSAGES: 'pendingMessages',
};

export const FriendStatus = {
  PENDING_SENT: 'pending_sent',
  PENDING_RECEIVED: 'pending_received',
  ACCEPTED: 'accepted',
};

/**
 * Create a friend store instance
 * @param {string} userId - User ID (for database namespace)
 * @returns {object} Friend store instance
 */
export function createFriendStore(userId) {
  const dbName = `${DB_NAME_PREFIX}_${userId}`;
  let db = null;

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

        if (!database.objectStoreNames.contains(STORES.FRIENDS)) {
          const store = database.createObjectStore(STORES.FRIENDS, { keyPath: 'userId' });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('username', 'username', { unique: false });
        }

        if (!database.objectStoreNames.contains(STORES.PENDING_MESSAGES)) {
          const store = database.createObjectStore(STORES.PENDING_MESSAGES, {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('fromUserId', 'fromUserId', { unique: false });
        }
      };
    });
  }

  function close() {
    if (db) {
      db.close();
      db = null;
    }
  }

  async function getStore(storeName, mode = 'readonly') {
    await open();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

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
     * Add or update a friend
     * Per identity.md: Extended with devices and recoveryPublicKey
     */
    async addFriend(userId, username, status, options = {}) {
      const store = await getStore(STORES.FRIENDS, 'readwrite');
      const existing = await promisify(store.get(userId));

      return promisify(store.put({
        userId,
        username,
        status,
        devices: options.devices || existing?.devices || [],
        recoveryPublicKey: options.recoveryPublicKey || existing?.recoveryPublicKey,
        devicesUpdatedAt: options.devicesUpdatedAt || existing?.devicesUpdatedAt || 0,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      }));
    },

    /**
     * Get a friend by user ID
     */
    async getFriend(userId) {
      const store = await getStore(STORES.FRIENDS);
      return promisify(store.get(userId));
    },

    /**
     * Get all friends
     */
    async getAllFriends() {
      const store = await getStore(STORES.FRIENDS);
      return promisify(store.getAll());
    },

    /**
     * Get accepted friends only
     */
    async getAcceptedFriends() {
      const store = await getStore(STORES.FRIENDS);
      const index = store.index('status');
      return promisify(index.getAll(FriendStatus.ACCEPTED));
    },

    /**
     * Get pending friend requests
     */
    async getPendingRequests() {
      const store = await getStore(STORES.FRIENDS);
      const index = store.index('status');
      return promisify(index.getAll(FriendStatus.PENDING_RECEIVED));
    },

    /**
     * Update friend status
     */
    async updateFriendStatus(userId, newStatus) {
      const store = await getStore(STORES.FRIENDS, 'readwrite');
      const friend = await promisify(store.get(userId));
      if (friend) {
        friend.status = newStatus;
        friend.updatedAt = Date.now();
        return promisify(store.put(friend));
      }
    },

    /**
     * Update friend's device list
     * Per identity.md: From DeviceAnnounce messages
     */
    async updateFriendDevices(userId, devices, timestamp = Date.now()) {
      const store = await getStore(STORES.FRIENDS, 'readwrite');
      const friend = await promisify(store.get(userId));
      if (friend) {
        // LWW: Only update if newer
        if (timestamp > (friend.devicesUpdatedAt || 0)) {
          friend.devices = devices;
          friend.devicesUpdatedAt = timestamp;
          friend.updatedAt = Date.now();
          return promisify(store.put(friend));
        }
      }
    },

    /**
     * Get friend's device list
     */
    async getFriendDevices(userId) {
      const friend = await this.getFriend(userId);
      return friend?.devices || [];
    },

    /**
     * Set friend's recovery public key
     * Per identity.md: For verifying revocation signatures
     */
    async setFriendRecoveryKey(userId, recoveryPublicKey) {
      const store = await getStore(STORES.FRIENDS, 'readwrite');
      const friend = await promisify(store.get(userId));
      if (friend) {
        friend.recoveryPublicKey = recoveryPublicKey;
        friend.updatedAt = Date.now();
        return promisify(store.put(friend));
      }
    },

    /**
     * Remove a friend
     */
    async removeFriend(userId) {
      const store = await getStore(STORES.FRIENDS, 'readwrite');
      return promisify(store.delete(userId));
    },

    /**
     * Check if user is an accepted friend
     */
    async isFriend(userId) {
      const friend = await this.getFriend(userId);
      return friend?.status === FriendStatus.ACCEPTED;
    },

    // ==================== Pending Messages ====================

    /**
     * Add a pending message
     */
    async addPendingMessage(message) {
      const store = await getStore(STORES.PENDING_MESSAGES, 'readwrite');
      return promisify(store.add({
        ...message,
        receivedAt: Date.now(),
      }));
    },

    /**
     * Get all pending messages
     */
    async getPendingMessages() {
      const store = await getStore(STORES.PENDING_MESSAGES);
      return promisify(store.getAll());
    },

    /**
     * Get pending messages from a specific user
     */
    async getPendingMessagesFrom(userId) {
      const store = await getStore(STORES.PENDING_MESSAGES);
      const index = store.index('fromUserId');
      return promisify(index.getAll(userId));
    },

    /**
     * Delete a pending message
     */
    async deletePendingMessage(id) {
      const store = await getStore(STORES.PENDING_MESSAGES, 'readwrite');
      return promisify(store.delete(id));
    },

    /**
     * Clear all pending messages
     */
    async clearPendingMessages() {
      const store = await getStore(STORES.PENDING_MESSAGES, 'readwrite');
      return promisify(store.clear());
    },

    // ==================== Export/Import ====================

    /**
     * Export all data for device sync
     */
    async exportAll() {
      const friends = await this.getAllFriends();
      const pendingMessages = await this.getPendingMessages();
      return { friends, pendingMessages };
    },

    /**
     * Import data from device sync
     */
    async importAll(data) {
      if (data.friends) {
        const store = await getStore(STORES.FRIENDS, 'readwrite');
        for (const friend of data.friends) {
          await promisify(store.put(friend));
        }
      }
      if (data.pendingMessages) {
        const store = await getStore(STORES.PENDING_MESSAGES, 'readwrite');
        for (const msg of data.pendingMessages) {
          await promisify(store.add(msg));
        }
      }
    },

    /**
     * Clear all data
     */
    async clearAll() {
      const friendStore = await getStore(STORES.FRIENDS, 'readwrite');
      await promisify(friendStore.clear());
      const msgStore = await getStore(STORES.PENDING_MESSAGES, 'readwrite');
      await promisify(msgStore.clear());
    },
  };
}

export default createFriendStore;
