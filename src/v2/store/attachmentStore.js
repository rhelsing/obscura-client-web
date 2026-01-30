/**
 * Attachment Store (IndexedDB)
 * Caches decrypted attachments locally to avoid re-downloading
 */

const DB_NAME_PREFIX = 'obscura_attachments';
const DB_VERSION = 1;

const STORES = {
  ATTACHMENTS: 'attachments',
};

/**
 * Create an attachment store instance
 * @param {string} userId - User ID (for database namespace)
 * @returns {object} Attachment store instance
 */
export function createAttachmentStore(userId) {
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

        if (!database.objectStoreNames.contains(STORES.ATTACHMENTS)) {
          database.createObjectStore(STORES.ATTACHMENTS, { keyPath: 'attachmentId' });
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
     * Get cached attachment by ID
     * @param {string} attachmentId
     * @returns {Promise<ArrayBuffer|null>} Decrypted content or null if not cached
     */
    async get(attachmentId) {
      try {
        const store = await getStore(STORES.ATTACHMENTS);
        const record = await promisify(store.get(attachmentId));
        return record?.blob || null;
      } catch (e) {
        console.warn('[AttachmentStore] Get failed:', e.message);
        return null;
      }
    },

    /**
     * Cache an attachment
     * @param {string} attachmentId
     * @param {ArrayBuffer} blob - Decrypted content
     * @param {object} metadata - { contentType, sizeBytes }
     */
    async put(attachmentId, blob, metadata = {}) {
      try {
        const store = await getStore(STORES.ATTACHMENTS, 'readwrite');
        await promisify(store.put({
          attachmentId,
          blob,
          contentType: metadata.contentType || '',
          sizeBytes: metadata.sizeBytes || blob.byteLength,
          cachedAt: Date.now(),
        }));
      } catch (e) {
        console.warn('[AttachmentStore] Put failed:', e.message);
      }
    },

    /**
     * Check if attachment is cached
     * @param {string} attachmentId
     * @returns {Promise<boolean>}
     */
    async has(attachmentId) {
      const cached = await this.get(attachmentId);
      return cached !== null;
    },

    /**
     * Delete a cached attachment
     * @param {string} attachmentId
     */
    async delete(attachmentId) {
      try {
        const store = await getStore(STORES.ATTACHMENTS, 'readwrite');
        await promisify(store.delete(attachmentId));
      } catch (e) {
        console.warn('[AttachmentStore] Delete failed:', e.message);
      }
    },

    /**
     * Clear all cached attachments
     */
    async clearAll() {
      try {
        const store = await getStore(STORES.ATTACHMENTS, 'readwrite');
        await promisify(store.clear());
      } catch (e) {
        console.warn('[AttachmentStore] Clear failed:', e.message);
      }
    },
  };
}

export default createAttachmentStore;
