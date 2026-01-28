/**
 * GSet - Grow-only Set CRDT
 *
 * Used for immutable content: stories, comments, messages, friend requests.
 *
 * Properties:
 * - Add-only (entries cannot be removed or modified)
 * - Merge = union of sets
 * - Idempotent (adding same ID twice is no-op)
 * - Convergent (all replicas converge to same state)
 *
 * This is the simplest CRDT - perfect for append-only data.
 */

export class GSet {
  /**
   * @param {ModelStore} store - Persistence layer
   * @param {string} modelName - e.g., 'story', 'comment'
   */
  constructor(store, modelName) {
    this.store = store;
    this.modelName = modelName;
    this.elements = new Map();  // id -> entry (in-memory cache)
    this._loaded = false;
  }

  /**
   * Load all entries from storage into memory
   * Called once on startup or first access
   */
  async load() {
    if (this._loaded) return;

    const entries = await this.store.getAll(this.modelName);
    for (const entry of entries) {
      this.elements.set(entry.id, entry);
    }
    this._loaded = true;
  }

  /**
   * Ensure loaded before any operation
   */
  async _ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  /**
   * Add an entry to the set
   * Idempotent - adding existing ID returns existing entry
   *
   * @param {object} entry - { id, data, timestamp, signature, authorDeviceId }
   * @returns {object} The stored entry
   */
  async add(entry) {
    await this._ensureLoaded();

    // Idempotent: if already have this ID, return existing
    if (this.elements.has(entry.id)) {
      return this.elements.get(entry.id);
    }

    // Persist to storage
    await this.store.put(this.modelName, entry);

    // Add to in-memory cache
    this.elements.set(entry.id, entry);

    return entry;
  }

  /**
   * Merge incoming entries from remote
   * GSet merge = union (add anything we don't have)
   *
   * @param {Array} entries - Remote entries to merge
   * @returns {Array} Entries that were actually added (new to us)
   */
  async merge(entries) {
    await this._ensureLoaded();

    const added = [];
    for (const entry of entries) {
      if (!this.elements.has(entry.id)) {
        await this.store.put(this.modelName, entry);
        this.elements.set(entry.id, entry);
        added.push(entry);
      }
    }
    return added;
  }

  /**
   * Get entry by ID
   * @param {string} id
   * @returns {object|null}
   */
  async get(id) {
    await this._ensureLoaded();
    return this.elements.get(id) || null;
  }

  /**
   * Check if entry exists
   * @param {string} id
   * @returns {boolean}
   */
  async has(id) {
    await this._ensureLoaded();
    return this.elements.has(id);
  }

  /**
   * Get all entries
   * @returns {Array}
   */
  async getAll() {
    await this._ensureLoaded();
    return Array.from(this.elements.values());
  }

  /**
   * Get count of entries
   * @returns {number}
   */
  async size() {
    await this._ensureLoaded();
    return this.elements.size;
  }

  /**
   * Filter entries by predicate
   * @param {Function} predicate - (entry) => boolean
   * @returns {Array}
   */
  async filter(predicate) {
    await this._ensureLoaded();
    return Array.from(this.elements.values()).filter(predicate);
  }

  /**
   * Get entries sorted by timestamp (newest first by default)
   * @param {string} order - 'desc' (newest first) or 'asc' (oldest first)
   * @returns {Array}
   */
  async getAllSorted(order = 'desc') {
    await this._ensureLoaded();
    const entries = Array.from(this.elements.values());
    return entries.sort((a, b) => {
      return order === 'desc'
        ? b.timestamp - a.timestamp
        : a.timestamp - b.timestamp;
    });
  }
}
