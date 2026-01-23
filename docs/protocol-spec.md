# Obscura Protocol Specification

> The foundation layer: identity, devices, encryption, and sync over a dumb pipe.

**Version:** 0.1.0-draft
**Status:** Draft
**See also:** [SDK Guide](./sdk-guide.md) - the developer-facing abstraction built on this protocol

---

## North Star

> **Building on this infrastructure should be as simple as building centralized stuff - except the backbone is an encrypted dumb pipe and P2P sync happens in a "just works" way.**

What this means:

| Centralized (Firebase) | Obscura |
|------------------------|---------|
| `db.add({ text: 'hi' })` | `obscura.send(recipient, { text: 'hi' })` |
| Server stores data | Peers store data (your devices + friends) |
| Server syncs to clients | Clients sync to each other via dumb pipe |
| Auth = server sessions | Auth = cryptographic identity |
| Trust the server | Trust no one (E2E encrypted) |

**Developer should NOT think about:**
- Fan-out (automatic)
- Sync (just happens)
- Device management (feels like "same account")
- Encryption (handled by SDK)

**The protocol layers:**

| Layer | Concern | Who deals with it |
|-------|---------|-------------------|
| **Application** | "send message", "read history" | Developer |
| **Sync** | fan-out, replication, device management | Protocol SDK |
| **Crypto** | Signal Protocol (X3DH, Double Ratchet, XEdDSA) | Protocol SDK |
| **Transport** | HTTP/WebSocket to dumb pipe | Protocol SDK |

**Crypto is still Signal Protocol with XEdDSA** - battle-tested, formally verified. The SDK abstracts it so you don't think about it after the primitives are in place.

---

## Overview

This document specifies the Obscura Sync Protocol - a client-side protocol for multi-device sync, history replication, and federated identity that operates over a "dumb pipe" encrypted relay server.

### Design Principles

1. **Server is dumb** - The relay server only routes encrypted blobs. It has no knowledge of message content, device relationships, or sync state. One queue. KISS.
2. **Self-authenticating data** - All data is signed by the originating identity. Can be verified by any peer.
3. **Grow-only data** - Messages are a grow-only set (CRDT). No deletion, just accumulation. Can compact/archive for efficiency.
4. **Eventually consistent** - Devices sync via WebSocket drain + push. New devices receive history from peers.
5. **Privacy by default** - All payloads are E2E encrypted via Signal Protocol. Server sees only opaque bytes.
6. **Server knows NOTHING** - Device relationships, friend lists, sync state - all managed peer-to-peer via announcements.

### Inspirations

- **FidoNet**: Dumb nodes just route packets. Edge nodes do the work.
- **Secure Scuttlebutt**: Grow-only logs, peer replication, eventual consistency.
- **AT Protocol**: Self-authenticating data, portable identity.
- **CRDTs**: Conflict-free merge by design.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (all the smarts)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  • Generates and stores identity keypair                                     │
│  • Maintains grow-only sets (messages, devices, friends) - CRDT             │
│  • Knows own device list + sibling device keys                              │
│  • Establishes Signal sessions with all peers (friends + own devices)       │
│  • Fans out messages to all recipient devices                               │
│  • Receives messages via WebSocket drain                                    │
│  • Encrypts everything before it hits the wire                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER (dumb pipe)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  • Receives encrypted blobs via POST /v1/messages/{recipientId}             │
│  • Queues blobs for recipient                                               │
│  • Pushes blobs via WebSocket /v1/gateway                                   │
│  • Deletes blob after ACK                                                   │
│  • Stores prekeys for X3DH handshake                                        │
│  • CANNOT read content, identify device relationships, or track sync state  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Concept: Device = Server User, Identity = P2P

**This is the key insight of the protocol.**

