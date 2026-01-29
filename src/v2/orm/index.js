/**
 * ORM Layer - Entry Point
 *
 * Provides the schema() method that wires everything together.
 *
 * Usage with model classes (preferred):
 *   import { modelsToSchema } from './models/index.js';
 *   client.schema(modelsToSchema());
 *
 * Usage with inline schema (legacy):
 *   client.schema({
 *     story: { fields: { content: 'string' }, sync: 'g-set', collectable: true, ttl: '24h' },
 *     profile: { fields: { name: 'string' }, sync: 'lww', collectable: true },
 *   });
 *
 *   await client.story.create({ content: 'Hello!' });
 */

import { ModelStore } from './storage/ModelStore.js';
import { GSet } from './crdt/GSet.js';
import { LWWMap } from './crdt/LWWMap.js';
import { Model } from './Model.js';
import { SyncManager } from './sync/SyncManager.js';
import { TTLManager } from './sync/TTLManager.js';

// Re-export for direct imports
export { ModelStore } from './storage/ModelStore.js';
export { GSet } from './crdt/GSet.js';
export { LWWMap } from './crdt/LWWMap.js';
export { Model } from './Model.js';
export { QueryBuilder } from './QueryBuilder.js';
export { SyncManager } from './sync/SyncManager.js';
export { TTLManager } from './sync/TTLManager.js';

/**
 * SchemaBuilder - Builds models from schema definitions
 */
export class SchemaBuilder {
  /**
   * @param {ObscuraClient} client
   */
  constructor(client) {
    this.client = client;
    this.models = new Map();
    this.store = null;
    this.syncManager = null;
    this.ttlManager = null;
    this._initialized = false;
  }

  /**
   * Initialize storage, sync manager, and TTL manager
   */
  async _init() {
    if (this._initialized) return;

    // Create storage namespaced to user
    this.store = new ModelStore(this.client.userId || 'anonymous');
    await this.store.open();

    // Create sync manager with store reference for associations
    this.syncManager = new SyncManager(this.client, this.store);

    // Create TTL manager for ephemeral content expiration
    this.ttlManager = new TTLManager(this.store);

    this._initialized = true;
  }

  /**
   * Define models from schema
   *
   * @param {object} definitions - { modelName: config, ... }
   * @returns {SchemaBuilder}
   */
  async define(definitions) {
    await this._init();

    for (const [name, config] of Object.entries(definitions)) {
      // Validate config
      this._validateConfig(name, config);

      // Create CRDT based on sync type
      const crdt = this._createCRDT(name, config);

      // Build model
      const model = new Model({
        name,
        config,
        crdt,
        client: this.client,
        syncManager: this.syncManager,
        ttlManager: this.ttlManager,
      });

      // Register with sync manager
      this.syncManager.register(name, model);

      // Store reference
      this.models.set(name, model);

      // Attach to client: client.story, client.streak, etc.
      this.client[name] = model;
    }

    // Store models map on client for routing
    this.client._ormModels = this.models;
    this.client._ormSyncManager = this.syncManager;

    return this;
  }

  /**
   * Validate model config
   * @param {string} name
   * @param {object} config
   */
  _validateConfig(name, config) {
    // Must have fields
    if (!config.fields || typeof config.fields !== 'object') {
      throw new Error(`Model "${name}": fields object is required`);
    }

    // Must have sync type
    if (!config.sync) {
      throw new Error(`Model "${name}": sync type is required (g-set, lww)`);
    }

    if (!['g-set', 'lww', 'counter'].includes(config.sync)) {
      throw new Error(`Model "${name}": sync must be 'g-set', 'lww', or 'counter'`);
    }

    // collectable is required (true = user can pin, false = cannot pin)
    if (typeof config.collectable !== 'boolean') {
      // Backwards compat: accept ephemeral as alias for collectable: true
      if (config.ephemeral) {
        config.collectable = true;
      } else {
        throw new Error(`Model "${name}": collectable: true/false is required`);
      }
    }

    // Validate field types
    const validTypes = ['string', 'string?', 'number', 'number?', 'boolean', 'boolean?', 'timestamp', 'timestamp?', 'bytes', 'bytes?'];
    for (const [field, type] of Object.entries(config.fields)) {
      if (!validTypes.includes(type)) {
        throw new Error(`Model "${name}": field "${field}" has invalid type "${type}"`);
      }
    }
  }

  /**
   * Create CRDT instance based on sync type
   * @param {string} name
   * @param {object} config
   * @returns {GSet|LWWMap}
   */
  _createCRDT(name, config) {
    switch (config.sync) {
      case 'g-set':
        return new GSet(this.store, name);

      case 'lww':
        return new LWWMap(this.store, name);

      case 'counter':
        // Counter uses LWWMap internally with special merge logic
        // TODO: Implement proper PN-Counter
        return new LWWMap(this.store, name);

      default:
        throw new Error(`Unknown sync type: ${config.sync}`);
    }
  }

  /**
   * Get a registered model
   * @param {string} name
   * @returns {Model|null}
   */
  get(name) {
    return this.models.get(name) || null;
  }
}

/**
 * Create schema builder for a client
 * This is the main entry point called by ObscuraClient.schema()
 *
 * @param {ObscuraClient} client
 * @param {object} definitions
 * @returns {Promise<SchemaBuilder>}
 */
export async function createSchema(client, definitions) {
  const builder = new SchemaBuilder(client);
  await builder.define(definitions);
  return builder;
}
