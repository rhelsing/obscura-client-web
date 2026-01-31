/**
 * Model - Generic base class for all ORM models
 *
 * This is the core of the ORM. It provides:
 * - create() - Validate, generate ID, sign, persist, broadcast
 * - find() - Get by ID
 * - where() - Query with conditions
 * - upsert() - Create or update (for LWW models)
 *
 * The same Model class works for ANY model name.
 * "story", "streak", "settings" - all use this same code.
 */

import { QueryBuilder } from './QueryBuilder.js';

/**
 * Generate a random ID suffix
 * @param {number} length
 * @returns {string}
 */
function randomId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export class Model {
  /**
   * @param {object} opts
   * @param {string} opts.name - Model name (e.g., 'story', 'streak')
   * @param {object} opts.config - Schema config { fields, sync, ephemeral|collectable, ... }
   * @param {GSet|LWWMap} opts.crdt - CRDT instance for this model
   * @param {ObscuraClient} opts.client - Parent client
   * @param {SyncManager} opts.syncManager - Handles broadcast
   * @param {TTLManager} [opts.ttlManager] - Handles ephemeral expiration
   */
  constructor({ name, config, crdt, client, syncManager, ttlManager }) {
    this.name = name;
    this.config = config;
    this.crdt = crdt;
    this.client = client;
    this.syncManager = syncManager;
    this.ttlManager = ttlManager;
  }

  /**
   * Create a new entry
   *
   * Handles automatically:
   * - Field validation
   * - ID generation: ${name}_${timestamp}_${random}
   * - Timestamp
   * - Signing
   * - Local persistence (CRDT add)
   * - Broadcast (fan-out to friends + self-sync)
   * - TTL scheduling (if ephemeral)
   *
   * @param {object} data - Field values, e.g., { content: 'Hello!' }
   * @returns {object} The created entry
   */
  async create(data) {
    // 1. Validate fields against schema
    this._validate(data);

    // 2. Generate unique ID
    const id = `${this.name}_${Date.now()}_${randomId()}`;

    // 3. Build entry
    const entry = {
      id,
      data,
      timestamp: Date.now(),
      authorDeviceId: this.client.deviceUUID,
      signature: new Uint8Array(0),  // Will be filled by signing
    };

    // 4. Sign the entry
    entry.signature = await this._sign(entry);

    // 5. Persist locally via CRDT
    await this.crdt.add(entry);

    // 6. Track associations (belongs_to relationships)
    if (this.config.belongs_to) {
      const belongsToList = Array.isArray(this.config.belongs_to)
        ? this.config.belongs_to
        : [this.config.belongs_to];

      for (const parentModel of belongsToList) {
        const foreignKey = `${parentModel}Id`;
        const parentId = data[foreignKey];
        if (parentId && this.syncManager.store) {
          await this.syncManager.store.addAssociation(parentModel, parentId, this.name, id);
        }
      }
    }

    // 7. Broadcast to friends + self-sync
    await this.syncManager.broadcast(this, entry);

    // 8. Schedule TTL if model has TTL defined
    if (this.config.ttl && this.ttlManager) {
      await this.ttlManager.schedule(this.name, id, this.config.ttl);
    }

    return entry;
  }

  /**
   * Upsert (create or update) - for LWW models
   *
   * If ID exists and this timestamp is newer, updates.
   * If ID doesn't exist, creates.
   *
   * @param {string} id - Entry ID
   * @param {object} data - New field values
   * @returns {object} The resulting entry
   */
  async upsert(id, data) {
    // Validate
    this._validate(data);

    // Build entry with provided ID
    const entry = {
      id,
      data,
      timestamp: Date.now(),
      authorDeviceId: this.client.deviceUUID,
      signature: new Uint8Array(0),
    };

    // Sign
    entry.signature = await this._sign(entry);

    // Set via CRDT (LWW will handle conflict resolution)
    const result = await this.crdt.set(entry);

    // Only broadcast if we actually updated (our entry won)
    if (result === entry) {
      await this.syncManager.broadcast(this, entry);
    }

    return result;
  }

  /**
   * Find entry by ID
   * @param {string} id
   * @returns {object|null}
   */
  async find(id) {
    return this.crdt.get(id);
  }

  /**
   * Start a query with conditions
   * @param {object} conditions - e.g., { authorDeviceId: 'abc' }
   * @returns {QueryBuilder}
   */
  where(conditions) {
    return new QueryBuilder(this).where(conditions);
  }

  /**
   * Get all entries
   * @returns {Array}
   */
  async all() {
    return this.crdt.getAll();
  }

  /**
   * Get all entries sorted by timestamp
   * @param {string} order - 'desc' or 'asc'
   * @returns {Array}
   */
  async allSorted(order = 'desc') {
    return this.crdt.getAllSorted(order);
  }

  /**
   * Batch load this model's entries into parent entries
   *
   * @param {Array} parents - Parent entries to load into
   * @param {string} foreignKey - Field name linking to parent (e.g., 'storyId')
   * @param {string} [propName] - Property name on parent (defaults to model name + 's')
   */
  async loadInto(parents, foreignKey, propName = null) {
    if (!parents || parents.length === 0) return;

    // Collect all parent IDs
    const parentIds = parents.map(p => p.id);

    // Single query: get all children where foreignKey in parentIds
    const children = await this.where({
      [`data.${foreignKey}`]: { in: parentIds }
    }).exec();

    // Group by parent
    const byParent = new Map();
    for (const child of children) {
      const pid = child.data[foreignKey];
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(child);
    }

    // Attach to parents
    const prop = propName || this.name + 's';
    for (const parent of parents) {
      parent[prop] = byParent.get(parent.id) || [];
    }
  }

  /**
   * Delete an entry (LWW models only)
   * Uses tombstone pattern - marks as deleted with newer timestamp
   *
   * @param {string} id - Entry ID to delete
   */
  async delete(id) {
    if (this.config.sync !== 'lww') {
      throw new Error('Delete only supported for LWW models');
    }

    const timestamp = Date.now();

    // Create tombstone entry
    const tombstone = {
      id,
      data: { _deleted: true },
      timestamp,
      authorDeviceId: this.client.deviceUUID,
      signature: new Uint8Array(0),
    };

    // Sign the tombstone
    tombstone.signature = await this._sign(tombstone);

    // Delete via CRDT (uses tombstone internally)
    await this.crdt.delete(id, this.client.deviceUUID);

    // Broadcast deletion to friends + self
    await this.syncManager.broadcast(this, tombstone);
  }

  /**
   * Handle incoming MODEL_SYNC message
   * Called by SyncManager when we receive a remote entry
   *
   * @param {object} modelSync - The decoded ModelSync message
   * @returns {object|null} The merged entry (null if rejected)
   */
  async handleSync(modelSync) {
    // Decode the entry from modelSync
    const entry = {
      id: modelSync.id,
      data: this._decodeData(modelSync.data),
      timestamp: modelSync.timestamp,
      authorDeviceId: modelSync.authorDeviceId,
      signature: modelSync.signature,
    };

    // TODO: Verify signature against authorDeviceId's known key

    // Merge into local CRDT
    const merged = await this.crdt.merge([entry]);

    // If merged successfully, track associations
    if (merged.length > 0 && this.config.belongs_to && this.syncManager.store) {
      const belongsToList = Array.isArray(this.config.belongs_to)
        ? this.config.belongs_to
        : [this.config.belongs_to];

      for (const parentModel of belongsToList) {
        const foreignKey = `${parentModel}Id`;
        const parentId = entry.data[foreignKey];
        if (parentId) {
          await this.syncManager.store.addAssociation(parentModel, parentId, this.name, entry.id);
        }
      }
    }

    // Return the entry if it was new/updated
    return merged.length > 0 ? merged[0] : null;
  }

  /**
   * Validate data against schema fields
   * @param {object} data
   * @throws {Error} If validation fails
   */
  _validate(data) {
    if (!this.config.fields) return;

    for (const [field, type] of Object.entries(this.config.fields)) {
      const isOptional = type.endsWith('?');
      const baseType = type.replace('?', '');
      const value = data[field];

      // Check required fields
      if (value === undefined || value === null) {
        if (!isOptional) {
          throw new Error(`Validation failed: ${field} is required`);
        }
        continue;
      }

      // Type checking
      switch (baseType) {
        case 'string':
          if (typeof value !== 'string') {
            throw new Error(`Validation failed: ${field} must be string, got ${typeof value}`);
          }
          break;

        case 'number':
          if (typeof value !== 'number' || isNaN(value)) {
            throw new Error(`Validation failed: ${field} must be number, got ${typeof value}`);
          }
          break;

        case 'boolean':
          if (typeof value !== 'boolean') {
            throw new Error(`Validation failed: ${field} must be boolean, got ${typeof value}`);
          }
          break;

        case 'timestamp':
          if (typeof value !== 'number' || value < 0) {
            throw new Error(`Validation failed: ${field} must be positive timestamp`);
          }
          break;

        case 'bytes':
          if (!(value instanceof Uint8Array)) {
            throw new Error(`Validation failed: ${field} must be Uint8Array`);
          }
          break;
      }
    }

    // Check for unknown fields (optional strictness)
    // For now, allow extra fields for flexibility
  }

  /**
   * Sign an entry
   * Uses the device's identity key to prove authorship
   *
   * @param {object} entry
   * @returns {Uint8Array} Signature bytes
   */
  async _sign(entry) {
    // Create deterministic data to sign
    const dataToSign = JSON.stringify({
      model: this.name,
      id: entry.id,
      data: entry.data,
      timestamp: entry.timestamp,
      authorDeviceId: entry.authorDeviceId,
    });

    // TODO: Implement actual signing with device identity key
    // For now, return a placeholder that indicates signing happened
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(dataToSign));
    return new Uint8Array(hash);
  }

  /**
   * Decode data from ModelSync bytes
   * @param {Uint8Array|string} data
   * @returns {object}
   */
  _decodeData(data) {
    if (data instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(data));
    }
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    return data;
  }

  /**
   * Get targeting association for sync
   * Returns the first belongs_to that should determine recipients
   *
   * @returns {object|null} { model, foreignKey }
   */
  getTargetingAssociation() {
    if (!this.config.belongs_to) return null;

    // belongs_to can be string or array
    const belongsTo = Array.isArray(this.config.belongs_to)
      ? this.config.belongs_to[0]
      : this.config.belongs_to;

    // Convention: foreignKey is ${model}Id
    return {
      model: belongsTo,
      foreignKey: `${belongsTo}Id`,
    };
  }
}
