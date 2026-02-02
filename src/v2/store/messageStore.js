/**
 * Message Store (IndexedDB)
 * Stores message history for sync between devices
 */

const DB_NAME_PREFIX = 'obscura_messages_v2';
const DB_VERSION = 1;

const STORES = {
  MESSAGES: 'messages',
};

/**
 * Create a message store instance
 * @param {string} userId - User ID (for database namespace)
 * @returns {object} Message store instance
 */
export function createMessageStore(userId) {
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

        if (!database.objectStoreNames.contains(STORES.MESSAGES)) {
          const store = database.createObjectStore(STORES.MESSAGES, { keyPath: 'messageId' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          // Compound index for conversation + time ordering
          store.createIndex('conversation_time', ['conversationId', 'timestamp'], { unique: false });
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
     * Add a message to the store
     * @param {string} conversationId - Friend username or ID
     * @param {object} message - Message object
     * @returns {Promise} Resolves when stored
     */
    async addMessage(conversationId, message) {
      const store = await getStore(STORES.MESSAGES, 'readwrite');

      // Check for duplicate (idempotent)
      const existing = await promisify(store.get(message.messageId));
      if (existing) {
        return existing; // Already have this message
      }

      return promisify(store.put({
        messageId: message.messageId,
        conversationId,
        timestamp: message.timestamp || Date.now(),
        content: message.content,
        mediaUrl: message.mediaUrl, // New: JSON string for attachments
        contentReference: message.contentReference, // Legacy: kept for backward compat
        isSent: message.isSent || false, // true = sent by me, false = received
        authorDeviceId: message.authorDeviceId,
        storedAt: Date.now(),
      }));
    },

    /**
     * Get a message by ID
     */
    async getMessage(messageId) {
      const store = await getStore(STORES.MESSAGES);
      return promisify(store.get(messageId));
    },

    /**
     * Get all messages for a conversation, ordered by timestamp
     * @param {string} conversationId - Friend username or ID
     * @param {object} options - { limit, offset }
     * @returns {Promise<Array>} Messages sorted by timestamp
     */
    async getMessages(conversationId, options = {}) {
      const store = await getStore(STORES.MESSAGES);
      const index = store.index('conversationId');
      const messages = await promisify(index.getAll(conversationId));

      // Sort by timestamp
      messages.sort((a, b) => a.timestamp - b.timestamp);

      // Apply pagination
      if (options.offset) {
        messages.splice(0, options.offset);
      }
      if (options.limit) {
        messages.splice(options.limit);
      }

      return messages;
    },

    /**
     * Get all messages (for sync export)
     * @returns {Promise<Array>} All messages
     */
    async getAllMessages() {
      const store = await getStore(STORES.MESSAGES);
      return promisify(store.getAll());
    },

    /**
     * Get all conversation IDs
     * @returns {Promise<Array>} Unique conversation IDs
     */
    async getConversationIds() {
      const messages = await this.getAllMessages();
      const ids = new Set(messages.map(m => m.conversationId));
      return Array.from(ids);
    },

    /**
     * Import messages from sync (idempotent)
     * @param {Array} messages - Messages to import
     * @returns {Promise} Resolves when done
     * Note: Deserializes contentReference Arrays back to Uint8Arrays
     */
    async importMessages(messages) {
      const store = await getStore(STORES.MESSAGES, 'readwrite');

      for (const msg of messages) {
        // Only add if not already present (dedup by messageId)
        const existing = await promisify(store.get(msg.messageId));
        if (!existing) {
          // Deserialize contentReference (Array -> Uint8Array)
          if (msg.contentReference) {
            msg.contentReference = {
              ...msg.contentReference,
              contentKey: msg.contentReference.contentKey ? new Uint8Array(msg.contentReference.contentKey) : undefined,
              nonce: msg.contentReference.nonce ? new Uint8Array(msg.contentReference.nonce) : undefined,
              contentHash: msg.contentReference.contentHash ? new Uint8Array(msg.contentReference.contentHash) : undefined,
            };
          }
          await promisify(store.put({
            ...msg,
            storedAt: Date.now(),
          }));
        }
      }
    },

    /**
     * Export all messages for sync
     * @returns {Promise<Array>} All messages (without storedAt, for cleaner export)
     * Note: Serializes contentReference Uint8Arrays to Arrays for JSON compatibility
     */
    async exportAll() {
      const messages = await this.getAllMessages();
      return messages.map(({ storedAt, ...msg }) => {
        // Serialize contentReference for JSON (Uint8Array -> Array)
        if (msg.contentReference) {
          msg.contentReference = {
            ...msg.contentReference,
            contentKey: msg.contentReference.contentKey ? Array.from(msg.contentReference.contentKey) : undefined,
            nonce: msg.contentReference.nonce ? Array.from(msg.contentReference.nonce) : undefined,
            contentHash: msg.contentReference.contentHash ? Array.from(msg.contentReference.contentHash) : undefined,
          };
        }
        return msg;
      });
    },

    /**
     * Delete a message
     */
    async deleteMessage(messageId) {
      const store = await getStore(STORES.MESSAGES, 'readwrite');
      return promisify(store.delete(messageId));
    },

    /**
     * Clear all messages for a conversation
     */
    async clearConversation(conversationId) {
      const store = await getStore(STORES.MESSAGES, 'readwrite');
      const index = store.index('conversationId');
      const messages = await promisify(index.getAll(conversationId));

      for (const msg of messages) {
        await promisify(store.delete(msg.messageId));
      }
    },

    /**
     * Clear all messages
     */
    async clearAll() {
      const store = await getStore(STORES.MESSAGES, 'readwrite');
      return promisify(store.clear());
    },

    /**
     * Delete all messages from a specific device (for revocation)
     * @param {string} authorDeviceId - The device's serverUserId
     * @returns {Promise<number>} Number of messages deleted
     */
    async deleteMessagesByAuthorDevice(authorDeviceId) {
      const messages = await this.getAllMessages();
      const toDelete = messages.filter(m => m.authorDeviceId === authorDeviceId);

      if (toDelete.length === 0) return 0;

      const store = await getStore(STORES.MESSAGES, 'readwrite');
      for (const msg of toDelete) {
        await promisify(store.delete(msg.messageId));
      }

      return toDelete.length;
    },

    /**
     * Migrate messages from one conversationId to another
     * Used when DEVICE_ANNOUNCE reveals that messages stored under a raw serverUserId
     * actually belong to a known friend's conversation.
     * @param {string} fromConversationId - Old conversation ID (typically a serverUserId)
     * @param {string} toConversationId - New conversation ID (friend's username)
     * @returns {Promise<number>} Number of messages migrated
     */
    async migrateMessages(fromConversationId, toConversationId) {
      if (fromConversationId === toConversationId) return 0;

      const messages = await this.getMessages(fromConversationId);
      if (messages.length === 0) return 0;

      const store = await getStore(STORES.MESSAGES, 'readwrite');
      for (const msg of messages) {
        // Update the conversationId and re-store
        msg.conversationId = toConversationId;
        await promisify(store.put(msg));
      }

      console.log(`[MessageStore] Migrated ${messages.length} messages from ${fromConversationId.slice(-8)} to ${toConversationId}`);
      return messages.length;
    },
  };
}

export default createMessageStore;
