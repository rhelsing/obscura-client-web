# Obscura SDK Guide

> The developer experience: ORM-like models over encrypted P2P sync. Define a schema, add associations, it just works.

**See also:** [Protocol Spec](./protocol-spec.md) - the low-level foundation this SDK abstracts

---

## Design Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| **Network size** | ~150 (Dunbar) | Full E2E practical, fan-out manageable |
| **Default persistence** | Ephemeral | Delete after view unless collected |
| **Encryption** | Always E2E | No public/signed-only tier needed at this scale |

```
┌─────────────────────────────────────────────────────────────────┐
│ EPHEMERAL BY DEFAULT                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Content auto-deletes after viewed (or TTL expires)              │
│ Not stored permanently unless explicitly "collected"            │
│                                                                 │
│ COLLECTABLE (opt-in)                                            │
│ Recipient can save to their local collection                    │
│ Their copy, their choice - survives server deletion             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Developer Experience

```javascript
import { Obscura } from '@obscura/sdk';

const client = new Obscura({ server: '...' });

// Define models - like Firebase/Prisma but P2P + encrypted
const Story = client.model('story', {
  sync: 'g-set',           // grow-only, fans out to friends
  ttl: '24h',              // auto-expire
  fields: {
    content: 'string',
    mediaUrl: 'string?',
  }
});

const Comment = client.model('comment', {
  sync: 'g-set',
  parent: 'story',         // nested under story
  fields: {
    text: 'string',
  }
});

const Streak = client.model('streak', {
  sync: 'lww',             // last-write-wins (mutable)
  fields: {
    friendId: 'string',
    count: 'number',
    lastActivity: 'timestamp',
  }
});

// CRUD - just works, syncs automatically
await Story.create({ content: 'Hello world' });
await Comment.create({ parentId: storyId, text: 'Nice!' });
await Streak.upsert({ friendId: 'bob', count: 5 });

// Query - local first, eventually consistent
const stories = await Story.find({ userId: 'alice' });
const comments = await Comment.find({ parentId: storyId });
const streak = await Streak.get({ friendId: 'bob' });
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    YOUR APP CODE                                │
│   Story.create()    Comment.find()    Streak.upsert()          │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MODEL LAYER                                  │
│  - Validates fields                                             │
│  - Generates unique IDs                                         │
│  - Signs entries                                                │
│  - Routes to correct CRDT                                       │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SYNC PRIMITIVES                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐                   │
│  │  G-Set    │  │  LWW-Map  │  │  Counter  │   (extensible)    │
│  │ (grow)    │  │ (mutable) │  │ (inc/dec) │                   │
│  └───────────┘  └───────────┘  └───────────┘                   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MESSAGE TRANSPORT                            │
│  Everything becomes a "message" to the dumb pipe:               │
│  { type: 'MODEL_SYNC', model: 'story', op: 'create', data }    │
│  → Encrypted via Signal → Fanned out → Drained via WebSocket   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Proto: Extended ClientMessage

```protobuf
message ClientMessage {
  enum Type {
    // ... existing types ...
    MODEL_SYNC = 30;
  }
  ModelOperation model_op = 50;
}

message ModelOperation {
  string model_name = 1;      // "story", "comment", "streak"
  string op = 2;              // "create", "update", "delete"
  string entry_id = 3;
  uint64 timestamp = 4;
  bytes data = 5;             // serialized model data
  bytes signature = 6;
  string parent_model = 7;    // for nested models
  string parent_id = 8;
}
```

---

## Device Linking: Password Verification

```
┌─────────────────────────────────────────────────────────────────┐
│ DEVICE LINKING WITH PASSWORD VERIFICATION                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 1. New device registers with server (any password)              │
│    → Server creates user, doesn't know about linking            │
│                                                                 │
│ 2. New device displays QR code:                                 │
│    { device_id, signal_key, password_hash_challenge }           │
│    password_hash_challenge = hash(password + random_salt)       │
│                                                                 │
│ 3. Existing device scans QR, prompts for password               │
│    → Computes: hash(entered_password + salt)                    │
│    → Match: approve link                                        │
│    → No match: reject                                           │
│                                                                 │
│ 4. Password verified client-side. Server never knows.           │
└─────────────────────────────────────────────────────────────────┘
```

---

## What We're Building

| Layer | What | Status |
|-------|------|--------|
| **Models** | `client.model('story', {...})` | New |
| **CRDT Primitives** | G-Set, LWW-Map, Counter | New |
| **Sync Manager** | Fan-out, drain, merge | New |
| **Device Manager** | Link, announce, password verify | New |
| **Session Manager** | Signal sessions | Exists (extend) |
| **Transport** | HTTP + WebSocket | Exists (extend) |
| **Storage** | IndexedDB | Exists (extend) |
| **Crypto** | libsignal | Exists |

