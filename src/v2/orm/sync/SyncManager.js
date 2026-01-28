/**
 * SyncManager - Handles broadcasting model operations
 *
 * Responsibilities:
 * - Fan-out MODEL_SYNC to all friend devices
 * - Self-sync to own devices
 * - Association-based targeting (group messages go to group members)
 * - Handle incoming MODEL_SYNC and route to correct model
 *
 * Uses existing Level 2 infrastructure:
 * - messenger.sendMessage() for transport
 * - friends.getFanOutTargets() for friend devices
 * - devices.getSelfSyncTargets() for own devices
 */

export class SyncManager {
  /**
   * @param {ObscuraClient} client
   * @param {ModelStore} [store] - Optional store for association tracking
   */
  constructor(client, store = null) {
    this.client = client;
    this.store = store;
    this.models = new Map();  // model name -> Model instance
  }

  /**
   * Register a model with the sync manager
   * @param {string} name
   * @param {Model} model
   */
  register(name, model) {
    this.models.set(name, model);
  }

  /**
   * Broadcast a model entry to all relevant recipients
   *
   * @param {Model} model - The model instance
   * @param {object} entry - { id, data, timestamp, signature, authorDeviceId }
   */
  async broadcast(model, entry) {
    const targets = await this._getTargets(model, entry);

    if (targets.length === 0) {
      return { sent: 0, failed: 0 };
    }

    // Build MODEL_SYNC message
    const modelSync = {
      model: model.name,
      id: entry.id,
      op: 0,  // CREATE (TODO: support UPDATE/DELETE)
      timestamp: entry.timestamp,
      data: this._encodeData(entry.data),
      signature: entry.signature,
      authorDeviceId: entry.authorDeviceId,
    };

    // Send to all targets
    let sent = 0;
    let failed = 0;

    for (const targetUserId of targets) {
      try {
        await this.client.messenger.sendMessage(targetUserId, {
          type: 'MODEL_SYNC',
          modelSync,
        });
        sent++;
      } catch (e) {
        console.warn(`Failed to sync to ${targetUserId}:`, e.message);
        failed++;
      }
    }

    return { sent, failed };
  }

  /**
   * Get all target device IDs for a model entry
   *
   * Targeting rules:
   * 1. Always self-sync to own devices
   * 2. If model.config.private = true, ONLY own devices
   * 3. If model has targeting association (belongs_to group), sync to group members
   * 4. Otherwise, broadcast to all friends
   *
   * @param {Model} model
   * @param {object} entry
   * @returns {Promise<Array<string>>} Device IDs
   */
  async _getTargets(model, entry) {
    const targets = new Set();

    // 1. Always self-sync to own devices
    const selfTargets = this.client.devices.getSelfSyncTargets();
    for (const t of selfTargets) {
      targets.add(t);
    }

    // 2. Private models = only own devices
    if (model.config.private) {
      return Array.from(targets);
    }

    // 3. Check for targeting association
    const targetingAssoc = model.getTargetingAssociation();
    if (targetingAssoc && this._isTargetingModel(targetingAssoc.model)) {
      // Look up parent to get members
      const parentId = entry.data[targetingAssoc.foreignKey];
      if (parentId) {
        const members = await this._getAssociationMembers(targetingAssoc.model, parentId);
        for (const username of members) {
          const friendTargets = this._getFriendTargets(username);
          for (const t of friendTargets) {
            targets.add(t);
          }
        }
        return Array.from(targets);
      }
    }

    // 4. Default: broadcast to all friends
    const allFriends = this.client.friends.getAll();
    for (const friend of allFriends) {
      for (const device of friend.devices) {
        targets.add(device.serverUserId);
      }
    }

    return Array.from(targets);
  }

  /**
   * Check if a model type should be used for targeting
   * (e.g., 'group', 'conversation' - models with members)
   */
  _isTargetingModel(modelName) {
    // Models that contain member lists
    return ['group', 'conversation', 'chat'].includes(modelName);
  }

  /**
   * Get members from a targeting model (group, conversation)
   * @param {string} modelName
   * @param {string} parentId
   * @returns {Promise<Array<string>>} Member usernames
   */
  async _getAssociationMembers(modelName, parentId) {
    const model = this.models.get(modelName);
    if (!model) return [];

    // Look up the parent entry (e.g., the group)
    const parent = await model.find(parentId);
    if (!parent) return [];

    // Convention: members stored as JSON array in data.members or data.participants
    // e.g., group.data.members = '["alice", "bob", "carol"]'
    const membersRaw = parent.data.members || parent.data.participants;
    if (!membersRaw) return [];

    // Parse if string (JSON), otherwise use as-is (array)
    try {
      return typeof membersRaw === 'string' ? JSON.parse(membersRaw) : membersRaw;
    } catch (e) {
      console.warn(`Failed to parse members for ${modelName}/${parentId}:`, e.message);
      return [];
    }
  }

  /**
   * Get device IDs for a friend
   * @param {string} username
   * @returns {Array<string>}
   */
  _getFriendTargets(username) {
    try {
      return this.client.friends.getFanOutTargets(username);
    } catch (e) {
      // Friend not found or not accepted
      return [];
    }
  }

  /**
   * Handle incoming MODEL_SYNC message
   * Routes to the correct model and merges into local CRDT
   *
   * @param {object} modelSync - The decoded ModelSync from the message
   * @param {string} sourceUserId - Who sent it
   * @returns {object|null} The merged entry (null if rejected/unknown model)
   */
  async handleIncoming(modelSync, sourceUserId) {
    const model = this.models.get(modelSync.model);

    if (!model) {
      console.warn(`Unknown model in MODEL_SYNC: ${modelSync.model}`);
      return null;
    }

    // Let the model handle the sync (validates, merges)
    return model.handleSync(modelSync);
  }

  /**
   * Encode data for transport
   * @param {object} data
   * @returns {Uint8Array}
   */
  _encodeData(data) {
    return new TextEncoder().encode(JSON.stringify(data));
  }
}
