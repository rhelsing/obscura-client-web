/**
 * Full ORM Schema Definition
 * Used by all clients after login/register
 */

export const fullSchema = {
  // EPHEMERAL MODELS (24h TTL)
  story: {
    fields: { content: 'string', mediaUrl: 'string?' },
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

  // COLLECTABLE MODELS (permanent)
  streak: {
    fields: { count: 'number', lastActivity: 'timestamp' },
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
