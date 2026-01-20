// IndexedDB store for friends and pending messages
// Separate from signalStore to keep concerns isolated

const DB_NAME = 'obscura_friends';
const DB_VERSION = 1;

const STORES = {
  FRIENDS: 'friends',
  PENDING_MESSAGES: 'pendingMessages',
};

// Friend status values
export const FriendStatus = {
  PENDING_SENT: 'pending_sent',       // We sent them a request
  PENDING_RECEIVED: 'pending_received', // They sent us a request
  ACCEPTED: 'accepted',               // Both accepted
};

class FriendStore {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORES.FRIENDS)) {
          const friendStore = db.createObjectStore(STORES.FRIENDS, { keyPath: 'userId' });
          friendStore.createIndex('status', 'status', { unique: false });
          friendStore.createIndex('username', 'username', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.PENDING_MESSAGES)) {
          const msgStore = db.createObjectStore(STORES.PENDING_MESSAGES, { keyPath: 'id', autoIncrement: true });
          msgStore.createIndex('fromUserId', 'fromUserId', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  // === Friend Methods ===

  async addFriend(userId, username, status = FriendStatus.PENDING_SENT) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.FRIENDS, 'readwrite');
      const store = tx.objectStore(STORES.FRIENDS);

      const friend = {
        userId,
        username,
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const request = store.put(friend);
      request.onsuccess = () => resolve(friend);
      request.onerror = () => reject(request.error);
    });
  }

  async getFriend(userId) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.FRIENDS, 'readonly');
      const store = tx.objectStore(STORES.FRIENDS);
      const request = store.get(userId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllFriends() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.FRIENDS, 'readonly');
      const store = tx.objectStore(STORES.FRIENDS);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getAcceptedFriends() {
    const all = await this.getAllFriends();
    return all.filter(f => f.status === FriendStatus.ACCEPTED);
  }

  async getPendingRequests() {
    const all = await this.getAllFriends();
    return all.filter(f => f.status === FriendStatus.PENDING_RECEIVED);
  }

  async updateFriendStatus(userId, status) {
    await this.open();
    const friend = await this.getFriend(userId);
    if (!friend) {
      throw new Error(`Friend not found: ${userId}`);
    }

    friend.status = status;
    friend.updatedAt = Date.now();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.FRIENDS, 'readwrite');
      const store = tx.objectStore(STORES.FRIENDS);
      const request = store.put(friend);

      request.onsuccess = () => resolve(friend);
      request.onerror = () => reject(request.error);
    });
  }

  async removeFriend(userId) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.FRIENDS, 'readwrite');
      const store = tx.objectStore(STORES.FRIENDS);
      const request = store.delete(userId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async isFriend(userId) {
    const friend = await this.getFriend(userId);
    return friend?.status === FriendStatus.ACCEPTED;
  }

  // === Pending Message Methods ===

  async addPendingMessage(message) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PENDING_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORES.PENDING_MESSAGES);

      const msg = {
        ...message,
        receivedAt: Date.now(),
      };

      const request = store.add(msg);
      request.onsuccess = () => {
        msg.id = request.result;
        resolve(msg);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getPendingMessages() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PENDING_MESSAGES, 'readonly');
      const store = tx.objectStore(STORES.PENDING_MESSAGES);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getPendingMessagesFrom(userId) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PENDING_MESSAGES, 'readonly');
      const store = tx.objectStore(STORES.PENDING_MESSAGES);
      const index = store.index('fromUserId');
      const request = index.getAll(userId);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async deletePendingMessage(id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PENDING_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORES.PENDING_MESSAGES);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clearAllPendingMessages() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORES.PENDING_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORES.PENDING_MESSAGES);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // === Utility Methods ===

  async clearAll() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(Object.values(STORES), 'readwrite');

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      for (const storeName of Object.values(STORES)) {
        tx.objectStore(storeName).clear();
      }
    });
  }
}

export const friendStore = new FriendStore();
export default friendStore;
