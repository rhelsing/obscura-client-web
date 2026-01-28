/**
 * LWWMap - Last-Writer-Wins Map CRDT
 *
 * Used for mutable state: streaks, settings, profiles, reactions.
 *
 * Properties:
 * - Each key has a value + timestamp
 * - On conflict, highest timestamp wins
 * - Updates overwrite (not append)
 * - Convergent (all replicas converge to same state)
 *
 * Perfect for data that changes: counters, settings, status fields.
 */

export class LWWMap {
  /**
   * @param {ModelStore} store - Persistence layer
   * @param {string} modelName - e.g., 'streak', 'settings'
   */
  constructor(store, modelName) {
    this.store = store;
    this.modelName = modelName;
    this.entries = new Map();  // id -> { data, timestamp, signature, authorDeviceId }
    this._loaded = false;
  }

  /**
   * Load all entries from storage into memory
   */
  async load() {
    if (this._loaded) return;

    const entries = await this.store.getAll(this.modelName);
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
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
   * Set/update an entry
   * Only updates if timestamp is newer than existing
   *
   * @param {object} entry - { id, data, timestamp, signature, authorDeviceId }
   * @returns {object} The winning entry (might be existing if it was newer)
   */
  async set(entry) {
    await this._ensureLoaded();

    const existing = this.entries.get(entry.id);

    // LWW: only update if newer timestamp
    if (!existing || entry.timestamp > existing.timestamp) {
      await this.store.put(this.modelName, entry);
      this.entries.set(entry.id, entry);
      return entry;
    }

    // Existing is newer, keep it
    return existing;
  }

  /**
   * Add entry (alias for set, for consistent interface with GSet)
   */
  async add(entry) {
    return this.set(entry);
  }

  /**
   * Merge incoming entries from remote
   * LWW merge = take newer timestamp for each key
   *
   * @param {Array} entries - Remote entries to merge
   * @returns {Array} Entries that actually updated local state
   */
  async merge(entries) {
    await this._ensureLoaded();

    const updated = [];
    for (const entry of entries) {
      const existing = this.entries.get(entry.id);

      if (!existing || entry.timestamp > existing.timestamp) {
        await this.store.put(this.modelName, entry);
        this.entries.set(entry.id, entry);
        updated.push(entry);
      }
    }
    return updated;
  }

  /**
   * Get entry by ID
   * @param {string} id
   * @returns {object|null}
   */
  async get(id) {
    await this._ensureLoaded();
    return this.entries.get(id) || null;
  }

  /**
   * Check if entry exists
   * @param {string} id
   * @returns {boolean}
   */
  async has(id) {
    await this._ensureLoaded();
    return this.entries.has(id);
  }

  /**
   * Get all entries
   * @returns {Array}
   */
  async getAll() {
    await this._ensureLoaded();
    return Array.from(this.entries.values());
  }

  /**
   * Get count of entries
   * @returns {number}
   */
  async size() {
    await this._ensureLoaded();
    return this.entries.size;
  }

  /**
   * Delete entry (for LWW, we use a tombstone pattern)
   * Creates a "deleted" entry with current timestamp
   *
   * @param {string} id
   * @param {string} authorDeviceId
   * @returns {object} The tombstone entry
   */
  async delete(id, authorDeviceId) {
    await this._ensureLoaded();

    const tombstone = {
      id,
      data: { _deleted: true },
      timestamp: Date.now(),
      signature: new Uint8Array(0),
      authorDeviceId,
    };

    await this.store.put(this.modelName, tombstone);
    this.entries.set(id, tombstone);

    return tombstone;
  }

  /**
   * Filter entries by predicate (excludes tombstones by default)
   * @param {Function} predicate - (entry) => boolean
   * @param {boolean} includeTombstones - Include deleted entries
   * @returns {Array}
   */
  async filter(predicate, includeTombstones = false) {
    await this._ensureLoaded();

    let entries = Array.from(this.entries.values());

    if (!includeTombstones) {
      entries = entries.filter(e => !e.data?._deleted);
    }

    return entries.filter(predicate);
  }

  /**
   * Get all non-deleted entries sorted by timestamp
   * @param {string} order - 'desc' (newest first) or 'asc' (oldest first)
   * @returns {Array}
   */
  async getAllSorted(order = 'desc') {
    await this._ensureLoaded();

    const entries = Array.from(this.entries.values())
      .filter(e => !e.data?._deleted);

    return entries.sort((a, b) => {
      return order === 'desc'
        ? b.timestamp - a.timestamp
        : a.timestamp - b.timestamp;
    });
  }
}