### Each Device Registers as a Separate "User" on the Server

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SERVER'S VIEW (dumb)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  "user" alice_phone_abc123     →  identity_key_A, prekeys_A                │
│  "user" alice_laptop_def456    →  identity_key_B, prekeys_B                │
│  "user" alice_tablet_ghi789    →  identity_key_C, prekeys_C                │
│  "user" bob_phone_xyz999       →  identity_key_D, prekeys_D                │
│                                                                             │
│  Server thinks: 4 completely separate users.                                │
│  Server knows NOTHING about Alice having 3 devices.                        │
│  Server just routes encrypted blobs between "users".                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### P2P Identity Links Devices Together

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PEER'S VIEW (smart)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Alice's P2P Identity (Ed25519 pubkey: 0xABC...)                           │
│    │                                                                        │
│    ├── Device: alice_phone_abc123   (Signal key A)                         │
│    ├── Device: alice_laptop_def456  (Signal key B)                         │
│    └── Device: alice_tablet_ghi789  (Signal key C)                         │
│                                                                             │
│  Bob's P2P Identity (Ed25519 pubkey: 0xDEF...)                             │
│    │                                                                        │
│    └── Device: bob_phone_xyz999     (Signal key D)                         │
│                                                                             │
│  Peers know: alice_phone, alice_laptop, alice_tablet are all "Alice"       │
│  This knowledge comes from DeviceAnnounce messages, NOT from server.       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### How It Maps to the Server API

| Action | Server Endpoint | What Server Sees |
|--------|-----------------|------------------|
| Register Device A | `POST /v1/users` | New user "alice_phone_abc123" |
| Register Device B | `POST /v1/users` | New user "alice_laptop_def456" (unrelated!) |
| Alice sends to Bob | `POST /v1/messages/bob_phone_xyz999` | User sends blob to another user |
| Alice syncs to self | `POST /v1/messages/alice_laptop_def456` | User sends blob to another user |
| Bob sends to Alice | Fan-out to 3 endpoints | 3 separate messages to 3 "users" |

**Server sees no difference between:**
- Alice messaging Bob
- Alice syncing to her own devices
- Bob messaging Alice

It's all just: `POST /v1/messages/{some_user_id}` with an encrypted blob.

