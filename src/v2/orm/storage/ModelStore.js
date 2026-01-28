/**
 * ModelStore - IndexedDB storage for ORM models
 *
 * Generic storage layer that persists model entries, associations, and TTL tracking.
 * Works with any model name - the ORM machinery uses this for all models.
 */

const DB_VERSION = 1;

export class ModelStore {
  constructor(namespace = 'default') {
    this.dbName = `obscura_models_${namespace}`;
    this.db = null;
  }

  /**
   * Open the database and create stores if needed
   */
  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Models store: holds all model entries
        // Key: [modelName, id] - allows querying by model type
        if (!db.objectStoreNames.contains('models')) {
          const store = db.createObjectStore('models', { keyPath: ['modelName', 'id'] });
          store.createIndex('byModel', 'modelName');
          store.createIndex('byTimestamp', ['modelName', 'timestamp']);
          store.createIndex('byAuthor', ['modelName', 'authorDeviceId']);
        }

        // Associations store: parent -> child relationships
        // Key: [parentType, parentId, childType, childId]
        if (!db.objectStoreNames.contains('associations')) {
          const store = db.createObjectStore('associations', {
            keyPath: ['parentType', 'parentId', 'childType', 'childId']
          });
          store.createIndex('byParent', ['parentType', 'parentId']);
          store.createIndex('byChild', ['childType', 'childId']);
        }

        // TTL store: tracks expiration for ephemeral models
        // Key: [modelName, id]
        if (!db.objectStoreNames.contains('ttl')) {
          const store = db.createObjectStore('ttl', { keyPath: ['modelName', 'id'] });
          store.createIndex('byExpiry', 'expiresAt');
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
    });
  }

  /**
   * Get a transaction and store
   */
  async _getStore(storeName, mode = 'readonly') {
    const db = await this.open();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  /**
   * Promisify an IDB request
   */
  _promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ===========================================================================
  // Model Operations
  // ===========================================================================

  /**
   * Store a model entry
   * @param {string} modelName - e.g., 'story', 'streak', 'settings'
   * @param {object} entry - { id, data, timestamp, signature, authorDeviceId }
   */
  async put(modelName, entry) {
    const store = await this._getStore('models', 'readwrite');
    await this._promisify(store.put({
      modelName,
      id: entry.id,
      data: entry.data,
      timestamp: entry.timestamp,
      signature: entry.signature,
      authorDeviceId: entry.authorDeviceId,
    }));
  }

  /**
   * Get a single entry
   * @param {string} modelName
   * @param {string} id
   * @returns {object|null}
   */
  async get(modelName, id) {
    const store = await this._getStore('models');
    const result = await this._promisify(store.get([modelName, id]));
    return result || null;
  }

  /**
   * Get all entries for a model
   * @param {string} modelName
   * @returns {Array}
   */
  async getAll(modelName) {
    const store = await this._getStore('models');
    const index = store.index('byModel');
    return this._promisify(index.getAll(modelName));
  }

  /**
   * Delete an entry
   * @param {string} modelName
   * @param {string} id
   */
  async delete(modelName, id) {
    const store = await this._getStore('models', 'readwrite');
    await this._promisify(store.delete([modelName, id]));
  }

  /**
   * Check if entry exists
   * @param {string} modelName
   * @param {string} id
   * @returns {boolean}
   */
  async has(modelName, id) {
    const entry = await this.get(modelName, id);
    return entry !== null;
  }

  // ===========================================================================
  // Association Operations
  // ===========================================================================

  /**
   * Add an association (parent -> child)
   * @param {string} parentType - e.g., 'story'
   * @param {string} parentId - e.g., 'story_123'
   * @param {string} childType - e.g., 'comment'
   * @param {string} childId - e.g., 'comment_456'
   */
  async addAssociation(parentType, parentId, childType, childId) {
    const store = await this._getStore('associations', 'readwrite');
    await this._promisify(store.put({
      parentType,
      parentId,
      childType,
      childId,
    }));
  }

  /**
   * Get all children of a parent
   * @param {string} parentType
   * @param {string} parentId
   * @param {string} [childType] - Optional filter by child type
   * @returns {Array<{childType, childId}>}
   */
  async getChildren(parentType, parentId, childType = null) {
    const store = await this._getStore('associations');
    const index = store.index('byParent');
    const results = await this._promisify(index.getAll([parentType, parentId]));

    if (childType) {
      return results.filter(r => r.childType === childType);
    }
    return results;
  }

  /**
   * Get parent of a child
   * @param {string} childType
   * @param {string} childId
   * @returns {object|null} - { parentType, parentId }
   */
  async getParent(childType, childId) {
    const store = await this._getStore('associations');
    const index = store.index('byChild');
    const results = await this._promisify(index.getAll([childType, childId]));
    return results[0] || null;
  }

  /**
   * Remove an association
   */
  async removeAssociation(parentType, parentId, childType, childId) {
    const store = await this._getStore('associations', 'readwrite');
    await this._promisify(store.delete([parentType, parentId, childType, childId]));
  }

  // ===========================================================================
  // TTL Operations
  // ===========================================================================

  /**
   * Set TTL for an entry
   * @param {string} modelName
   * @param {string} id
   * @param {number} expiresAt - Timestamp when entry expires
   */
  async setTTL(modelName, id, expiresAt) {
    const store = await this._getStore('ttl', 'readwrite');
    await this._promisify(store.put({
      modelName,
      id,
      expiresAt,
    }));
  }

  /**
   * Get TTL for an entry
   * @param {string} modelName
   * @param {string} id
   * @returns {number|null} - Expiration timestamp or null
   */
  async getTTL(modelName, id) {
    const store = await this._getStore('ttl');
    const result = await this._promisify(store.get([modelName, id]));
    return result?.expiresAt || null;
  }

  /**
   * Remove TTL tracking for an entry
   */
  async removeTTL(modelName, id) {
    const store = await this._getStore('ttl', 'readwrite');
    await this._promisify(store.delete([modelName, id]));
  }

  /**
   * Get all expired entries
   * @returns {Array<{modelName, id, expiresAt}>}
   */
  async getExpired() {
    const store = await this._getStore('ttl');
    const index = store.index('byExpiry');
    const now = Date.now();
    const range = IDBKeyRange.upperBound(now);
    return this._promisify(index.getAll(range));
  }

  /**
   * Get all TTL entries (for restoring timers on startup)
   * @returns {Array<{modelName, id, expiresAt}>}
   */
  async getAllTTL() {
    const store = await this._getStore('ttl');
    return this._promisify(store.getAll());
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /**
   * Clear all data for a model
   * @param {string} modelName
   */
  async clearModel(modelName) {
    const entries = await this.getAll(modelName);
    const store = await this._getStore('models', 'readwrite');
    for (const entry of entries) {
      await this._promisify(store.delete([modelName, entry.id]));
    }
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
