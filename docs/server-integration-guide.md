# Server Integration Guide

Hard-won knowledge from building the Obscura web client against the v0.8.0 server. Everything here was discovered through smoke tests against the real server, not documentation.

## Identity Model

**One user, many devices.** The server has two JWT scopes:

- **User-Scoped JWT** — `POST /v1/users` or `POST /v1/sessions` without `deviceId`. Has `sub` (userId) but no `device_id` claim. Can provision devices, list devices. Cannot send messages, fetch bundles, or access backups.
- **Device-Scoped JWT** — `POST /v1/devices` or `POST /v1/sessions` with `deviceId`. Has both `sub` (userId) and `device_id` (deviceId). Required for messaging, prekey bundles, backup, gateway.

The `device_id` claim in the JWT uses **snake_case**, not camelCase. Parse with `payload.device_id`, not `payload.deviceId`.

## Registration Flow

```
POST /v1/users     { username, password }           → User-Scoped JWT (no keys needed!)
POST /v1/devices   { name, identityKey, ...keys }   → Device-Scoped JWT
```

The old server required Signal keys at registration. The new server separates user creation from device provisioning. Keys go on the device, not the user.

## Login Flow

```
POST /v1/sessions  { username, password, deviceId }  → Device-Scoped JWT
```

If you omit `deviceId`, you get a User-Scoped JWT. Always include `deviceId` when you have one stored locally.

## Envelope.sender_id is userId, NOT deviceId

This is the most important thing to understand. When you receive a message via WebSocket:

```
Envelope {
  id: bytes        // message UUID
  sender_id: bytes // sender's USER UUID (not device UUID!)
  timestamp: uint64
  message: bytes   // encrypted payload
}
```

The `sender_id` is the **userId** (user account UUID). The server does NOT tell you which device sent the message. This means:

- **Signal sessions are keyed by userId**, not deviceId
- **Friend lookup uses userId** — `getUsernameFromDeviceId(senderId)` must check `friend.userId`, not just `friend.devices[].deviceId`
- **Message routing uses deviceId** — `SendMessageRequest.Submission.device_id` targets a specific device queue

## Message Routing vs Signal Encryption

These use DIFFERENT identifiers:

| Operation | Identifier | Source |
|-----------|-----------|--------|
| `SendMessageRequest.device_id` | deviceId | From friend's device list or prekey bundles |
| `SignalProtocolAddress(id, regId)` | userId | From `Envelope.sender_id` |
| `Envelope.sender_id` | userId | Server fills this from JWT `sub` |
| `GET /v1/users/{id}` | userId | Returns array of prekey bundles |

Every `sendMessage` call needs BOTH: `deviceId` for routing, `userId` for Signal encryption. The messenger's `queueMessage(targetDeviceId, opts, targetUserId)` takes both.

## PreKey Bundles Are Per-Device

```
GET /v1/users/{userId}  →  Array of PreKeyBundleResponse
```

Each bundle has `{ deviceId, registrationId, identityKey, signedPreKey, oneTimePreKey }`. Note: `oneTimePreKey` (singular), not `preKey`. The field name changed from the old API.

When sending to a user with multiple devices, you must send to EACH device separately — fetch bundles, iterate, encrypt per-device, batch in one `POST /v1/messages`.

## Signal Protocol Multi-Device Addressing

For single-device users, `SignalProtocolAddress(userId, 1)` works fine. For multi-device:

```js
SignalProtocolAddress(userId, registrationId)
```

Each device has a unique `registrationId` from its prekey bundle. Using different `registrationId` values creates separate Signal sessions per device under the same userId. This is critical — using `1` for all devices causes session collisions.

**The registrationId must be stored** on friend device records in IndexedDB. It's discovered via `fetchPreKeyBundles` and persisted so it survives page reloads. The messenger maintains a `_deviceMap` (deviceId → {userId, registrationId}) for runtime resolution.

## Decrypt Must Try Multiple Sessions

When decrypting, the receiver knows the sender's userId but not which device sent it. The decrypt function must:

1. Collect all known `registrationId` values for that userId
2. For **Whisper** messages: try addresses WITH existing sessions first
3. For **PreKey** messages: try addresses WITHOUT existing sessions first (to avoid corrupting stale sessions)
4. Return on first successful decrypt

```js
// Simplified decrypt loop
for (const regId of candidates) {
  const addr = new SignalProtocolAddress(senderId, regId);
  const hasSession = await store.loadSession(addr.toString());
  if (isWhisper && !hasSession) continue;
  try {
    return cipher.decrypt(content);
  } catch { continue; }
}
```

Trying a stale session with a Whisper message can corrupt it (Bad MAC advances internal state). Order matters.

## Backups Are Per-Device

```
POST /v1/backup    → requires Device-Scoped JWT
HEAD /v1/backup    → requires Device-Scoped JWT (same device that uploaded)
GET  /v1/backup    → requires Device-Scoped JWT (same device that uploaded)
```

Backups are scoped to the device that uploaded them. A different device (even same user) gets 404. User-Scoped JWTs get 403.

**For recovery:** use device takeover. Login with the old device's `deviceId`, call `POST /v1/devices/keys` with a new `identityKey` to take over the device. The backup remains accessible under the same deviceId. Then download and restore.

```
POST /v1/sessions          { username, password, deviceId: oldDeviceId }  → Device-Scoped JWT
POST /v1/devices/keys      { identityKey: NEW_KEY, ... }                 → Takeover (200)
GET  /v1/backup                                                          → Backup still there
```

Device takeover deletes all old keys, pending messages, and disconnects active WebSockets. But preserves the backup.

## Device Takeover