### Device Linking (Both Devices Nearby)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DEVICE LINKING FLOW                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Device B (new) registers with server as NEW "user"                     │
│     → POST /v1/users { username: "alice_laptop_def456", ... }              │
│     → Server creates new user. Knows nothing about Alice's phone.          │
│                                                                             │
│  2. Device B displays QR code containing:                                   │
│     → server_user_id: "alice_laptop_def456"                                │
│     → signal_identity_key: <key_B>                                         │
│     → challenge: <random_bytes>                                            │
│                                                                             │
│  3. Device A (existing) scans QR code                                       │
│     → Verifies challenge (proves physical proximity)                       │
│     → Sends DeviceLinkApproval via dumb pipe:                              │
│       POST /v1/messages/alice_laptop_def456                                │
│       { type: DEVICE_LINK_APPROVAL, p2p_identity: <Alice's Ed25519>, ... } │
│                                                                             │
│  4. Device B receives approval via WebSocket                                │
│     → Now knows: "I am part of Alice's P2P identity"                       │
│     → Stores Alice's Ed25519 identity key                                  │
│     → Stores sibling device list                                           │
│                                                                             │
│  5. Device A broadcasts DeviceAnnounce to all friends                       │
│     → POST /v1/messages/bob_phone_xyz999 { type: DEVICE_ANNOUNCE, ... }    │
│     → Bob learns: "Alice now has alice_laptop_def456 too"                  │
│     → Bob updates his fan-out list for Alice                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Fan-Out Through the Dumb Pipe

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BOB SENDS MESSAGE TO ALICE                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Bob's client knows (from DeviceAnnounce):                                 │
│    Alice's devices = [alice_phone_abc123, alice_laptop_def456]             │
│                                                                             │
│  Bob's client does:                                                         │
│    1. Encrypt message for alice_phone_abc123 (using Signal session)        │
│       → POST /v1/messages/alice_phone_abc123  [encrypted blob 1]           │
│                                                                             │
│    2. Encrypt message for alice_laptop_def456 (using Signal session)       │
│       → POST /v1/messages/alice_laptop_def456 [encrypted blob 2]           │
│                                                                             │
│  Server sees: Bob's device sending 2 unrelated messages to 2 users.        │
│  Server does NOT know these are the same message to the same person.       │
│                                                                             │
│  Alice's phone:   WebSocket receives blob 1 → decrypt → display            │
│  Alice's laptop:  WebSocket receives blob 2 → decrypt → display            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Self-Sync Through the Dumb Pipe

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ALICE READS MESSAGE ON PHONE, SYNCS TO LAPTOP                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Alice reads message on phone. Phone creates READ_SYNC:                    │
│    → POST /v1/messages/alice_laptop_def456                                 │
│      { type: READ_SYNC, message_id: "xyz", timestamp: 1234567890 }         │
│      (encrypted via Signal session with laptop)                            │
│                                                                             │
│  Server sees: alice_phone_abc123 sending message to alice_laptop_def456    │
│  Server thinks: just two users talking. Has no idea it's sync.             │
│                                                                             │
│  Alice's laptop: WebSocket receives → decrypt → mark message as read       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Design?

| Alternative | Problem |
|-------------|---------|
| Server tracks devices | Server learns relationships, less private |
| Shared Signal key across devices | Breaks forward secrecy, key compromise affects all |
| Single device only | No multi-device support |

**This design:**
- Server stays maximally dumb (just routes blobs)
- Each device has independent Signal keys (forward secrecy preserved)
- P2P announcements link devices (peers know, server doesn't)
- Linking requires physical proximity (QR scan) - secure, but slower

### Trade-off: Privacy vs Speed

```
Server-tracked devices:
  ✓ Instant device discovery
  ✗ Server knows device relationships

P2P-tracked devices (our choice):
  ✓ Server knows NOTHING about relationships
  ✗ Device discovery is eventual (announcement must propagate)
  ✗ Linking requires both devices present
```

**We choose privacy.** Device linking is rare. The slowness is acceptable.

## Identity Model

### User Identity

A user's identity IS their signing keypair. Not tied to any server.

```
Identity = Ed25519 keypair (or Curve25519 converted via XEdDSA)
         = 32-byte public key (globally unique identifier)
         = Portable across servers (if servers federate)
```

### Device Identity

Each device has its own Signal Protocol identity key, linked to the user identity.

```
Device = {
  device_id: random UUID
  signal_identity_key: Curve25519 keypair (for Signal Protocol)
  linked_to: user_identity_public_key
  signature: sign(device_id + signal_identity_key, user_private_key)
}
```

### Multi-Device Topology

```
User Identity (Ed25519)
       │
       ├── Device A (Signal identity key A)
       │      └── Sessions with: Device B, Device C, Alice, Bob...
       │
       ├── Device B (Signal identity key B)
       │      └── Sessions with: Device A, Device C, Alice, Bob...
       │
       └── Device C (Signal identity key C)
              └── Sessions with: Device A, Device B, Alice, Bob...
```

## Authentication & Recovery

### The Problem: Stolen Devices

```
Stolen iOS device:
├── Device unlocked (Face ID, or thief knows passcode)
├── Browser/Keychain autofills password
├── Attacker has: device + password
└── Without protection: could add devices, take over account
```

### Solution: Layered Security

| Secret | Stored on device? | Autofilled? | Used for |
|--------|-------------------|-------------|----------|
| **Password** | Yes (keychain) | Yes | Login, add device |
| **Recovery Phrase** | NO | NO | Revoke device only |

The recovery phrase is the ONE secret that cannot be on the device.

### Recovery Phrase (BIP39-style)

**Generation (at registration):**

```
1. Generate 128 bits of cryptographic randomness (CSPRNG)
2. Compute SHA-256 checksum, take first 4 bits
3. Combine: 128 + 4 = 132 bits
4. Split into 12 groups of 11 bits
5. Each 11-bit value (0-2047) maps to BIP39 wordlist
6. Result: 12 words

Example: "abandon ability able about above absent absorb abstract absurd abuse access accident"
```

**Properties:**
- 128 bits entropy = 3.4 × 10³⁸ combinations (infeasible to brute force)
- Checksum detects transcription errors (wrong word → validation fails)
- BIP39 wordlist is standard, well-known, available in multiple languages
- User writes it down, stores safely (NOT on any device)

**Cryptographic use (BIP39 standard):**

```
recovery_phrase = "word1 word2 ... word12"

// Standard BIP39 seed derivation
recovery_seed = PBKDF2_HMAC_SHA512(
  password: recovery_phrase,
  salt: "mnemonic" + optional_passphrase,  // BIP39 standard salt
  iterations: 2048,
  output_length: 64 bytes
)

// Derive Ed25519 keypair from seed
recovery_keypair = Ed25519_from_seed(recovery_seed[0:32])

recovery_public_key → stored as part of user identity (included in DeviceAnnounce)
recovery_private_key → derived only when needed, then wiped from memory
```

**Why BIP39 standard?** Allows use of existing BIP39 tools/libraries. Users familiar with crypto wallets will recognize the flow.

### Authentication Flows

**First Device Registration (Primary Device):**

```
┌─────────────────────────────────────────────────────────────────┐
│ FIRST DEVICE = PRIMARY. Creates the P2P identity.               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ 1. User chooses username + password                             │
│    → Server stores Argon2 hash                                  │
│    → Server creates "user" for this device                      │
│                                                                 │
│ 2. Client generates P2P IDENTITY (Ed25519 keypair)              │
│    → This IS the user's identity across all devices             │
│    → Private key stored securely on device                      │
│                                                                 │
│ 3. Client generates 12-word RECOVERY PHRASE                     │
│    → Derive recovery keypair (separate from identity)           │
│    → Recovery PUBLIC key becomes part of identity               │
│    → Display: "WRITE THESE 12 WORDS DOWN. STORE SAFELY."        │
│    → User confirms they saved it                                │
│    → Recovery phrase DELETED from device memory                 │
│                                                                 │
│ 4. Client generates DEVICE identity key (for Signal Protocol)   │
│    → Register device with server                                │
│    → Upload prekeys for X3DH                                    │
│                                                                 │
│ 5. This device is now PRIMARY and ONLY device                   │
│    → Device list = [this device]                                │
│    → Can add more devices via QR scan                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Add Device (requires password):**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. New device: login with username + password                   │
│    → Server verifies (Argon2)                                   │
│    → Server issues JWT                                          │
│                                                                 │
│ 2. New device displays QR code                                  │
│    → Contains: new_device_id, new_device_signal_key             │
│                                                                 │
│ 3. Existing device scans QR                                     │
│    → Approves link                                              │
│    → Sends DeviceLinkApproval + history                         │
│                                                                 │
│ 4. Existing device broadcasts DeviceAnnounce to all friends     │
│    → Friends update their device list for this user             │
└─────────────────────────────────────────────────────────────────┘
```

**Revoke Device (requires recovery phrase):**

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User enters 12-word recovery phrase                          │
│    → Client derives recovery keypair                            │
│    → Client verifies it matches known recovery public key       │
│                                                                 │
│ 2. Client creates DeviceAnnounce (excluding revoked device)     │
│    → Signed with recovery private key                           │
│                                                                 │
│ 3. Broadcast to all friends                                     │
│    → Friends verify signature against recovery public key       │
│    → Friends update device list                                 │
│    → Friends stop fanning out to revoked device                 │
│                                                                 │
│ 4. Recovery phrase wiped from memory                            │
└─────────────────────────────────────────────────────────────────┘
```

### Stolen Device Scenarios

| Scenario | Attacker can... | Attacker cannot... |
|----------|-----------------|-------------------|
| **Device only** | Use existing sessions (until revoked) | Login (no password) |
| **Device + password** | Add new device (if they can scan QR) | Revoke other devices |
| **Device + password + recovery** | Everything (game over) | N/A |

**Key insight:** Recovery phrase is the one secret the attacker cannot have if they only have the device. It's physically stored elsewhere.

### Proto Definitions

```protobuf
message RecoveryInfo {
  bytes recovery_public_key = 1;    // Ed25519 public key, part of identity
}

message DeviceRevocation {
  bytes device_id_to_revoke = 1;
  uint64 timestamp = 2;
  bytes recovery_signature = 3;     // Signed by recovery key, not device key
}
```

## Data Model (CRDT-Based)

Data is organized as grow-only sets with CRDT semantics. No hash chains - signatures provide authenticity, timestamps provide ordering.

### Message Entry

```protobuf
message MessageEntry {
  // Identity
  string message_id = 1;           // Unique ID: hash(content + timestamp + author_device)
  uint64 timestamp = 2;            // Client timestamp (ms since epoch) - for ordering

  // Content
  bytes content = 3;               // The actual message payload

  // Authentication
  bytes author_device_id = 4;      // Which device created this
  bytes signature = 5;             // sign(message_id + timestamp + content, device_key)
}
```

### Data Stores

| Store | Type | Merge Strategy |
|-------|------|----------------|
| **Messages** | G-Set | Union. Dedupe by message_id. Grow-only. |
| **Devices** | LWW-Map | DeviceAnnounce is **authoritative** - replaces entire list. Latest timestamp wins. |
| **Friends** | G-Set | Union. Friend relationships accumulate. |

**Why Devices use LWW-Map, not G-Set?**

Devices need revocation. G-Set is grow-only (can't remove). Options:

| Approach | How it works | Complexity |
|----------|--------------|------------|
| **OR-Set** | Track add/remove operations with unique IDs | Complex - need tombstones |
| **2P-Set** | Separate add-set and remove-set | Medium - but removed items can't return |
| **LWW-Map (our choice)** | DeviceAnnounce replaces entire list. Latest wins. | Simple! |

**LWW-Map is simplest:**
```
DeviceAnnounce { devices: [A, B, C], timestamp: 100 }  →  list = [A, B, C]
DeviceAnnounce { devices: [A, B], timestamp: 200 }     →  list = [A, B]  (C revoked)
DeviceAnnounce { devices: [A, B, C], timestamp: 150 }  →  ignored (older)
```

No tombstones. No complex merge. Just "latest announcement wins."

### Ordering

- No sequence numbers or hash chains
- Order by timestamp
- Ties broken by: `(timestamp, message_id)` - deterministic
- Signatures prove authenticity (not ordering)

### Why No Hash Chain?

| Hash Chain | Signatures Only |
|------------|-----------------|
| Detects tampering | Signatures already do this |
| Enforces ordering | Timestamps are sufficient |
| Detects forks | G-Set has no forks - union merge |
| Complex sync | Simple: just union the sets |

**Simpler is better. Signatures + timestamps + G-Set = no conflicts by design.**

## Sync Protocol

Sync is simple: **WebSocket drain + push**. No complex request/response negotiation.

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         DUMB PIPE                                │
│                                                                  │
│  1. POST /v1/messages/{recipient} → message queued              │
│  2. Recipient connects WebSocket  → drain all queued messages   │
│  3. Stay connected                → receive pushes in real-time │
│  4. ACK each message              → server deletes from queue   │
│                                                                  │
│  That's it. One queue per user. KISS.                           │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Flow

**Ongoing sync (the normal case):**

```
User sends message on Device A
     │
     ├── Create signed MessageEntry
     ├── Add to local G-Set
     └── Fan out to:
            ├── Bob's Device 1  ──► POST /v1/messages/{bob_d1}
            ├── Bob's Device 2  ──► POST /v1/messages/{bob_d2}
            ├── Alice Device B  ──► POST /v1/messages/{alice_d2}  (self-sync)
            └── Alice Device C  ──► POST /v1/messages/{alice_d3}  (self-sync)
                   │
                   └── Each device: WebSocket receives → add to G-Set → ACK
```

**New device joining:**

```
Device B (new)                    Server                    Device A (has history)
     │                              │                              │
     │◄─────── Device Link ─────────┼──────────────────────────────│
     │         (QR code scan)       │                              │
     │                              │                              │
     │         Device A sends history dump as messages             │
     │◄─────────────────────────────┼──────────────────────────────│
     │    (chunked, via normal message flow)                       │
     │                              │                              │
     │    Device B drains queue via WebSocket                      │
     │    Adds all to local G-Set                                  │
     │    ACKs each chunk                                          │
     │                              │                              │
     ▼ Device B now has history (eventually consistent)            │
```

**Key insight:** History sync uses the same mechanism as normal messages. No special sync protocol. Device A just sends its data to Device B as regular encrypted messages.

### Eventual Consistency (Server Holds Messages)

```
┌─────────────────────────────────────────────────────────────────┐
│ NO ONE NEEDS TO BE ONLINE AT THE SAME TIME                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Alice sends DeviceAnnounce at 10:00 AM                        │
│    → POST /v1/messages/bob_device_1                            │
│    → Server queues message                                      │
│                                                                 │
│  Bob is offline all day                                         │
│    → Message sits in queue                                      │
│                                                                 │
│  Bob comes online at 9:00 PM                                    │
│    → WebSocket connects                                         │
│    → Server drains queue (pushes DeviceAnnounce)               │
│    → Bob's client processes, updates Alice's device list        │
│    → Bob ACKs                                                   │
│    → Server deletes from queue                                  │
│                                                                 │
│  RESULT: Bob's state is now consistent with Alice's.           │
│          No special sync protocol. Just messages and drain.     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**This is how ALL sync works:**
- Device linking → messages
- Device announcement → messages
- Read sync → messages
- History sync → messages

Server is just a mailbox. Client drains it. State converges eventually.

## Device Management

**Server knows NOTHING about device relationships.** All device discovery happens via peer announcements.

### Device Linking

```protobuf
message DeviceLinkRequest {
  bytes new_device_id = 1;
  bytes new_device_signal_key = 2;  // Signal identity public key
  bytes challenge_response = 3;     // Proves possession of shared secret from QR
}

message DeviceLinkApproval {
  bytes new_device_id = 1;
  bytes signature = 2;              // Primary signs new device's identity
  repeated DeviceInfo sibling_devices = 3;  // Other linked devices
  bytes encrypted_identity_key = 4; // User's identity key (encrypted to new device)
}

message DeviceAnnounce {
  bytes user_id = 1;                // Whose device list changed
  repeated DeviceInfo devices = 2;  // Current device list (authoritative - replaces old list)
  bytes signature = 3;              // Signed by user identity key (add) OR recovery key (revoke)
  bool is_revocation = 4;           // If true, signature MUST be from recovery key
}

message DeviceInfo {
  bytes device_id = 1;
  bytes signal_identity_key = 2;
  string device_name = 3;           // "iPhone", "Laptop", etc.
}
```

### Device Link Flow

```
Primary Device                    New Device
      │                               │
      │◄──────── Scan QR ─────────────│
      │    (contains: device_id,      │
      │     signal_key, shared_secret)│
      │                               │
      ├── Verify shared_secret        │
      ├── Create DeviceLinkApproval   │
      ├── Establish Signal session    │
      │                               │
      │───── DeviceLinkApproval ─────►│
      │      (via server, encrypted)  │
      │                               │
      │                               ├── Store user identity key
      │                               ├── Store sibling device list
      │                               └── Request history from siblings
      │                               │
      ├── Announce to ALL friends ────┼───────────────────────────────►
      │   "I have a new device"       │   (so friends update their fan-out list)
      │                               │
```

### How Friends Learn About Your Devices

**Initial exchange (becoming friends):**

```
Alice sends FRIEND_REQUEST to Bob
     │
     └── Includes: Alice's P2P identity + recovery_public_key + DeviceAnnounce
         Bob now knows Alice's initial device list

Bob sends FRIEND_RESPONSE (accepted) to Alice
     │
     └── Includes: Bob's P2P identity + recovery_public_key + DeviceAnnounce
         Alice now knows Bob's initial device list

Both can now fan out to each other's devices.
```

**Ongoing updates (adding/removing devices):**

```
Alice adds Device C
     │
     ├── Link Device C (QR scan from Device A or B)
     │
     └── Broadcast DeviceAnnounce to all friends:
            ├── Bob's devices
            ├── Carol's devices
            └── etc.
                   │
                   └── Each friend updates their copy of "Alice's devices"
                       (LWW-Map: latest timestamp wins)
                       Now they fan out to Alice's Device C too
```

**This is pure P2P device discovery. Server just routes messages. Developer doesn't think about it - SDK handles fan-out automatically.**

## Message Fan-Out

When sending a message to another user, encrypt for ALL their devices:

```
Alice sends to Bob (who has 3 devices):

Alice's Device
      │
      ├── Encrypt for Bob's Device 1 ──► POST /v1/messages/{bob_device_1}
      ├── Encrypt for Bob's Device 2 ──► POST /v1/messages/{bob_device_2}
      └── Encrypt for Bob's Device 3 ──► POST /v1/messages/{bob_device_3}

      Also fan out to Alice's other devices (self-sync):
      ├── Encrypt for Alice's Device 2 ──► POST /v1/messages/{alice_device_2}
      └── Encrypt for Alice's Device 3 ──► POST /v1/messages/{alice_device_3}
```

**Note:** Server sees 5 separate encrypted messages. Has no idea they're related.

## Integration with Existing Server API

The sync protocol uses the existing dumb pipe API. No server changes required.

### Endpoint Mapping

| Protocol Action | Server Endpoint | Notes |
|----------------|-----------------|-------|
| Send any message | `POST /v1/messages/{device_id}` | All encrypted via Signal Protocol |
| Receive any | `WebSocket /v1/gateway` | Drain queue + live push |
| Device registration | `POST /v1/users` | Per-device registration |
| Prekey fetch | `GET /v1/keys/{userId}` | For X3DH handshake |
| Attachments | `POST/GET /v1/attachments` | Large binary blobs |

**Everything goes through the same pipe.** TEXT, IMAGE, DEVICE_ANNOUNCE, HISTORY_CHUNK - all just encrypted blobs to the server.

### Extended ClientMessage

```protobuf
message ClientMessage {
  enum Type {
    TEXT = 0;
    IMAGE = 1;
    FRIEND_REQUEST = 2;
    FRIEND_RESPONSE = 3;
    SESSION_RESET = 4;

    // Device management
    DEVICE_LINK_REQUEST = 10;
    DEVICE_LINK_APPROVAL = 11;
    DEVICE_ANNOUNCE = 12;        // Broadcast device list changes to friends

    // Sync (uses same message flow - no special protocol)
    HISTORY_CHUNK = 20;          // Chunk of history data for new device sync
    SETTINGS_SYNC = 21;          // Universal settings sync
    READ_SYNC = 22;              // "I read message X" - fan out to own devices
  }

  Type type = 1;

  // Existing fields...
  string text = 2;
  bytes image_data = 3;
  // ...

  // Device management
  DeviceLinkRequest device_link_request = 30;
  DeviceLinkApproval device_link_approval = 31;
  DeviceAnnounce device_announce = 32;

  // Sync payloads
  repeated MessageEntry history_chunk = 40;
  bytes settings_data = 41;        // Serialized settings CRDT
  string read_message_id = 42;     // For READ_SYNC
}
```

**Note:** Sync uses the same message queue as regular messages. No special sync protocol - just different message types going through the same dumb pipe.

## Storage

### Client-Side Storage (IndexedDB)

```
obscura_db/
├── identity/
│   ├── user_keypair           # Ed25519 identity
│   └── device_id              # This device's UUID
│
├── live/                      # < 1 month, full fidelity
│   ├── messages[]             # G-Set of MessageEntry
│   ├── devices[]              # G-Set of known devices (yours + friends')
│   └── friends[]              # G-Set of friend relationships
│
├── archive/                   # > 1 month, compressed
│   └── {month}.gz             # Compressed message batches
│
├── settings/                  # Universal settings (always synced, small)
│   ├── profile                # Name, avatar, etc.
│   ├── my_devices[]           # Your linked devices
│   └── preferences            # App preferences
│
└── signal/
    ├── sessions/              # Signal sessions (existing)
    ├── prekeys/               # Prekeys (existing)
    └── identity_keys/         # Signal identity keys (existing)
```

### Storage Tiers

```
┌─────────────────────────────────────────────────────────────────┐
│ LIVE (< 1 month)                                                │
│ • Full fidelity, uncompressed                                   │
│ • Fast random access                                            │
│ • Synced immediately on new device                              │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼ (monthly archive job)
┌─────────────────────────────────────────────────────────────────┐
│ ARCHIVE (> 1 month)                                             │
│ • Compressed (gzip)                                             │
│ • Lazy-loaded on demand (scroll back in history)                │
│ • Synced in background after live data                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ SETTINGS (always synced first)                                  │
│ • Small payload                                                 │
│ • CRDT-based (LWW for values, OR-Set for lists)                │
│ • New device gets this immediately → usable state               │
└─────────────────────────────────────────────────────────────────┘
```

### New Device Sync Order

1. **Settings** → Device is immediately usable (knows friends, profile)
2. **Live messages** → Last month of conversations
3. **Archive** → Background sync, on-demand load

## Security Considerations

### Threat Model

- **Server is honest-but-curious**: Routes messages correctly but may try to learn metadata
- **Network adversary**: Can observe traffic patterns but not content (TLS + E2E)
- **Compromised device**: Can access that device's data but not retroactively decrypt past messages (forward secrecy via Signal)

### Mitigations

1. **Message integrity**: Signed entries prevent tampering
2. **No conflicts**: G-Set merge = union, no forks possible
3. **Device isolation**: Each device has own Signal keys; compromise one doesn't expose others' sessions
4. **Forward secrecy**: Signal Protocol's Double Ratchet provides forward secrecy
5. **Metadata minimization**: Server only sees encrypted blobs + recipient IDs
6. **Server knows nothing**: Device relationships, friend lists - all P2P via announcements

### Open Questions

#### 1. Device Revocation

**Problem:** How to handle a lost/stolen device?

**Decision: Recovery phrase required for revocation**

```
REVOKE DEVICE:
  1. Enter 12-word recovery phrase (on any remaining device)
  2. Derive recovery keypair
  3. Sign DeviceAnnounce (excluding revoked device) with recovery key
  4. Broadcast to all friends
  5. Friends verify signature against known recovery public key
  6. Friends stop fanning out to revoked device
```

**Why recovery phrase?**
- Password may be in device keychain (attacker has it)
- Recovery phrase is NEVER on device (physically stored elsewhere)
- Prevents stolen device from revoking legitimate devices

See **Authentication & Recovery** section for full details.

---

#### 2. Key Rotation

**Problem:** When would you even need to rotate your identity key?

**Analysis:**
- Lost one device? Just unlink it (see above)
- Lost ALL devices? You're starting over anyway - new identity
- Proactive rotation? Forward secrecy already limits damage

**Decision: Defer**
- Identity key is permanent for MVP
- If ALL devices compromised → new identity (rare, acceptable)
- Social recovery is interesting but complex - revisit later

---

#### 3. Conflict Resolution

**Problem:** Two devices create message at same time. Conflict?

**Decision: No conflicts by design (G-Set + CRDT)**
- Messages are a grow-only set
- Each message has unique ID: `hash(content + timestamp + author_device)`
- Merge = union of sets
- Ordering by `(timestamp, message_id)` - deterministic
- Two messages at "same time"? Both kept, ordered deterministically. Not a conflict.

**No special handling needed.**

---

#### 4. Storage Limits

**Decision: Archive after 1 month + universal settings**

```
LIVE (< 1 month)     → Full fidelity, fast access
ARCHIVE (> 1 month)  → Compressed, lazy-load on scroll
SETTINGS             → Always synced first, small, CRDT-based
```

New device sync order:
1. Settings → immediately usable
2. Live → last month
3. Archive → background/on-demand

---

## Future Considerations

### Server Federation

With this protocol, server federation becomes straightforward:

```
User A @ server1.example.com
User B @ server2.example.com

A's client encrypts for B → POST to server1 → server1 routes to server2 → B's client decrypts
```

Identity is the signing key, not the server. Users can migrate.

### Partial Sync

For constrained devices (mobile), could implement:
- Sync only recent N entries
- Sync only specific event types
- On-demand sync for older history

---

## Appendix A: Full Proto Definition

See `src/proto/client/sync.proto` (to be created)

## Appendix B: Compatibility Matrix

| Feature | Requires Server Change | Requires Client Change |
|---------|----------------------|----------------------|
| Multi-device | No | Yes |
| History sync | No | Yes |
| Device linking | No | Yes |
| Read sync | No | Yes |
| Server federation | Yes (routing) | Yes (addressing) |

## Appendix C: References

- [Signal Protocol Specification](https://signal.org/docs/)
- [Secure Scuttlebutt Protocol Guide](https://ssbc.github.io/scuttlebutt-protocol-guide/)
- [AT Protocol](https://atproto.com/)
- [FidoNet Technical Standards](http://ftsc.org/docs/)
