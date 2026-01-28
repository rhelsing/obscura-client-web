/**
 * QueryBuilder - Chainable query interface for models
 *
 * Usage:
 *   await model.where({ authorDeviceId: 'abc' }).orderBy('timestamp').limit(10).exec()
 *   await model.where({ status: 'active' }).include('comment').exec()
 *
 * Supports:
 * - where() - Filter by field values
 * - orderBy() - Sort results
 * - limit() - Limit result count
 * - include() - Load associations (TODO)
 * - exec() - Execute and return results
 * - first() - Execute and return first result
 */

export class QueryBuilder {
  /**
   * @param {Model} model - The model to query
   */
  constructor(model) {
    this.model = model;
    this._conditions = [];
    this._orderBy = null;
    this._orderDir = 'desc';
    this._limit = null;
    this._includes = [];
  }

  /**
   * Add filter conditions
   *
   * Supports:
   * - Simple equality: { field: value }
   * - Operators: { field: { gt: 5, lt: 10 } }
   * - Multiple conditions (AND): { field1: 'a', field2: 'b' }
   *
   * @param {object} conditions
   * @returns {QueryBuilder}
   */
  where(conditions) {
    this._conditions.push(conditions);
    return this;
  }

  /**
   * Sort results
   * @param {string} field - Field to sort by (e.g., 'timestamp', 'data.count')
   * @param {string} direction - 'desc' (default) or 'asc'
   * @returns {QueryBuilder}
   */
  orderBy(field, direction = 'desc') {
    this._orderBy = field;
    this._orderDir = direction;
    return this;
  }

  /**
   * Limit results
   * @param {number} count
   * @returns {QueryBuilder}
   */
  limit(count) {
    this._limit = count;
    return this;
  }

  /**
   * Include associations (eager loading)
   * @param {string|string[]} associations - Association names to include
   * @returns {QueryBuilder}
   */
  include(associations) {
    const assocs = Array.isArray(associations) ? associations : [associations];
    this._includes.push(...assocs);
    return this;
  }

  /**
   * Execute query and return all results
   * @returns {Promise<Array>}
   */
  async exec() {
    // Get all entries from CRDT
    let entries = await this.model.crdt.getAll();

    // Apply filters
    for (const conditions of this._conditions) {
      entries = entries.filter(entry => this._matchesConditions(entry, conditions));
    }

    // Sort
    if (this._orderBy) {
      entries = this._sortEntries(entries);
    }

    // Limit
    if (this._limit !== null) {
      entries = entries.slice(0, this._limit);
    }

    // Load associations (TODO: implement fully)
    if (this._includes.length > 0) {
      entries = await this._loadAssociations(entries);
    }

    return entries;
  }

  /**
   * Execute query and return first result
   * @returns {Promise<object|null>}
   */
  async first() {
    this._limit = 1;
    const results = await this.exec();
    return results[0] || null;
  }

  /**
   * Execute query and return count
   * @returns {Promise<number>}
   */
  async count() {
    const results = await this.exec();
    return results.length;
  }

  /**
   * Check if entry matches all conditions
   * @param {object} entry
   * @param {object} conditions
   * @returns {boolean}
   */
  _matchesConditions(entry, conditions) {
    for (const [field, condition] of Object.entries(conditions)) {
      const value = this._getFieldValue(entry, field);

      // Object condition with operators
      if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
        if (!this._matchesOperators(value, condition)) {
          return false;
        }
      }
      // Simple equality
      else if (value !== condition) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if value matches operator conditions
   * @param {*} value
   * @param {object} operators - { gt: 5, lt: 10, in: [...], contains: '...' }
   * @returns {boolean}
   */
  _matchesOperators(value, operators) {
    for (const [op, target] of Object.entries(operators)) {
      switch (op) {
        case 'eq':
          if (value !== target) return false;
          break;

        case 'ne':
        case 'neq':
          if (value === target) return false;
          break;

        case 'gt':
          if (!(value > target)) return false;
          break;

        case 'gte':
          if (!(value >= target)) return false;
          break;

        case 'lt':
          if (!(value < target)) return false;
          break;

        case 'lte':
          if (!(value <= target)) return false;
          break;

        case 'in':
          if (!Array.isArray(target) || !target.includes(value)) return false;
          break;

        case 'nin':
        case 'notIn':
          if (Array.isArray(target) && target.includes(value)) return false;
          break;

        case 'contains':
          if (typeof value !== 'string' || !value.includes(target)) return false;
          break;

        case 'startsWith':
          if (typeof value !== 'string' || !value.startsWith(target)) return false;
          break;

        case 'endsWith':
          if (typeof value !== 'string' || !value.endsWith(target)) return false;
          break;

        default:
          console.warn(`Unknown query operator: ${op}`);
      }
    }
    return true;
  }

  /**
   * Get nested field value from entry
   * Supports dot notation: 'data.content', 'data.author.name'
   *
   * @param {object} entry
   * @param {string} field
   * @returns {*}
   */
  _getFieldValue(entry, field) {
    const parts = field.split('.');
    let value = entry;

    for (const part of parts) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Sort entries by field
   * @param {Array} entries
   * @returns {Array}
   */
  _sortEntries(entries) {
    return [...entries].sort((a, b) => {
      const aVal = this._getFieldValue(a, this._orderBy);
      const bVal = this._getFieldValue(b, this._orderBy);

      // Handle null/undefined
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      // Compare
      let cmp;
      if (typeof aVal === 'string') {
        cmp = aVal.localeCompare(bVal);
      } else {
        cmp = aVal - bVal;
      }

      return this._orderDir === 'desc' ? -cmp : cmp;
    });
  }

  /**
   * Load associations for entries
   * Uses the ModelStore's association index to fetch children
   *
   * @param {Array} entries
   * @returns {Promise<Array>}
   */
  async _loadAssociations(entries) {
    const client = this.model.client;
    const store = this.model.syncManager?.store;

    if (!store) {
      console.warn('No store available for association loading');
      return entries;
    }

    for (const entry of entries) {
      for (const assocName of this._includes) {
        // Get child model from client (e.g., client.comment)
        const childModel = client[assocName];
        if (!childModel) {
          console.warn(`Unknown association model: ${assocName}`);
          continue;
        }

        // Query children via association index
        const children = await store.getChildren(this.model.name, entry.id, assocName);

        // Load full entries for each child
        const propName = assocName + 's';  // e.g., 'comments', 'reactions'
        entry[propName] = [];

        for (const child of children) {
          const childEntry = await childModel.find(child.childId);
          if (childEntry && !childEntry.data?._deleted) {
            entry[propName].push(childEntry);
          }
        }
      }
    }

    return entries;
  }
}
