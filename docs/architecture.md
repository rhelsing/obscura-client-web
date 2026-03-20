# Obscura Web Client Architecture

## The Big Picture

Obscura is an end-to-end encrypted messaging app. The server is a dumb pipe — it queues encrypted blobs and delivers them. It never sees plaintext. All encryption, session management, friend discovery, and device coordination happens client-side.

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                            │
│                                                         │
│  ObscuraClient (facade)                                 │
│    ├── Messenger (Signal Protocol + transport)          │
│    ├── FriendManager (friend list + device tracking)    │
│    ├── DeviceManager (own devices for self-sync)        │
│    ├── AttachmentManager (encrypted file upload)        │
│    └── ORM (Stories, Pix, Groups, Settings)             │
│                                                         │
│  Signal Store (IndexedDB)                               │
│    ├── Identity keys (encrypted with password)          │
│    ├── Sessions (per-user, per-device registrationId)   │
│    ├── PreKeys (one-time, signed)                       │
│    └── Trusted identities                               │
│                                                         │
│  Data Stores (IndexedDB)                                │
│    ├── Friends + devices + recoveryPublicKey             │
│    ├── Messages                                         │
│    ├── Own devices (with registrationId)                 │
│    └── ORM models                                       │
└───────────────────┬─────────────────────────────────────┘
                    │ HTTPS + WSS
┌───────────────────┴─────────────────────────────────────┐
│                    Server (dumb pipe)                    │
│                                                         │
│  POST /v1/users          → register (no keys)           │
│  POST /v1/devices        → provision with Signal keys   │
│  POST /v1/sessions       → login (optional deviceId)    │
│  POST /v1/messages       → queue encrypted blobs        │
│  GET  /v1/users/{id}     → prekey bundles (per device)  │
│  GET  /v1/gateway        → WebSocket (ticket auth)      │
│  POST /v1/devices/keys   → upload prekeys / takeover    │
│  GET  /v1/backup         → per-device backup blob       │
└─────────────────────────────────────────────────────────┘
```

## Two IDs, Two Purposes

Everything in this codebase revolves around two UUIDs that look identical but serve completely different purposes:

| ID | What it is | Where it appears | Used for |
|----|-----------|-----------------|----------|
| **userId** | User account UUID | `JWT.sub`, `Envelope.sender_id` | Signal sessions, friend lookup, "who is this person" |
| **deviceId** | Device UUID | `JWT.device_id`, `Submission.device_id` | Message routing, prekey bundles, backup access |

The server puts **userId** in `Envelope.sender_id`. The server routes messages by **deviceId** in `Submission.device_id`. Confusing these two causes silent message loss (sent to userId as device_id → server accepts, never delivers) or 404 errors (fetching bundles with deviceId instead of userId).

## Identity & Auth

### Registration
```
POST /v1/users     { username, password }     → User-Scoped JWT (no keys)
POST /v1/devices   { name, keys... }          → Device-Scoped JWT (has device_id claim)
```

One user account, many devices. Keys live on devices, not users. The JWT `device_id` claim uses snake_case.

### Login
```
POST /v1/sessions  { username, password, deviceId }  → Device-Scoped JWT
```

Omitting `deviceId` gives a User-Scoped JWT (can provision devices, can't message). The stored `deviceId` from IndexedDB is included on re-login to get a device-scoped token.

### Session Persistence
`ObscuraClient.saveSession()` writes to localStorage:
- `token`, `refreshToken`, `userId`, `deviceId`, `deviceUUID`, `deviceInfo`

`ObscuraClient.restoreSession()` reads it back, refreshes expired tokens, recreates the Signal store from IndexedDB. The Signal store database is `obscura_signal_v2_{username}`.

## Signal Protocol

### Session Addressing

Sessions are keyed by `SignalProtocolAddress(userId, registrationId)`:
- **userId** because `Envelope.sender_id` gives us userId on receive
- **registrationId** because each device has a unique one — prevents session collision when a user has multiple devices

For single-device users, `registrationId` from the prekey bundle is used. For the first interaction, it defaults to 1 (the encrypt auto-fetches bundles to build the session).

### The Device Map

`messenger._deviceMap`: `Map<deviceId, { userId, registrationId }>`

Bridges the gap between deviceId (for routing) and userId+registrationId (for Signal sessions). Populated by:
- `fetchPreKeyBundles(userId)` → auto-populates for each bundle returned
- `connect()` → loads from friend device records and own device records
- `_routeMessage()` → populates from incoming DeviceAnnounce

The registrationId MUST be persisted in IndexedDB (on friend device records and own device records) to survive page reloads. Without it, the device map has `registrationId: undefined` after reload and sessions can't be resolved.

### Encrypt Flow

```
queueMessage(targetDeviceId, opts, targetUserId)
  → resolve userId from: explicit arg > deviceMap > fallback to deviceId
  → resolve registrationId from: deviceMap > default 1
  → encrypt(userId, plaintext, registrationId)
    → check session at (userId, registrationId)
    → if no session: fetchPreKeyBundles(userId) → processPreKey → store session
    → SessionCipher.encrypt()
  → queue { submissionId, device_id: targetDeviceId, message }