---

## Inner Proto: ModelSync

```
┌─────────────────────────────────────────────────────────────────┐
│                    ENCRYPTED ENVELOPE (Signal)                  │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              INNER PROTO: ModelSync                        │  │
│  │  model: "story"                                            │  │
│  │  id: "abc123"                                              │  │
│  │  data: { content: "...", mediaUrl: "..." }                 │  │
│  │  associations: [                                           │  │
│  │    { type: "has_many", model: "comment", foreignKey }      │  │
│  │  ]                                                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

```protobuf
message ModelSync {
  string model = 1;
  string id = 2;
  Op op = 3;
  uint64 timestamp = 4;
  bytes data = 5;
  bytes signature = 6;
  repeated Association assocs = 7;

  enum Op {
    CREATE = 0;
    UPDATE = 1;    // only for LWW
    DELETE = 2;    // only if model supports
  }
}

message Association {
  string type = 1;            // "belongs_to", "has_many"
  string model = 2;
  string foreign_key = 3;
  string id = 4;
}
```

---

## Schema Definition

```javascript
const schema = client.schema({

  // ─────────────────────────────────────────────────────────────
  // EPHEMERAL MODELS (auto-delete after view or TTL)
  // ─────────────────────────────────────────────────────────────

  story: {
    fields: {
      content: 'string',
      mediaUrl: 'string?',
    },
    has_many: ['comment', 'reaction'],
    sync: 'g-set',
    ephemeral: true,           // REQUIRED: auto-delete
    ttl: '24h',
  },

  message: {
    fields: {
      text: 'string',
      mediaUrl: 'string?',
    },
    belongs_to: 'conversation',
    sync: 'g-set',
    ephemeral: true,           // REQUIRED
    ttl: '7d',
  },

  comment: {
    fields: { text: 'string' },
    belongs_to: ['story', 'comment'],
    has_many: ['comment'],
    sync: 'g-set',
    ephemeral: true,           // REQUIRED
    ttl: '24h',
  },

  reaction: {
    fields: { emoji: 'string' },
    belongs_to: ['story', 'comment', 'message'],
    sync: 'lww',
    ephemeral: true,           // REQUIRED
    ttl: '24h',
  },

  // ─────────────────────────────────────────────────────────────
  // COLLECTABLE MODELS (persist locally forever)
  // ─────────────────────────────────────────────────────────────

  collected: {
    fields: {
      originalType: 'string',
      originalId: 'string',
      originalAuthor: 'string',
      data: 'bytes',
      collectedAt: 'timestamp',
    },
    sync: 'g-set',
    collectable: true,         // REQUIRED: user's permanent collection
  },

  streak: {
    fields: {
      count: 'number',
      lastActivity: 'timestamp',
    },
    belongs_to: 'friend',
    sync: 'lww',
    collectable: true,         // REQUIRED: persists
  },

  profile: {
    fields: {
      displayName: 'string',
      avatarUrl: 'string?',
      bio: 'string?',
    },
    sync: 'lww',
    collectable: true,         // REQUIRED: persists
  },

  friend: {
    fields: {
      status: 'string',        // 'pending', 'accepted'
      addedAt: 'timestamp',
    },
    sync: 'g-set',
    collectable: true,         // REQUIRED: friend list persists
  },

});
```

### Persistence Mode (REQUIRED)

Every model MUST declare either `ephemeral: true` or `collectable: true`:

```javascript
// EPHEMERAL: auto-deletes after view (or TTL)
story: {
  ephemeral: true,    // REQUIRED
  ttl: '24h',         // fallback expiration
  ...
}

// COLLECTABLE: persists in user's local collection
collected: {
  collectable: true,  // REQUIRED
  ...
}
```

| Mode | Behavior | Use Case |
|------|----------|----------|
| `ephemeral: true` | Auto-delete after view or TTL | Stories, messages, snaps |
| `collectable: true` | Persists locally forever | Saved items, profile, streaks |

**No default.** You must choose. This forces intentional data lifecycle design.

---

## Usage

```javascript
// Create
const story = await client.story.create({ content: 'Hello world' });

// Nested create
const comment = await client.comment.create({
  storyId: story.id,
  text: 'Nice!'
});

// Nested nested (replies)
const reply = await client.comment.create({
  commentId: comment.id,
  text: 'Thanks!'
});

