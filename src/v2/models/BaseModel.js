/**
 * BaseModel - Base class for all ORM models
 *
 * Subclasses override static properties and hooks.
 */

export class BaseModel {
  // Schema
  static fields = {};
  static sync = 'lww';           // 'lww' | 'g-set'
  static collectable = true;     // Can user pin/save this?

  // TTL
  static ttl = null;             // Model default TTL (e.g., '24h'), or null to inherit user setting
  static ttlTrigger = 'create';  // 'create' | 'read' | 'custom'

  // Relationships
  static has_many = null;
  static belongs_to = null;

  // Privacy
  static private = false;        // Only sync to own devices

  /**
   * Get TTL for an entry (override for dynamic TTL)
   * @param {object} entry - The entry being created/read
   * @returns {number|string|null} TTL in ms, or string like '24h', or null
   */
  static getTTL(entry) {
    return this.ttl;
  }

  /**
   * Called when TTL should start (override for custom behavior)
   * @param {object} entry - The entry
   * @returns {number} Timestamp when TTL started
   */
  static onTTLStart(entry) {
    return Date.now();
  }

  /**
   * Convert model class to schema config object
   * Used by ORM for backwards compatibility
   */
  static toConfig() {
    const config = {
      fields: this.fields,
      sync: this.sync,
      collectable: this.collectable,
    };

    if (this.ttl) config.ttl = this.ttl;
    if (this.ttlTrigger !== 'create') config.ttlTrigger = this.ttlTrigger;
    if (this.has_many) config.has_many = this.has_many;
    if (this.belongs_to) config.belongs_to = this.belongs_to;
    if (this.private) config.private = this.private;

    return config;
  }
}