```

### Decrypt Flow

```
decrypt(sourceUserId, content, messageType)
  → collect candidate registrationIds: [explicit, 1, ownRegId, ...mapEntries]
  → sort: Whisper → try WITH session first; PreKey → try WITHOUT session first
  → for each candidate:
    → if Whisper and no session: skip
    → try decrypt
    → on success: return { bytes, senderRegId, senderDeviceId }
    → on failure: try next
  → if all fail and PreKey: try fetching fresh bundles
  → if all fail: throw "No record for {userId}"
```

The ordering matters critically:
- **Whisper + stale session = Bad MAC** which corrupts the session state
- **PreKey at existing session address** may overwrite good session with garbage
- Always try fresh addresses first for PreKey, existing sessions first for Whisper

### Session Reset Protocol

When sessions are corrupted (Bad MAC, No Record on Whisper):

1. **Initiator** calls `resetSessionWith(userId)`:
   - `removeSessionsForUser(userId)` — scans IndexedDB for ALL sessions with that userId prefix
   - Sends SESSION_RESET to each of the user's devices (PreKey message, establishes fresh session)

2. **Receiver** gets SESSION_RESET:
   - PreKey decrypt creates a fresh session at some registrationId
   - `_handleSessionReset` deletes ALL other sessions for that userId (keeps the fresh one via `keepRegId`)
   - Next message from initiator uses the fresh session — bidirectional ratchet works

3. **Auto-recovery** triggers when receiving a Whisper that fails with "No record":
   - Calls `resetSessionWith(senderId)` automatically
   - ACKs the failed message to clear it from the queue

Auto-recovery does NOT trigger on Bad MAC — that would cause cascade resets in multi-device scenarios where a stale session attempt fails but another registrationId succeeds.

## Multi-Device

### Device Linking

```
1. New device logs in → gets User-Scoped JWT → POST /v1/devices → gets Device-Scoped JWT
2. New device shows link code (contains userId, deviceId, deviceUUID, signalIdentityKey, challenge, signature)
3. Existing device scans code → approveLink():
   a. fetchPreKeyBundles(ownUserId) → discover new device's registrationId
   b. Add new device to DeviceManager
   c. Send DEVICE_LINK_APPROVAL (PreKey) with p2pIdentity, recoveryPublicKey, own device list
   d. Send SYNC_BLOB with compressed friends, messages, ORM data
   e. announceDevices() → notify all friends about new device list
4. New device receives approval → stores identity, navigates to /stories
5. Friends receive DeviceAnnounce → update device lists → fetchPreKeyBundles to get registrationIds
```

### Fan-Out (Sending to Multi-Device User)

When sending to a friend with multiple devices:
1. `send()` gets `targets = getFanOutTargets(friendUsername)` — array of deviceIds
2. If targets > 1, fetch bundles to ensure device map has registrationIds for all devices
3. `queueMessage(deviceId, opts, friendUserId)` for each target
4. Each device gets a separately encrypted message (different Signal session per registrationId)
5. Also queue SENT_SYNC to own devices for self-sync

The `send()` pre-fetch is critical — without it, all devices share one session at `(userId, 1)` and only the first device can decrypt.

### Self-Sync

Own devices share the same userId. Self-sync messages (SENT_SYNC, DEVICE_ANNOUNCE, MODEL_SYNC) go from one device to another via the same messaging infrastructure. Each own device needs:
- A separate Signal session (different registrationId)
- The registrationId persisted on the own device record in IndexedDB
- The deviceId → (userId, registrationId) mapping in the messenger's device map

## Data Flow

### Outbound Message

```
User types message → Chat.js submit
  → ObscuraClient.send(friendUsername, { type: 'TEXT', text })
    → FriendManager.getFanOutTargets(friendUsername) → [deviceId1, deviceId2]
    → for each: messenger.queueMessage(deviceId, opts, friendUserId)
      → messenger.encrypt(friendUserId, plaintext, registrationId)
      → queue Submission { device_id, message }
    → for own devices: messenger.queueMessage(ownDeviceId, sentSyncOpts, ownUserId)
    → messenger.flushMessages()
      → POST /v1/messages (protobuf, Idempotency-Key header)