// Query with associations
const storyWithComments = await client.story.find(story.id, {
  include: ['comment']
});
// => { id, content, comments: [{ id, text, comments: [...] }] }

// Update (LWW models)
await client.streak.upsert({
  friendId: 'bob',
  count: prev => prev + 1,
  lastActivity: Date.now()
});

// Query
const myStories = await client.story.where({ authorId: client.userId });
const bobsStreak = await client.streak.find({ friendId: 'bob' });

// Collect (save before it expires)
await client.collected.create({
  originalType: 'story',
  originalId: story.id,
  originalAuthor: story.authorId,
  data: story,
});

// View collection
const myCollection = await client.collected.where({ /* all */ });
```

---

## Large Content (Attachments)

For media (images, videos), use the attachment pattern. **Encryption is handled automatically** - content is encrypted before upload, keys distributed via E2E messages. Server never sees plaintext.

```javascript
// Upload (encrypts automatically, server stores only encrypted bytes)
const attachment = await client.attachments.upload(imageBlob);

// Reference in your content
await client.story.create({
  content: 'Check this out!',
  mediaUrl: attachment.id,
});

// Download (decrypts automatically)
const media = await client.attachments.download(story.mediaUrl);
```

```
┌─────────────────────────────────────────────────────────────────┐
│ LARGE CONTENT FLOW                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ WITHOUT attachments:                                            │
│   150 friends × 5MB image = 750MB uploaded (bad!)               │
│                                                                 │
│ WITH attachments:                                               │
│   1 × 5MB upload + 150 × 100 byte notifications = 5MB (good!)  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Scaling Characteristics

| Network Size | Fan-out | Latency | Battery | Recommendation |
|--------------|---------|---------|---------|----------------|
| **1-10** | Trivial | Instant | None | Full E2E, direct |
| **10-50** | Easy | <1s | Minimal | Full E2E, direct |
| **50-150** | OK | ~3s | Noticeable | Full E2E, direct |
| **150+** | Heavy | 5-10s+ | Significant | Consider limits |

```
┌─────────────────────────────────────────────────────────────────┐
│ DUNBAR'S NUMBER (~150) IS THE SWEET SPOT                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Below 150:                                                      │
│   ✓ Full E2E encryption always                                  │
│   ✓ Direct fan-out works                                        │
│   ✓ No complex scaling needed                                   │
│   ✓ Intimate network                                            │
│                                                                 │
│ Above 150:                                                      │
│   • Sends take seconds                                          │
│   • Battery drain noticeable                                    │
│   • Message volume grows quadratically                          │
│   • Consider: is this really a "close network"?                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Sync Flow

```
Alice creates Story with Comment:

1. Client creates:
   ModelSync { model: "story", id: "s1", data: {...} }
   ModelSync { model: "comment", id: "c1", data: {...},
               assocs: [{ type: "belongs_to", model: "story", id: "s1" }] }

2. Wrapped in ClientMessage, encrypted via Signal

3. Fan out to:
   - Alice's other devices (self-sync)
   - Bob (if friend)

4. Bob's device receives, decrypts, unpacks ModelSync

5. Bob's client:
   - Adds to local story G-Set
   - Adds to local comment G-Set
   - Builds association index: story:s1 -> [comment:c1]

6. Bob queries: client.story.find('s1', { include: ['comment'] })
   → Returns nested structure
```

---

## Storage (IndexedDB)

```
obscura_db/
├── models/
│   ├── story/          # G-Set
│   ├── comment/        # G-Set
│   ├── reaction/       # LWW-Map
│   └── streak/         # LWW-Map
├── associations/
│   ├── story:s1 -> [comment:c1, comment:c2, reaction:r1]
│   └── comment:c1 -> [comment:c3]
└── ... (signal, identity, etc.)
```

---

## Full Stack

```
┌──────────────────────────────────────────────────────────────┐
│  YOUR CODE                                                    │
│  client.story.create({ content: '...' })                      │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  SCHEMA LAYER (ORM-like)                                      │
│  Validates fields, builds associations, generates ModelSync   │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  CRDT LAYER                                                   │
│  G-Set (immutable) / LWW-Map (mutable) / Merge on receive     │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  SYNC LAYER                                                   │
│  Wraps in ClientMessage, fan-out, drain from WebSocket        │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  SIGNAL LAYER (libsignal)                                     │
│  Encrypt per recipient device, X3DH, Double Ratchet           │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  DUMB PIPE     message and attachments                        │
│  POST /v1/messages/{device} → queue → WebSocket drain         │
└──────────────────────────────────────────────────────────────┘
```