`POST /v1/devices/keys` with a DIFFERENT `identityKey` triggers takeover:
- Replaces the identity key
- Deletes ALL old keys (signed + one-time)
- Deletes ALL pending messages
- Disconnects active WebSockets
- **Preserves backup**

If the `identityKey` matches what's already stored, it's just a normal key refill (append prekeys).

## WebSocket Gateway

```
POST /v1/gateway/ticket    → { ticket: "..." }     (requires Device-Scoped JWT)
GET  /v1/gateway?ticket=X  → WebSocket upgrade      (single-use ticket)
```

Tickets are single-use. You cannot reuse a ticket or pass the JWT directly as a query param.

On connect, the server may push a `PreKeyStatus` frame if one-time prekeys are running low. Handle this to trigger prekey replenishment via `POST /v1/devices/keys`.

## PreKey Upload

```
POST /v1/devices/keys  (NOT /v1/keys)
```

The old endpoint `/v1/keys` no longer exists. Prekey upload requires a Device-Scoped JWT.

## SESSION_RESET Protocol

When a Signal session is corrupted (Bad MAC, No Record):

1. **Sender** deletes all local sessions for the target userId (at all known registrationIds)
2. **Sender** sends `SESSION_RESET` to each of the target's devices (this creates a new PreKey session)
3. **Receiver** gets the SESSION_RESET as a PreKey message — the decrypt creates a fresh session automatically
4. **Receiver** deletes stale sessions at OTHER registrationIds (but keeps the one just created)
5. Next message uses the fresh session — bidirectional ratchet works

Key insight: `_handleSessionReset` should delete stale sessions but NOT the one just created by the PreKey decrypt. Pass the decrypt's `regId` through and exclude it from deletion.

## Auto-Recovery

When receiving a Whisper message that fails to decrypt (Bad MAC or No Record), trigger auto-recovery:

1. Send SESSION_RESET to the sender's devices (via `resetSessionWith(senderId)`)
2. ACK the failed message to clear it from the queue
3. The sender receives SESSION_RESET, their next message will be PreKey

This handles both "no session" (device was wiped) and "bad session" (keys rotated, corruption).

## The deviceId → userId Problem

The most common bug pattern: using a `deviceId` where a `userId` is expected, or vice versa. These are both UUIDs and look identical. The error manifests as:

- **404 from `GET /v1/users/{id}`** — you passed a deviceId instead of userId
- **"Device not found" from `POST /v1/messages`** — you passed a userId instead of deviceId
- **Messages silently not delivered** — sent to userId as device_id, server accepts (200) but never delivers

Every function that touches the server needs to be clear about which ID it's using. The naming convention:
- `userId` — user account UUID (`JWT.sub`, `Envelope.sender_id`)
- `deviceId` — device UUID (`JWT.device_id`, `GET /v1/devices`, prekey bundle `deviceId`)

## Friend Record Must Store userId

Friend records in IndexedDB must store the friend's `userId` (user account UUID) separately from their device list. This is needed for:

- Signal encryption (`encrypt(userId, ...)`)
- Prekey bundle fetching (`GET /v1/users/{userId}`)
- Verify code generation (uses `recoveryPublicKey`, looked up by userId)

The `userId` comes from `Envelope.sender_id` when you first interact with a friend. Store it immediately and persist to IndexedDB.

## Own Device Records Must Store registrationId

When you add a linked device (via approveLink), fetch its prekey bundle to get the `registrationId` and store it on the device record. This is needed for:

- Signal session resolution (decrypt tries all known regIds)
- Self-sync encryption (own devices share the same userId, need different regIds)

## Verify Codes Use Recovery Public Key

Verify codes (4-digit out-of-band verification) use the `recoveryPublicKey`, NOT Signal identity keys. The recovery key is:

- Per-user (not per-device) — same across all devices
- Stable — doesn't change when devices are added/removed
- Available to friends via DeviceAnnounce
- Ed25519 public key (32 bytes)

## Proto Field Names

The client proto (`public/proto/v2/client.proto`) and server proto (`public/proto/obscura/v1/obscura.proto`) use snake_case. Protobufjs converts to camelCase in JavaScript:

| Proto field | JS property |
|------------|-------------|
| `device_id` | `deviceId` |
| `sender_id` | `senderId` |
| `device_uuid` | `deviceUuid` |
| `submission_id` | `submissionId` |
| `one_time_pre_key` | `oneTimePreKey` |

## Rate Limiting

All endpoints subject to 429 with `retry-after` header. Add delays between rapid API calls in tests (`await sleep(500)`).

## Common Gotchas

1. **Don't send to userId** — `SendMessageRequest.device_id` must be a real deviceId, not userId. The server silently accepts userId but never delivers the message.

2. **Don't delete the session you just created** — After decrypting a SESSION_RESET PreKey, the session at the decrypt address is fresh. Don't delete it in `_handleSessionReset`.

3. **PreKey decrypt at stale address corrupts it** — The decrypt loop must try without-session addresses first for PreKey messages. Trying a stale session with a PreKey can create garbage.

4. **Backup is per-device** — Don't try to access another device's backup. Use device takeover for recovery.

5. **Friend records from backup may lack userId** — When restoring from backup, explicitly pass `userAccountId` to `addFriend`. The backup's raw IndexedDB records have it, but the restore code must propagate it.

6. **The _deviceMap is in-memory only** — It doesn't survive page reloads. Populate it from friend device records (which have `registrationId`) and own device records on `connect()`. Also populate it when processing DeviceAnnounce and when fetching prekey bundles.

7. **`sendMessage(deviceId, opts)` without userId** — If the `_deviceMap` doesn't have the deviceId mapped, the messenger falls back to using deviceId as userId for Signal encryption. This causes 404 on `fetchPreKeyBundles`. Always pass the third arg: `sendMessage(deviceId, opts, userId)`.