```

### Inbound Message

```
WebSocket frame → ObscuraClient._handleMessage()
  → decode WebSocketFrame → extract Envelope { id, sender_id, message }
  → sender_id is userId (not deviceId!)
  → decode EncryptedMessage from message bytes
  → messenger.decrypt(senderId, content, type) → { bytes, senderDeviceId }
  → messenger.decodeClientMessage(bytes) → { type, text, deviceAnnounce, ... }
  → msg.sourceUserId = senderId
  → msg.senderDeviceId = senderDeviceId (from decrypt result)
  → _routeMessage(msg) → switch on msg.type:
    FRIEND_REQUEST → friends.processRequest() → emit 'friendRequest'
    FRIEND_RESPONSE → friends.processResponse() → emit 'friendResponse'
    TEXT/IMAGE → getUsernameFromDeviceId(sourceUserId) → _persistMessage → emit 'message'
    DEVICE_ANNOUNCE → _processAnnounce() → emit 'deviceAnnounce'
    DEVICE_LINK_APPROVAL → _processLinkApproval()
    SYNC_BLOB → _processSyncBlob()
    SENT_SYNC → _processSentSync()
    SESSION_RESET → _handleSessionReset()
    MODEL_SYNC → ORM handles it
  → _acknowledge(envelopeId) → bulk ACK via WebSocket
```

### Friend Lookup

`getUsernameFromDeviceId(id)` searches by:
1. `friend.userId === id` (Envelope.sender_id is userId)
2. `friend.devices.some(d => d.deviceId === id)` (fallback for device-level lookup)

This dual lookup is necessary because `Envelope.sender_id` is always userId, but some legacy code paths pass deviceId.

## Persistence

### IndexedDB Databases

| Database | Keyed By | Contains |
|----------|----------|----------|
| `obscura_signal_v2_{username}` | username | Identity keys, prekeys, sessions, device identity |
| `obscura_friends_v2_{userId}` | username (key) | Friends with devices, userAccountId, recoveryPublicKey |
| `obscura_device_{username}` | singleton | Own identity, p2pPublicKey, recoveryPublicKey |
| `obscura_messages_v2_{userId}` | - | Chat messages with authorDeviceId |
| `obscura_models_{userId}` | - | ORM data (stories, pix, groups, settings) |
| `obscura_attachments_{username}` | - | Cached encrypted attachment blobs |

### What Must Be Persisted for Multi-Device

- **registrationId** on friend device records → enables per-device Signal sessions after page reload
- **registrationId** on own device records → enables self-sync Signal sessions after page reload
- **userId** on friend records (as `userAccountId`) → needed for Signal encryption and bundle fetching
- **recoveryPublicKey** on friend records → needed for verify codes and revocation verification

### Session Persistence

Signal sessions are stored in `obscura_signal_v2_{username}` IndexedDB at key `{userId}.{registrationId}`. The `removeSessionsForUser(userId)` method scans all keys with the userId prefix — this is used by `resetSessionWith` and `_handleSessionReset` to clean up all sessions regardless of registrationId.

## Backup & Recovery

### Backup Upload
Each device uploads its own backup via `POST /v1/backup`. Backups are **per-device** — another device (even same user) gets 404.

### Recovery Flow
1. Login → User-Scoped JWT
2. `GET /v1/devices` → list existing devices
3. For each device: login with its deviceId → check `HEAD /v1/backup`
4. Found backup → `POST /v1/devices/keys` with new identity key → **device takeover**
5. Takeover preserves backup, replaces keys, purges messages
6. `GET /v1/backup` → download and restore
7. `recoverAccount()` provisions the recovery device with new Signal keys

### What Survives Recovery
- Friends list (from backup, must include `userAccountId`)
- Messages (from backup)
- ORM data (from backup)
- Signal sessions: NO — all sessions are re-established via PreKey on first message

## Verify Codes

4-digit codes for out-of-band verification. Uses `recoveryPublicKey` (Ed25519, 32 bytes):
- Per-user (not per-device) — same across all devices of the same user
- Stable — doesn't change when devices are added/removed
- `SHA-256(recoveryPublicKey)` → first 2 bytes → uint16 mod 10000 → zero-padded to 4 digits

## ORM Layer

Models (Story, Pix, Group, Settings, etc.) use CRDT-based sync:
- Each model operation creates a `MODEL_SYNC` message
- `SyncManager.broadcast()` fans out to friend devices + self-syncs to own devices
- Incoming MODEL_SYNC routes through the ORM to create/update/delete local entries
- TTL-based cleanup for ephemeral models (stories: 24h)

## Three Protocol Layers

The system has three nesting layers. The server only sees Layer 1. Layers 2 and 3 are opaque encrypted bytes from the server's perspective.

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: SERVER PROTO (transport)                   │
│ public/proto/obscura/v1/obscura.proto               │
│                                                     │
│ WebSocketFrame, Envelope, AckMessage,               │
│ SendMessageRequest, SendMessageResponse,            │
│ PreKeyStatus                                        │
│                                                     │
│ The server reads and writes these.                  │
│ Binary protobuf over HTTP (messages) and            │
│ WebSocket (gateway).                                │
├─────────────────────────────────────────────────────┤
│ Layer 2: CLIENT PROTO (encrypted application)       │
│ public/proto/v2/client.proto                        │
│                                                     │
│ EncryptedMessage { type, content }                  │
│   → wraps Signal ciphertext                         │
│                                                     │
│ ClientMessage { type, text, deviceAnnounce, ... }   │
│   → the actual message (TEXT, FRIEND_REQUEST,       │
│     DEVICE_ANNOUNCE, SYNC_BLOB, SENT_SYNC, etc.)   │
│                                                     │
│ DeviceInfo, DeviceLinkApproval, DeviceAnnounce,     │
│ SyncBlob, SentSync, ContentReference, FriendSync    │
│                                                     │
│ Server NEVER sees this. It's the plaintext inside   │
│ the Signal encryption. Lives in Envelope.message    │
│ as opaque bytes.                                    │
├─────────────────────────────────────────────────────┤
│ Layer 3: ORM LAYER (JSON inside proto)              │
│ No .proto file — JSON encoded as bytes              │
│                                                     │
│ ModelSync { model, id, op, data, timestamp }        │
│   → data field is JSON.stringify() as bytes         │
│   → models: Story, Pix, Group, Settings,            │
│     Profile, Comment, Reaction, GroupMessage         │
│                                                     │
│ SyncBlob { compressed_data }                        │
│   → gzip(JSON.stringify({ friends, messages, orm }))│
│                                                     │
│ These ride inside Layer 2's ClientMessage as         │
│ modelSync or syncBlob fields. The proto defines     │
│ the envelope; the actual model data is schemaless   │
│ JSON. Schema versioning is handled by the ORM's     │
│ CRDT merge semantics, not by protobuf.              │
└─────────────────────────────────────────────────────┘
```

