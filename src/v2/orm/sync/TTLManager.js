/**
 * TTLManager - Handles ephemeral content expiration
 *
 * Responsibilities:
 * - Parse TTL strings ("24h", "7d", "30m")
 * - Schedule expiration timestamps
 * - Cleanup expired entries
 */

export class TTLManager {
  /**
   * @param {ModelStore} store
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * Parse TTL string to milliseconds
   *
   * Supported formats:
   * - "30s" - 30 seconds
   * - "30m" - 30 minutes
   * - "24h" - 24 hours
   * - "7d"  - 7 days
   *
   * @param {string} ttl
   * @returns {number} Milliseconds
   */
  parseTTL(ttl) {
    const match = ttl.match(/^(\d+)(s|m|h|d)$/);
    if (!match) {
      throw new Error(`Invalid TTL format: ${ttl}. Expected format like "24h", "7d", "30m", "30s"`);
    }

    const [, numStr, unit] = match;
    const num = parseInt(numStr, 10);

    const multipliers = {
      s: 1000,           // seconds
      m: 60 * 1000,      // minutes
      h: 60 * 60 * 1000, // hours
      d: 24 * 60 * 60 * 1000, // days
    };

    return num * multipliers[unit];
  }

  /**
   * Schedule an entry for expiration
   *
   * @param {string} modelName
   * @param {string} id
   * @param {string} ttl - TTL string like "24h"
   */
  async schedule(modelName, id, ttl) {
    const ms = this.parseTTL(ttl);
    const expiresAt = Date.now() + ms;
    await this.store.setTTL(modelName, id, expiresAt);
  }

  /**
   * Cleanup all expired entries
   *
   * @param {function} getModel - Function to get model by name: (name) => Model
   * @returns {number} Number of entries cleaned up
   */
  async cleanup(getModel) {
    const expired = await this.store.getExpired();
    let cleaned = 0;

    for (const { modelName, id } of expired) {
      try {
        const model = getModel(modelName);
        if (model) {
          // For LWW models, use delete (tombstone)
          // For G-Set models, we can't really delete, just remove from TTL tracking
          if (model.config.sync === 'lww') {
            await model.delete(id);
          }
          // Remove from local storage regardless
          await model.crdt.storage?.delete(modelName, id);
        }
        await this.store.removeTTL(modelName, id);
        cleaned++;
      } catch (e) {
        console.warn(`Failed to cleanup ${modelName}/${id}:`, e.message);
      }
    }

    return cleaned;
  }

  /**
   * Get time until an entry expires
   *
   * @param {string} modelName
   * @param {string} id
   * @returns {number|null} Milliseconds until expiration, or null if not tracked
   */
  async getTimeRemaining(modelName, id) {
    const expiresAt = await this.store.getTTL(modelName, id);
    if (!expiresAt) return null;
    return Math.max(0, expiresAt - Date.now());
  }

  /**
   * Check if an entry has expired
   *
   * @param {string} modelName
   * @param {string} id
   * @returns {boolean}
   */
  async isExpired(modelName, id) {
    const remaining = await this.getTimeRemaining(modelName, id);
    return remaining !== null && remaining === 0;
  }
}
