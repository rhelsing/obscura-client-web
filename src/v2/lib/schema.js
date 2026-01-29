/**
 * Full ORM Schema Definition
 * Used by all clients after login/register
 */

export const fullSchema = {
  // EPHEMERAL MODELS (24h TTL)
  story: {
    fields: { content: 'string', mediaUrl: 'string?', authorUsername: 'string?' },
    has_many: ['comment', 'reaction'],
    sync: 'g-set',
    ephemeral: true,
    ttl: '24h',
  },
  comment: {
    fields: { text: 'string' },
    belongs_to: ['story', 'comment'],
    has_many: ['comment', 'reaction'],
    sync: 'g-set',
    ephemeral: true,
    ttl: '24h',
  },
  reaction: {
    fields: { emoji: 'string' },
    belongs_to: ['story', 'comment'],
    sync: 'lww',
    ephemeral: true,
    ttl: '24h',
  },

  // SNAP MODELS
  snap: {
    fields: {
      recipientUsername: 'string',
      senderUsername: 'string',
      mediaRef: 'string',        // JSON ContentReference
      caption: 'string?',
      displayDuration: 'number', // 1-10 seconds
      viewedAt: 'timestamp?',    // null = unviewed
    },
    sync: 'g-set',      // Immutable (no edits after send)
    collectable: true,  // Persists until viewed+deleted
  },

  // COLLECTABLE MODELS (permanent)
  streak: {
    fields: {
      friendUsername: 'string',
      count: 'number',
      lastSentAt: 'timestamp',
      lastReceivedAt: 'timestamp',
      expiresAt: 'timestamp',
    },
    sync: 'lww',
    collectable: true,
  },
  profile: {
    fields: { displayName: 'string', avatarUrl: 'string?', bio: 'string?' },
    sync: 'lww',
    collectable: true,
  },
  settings: {
    fields: { theme: 'string', notificationsEnabled: 'boolean' },
    sync: 'lww',
    collectable: true,
    private: true,  // Only syncs to own devices
  },

  // GROUP MODELS
  group: {
    fields: { name: 'string', members: 'string' },  // members = JSON array of usernames
    has_many: ['groupMessage'],
    sync: 'g-set',
    collectable: true,
  },
  groupMessage: {
    fields: { text: 'string' },
    belongs_to: 'group',
    sync: 'g-set',
    ephemeral: true,
    ttl: '7d',
  },
};