**Nesting on send:**
```
App data (JSON) → ModelSync.data (bytes)
  → ClientMessage (proto) → plaintext bytes
    → Signal encrypt → EncryptedMessage.content (bytes)
      → Submission.message (bytes)
        → SendMessageRequest (proto) → HTTP POST body
```

**Nesting on receive:**
```
WebSocket binary → WebSocketFrame (proto)
  → Envelope.message (bytes)
    → EncryptedMessage (proto) → Signal decrypt
      → ClientMessage (proto) → route by type
        → ModelSync.data (bytes) → JSON.parse → ORM model
```

## Message Types

| Type | Value | Direction | Purpose |
|------|-------|-----------|---------|
| TEXT | 0 | friend→friend | Chat message |
| IMAGE | 1 | friend→friend | Image attachment |
| FRIEND_REQUEST | 2 | user→user | Initiate friendship |
| FRIEND_RESPONSE | 3 | user→user | Accept/reject |
| SESSION_RESET | 4 | user→user | Reset broken Signal session |
| DEVICE_LINK_APPROVAL | 11 | self→self | Approve new device |
| DEVICE_ANNOUNCE | 12 | user→friends | Updated device list |
| DEVICE_RECOVERY_ANNOUNCE | 13 | user→friends | Account recovery notification |
| SYNC_BLOB | 23 | self→self | Full state transfer to new device |
| SENT_SYNC | 24 | self→self | Notify own devices of sent message |
| CONTENT_REFERENCE | 25 | friend→friend | Encrypted attachment key |
| MODEL_SYNC | 30 | varies | ORM CRDT operation |

## Key Files

| File | Responsibility |
|------|---------------|
| `src/v2/lib/ObscuraClient.js` | Main facade — connects everything, handles WebSocket, routes messages |
| `src/v2/lib/messenger.js` | Signal Protocol encrypt/decrypt, prekey bundles, device map, message batching |
| `src/v2/lib/auth.js` | Register, login, recovery — server API interaction |
| `src/v2/lib/friends.js` | Friend list, device tracking, fan-out targets, verify codes |
| `src/v2/lib/devices.js` | Own device list, self-sync targets, link code parsing |
| `src/v2/lib/store.js` | InMemoryStore (tests) / IndexedDBStore (browser) for Signal Protocol |
| `src/v2/lib/IndexedDBStore.js` | Signal session/key persistence in IndexedDB |
| `src/v2/api/client.js` | HTTP API client — all server endpoints |
| `src/v2/orm/sync/SyncManager.js` | ORM model sync — broadcasts MODEL_SYNC to devices |
| `src/v2/store/friendStore.js` | IndexedDB for friends (includes userAccountId, registrationId) |
| `src/v2/store/deviceStore.js` | IndexedDB for own devices (includes registrationId) |
| `src/v2/views/auth/Recover.js` | Recovery UI — device takeover for backup access |
| `src/v2/crypto/signatures.js` | Verify codes, recovery key derivation, announce signing |
